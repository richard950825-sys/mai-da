import { createHash } from 'node:crypto';
import { assert } from './errors.mjs';
import { mapProduct, matchesProductTerm, hasProductFeature, productTermFeatures, matchesDrinkPreference } from './product-mapping.mjs';
import { configureCombo, mealRole, mealContents, compositionCounts } from './meal-composition.mjs';
import { sumNutrition, emptyNutrition } from './normalize.mjs';

const validNumber = (v, max = 10000) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
export function normalizeConstraints(body, parsed = {}) {
  if (body.mealTarget !== undefined && body.mealTarget !== null) {
    const target = body.mealTarget;
    assert(typeof target === 'number' ? validNumber(target) : target && typeof target === 'object' && !Array.isArray(target) && Object.keys(target).length > 0 && Object.keys(target).every(key => ['min', 'max'].includes(key)) && ['min', 'max'].some(key => target[key] != null) && ['min', 'max'].every(key => target[key] == null || validNumber(target[key])), 'INVALID_CONSTRAINT', '热量目标必须是有效数字或明确的上下限', 422);
  }
  let preferences = body.preferences || {};
  if (Array.isArray(preferences)) preferences = { goal: preferences.find(v => ['high-protein', 'low-calorie', 'low-sugar'].includes(v)) || 'balanced' };
  assert(preferences && typeof preferences === 'object' && !Array.isArray(preferences), 'INVALID_PREFERENCES', '偏好格式无效');
  // The intent parser returns a complete resolved state. Explicit null is a cleared
  // limit, not a request to restore an older value from the submitted UI state.
  const resolved = ['meal', 'mixed'].includes(parsed.intent);
  const parsedOr = (key, fallback) => resolved && Object.hasOwn(parsed, key) ? parsed[key] : parsed[key] ?? fallback;
  const manualPreferences = body.preferStructuredPreferences === true;
  const preference = (key, fallback) => manualPreferences && Object.hasOwn(preferences, key) ? preferences[key] : resolved ? parsed[key] : preferences[key] ?? parsed[key] ?? fallback;
  if (body.preferStructuredBudget === true) assert(Object.hasOwn(body, 'budget') && (body.budget === null || validNumber(body.budget)), 'INVALID_CONSTRAINT', '请提供已确认的预算，清除预算时使用 null', 422);
  const manual = body.preferStructuredTarget === true;
  const clear = manual ? body.mealTarget === null : parsed.clearKcalTarget === true;
  const target = clear ? null : manual ? (typeof body.mealTarget === 'number' ? body.mealTarget : null) : parsedOr('kcalTarget', typeof body.mealTarget === 'number' ? body.mealTarget : null);
  const statedMin = clear || resolved && !manual ? null : typeof body.mealTarget === 'object' ? body.mealTarget?.min : null;
  const statedMax = clear || resolved && !manual ? null : typeof body.mealTarget === 'object' ? body.mealTarget?.max : null;
  const mins = clear ? [] : [statedMin, manual ? null : parsed.kcalMin, validNumber(target) ? Math.round(target * 0.9) : null].filter(v => v !== null && v !== undefined);
  const maxes = clear ? [] : [statedMax, manual ? null : parsed.kcalMax, validNumber(target) ? Math.round(target * 1.1) : null].filter(v => v !== null && v !== undefined);
  for (const v of [...mins, ...maxes]) assert(validNumber(v), 'INVALID_CONSTRAINT', '热量限制必须是有效的非负数字', 422);
  const goal = manualPreferences && Object.hasOwn(preferences, 'goal') ? preferences.goal : resolved ? parsed.goal : parsed.goal && parsed.goal !== 'balanced' ? parsed.goal : preferences.goal ?? parsed.goal ?? 'balanced';
  assert(['balanced', 'high-protein', 'low-calorie', 'low-sugar'].includes(goal), 'INVALID_GOAL', '不支持的偏好类型');
  const values = { kcalTarget: target ?? null, kcalMin: mins.length ? Math.max(...mins) : null, kcalMax: maxes.length ? Math.min(...maxes) : null, proteinMin: manualPreferences && Object.hasOwn(preferences, 'proteinMin') ? preferences.proteinMin : parsedOr('proteinMin', preferences.proteinMin ?? null), sugarMax: manualPreferences && Object.hasOwn(preferences, 'sugarMax') ? preferences.sugarMax : parsedOr('sugarMax', preferences.sugarMax ?? null), sodiumMax: manualPreferences && Object.hasOwn(preferences, 'sodiumMax') ? preferences.sodiumMax : parsedOr('sodiumMax', preferences.sodiumMax ?? null), budget: body.preferStructuredBudget === true ? body.budget : parsedOr('budget', body.budget ?? null) };
  for (const [key, value] of Object.entries(values)) assert(value === null || validNumber(value, key === 'sodiumMax' ? 20000 : 10000), 'INVALID_CONSTRAINT', '营养或预算限制必须是有效的非负数字', 422, { field: key });
  assert(values.kcalMin === null || values.kcalMax === null || values.kcalMin <= values.kcalMax, 'INVALID_CONSTRAINT', '热量下限不能高于上限', 422, { reason: 'conflicting_constraints' });
  if (preferences.avoid !== undefined) assert(Array.isArray(preferences.avoid), 'INVALID_AVOID', '排除食物格式无效');
  for (const field of ['preferCoupons', 'preferCombo', 'unsweetenedDrink', 'beverageOnlyAllowed']) if (preferences[field] !== undefined) assert(typeof preferences[field] === 'boolean', 'INVALID_PREFERENCES', '偏好开关必须为布尔值');
  const avoid = [...new Set(manualPreferences && Object.hasOwn(preferences, 'avoid') ? preferences.avoid : resolved ? parsed.avoid : [...(Array.isArray(preferences.avoid) ? preferences.avoid : []), ...(Array.isArray(parsed.avoid) ? parsed.avoid : [])])];
  assert(Array.isArray(avoid) && avoid.length <= 12 && avoid.every(v => typeof v === 'string' && v.length <= 40), 'INVALID_AVOID', '排除食物格式无效');
  const includeKeywords = preference('includeKeywords', []);
  const includeAnyKeywords = preference('includeAnyKeywords', []);
  for (const terms of [includeKeywords, includeAnyKeywords]) assert(Array.isArray(terms) && terms.length <= 6 && terms.every(t => typeof t === 'string' && t.trim() && t.length <= 40), 'INVALID_FOOD_PREFERENCE', '想吃的食物关键词格式无效');
  const canonical = term => productTermFeatures(term.trim()).join('|') || term.trim();
  const excluded = new Set(avoid.map(canonical));
  assert(!includeKeywords.some(term => excluded.has(canonical(term))) && !(includeAnyKeywords.length && includeAnyKeywords.every(term => excluded.has(canonical(term)))), 'INVALID_CONSTRAINT', '想吃和排除的餐品条件互相冲突', 422, { reason: 'conflicting_constraints' });
  const unsweetenedDrink = preference('unsweetenedDrink', false);
  assert(!unsweetenedDrink || !includeKeywords.some(term => productTermFeatures(term).includes('regular-cola')), 'INVALID_CONSTRAINT', '普通可乐与全部饮品无糖的要求互相冲突，请确认本次可乐类型', 422, { reason: 'conflicting_constraints' });
  const people = body.preferStructuredPeople === true ? preferences.people : preference('people', 1) ?? 1;
  assert(Number.isSafeInteger(people) && people >= 1 && people <= 6, 'INVALID_PEOPLE', '用餐人数需为 1 至 6 人', 422);
  return { ...values, people, goal, avoid, includeKeywords, includeAnyKeywords, unsweetenedDrink, beverageOnlyAllowed: preference('beverageOnlyAllowed', false), preferCoupons: preference('preferCoupons', true), preferCombo: preference('preferCombo', false) };
}
export function generateCandidates(foods, constraints, limit = 30) {
  const people = constraints.people ?? 1;
  foods = foods.flatMap(f => f.comboRounds ? configureCombo(f, constraints) : [f]).map(f => f.productMapping ? f : mapProduct(f));
  const contentMatches = (food, term) => mealContents(food).some(part => matchesProductTerm(part, term));
  const warnings = [];
  if (constraints.preferCombo) warnings.push('套餐优先：没有合适的官方套餐时会推荐单点搭配。');
  if (foods.some(f => f.basis?.kind !== 'serving')) warnings.push('部分餐品营养未知，设置营养目标后会排除这些餐品。');
  if (constraints.includeKeywords.length || constraints.includeAnyKeywords.length || constraints.avoid.length) warnings.push('有食物过敏请核对官方信息，口味筛选不能保证无过敏原。');
  if (constraints.unsweetenedDrink) warnings.push('无糖饮品按官方名称筛选，具体糖含量未知。');
  if (constraints.goal === 'low-sugar' || constraints.sugarMax !== null) warnings.push('暂无糖含量数据，无法确认低糖目标。');
  const needsNutrition = constraints.goal !== 'balanced' || ['kcalTarget', 'kcalMin', 'kcalMax', 'proteinMin', 'sugarMax', 'sodiumMax'].some(key => constraints[key] !== null);
  let eligible = foods.filter(f => f.productMapping.kind !== 'non-food' && !['failed', 'unsupported'].includes(f.configurationStatus) && ((f.basis?.kind === 'serving' || f.isCombo) && f.nutrition.kcal !== null || !needsNutrition && f.standardVerified === true && f.productCode && (f.isCombo || ['food', 'beverage'].includes(f.productMapping.kind))) && !constraints.avoid.some(a => a.trim() && contentMatches(f, a.trim()))).map(f => f.basis?.kind === 'serving' || f.isCombo ? f : { ...f, nutrition: emptyNutrition() });
  // Hard limits require known values. Unknown nutrition can never pass a stated limit.
  if (constraints.sugarMax !== null) eligible = eligible.filter(f => f.nutrition.sugarG !== null && f.nutrition.sugarG <= constraints.sugarMax);
  if (constraints.sodiumMax !== null) eligible = eligible.filter(f => f.nutrition.sodiumMg !== null && f.nutrition.sodiumMg <= constraints.sodiumMax);
  const eligibleBeforeSearch = eligible;
  const target = constraints.kcalTarget ?? (constraints.kcalMin !== null && constraints.kcalMax !== null ? (constraints.kcalMin + constraints.kcalMax) / 2 : null);
  // A bounded, deterministic factual candidate set; naming heuristics never become nutrient facts.
  const wanted = f => [...constraints.includeKeywords, ...constraints.includeAnyKeywords].some(k => contentMatches(f, k)) || constraints.unsweetenedDrink && isBeverage(f) && hasProductFeature(f, 'unsweetened-label');
  eligible = eligible.sort((a, b) => {
    const comboPriority = constraints.preferCombo ? Number(b.isCombo === true) - Number(a.isCombo === true) : 0; if (comboPriority) return comboPriority;
    const priority = Number(wanted(b)) - Number(wanted(a)); if (priority) return priority;
    if (constraints.goal === 'high-protein') return (b.nutrition.proteinG ?? -1) - (a.nutrition.proteinG ?? -1);
    if (target !== null) return Math.abs(a.nutrition.kcal - target / 2) - Math.abs(b.nutrition.kcal - target / 2);
    if (a.nutrition.kcal === null) return b.nutrition.kcal === null ? 0 : 1;
    if (b.nutrition.kcal === null) return -1;
    return a.nutrition.kcal - b.nutrition.kcal;
  });
  const seenCodes = new Map();
  eligible = eligible.filter(f => { const key = f.productCode || f.code || f.id; const count = seenCodes.get(key) || 0; seenCodes.set(key, count + 1); return count < (f.isCombo ? 4 : 8); }).slice(0, 160);
  const candidates = [];
  const mainTerms = constraints.includeKeywords.filter(k => productTermFeatures(k).some(f => ['beef', 'chicken', 'pork', 'fish'].includes(f)));
  const anyMainTerms = constraints.includeAnyKeywords.filter(k => productTermFeatures(k).some(f => ['beef', 'chicken', 'pork', 'fish'].includes(f)));
  const limits = members => { if (anyMainTerms.length && members.flatMap(mealContents).some(f => mealRole(f) === 'main' && !anyMainTerms.some(k => matchesProductTerm(f, k)))) return false; if (mainTerms.length === 1 && members.flatMap(mealContents).some(f => mealRole(f) === 'main' && !matchesProductTerm(f, mainTerms[0]))) return false; const c = compositionCounts(members); return c.main <= people && c.drink <= people && c.side <= people * 3 && c.dessert <= people && c.other === 0; };
  const add = members => {
    const parts = members.flatMap(mealContents);
    const counts = compositionCounts(members);
    if (!limits(members)) return;
    if (constraints.beverageOnlyAllowed ? counts.main || counts.side || counts.dessert || counts.drink !== people : counts.main !== people) return;
    if (constraints.includeKeywords.some(k => !members.some(f => contentMatches(f, k)))) return;
    if (constraints.includeAnyKeywords.length && !members.some(f => constraints.includeAnyKeywords.some(k => contentMatches(f, k)))) return;
    if (parts.some(f => !matchesDrinkPreference(f, constraints))) return;
    if (constraints.unsweetenedDrink && !parts.some(f => isBeverage(f) && hasProductFeature(f, 'unsweetened-label'))) return;
    const grouped = new Map();
    for (const f of members) {
      const previous = grouped.get(f.id);
      if (previous) { previous.quantity++; continue; }
      grouped.set(f.id, { id: f.id, name: f.name, quantity: 1, nutrition: f.nutrition, role: mealRole(f), imageUrl: f.imageUrl || f.image || null, ...(f.productCode ? { productCode: f.productCode } : {}), ...(f.roundList ? { roundList: structuredClone(f.roundList) } : {}), ...(f.components ? { components: f.components.map(c => ({ code: c.code, name: c.name, quantity: c.quantity, role: mealRole(c), imageUrl: c.imageUrl || null })) } : {}) });
    }
    const selected = [...grouped.values()];
    const nutrition = sumNutrition(selected);
    if (constraints.kcalMin !== null && nutrition.kcal < constraints.kcalMin || constraints.kcalMax !== null && nutrition.kcal > constraints.kcalMax) return;
    if (constraints.proteinMin !== null && (nutrition.proteinG === null || nutrition.proteinG < constraints.proteinMin)) return;
    if (constraints.sugarMax !== null && (nutrition.sugarG === null || nutrition.sugarG > constraints.sugarMax)) return;
    if (constraints.sodiumMax !== null && (nutrition.sodiumMg === null || nutrition.sodiumMg > constraints.sodiumMax)) return;
    let penalty = target === null ? 0 : Math.abs(nutrition.kcal - target);
    if (!constraints.beverageOnlyAllowed) {
      penalty += (people - counts.drink) * 35 + Math.abs(counts.side - people) * 12 + counts.dessert * 15;
      if (constraints.preferCombo) penalty -= members.filter(f => f.isCombo).reduce((n, f) => n + compositionCounts([f]).main, 0) * 150;
    }
    penalty -= members.reduce((n, f) => n + (f.configurationPreference || 0), 0) / 100;
    if (constraints.goal === 'high-protein') penalty -= (nutrition.proteinG ?? 0) * 4;
    if (constraints.goal === 'low-calorie') penalty += nutrition.kcal * 0.15;
    const id = `candidate-${createHash('sha256').update(selected.map(f => `${f.id}x${f.quantity}`).sort().join('|')).digest('hex').slice(0, 12)}`;
    const reasons = [`${people} 人份 · 主食 ${counts.main} · 饮品 ${counts.drink} · 配餐 ${counts.side}${counts.dessert ? ` · 甜品 ${counts.dessert}` : ''}`];
    if (target !== null) reasons.push(`热量 ${nutrition.kcal} kcal，目标 ${target} kcal`);
    if (nutrition.proteinG !== null) reasons.push(`蛋白质 ${nutrition.proteinG} g`);
    const priceHint = members.every(f => typeof f.menuPrice === 'number' && Number.isFinite(f.menuPrice)) ? members.reduce((sum, f) => sum + f.menuPrice, 0) : null;
    candidates.push({ priceHint, id, people, composition: counts, officialCombo: members.some(f => f.isCombo), title: selected.map(f => `${f.name}${f.quantity > 1 ? ` ×${f.quantity}` : ''}`).join(' + '), foods: selected, nutrition, price: null, priceStatus: 'unverified', score: Math.round(1000 - penalty), reasons, warnings: ['糖含量未知', ...(members.some(f => f.nutrition.kcal === null) ? ['部分餐品营养未知，本方案不用于满足热量或营养目标'] : []), ...(members.some(f => !f.productCode) ? ['门店在售情况及价格待查询'] : [])] });
  };
  // Bounded beam keeps multi-person searches finite and counts the contents of every official combo.
  const preferred = [...constraints.includeKeywords, ...constraints.includeAnyKeywords];
  const beamScore = members => {
    const counts = compositionCounts(members);
    const matched = preferred.filter(k => members.some(f => contentMatches(f, k))).length;
    const energy = sumNutrition(members).kcal;
    const cost = members.every(f => typeof f.menuPrice === 'number') ? members.reduce((s, f) => s + f.menuPrice, 0) : null;
    return (constraints.budget !== null && cost !== null && cost > constraints.budget ? -1000 : 0) + matched * 200 + (constraints.preferCombo ? members.filter(f => f.isCombo).reduce((n, f) => n + compositionCounts([f]).main, 0) * 100 : 0) + counts.drink * 10 - members.length - (target !== null && energy !== null ? Math.abs(energy - target) / 50 : 0);
  };
  let beam = [[]];
  for (let step = 0; step < people * 4; step++) {
    const next = new Map();
    for (const members of beam) {
      const counts = compositionCounts(members);
      const missing = constraints.includeKeywords.filter(k => !members.some(f => contentMatches(f, k)));
      const pool = eligible.filter(f => {
        const roles = compositionCounts([f]);
        if (constraints.beverageOnlyAllowed) return roles.drink > 0 && roles.main + roles.side + roles.dessert + roles.other === 0;
        if (counts.main < people) return roles.main > 0;
        if (roles.main) return false;
        return roles.drink > 0 && counts.drink < people || roles.side > 0 && counts.side < people || missing.some(k => contentMatches(f, k));
      });
      for (const food of pool) {
        const expanded = [...members, food];
        if (!limits(expanded)) continue;
        const key = expanded.map(f => f.id).sort().join('|');
        if (!next.has(key)) { add(expanded); next.set(key, expanded); }
      }
    }
    beam = [...next.values()].sort((a, b) => beamScore(b) - beamScore(a)).slice(0, 100);
    if (!beam.length) break;
  }
  // Catalog prices only prioritize reads; every displayed payable price still requires a complete live quote.
  const pricePriority = candidate => constraints.budget === null ? 0 : candidate.priceHint === null ? 0 : candidate.priceHint <= constraints.budget ? 0 : 1;
  const sorted = [...new Map(candidates.map(c => [c.id, c])).values()].sort((a, b) => pricePriority(a) - pricePriority(b) || b.score - a.score);
  // Reserve single-item alternatives so an unaffordable preferred combo cannot hide an affordable meal.
  const combos = sorted.filter(c => c.officialCombo);
  const reserveSingles = combos.length ? Math.min(6, Math.floor(limit / 3)) : limit;
  const chosen = constraints.preferCombo
    ? [...combos.slice(0, limit - reserveSingles), ...sorted.filter(c => !c.officialCombo).slice(0, reserveSingles)]
    : sorted.slice(0, limit);
  const unique = chosen.map(({ priceHint, ...candidate }) => candidate);
  if (!unique.length) warnings.push('没有足够的已知数据满足这些限制，请调整条件或等待完整营养数据');
  const noMatch = unique.length ? null : explainNoMatch(foods, eligibleBeforeSearch, constraints);
  return { candidates: unique, warnings, noMatch };
}

function isBeverage(food) { return food.productMapping?.kind === 'beverage'; }


function explainNoMatch(foods, eligible, constraints) {
  const details = { menuCount: foods.length, eligibleCount: eligible.length };
  const reason = (code, message, missing = []) => ({ code, message, ...details, missingFeatures: [...new Set(missing.flatMap(productTermFeatures))] });
  const all = terms => terms.filter(term => !foods.some(f => matchesProductTerm(f, term)));
  const display = term => ({ 牛: '牛肉', 鸡: '鸡肉', 猪: '猪肉', 鱼: '鱼肉' })[term] || term;
  if (!foods.length) return reason('MENU_EMPTY', '这个时间没有可选餐品，试试更换餐厅或取餐时间。');
  const missing = all(constraints.includeKeywords);
  const alternatives = constraints.includeAnyKeywords;
  if (missing.length || alternatives.length && all(alternatives).length === alternatives.length) {
    const terms = missing.length ? missing : alternatives;
    return reason('REQUIRED_FOOD_NOT_IDENTIFIED', `当前菜单未找到已确认的「${terms.map(display).join('、')}」，试试更换餐厅或取餐时间。`, terms);
  }
  if (constraints.unsweetenedDrink && !foods.some(f => isBeverage(f) && hasProductFeature(f, 'unsweetened-label'))) return reason('UNSWEETENED_DRINK_NOT_IDENTIFIED', '当前菜单没有已确认的无糖饮品，试试更换餐厅或取餐时间。', ['无糖饮料']);
  if (constraints.sugarMax !== null && foods.every(f => f.nutrition.sugarG === null)) return reason('NUTRITION_DATA_MISSING', '暂无糖含量数据，无法按糖上限筛选。');
  const unavailable = constraints.includeKeywords.filter(term => !eligible.some(f => matchesProductTerm(f, term)));
  if (unavailable.length) return reason('REQUESTED_FOOD_NOT_ELIGIBLE', `「${unavailable.map(display).join('、')}」的规格、营养或口味条件不符合本次要求。`, unavailable);
  if (!eligible.length) return reason('NO_ELIGIBLE_FOOD', '没有餐品符合当前条件，试试调整口味或营养目标。');
  return reason('COMBINATION_NOT_FOUND', '暂未找到满足全部要求的搭配，试试放宽一项条件。');
}
