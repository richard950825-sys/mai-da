import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProductCatalog } from '../server/catalog.mjs';
import { DeepSeekClient } from '../server/deepseek.mjs';
import { AppError } from '../server/errors.mjs';
import { normalizeMenu, emptyNutrition } from '../server/normalize.mjs';
import { mapProduct, productSource, validateProductMappings } from '../server/product-mapping.mjs';
import { readStoreMenu } from '../server/menu.mjs';
import { createApp } from '../server/app.mjs';

const envelope = data => ({ structuredContent: { success: true, code: 200, data } });
const context = { storeCode: 'test-store', orderType: 1, beType: 1 };
const item = (id = 'new', description = '芝士条小食') => mapProduct({ id, code: id, name: `测试新品-${id}`, description, categories: [], tags: [], nutrition: emptyNutrition(), standardVerified: true });
const menu = items => ({ items, storeContext: context, retrievedAt: new Date().toISOString(), warnings: [] });
const inferred = sources => validateProductMappings({ products: sources.map(s => ({ id: s.id, kind: 'food', evidence: [{ feature: s.description.includes('猪肉') ? 'pork' : 'side', field: 'description', value: s.description }] })) }, sources);
async function storeFor(t) { const store = new ProductCatalog(); t.after(() => store.close()); return store; }
const completion = output => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });

test('catalog persists unseen products and mappings across a database reopen', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mcd-catalog-test-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const filename = path.join(dir, 'data', 'catalog.sqlite'); let calls = 0;
  const ai = { classifyProducts: async rows => { calls++; return inferred(rows); } };
  let store = new ProductCatalog(filename);
  const first = menu([item()]); store.observe('owner', first); await store.sync('owner', first, ai, 'test-model');
  assert.equal(first.catalogSync.newProducts, 1); assert.equal(first.catalogSync.mapped, 1); assert.equal(first.items[0].productMapping.features.includes('side'), true);
  assert.equal(first.items[0].nutrition.kcal, null); assert.equal((await stat(filename)).mode & 0o777, 0o600);
  await store.close(); store = new ProductCatalog(filename);
  const second = await store.sync('owner', menu([item()]), ai, 'test-model');
  assert.equal(second.catalogSync.reused, 1); assert.equal(calls, 1); await store.close();
  const db = new DatabaseSync(filename, { readOnly: true });
  assert.equal(db.prepare('SELECT count(*) AS n FROM product_mappings').get().n, 1);
  assert.equal(JSON.parse(db.prepare('SELECT source_json FROM catalog_snapshots').get().source_json)[0].code, 'new'); db.close();
});

test('same-code metadata changes trigger reclassification without old attribute leakage', async t => {
  const store = await storeFor(t); let calls = 0;
  const ai = { classifyProducts: async rows => { calls++; return inferred(rows); } };
  const a = await store.sync('owner', menu([item('sku', '猪肉小食')]), ai, 'm');
  assert(a.items[0].productMapping.features.includes('pork'));
  const b = await store.sync('owner', menu([item('sku', '薯类小食')]), ai, 'm');
  assert.equal(calls, 2); assert.equal(b.catalogSync.changedProducts, 1);
  assert(!b.items[0].productMapping.features.includes('pork')); assert(b.items[0].productMapping.features.includes('side'));
  assert.notEqual(a.items[0].productMapping.sourceHash, b.items[0].productMapping.sourceHash);
});

test('price changes are live data and do not invalidate semantic mappings', async t => {
  const store = await storeFor(t); let calls = 0;
  const ai = { classifyProducts: async rows => { calls++; return inferred(rows); } };
  await store.sync('owner', menu([{ ...item(), menuPrice: 10 }]), ai, 'm');
  const next = await store.sync('owner', menu([{ ...item(), menuPrice: 15 }]), ai, 'm');
  assert.equal(calls, 1); assert.equal(next.items[0].menuPrice, 15); assert.equal(next.catalogSync.reused, 1);
});

test('a saved historical product cannot reappear in a different current store menu', async t => {
  const store = await storeFor(t); const ai = { classifyProducts: async rows => inferred(rows) };
  await store.sync('owner', menu([item('old')]), ai, 'm');
  const next = await store.sync('owner', { ...menu([item('new')]), storeContext: { ...context, storeCode: 'different' } }, ai, 'm');
  assert.deepEqual(next.items.map(p => p.code), ['new']);
  assert.equal((await store.sync('owner', menu([]), ai, 'm')).items.length, 0);
});

test('all descriptor versions are scoped to the owner and model version', async t => {
  const store = await storeFor(t); let calls = 0;
  const ai = { classifyProducts: async rows => { calls++; return inferred(rows); } };
  for (const [scope, model] of [['a','m1'],['b','m1'],['a','m2']]) await store.sync(scope, menu([item()]), ai, model);
  assert.equal(calls, 3);
});

test('failed classifications stay visible and retry on the next request', async t => {
  const store = await storeFor(t); let fail = true;
  const ai = { classifyProducts: async rows => { if (fail) throw new AppError('DEEPSEEK_HTTP_ERROR', 'test', 429); return inferred(rows); } };
  const first = await store.sync('owner', menu([item()]), ai, 'm');
  assert.equal(first.catalogSync.failed, 1); assert.equal(first.catalogSync.complete, false); assert.match(first.warnings.join(' '), /下次规划会自动重试/);
  fail = false;
  const second = await store.sync('owner', menu([item()]), ai, 'm');
  assert.equal(second.catalogSync.mapped, 1); assert.equal(second.catalogSync.complete, true); assert.equal(second.catalogSync.reused, 0);
});

test('no AI consent leaves unresolved mappings pending and does not block known official tags', async t => {
  const store = await storeFor(t);
  const beef = mapProduct({ ...item('beef'), name: '巨无霸', categories: ['巨无霸\n牛鱼肉堡'], tags: ['100%纯牛肉'] });
  const m = await store.sync('owner', menu([beef, item()]), null, 'm');
  assert.equal(m.catalogSync.mapped, 1); assert.equal(m.catalogSync.pending, 1); assert.equal(m.catalogSync.analyzed, 0);
  assert(m.items[0].productMapping.features.includes('beef'));
});

test('insufficient source information stays unknown without repeatedly asking the model', async t => {
  const store = await storeFor(t); let calls = 0;
  const ai = { classifyProducts: async rows => { calls++; return rows.map(r => ({ id: r.id, kind: 'unknown', features: [], evidence: [] })); } };
  const a = await store.sync('owner', menu([item()]), ai, 'm');
  const b = await store.sync('owner', menu([item()]), ai, 'm');
  assert.equal(a.catalogSync.unknown, 1); assert.equal(b.catalogSync.reused, 1); assert.equal(calls, 1);
});

test('concurrent reads of the same changed SKU share one model job', async t => {
  const store = await storeFor(t); let calls = 0;
  const ai = { classifyProducts: async rows => { calls++; await new Promise(r => setTimeout(r, 15)); return inferred(rows); } };
  const results = await Promise.all([store.sync('owner', menu([item()]), ai, 'm'), store.sync('owner', menu([item()]), ai, 'm')]);
  assert.equal(calls, 1); assert(results.every(r => r.catalogSync.mapped === 1));
});

test('batches process the whole catalog with bounded model concurrency', async t => {
  const store = await storeFor(t); let active = 0, max = 0, count = 0;
  const ai = { classifyProducts: async rows => { active++; max = Math.max(max, active); count += rows.length; assert(rows.length <= 6); await new Promise(r => setTimeout(r, 5)); active--; return inferred(rows); } };
  const m = await store.sync('owner', menu(Array.from({ length: 29 }, (_, i) => item(String(i)))), ai, 'm');
  assert.equal(count, 29); assert.equal(m.catalogSync.mapped, 29); assert(max <= 2);
});

test('a provider failure leaves unattempted products pending, not lost or marked classified', async t => {
  const store = await storeFor(t); let calls = 0;
  const m = await store.sync('owner', menu(Array.from({ length: 20 }, (_, i) => item(String(i)))), { classifyProducts: async () => { calls++; throw new Error('offline failure'); } }, 'm');
  assert.equal(calls, 2); assert.equal(m.catalogSync.failed, 12); assert.equal(m.catalogSync.pending, 8); assert.equal(m.items.length, 20);
});

test('model classifications reject fabricated IDs, quotations, extra facts and incompatible categories', () => {
  const sources = [productSource(item())];
  const row = { id: 'new', kind: 'food', evidence: [{ feature: 'side', field: 'description', value: '芝士条' }] };
  assert.equal(validateProductMappings({ products: [row] }, sources)[0].features[0], 'side');
  for (const bad of [
    { ...row, id: 'invented' }, { ...row, price: 0 }, { ...row, nutrition: { kcal: 0 } },
    { ...row, evidence: [{ feature: 'side', field: 'description', value: '从未提供的依据' }] },
    { ...row, evidence: [{ feature: 'beef', field: 'address', value: '芝士条' }] },
    { ...row, kind: 'beverage' }, { ...row, kind: 'unknown' },
    { ...row, kind: 'beverage', evidence: [{ feature: 'unsweetened-label', field: 'description', value: '芝士条' }] },
  ]) assert.throws(() => validateProductMappings({ products: [bad] }, sources), { code: 'PRODUCT_MAPPING_INVALID' });
  assert.throws(() => validateProductMappings({ products: [row, row] }, sources), { code: 'PRODUCT_MAPPING_INVALID' });
  assert.throws(() => validateProductMappings({ products: [] }, sources), { code: 'PRODUCT_MAPPING_INVALID' });
});

test('the product model request contains only supplied public descriptors and validates the response', async () => {
  let body;
  const client = new DeepSeekClient({ apiKey: 'test-only-secret', fetchImpl: async (_url, init) => {
    body = JSON.parse(init.body); const { products } = JSON.parse(body.messages[1].content);
    return completion({ products: products.map(p => ({ id: p.id, kind: 'food', evidence: [{ feature: 'side', field: 'description', value: '芝士条' }] })) });
  } });
  const source = productSource({ ...item(), price: 20, nutrition: { kcal: 333 }, couponId: 'private-coupon', address: 'private-address', token: 'private-token' });
  const output = await client.classifyProducts([source]); assert.equal(output[0].kind, 'food');
  const serialized = JSON.stringify(body);
  for (const value of ['private-coupon', 'private-address', 'private-token', 'test-only-secret', '333']) assert(!serialized.includes(value));
  assert.equal(body.tools, undefined); assert.equal(body.max_tokens, 3000);
});

test('unfamiliar products beyond position 24 get live detail reads before recommendation filtering', async () => {
  const meals = Object.fromEntries(Array.from({ length: 29 }, (_, i) => [String(i), { name: `谜语新品${i}` }]));
  const calls = []; let observed = false;
  const client = { listTools: async () => [{ name: 'query-meal-detail' }], callRead: async (name, args) => {
    if (name === 'query-meals') return envelope({ meals });
    assert(observed); calls.push(args.code); return envelope({ code: args.code, name: meals[args.code].name, description: '芝士条小食', rounds: [] });
  } };
  const m = await readStoreMenu(client, context, [], [], snapshot => { observed = true; assert.equal(snapshot.items.length, 29); });
  assert.equal(new Set(calls).size, 29); assert.equal(m.detailCoverage.resolved, 29); assert(m.items.every(p => p.standardVerified));
});

test('rate-limited details remain in the directory with explicit incomplete coverage', async () => {
  const meals = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), { name: `新品${i}` }]));
  const client = { listTools: async () => [{ name: 'query-meal-detail' }], callRead: async name => {
    if (name === 'query-meals') return envelope({ meals });
    throw new AppError('MCD_RATE_LIMIT', 'test', 429);
  } };
  const m = await readStoreMenu(client, context, []);
  assert.equal(m.items.length, 9); assert.equal(m.detailCoverage.failed, 9); assert.match(m.warnings.join(' '), /覆盖不完整/); assert(m.items.every(p => p.configurationStatus === 'failed'));
});

test('HTTP planning discovers a new unrecognized SKU, caches its mapping, handles a changed SKU, and excludes a removal', async t => {
  let description = '芝士条小食', available = true, modelCalls = 0;
  const tools = ['list-nutrition-foods', 'query-meals', 'query-meal-detail', 'query-store-coupons', 'calculate-price'];
  const fetchImpl = async (url, init) => {
    const req = JSON.parse(init.body);
    if (url.includes('deepseek.com')) {
      modelCalls++; const input = JSON.parse(req.messages[1].content); assert.deepEqual(Object.keys(input), ['products']);
      return completion({ products: input.products.map(p => ({ id: p.id, kind: 'food', evidence: [{ feature: description.includes('猪肉') ? 'pork' : 'side', field: 'description', value: description }] })) });
    }
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let payload;
    if (req.method === 'initialize') payload = { protocolVersion: '2025-06-18' };
    else if (req.method === 'tools/list') payload = { tools: tools.map(name => ({ name, inputSchema: { type: 'object' } })) };
    else {
      const { name, arguments: args } = req.params;
      if (name === 'list-nutrition-foods' || name === 'query-store-coupons') payload = envelope([]);
      else if (name === 'query-meals') payload = envelope({ meals: available ? { new: { name: '测试新品', description }, main: { name: '测试牛肉堡' } } : {} });
      else if (name === 'query-meal-detail') payload = envelope({ code: args.code, name: args.code === 'main' ? '测试牛肉堡' : '测试新品', description: args.code === 'main' ? '' : description, rounds: [] });
      else if (name === 'calculate-price') payload = envelope({ price: 1700, productList: args.items });
      else throw Error('Unexpected tool');
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result: payload });
  };
  const port = 5274;
  const server = createApp({ port, providerAccessEnabled: true, resolveUser: async () => ({ id: 'test' }), resolveCredentials: async () => ({ mcdToken: 'test-only', deepseekApiKey: 'test-only' }), fetchImpl }).createServer();
  await new Promise(r => server.listen(port, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const request = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/recommendations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aiConsent: true, storeContext: context, preferences: { goal: 'balanced' } }) });
    assert.equal(r.status, 200); return r.json();
  };
  const first = await request(); assert.equal(first.catalogSync.mapped, 2); assert(first.recommendations.some(p => p.foods.some(f => f.productCode === 'new'))); assert.equal(first.recommendations[0].price, 17); assert.equal(first.recommendations[0].nutrition.kcal, null);
  assert.equal((await request()).catalogSync.reused, 2); assert.equal(modelCalls, 1);
  description = '猪肉小食'; assert.equal((await request()).catalogSync.changedProducts, 1); assert.equal(modelCalls, 2);
  available = false; const removed = await request(); assert.equal(removed.catalogSync.total, 0); assert.equal(removed.recommendations.length, 0); assert.equal(modelCalls, 2);
});


test('multiple verbatim sources for one feature are accepted without duplicating the attribute', () => {
  const source = productSource(mapProduct({ ...item(), categories: ['小食拼盘'], tags: ['小食拼盘'] }));
  const output = validateProductMappings({ products: [{ id: source.id, kind: 'food', evidence: [
    { feature: 'side', field: 'categories', value: '小食拼盘' },
    { feature: 'side', field: 'tags', value: '小食拼盘' },
  ] }] }, [source]);
  assert.deepEqual(output[0].features, ['side']); assert.equal(output[0].evidence.length, 2);
});

test('an invalid classification batch cannot starve unrelated new products', async t => {
  const store = await storeFor(t); let calls = 0;
  const ai = { classifyProducts: async rows => { calls++; if (rows[0].id === '0') throw new AppError('PRODUCT_MAPPING_INVALID', 'test', 502); return inferred(rows); } };
  const m = await store.sync('owner', menu(Array.from({ length: 20 }, (_, i) => item(String(i)))), ai, 'm');
  assert.equal(calls, 4); assert.equal(m.catalogSync.failed, 6); assert.equal(m.catalogSync.mapped, 14); assert.equal(m.catalogSync.pending, 0);
});
