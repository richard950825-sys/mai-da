import calculator from './serving-calculator-evidence.json' with { type: 'json' };
// Evidence for serving basis only. These records are NEVER a replacement menu/nutrition source.
// An authoritative live MCP record must independently match the exact name and all six
// published nutrient values, plus consistent kcal, before this metadata can be attached.
// Only unambiguous single-item products are listed; no size aliases, combos or substitutions.
export const SERVING_EVIDENCE = Object.freeze([
  { name: '猪柳麦满分', portion: '1个', url: 'https://www.mcdonalds.com.cn/product/sausage-mcmuffin', values: [1288, 16, 16, 24, 781, 213] },
  { name: '猪柳蛋麦满分', portion: '1个', url: 'https://www.mcdonalds.com.cn/product/sausage-mcmuffin-with-egg', values: [1618, 23, 21, 25, 846, 243] },
  { name: '巨无霸', portion: '1个', url: 'https://www.mcdonalds.com.cn/product/Big-Mac', values: [2146, 27, 26, 42, 961, 171] },
  { name: '板烧鸡腿堡', portion: '1个', url: 'https://www.mcdonalds.com.cn/product/Grilled-Chicken-Sandwich?from=groupmessage', values: [1638, 23, 17, 35, 1041, 93] },
].map(e => Object.freeze({ ...e, retrievedAt: '2026-10-09', sourceDataDate: '2025-04', values: Object.freeze(e.values) })));
const calculatorEntries = calculator.entries.map(e => ({ ...e, url: calculator.url, retrievedAt: calculator.retrievedAt, sourceDataDate: calculator.sourceDataDate }));
const fields = ['energyKj', 'protein', 'fat', 'carbohydrate', 'sodium', 'calcium'];
export function verifiedServingEvidence(row, readNumber) {
  // Never override any nonempty portion text: an explicit conflicting portion wins.
  if (row.nutritionDescription != null && String(row.nutritionDescription).trim() !== '') return null;
  const entry = [...SERVING_EVIDENCE, ...calculatorEntries].find(e => e.name === row.productName);
  if (!entry || !fields.every((field, i) => readNumber(row[field]) === entry.values[i])) return null;
  if (readNumber(row.energyKcal) !== Math.round(entry.values[0] / 4.184)) return null;
  return { kind: 'serving', description: entry.portion, evidence: { source: 'official-product-page', url: entry.url, retrievedAt: entry.retrievedAt, sourceDataDate: entry.sourceDataDate, match: 'exact-name-and-six-nutrient-fingerprint', kcalCheck: 'rounded-kJ-divided-by-4.184' } };
}
