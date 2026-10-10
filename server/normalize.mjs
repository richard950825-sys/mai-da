import { createHash } from 'node:crypto';
import { decode } from '@toon-format/toon';
import { AppError, assert } from './errors.mjs';
import { verifiedServingEvidence } from './serving-evidence.mjs';
import { mapProduct } from './product-mapping.mjs';

export const SOURCE = 'mcd-live';
export const NUTRIENTS = ['kcal', 'proteinG', 'fatG', 'carbsG', 'sugarG', 'sodiumMg', 'calciumMg'];
export const emptyNutrition = () => Object.fromEntries(NUTRIENTS.map(k => [k, null]));
export function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\s*\d+(?:\.\d+)?\s*$/.test(value))) return null;
  const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null;
}
export function textOrNull(value) { return typeof value === 'string' && value.trim() ? value.trim() : null; }
export function unwrapMcp(result) {
  assert(result && !result.isError, 'MCD_TOOL_FAILED', '麦当劳查询未成功，没有可用的实时结果', 502);
  let payload = result.structuredContent;
  if (payload === undefined) {
    const texts = (result.content || []).filter(c => c.type === 'text').map(c => c.text);
    assert(texts.length === 1 && typeof texts[0] === 'string', 'MCD_PAYLOAD_UNSUPPORTED', '此麦当劳响应格式尚未适配', 502);
    try { payload = JSON.parse(texts[0]); }
    catch { throw new AppError('MCD_PAYLOAD_UNSUPPORTED', '此麦当劳响应不是支持的 JSON 格式', 502); }
  }
  assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'MCD_PAYLOAD_UNSUPPORTED', '麦当劳响应结构不可识别', 502);
  if (String(payload.code) === '600057') throw new AppError('STORE_NOT_AVAILABLE_NOW', '这家餐厅当前不支持即时点餐，请查看营业信息并选择可预约时段后重试', 409);
  assert(payload.success === true && (payload.code === 200 || payload.code === '200'), 'MCD_BUSINESS_ERROR', '麦当劳未确认此查询成功，请检查门店、餐段及账户状态', 502);
  assert(Object.hasOwn(payload, 'data'), 'MCD_PAYLOAD_UNSUPPORTED', '麦当劳未返回查询数据', 502);
  return { data: payload.data, source: SOURCE, retrievedAt: new Date().toISOString(), providerTime: textOrNull(payload.datetime) };
}
export function nutritionBasis(description) {
  if (typeof description !== 'string' || !description.trim()) return { kind: 'unknown', description: null };
  const text = description.normalize('NFKC').trim();
  if (/(?:每|per\s*)?100\s*(?:g|克|ml|毫升)/i.test(text)) return { kind: 'per-100', description: text };
  if (/(?:每(?:一)?份|单份|每(?:一)?个|单个|每杯|per\s+serving|per\s+portion)/i.test(text) && !/(?:半份|每\s*\d+|每百|per\s*\d+)/i.test(text)) return { kind: 'serving', description: text };
  return { kind: 'unknown', description: text };
}
export function normalizeNutrition(result) {
  const envelope = unwrapMcp(result); let rows = envelope.data;
  if (typeof rows === 'string') {
    try { rows = decode(rows); }
    catch { throw new AppError('NUTRITION_TOON_INVALID', '营养信息的 TOON 数据无法解析', 502); }
  }
  assert(Array.isArray(rows), 'NUTRITION_SCHEMA_CHANGED', '营养数据结构已变化，需要更新适配', 502);
  const foods = rows.map((r, index) => {
    assert(r && textOrNull(r.productName), 'NUTRITION_SCHEMA_CHANGED', '营养数据缺少餐品名称', 502);
    return {
      id: `nutrition-${createHash('sha256').update(`${r.productName}|${r.nutritionDescription || ''}|${index}`).digest('hex').slice(0, 12)}`,
      name: r.productName.trim(), description: textOrNull(r.nutritionDescription), basis: verifiedServingEvidence(r, numberOrNull) || nutritionBasis(r.nutritionDescription),
      nutrition: { kcal: numberOrNull(r.energyKcal), proteinG: numberOrNull(r.protein), fatG: numberOrNull(r.fat), carbsG: numberOrNull(r.carbohydrate), sugarG: null, sodiumMg: numberOrNull(r.sodium), calciumMg: numberOrNull(r.calcium) },
      source: SOURCE,
    };
  });
  return { foods, source: SOURCE, retrievedAt: envelope.retrievedAt, warnings: ['官方未提供糖含量，暂显示为未知。', '定制或替换餐品后，营养数据可能变化。'] };
}
export function sumNutrition(foods) {
  return Object.fromEntries(NUTRIENTS.map(key => {
    const known = foods.length > 0 && foods.every(f => numberOrNull(f.nutrition?.[key]) !== null);
    return [key, known ? Math.round(foods.reduce((s, f) => s + f.nutrition[key] * (f.quantity ?? 1), 0) * 100) / 100 : null];
  }));
}
export function normalizeStores(result) {
  const envelope = unwrapMcp(result);
  assert(Array.isArray(envelope.data), 'STORE_SCHEMA_CHANGED', '门店数据结构已变化，需要更新适配', 502);
  return { stores: envelope.data.map(s => {
    assert(textOrNull(s.storeCode) && textOrNull(s.storeName), 'STORE_SCHEMA_CHANGED', '门店数据缺少编码或名称', 502);
    return { id: s.storeCode, storeCode: s.storeCode, beCode: s.beCode ?? null, name: s.storeName, address: textOrNull(s.address), distance: s.distance ?? null, reservation: typeof s.reservation === 'boolean' ? s.reservation : null, businessStatus: typeof s.businessStatus === 'boolean' ? s.businessStatus : null, businessStartTime: textOrNull(s.businessStartTime), businessEndTime: textOrNull(s.businessEndTime), reservationTimeOptions: Array.isArray(s.reservationTimeOptions) ? s.reservationTimeOptions.filter(o => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && typeof o.reservationOptionText === 'string').map(o => ({ date: o.date, today: o.today === true, reservationOptionText: o.reservationOptionText })) : [] };
  }), source: SOURCE, retrievedAt: envelope.retrievedAt };
}
export function normalizeAddresses(result) {
  const envelope = unwrapMcp(result);
  assert(Array.isArray(envelope.data?.addresses), 'ADDRESS_SCHEMA_CHANGED', '配送地址数据结构已变化', 502);
  return { addresses: envelope.data.addresses.map(a => ({ id: a.addressId, addressId: a.addressId, label: textOrNull(a.fullAddress), contactName: textOrNull(a.contactName), phone: textOrNull(a.phone) })), source: SOURCE, retrievedAt: envelope.retrievedAt };
}
export function matchNutritionByName(name, foods) {
  const matched = foods.filter(f => f.name.normalize('NFKC').trim() === name.normalize('NFKC').trim());
  return matched.length === 1 && matched[0].basis?.kind === 'serving' ? { ...matched[0].nutrition } : emptyNutrition();
}
export function normalizeMenu(result, foods = []) {
  const envelope = unwrapMcp(result); const data = envelope.data;
  assert(data?.meals && typeof data.meals === 'object' && !Array.isArray(data.meals), 'MENU_SCHEMA_CHANGED', '菜单数据结构已变化，需要更新适配', 502);
  const categories = Array.isArray(data.categories) ? data.categories : [];
  const items = Object.entries(data.meals).map(([code, meal]) => {
    assert(textOrNull(meal.name), 'MENU_SCHEMA_CHANGED', '菜单餐品缺少名称', 502);
    const references = categories.flatMap(c => Array.isArray(c.meals) ? c.meals.filter(m => m.code === code).map(m => ({ category: textOrNull(c.name), tags: Array.isArray(m.tags) ? m.tags.filter(t => typeof t === 'string') : [] })) : []);
    const categoryNames = [...new Set(references.map(r => r.category).filter(Boolean))];
    const tags = [...new Set(references.flatMap(r => r.tags))];
    const requiresAddOn = typeof meal.discountType === 'string' && meal.discountType.includes('随单购');
    return mapProduct({ id: code, code, name: meal.name, description: textOrNull(meal.description), image: safeHttpsImage(meal.image), category: categoryNames[0] || null, categories: categoryNames, tags, menuPrice: requiresAddOn ? numberOrNull(meal.originalPrice) : numberOrNull(meal.currentPrice), originalPrice: numberOrNull(meal.originalPrice), discountType: textOrNull(meal.discountType), requiresAddOn, nutrition: matchNutritionByName(meal.name, foods) });
  });
  return { items, source: SOURCE, retrievedAt: envelope.retrievedAt, warnings: ['价格以结算时为准。', '未核实整份营养的餐品显示为未知。'] };
}
export function safeHttpsImage(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && ['mcd.cn', 'mcdchina.net', 'mcdonalds.com.cn'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null; } catch { return null; }
}
export function normalizeCoupons(result) {
  const envelope = unwrapMcp(result);
  assert(Array.isArray(envelope.data), 'COUPON_SCHEMA_CHANGED', '优惠券数据结构已变化', 502);
  return { coupons: envelope.data.map(c => ({ id: c.couponId, couponId: c.couponId, couponCode: c.couponCode, title: textOrNull(c.title), validity: textOrNull(c.tradeDateTime), products: Array.isArray(c.products) ? c.products.map(p => ({ productCode: p.productCode, productName: p.productName })) : [] })), source: SOURCE, retrievedAt: envelope.retrievedAt };
}
export function normalizeQuote(result, requestedItems) {
  const envelope = unwrapMcp(result); const d = envelope.data;
  assert(d && typeof d === 'object' && !Array.isArray(d), 'QUOTE_SCHEMA_CHANGED', '价格数据结构已变化', 502);
  const fen = value => Number.isSafeInteger(value) && value >= 0 ? value / 100 : null;
  const total = fen(d.price);
  assert(total !== null, 'QUOTE_TOTAL_UNKNOWN', '麦当劳未返回可确认的实付总价', 502);
  if (requestedItems) {
    const quantities = rows => {
      const totals = new Map();
      for (const row of rows) {
        assert(typeof row.productCode === 'string' && Number.isSafeInteger(row.quantity) && row.quantity > 0, 'QUOTE_ITEMS_UNVERIFIED', '实时报价未完整确认餐品与数量，请重新选择或核价', 502);
        totals.set(row.productCode, (totals.get(row.productCode) || 0) + row.quantity);
      }
      return totals;
    };
    assert(Array.isArray(d.productList), 'QUOTE_ITEMS_UNVERIFIED', '实时报价缺少餐品明细，不能确认实付金额', 502);
    const expected = quantities(requestedItems); const actual = quantities(d.productList);
    assert(expected.size === actual.size && [...expected].every(([code, count]) => actual.get(code) === count), 'QUOTE_ITEMS_UNVERIFIED', '实时报价漏掉了餐品或数量，不能作为完整报价；券专用商品需要有效优惠券', 502);
  }
  return { quote: { currency: 'CNY', total, productTotal: fen(d.productPrice), deliveryFee: fen(d.deliveryPrice), discount: fen(d.discount), tablewareFee: fen(d.tablewarePrice), items: Array.isArray(d.productList) ? d.productList : [], takeWayList: Array.isArray(d.takeWayList) ? d.takeWayList.map(t => ({ ...t, name: textOrNull(t.name) || textOrNull(t.title) || textOrNull(t.takeWayName) })) : [] }, source: SOURCE, retrievedAt: envelope.retrievedAt };
}
