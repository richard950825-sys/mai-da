/** Only meal-preference fields are carried forward; body/account information is never copied. */
const allowed = [
  'kcalTarget',
  'kcalMin',
  'kcalMax',
  'proteinMin',
  'sugarMax',
  'sodiumMax',
  'budget',
  'people',
  'goal',
  'avoid',
  'includeKeywords',
  'includeAnyKeywords',
  'unsweetenedDrink',
  'beverageOnlyAllowed',
  'preferCoupons',
  'preferCombo',
] as const;
export function buildMealPrompt(
  text: string,
  current: Record<string, unknown>,
  manual: Record<string, unknown> = {},
) {
  const pick = (source: Record<string, unknown>) =>
    Object.fromEntries(
      allowed
        .filter((k) => Object.prototype.hasOwnProperty.call(source, k))
        .map((k) => [k, source[k]]),
    );
  return `当前已确认的本餐偏好（不是历史原话；null 表示未设置，请保留未被新需求修改的项目）：${JSON.stringify(pick(current))}\n本次新的需求（用它修改当前偏好，输出修改后的完整偏好）：${text}\n${Object.keys(manual).length ? `用户在输入之后最终手动确认的界面设置（优先于上面的文本）：${JSON.stringify(pick(manual))}` : ''}`;
}

/** Keep explicit null clears in the serialized API request. */
export function buildManualControls(input: {
  mealTarget: number | null;
  budget: number | null;
  preferStructuredTarget: boolean;
  preferStructuredBudget: boolean;
  preferStructuredPreferences: boolean;
}) {
  return { ...input };
}
