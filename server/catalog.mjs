import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, assert } from './errors.mjs';
import { mapProduct, productSource, needsProductUnderstanding, supplementProductMapping, PRODUCT_MAPPING_VERSION } from './product-mapping.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const complete = row => row && ['mapped', 'unknown'].includes(row.status);

export class ProductCatalog {
  #db; #inFlight = new Map();
  constructor(filename = ':memory:') {
    this.persistent = filename !== ':memory:';
    if (this.persistent) mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(filename);
    if (this.persistent) chmodSync(filename, 0o600);
    assert(this.#db.prepare('PRAGMA user_version').get().user_version <= 1, 'CATALOG_VERSION_UNSUPPORTED', '商品数据库版本不受当前程序支持', 503);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS catalog_snapshots (
        scope TEXT NOT NULL, context_key TEXT NOT NULL, context_json TEXT NOT NULL,
        retrieved_at TEXT NOT NULL, source_json TEXT NOT NULL,
        PRIMARY KEY (scope, context_key)
      );
      CREATE TABLE IF NOT EXISTS product_mappings (
        scope TEXT NOT NULL, product_id TEXT NOT NULL, source_hash TEXT NOT NULL, parser_version TEXT NOT NULL,
        source_json TEXT NOT NULL, mapping_json TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, error_code TEXT, updated_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        PRIMARY KEY (scope, product_id, source_hash, parser_version)
      );
      PRAGMA user_version=1;`);
  }
  observe(scope, menu) {
    const context = menu.storeContext;
    this.#db.prepare(`INSERT INTO catalog_snapshots VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope, context_key) DO UPDATE SET retrieved_at=excluded.retrieved_at, source_json=excluded.source_json
      WHERE excluded.retrieved_at >= catalog_snapshots.retrieved_at`).run(scope, hash(context), JSON.stringify(context), menu.retrievedAt, JSON.stringify(menu.items));
  }
  #read(entry) {
    return this.#db.prepare('SELECT * FROM product_mappings WHERE scope=? AND product_id=? AND source_hash=? AND parser_version=?').get(...entry.key);
  }
  #write(entry, status, mapping, errorCode = null, attempted = false) {
    const at = new Date().toISOString();
    this.#db.prepare(`INSERT INTO product_mappings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, product_id, source_hash, parser_version) DO UPDATE SET
      mapping_json=excluded.mapping_json, status=excluded.status, error_code=excluded.error_code,
      attempts=product_mappings.attempts+excluded.attempts, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
      WHERE product_mappings.status NOT IN ('mapped', 'unknown') OR excluded.status IN ('mapped', 'unknown')`).run(
      ...entry.key, JSON.stringify(entry.source), JSON.stringify(mapping), status, Number(attempted), errorCode, at, at,
    );
    return this.#read(entry);
  }
  async #resolve(entries, ai) {
    const fresh = entries.filter(e => !this.#inFlight.has(e.jobKey));
    if (fresh.length) {
      const job = (async () => {
        try {
          const outputs = await ai.classifyProducts(fresh.map(e => e.source));
          const byId = new Map(outputs.map(o => [o.id, o]));
          for (const e of fresh) {
            try {
              const inferred = byId.get(e.source.id);
              assert(inferred && !inferred.errorCode, 'PRODUCT_MAPPING_INVALID', '商品分类结果不完整或依据无效', 502);
              this.#write(e, inferred.kind === 'unknown' ? 'unknown' : 'mapped', supplementProductMapping(e.item, inferred), null, true);
            } catch (error) { this.#write(e, 'failed', e.item.productMapping, error instanceof AppError ? error.code : 'PRODUCT_MAPPING_FAILED', true); }
          }
        } catch (error) {
          for (const e of fresh) this.#write(e, 'failed', e.item.productMapping, error instanceof AppError ? error.code : 'PRODUCT_MAPPING_FAILED', true);
        }
      })();
      for (const e of fresh) this.#inFlight.set(e.jobKey, job);
      // Remove only the exact job we registered; another request may already be retrying a failure.
      void job.finally(() => { for (const e of fresh) if (this.#inFlight.get(e.jobKey) === job) this.#inFlight.delete(e.jobKey); }).catch(() => {});
    }
    await Promise.all([...new Set(entries.map(e => this.#inFlight.get(e.jobKey)).filter(Boolean))]);
  }
  async sync(scope, menu, ai, model) {
    const version = `${PRODUCT_MAPPING_VERSION}:${model}`;
    const counts = { total: menu.items.length, newProducts: 0, changedProducts: 0, reused: 0, analyzed: 0, mapped: 0, unknown: 0, pending: 0, failed: 0 };
    const entries = menu.items.map(item => {
      item = item.productMapping ? item : mapProduct(item);
      const source = productSource(item); const digest = hash(source);
      const key = [scope, source.id, digest, version];
      const e = { item, source, key, jobKey: JSON.stringify(key) };
      const previous = this.#read(e);
      if (previous) {
        this.#db.prepare('UPDATE product_mappings SET last_seen_at=? WHERE scope=? AND product_id=? AND source_hash=? AND parser_version=?').run(new Date().toISOString(), ...key);
      } else {
        const known = this.#db.prepare('SELECT 1 FROM product_mappings WHERE scope=? AND product_id=? LIMIT 1').get(scope, source.id);
        counts[known ? 'changedProducts' : 'newProducts']++;
      }
      if (complete(previous)) counts.reused++;
      else if (!needsProductUnderstanding(item)) this.#write(e, 'mapped', item.productMapping);
      else this.#write(e, 'pending', item.productMapping);
      return e;
    });
    const todo = entries.filter(e => !complete(this.#read(e)));
    // ponytail: at most two six-product model batches in flight; no product-count truncation.
    if (ai) for (let offset = 0; offset < todo.length; offset += 12) {
      const batch = todo.slice(offset, offset + 12);
      await Promise.all([this.#resolve(batch.slice(0, 6), ai), this.#resolve(batch.slice(6), ai)]);
      counts.analyzed += batch.length;
      if (batch.some(e => { const row = this.#read(e); return row.status === 'failed' && !['PRODUCT_MAPPING_INVALID', 'PRODUCT_MAPPING_CONFLICT'].includes(row.error_code); })) break;
    }
    const issues = [];
    menu.items = entries.map(e => {
      const saved = this.#read(e); counts[saved.status]++;
      if (saved.status !== 'mapped') issues.push({ id: e.source.id, name: e.source.name, status: saved.status });
      return { ...e.item, productMapping: { ...JSON.parse(saved.mapping_json), status: saved.status, sourceHash: e.key[2], parserVersion: version } };
    });
    const unresolved = counts.unknown + counts.pending + counts.failed;
    const detailFailed = menu.detailCoverage?.failed || 0;
    const unsupported = menu.detailCoverage?.unsupported || 0;
    const notice = [unresolved ? `${unresolved} 款餐品分类待确认` : '', detailFailed ? `${detailFailed} 款餐品规格暂缺` : '', unsupported ? `${unsupported} 款套餐暂不支持自动搭配` : ''].filter(Boolean).join('；');
    menu.catalogSync = { ...counts, issues, persistent: this.persistent, updatedAt: menu.retrievedAt, complete: !unresolved && !detailFailed && !unsupported, notice };
    if (counts.pending || counts.failed) menu.warnings.push(`${counts.pending + counts.failed} 款餐品分类未完成，下次规划会自动重试`);
    if (counts.unknown) menu.warnings.push(`${counts.unknown} 款餐品资料不足，分类暂未确认`);
    return menu;
  }
  async close() { await Promise.allSettled([...this.#inFlight.values()]); this.#db.close(); }
}
