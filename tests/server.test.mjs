import test from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { McdClient, MCD_ENDPOINT, validateArguments } from '../server/mcp.mjs';
import { normalizeNutrition, normalizeMenu, normalizeQuote, sumNutrition, numberOrNull } from '../server/normalize.mjs';
import { DeepSeekClient } from '../server/deepseek.mjs';
import { normalizeConstraints, generateCandidates } from '../server/recommend.mjs';
import { OrderGateway } from '../server/orders.mjs';
import { createApp } from '../server/app.mjs';

// All fixtures below are local test-only data. No provider is contacted in these tests.
const result = data => ({ content: [{ type: 'text', text: JSON.stringify({ success: true, code: 200, data }) }] });
const nutritionFixture = result('[2]{productName,nutritionDescription,energyKj,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  测试餐品A,每份,1288,308,16,16,24,781,213\n  测试餐品B,每份,400,100,null,0,0,0,0\n');
const schema = { type: 'object', properties: { storeCode: { type: 'string' }, beType: { type: 'integer' } }, required: ['storeCode'], additionalProperties: false };
function rpcFetch({ useSse = false, failCall = false, expireSession = false } = {}) {
  const calls = []; let expired = false;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, init, body });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (expireSession && body.method === 'tools/call' && !expired) { expired = true; return new Response(null, { status: 404 }); }
    const payload = body.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : body.method === 'tools/list' ? { tools: [{ name: 'query-meals', inputSchema: schema }, { name: 'create-order', inputSchema: schema }] } : failCall ? { isError: true, content: [] } : result({ meals: {} });
    const message = { jsonrpc: '2.0', id: body.id, result: payload };
    const headers = { 'Content-Type': useSse ? 'text/event-stream' : 'application/json', ...(body.method === 'initialize' ? { 'Mcp-Session-Id': 'test-session' } : {}) };
    return new Response(useSse ? `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n` : JSON.stringify(message), { headers });
  };
  return { fetchImpl, calls };
}

test('real MCP endpoint, bearer isolation, initialization, schema and session headers', async () => {
  const { fetchImpl, calls } = rpcFetch(); const client = new McdClient({ token: 'test-only-secret', fetchImpl });
  const tools = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['query-meals']);
  assert.deepEqual(tools[0].inputSchema, schema);
  await client.callRead('query-meals', { storeCode: 'test-store' });
  assert(calls.every(c => c.url === MCD_ENDPOINT));
  assert(calls.every(c => c.init.headers.Authorization === 'Bearer test-only-secret'));
  assert.equal(calls[2].init.headers['Mcp-Session-Id'], 'test-session');
  assert.equal(calls[2].init.headers['MCP-Protocol-Version'], '2025-06-18');
  assert(!JSON.stringify(client).includes('test-only-secret'));
});
test('MCP handles SSE and bounded expired read session recovery', async () => {
  const { fetchImpl, calls } = rpcFetch({ useSse: true, expireSession: true });
  const client = new McdClient({ token: 'test-only', fetchImpl });
  await client.callRead('query-meals', { storeCode: 'test-store' });
  assert.equal(calls.filter(c => c.body.method === 'initialize').length, 2);
  assert.equal(calls.filter(c => c.body.method === 'tools/call').length, 2);
});
test('every mutating or unknown tool is blocked before network', async () => {
  const { fetchImpl, calls } = rpcFetch(); const client = new McdClient({ token: 'test-only', fetchImpl });
  for (const name of ['create-order', 'cancel-order', 'auto-bind-coupons', 'mall-create-order', 'draw-lottery', 'delivery-create-address', 'new-tool']) await assert.rejects(client.callRead(name, {}), { code: 'TOOL_NOT_ALLOWED' });
  assert.equal(calls.length, 0);
});
test('exact runtime schema rejects missing, extra or wrong-type parameters', () => {
  assert.throws(() => validateArguments(schema, {}), { code: 'MCD_ARGUMENTS_INVALID' });
  assert.throws(() => validateArguments(schema, { storeCode: 123 }), { code: 'MCD_ARGUMENTS_INVALID' });
  assert.throws(() => validateArguments(schema, { storeCode: 's', unexpected: true }), { code: 'MCD_ARGUMENTS_INVALID' });
  assert.throws(() => validateArguments({ $ref: 'https://example.invalid/schema' }, {}), { code: 'MCD_SCHEMA_UNSUPPORTED' });
});
test('TOON-in-JSON nutrition preserves unknowns and genuine zeros', () => {
  const { foods } = normalizeNutrition(nutritionFixture);
  assert.equal(foods[0].nutrition.kcal, 308);
  assert.equal(foods[0].nutrition.sugarG, null);
  assert.equal(foods[0].nutrition.carbsG, 24);
  assert.equal(foods[1].nutrition.proteinG, null);
  assert.equal(foods[1].nutrition.fatG, 0);
  assert.equal(sumNutrition(foods).proteinG, null);
  assert.equal(sumNutrition(foods).sugarG, null);
  assert.equal(sumNutrition(foods).kcal, 408);
  for (const x of ['', null, undefined, false, '未知', '12g', '-2', NaN]) assert.equal(numberOrNull(x), null);
});
test('malformed provider data never becomes an empty successful list', () => {
  assert.throws(() => normalizeNutrition(result('not TOON')), { code: 'NUTRITION_SCHEMA_CHANGED' });
  assert.throws(() => normalizeNutrition({ isError: true }), { code: 'MCD_TOOL_FAILED' });
  assert.throws(() => normalizeNutrition(result({ foods: [] })), { code: 'NUTRITION_SCHEMA_CHANGED' });
});
test('menu uses verified shape; only unique exact-name nutrition match; no paid membership auto-selection', () => {
  const foods = normalizeNutrition(nutritionFixture).foods;
  const menu = normalizeMenu(result({ categories: [{ name: '测试分类', meals: [{ code: 'test-a', tags: [] }] }], meals: { 'test-a': { name: '测试餐品A', currentPrice: '12.5', originalPrice: '18', discountType: '随单购麦金卡优惠', withOrder: { membershipCode: 'test' } }, 'test-b': { name: '测试餐品A大份', currentPrice: '20' } } }), foods);
  assert.equal(menu.items[0].menuPrice, 18);
  assert.equal(menu.items[0].requiresAddOn, true);
  assert.equal(menu.items[0].nutrition.kcal, 308);
  assert.equal(menu.items[1].nutrition.kcal, null);
});
test('price conversion is explicit integer fen, with missing amounts null', () => {
  assert.equal(normalizeQuote(result({ price: 2200, productPrice: 1600, deliveryPrice: 600, discount: 0 })).quote.total, 22);
  assert.equal(normalizeQuote(result({ price: 2200 })).quote.deliveryFee, null);
  assert.throws(() => normalizeQuote(result({ price: '22' })), { code: 'QUOTE_TOTAL_UNKNOWN' });
});
test('DeepSeek sends no tools or provider data; parses only bounded fields', async () => {
  let captured;
  const deepseek = new DeepSeekClient({ apiKey: 'deepseek-test-only', fetchImpl: async (url, init) => { captured = { url, init, body: JSON.parse(init.body) }; return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ intent: 'meal', clarificationReason: null, goal: 'high-protein', clearKcalTarget: false, kcalTarget: null, kcalMin: null, kcalMax: null, proteinMin: 30, sugarMax: null, sodiumMax: null, budget: null, avoid: ['测试食物'], preferCoupons: false, includeKeywords: [], includeAnyKeywords: [], unsweetenedDrink: false, beverageOnlyAllowed: false }) } }] }); } });
  const parsed = await deepseek.parseMealText('高蛋白');
  assert.equal(parsed.proteinMin, 30); assert.equal(parsed.sugarMax, null);
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.body.model, 'deepseek-flash');
  assert(!Object.hasOwn(captured.body, 'tools'));
  assert(!JSON.stringify(captured.body).includes('deepseek-test-only'));
});
test('unknown sugar cannot satisfy a hard sugar limit and totals never coerce null', () => {
  const foods = normalizeNutrition(nutritionFixture).foods;
  const constraints = normalizeConstraints({ preferences: { sugarMax: 10 } });
  assert.equal(generateCandidates(foods, constraints).candidates.length, 0);
});
test('budget and constraints reject malformed bounds', () => {
  assert.throws(() => normalizeConstraints({ budget: -1 }), { code: 'INVALID_CONSTRAINT' });
  assert.throws(() => normalizeConstraints({ mealTarget: { min: 900, max: 400 } }), { code: 'INVALID_CONSTRAINT' });
});

async function serverWith(t, options = {}) {
  const app = createApp(options); const server = app.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const origin = 'http://127.0.0.1:5178';
  const request = async (route, body, extra = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path: route, method: body === undefined ? 'GET' : 'POST', headers: { Host: '127.0.0.1:8788', Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: { get: name => { const value = res.headers[name.toLowerCase()]; return Array.isArray(value) ? value.join(', ') : value || null; } }, text: async () => text, json: async () => JSON.parse(text) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { request, server };
}
test('default HTTP server reports missing integrations with no sample fallback', async t => {
  const { request } = await serverWith(t);
  const status = await (await request('/api/status')).json();
  assert.equal(status.mcd.configured, false); assert.equal(status.ordering.enabled, false);
  const missing = await request('/api/nutrition'); assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error.code, 'MCD_NOT_CONFIGURED');
  const setup = await (await request('/api/owner/setup/status')).json(); assert.equal(setup.enabled, false);
  assert(!Object.hasOwn(setup, 'csrfToken'));
});
test('owner setup is write-only, CSRF-protected, memory-only and provider access separately gated', async t => {
  const { request } = await serverWith(t, { ownerSetupEnabled: true });
  const setup = await request('/api/owner/setup/status'); const cookie = setup.headers.get('set-cookie').split(';')[0]; const state = await setup.json();
  const denied = await request('/api/owner/setup', { mcdToken: 'test-only-token' }, { Cookie: cookie }); assert.equal(denied.status, 403);
  const saved = await request('/api/owner/setup', { mcdToken: 'test-only-token', deepseekApiKey: 'test-only-key' }, { Cookie: cookie, 'X-CSRF-Token': state.csrfToken });
  const text = await saved.text(); assert.equal(saved.status, 200); assert(!text.includes('test-only-token')); assert(!text.includes('test-only-key'));
  assert.equal((await (await request('/api/owner/setup/status', undefined, { Cookie: cookie })).json()).mcdConfigured, true);
  const blocked = await request('/api/nutrition', undefined, { Cookie: cookie }); assert.equal((await blocked.json()).error.code, 'PROVIDER_ACCESS_DISABLED');
  const leaked = await request('/api/status', undefined, { Cookie: cookie }); assert(!(await leaked.text()).includes('test-only-token'));
  const alien = await request('/api/owner/setup', { mcdToken: 'test-only-token' }, { Cookie: cookie, Origin: 'https://evil.example', 'X-CSRF-Token': state.csrfToken }); assert.equal(alien.status, 403);
});
test('owner sessions isolate different users credentials', async t => {
  const { request } = await serverWith(t, { ownerSetupEnabled: true });
  const a = await request('/api/owner/setup/status'); const cookie = a.headers.get('set-cookie').split(';')[0]; const state = await a.json();
  await request('/api/owner/setup', { mcdToken: 'user-a-test-secret' }, { Cookie: cookie, 'X-CSRF-Token': state.csrfToken });
  const b = await request('/api/owner/setup/status'); assert.equal((await b.json()).mcdConfigured, false);
  assert.notEqual(b.headers.get('set-cookie').split(';')[0], cookie);
});
test('default order execution is blocked even with a confirmation-shaped body', async () => {
  const gateway = new OrderGateway();
  await assert.rejects(gateway.confirm('u', { confirmed: true, acceptedTerms: true }, {}), { code: 'ORDERING_DISABLED' });
});
test('order gateway code can be verified offline for confirmation binding and exact-once behavior', async () => {
  let writes = 0; let currentTotal = 22;
  const gateway = new OrderGateway({ enabled: true, termsUrl: 'https://open.mcd.cn/mcp', cancellationDisclosure: 'TEST ONLY disclosure' });
  const client = { getOrderSchema: async () => ({ type: 'object' }), createConfirmedOrder: async () => { writes++; await new Promise(r => setTimeout(r, 5)); return result({ orderId: 'test-order', payH5Url: 'https://mcd.cn/test-only-pay' }); } };
  const quote = gateway.rememberQuote('u', { quote: { total: 22, currency: 'CNY', items: [], takeWayList: [{ code: 'takeout' }] } }, { orderType: 1, beType: 1, storeCode: 'test', items: [{ productCode: 'test', quantity: 1 }] }).quote;
  const { proposal } = await gateway.prepare('u', { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } }, client);
  const body = { proposalId: proposal.id, confirmationNonce: proposal.confirmationNonce, confirmed: true, acceptedTerms: true, expectedTotal: 22, currency: 'CNY', paymentMethod: 'provider-checkout' };
  await assert.rejects(gateway.confirm('other-user', body, { client }), { code: 'PROPOSAL_INVALID' });
  const deps = { client, reprice: async () => ({ quote: { total: currentTotal, currency: 'CNY', takeWayList: [{ code: 'takeout' }] } }) };
  const outputs = await Promise.all([gateway.confirm('u', body, deps), gateway.confirm('u', body, deps)]);
  assert.equal(writes, 1); assert.equal(outputs[0].orderId, 'test-order');
  await gateway.confirm('u', body, deps); assert.equal(writes, 1);
});
test('price change invalidates confirmation before any write and unknown outcome is not retried', async () => {
  const make = async fail => {
    let writes = 0;
    const gateway = new OrderGateway({ enabled: true, termsUrl: 'https://open.mcd.cn/mcp', cancellationDisclosure: 'TEST ONLY' });
    const client = { getOrderSchema: async () => ({ type: 'object' }), createConfirmedOrder: async () => { writes++; throw new Error('simulated timeout'); } };
    const quote = gateway.rememberQuote('u', { quote: { total: 22, currency: 'CNY', items: [], takeWayList: [{ code: 'takeout' }] } }, { orderType: 1, beType: 1, storeCode: 'test', items: [] }).quote;
    const { proposal } = await gateway.prepare('u', { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } }, client);
    const body = { proposalId: proposal.id, confirmationNonce: proposal.confirmationNonce, confirmed: true, acceptedTerms: true, expectedTotal: 22, currency: 'CNY', paymentMethod: 'provider-checkout' };
    const deps = { client, reprice: async () => ({ quote: { total: fail ? 22 : 23, currency: 'CNY', takeWayList: [{ code: 'takeout' }] } }) };
    await assert.rejects(gateway.confirm('u', body, deps), { code: fail ? 'ORDER_OUTCOME_UNCERTAIN' : 'PRICE_CHANGED' });
    await assert.rejects(gateway.confirm('u', body, deps));
    assert.equal(writes, fail ? 1 : 0);
  };
  await make(false); await make(true);
});

test('scalar calorie target enforces 10 percent band and parsed preferences survive UI defaults', () => {
  const constraints = normalizeConstraints({ mealTarget: 600, preferences: { goal: 'balanced', avoid: [] } }, { goal: 'high-protein', avoid: ['测试B'] });
  assert.equal(constraints.kcalMin, 540); assert.equal(constraints.kcalMax, 660);
  assert.equal(constraints.goal, 'high-protein'); assert.deepEqual(constraints.avoid, ['测试B']);
  const foods = normalizeNutrition(nutritionFixture).foods;
  assert(generateCandidates(foods, constraints).candidates.every(c => c.nutrition.kcal >= 540 && c.nutrition.kcal <= 660));
});
test('per-100g or unspecified serving records never attach to an entire menu meal', () => {
  const nutrition = normalizeNutrition(result('[3]{productName,nutritionDescription,energyKcal,protein}:\n  测试200克餐品,每100克,200,20\n  测试未知餐品,null,300,30\n  测试每份餐品,每份,400,40\n'));
  const menu = normalizeMenu(result({ meals: { a: { name: '测试200克餐品' }, b: { name: '测试未知餐品' }, c: { name: '测试每份餐品' } } }), nutrition.foods);
  assert.equal(menu.items[0].nutrition.kcal, null);
  assert.equal(menu.items[1].nutrition.kcal, null);
  assert.equal(menu.items[2].nutrition.kcal, 400);
  const candidates = generateCandidates(nutrition.foods, normalizeConstraints({})).candidates;
  assert(candidates.every(c => c.foods.every(f => f.name === '测试每份餐品')));
});
test('coupon variants require exact eligible product codes and never bind or stack coupons', async () => {
  const { couponQuoteVariants } = await import('../server/coupons.mjs');
  const base = { storeCode: 'test', items: [{ productCode: 'a', quantity: 1 }, { productCode: 'b', quantity: 1 }] };
  const coupons = [{ couponId: 'test-c1', couponCode: 'code1', products: [{ productCode: 'a' }] }, { couponId: 'test-c2', couponCode: 'code2', products: [{ productCode: 'wrong' }] }];
  const variants = couponQuoteVariants(base, coupons);
  assert.equal(variants.length, 2); assert.equal(variants[1].args.items[0].couponId, 'test-c1');
  assert(!variants[1].args.items[1].couponId); assert(!base.items[0].couponId);
});
test('uncertain and completed quote IDs cannot be prepared into a second order proposal', async () => {
  for (const fails of [true, false]) {
    let writes = 0;
    const gateway = new OrderGateway({ enabled: true, termsUrl: 'https://open.mcd.cn/mcp', cancellationDisclosure: 'TEST ONLY' });
    const client = { getOrderSchema: async () => ({ type: 'object' }), createConfirmedOrder: async () => { writes++; if (fails) throw Error('offline simulated timeout'); return result({ orderId: 'test-order', payH5Url: 'https://mcd.cn/test-pay' }); } };
    const quote = gateway.rememberQuote('u', { quote: { total: 22, currency: 'CNY', items: [], takeWayList: [{ code: 'takeout' }] } }, { orderType: 1, beType: 1, storeCode: 'test', items: [] }).quote;
    const request = { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } };
    const { proposal } = await gateway.prepare('u', request, client);
    const body = { proposalId: proposal.id, confirmationNonce: proposal.confirmationNonce, confirmed: true, acceptedTerms: true, expectedTotal: 22, currency: 'CNY', paymentMethod: 'provider-checkout' };
    try { await gateway.confirm('u', body, { client, reprice: async () => ({ quote: { total: 22, currency: 'CNY', takeWayList: [{ code: 'takeout' }] } }) }); } catch {}
    await assert.rejects(gateway.prepare('u', request, client), { code: 'QUOTE_ALREADY_SUBMITTED' });
    assert.equal(writes, 1);
  }
});
test('credential invalidation destroys all prior account quotes and confirmation nonces', async () => {
  const gateway = new OrderGateway({ enabled: true, termsUrl: 'https://open.mcd.cn/mcp', cancellationDisclosure: 'TEST ONLY' });
  let writes = 0;
  const client = { getOrderSchema: async () => ({ type: 'object' }), createConfirmedOrder: async () => { writes++; throw Error('must not call'); } };
  const quote = gateway.rememberQuote('same-owner-session', { quote: { total: 22, currency: 'CNY', items: [], takeWayList: [{ code: 'takeout' }] } }, { orderType: 1, beType: 1, storeCode: 'test', items: [] }).quote;
  const { proposal } = await gateway.prepare('same-owner-session', { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } }, client);
  gateway.invalidateUser('same-owner-session');
  await assert.rejects(gateway.prepare('same-owner-session', { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } }, client), { code: 'QUOTE_EXPIRED' });
  await assert.rejects(gateway.confirm('same-owner-session', { proposalId: proposal.id }, { client }), { code: 'PROPOSAL_INVALID' });
  assert.equal(writes, 0);
});
test('live-schema string formats are validated without coercion', () => {
  assert.throws(() => validateArguments({ type: 'object', properties: { at: { type: 'string', format: 'date-time' } } }, { at: 'tomorrow' }), { code: 'MCD_ARGUMENTS_INVALID' });
  assert.throws(() => validateArguments({ type: 'object', properties: { at: { type: 'string', format: 'not-a-known-format' } } }, {}), { code: 'MCD_SCHEMA_UNSUPPORTED' });
});

test('latest parsed target overrides prior UI target; explicit cancellation clears all calorie limits', () => {
  const changed = normalizeConstraints({ mealTarget: 650 }, { kcalTarget: 800 });
  assert.equal(changed.kcalTarget, 800); assert.equal(changed.kcalMin, 720); assert.equal(changed.kcalMax, 880);
  const cleared = normalizeConstraints({ mealTarget: 650 }, { clearKcalTarget: true, kcalTarget: null });
  assert.equal(cleared.kcalTarget, null); assert.equal(cleared.kcalMin, null); assert.equal(cleared.kcalMax, null);
  const intersected = normalizeConstraints({ mealTarget: 650 }, { kcalMax: 700 });
  assert.equal(intersected.kcalMax, 700);
  const tighter = normalizeConstraints({ mealTarget: { min: 550, max: 700 } }, { kcalTarget: 650, kcalMax: 680 });
  assert.equal(tighter.kcalMin, 585); assert.equal(tighter.kcalMax, 680);
});

test('an explicitly edited structured target, including cleared null, wins over stale text', () => {
  const manual = normalizeConstraints({ mealTarget: 500, preferStructuredTarget: true }, { kcalTarget: 800, kcalMax: 900 });
  assert.equal(manual.kcalTarget, 500); assert.equal(manual.kcalMax, 550);
  const cleared = normalizeConstraints({ mealTarget: null, preferStructuredTarget: true }, { kcalTarget: 800, kcalMax: 900 });
  assert.equal(cleared.kcalTarget, null); assert.equal(cleared.kcalMin, null); assert.equal(cleared.kcalMax, null);
});
test('HTTP credential provider rotation invalidates previously prepared order before any write', async t => {
  let token = 'account-A-test-only'; const writes = [];
  const fetchImpl = async (url, init) => {
    const req = JSON.parse(init.body);
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let data;
    if (req.method === 'initialize') data = { protocolVersion: '2025-06-18' };
    else if (req.method === 'tools/list') data = { tools: ['calculate-price', 'create-order'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else if (req.params.name === 'calculate-price') data = result({ price: 2200, productPrice: 2200, deliveryPrice: 0, discount: 0, productList: req.params.arguments.items.map(i => ({ productCode: i.productCode, quantity: i.quantity })), takeWayList: [{ code: 'takeout' }] });
    else { writes.push(req); data = result({ orderId: 'never-expected', payH5Url: 'https://mcd.cn/test-only' }); }
    return Response.json({ jsonrpc: '2.0', id: req.id, result: data });
  };
  const { request } = await serverWith(t, { providerAccessEnabled: true, orderingEnabled: true, orderTermsUrl: 'https://open.mcd.cn/mcp', cancellationDisclosure: 'TEST ONLY', resolveUser: async () => ({ id: 'owner' }), resolveCredentials: async () => ({ mcdToken: token }), verifyCsrf: async () => true, fetchImpl });
  const quoteResponse = await request('/api/quote', { storeContext: { storeCode: 'test-store', orderType: 1, beType: 1 }, items: [{ productCode: 'test-item', quantity: 1 }] });
  const { quote } = await quoteResponse.json(); assert(quote);
  const prepared = await request('/api/orders/prepare', { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } });
  const { proposal } = await prepared.json(); assert(proposal);
  token = 'account-B-test-only';
  const confirmation = await request('/api/orders/confirm', { proposalId: proposal.id, confirmationNonce: proposal.confirmationNonce, confirmed: true, acceptedTerms: true, expectedTotal: 22, currency: 'CNY', paymentMethod: 'provider-checkout' });
  assert.equal((await confirmation.json()).error.code, 'PROPOSAL_INVALID'); assert.equal(writes.length, 0);
});

test('recommendations fetch real-shaped menu/coupons and retain the best actually quoted eligible coupon', async t => {
  const toolCalls = [];
  const fetchImpl = async (url, init) => {
    const req = JSON.parse(init.body); let data;
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (req.method === 'initialize') data = { protocolVersion: '2025-06-18' };
    else if (req.method === 'tools/list') data = { tools: ['list-nutrition-foods', 'query-meals', 'query-store-coupons', 'calculate-price'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else {
      toolCalls.push(req.params);
      switch (req.params.name) {
        case 'list-nutrition-foods': data = result('[2]{productName,nutritionDescription,energyKcal,protein,fat,carbohydrate,sodium,calcium}:\n  测试鸡腿堡,每份,300,20,5,30,200,30\n  测试薯条,每份,300,20,5,30,200,30\n'); break;
        case 'query-meals': data = result({ meals: { a: { name: '测试鸡腿堡', currentPrice: '12' }, b: { name: '测试薯条', currentPrice: '12' } } }); break;
        case 'query-store-coupons': data = result([{ title: '测试券', couponId: 'test-coupon', couponCode: 'test-code', products: [{ productCode: 'a', productName: '测试鸡腿堡' }] }]); break;
        case 'calculate-price': { const discounted = req.params.arguments.items.some(i => i.couponId === 'test-coupon'); data = result({ price: discounted ? 2100 : 2400, productPrice: discounted ? 2100 : 2400, deliveryPrice: 0, discount: discounted ? 300 : 0, productList: req.params.arguments.items.map(i => ({ productCode: i.productCode, quantity: i.quantity })) }); break; }
        default: throw Error('Unexpected tool');
      }
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result: data });
  };
  const { request } = await serverWith(t, { providerAccessEnabled: true, resolveUser: async () => ({ id: 'test-user' }), resolveCredentials: async () => ({ mcdToken: 'test-only-token' }), fetchImpl });
  const response = await request('/api/recommendations', { mealTarget: 600, budget: 22, storeContext: { storeCode: 'test-store', orderType: 1, beType: 1 } });
  const payload = await response.json(); assert.equal(response.status, 200);
  assert.equal(payload.recommendations.length, 1);
  assert.equal(payload.recommendations[0].price, 21);
  assert.equal(payload.recommendations[0].nutrition.kcal, 600);
  assert.equal(payload.recommendations[0].nutrition.sugarG, null);
  assert(payload.recommendations[0].foods.some(f => f.couponId === 'test-coupon'));
  assert(toolCalls.some(c => c.name === 'query-store-coupons'));
  assert.equal(toolCalls.filter(c => c.name === 'calculate-price').length, 2);
  assert(!toolCalls.some(c => /create|bind|lottery|cancel/.test(c.name)));
});

test('explicit food keywords and named unsweetened drink preference constrain factual candidates', () => {
  const food = (id, name, kcal, category) => ({ id, name, category, basis: { kind: 'serving' }, nutrition: { kcal, proteinG: 10, fatG: 5, carbsG: 20, sugarG: null, sodiumMg: 100, calciumMg: 10 } });
  const foods = [food('a','测试鸡腿堡',350,'汉堡'),food('b','测试牛肉堡',400,'汉堡'),food('c','测试无糖可乐',1,'饮料'),food('d','测试美式咖啡',10,'饮料')];
  const preferences = normalizeConstraints({}, { includeKeywords: ['鸡'], unsweetenedDrink: true });
  const candidates = generateCandidates(foods, preferences).candidates;
  assert(candidates.length > 0);
  assert(candidates.every(c => c.foods.some(f => f.name.includes('鸡')) && c.foods.some(f => f.name.includes('无糖可乐'))));
  assert(candidates.every(c => c.nutrition.sugarG === null));
  const drinks = foods.slice(2);
  assert.equal(generateCandidates(drinks, normalizeConstraints({})).candidates.length, 0);
  assert(generateCandidates(drinks, normalizeConstraints({}, { beverageOnlyAllowed: true })).candidates.length > 0);
});

test('source-proven serving basis requires exact name and complete nutrient fingerprint, never fills facts', () => {
  const exact = { productName: '猪柳麦满分', nutritionDescription: null, energyKj: 1288, energyKcal: 308, protein: 16, fat: 16, carbohydrate: 24, sodium: 781, calcium: 213 };
  const normalized = normalizeNutrition(result([exact]));
  assert.equal(normalized.foods[0].basis.kind, 'serving');
  assert.equal(normalized.foods[0].basis.evidence.url, 'https://www.mcdonalds.com.cn/product/sausage-mcmuffin');
  for (const altered of [{ ...exact, productName: '猪柳麦满分大份' }, { ...exact, sodium: 782 }, { ...exact, calcium: null }, { ...exact, energyKcal: 400 }, { ...exact, nutritionDescription: '每100克' }]) {
    const food = normalizeNutrition(result([altered])).foods[0];
    assert.notEqual(food.basis.kind, 'serving');
  }
  assert.equal(normalizeNutrition(result([{ ...exact, calcium: null }])).foods[0].nutrition.calciumMg, null);
});
test('unsweetened beverage preference excludes ordinary beverages even when zero cola is also present', () => {
  const food = (id,name,kcal,category) => ({ id,name,category,basis:{kind:'serving'},nutrition:{kcal,proteinG:10,fatG:5,carbsG:20,sugarG:null,sodiumMg:100,calciumMg:10} });
  const foods = [food('a','测试鸡腿堡',350,'汉堡'),food('b','测试无糖可乐',0,'饮料'),food('c','测试普通可乐',120,'饮料'),food('d','测试美式咖啡',10,'饮料')];
  const candidates = generateCandidates(foods,normalizeConstraints({}, { includeKeywords:['鸡'],unsweetenedDrink:true })).candidates;
  assert(candidates.length > 0);
  assert(candidates.every(c => c.foods.every(f => !['c','d'].includes(f.id))));
  assert(candidates.every(c => c.nutrition.sugarG === null));
});

test('city-only store search stays in the explicit city and never queries account favorites', async t => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const req = JSON.parse(init.body); calls.push(req);
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const payload = req.method === 'initialize' ? { protocolVersion: '2025-06-18' } : req.method === 'tools/list' ? { tools: [{ name: 'query-nearby-stores', inputSchema: { type: 'object' } }] } : result([]);
    return Response.json({ jsonrpc: '2.0', id: req.id, result: payload });
  };
  const { request } = await serverWith(t, { providerAccessEnabled: true, resolveUser: async () => ({ id: 'test' }), resolveCredentials: async () => ({ mcdToken: 'test-only' }), fetchImpl });
  assert.equal((await request('/api/stores/search', { city: '上海', query: '' })).status, 200);
  assert.deepEqual(calls.find(c => c.method === 'tools/call').params.arguments, { searchType: 2, beType: 1, city: '上海', keyword: '麦当劳' });
  const count = calls.length;
  assert.equal((await (await request('/api/stores/search', {})).json()).error.code, 'CITY_REQUIRED');
  assert.equal((await (await request('/api/stores/search', { coordinates: { latitude: 31, longitude: 121 } })).json()).error.code, 'LOCATION_SEARCH_UNAVAILABLE');
  assert.equal(calls.length, count);
});
test('live-shaped pickup titles remain Chinese and missing fees remain unknown', () => {
  const { quote } = normalizeQuote(result({ price: 3300, takeWayList: [{ code: 'eat-in', title: '堂食', subtitle: '店内用餐' }] }));
  assert.equal(quote.takeWayList[0].name, '堂食'); assert.equal(quote.deliveryFee, null);
});
test('calculator serving metadata matches all six live nutrients, keeps zero and fails closed on changes', () => {
  const row = { productName: '无糖可口可乐小杯', nutritionDescription: null, energyKj: 0, energyKcal: 0, protein: 0, fat: 0, carbohydrate: 0, sodium: 25, calcium: 0 };
  const food = normalizeNutrition(result([row])).foods[0];
  assert.equal(food.basis.kind, 'serving'); assert.equal(food.nutrition.kcal, 0); assert.equal(food.nutrition.sugarG, null);
  for (const altered of [{ ...row, sodium: 26 }, { ...row, sodium: null }, { ...row, productName: '无糖可口可乐' }, { ...row, nutritionDescription: '每100毫升' }]) assert.notEqual(normalizeNutrition(result([altered])).foods[0].basis.kind, 'serving');
});
test('only-drinks and meat exclusions apply to every candidate', () => {
  const food = (id, name) => ({ id, name, basis: { kind: 'serving' }, nutrition: { kcal: 300, proteinG: 20, sugarG: null, sodiumMg: 100 } });
  const foods = [food('a', '测试鸡腿堡'), food('b', '测试牛肉堡'), food('c', '测试无糖可乐'), food('d', '测试咖啡')];
  const drinks = generateCandidates(foods, normalizeConstraints({ preferences: { beverageOnlyAllowed: true } })).candidates;
  assert(drinks.length); assert(drinks.every(c => c.foods.every(f => /可乐|咖啡/.test(f.name))));
  const excluded = generateCandidates(foods, normalizeConstraints({ preferences: { avoid: ['鸡肉'] } })).candidates;
  assert(excluded.length); assert(excluded.every(c => c.foods.every(f => !f.name.includes('鸡'))));
});
test('immutable order review includes the provider-verified selected drink size', async () => {
  const gateway = new OrderGateway();
  const item = { productCode: 'test-group', quantity: 1, roundList: [{ round: '1', comboItemList: [{ code: 'test-zero', quantity: 1 }] }] };
  const quote = gateway.rememberQuote('u', { quote: { total: 10, currency: 'CNY', items: [{ productCode: 'test-group', productName: '测试可乐' }], takeWayList: [{ code: 'eat-in' }] } }, { storeCode: 'test-store', orderType: 1, beType: 1, items: [item] }).quote;
  const client = { getOrderSchema: async () => ({ type: 'object' }), callRead: async (name, args) => {
    assert.equal(name, 'query-meal-detail'); assert.equal(args.code, 'test-group'); assert.equal(args.items, undefined);
    return result({ code: 'test-group', rounds: [{ id: 1, minQuantity: 1, maxQuantity: 1, choices: [{ code: 'test-zero', name: '测试无糖可乐小杯' }] }] });
  } };
  const review = await gateway.prepare('u', { quoteId: quote.id, fulfillment: { takeWayCode: 'eat-in' } }, client);
  assert.equal(review.executionEnabled, false); assert.match(review.proposal.items[0].name, /测试无糖可乐小杯 ×1/);
});

test('private file mode reports configuration without exposing keys and verifies only with origin and consent', async t => {
  const saved = { mcd: process.env.MCD_MCP_TOKEN, deepseek: process.env.DEEPSEEK_API_KEY };
  process.env.MCD_MCP_TOKEN = 'local-test-mcd-only'; process.env.DEEPSEEK_API_KEY = 'local-test-deepseek-only';
  t.after(() => { for (const [key, value] of [['MCD_MCP_TOKEN', saved.mcd], ['DEEPSEEK_API_KEY', saved.deepseek]]) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const { fetchImpl, calls } = rpcFetch();
  const { request } = await serverWith(t, { allowLocalEnvCredentials: true, providerAccessEnabled: true, fetchImpl });
  const status = await (await request('/api/owner/setup/status')).json();
  assert.equal(status.credentialMode, 'local-file'); assert.equal(status.persistentStorage, true); assert.equal(status.enabled, false);
  assert(status.mcdConfigured && status.deepseekConfigured); assert(!JSON.stringify(status).includes('local-test-'));
  assert.equal((await request('/api/providers/verify', { provider: 'deepseek' })).status, 422); assert.equal(calls.length, 0);
  assert.equal((await request('/api/providers/verify', { provider: 'mcd' }, { Origin: 'https://untrusted.invalid' })).status, 403); assert.equal(calls.length, 0);
  assert.equal((await request('/api/providers/verify', { provider: 'mcd' })).status, 200);
  assert.equal((await request('/api/owner/setup', { mcdToken: 'not-accepted' })).status, 403);
  const { request: sessionRequest } = await serverWith(t, { ownerSetupEnabled: true, allowLocalEnvCredentials: true, providerAccessEnabled: true, fetchImpl });
  assert.equal((await sessionRequest('/api/providers/verify', { provider: 'mcd' })).status, 403);
});

test('an upstream successful but incomplete quote never makes omitted items free', () => {
  const requested = [{ productCode: 'test-burger', quantity: 1 }, { productCode: 'test-coupon-only', quantity: 1 }];
  for (const data of [
    { price: 0, productList: [] },
    { price: 2300, productList: [{ productCode: 'test-burger', quantity: 1 }] },
    { price: 2300, productList: [{ productCode: 'test-burger', quantity: 1 }, { productCode: 'test-coupon-only', quantity: 2 }] },
    { price: 2300, productList: [{ productCode: 'test-burger', quantity: '1' }, { productCode: 'test-coupon-only', quantity: 1 }] },
  ]) assert.throws(() => normalizeQuote(result(data), requested), { code: 'QUOTE_ITEMS_UNVERIFIED' });
  assert.equal(normalizeQuote(result({ price: 0, productList: requested }), requested).quote.total, 0, 'a genuine complete zero-price quote remains zero');
  assert.equal(normalizeQuote(result({ price: 3000, productList: [{ productCode: 'test-burger', quantity: 2 }] }), [{ productCode: 'test-burger', quantity: 1 }, { productCode: 'test-burger', quantity: 1 }]).quote.total, 30);
});

test('request logs correlate concurrent model failures without persisting text, credentials, cookies or URL queries', async t => {
  const logs = [];
  const fetchImpl = async (_url, init) => {
    await new Promise(r => setTimeout(r, init.body.includes('private-first') ? 15 : 5));
    return new Response(null, { status: 429 });
  };
  const { request } = await serverWith(t, { logger: event => logs.push(event), providerAccessEnabled: true, resolveUser: async () => ({ id: 'private-user-id' }), resolveCredentials: async () => ({ deepseekApiKey: 'secret-provider-key' }), fetchImpl });
  const responses = await Promise.all(['private-first-message', 'private-second-message'].map(text => request('/api/recommendations?private-query=do-not-log', { text, aiConsent: true }, { Authorization: 'Bearer secret-header', Cookie: 'private-cookie-value' })));
  const ids = [];
  for (const response of responses) {
    assert.equal(response.status, 429); const body = await response.json();
    const id = response.headers.get('x-request-id'); assert.match(id, /^[a-f0-9]{18}$/); assert.equal(body.error.requestId, id); ids.push(id);
    const records = logs.filter(e => e.requestId === id);
    assert.equal(records.filter(e => e.event === 'provider_http').length, 1);
    assert(records.some(e => e.event === 'provider_http' && e.provider === 'deepseek' && e.status === 429));
    const end = records.filter(e => e.event === 'request_finished'); assert.equal(end.length, 1);
    assert.equal(end[0].phase, 'parse-input'); assert.equal(end[0].code, 'DEEPSEEK_HTTP_ERROR'); assert.equal(end[0].status, 429); assert(end[0].durationMs >= 0);
  }
  assert.notEqual(ids[0], ids[1]);
  const serialized = JSON.stringify(logs);
  for (const privateText of ['private-first-message', 'private-second-message', 'private-query', 'do-not-log', 'secret-provider-key', 'secret-header', 'private-cookie-value', 'private-user-id']) assert(!serialized.includes(privateText));
});
test('empty recommendations are traceable as no matching candidates, not a transport failure', async t => {
  const logs = [];
  const fetchImpl = async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const payload = req.method === 'initialize' ? { protocolVersion: '2025-06-18' } : req.method === 'tools/list' ? { tools: [{ name: 'list-nutrition-foods', inputSchema: { type: 'object' } }] } : result([]);
    return Response.json({ jsonrpc: '2.0', id: req.id, result: payload });
  };
  const { request } = await serverWith(t, { logger: e => logs.push(e), providerAccessEnabled: true, resolveUser: async () => ({ id: 'test' }), resolveCredentials: async () => ({ mcdToken: 'test-only' }), fetchImpl });
  const response = await request('/api/recommendations', { preferences: { goal: 'balanced' } }); const body = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(body.recommendations, []); assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert(logs.some(e => e.requestId === body.requestId && e.phase === 'complete' && e.outcome === 'no-matching-candidates' && e.returned === 0));
});
test('unknown routes are redacted and logging sink failures do not break the API', async t => {
  const logs = []; const { request } = await serverWith(t, { logger: e => logs.push(e) });
  assert.equal((await request('/api/never-log-this-private-path')).status, 404);
  assert(logs.every(e => !JSON.stringify(e).includes('never-log-this-private-path')));
  assert(logs.some(e => e.route === '/api/unknown'));
  const { request: brokenLog } = await serverWith(t, { logger: () => { throw Error('unavailable sink'); } });
  assert.equal((await brokenLog('/api/status')).status, 200);
});

test('common zero-cola name and beverage category exclusions match actual food names', () => {
  const food = (id, name) => ({ id, name, basis: { kind: 'serving' }, nutrition: { kcal: 100, proteinG: 10, sugarG: null, sodiumMg: 100 } });
  const foods = [food('a', '测试鸡肉堡'), food('b', '无糖可口可乐小杯'), food('c', '纯悦'), food('d', '【美汁源】黄金橙橙')];
  const drinks = generateCandidates(foods, normalizeConstraints({ preferences: { beverageOnlyAllowed: true, includeKeywords: ['无糖可乐'], unsweetenedDrink: true } })).candidates;
  assert(drinks.length); assert(drinks.every(p => p.foods.every(f => f.id === 'b')));
  const excluded = generateCandidates(foods, normalizeConstraints({ preferences: { includeKeywords: ['鸡肉'], avoid: ['饮料'] } })).candidates;
  assert(excluded.length); assert(excluded.every(p => p.foods.every(f => f.id === 'a')));
});
test('tight budgets prioritize affordable catalog candidates but never turn hints into payable prices', () => {
  const food = (id, name, menuPrice) => ({ id, name, menuPrice, basis: { kind: 'serving' }, nutrition: { kcal: 300, proteinG: 20, sugarG: null } });
  const foods = [...Array.from({ length: 20 }, (_, i) => food(`expensive-${i}`, `测试汉堡${i}`, 35)), food('cheap-chicken', '测试鸡腿堡', 14), food('cheap-side', '测试薯条', 5)];
  const candidates = generateCandidates(foods, normalizeConstraints({ budget: 20 }), 8).candidates;
  assert(candidates.length); assert(candidates[0].foods.every(f => f.id.startsWith('cheap-')));
  assert(candidates.some(p => p.foods.length === 2 && p.foods.every(f => f.id.startsWith('cheap-'))));
  assert(candidates.every(p => p.price === null && p.priceStatus === 'unverified' && !Object.hasOwn(p, 'priceHint')));
});
test('complete model output exceeding numeric limits is rejected with an actionable limit error', async () => {
  const output = { intent: 'meal', clarificationReason: null, goal: 'balanced', clearKcalTarget: false, kcalTarget: 100000, kcalMin: null, kcalMax: null, proteinMin: null, sugarMax: null, sodiumMax: null, budget: 20000, avoid: [], preferCoupons: false, includeKeywords: [], includeAnyKeywords: [], unsweetenedDrink: false, beverageOnlyAllowed: false };
  const client = new DeepSeekClient({ apiKey: 'test-only', fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).temperature, 0);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
  } });
  await assert.rejects(client.parseMealText('本餐100000千卡'), { code: 'MEAL_LIMIT_OUT_OF_RANGE', status: 422 });
});

test('verified standard products with unknown nutrition work only when no nutrient goal is requested', () => {
  const unknown = { id: 'test-coffee', name: '麦咖啡™冰美式中杯', productCode: 'test-coffee', standardVerified: true, menuPrice: 20, basis: { kind: 'unknown' }, nutrition: { kcal: null, proteinG: null, fatG: null, carbsG: null, sugarG: null, sodiumMg: null } };
  const prefs = { beverageOnlyAllowed: true, includeKeywords: ['美式咖啡'] };
  const result = generateCandidates([unknown], normalizeConstraints({ budget: 30, preferences: prefs }));
  assert.equal(result.candidates.length, 1); assert.equal(result.candidates[0].nutrition.kcal, null); assert.equal(result.candidates[0].nutrition.proteinG, null); assert.equal(result.candidates[0].price, null);
  assert.equal(generateCandidates([unknown], normalizeConstraints({ mealTarget: 30, preferences: prefs })).candidates.length, 0);
  assert.equal(generateCandidates([unknown], normalizeConstraints({ preferences: { ...prefs, proteinMin: 1 } })).candidates.length, 0);
  assert.equal(generateCandidates([{ ...unknown, standardVerified: false }], normalizeConstraints({ preferences: prefs })).candidates.length, 0);
  const per100 = { ...unknown, basis: { kind: 'per-100' }, nutrition: { ...unknown.nutrition, kcal: 100 } };
  assert.equal(generateCandidates([per100], normalizeConstraints({ preferences: prefs })).candidates[0].nutrition.kcal, null);
  const milk = { ...unknown, name: '麦咖啡™热牛奶中杯' };
  assert.equal(generateCandidates([milk], normalizeConstraints({ preferences: { beverageOnlyAllowed: true, includeKeywords: ['咖啡'] } })).candidates.length, 0);
});

test('recommendation HTTP path preserves code-based classification and the selected pickup time', async t => {
  const calls = [];
  const context = { storeCode: 'test-store', orderType: 1, beType: 1, reservationDate: '2030-01-01 12:00' };
  const names = { burger: '巨无霸', milk: '热牛奶中杯', zero: '无糖可口可乐小杯' };
  const fetchImpl = async (_url, init) => {
    const req = JSON.parse(init.body);
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let payload;
    if (req.method === 'initialize') payload = { protocolVersion: '2025-06-18' };
    else if (req.method === 'tools/list') payload = { tools: ['list-nutrition-foods', 'query-meals', 'query-store-coupons', 'calculate-price'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else {
      const { name, arguments: args } = req.params; calls.push({ name, args });
      if (name === 'list-nutrition-foods') payload = result(Object.values(names).map(productName => ({ productName, nutritionDescription: '每份', energyKcal: 100, protein: 10 })));
      else if (name === 'query-store-coupons') payload = result([]);
      else if (name === 'query-meals') payload = result({ meals: Object.fromEntries(Object.entries(names).map(([code, name]) => [code, { name }])), categories: [{ name: '人气', meals: [{ code: 'burger', tags: [] }] }, { name: '牛鱼肉堡', meals: [{ code: 'burger', tags: ['100%纯牛肉'] }] }, { name: '饮品', meals: [{ code: 'milk', tags: ['热饮'] }, { code: 'zero', tags: ['冷饮'] }] }] });
      else if (name === 'calculate-price') payload = result({ price: 2500, productList: args.items, takeWayList: [{ code: 'takeout', name: '外带' }] });
      else throw Error('Unexpected provider tool');
    }
    return Response.json({ jsonrpc: '2.0', id: req.id, result: payload });
  };
  const { request } = await serverWith(t, { providerAccessEnabled: true, resolveUser: async () => ({ id: 'test' }), resolveCredentials: async () => ({ mcdToken: 'test-only' }), fetchImpl });
  const response = await request('/api/recommendations', { storeContext: context, preferences: { includeKeywords: ['牛肉', '可乐'], unsweetenedDrink: true } });
  assert.equal(response.status, 200);
  const data = await response.json(); assert(data.recommendations.length > 0);
  assert(data.recommendations.every(p => p.priceStatus === 'quoted' && p.foods.some(f => f.productCode === 'burger') && p.foods.some(f => f.productCode === 'zero') && p.foods.every(f => f.productCode !== 'milk')));
  assert(calls.filter(c => c.name !== 'list-nutrition-foods').every(c => c.args.reservationDate === context.reservationDate));
  for (const reservationDate of ['2030-02-30 12:00', '2030-01-01 25:00', '2030-01-01', 123]) {
    const invalid = await request('/api/quote', { storeContext: { ...context, reservationDate }, items: [{ productCode: 'burger', quantity: 1 }] });
    assert.equal(invalid.status, 422); assert.equal((await invalid.json()).error.code, 'RESERVATION_TIME_INVALID');
  }
});

test('menu overview returns this restaurant period using only the current menu read', async t => {
  const calls=[];
  const fetchImpl=async(_url,init)=>{
    const req=JSON.parse(init.body);
    if(req.method==='notifications/initialized')return new Response(null,{status:202});
    let payload;
    if(req.method==='initialize')payload={protocolVersion:'2025-06-18'};
    else if(req.method==='tools/list')payload={tools:[{name:'query-meals',inputSchema:{type:'object'}}]};
    else {calls.push(req.params); assert.equal(req.params.name,'query-meals');payload=result({meals:{a:{name:'测试麦满分'}},categories:[{name:'麦满分系列',meals:[{code:'a',tags:['单品']}]}]});}
    return Response.json({jsonrpc:'2.0',id:req.id,result:payload});
  };
  const {request}=await serverWith(t,{providerAccessEnabled:true,resolveUser:async()=>({id:'test'}),resolveCredentials:async()=>({mcdToken:'test-only'}),fetchImpl});
  const r=await request('/api/menu/overview',{storeContext:{storeCode:'test-new-store',orderType:1,beType:1}});
  assert.equal(r.status,200);const body=await r.json();assert.equal(body.menuContext.storeCode,'test-new-store');assert.equal(body.menuContext.period,'breakfast');assert.equal(calls.length,1);
});

test('local-file ordering opens a separate CSRF session without enabling credential edits or losing the env account', async t => {
  const old = process.env.MCD_MCP_TOKEN; process.env.MCD_MCP_TOKEN = 'local-orders-test-only';
  t.after(() => { if (old === undefined) delete process.env.MCD_MCP_TOKEN; else process.env.MCD_MCP_TOKEN = old; });
  let writes = 0;
  const fetchImpl = async (url, init) => {
    const req = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer local-orders-test-only');
    if (req.method === 'notifications/initialized') return new Response(null, { status: 202 });
    let payload;
    if (req.method === 'initialize') payload = { protocolVersion: '2025-06-18' };
    else if (req.method === 'tools/list') payload = { tools: ['calculate-price', 'create-order'].map(name => ({ name, inputSchema: { type: 'object' } })) };
    else if (req.params.name === 'calculate-price') payload = result({ price: 2200, productList: req.params.arguments.items, takeWayList: [{ code: 'takeout', name: '打包' }] });
    else if (req.params.name === 'create-order') { writes++; payload = result({ orderId: 'local-test-order', payH5Url: 'https://mcd.cn/test-checkout' }); }
    else throw Error('Unexpected request');
    return Response.json({ jsonrpc: '2.0', id: req.id, result: payload });
  };
  const { request } = await serverWith(t, { providerAccessEnabled: true, allowLocalEnvCredentials: true, orderingEnabled: true, orderTermsUrl: 'https://www.mcdonalds.com.cn/page/test-terms/', cancellationDisclosure: 'TEST ONLY', fetchImpl });
  const status = await request('/api/status'); const cookie = status.headers.get('set-cookie').split(';')[0];
  assert.equal((await status.json()).ordering.enabled, true);
  const session = await (await request('/api/owner/setup/status', undefined, { Cookie: cookie })).json();
  assert.equal(session.enabled, false); assert(session.csrfToken); assert(session.mcdConfigured);
  const common = { Cookie: cookie };
  assert.equal((await request('/api/owner/setup', { mcdToken: 'not-permitted' }, { ...common, 'X-CSRF-Token': session.csrfToken })).status, 403);
  const { quote } = await (await request('/api/quote', { storeContext: { storeCode: 'test-store', orderType: 1, beType: 1 }, items: [{ productCode: 'test-main', quantity: 1 }] }, common)).json();
  const review = await (await request('/api/orders/prepare', { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } }, common)).json();
  assert.equal(review.executionEnabled, true);
  const confirmation = { proposalId: review.proposal.id, confirmationNonce: review.proposal.confirmationNonce, confirmed: true, acceptedTerms: true, expectedTotal: 22, currency: 'CNY', paymentMethod: 'provider-checkout' };
  assert.equal((await request('/api/orders/confirm', confirmation, common)).status, 403); assert.equal(writes, 0);
  const secured = { ...common, 'X-CSRF-Token': session.csrfToken };
  assert.equal((await request('/api/orders/confirm', { ...confirmation, expectedTotal: 1 }, secured)).status, 422); assert.equal(writes, 0);
  const confirmed = await request('/api/orders/confirm', confirmation, secured);
  assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).orderId, 'local-test-order');
  assert.equal((await request('/api/orders/confirm', confirmation, secured)).status, 200); assert.equal(writes, 1);
});

test('provider no longer offering selected pickup stops order before a write', async () => {
  const gateway = new OrderGateway({ enabled: true, termsUrl: 'https://www.mcdonalds.com.cn/page/terms', cancellationDisclosure: 'TEST ONLY' });
  let writes = 0;
  const client = { getOrderSchema: async () => ({ type: 'object' }), createConfirmedOrder: async () => { writes++; } };
  const { quote } = gateway.rememberQuote('u', { quote: { total: 22, currency: 'CNY', items: [], takeWayList: [{ code: 'takeout' }] } }, { storeCode: 'test', orderType: 1, beType: 1, items: [] });
  const { proposal } = await gateway.prepare('u', { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } }, client);
  await assert.rejects(gateway.confirm('u', { proposalId: proposal.id, confirmationNonce: proposal.confirmationNonce, confirmed: true, acceptedTerms: true, expectedTotal: 22, currency: 'CNY', paymentMethod: 'provider-checkout' }, { client, reprice: async () => ({ quote: { total: 22, currency: 'CNY', takeWayList: [] } }) }), { code: 'PICKUP_METHOD_CHANGED' });
  assert.equal(writes, 0);
});
