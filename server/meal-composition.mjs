import { mapProduct, matchesProductTerm, hasProductFeature, matchesDrinkPreference } from './product-mapping.mjs';
import { emptyNutrition, matchNutritionByName, sumNutrition, safeHttpsImage } from './normalize.mjs';

export function mealRole(food) {
  if (food.isCombo) return 'combo';
  if (hasProductFeature(food, 'burger')) return 'main';
  if (food.productMapping?.kind === 'beverage') return 'drink';
  if (hasProductFeature(food, 'dessert')) return 'dessert';
  if (hasProductFeature(food, 'side')) return 'side';
  if (/卷|粥|饭|面条|松饼/.test(food.name)) return 'main';
  // Meat is an ingredient, not proof of a main course: wings and nuggets remain sides.
  if (['beef', 'chicken', 'pork', 'fish'].some(f => hasProductFeature(food, f))) return 'side';
  return 'other';
}
export function mealContents(food) { return food.components || [{ ...food, quantity: 1 }]; }
export function compositionCounts(members) {
  const counts = { main: 0, drink: 0, side: 0, dessert: 0, other: 0 };
  for (const food of members) for (const part of mealContents(food)) counts[mealRole(part)] += part.quantity;
  return counts;
}
const wanted = (food, constraints) => [...constraints.includeKeywords, ...constraints.includeAnyKeywords].filter(term => matchesProductTerm(food, term)).length;
const permitted = (food, constraints) => food.productMapping.kind !== 'non-food' && !constraints.avoid.some(term => matchesProductTerm(food, term)) && matchesDrinkPreference(food, constraints);

// ponytail: bounded search of provider-defined choices; unusual nested/custom configurations remain unavailable.
export function configureCombo(item, constraints) {
  const people = constraints.people ?? 1;
  let states = [{ components: [], roundList: [], preference: 0 }];
  for (const round of item.comboRounds) {
    const choices = round.choices.filter(c => permitted(c, constraints)).sort((a, b) => wanted(b, constraints) - wanted(a, constraints) || Number(b.isDefault) - Number(a.isDefault) || a.extraPrice - b.extraPrice).slice(0, 8);
    const allocations = [];
    function choose(start, remaining, selection) {
      if (!remaining) { allocations.push(selection); return; }
      if (allocations.length >= 64) return;
      for (let i = start; i < choices.length; i++) {
        const choice = choices[i];
        const existing = selection.filter(c => c.code === choice.code).length;
        if (choice.maxQuantity > 0 && existing >= choice.maxQuantity) continue;
        choose(i, remaining - 1, [...selection, choice]);
      }
    }
    choose(0, round.quantity, []);
    if (!allocations.length) return [];
    const next = [];
    for (const state of states) for (const allocation of allocations) {
      const components = [...state.components, ...allocation.map(c => ({ ...c, quantity: 1 }))];
      const counts = compositionCounts(components);
      if (counts.drink > people || counts.main > people || constraints.beverageOnlyAllowed && counts.main) continue;
      const selected = new Map();
      for (const c of allocation) selected.set(c.code, { code: c.code, quantity: (selected.get(c.code)?.quantity || 0) + 1 });
      next.push({ components, roundList: [...state.roundList, { round: String(round.id), comboItemList: [...selected.values()] }], preference: state.preference + allocation.reduce((s, c) => s + wanted(c, constraints) * 100 + Number(c.isDefault) * 3 - c.extraPrice, 0) });
    }
    states = next.sort((a, b) => b.preference - a.preference).slice(0, 24);
    if (!states.length) return [];
  }
  return states.map(state => ({ ...item, id: `${item.code}:${state.roundList.map(r => r.comboItemList.map(c => `${c.code}x${c.quantity}`).join(',')).join('|')}`, standardVerified: true, configurationStatus: 'resolved', configurationPreference: state.preference, components: state.components, roundList: state.roundList, nutrition: sumNutrition(state.components), menuPrice: null }));
}

export function normalizedComboRounds(rounds, foods, catalog) {
  if (!rounds.length || rounds.length > 12 || new Set(rounds.map(r => String(r.id))).size !== rounds.length) return null;
  const normalized = [];
  for (const r of rounds) {
    if (!['number', 'string'].includes(typeof r.id) || !Number.isSafeInteger(r.quantity) || r.quantity < 1 || r.quantity > 6 || !Number.isSafeInteger(r.minQuantity) || !Number.isSafeInteger(r.maxQuantity) || r.minQuantity < 0 || r.quantity < r.minQuantity || r.quantity > r.maxQuantity || !Array.isArray(r.choices) || !r.choices.length) return null;
    const choices = r.choices.filter(c => typeof c.code === 'string' && c.code && typeof c.name === 'string' && c.name && !c.rounds?.length && (c.maxQuantity == null || Number.isSafeInteger(c.maxQuantity) && (c.maxQuantity === -1 || c.maxQuantity > 0))).map(c => {
      const source = catalog.get(c.code) || {};
      const match = typeof c.diffPrice === 'string' && c.diffPrice.match(/^([+-])\s*¥\s*(\d+(?:\.\d+)?)$/);
      return mapProduct({ ...source, code: c.code, id: c.code, name: c.name, description: typeof c.description === 'string' ? c.description : null, isDefault: c.isDefault === 1, maxQuantity: c.maxQuantity ?? -1, extraPrice: match ? Number(match[2]) * (match[1] === '-' ? -1 : 1) : 0, imageUrl: safeHttpsImage(c.image || source.imageUrl || source.image), nutrition: matchNutritionByName(c.name, foods) || emptyNutrition() });
    });
    if (!choices.length || new Set(choices.map(c => c.code)).size !== choices.length) return null;
    normalized.push({ id: r.id, name: r.name, quantity: r.quantity, minQuantity: r.minQuantity, maxQuantity: r.maxQuantity, choices });
  }
  return normalized;
}
