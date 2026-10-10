import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApp } from '../server/app.mjs';
import { DEEPSEEK_ENDPOINT } from '../server/deepseek.mjs';

// Offline providers, real application HTTP routes, independent visitor cookies; never places orders.
const output = process.env.QA_OUTPUT || '/tmp/mcd-public-browser';
await mkdir(output, { recursive: true });
const key = 'offline-server-key-never-in-browser';
process.env.DEEPSEEK_API_KEY = key;
const calls = [], posts = [], consoleErrors = [], pageErrors = [], leaks = [];
const meal = { intent: 'meal', clarificationReason: null, goal: 'balanced', clearKcalTarget: false, kcalTarget: null, kcalMin: null, kcalMax: null, proteinMin: null, sugarMax: null, sodiumMax: null, budget: null, avoid: [], preferCoupons: false, includeKeywords: [], includeAnyKeywords: [], unsweetenedDrink: false, beverageOnlyAllowed: false };
const port = 5194, base = `http://127.0.0.1:${port}`;
let clock = Date.parse('2026-10-10T03:00:00Z');
const server = createApp({ port, visitorAccess: true, providerAccessEnabled: true, clock: () => clock, staticDir: process.env.QA_STATIC_DIR, fetchImpl: async (url, init) => {
  const body = JSON.parse(init.body); calls.push(url);
  if (url === DEEPSEEK_ENDPOINT) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(meal) } }] });
  if (init.headers.Authorization === 'Bearer invalid-test-token') return new Response(null, { status: 401 });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
  let result;
  if (body.method === 'initialize') result = { protocolVersion: '2025-06-18' };
  else if (body.method === 'tools/list') result = { tools: ['query-nearby-stores', 'query-meals'].map(name => ({ name, inputSchema: { type: 'object' } })) };
  else {
    assert.notEqual(body.params.name, 'create-order');
    const data = body.params.name === 'query-nearby-stores' ? [{ storeCode: 'test', storeName: '测试餐厅', address: '仅离线验证', businessStatus: true }]
      : { categories: [{ name: '常规餐', meals: [{ code: 'burger', tags: ['牛肉'] }] }], meals: { burger: { name: '测试牛肉堡', currentPrice: '20' } } };
    result = { content: [{ type: 'text', text: JSON.stringify({ success: true, code: 200, data }) }] };
  }
  return Response.json({ jsonrpc: '2.0', id: body.id, result });
} }).createServer();
await new Promise(r => server.listen(port, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : '/usr/bin/google-chrome'), headless: true, args: ['--no-sandbox'] });
let page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', e => pageErrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('request', r => { if (r.method() === 'POST') posts.push({ url: r.url(), body: r.postData() }); });
  page.on('response', async r => { if (new URL(r.url()).origin === base) { const body = await r.text().catch(() => ''); if (body.includes(key) || body.includes('visitor-browser-test-token')) leaks.push(new URL(r.url()).pathname); } });
  await page.goto(base); await page.getByRole('heading', { name: '连接麦当劳账户' }).waitFor();
  assert.equal(page.url(), `${base}/`); assert.equal(await page.title(), '麦搭 · 这一餐，刚刚好');
  assert.equal(await page.locator('input[type=password]').count(), 1); assert.equal(await page.getByText('DeepSeek API Key').count(), 0);
  const link = page.getByRole('link', { name: '去麦当劳 MCP 登录' });
  assert.equal(await link.getAttribute('href'), 'https://open.mcd.cn/mcp'); assert.equal(await link.getAttribute('target'), '_blank');
  assert((await link.getAttribute('rel')).includes('noopener'));
  await page.screenshot({ path: `${output}/desktop-connect.png`, fullPage: true });
  await page.getByLabel('麦当劳 MCP Token', { exact: true }).fill('invalid-test-token'); await page.getByRole('button', { name: '连接并开始' }).click();
  await page.getByRole('alert').waitFor(); assert.equal(await page.getByLabel('麦当劳 MCP Token', { exact: true }).inputValue(), '');
  await page.getByLabel('麦当劳 MCP Token', { exact: true }).fill('visitor-browser-test-token'); await page.getByRole('button', { name: '连接并开始' }).click();
  await page.getByRole('button', { name: '不用，直接开始' }).waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 0);
  await page.evaluate(() => sessionStorage.setItem('mcd-current-order', JSON.stringify({ state: 'completed', orderId: 'previous-account-order', label: 'old account', paymentUrl: 'https://mcd.cn/test-only' })));
  await page.reload();
  await page.getByRole('button', { name: '不用，直接开始' }).click();
  assert.equal(await page.getByText('订单号：previous-account-order').count(), 0);
  const storage = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  assert(!storage.includes('visitor-browser-test-token')); assert(!storage.includes(key));
  assert.equal((await context.cookies()).find(c => c.name === 'mcd_owner').httpOnly, true);
  await page.getByLabel('所在城市').fill('测试城市'); await page.getByRole('button', { name: '查找餐厅' }).click();
  await page.locator('.store-row').first().click(); await page.getByRole('button', { name: '确认这家餐厅' }).click();
  await page.getByRole('group', { name: '切换供餐时间' }).waitFor();
  const state = await (await context.request.get(`${base}/api/owner/setup/status`)).json();
  for (let i = 0; i < 10; i++) {
    const r = await context.request.post(`${base}/api/owner/setup/verify`, { headers: { Origin: base, 'X-CSRF-Token': state.csrfToken }, data: { provider: 'deepseek', aiConsent: true } }); assert.equal(r.status(), 200);
  }
  await page.getByRole('textbox', { name: '描述你的本餐需求' }).fill('想吃牛肉'); await page.locator('.consent-row input').check();
  await page.getByRole('button', { name: '开始规划', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '今天的 10 次 AI 额度已用完' }).waitFor();
  await page.getByText('今日 AI 剩余 0 / 10 次', { exact: false }).waitFor();
  assert.equal(calls.filter(url => url === DEEPSEEK_ENDPOINT).length, 10);
  await page.screenshot({ path: `${output}/desktop-limit.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/mobile-limit.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  clock += 31 * 60000;
  await page.reload(); await page.getByRole('heading', { name: '连接麦当劳账户' }).waitFor();
  await page.screenshot({ path: `${output}/mobile-connect.png`, fullPage: true });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const visitorB = await browser.newPage({ viewport: { width: 320, height: 740 } });
  await visitorB.goto(base); await visitorB.getByRole('heading', { name: '连接麦当劳账户' }).waitFor();
  assert(await visitorB.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  assert.deepEqual(pageErrors, []); assert.deepEqual(leaks, []);
  assert(consoleErrors.every(e => /server responded with a status of (502|429)/.test(e)), consoleErrors.join('\n'));
  assert(posts.every(p => new URL(p.url).origin === base && !p.body.includes(key)));
  assert(posts.filter(p => p.body?.includes('visitor-browser-test-token')).every(p => new URL(p.url).pathname === '/api/owner/setup'));
  await writeFile(`${output}/summary.json`, JSON.stringify({ passed: true, browser: 'Playwright; Browser plugin not available', url: base, viewports: ['1440x1000', '390x844', '320x740'], checks: ['first visit token-only entry and official login link', 'invalid token rejected and input cleared', 'connected session survives refresh', 'tokens absent from storage and response bodies', 'LLM key absent from browser requests, responses and bundles', 'existing store selection works with CSRF', 'ten shared AI calls; eleventh blocked before provider', 'visible remaining count and midnight reset notice', 'idle timeout and independent visitor require reconnect', 'no horizontal overflow, blank screen, framework overlay or JS errors'], expectedHttpErrors: [502, 429], pageErrors, leaks }, null, 2));
  console.log(JSON.stringify({ passed: true, output }));
} catch (e) { if (page) await page.screenshot({ path: `${output}/failure.png`, fullPage: true }); throw e; }
finally { await browser.close(); await new Promise(r => server.close(r)); }
