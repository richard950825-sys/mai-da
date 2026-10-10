import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createApp } from '../server/app.mjs';

// Homepage -> explicit CTA -> personal-token form. No provider traffic or real keys.
const output = process.env.QA_OUTPUT || '/tmp/mcd-landing-browser';
await mkdir(output, { recursive: true });
const port = 5195, base = `http://127.0.0.1:${port}`;
const server = createApp({ port, visitorAccess: true, staticDir: process.env.QA_STATIC_DIR }).createServer();
await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : '/usr/bin/google-chrome'), headless: true, args: ['--no-sandbox'] });
const results = [], errors = [];
try {
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844], ['small-mobile', 320, 740]]) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage(); const apiRequests = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) apiRequests.push(r.url()); });
    await page.goto(base); await page.getByRole('heading', { level: 1, name: /今天这顿/ }).waitFor();
    assert.equal(page.url(), `${base}/`); assert.equal(await page.title(), '麦搭 · 这一餐，刚刚好');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.className), 'landing-skip');
    assert.equal(await page.locator('.landing-skip').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'landing-main');
    await page.evaluate(() => { document.activeElement.blur(); window.scrollTo(0, 0); });
    assert.equal(await page.locator('input[type=password]').count(), 0);
    assert.equal(apiRequests.length, 0, 'Public product page must not depend on backend availability');
    assert.equal(await context.cookies().then(c => c.length), 0, 'No credential session before CTA');
    assert.equal(await page.locator('vite-error-overlay').count(), 0);
    const ctas = page.getByRole('link', { name: '开始搭配', exact: true }); assert.equal(await ctas.count(), 3);
    for (const cta of await ctas.all()) {
      assert.equal(await cta.getAttribute('href'), '/connect');
      const contrast = await cta.evaluate(el => {
        const style = getComputedStyle(el);
        const luminance = color => color.match(/\d+/g).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [0.2126, 0.7152, 0.0722][i], 0);
        const a = luminance(style.color), b = luminance(style.backgroundColor);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      });
      assert(contrast >= 4.5, 'CTA text must be readable against its background');
    }
    const ctaBox = await page.locator('.landing-hero').getByRole('link', { name: '开始搭配' }).boundingBox();
    assert(ctaBox && ctaBox.y + ctaBox.height < height, 'Primary action must be in the first viewport');
    await page.locator('.landing-hero-art img').evaluate(img => img.decode());
    await page.screenshot({ path: `${output}/${name}-hero.png`, fullPage: false });
    await page.getByRole('link', { name: /先看看怎么用/ }).click();
    assert.equal(new URL(page.url()).hash, '#how'); await page.getByRole('heading', { name: '三步，开搭。' }).waitFor();
    await page.locator('.landing-product-preview').scrollIntoViewIfNeeded();
    await page.locator('.landing-product-preview img').evaluate(img => img.decode());
    await page.locator('.landing-showcase').screenshot({ path: `${output}/${name}-showcase.png` });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `${output}/${name}-full.png`, fullPage: true });
    if (width === 1440) {
      await page.locator('.landing-hero').getByRole('link', { name: '开始搭配' }).focus();
      await page.keyboard.press('Enter');
    } else await page.locator('.landing-hero').getByRole('link', { name: '开始搭配' }).click();
    await page.waitForURL(`${base}/connect`); await page.getByRole('heading', { name: '连接麦当劳账户' }).waitFor();
    await page.getByLabel('麦当劳 MCP Token', { exact: true }).waitFor();
    assert.equal(await page.locator('input[type=password]').count(), 1); assert.equal(await page.getByText('DeepSeek API Key').count(), 0);
    assert(await page.getByRole('link', { name: '去麦当劳 MCP 登录' }).getAttribute('href') === 'https://open.mcd.cn/mcp');
    const reads = apiRequests.length; await page.getByRole('link', { name: '返回麦搭首页' }).click();
    await page.getByRole('heading', { level: 1, name: /今天这顿/ }).waitFor(); assert.equal(apiRequests.length, reads);
    await page.goBack(); await page.waitForURL(`${base}/connect`); await page.getByRole('heading', { name: '连接麦当劳账户' }).waitFor();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    results.push({ viewport: `${width}x${height}`, noApiOnHome: true, noTokenBeforeCta: true, navigation: 'home -> how -> connect -> home -> browser back', overflow: false });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(`${output}/summary.json`, JSON.stringify({ passed: true, browser: 'Playwright Chromium; Browser plugin not available', results, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, output, results }));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
