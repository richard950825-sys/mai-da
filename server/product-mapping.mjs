// Product identity stays the supplier code/variant. These are category signals, not a complete ingredient or allergen list.
import { assert } from './errors.mjs';

export const PRODUCT_MAPPING_VERSION = 'catalog-v3';
const strings = values => Array.isArray(values) ? values.filter(v => typeof v === 'string') : [];
const canonicalName = name => String(name || '').normalize('NFKC').replace(/^麦咖啡(?:TM|®)?/, '').trim();
const termFeatures = {
  牛: ['beef'], 牛肉: ['beef'], 牛肉汉堡: ['beef', 'burger'],
  鸡: ['chicken'], 鸡肉: ['chicken'], 鸡肉汉堡: ['chicken', 'burger'],
  猪: ['pork'], 猪肉: ['pork'], 鱼: ['fish'], 鱼肉: ['fish'],
  汉堡: ['burger'], 饮料: ['beverage'], 饮品: ['beverage'],
  有糖可乐: ['beverage', 'cola', 'regular-cola'], 普通可乐: ['beverage', 'cola', 'regular-cola'],
  含糖可乐: ['beverage', 'cola', 'regular-cola'], 正常可乐: ['beverage', 'cola', 'regular-cola'], 经典可乐: ['beverage', 'cola', 'regular-cola'],
  有糖可口可乐: ['beverage', 'cola', 'regular-cola'], 普通可口可乐: ['beverage', 'cola', 'regular-cola'],
  可乐: ['beverage', 'cola'], 无糖可乐: ['beverage', 'cola', 'unsweetened-label'],
  无糖可口可乐: ['beverage', 'cola', 'unsweetened-label'], 零糖可乐: ['beverage', 'cola', 'unsweetened-label'], '0糖可乐': ['beverage', 'cola', 'unsweetened-label'],
  无糖饮料: ['beverage', 'unsweetened-label'], 咖啡: ['coffee'], 美式咖啡: ['coffee', 'americano'],
  甜品: ['dessert'], 甜点: ['dessert'], 小食: ['side'],
};
export function mapProduct(product) {
  const features = new Set(); const evidence = [];
  const add = (feature, source, value) => { features.add(feature); evidence.push({ feature, source, value, sourceCode: source === 'explicit-name' ? product.variantCode || product.code || null : product.classificationSourceCode || product.code || null }); };
  const name = canonicalName(product.name);
  const categories = [...new Set([...strings(product.categories), ...(typeof product.category === 'string' ? [product.category] : [])])];
  const tags = strings(product.tags);
  if (categories.some(c => /周边|礼品卡|会员卡/.test(c)) || /棒球帽|玩偶|玩具|礼品卡|会员卡|包装盒/.test(name)) {
    return { ...product, productMapping: { kind: 'non-food', features: [], evidence: [{ feature: 'non-food', source: 'explicit-name-or-category', value: name }] } };
  }
  for (const tag of tags) {
    if (['100%纯牛肉', '100%安格斯牛肉', '纯牛肉', '牛肉'].includes(tag)) add('beef', 'product-tag', tag);
    if (['麦香鱼系列', '鱼肉', '鳕鱼'].includes(tag)) add('fish', 'product-tag', tag);
    if (['鸡肉', '鸡肉系列'].includes(tag)) add('chicken', 'product-tag', tag);
    if (['冷饮', '热饮', '饮品', '饮料'].includes(tag)) add('beverage', 'product-tag', tag);
    if (['冰淇淋', '派', '甜品'].includes(tag)) add('dessert', 'product-tag', tag);
    if (tag === '小食') add('side', 'product-tag', tag);
  }
  for (const label of categories) {
    const c = label.replace(/\s/g, '');
    if (/鸡肉汉堡/.test(c)) { add('chicken', 'menu-category', label); add('burger', 'menu-category', label); }
    if (/牛鱼肉堡|厚牛堡|汉堡和卷/.test(c)) add('burger', 'menu-category', label); // Mixed beef/fish shelves do not establish meat type.
    if (c === '炸鸡' && tags.includes('单品')) add('chicken', 'menu-category', label);
    if (['饮品', '饮料', '冷饮', '热饮'].includes(c)) add('beverage', 'menu-category', label);
  }
  // Explicit type/serving labels supplement incomplete catalog metadata; single animal characters never imply meat.
  if (/堡|麦满分/.test(name)) add('burger', 'explicit-name', name);
  if (/牛肉(?!味|风味)|牛堡|牛排|厚牛/.test(name) && !/牛油果|植物|纯素|素食|人造肉/.test(name)) add('beef', 'explicit-name', name);
  if (/鸡肉|鸡腿|鸡翅|鸡块|鸡排|麦乐鸡|脆汁鸡/.test(name)) add('chicken', 'explicit-name', name);
  if (/猪肉|猪柳|猪排/.test(name)) add('pork', 'explicit-name', name);
  if (/鱼肉|鱼排|鱼堡|鳕鱼|麦香鱼/.test(name)) add('fish', 'explicit-name', name);
  if (/冰淇淋|麦旋风|新地|圣代|甜筒|圆筒|阿芙佳朵|蛋糕|派/.test(name)) add('dessert', 'explicit-name', name);
  if (/薯条|薯饼|玉米杯|苹果片|鸡翅|麦乐鸡/.test(name)) add('side', 'explicit-name', name);
  if (!features.has('burger') && !features.has('dessert') && /可乐|雪碧|芬达|怡泉|咖啡|奶铁|拿铁|美式|红茶|奶茶|果汁|橙汁|橙橙|牛奶|纯悦|纯净水|矿泉水|冰沙|雪冰/.test(name)) add('beverage', 'explicit-name', name);
  if (features.has('beverage')) {
    if (/可乐/.test(name)) add('cola', 'explicit-name', name);
    // Match the provider's standard-cola names positively; an unfamiliar cola is not assumed to contain sugar.
    if (/^(?:(?:普通|经典|原味|正常|有糖|含糖)(?:款)?)?(?:可口)?可乐(?:[(]?(?:大|中|小)杯?[)]?)?$/.test(name.replace(/[®™\s]/g, ''))) add('regular-cola', 'explicit-name', name);
    if (/咖啡|美式|奶铁|拿铁|卡布奇诺|玛奇朵|浓缩/.test(name)) add('coffee', 'explicit-name', name);
    if (/美式/.test(name)) add('americano', 'explicit-name', name);
    if (/无糖|零糖|0糖/.test(name)) add('unsweetened-label', 'explicit-name', name);
    // Beverage labels cannot be used as evidence of a meat dish (e.g. 牛奶).
    for (const meat of ['beef', 'chicken', 'pork', 'fish']) features.delete(meat);
  }
  const kind = features.has('beverage') ? 'beverage' : ['beef', 'chicken', 'pork', 'fish', 'burger', 'side', 'dessert'].some(f => features.has(f)) ? 'food' : 'unknown';
  return { ...product, productMapping: { kind, features: [...features], evidence: evidence.filter(e => features.has(e.feature)) } };
}
export function hasProductFeature(product, feature) { return product.productMapping?.features.includes(feature) === true; }
export function productTermFeatures(term) { return Object.hasOwn(termFeatures, term) ? termFeatures[term] : []; }
export function matchesProductTerm(product, term) {
  const required = productTermFeatures(term);
  return required.length ? required.every(feature => hasProductFeature(product, feature)) : canonicalName(product.name).includes(canonicalName(term));
}


export function matchesDrinkPreference(product, constraints) {
  if (product.productMapping?.kind !== 'beverage') return true;
  if (constraints.unsweetenedDrink && !hasProductFeature(product, 'unsweetened-label')) return false;
  if (!hasProductFeature(product, 'cola')) return true;
  const requestedTypes = ['regular-cola', 'unsweetened-label'].filter(feature => constraints.includeKeywords.some(term => productTermFeatures(term).includes('cola') && productTermFeatures(term).includes(feature)));
  // A single requested cola type applies to every cola, including drinks inside multi-person packages.
  return requestedTypes.length !== 1 || hasProductFeature(product, requestedTypes[0]);
}

export function needsProductUnderstanding(product) {
  const mapping = product.productMapping;
  return mapping.kind === 'unknown' || mapping.features.includes('burger') && !['beef', 'chicken', 'pork', 'fish'].some(f => mapping.features.includes(f));
}

// Only public product descriptors enter the model/cache key; prices, account data and nutrition never do.
export function productSource(product) {
  return {
    id: product.id || product.code, code: product.code, variantCode: product.variantCode || null,
    name: product.name, description: product.description || '',
    categories: [...new Set(strings(product.categories))].sort(), tags: [...new Set(strings(product.tags))].sort(),
    classificationSourceCode: product.classificationSourceCode || product.code,
    roundList: product.roundList || [],
  };
}
const productFeatures = ['food', 'non-food', 'beverage', 'beef', 'chicken', 'pork', 'fish', 'burger', 'side', 'dessert', 'cola', 'coffee', 'americano', 'unsweetened-label'];
export function validateProductMappings(output, sources, allowPartial = false) {
  const valid = condition => assert(condition, 'PRODUCT_MAPPING_INVALID', '商品分类结果未通过校验，未将它作为商品事实', 502);
  valid(output && typeof output === 'object' && !Array.isArray(output) && Object.keys(output).every(k => k === 'products') && Array.isArray(output.products) && output.products.length === sources.length);
  const byId = new Map(sources.map(p => [p.id, p])); const seen = new Set();
  for (const row of output.products) {
    valid(row && typeof row === 'object' && typeof row.id === 'string' && byId.has(row.id) && !seen.has(row.id));
    seen.add(row.id);
  }
  const validateRow = row => {
    valid(Object.keys(row).every(k => ['id', 'kind', 'evidence'].includes(k)));
    valid(['food', 'beverage', 'non-food', 'unknown'].includes(row.kind));
    valid(Array.isArray(row.evidence) && row.evidence.length <= productFeatures.length);
    const source = byId.get(row.id); const features = new Set();
    const evidence = row.evidence.map(e => {
      valid(e && typeof e === 'object' && Object.keys(e).every(k => ['feature', 'field', 'value'].includes(k)));
      valid(productFeatures.includes(e.feature)); features.add(e.feature);
      valid(['name', 'description', 'tags', 'categories'].includes(e.field) && typeof e.value === 'string' && e.value.trim().length > 0 && e.value.length <= 240);
      const values = Array.isArray(source[e.field]) ? source[e.field] : [source[e.field]];
      valid(values.some(value => typeof value === 'string' && value.includes(e.value)));
      if (['coffee', 'americano'].includes(e.feature) && ['categories', 'tags'].includes(e.field)) valid(values.some(value => value.includes(e.value) && !/^麦咖啡(?:TM|™|®)?$/.test(value)));
      if (e.feature === 'unsweetened-label') valid(/无糖|零糖|0糖/.test(e.value));
      return { feature: e.feature, source: 'llm', field: e.field, value: e.value, sourceCode: ['tags', 'categories'].includes(e.field) ? source.classificationSourceCode : source.variantCode || source.code };
    });
    const foodFeatures = ['food', 'beef', 'chicken', 'pork', 'fish', 'burger', 'side', 'dessert'];
    const beverageFeatures = ['beverage', 'cola', 'coffee', 'americano', 'unsweetened-label'];
    if (row.kind === 'unknown') valid(features.size === 0);
    if (row.kind === 'food') valid([...features].some(f => foodFeatures.includes(f)) && ![...features].some(f => beverageFeatures.includes(f) || f === 'non-food'));
    if (row.kind === 'beverage') {
      valid([...features].some(f => ['beverage', 'cola', 'coffee', 'americano'].includes(f)) && [...features].every(f => beverageFeatures.includes(f)));
      if (!features.has('beverage')) {
        const proof = evidence.find(e => ['cola', 'coffee', 'americano'].includes(e.feature));
        features.add('beverage'); evidence.push({ ...proof, feature: 'beverage' });
      }
    }
    if (row.kind === 'non-food') valid(features.size === 1 && features.has('non-food'));
    return { id: row.id, kind: row.kind, features: [...features], evidence };
  };
  return output.products.map(row => {
    try { return validateRow(row); } catch (error) {
      if (!allowPartial) throw error;
      return { id: row.id, errorCode: 'PRODUCT_MAPPING_INVALID' };
    }
  });
}

export function supplementProductMapping(product, inferred) {
  const base = product.productMapping;
  if (inferred.kind === 'unknown') return base;
  assert(base.kind === 'unknown' || base.kind === inferred.kind, 'PRODUCT_MAPPING_CONFLICT', '商品分类与已有依据冲突，已保留待核实状态', 502);
  return { kind: inferred.kind, features: [...new Set([...base.features, ...inferred.features])], evidence: [...base.evidence, ...inferred.evidence] };
}
