import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.LIVE_BASE_URL || 'http://127.0.0.1:8798';
assert(['127.0.0.1', 'localhost'].includes(new URL(base).hostname), 'Live browser QA is private loopback only');
const output = process.env.LIVE_BROWSER_OUTPUT || '/tmp/mcd-live-browser-qa';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : '/usr/bin/google-chrome'), headless: true, args: ['--no-sandbox'] });
const checks = [], errors = [], posts = [], httpFailures = [];
const evidence = { passed: false, url: base, browser: 'Playwright; Browser plugin not available', viewports: ['1440x1000', '390x844'], checks, errors, httpFailures, realOrderWrites: 0, data: 'Live McD and DeepSeek; public Shanghai landmark used only for QA' };
let currentPage;
async function pageFor(viewport) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', ...(viewport.width < 500 ? { isMobile: true } : {}) });
  const page = await context.newPage(); page.setDefaultTimeout(60000); currentPage = page;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('status of 422')) errors.push(m.text()); });
  page.on('response', r => { if (r.status() >= 400) httpFailures.push({ path: new URL(r.url()).pathname, status: r.status() }); });
  page.on('request', r => { if (r.method() === 'POST') posts.push({ path: new URL(r.url()).pathname, body: r.postData() }); });
  await page.route('**/api/orders/confirm', async route => { errors.push('Unexpected order attempt was blocked'); await route.abort(); });
  await page.goto(base); assert.equal(await page.title(), '麦搭 · 这一餐，刚刚好');
  await page.getByRole('heading', { name: '是否需要帮你规划本餐热量？' }).waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  evidence.orderingEnabled = (await (await page.request.get(`${base}/api/status`)).json()).ordering.enabled;
  return page;
}
const responseFor = (page, path) => page.waitForResponse(r => new URL(r.url()).pathname === `/api${path}` && r.request().method() === 'POST', { timeout: 120000 });
async function selectAndPlan(page, prefix) {
  await page.getByRole('button', { name: '不用，直接开始' }).click();
  await page.getByLabel('所在城市').fill('上海'); await page.getByLabel('附近地标', { exact: false }).fill('人民广场');
  const storeResponse = responseFor(page, '/stores/search'); await page.getByRole('button', { name: '查找餐厅' }).click(); assert.equal((await storeResponse).status(), 200);
  await page.locator('.store-row').first().click(); await page.getByRole('button', { name: '确认这家餐厅' }).click();
  await page.getByRole('textbox', { name: '描述你的本餐需求' }).fill('预算35元，想吃鸡肉，饮料无糖，优先用优惠券');
  await page.locator('.consent-row input').check();
  const response = responseFor(page, '/recommendations'); await page.getByRole('button', { name: '开始规划', exact: true }).click();
  const result = await response; assert.equal(result.status(), 200); const data = await result.json(); assert(data.recommendations.length > 0);
  await page.locator('.plan').first().waitFor(); assert.equal(await page.locator('.plan').count(), data.recommendations.length);
  const quoteResponse = responseFor(page, '/quote'); await page.locator('.plan').first().getByRole('button').click();
  const quoted = (await (await quoteResponse).json()).quote; await page.locator('.meal-summary select').waitFor();
  assert(quoted.takeWayList.length > 0 && quoted.takeWayList.every(t => typeof t.name === 'string' && t.name));
  await page.locator('.meal-summary').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: `${output}/${prefix}-meal.png`, fullPage: false });
  checks.push({ name: `${prefix} real planning`, plans: data.recommendations.length, total: quoted.total, source: data.source });
  return { data, quoted };
}
try {
  const page = await pageFor({ width: 1440, height: 1000 });
  await page.screenshot({ path: `${output}/desktop-intro.png`, fullPage: false });
  const { data, quoted } = await selectAndPlan(page, 'desktop');
  const plan = data.recommendations[0]; const food = plan.foods.find(f => f.role === 'main') || plan.foods[0];
  const increase = page.getByRole('button', { name: `增加${food.name}`, exact: true });
  if (await increase.isDisabled()) {
    assert(food.components?.some(c => c.role === 'drink'));
    checks.push({ name: 'single-person drink cap also applies to increasing a whole combo' });
  } else {
  const quantityResponse = responseFor(page, '/quote'); await page.getByRole('button', { name: `增加${food.name}`, exact: true }).click();
  const larger = (await (await quantityResponse).json()).quote; assert(larger.total > quoted.total);
  const expectedKcal = plan.nutrition.kcal === null || food.nutrition.kcal === null ? null : Math.round((plan.nutrition.kcal + food.nutrition.kcal) * 10) / 10;
  if (expectedKcal === null) assert.match(await page.getByLabel('本餐营养合计').innerText(), /本餐.*未知/);
  else await page.getByLabel('本餐营养合计').getByText(String(expectedKcal), { exact: true }).waitFor();
  await page.getByText('当前金额超过本餐预算', { exact: false }).waitFor();
  assert.match(await page.getByLabel('本餐营养合计').innerText(), /糖.*未知/);
  checks.push({ name: 'quantity updates both live price and nutrition, with budget warning', before: quoted.total, after: larger.total, kcal: expectedKcal });
  const smallerResponse = responseFor(page, '/quote'); await page.getByRole('button', { name: `减少${food.name}`, exact: true }).click(); await smallerResponse;
  }
  await page.locator('.meal-summary select').selectOption({ index: 1 });
  const pickupLabel = await page.locator('.meal-summary select option:checked').innerText();
  const prepareResponse = responseFor(page, '/orders/prepare'); await page.getByRole('button', { name: '确认餐品与金额' }).click(); assert.equal((await prepareResponse).status(), 200);
  await page.getByRole('heading', { name: '确认这一餐' }).waitFor(); const review = await page.locator('.checkout-review').innerText();
  assert.match(review, /无糖可口可乐.*杯/); assert(review.includes(pickupLabel));
  if (evidence.orderingEnabled) { assert(await page.getByRole('button', { name: '确认创建订单，前往支付' }).isDisabled()); assert.equal(await page.locator('.checkout-review input').isChecked(), false); } else { assert.match(review, /没有创建订单或扣款/); }
  await page.screenshot({ path: `${output}/desktop-review.png`, fullPage: false });
  checks.push({ name: 'immutable review identifies real drink size and Chinese pickup; confirmation gate remains untouched' });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('textbox', { name: '描述你的本餐需求' }).fill('请给我写一个Python程序');
  const unrelated = responseFor(page, '/recommendations'); await page.getByRole('button', { name: '开始规划', exact: true }).click(); assert.equal((await unrelated).status(), 422);
  await page.getByText('这里可以帮你搭配麦当劳的一餐。', { exact: false }).waitFor(); assert.equal(await page.locator('.plan').count(), 0); checks.push({ name: 'off-topic input produces helpful stop state' });
  await page.goto(`${base}/owner/setup`); await page.getByText('已连接，可以开始选餐了', { exact: false }).waitFor(); assert.equal(await page.locator('input[type=password]').count(), 0); checks.push({ name: 'configured file mode is accurately described without credential re-entry' });
  await page.goto(`${base}/verify`); await page.getByRole('button', { name: '验证 DeepSeek 4.1 Flash' }).click(); await page.getByText('DeepSeek-V4.1-Flash 真实最小请求成功', { exact: false }).waitFor();
  await page.getByRole('button', { name: '验证麦当劳只读连接' }).click(); await page.getByText('麦当劳真实连接成功', { exact: false }).waitFor(); checks.push({ name: 'verification page performs real provider requests in file mode' });
  const mobile = await pageFor({ width: 390, height: 844 });
  await mobile.screenshot({ path: `${output}/mobile-intro.png`, fullPage: false });
  await selectAndPlan(mobile, 'mobile');
  await mobile.locator('.meal-summary select').selectOption({ index: 1 }); await mobile.getByRole('button', { name: '确认餐品与金额' }).click(); await mobile.getByRole('heading', { name: '确认这一餐' }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.screenshot({ path: `${output}/mobile-review.png`, fullPage: false }); checks.push({ name: 'mobile review is usable at 390px without horizontal overflow' });
  assert(!posts.some(r => r.path === '/api/orders/confirm'));
  assert(!posts.some(r => /heightCm|weightKg|sexParameter/.test(r.body || '')));
  assert.deepEqual(httpFailures, [{ path: '/api/recommendations', status: 422 }]); assert.deepEqual(errors, []);
  evidence.passed = true;
} catch (error) {
  evidence.failure = { name: error.name, message: error.message };
  if (currentPage) { await currentPage.screenshot({ path: `${output}/failure.png`, fullPage: false }).catch(() => {}); await writeFile(`${output}/failure-body.txt`, await currentPage.locator('body').innerText().catch(() => '')).catch(() => {}); }
  console.error(JSON.stringify(evidence.failure)); process.exitCode = 1;
} finally {
  evidence.postCount = posts.length;
  await writeFile(`${output}/summary.json`, JSON.stringify(evidence, null, 2));
  await browser.close(); console.log(JSON.stringify({ passed: evidence.passed, output, checks: checks.length }));
}
