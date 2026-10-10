import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import path from 'node:path';
import { assert } from './errors.mjs';

export const DAILY_AI_LIMIT = 10;
const DAY = 86400000;
const OFFSET = 8 * 3600000;
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
export function requestIp(req, trustCloudflare = false) {
  let ip = req.socket.remoteAddress;
  if (trustCloudflare) {
    // Only a local cloudflared ingress may supply Cloudflare's overwritten visitor header.
    assert(loopback(ip), 'UNTRUSTED_PROXY', '请求来源无法验证', 403);
    ip = req.headers['cf-connecting-ip'];
  }
  assert(typeof ip === 'string' && isIP(ip), 'CLIENT_IP_REQUIRED', '无法确认访问地址，请稍后重试', 403);
  if (isIP(ip) === 6) {
    ip = new URL(`http://[${ip}]`).hostname.slice(1, -1);
    const mapped = /^::ffff:([a-f\d]{1,4}):([a-f\d]{1,4})$/.exec(ip);
    if (mapped) ip = mapped.slice(1).flatMap(p => { const n = parseInt(p, 16); return [n >> 8, n & 255]; }).join('.');
  }
  return ip;
}
export class AiQuota {
  #db;
  constructor(filename = ':memory:', clock = Date.now) {
    this.clock = clock;
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS ai_daily_usage (ip_hash TEXT NOT NULL, day TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY (ip_hash, day));`);
  }
  #bucket(ip) {
    const now = this.clock();
    const day = new Date(now + OFFSET).toISOString().slice(0, 10);
    const resetsAt = new Date((Math.floor((now + OFFSET) / DAY) + 1) * DAY - OFFSET).toISOString();
    return { day, resetsAt, key: createHash('sha256').update(`${day}:${ip}`).digest('hex') };
  }
  status(ip) {
    const { day, resetsAt, key } = this.#bucket(ip);
    const used = this.#db.prepare('SELECT used FROM ai_daily_usage WHERE ip_hash=? AND day=?').get(key, day)?.used || 0;
    return { limit: DAILY_AI_LIMIT, remaining: Math.max(0, DAILY_AI_LIMIT - used), resetsAt, timezone: 'Asia/Shanghai' };
  }
  consume(ip) {
    const { day, resetsAt, key } = this.#bucket(ip);
    this.#db.prepare('DELETE FROM ai_daily_usage WHERE day < ?').run(day);
    const accepted = this.#db.prepare(`INSERT INTO ai_daily_usage VALUES (?, ?, 1)
      ON CONFLICT(ip_hash, day) DO UPDATE SET used=used+1 WHERE used < ? RETURNING used`).get(key, day, DAILY_AI_LIMIT);
    assert(accepted, 'AI_DAILY_LIMIT', '今天的 10 次 AI 额度已用完，北京时间零点后可继续使用。', 429,
      { limit: DAILY_AI_LIMIT, remaining: 0, resetsAt, retryAfter: Math.max(1, Math.ceil((Date.parse(resetsAt) - this.clock()) / 1000)) });
    return { limit: DAILY_AI_LIMIT, remaining: DAILY_AI_LIMIT - accepted.used, resetsAt, timezone: 'Asia/Shanghai' };
  }
  close() { this.#db.close(); }
}
