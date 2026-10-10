export function describeMenu(menu, context) {
  const categories = [...new Set(menu.items.flatMap(item => item.categories || []))];
  const breakfast = categories.filter(c => /早餐|麦满分|炒双蛋堡|早安营养卷|粥王|厚松饼堡/.test(c));
  const regular = categories.filter(c => /牛鱼肉堡|厚牛堡|鸡肉汉堡|大堡口福|大卡套餐/.test(c));
  const period = breakfast.length && regular.length ? 'mixed' : breakfast.length ? 'breakfast' : regular.length ? 'regular' : 'unknown';
  const labels = { breakfast: '早餐菜单', regular: '常规餐菜单（午晚餐）', mixed: '混合菜单', unknown: '餐段未能确认' };
  return { storeCode: context.storeCode, requestedTime: context.reservationDate || null, period, label: labels[period], source: 'menu-categories', categoryEvidence: [...breakfast, ...regular], itemCount: menu.items.length, retrievedAt: menu.retrievedAt };
}

export function summarizeRequirements(constraints) {
  const labels = [`${constraints.people ?? 1} 人用餐`];
  labels.push(constraints.budget === null ? '预算不限' : `预算不超过 ${constraints.budget} 元`);
  if (constraints.kcalMin !== null || constraints.kcalMax !== null) labels.push(`热量${constraints.kcalMin === null ? '' : `至少 ${constraints.kcalMin}`}${constraints.kcalMin !== null && constraints.kcalMax !== null ? '、' : ''}${constraints.kcalMax === null ? '' : `不超过 ${constraints.kcalMax}`} kcal`);
  for (const [key, label, unit] of [['proteinMin', '蛋白质至少', 'g'], ['sugarMax', '糖不超过', 'g'], ['sodiumMax', '钠不超过', 'mg']]) if (constraints[key] != null) labels.push(`${label} ${constraints[key]} ${unit}`);
  if (constraints.goal !== 'balanced') labels.push('偏好：' + ({ 'high-protein': '高蛋白', 'low-calorie': '热量优先', 'low-sugar': '关注糖含量' })[constraints.goal]);
  if (constraints.beverageOnlyAllowed) labels.push('仅饮品');
  if (constraints.preferCoupons) labels.push('优先用券');
  const display = term => ({ 牛: '牛肉', 鸡: '鸡肉', 猪: '猪肉', 鱼: '鱼肉', 普通可乐: '普通可乐（有糖款）', 有糖可乐: '普通可乐（有糖款）' })[term] || term;
  if (constraints.includeKeywords.length) labels.push('想吃：' + constraints.includeKeywords.map(display).join('、'));
  if (constraints.includeAnyKeywords.length) labels.push('任选：' + constraints.includeAnyKeywords.map(display).join('、'));
  if (constraints.unsweetenedDrink) labels.push('饮品需有无糖标注');
  if (constraints.avoid.length) labels.push('排除：' + constraints.avoid.map(display).join('、'));
  if (constraints.preferCombo) labels.push('套餐优先');
  return labels;
}
