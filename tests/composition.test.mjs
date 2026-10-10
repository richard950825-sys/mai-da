import test from 'node:test';
import assert from 'node:assert/strict';
import { mapProduct } from '../server/product-mapping.mjs';
import { normalizeConstraints, generateCandidates } from '../server/recommend.mjs';
import { normalizeMealDetail } from '../server/menu.mjs';
import { configureCombo, mealRole } from '../server/meal-composition.mjs';

const nutrition = kcal => ({ kcal, proteinG: 20, fatG: 10, carbsG: 30, sugarG: null, sodiumMg: 200 });
const food = (id, name, kcal = 300) => mapProduct({ id, code: id, productCode: id, name, menuPrice: 10, standardVerified: true, configurationStatus: 'resolved', nutrition: nutrition(kcal), basis: { kind: 'serving' } });
const foods = [food('beef', '测试牛肉堡'), food('chicken', '测试鸡腿堡'), food('zero', '测试无糖可乐', 0), food('water', '测试纯净水', 0), food('cola', '测试可乐', 100), food('fries', '测试薯条', 200)];
const constraints = preferences => normalizeConstraints({ preferences });
const reply = data => ({ structuredContent: { success: true, code: 200, data } });
const choice = (code, name, def = 0, maxQuantity = -1) => ({ code, name, isDefault: def, quantity: def, maxQuantity, diffPrice: '+ ¥0' });
const round = (id, count, choices) => ({ id, quantity: count, minQuantity: count, maxQuantity: count, choices });
function combo(count = 1) {
  return normalizeMealDetail(reply({ code: 'combo', name: '测试官方套餐', rounds: [round(1, count, [choice('beef', '测试牛肉堡', 1)]), round(2, count, [choice('fries', '测试薯条', 1)]), round(3, count, [choice('cola', '测试可乐', 1), choice('zero', '测试无糖可乐')])] }), { code: 'combo', id: 'combo', productCode: 'combo' }, foods, new Map(foods.map(f => [f.code, f])))[0];
}

test('single diners never receive two beverages, even without a named drink preference', () => {
  const result = generateCandidates(foods, constraints({}));
  assert(result.candidates.length);
  assert(result.candidates.every(p => p.composition.main === 1 && p.composition.drink <= 1));
  assert.equal(result.candidates[0].composition.drink, 1);
  assert.equal(result.candidates[0].composition.side, 1);
});
test('every requested diner gets a main, repeat quantities count, and all mains obey beef-only preference', () => {
  for (const people of [2, 3, 6]) {
    const result = generateCandidates(foods, constraints({ people, includeKeywords: ['牛肉', '可乐'], unsweetenedDrink: true }));
    assert(result.candidates.length, `${people} people`);
    for (const p of result.candidates) {
      assert.equal(p.composition.main, people); assert(p.composition.drink <= people);
      assert(p.foods.filter(f => f.role === 'main').every(f => f.id === 'beef'));
      assert.equal(p.foods.find(f => f.id === 'beef').quantity, people);
    }
    assert.equal(result.candidates[0].composition.drink, people);
  }
});
test('drink-only plans use exactly the stated number of drinks and no food', () => {
  const result = generateCandidates(foods, constraints({ people: 2, beverageOnlyAllowed: true, includeKeywords: ['无糖可乐'], unsweetenedDrink: true }));
  assert(result.candidates.length); assert(result.candidates.every(p => p.composition.main === 0 && p.composition.drink === 2));
});
test('explicit no-drinks produces mains and sides only', () => {
  const result = generateCandidates(foods, constraints({ people: 2, avoid: ['饮料'] }));
  assert(result.candidates.length); assert(result.candidates.every(p => p.composition.drink === 0 && p.composition.main === 2));
});
test('official three-round combos choose zero cola and preserve exact supplier selections', () => {
  const c = combo();
  const preferences = constraints({ includeKeywords: ['牛肉', '可乐'], unsweetenedDrink: true, preferCombo: true });
  const variants = configureCombo(c, preferences);
  assert(variants.length); assert.deepEqual(variants[0].roundList[2], { round: '3', comboItemList: [{ code: 'zero', quantity: 1 }] });
  const result = generateCandidates([...foods, c], preferences);
  assert(result.candidates.length); assert.equal(result.candidates[0].officialCombo, true);
  assert(result.candidates.every(p => p.composition.drink === 1));
  assert(result.candidates.filter(p => p.officialCombo).every(p => p.foods.length === 1));
});
test('two-person official combo cannot be suggested to one diner and counts drinks inside the package', () => {
  const c = combo(2);
  assert.deepEqual(configureCombo(c, constraints({})), []);
  const result = generateCandidates([c, ...foods], constraints({ people: 2, preferCombo: true, unsweetenedDrink: true }));
  assert(result.candidates.length); assert.equal(result.candidates[0].composition.drink, 2);
  assert.equal(result.candidates[0].composition.main, 2);
});
test('provider round quantity and choice caps are respected, duplicate rounds fail closed', () => {
  const invalid = { code: 'x', name: '测试套餐', rounds: [round(1, 1, [choice('beef','测试牛肉堡')]), round(1, 1, [choice('zero','无糖可乐')])] };
  assert.deepEqual(normalizeMealDetail(reply(invalid), { code: 'x' }, foods), []);
  const c = combo(2); c.comboRounds[2].choices.forEach(c => { c.maxQuantity = 1; });
  assert.deepEqual(configureCombo(c, constraints({ people: 2, unsweetenedDrink: true })), []);
});
test('unknown component nutrition cannot satisfy a numerical calorie requirement', () => {
  const c = combo(); c.comboRounds[0].choices[0].nutrition.kcal = null;
  const result = generateCandidates([c], normalizeConstraints({ mealTarget: 500, preferences: { preferCombo: true } }));
  assert.equal(result.candidates.length, 0);
});
test('people boundaries and final explicit UI override are validated', () => {
  for (const people of [0, 7, 1.5, '2', true]) assert.throws(() => constraints({ people }), { code: 'INVALID_PEOPLE' });
  assert.equal(normalizeConstraints({ preferStructuredPeople: true, preferences: { people: 3 } }, { people: 2 }).people, 3);
});

test('ingredient-only chicken classification does not turn wings into a main course', () => {
  const wings = { ...food('wings', '薄皮焦香V翅'), productMapping: { kind: 'food', features: ['chicken'], evidence: [] } };
  assert.equal(mealRole(wings), 'side');
  const result = generateCandidates([...foods, wings], constraints({ includeKeywords: ['鸡'] }));
  assert(result.candidates.length); assert(result.candidates.every(p => p.foods.some(f => f.id === 'chicken')));
});

test('combo preference still retains ordinary alternatives for live budget fallback', () => {
  const c = combo();
  const result = generateCandidates([c, ...foods], normalizeConstraints({ budget: 35, preferences: { includeKeywords: ['牛肉','可乐'], unsweetenedDrink: true, preferCombo: true } }));
  assert(result.candidates[0].officialCombo);
  assert(result.candidates.some(p => !p.officialCombo));
});

test('unavailable or malformed choice limits cannot enter a package configuration', () => {
  for (const maxQuantity of [0, -2, '1', 1.5]) {
    const rounds = [round(1, 1, [choice('beef','测试牛肉堡',1,maxQuantity)]),round(2,1,[choice('zero','测试无糖可乐')])];
    assert.deepEqual(normalizeMealDetail(reply({code:'bad',name:'测试套餐',rounds}),{code:'bad'},foods),[]);
  }
});
