import test from 'node:test';
import assert from 'node:assert/strict';
import { mapProduct, matchesProductTerm, hasProductFeature } from '../server/product-mapping.mjs';
import { normalizeConstraints, generateCandidates } from '../server/recommend.mjs';
import { normalizeMealDetail } from '../server/menu.mjs';
import { summarizeRequirements } from '../server/menu-context.mjs';

const nutrition = kcal => ({ kcal, proteinG: 0, fatG: 0, carbsG: 0, sugarG: null, sodiumMg: 10 });
const food = (id, name, kcal) => mapProduct({ id, code: id, productCode: id, name, standardVerified: true, nutrition: nutrition(kcal), basis: { kind: 'serving' } });
const burger = food('burger', '牛肉汉堡', 400);
const regular = food('regular', '可乐中杯', 140);
const zero = food('zero', '无糖可口可乐中杯', 0);
const unknown = food('unknown', '神秘新品可乐', 0);
const reply = data => ({ structuredContent: { success: true, code: 200, data } });
const children = plan => plan.foods.flatMap(f => f.components || [f]);
const isCola = f => /可乐/.test(f.name);
const onlyRegular = result => {
  assert(result.candidates.length);
  for (const plan of result.candidates) {
    const colas = children(plan).filter(isCola); assert(colas.length);
    assert(colas.every(c => matchesProductTerm(mapProduct(c), '普通可乐')));
    assert.equal(plan.nutrition.sugarG, null);
  }
};
function combo(people, drinks = [zero, regular, unknown]) {
  const rounds = [[burger], drinks].map((choices, i) => ({ id: i + 1, quantity: people, minQuantity: people, maxQuantity: people, choices: choices.map((c, j) => ({ code:c.code, name:c.name, quantity:j===0?people:0, isDefault:j===0?1:0, maxQuantity:-1, diffPrice:'+ ¥0' })) }));
  return normalizeMealDetail(reply({ code:'combo',name:'测试套餐',rounds }), { id:'combo',code:'combo',productCode:'combo' }, [], new Map([burger,regular,zero,unknown].map(f=>[f.code,f])))[0];
}

test('ordinary cola names and user aliases are distinct from zero and unidentified cola', () => {
  for (const name of ['可乐','可乐小杯','可乐中杯','可口可乐大杯','可口可乐（中杯）','可口可乐® 小杯','普通可乐']) {
    const p=mapProduct({name});assert(hasProductFeature(p,'regular-cola'),name);
    for(const term of ['有糖可乐','普通可乐','含糖可乐','正常可乐'])assert(matchesProductTerm(p,term));
  }
  for(const name of ['无糖可口可乐中杯','零糖可乐','0糖可乐','低糖可乐','健怡可乐','神秘新品可乐','可乐味冰淇淋'])assert(!matchesProductTerm(mapProduct({name}),'有糖可乐'),name);
});
test('single and multiple diners asking for regular cola never get a zero-cola substitution', () => {
  for(const people of [1,2]) onlyRegular(generateCandidates([burger,zero,unknown,regular],normalizeConstraints({preferences:{people,includeKeywords:['有糖可乐']}})));
});
test('package drink choices obey regular cola even when zero is the default', () => {
  for(const people of [1,2]) {
    const r=generateCandidates([combo(people)],normalizeConstraints({preferences:{people,preferCombo:true,includeKeywords:['普通可乐']}}));
    onlyRegular(r);assert(r.candidates.every(p=>p.foods[0].roundList[1].comboItemList.every(c=>c.code==='regular' && c.quantity===people)));
  }
});
test('unavailable ordinary cola yields no meal rather than silently using zero or an unknown type', () => {
  const c=normalizeConstraints({preferences:{includeKeywords:['普通可乐']}});
  assert.equal(generateCandidates([burger,zero,unknown],c).candidates.length,0);
  assert.equal(generateCandidates([combo(1,[zero,unknown])],c).candidates.length,0);
});
test('unspecified cola permits either type, while explicit zero still excludes ordinary cola', () => {
  const r=generateCandidates([burger,regular,zero],normalizeConstraints({preferences:{includeKeywords:['可乐']}}));
  assert(r.candidates.some(p=>children(p).some(f=>f.id==='zero')));assert(r.candidates.some(p=>children(p).some(f=>f.id==='regular')));
  const z=generateCandidates([burger,regular,zero],normalizeConstraints({preferences:{includeKeywords:['无糖可乐'],unsweetenedDrink:true}}));
  assert(z.candidates.length);assert(z.candidates.every(p=>children(p).filter(isCola).every(f=>f.name.includes('无糖'))));
});
test('explicit ordinary and zero cola can coexist in a two-person request', () => {
  const r=generateCandidates([burger,regular,zero],normalizeConstraints({preferences:{people:2,includeKeywords:['普通可乐','无糖可乐']}}));
  assert(r.candidates.length);assert(r.candidates.every(p=>p.foods.some(f=>f.id==='regular')&&p.foods.some(f=>f.id==='zero')));
});
test('conflicting type constraints fail explicitly and the UI echoes ordinary cola', () => {
  assert.throws(()=>normalizeConstraints({preferences:{includeKeywords:['普通可乐'],unsweetenedDrink:true}}),{code:'INVALID_CONSTRAINT'});
  assert.throws(()=>normalizeConstraints({preferences:{includeKeywords:['有糖可乐'],avoid:['普通可乐']}}),{code:'INVALID_CONSTRAINT'});
  assert(summarizeRequirements(normalizeConstraints({preferences:{includeKeywords:['普通可乐']}})).some(s=>s.includes('普通可乐（有糖款）')));
});
