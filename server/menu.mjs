import { normalizedComboRounds } from './meal-composition.mjs';
import { describeMenu } from './menu-context.mjs';
import { mapProduct } from './product-mapping.mjs';
import { assert } from './errors.mjs';
import { unwrapMcp, normalizeMenu, matchNutritionByName, safeHttpsImage } from './normalize.mjs';

// Only provider-confirmed single items and one-choice size groups can supply serving nutrition.
export function normalizeMealDetail(result, item, foods, catalog = new Map()) {
  const { data } = unwrapMcp(result);
  assert(data?.code === item.code && typeof data.name === 'string' && Array.isArray(data.rounds), 'MEAL_DETAIL_SCHEMA_CHANGED', '餐品规格返回不完整，暂不用于推荐', 502);
  if (!data.rounds.length) return [mapProduct({ ...item, standardVerified: true, configurationStatus: 'resolved', name: data.name, description: typeof data.description === 'string' ? data.description : item.description, nutrition: matchNutritionByName(data.name, foods) })];
  if (data.rounds.length !== 1 || data.rounds[0].quantity !== 1) {
    const comboRounds = normalizedComboRounds(data.rounds, foods, catalog);
    return comboRounds ? [mapProduct({ ...item, name: data.name, imageUrl: safeHttpsImage(data.image || item.imageUrl || item.image), isCombo: true, comboRounds, configurationStatus: 'configurable' })] : [];
  }
  const round = data.rounds[0];
  if (round.minQuantity !== 1 || round.maxQuantity !== 1 || round.quantity !== 1 || !Array.isArray(round.choices) || !['number', 'string'].includes(typeof round.id)) return [];
  return round.choices.filter(c => typeof c.code === 'string' && typeof c.name === 'string' && (c.maxQuantity == null || Number.isSafeInteger(c.maxQuantity) && (c.maxQuantity === -1 || c.maxQuantity > 0))).map(c => mapProduct({
    ...item, ...(catalog.get(c.code) ? { tags: catalog.get(c.code).tags, categories: catalog.get(c.code).categories, category: catalog.get(c.code).category } : {}), classificationSourceCode: catalog.get(c.code)?.code || item.code, variantCode: c.code, standardVerified: true, configurationStatus: 'resolved', id: `${item.code}:${c.code}`, name: c.name, description: typeof c.description === 'string' ? c.description : null,
    nutrition: matchNutritionByName(c.name, foods),
    roundList: [{ round: String(round.id), comboItemList: [{ code: c.code, quantity: 1 }] }],
  }));
}

export async function readStoreMenu(client, context, foods, coupons = [], onSnapshot = () => {}) {
  const menu = normalizeMenu(await client.callRead('query-meals', context), foods);
  menu.storeContext = { ...context };
  menu.menuContext = describeMenu(menu, context);
  onSnapshot(menu);
  const availableTools = await client.listTools();
  if (!availableTools.some(t => t.name === 'query-meal-detail')) return menu;
  const catalog = new Map(menu.items.map(item => [item.code, item]));
  const couponProducts = coupons.flatMap(c => c.products).filter(p => typeof p.productCode === 'string' && typeof p.productName === 'string' && !menu.items.some(i => i.code === p.productCode));
  const requested = [...menu.items.filter(item => item.productMapping.kind !== 'non-food'), ...couponProducts.map(p => ({ id: p.productCode, code: p.productCode, name: p.productName, category: null, couponOnly: true }))];
  const unique = [...new Map(requested.map(i => [i.code, i])).values()];
  assert(unique.length <= 1000, 'MENU_TOO_LARGE', '餐品目录过大，无法在本次请求中完整查询', 502);
  menu.detailCoverage = { requested: unique.length, resolved: 0, failed: 0, unsupported: 0 };
  for (let offset = 0; offset < unique.length; offset += 4) {
    const batch = unique.slice(offset, offset + 4);
    const results = await Promise.allSettled(batch.map(async item => normalizeMealDetail(await client.callRead('query-meal-detail', { ...context, code: item.code }), item, foods, catalog)));
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        if (result.reason?.code === 'MCD_RATE_LIMIT') {
          menu.detailCoverage.failed = unique.length - menu.detailCoverage.resolved - menu.detailCoverage.unsupported;
          const remaining = new Set(unique.slice(offset + i).map(item => item.code));
          menu.items = menu.items.map(item => remaining.has(item.code) ? { ...item, configurationStatus: 'failed' } : item);
          menu.warnings.push('菜单查询过于频繁，餐品覆盖不完整，请稍后重试。');
          return menu;
        }
        menu.detailCoverage.failed++;
        menu.items = menu.items.map(item => item.code === batch[i].code ? { ...item, configurationStatus: 'failed' } : item);
        menu.warnings.push('部分餐品规格暂时无法查询，未参与搭配。');
        continue;
      }
      const exact = result.value;
      if (exact.length) { menu.items = [...menu.items.filter(existing => existing.code !== batch[i].code), ...exact]; menu.detailCoverage.resolved++; }
      else {
        menu.detailCoverage.unsupported++;
        menu.items = menu.items.map(item => item.code === batch[i].code ? { ...item, configurationStatus: 'unsupported' } : item);
      }
    }
  }
  if (menu.detailCoverage.unsupported) menu.warnings.push(`${menu.detailCoverage.unsupported} 款套餐暂不支持自动搭配`);
  menu.warnings = [...new Set(menu.warnings)];
  return menu;
}
