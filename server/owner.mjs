import { randomBytes, timingSafeEqual } from 'node:crypto';
import { assert } from './errors.mjs';

const IDLE_MS = 30 * 60 * 1000;
export class OwnerSessions {
  #sessions = new Map();
  constructor({ enabled = false, securitySessions = false, secure = false, clock = Date.now } = {}) { this.enabled = enabled; this.securitySessions = securitySessions; this.clock = clock; this.secure = secure; }
  #prune() { for (const [id, session] of this.#sessions) if (session.expiresAt < this.clock()) this.#sessions.delete(id); }
  prune() { this.#prune(); }
  clearAll() { this.#sessions.clear(); }
  get(req) {
    this.#prune();
    const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('mcd_owner='))?.slice(10);
    const session = cookie ? this.#sessions.get(cookie) : undefined;
    if (session) session.expiresAt = this.clock() + IDLE_MS;
    return session;
  }
  open(req, res) {
    assert(this.enabled || this.securitySessions, 'OWNER_SETUP_DISABLED', '凭据设置尚未获得启用授权', 403);
    let session = this.get(req);
    if (!session) {
      assert(this.#sessions.size < 10000, 'SESSIONS_BUSY', '访问人数较多，请稍后再试', 503);
      const id = randomBytes(32).toString('base64url');
      session = { id, accountId: randomBytes(24).toString('hex'), csrf: randomBytes(32).toString('base64url'), expiresAt: this.clock() + IDLE_MS, credentials: {} };
      this.#sessions.set(id, session);
    }
    res.setHeader('Set-Cookie', `mcd_owner=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${IDLE_MS / 1000}${this.secure ? '; Secure' : ''}`);
    return session;
  }
  requireCsrf(req) {
    assert(this.enabled || this.securitySessions, 'OWNER_SETUP_DISABLED', '凭据设置尚未获得启用授权', 403);
    const session = this.get(req);
    const token = req.headers['x-csrf-token'];
    assert(session && typeof token === 'string' && equal(token, session.csrf), 'CSRF_INVALID', '安全会话已过期，请刷新页面后重新核对订单', 403);
    return session;
  }
  setCredentials(session, body) {
    assert(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_CREDENTIAL_INPUT', '凭据输入格式无效');
    const keys = Object.keys(body);
    assert(keys.length > 0 && keys.every(k => ['mcdToken', 'deepseekApiKey'].includes(k)), 'INVALID_CREDENTIAL_INPUT', '仅支持指定的凭据字段');
    for (const key of keys) assert(typeof body[key] === 'string' && body[key].trim().length >= 8 && body[key].length <= 8192 && !/[\r\n]/.test(body[key]), 'INVALID_CREDENTIAL_INPUT', '凭据格式无效');
    if (body.mcdToken && body.mcdToken.trim() !== session.credentials.mcdToken) session.accountId = randomBytes(24).toString('hex');
    for (const key of keys) session.credentials[key] = body[key].trim();
    session.clients = undefined;
  }
  clear(session) { session.accountId = randomBytes(24).toString('hex'); session.credentials = {}; session.clients = undefined; }
  status(session) { return { enabled: this.enabled, mcdConfigured: !!session?.credentials.mcdToken, deepseekConfigured: !!session?.credentials.deepseekApiKey, ...(session ? { csrfToken: session.csrf } : {}) }; }
}
function equal(a, b) { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
