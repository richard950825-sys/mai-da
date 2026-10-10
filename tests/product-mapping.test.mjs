import test from 'node:test';
import assert from 'node:assert/strict';
import { mapProduct, hasProductFeature, matchesProductTerm } from '../server/product-mapping.mjs';
import { normalizeMenu, normalizeStores, unwrapMcp, emptyNutrition } from '../server/normalize.mjs';
import { normalizeMealDetail } from '../server/menu.mjs';
import { generateCandidates, normalizeConstraints } from '../server/recommend.mjs';
import { OrderGateway } from '../server/orders.mjs';

// Synthetic catalog records; these are classification checks, not current inventory or nutrition facts.
const result = data => ({ structuredContent: { success: true, code: 200, data } });
const meals = { beef: { name: '巨无霸' }, fish: { name: '麦香鱼' }, milk: { name: '热牛奶中杯' }, zero: { name: '无糖可口可乐小杯' } };
const catalog = () => normalizeMenu(result({ meals, categories: [
  { name: '人气热卖', meals: [{ code: 'beef', tags: ['人气'] }] },
  { name: '巨无霸\n牛鱼肉堡', meals: [{ code: 'beef', tags: ['单品', '100%纯牛肉'] }, { code: 'fish', tags: ['单品', '麦香鱼系列'] }] },
  { name: '饮品', meals: [{ code: 'milk', tags: ['热饮'] }, { code: 'zero', tags: ['冷饮'] }] },
] })).items;

test('all category references for one product code contribute provenance', () => {
  const beef = catalog().find(p => p.code === 'beef');
  assert.deepEqual(beef.categories, ['人气热卖', '巨无霸\n牛鱼肉堡']);
  assert.deepEqual(beef.tags, ['人气', '单品', '100%纯牛肉']);
  assert(matchesProductTerm(beef, '牛肉'));
  assert(beef.productMapping.evidence.some(e => e.feature === 'beef' && e.source === 'product-tag' && e.sourceCode === 'beef' && e.value === '100%纯牛肉'));
});

test('beef class includes branded burgers while excluding milk, fish, plant names and merchandise', () => {
  const products = catalog();
  assert.deepEqual(products.filter(p => matchesProductTerm(p, '牛')).map(p => p.code), ['beef']);
  assert.deepEqual(products.filter(p => matchesProductTerm(p, '鱼肉')).map(p => p.code), ['fish']);
  for (const name of ['纯牛奶', '麦咖啡™热牛奶中杯', '牛油果汉堡', '植物牛肉汉堡', '牛气玩偶']) {
    assert.equal(matchesProductTerm(mapProduct({ name }), '牛肉'), false, name);
  }
  assert.equal(matchesProductTerm(mapProduct({ name: '麦咖啡™热牛奶中杯' }), '咖啡'), false);
  assert.equal(hasProductFeature(mapProduct({ name: '未知新品', category: '巨无霸\n牛鱼肉堡' }), 'beef'), false);
});

test('variant-specific catalog evidence replaces mixed parent metadata and preserves quote codes', () => {
  const items = catalog();
  const parent = mapProduct({ code: 'group', name: '牛肉精选', tags: ['100%纯牛肉'] });
  const variants = normalizeMealDetail(result({ code: 'group', name: '测试单选组', rounds: [{ id: 7, minQuantity: 1, maxQuantity: 1, quantity: 1, choices: [{ code: 'beef', name: '巨无霸' }, { code: 'fish', name: '麦香鱼' }] }] }), parent, [], new Map(items.map(p => [p.code, p])));
  assert.equal(variants[0].variantCode, 'beef');
  assert(matchesProductTerm(variants[0], '牛肉'));
  assert.equal(matchesProductTerm(variants[1], '牛肉'), false);
  assert(matchesProductTerm(variants[1], '鱼肉'));
  assert.equal(variants[1].code, 'group');
  assert.deepEqual(variants[1].roundList, [{ round: '7', comboItemList: [{ code: 'fish', quantity: 1 }] }]);
  assert(variants[1].productMapping.evidence.some(e => e.feature === 'fish' && e.sourceCode === 'fish'));
});

test('beef and zero-cola constraints consume mapped features; meat exclusion leaves milk available', () => {
  const foods = catalog().map(p => ({ ...p, productCode: p.code, standardVerified: true, basis: { kind: 'unknown' } }));
  const candidates = generateCandidates(foods, normalizeConstraints({ preferences: { includeKeywords: ['牛肉', '可乐'], unsweetenedDrink: true } })).candidates;
  assert(candidates.length > 0);
  assert(candidates.every(c => c.foods.some(f => f.productCode === 'beef') && c.foods.some(f => f.productCode === 'zero') && c.foods.every(f => f.productCode !== 'milk')));
  assert(candidates.every(c => c.nutrition.kcal === null && c.nutrition.sugarG === null));
  const excluded = generateCandidates(foods, normalizeConstraints({ preferences: { avoid: ['牛肉'], beverageOnlyAllowed: true } })).candidates;
  assert(excluded.some(c => c.foods.some(f => f.productCode === 'milk')));
  assert.equal(generateCandidates(foods, normalizeConstraints({ mealTarget: 600, preferences: { includeKeywords: ['牛肉', '可乐'] } })).candidates.length, 0);
});

test('unknown or nonfood products are not promoted into price-only meal candidates', () => {
  for (const name of ['未知新品', '牛肉堡玩偶']) {
    const food = { id: 'unknown', name, productCode: 'unknown', standardVerified: true, nutrition: emptyNutrition(), basis: { kind: 'unknown' } };
    assert.equal(generateCandidates([food], normalizeConstraints({})).candidates.length, 0);
  }
});

test('closed store and reservation metadata remain explicit instead of becoming no matching food', () => {
  assert.throws(() => unwrapMcp({ structuredContent: { success: false, code: 600057 } }), { code: 'STORE_NOT_AVAILABLE_NOW', status: 409 });
  const options = [{ date: '2030-01-01', today: false, reservationOptionText: '午餐 10:44-14:00' }];
  const store = normalizeStores(result([{ storeCode: 'test', storeName: '测试餐厅', businessStatus: false, businessStartTime: '06:00', businessEndTime: '23:00', reservation: true, reservationTimeOptions: options }])).stores[0];
  assert.equal(store.businessStatus, false); assert.equal(store.reservation, true); assert.deepEqual(store.reservationTimeOptions, options);
});

test('selected pickup time is carried into the immutable review', async () => {
  const gateway = new OrderGateway();
  const quote = gateway.rememberQuote('u', { quote: { total: 20, items: [{ productCode: 'test', productName: '测试餐品' }], currency: 'CNY', takeWayList: [{ code: 'takeout', name: '外带' }] } }, { storeCode: 's', orderType: 1, beType: 1, reservationDate: '2030-01-01 12:00', items: [{ productCode: 'test', quantity: 1 }] }).quote;
  const review = await gateway.prepare('u', { quoteId: quote.id, fulfillment: { takeWayCode: 'takeout' } }, { getOrderSchema: async () => ({ type: 'object' }) });
  assert.equal(review.proposal.reservationDate, '2030-01-01 12:00'); assert.equal(review.executionEnabled, false);
});
