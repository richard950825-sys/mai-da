import { Icon } from './Icon';
export type NutritionValues = {
  kcal: number | null;
  proteinG: number | null;
  fatG: number | null;
  carbsG: number | null;
  sugarG: number | null;
  sodiumMg: number | null;
};
export type Food = {
  id: string;
  name: string;
  quantity: number;
  role?: 'main' | 'drink' | 'side' | 'dessert' | 'other' | 'combo';
  imageUrl?: string | null;
  components?: {
    code: string;
    name: string;
    quantity: number;
    role: 'main' | 'drink' | 'side' | 'dessert' | 'other';
    imageUrl?: string | null;
  }[];
  nutrition?: NutritionValues | null;
  productCode?: string;
  roundList?: { round: string; comboItemList: { code: string; quantity: number }[] }[];
};
export type Plan = {
  id: string;
  title: string;
  foods: Food[];
  nutrition: NutritionValues;
  price: number | null;
  priceStatus: string;
  score: number;
  people?: number;
  officialCombo?: boolean;
  reasons: string[];
  warnings: string[];
};
export function isPlan(value: unknown): value is Plan {
  if (!value || typeof value !== 'object') return false;
  const p = value as Plan;
  const validRole = (role: unknown) =>
    role === undefined ||
    (typeof role === 'string' &&
      ['main', 'drink', 'side', 'dessert', 'other', 'combo'].includes(role));
  const validImage = (url: unknown) =>
    url == null || (typeof url === 'string' && /^https:\/\//.test(url));
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  return (
    typeof p.id === 'string' &&
    typeof p.title === 'string' &&
    (p.price === null ||
      (typeof p.price === 'number' && Number.isFinite(p.price) && p.price >= 0)) &&
    Array.isArray(p.foods) &&
    p.foods.length > 0 &&
    p.foods.every(
      (f) =>
        f &&
        typeof f.id === 'string' &&
        typeof f.name === 'string' &&
        Number.isSafeInteger(f.quantity) &&
        f.quantity > 0 &&
        f.quantity <= 99 &&
        validRole(f.role) &&
        validImage(f.imageUrl) &&
        (f.components === undefined ||
          (Array.isArray(f.components) &&
            f.components.length > 0 &&
            f.components.every(
              (c) =>
                c &&
                typeof c.code === 'string' &&
                typeof c.name === 'string' &&
                Number.isSafeInteger(c.quantity) &&
                c.quantity > 0 &&
                c.quantity <= 99 &&
                ['main', 'drink', 'side', 'dessert', 'other'].includes(c.role) &&
                validImage(c.imageUrl),
            ))),
    ) &&
    (p.reasons === undefined || strings(p.reasons)) &&
    (p.warnings === undefined || strings(p.warnings))
  );
}
export function formatNutrient(value: number | null | undefined, unit: string) {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 10) / 10}${unit}`
    : '未知';
}
export const roleLabels: Record<string, string> = {
  main: '主食',
  drink: '饮品',
  side: '配餐',
  dessert: '甜品',
  other: '其他',
  combo: '套餐',
};
export function Recommendations({
  plans,
  retrievedAt,
  onChoose,
  selectedId,
}: {
  plans: Plan[];
  retrievedAt?: string;
  onChoose: (p: Plan) => void;
  selectedId?: string;
}) {
  return (
    <section className="recommendations">
      <div className="section-heading">
        <h2>推荐搭配</h2>
        <span className="small-muted">{plans.length} 个方案</span>
      </div>
      <div className="plan-list">
        {plans.map((plan, index) => (
          <article className={`plan ${selectedId === plan.id ? 'chosen' : ''}`} key={plan.id}>
            <div className="plan-head">
              <span className="plan-number">0{index + 1}</span>
              <h3>{plan.title || '本餐组合'}</h3>
              <span className="plan-price">
                {plan.price != null ? `¥${plan.price.toFixed(2)}` : '待核价'}
              </span>
            </div>
            <div className="plan-content">
              <div className="plan-photo">
                {plan.foods.find((f) => f.imageUrl)?.imageUrl ? (
                  <img
                    src={plan.foods.find((f) => f.imageUrl)!.imageUrl!}
                    alt=""
                    loading="lazy"
                    onError={(e) => {
                      e.currentTarget.hidden = true;
                    }}
                  />
                ) : (
                  <Icon name="receipt" size={44} />
                )}
              </div>
              <ul className="food-list">
                {plan.foods
                  .flatMap((f) =>
                    f.components?.length
                      ? f.components.map((c, i) => ({
                          ...c,
                          id: `${f.id}-${i}`,
                          quantity: c.quantity * f.quantity,
                        }))
                      : [f],
                  )
                  .map((f, i) => (
                    <li key={`${f.id}-${i}`}>
                      <span className="food-role">{roleLabels[f.role || 'other']}</span>
                      <span>{f.name}</span>
                      <small>×{f.quantity}</small>
                    </li>
                  ))}
              </ul>
            </div>
            <div className="nutrition-row">
              <span>
                <b>{formatNutrient(plan.nutrition?.kcal, '')}</b> kcal
              </span>
              <span>
                蛋白质 <b>{formatNutrient(plan.nutrition?.proteinG, 'g')}</b>
              </span>
              <span>
                糖 <b>{formatNutrient(plan.nutrition?.sugarG, 'g')}</b>
              </span>
            </div>
            {plan.reasons?.length > 0 && (
              <div className="plan-reasons">
                {plan.reasons.map((r, i) => (
                  <p key={i}>
                    <Icon name="check" size={14} />
                    {r}
                  </p>
                ))}
              </div>
            )}
            {plan.warnings?.length > 0 && (
              <details className="micro warnings">
                <summary>餐品说明</summary>
                {plan.warnings.map((w, i) => (
                  <p key={i}>{w}</p>
                ))}
              </details>
            )}
            <button
              className={`button ${selectedId === plan.id ? 'secondary' : 'primary'}`}
              onClick={() => onChoose(plan)}
            >
              {selectedId === plan.id ? '已加入本餐' : '选这份'}
              <Icon name={selectedId === plan.id ? 'check' : 'arrow'} size={17} />
            </button>
          </article>
        ))}
      </div>
      {retrievedAt && (
        <p className="provenance">
          更新于 {new Date(retrievedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
        </p>
      )}
    </section>
  );
}
