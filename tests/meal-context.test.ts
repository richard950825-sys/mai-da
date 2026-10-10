import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMealPrompt, buildManualControls } from '../src/lib/meal-context';
test('cleared targets stay cleared without replaying earlier utterances', () => {
  const text = buildMealPrompt('不吃辣', {
    kcalTarget: null,
    kcalMin: null,
    kcalMax: null,
    budget: 35,
  });
  assert.ok(!text.includes('650'));
  assert.match(text, /"kcalTarget":null/);
  assert.match(text, /不吃辣/);
});
test('manual changes appear after latest input and survive independently of old wording', () => {
  const text = buildMealPrompt('预算35', { budget: 50 }, { budget: 50 });
  assert.ok(text.lastIndexOf('"budget":50') > text.indexOf('预算35'));
});
test('only bounded meal preference fields are included from current state', () => {
  const text = buildMealPrompt('鸡肉', {
    heightCm: 170,
    weightKg: 65,
    age: 30,
    address: 'not included',
    token: 'not included',
    kcalTarget: 650,
  });
  assert.ok(!text.includes('heightCm'));
  assert.ok(!text.includes('not included'));
  assert.match(text, /650/);
});

test('taste and drink constraints survive later edits with exact server keys', () => {
  const text = buildMealPrompt('改成600千卡', {
    includeKeywords: ['鸡'],
    includeAnyKeywords: ['汉堡', '鸡腿'],
    unsweetenedDrink: true,
    beverageOnlyAllowed: false,
    goal: 'high-protein',
    avoid: ['牛肉'],
  });
  for (const key of [
    'includeKeywords',
    'includeAnyKeywords',
    'unsweetenedDrink',
    'beverageOnlyAllowed',
  ])
    assert.ok(text.includes(key));
  assert.ok(text.includes('high-protein'));
  assert.ok(text.includes('牛肉'));
});

test('actual client controls preserve explicit budget and calorie clears through JSON', () => {
  const body = JSON.parse(
    JSON.stringify(
      buildManualControls({
        mealTarget: null,
        budget: null,
        preferStructuredTarget: true,
        preferStructuredBudget: true,
        preferStructuredPreferences: false,
      }),
    ),
  );
  assert.equal(Object.hasOwn(body, 'budget'), true);
  assert.equal(body.budget, null);
  assert.equal(body.mealTarget, null);
  assert.equal(body.preferStructuredBudget, true);
});
