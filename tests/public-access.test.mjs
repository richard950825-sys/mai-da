import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AiQuota, requestIp } from '../server/ai-quota.mjs';
import { createApp } from '../server/app.mjs';
import { DEEPSEEK_ENDPOINT } from '../server/deepseek.mjs';

const secret = 'server-only-model-key-for-offline-tests';
const meal = { intent: 'meal', clarificationReason: null, goal: 'balanced', clearKcalTarget: false, kcalTarget: null, kcalMin: null, kcalMax: null, proteinMin: null, sugarMax: null, sodiumMax: null, budget: null, avoid: [], preferCoupons: false, includeKeywords: [], includeAnyKeywords: [], unsweetenedDrink: false, beverageOnlyAllowed: false };
function fixture() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body, authorization: init.headers.Authorization });
    if (url === DEEPSEEK_ENDPOINT) {
      assert.equal(init.headers.Authorization, `Bearer ${secret}`);
      const input = JSON.parse(body.messages[1].content);
      const output = input.candidates ? { ids: input.candidates.map(c => c.id) } : input.products ? { products: input.products.map(p => ({ id: p.id, kind: 'unknown', evidence: [] })) } : meal;
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
    }
    if (init.headers.Authorization === 'Bearer invalid-test-token') return new Response(null, { status: 401 });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let result;
    if (body.method === 'initialize') result = { protocolVersion: '2025-06-18' };
    else if (body.method === 'tools/list') result = { tools: ['list-nutrition-foods', 'query-meals', 'query-meal-detail'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else {
      const data = body.params.name === 'query-meals' ? { meals: { new: { code: 'new', name: '测试新品', description: '新上市' } } }
        : body.params.name === 'query-meal-detail' ? { code: 'new', name: '测试新品', description: '新上市', rounds: [] }
        : '[2]{productName,nutritionDescription,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  测试牛肉汉堡,每份,350,25,10,40,500,20\n  测试薯条,每份,150,2,8,18,100,5\n';
      result = { content: [{ type: 'text', text: JSON.stringify({ success: true, code: 200, data }) }] };
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  return { calls, fetchImpl };
}
async function serverWith(t, options = {}) {
  const previous = process.env.DEEPSEEK_API_KEY;
  const previousMcd = process.env.MCD_MCP_TOKEN;
  process.env.DEEPSEEK_API_KEY = secret;
  process.env.MCD_MCP_TOKEN = 'private-owner-token-must-never-be-used';
  t.after(() => { for (const [name, value] of [['DEEPSEEK_API_KEY', previous], ['MCD_MCP_TOKEN', previousMcd]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const transport = fixture();
  const logs = [];
  const server = createApp({ visitorAccess: true, providerAccessEnabled: true, allowLocalEnvCredentials: true, ...options, fetchImpl: transport.fetchImpl, logger: e => logs.push(e) }).createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const request = (route, body, headers = {}, method) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: `/api${route}`, method: method || (body === undefined ? 'GET' : 'POST'), headers: { Host: '127.0.0.1:8788', Origin: 'http://127.0.0.1:5178', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text), headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const connect = async (token = 'visitor-a-test-token', extra = {}) => {
    const setup = await request('/owner/setup/status', undefined, extra);
    const headers = { ...extra, Cookie: setup.headers['set-cookie'][0].split(';')[0], 'X-CSRF-Token': setup.body.csrfToken };
    assert.equal((await request('/owner/setup', { mcdToken: token }, headers)).status, 200);
    return headers;
  };
  return { ...transport, request, connect, logs };
}
test('public entry needs a personal token, never shares the owner token or accepts a browser LLM key', async t => {
  const { request, connect, calls, logs } = await serverWith(t, { secureCookies: true });
  const status = await request('/status');
  assert.equal(status.body.accessMode, 'visitor'); assert.equal(status.body.mcd.configured, false); assert.equal(status.body.deepseek.configured, true);
  assert.equal((await request('/recommendations', { text: '牛肉', aiConsent: true })).status, 401); assert.equal(calls.length, 0);
  const setup = await request('/owner/setup/status');
  assert.match(setup.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/); assert.match(setup.headers['set-cookie'][0], /; Secure/);
  const a = await connect(); const b = await connect('visitor-b-test-token');
  const scope = (await request('/status', undefined, a)).body.receiptScope;
  assert.notEqual(scope, (await request('/status', undefined, b)).body.receiptScope);
  const again = await connect(); assert.equal(scope, (await request('/status', undefined, again)).body.receiptScope);
  assert.equal((await request('/nutrition', undefined, a)).status, 200); assert.equal((await request('/nutrition', undefined, b)).status, 200);
  assert(calls.some(c => c.authorization === 'Bearer visitor-a-test-token')); assert(calls.some(c => c.authorization === 'Bearer visitor-b-test-token'));
  assert(!calls.some(c => c.authorization.includes('private-owner')));
  assert.equal((await request('/owner/setup', { mcdToken: 'new-test-token', deepseekApiKey: 'injected-test-key' }, a)).status, 400);
  assert.equal((await request('/owner/setup', { mcdToken: 'invalid-test-token' }, a)).status, 502);
  assert.equal((await request('/status', undefined, a)).body.mcd.connected, true);
  const rejected = await request('/owner/setup', { mcdToken: 'new-test-token' }, { ...a, 'X-CSRF-Token': b['X-CSRF-Token'] }); assert.equal(rejected.status, 403);
  assert.equal((await request('/recommendations', { text: '牛肉', aiConsent: true }, { Cookie: a.Cookie })).status, 403);
  assert.equal((await request('/recommendations', { text: '牛肉', aiConsent: true }, { ...a, Origin: 'https://evil.invalid' })).status, 403);
  const visible = JSON.stringify([status, setup, logs, await request('/status', undefined, a)]);
  for (const value of [secret, 'visitor-a-test-token', 'visitor-b-test-token', 'private-owner-token-must-never-be-used']) assert(!visible.includes(value));
});
test('ten requests share an IP budget across sessions; parsing and ranking count once; forged headers do not bypass it', async t => {
  const { request, connect, calls } = await serverWith(t);
  const a = await connect(); const b = await connect('visitor-b-test-token');
  const body = { text: '牛肉汉堡', aiConsent: true };
  for (let i = 0; i < 10; i++) {
    const r = await request('/recommendations', body, { ...(i % 2 ? a : b), 'CF-Connecting-IP': `192.0.2.${i + 1}`, 'X-Forwarded-For': `198.51.100.${i + 1}` });
    assert.equal(r.status, 200, r.text); assert(r.body.recommendations.length > 0);
  }
  assert.equal(calls.filter(c => c.url === DEEPSEEK_ENDPOINT).length, 20);
  assert.equal((await request('/status', undefined, a)).body.aiQuota.remaining, 0);
  const count = calls.length;
  for (const [route, body] of [['/recommendations', { text: '再来一份', aiConsent: true }], ['/owner/setup/verify', { provider: 'deepseek', aiConsent: true }], ['/menu', { storeContext: { storeCode: 'test', orderType: 1, beType: 1 }, aiConsent: true }]]) {
    const before = calls.filter(c => c.url === DEEPSEEK_ENDPOINT).length;
    const r = await request(route, body, a); assert.equal(r.status, 429, r.text); assert.equal(r.body.error.code, 'AI_DAILY_LIMIT'); assert(Number(r.headers['retry-after']) > 0);
    assert.equal(calls.filter(c => c.url === DEEPSEEK_ENDPOINT).length, before);
  }
  assert(calls.length >= count);
  assert.equal((await request('/nutrition', undefined, a)).status, 200);
  const c = await connect('visitor-c-test-token');
  assert.equal((await request('/recommendations', body, c)).status, 429);
});
test('parallel calls cannot exceed ten, and trusted Cloudflare visitors have separate IP budgets', async t => {
  const { request, connect, calls } = await serverWith(t, { trustCloudflare: true });
  const a = await connect('visitor-a-test-token', { 'CF-Connecting-IP': '192.0.2.1' });
  const results = await Promise.all(Array.from({ length: 16 }, () => request('/owner/setup/verify', { provider: 'deepseek', aiConsent: true }, a)));
  assert.equal(results.filter(r => r.status === 200).length, 10); assert.equal(results.filter(r => r.status === 429).length, 6);
  assert.equal(calls.filter(c => c.url === DEEPSEEK_ENDPOINT).length, 10);
  assert.equal((await request('/status', undefined, { ...a, 'CF-Connecting-IP': '192.0.2.2' })).body.aiQuota.remaining, 10);
  assert.equal((await request('/status', undefined, { ...a, 'CF-Connecting-IP': 'bad-ip' })).status, 403);
});
test('quota persists across database handles and resets at midnight in Asia/Shanghai', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'mcd-quota-')); const filename = path.join(folder, 'quota.sqlite');
  let now = Date.parse('2026-10-10T15:59:59Z'); let q = new AiQuota(filename, () => now);
  try {
    for (let i = 0; i < 9; i++) q.consume('192.0.2.1');
    q.close(); q = new AiQuota(filename, () => now);
    const other = new AiQuota(filename, () => now); try { other.consume('192.0.2.1'); } finally { other.close(); }
    assert.equal(q.status('192.0.2.1').remaining, 0); assert.throws(() => q.consume('192.0.2.1'), { code: 'AI_DAILY_LIMIT' });
    now += 1000; assert.equal(q.status('192.0.2.1').remaining, 10); assert.equal(q.consume('192.0.2.1').remaining, 9);
  } finally { q.close(); assert(!readFileSync(filename).includes(Buffer.from('192.0.2.1'))); rmSync(folder, { recursive: true }); }
});
test('IP keys normalize IPv6 and mapped IPv4, and accept proxy headers only at the configured local ingress', () => {
  const req = (ip, value) => ({ socket: { remoteAddress: ip }, headers: { 'cf-connecting-ip': value } });
  assert.equal(requestIp(req('2001:0DB8:0:0:0:0:0:1')), '2001:db8::1');
  assert.equal(requestIp(req('::ffff:192.0.2.1')), '192.0.2.1');
  assert.equal(requestIp(req('::ffff:c000:201')), '192.0.2.1');
  assert.equal(requestIp(req('192.0.2.1', '198.51.100.1')), '192.0.2.1');
  assert.throws(() => requestIp(req('192.0.2.1', '198.51.100.1'), true), { code: 'UNTRUSTED_PROXY' });
  assert.throws(() => requestIp(req('127.0.0.1', '198.51.100.1, 198.51.100.2'), true), { code: 'CLIENT_IP_REQUIRED' });
});
test('idle expiry requires reconnecting and never restores the same IP daily allowance', async t => {
  let clock = Date.parse('2026-10-10T03:00:00Z');
  const { request, connect } = await serverWith(t, { clock: () => clock });
  const a = await connect();
  assert.equal((await request('/owner/setup/verify', { provider: 'deepseek', aiConsent: true }, a)).status, 200);
  clock += 31 * 60000;
  assert.equal((await request('/status', undefined, a)).body.mcd.configured, false);
  assert.equal((await request('/nutrition', undefined, a)).status, 401);
  const b = await connect(); assert.equal((await request('/status', undefined, b)).body.aiQuota.remaining, 9);
});

test('visitor access works in production without falling back to owner credentials', async t => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
  const { request, connect } = await serverWith(t);
  assert.equal((await request('/status')).body.mcd.configured, false);
  const a = await connect(); assert.equal((await request('/status', undefined, a)).body.mcd.connected, true);
});

test('Cloudflare requests cannot reach the local shared owner account in private mode', async t => {
  const { request, calls } = await serverWith(t, { visitorAccess: false });
  const response = await request('/nutrition', undefined, { 'CF-Connecting-IP': '192.0.2.1' });
  assert.equal(response.status, 403); assert.equal(response.body.error.code, 'VISITOR_ACCESS_REQUIRED'); assert.equal(calls.length, 0);
});

test('startup rejects public origins in shared-owner mode and proxy trust without an HTTPS origin', () => {
  for (const [env, message] of [
    [{ PUBLIC_ORIGIN: 'https://test.example', PUBLIC_ACCESS: 'false' }, /PUBLIC_ORIGIN requires PUBLIC_ACCESS=true/],
    [{ TRUST_CLOUDFLARE_PROXY: 'true' }, /requires PUBLIC_ORIGIN/],
    [{ PUBLIC_ORIGIN: 'http://test.example', PUBLIC_ACCESS: 'true' }, /must be an HTTPS origin/],
  ]) {
    const child = spawnSync(process.execPath, ['server/index.mjs'], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', timeout: 3000 });
    assert.notEqual(child.status, 0); assert.match(child.stderr, message);
  }
});
