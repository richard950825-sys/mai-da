import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMenu, summarizeRequirements } from '../server/menu-context.mjs';
import { generateCandidates, normalizeConstraints } from '../server/recommend.mjs';
import { mapProduct, validateProductMappings, productSource } from '../server/product-mapping.mjs';

const context = { storeCode: 'test-store', orderType: 1, beType: 1 };
const menu = categories => ({ items: categories.map((category, i) => ({ code: String(i), categories: [category] })), retrievedAt: '2026-10-10T01:00:00Z' });
const food = (id, name, extra = {}) => mapProduct({ id, productCode: id, name, standardVerified: true, basis: { kind: 'serving' }, nutrition: { kcal: 100, proteinG: 10, sugarG: null, sodiumMg: 100 }, ...extra });

test('meal-period labels follow actual menu categories, not a fixed clock or selected reservation label', () => {
  assert.equal(describeMenu(menu(['饮品', '麦满分系列', '超值早餐']), context).period, 'breakfast');
  assert.equal(describeMenu(menu(['巨无霸\n牛鱼肉堡', '鸡肉汉堡\n/卷']), context).period, 'regular');
  assert.equal(describeMenu(menu(['早餐', '鸡肉汉堡']), context).period, 'mixed');
  assert.equal(describeMenu(menu(['饮品', '麦咖啡™']), context).period, 'unknown');
  const mismatched = describeMenu(menu(['早餐']), { ...context, reservationDate: '2026-10-10 12:00' });
  assert.equal(mismatched.period, 'breakfast'); assert.equal(mismatched.requestedTime, '2026-10-10 12:00');
});

test('a breakfast menu without beef explains the missing requested food instead of blaming the budget', () => {
  const foods = [food('chicken','鸡腿堡'), food('zero','无糖可口可乐小杯'), food('milk','热牛奶中杯')];
  const constraints = normalizeConstraints({ budget: 60, preferences: { includeKeywords: ['牛', '可乐'], unsweetenedDrink: true, preferCombo: true } });
  const result = generateCandidates(foods, constraints);
  assert.equal(result.candidates.length, 0); assert.equal(result.noMatch.code, 'REQUIRED_FOOD_NOT_IDENTIFIED');
  assert.match(result.noMatch.message, /牛肉/); assert.match(result.noMatch.message, /取餐时间/); assert(!result.noMatch.message.includes('调整预算'));
  assert.deepEqual(result.noMatch.missingFeatures, ['beef']);
  assert(summarizeRequirements(constraints).includes('预算不超过 60 元'));
  assert(summarizeRequirements(constraints).includes('套餐优先')); assert.equal(constraints.kcalMax, null);
});

test('items present but not configurable or lacking nutrition get a different explanation from absence', () => {
  const unsupported = food('beef', '牛肉汉堡套餐', { configurationStatus: 'unsupported' });
  const result = generateCandidates([unsupported], normalizeConstraints({ preferences: { includeKeywords: ['牛肉'] } }));
  assert.equal(result.candidates.length, 0); assert.equal(result.noMatch.code, 'REQUESTED_FOOD_NOT_ELIGIBLE');
  const noSugar = generateCandidates([food('b','牛肉汉堡')], normalizeConstraints({ preferences: { sugarMax: 1 } }));
  assert.equal(noSugar.noMatch.code, 'NUTRITION_DATA_MISSING');
  assert.equal(generateCandidates([], normalizeConstraints({})).noMatch.code, 'MENU_EMPTY');
});

test('regular menu matches the beef/zero-cola request and keeps combo preference distinct from coupons', () => {
  const foods = [food('beef','巨无霸',{tags:['100%纯牛肉'],categories:['牛鱼肉堡']}),food('zero','无糖可口可乐小杯')];
  const constraints = normalizeConstraints({ budget: 60, preferences: { includeKeywords: ['牛肉', '可乐'], unsweetenedDrink: true, preferCombo: true, preferCoupons: false } });
  const result = generateCandidates(foods, constraints);
  assert(result.candidates.length); assert.equal(result.noMatch, null); assert.equal(constraints.preferCoupons, false); assert.equal(constraints.preferCombo, true);
  assert(result.warnings.some(w => w.includes('套餐优先') && w.includes('官方套餐')));
});

test('unknown query terms do not enter bounded diagnostic feature names or access object prototypes', () => {
  const constraints = normalizeConstraints({ preferences: { includeKeywords: ['private-test-keyword', '__proto__'] } });
  const result = generateCandidates([food('b','牛肉汉堡')], constraints);
  assert.equal(result.noMatch.code, 'REQUIRED_FOOD_NOT_IDENTIFIED'); assert.deepEqual(result.noMatch.missingFeatures, []);
});

test('coffee subtype is sufficient beverage evidence, while a brand shelf alone is rejected', () => {
  const source = productSource({ id:'coffee',code:'coffee',name:'卡布奇诺中杯',categories:['麦咖啡™'] });
  const output = validateProductMappings({ products:[{id:'coffee',kind:'beverage',evidence:[{feature:'coffee',field:'name',value:'卡布奇诺'}]}] }, [source]);
  assert.deepEqual(output[0].features, ['coffee','beverage']);
  assert.throws(() => validateProductMappings({ products:[{id:'coffee',kind:'beverage',evidence:[{feature:'coffee',field:'categories',value:'麦咖啡™'}]}] }, [source]), {code:'PRODUCT_MAPPING_INVALID'});
});

test('one invalid model classification is isolated from valid neighboring products', () => {
  const sources = ['a','b'].map(id => productSource({id,code:id,name:'芝士条'}));
  const products = [
    {id:'a',kind:'food',evidence:[{feature:'side',field:'name',value:'芝士条'}]},
    {id:'b',kind:'food',evidence:[{feature:'beef',field:'name',value:'未提供的牛肉'}]},
  ];
  const partial = validateProductMappings({products}, sources, true);
  assert.equal(partial[0].kind,'food'); assert.equal(partial[1].errorCode,'PRODUCT_MAPPING_INVALID');
  assert.throws(() => validateProductMappings({products},sources),{code:'PRODUCT_MAPPING_INVALID'});
});
