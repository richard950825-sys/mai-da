import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMealDetail, readStoreMenu } from '../server/menu.mjs';
import { generateCandidates, normalizeConstraints } from '../server/recommend.mjs';
import { couponQuoteVariants } from '../server/coupons.mjs';
const result = data => ({ structuredContent: { success: true, code: 200, data } });
const foods = [{ id: 'nutrition-test-zero', name: '测试无糖可乐小杯', basis: { kind: 'serving' }, nutrition: { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0, sugarG: null, sodiumMg: 25 } }];
const group = { code: 'test-cola', name: '测试可乐', rounds: [{ id: 1, minQuantity: 1, maxQuantity: 1, quantity: 1, choices: [{ code: 'test-zero', name: '测试无糖可乐小杯' }, { code: 'unknown', name: '未知新品' }] }] };

test('only complete single-choice groups carry exact serving facts and quote selections', () => {
  const variants = normalizeMealDetail(result(group), { code: 'test-cola' }, foods);
  assert.equal(variants[0].nutrition.kcal, 0); assert.equal(variants[1].nutrition.kcal, null);
  assert.deepEqual(variants[0].roundList, [{ round: '1', comboItemList: [{ code: 'test-zero', quantity: 1 }] }]);
  assert.deepEqual(normalizeMealDetail(result({ ...group, rounds: [...group.rounds, ...group.rounds] }), { code: 'test-cola' }, foods), []);
  assert.deepEqual(normalizeMealDetail(result({ ...group, rounds: [{ ...group.rounds[0], minQuantity: 0 }] }), { code: 'test-cola' }, foods), []);
  assert.throws(() => normalizeMealDetail(result({ ...group, code: 'wrong' }), { code: 'test-cola' }, foods), { code: 'MEAL_DETAIL_SCHEMA_CHANGED' });
  const candidates = generateCandidates(variants.filter(v => v.nutrition.kcal !== null).map(v => ({ ...v, productCode: v.code, basis: { kind: 'serving' } })), normalizeConstraints({ preferences: { beverageOnlyAllowed: true } })).candidates;
  assert.deepEqual(candidates[0].foods[0].roundList, variants[0].roundList);
  const coupons = [{ couponId: 'test-coupon', couponCode: 'test-code', products: [{ productCode: 'test-cola' }] }];
  const attempts = couponQuoteVariants({ items: candidates[0].foods }, coupons);
  assert.deepEqual(attempts[1].args.items[0].roundList, variants[0].roundList);
});
test('store detail enrichment reads provider sizes and admits exact coupon product codes', async () => {
  const calls = [];
  const client = { listTools: async () => [{ name: 'query-meal-detail' }], callRead: async (name, args) => {
    calls.push({ name, args });
    if (name === 'query-meals') return result({ meals: { 'test-cola': { name: '可乐', currentPrice: '10' } } });
    return result({ ...group, code: args.code });
  } };
  const menu = await readStoreMenu(client, { storeCode: 'test-store', orderType: 1, beType: 1 }, foods, [{ products: [{ productCode: 'test-coupon-group', productName: '测试券组' }] }]);
  assert.equal(menu.items.filter(i => i.nutrition.kcal === 0).length, 2);
  assert(calls.some(c => c.name === 'query-meal-detail' && c.args.code === 'test-coupon-group'));
  assert(menu.items.filter(i => i.nutrition.kcal !== null).every(i => i.name === foods[0].name));
  assert(menu.items.every(i => i.standardVerified));
});
