import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type Store, type StoreContext } from '../lib/api';
import { Icon } from './Icon';
import { Modal } from './Modal';
import {
  formatNutrient,
  roleLabels,
  type Food,
  type Plan,
  type NutritionValues,
} from './Recommendations';

type SelectedFood = Food & { couponId?: string; couponCode?: string };
type TakeWay = { code?: string; takeWayCode?: string; name?: string; takeWayName?: string };
type Quote = {
  id: string;
  currency: string;
  total: number;
  productTotal: number | null;
  deliveryFee: number | null;
  discount: number | null;
  tablewareFee: number | null;
  expiresAt: string;
  items: unknown[];
  takeWayList?: TakeWay[];
};
type Proposal = {
  id: string;
  quoteId: string;
  storeCode: string;
  service: string;
  reservationDate?: string | null;
  items: { productCode: string; name: string; quantity: number }[];
  destination?: { label?: string | null; addressId?: string };
  fulfillment?: { takeWayCode?: string; addressId?: string };
  confirmationNonce: string;
  total: number;
  currency: string;
  termsUrl?: string | null;
  cancellationDisclosure?: string | null;
  expiresAt: string;
};
type Review = {
  proposal: Proposal;
  executionEnabled: boolean;
  snapshot?: {
    selectionKey: string;
    storeName: string;
    storeAddress: string;
    takeWayLabel: string;
  };
};
const money = (value: number | null | undefined) =>
  typeof value === 'number' && Number.isFinite(value) ? `¥${value.toFixed(2)}` : '未知';

function readStoredOrder(orderStorageKey: string): {
  state?: string;
  paymentUrl?: string;
  orderId?: string;
  label?: string;
} {
  try {
    const value = JSON.parse(sessionStorage.getItem(orderStorageKey) || '{}');
    if (!['pending', 'completed'].includes(value.state)) return {};
    if (value.state === 'completed') {
      const url = new URL(value.paymentUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !['mcd.cn', 'mcdchina.net'].some(
          (h) => url.hostname === h || url.hostname.endsWith(`.${h}`),
        ) ||
        typeof value.orderId !== 'string' ||
        typeof value.label !== 'string'
      )
        return { state: 'pending' };
    }
    return value.state === 'pending' ? { state: 'pending' } : value;
  } catch {
    return {};
  }
}
function storeOrder(value: Record<string, string> | null, orderStorageKey: string) {
  try {
    if (value) sessionStorage.setItem(orderStorageKey, JSON.stringify(value));
    else sessionStorage.removeItem(orderStorageKey);
  } catch {
    /* Private browsing may disable tab storage; server confirmation remains single-use. */
  }
}

export function MealSummary({
  store,
  context,
  plan,
  target,
  budget = null,
  onEdit,
  connected,
  people = 1,
  onOrderLock,
  receiptScope,
}: {
  receiptScope?: string;
  store: Store | null;
  context: StoreContext | null;
  plan: Plan | null;
  target: number | null;
  budget?: number | null;
  onEdit: () => void;
  connected: boolean;
  people?: number;
  onOrderLock?: (locked: boolean) => void;
}) {
  const orderStorageKey = receiptScope ? `mcd-current-order:${receiptScope}` : 'mcd-current-order';
  const [storedOrder] = useState(() => readStoredOrder(orderStorageKey));
  const [foods, setFoods] = useState<SelectedFood[]>([]);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checkoutNotice, setCheckoutNotice] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState(storedOrder.paymentUrl || '');
  const [paymentLabel, setPaymentLabel] = useState(storedOrder.label || '');
  const [takeWayCode, setTakeWayCode] = useState('');
  const [orderUncertain, setOrderUncertain] = useState(storedOrder.state === 'pending');
  const [orderId, setOrderId] = useState(storedOrder.orderId || '');
  const summaryElement = useRef<HTMLElement>(null);
  const drinksIn = (food: SelectedFood) =>
    food.components?.reduce((n, c) => n + (c.role === 'drink' ? c.quantity : 0), 0) ??
    (food.role === 'drink' ? 1 : 0);
  const drinkCount = foods.reduce((n, f) => n + drinksIn(f) * f.quantity, 0);
  useEffect(() => {
    onOrderLock?.((busy && submitting.current) || orderUncertain || !!paymentUrl);
  }, [busy, orderUncertain, paymentUrl, onOrderLock]);
  const seq = useRef(0);
  const submitting = useRef(false);
  const selectionKey = JSON.stringify({
    planId: plan?.id,
    context,
    foods: foods.map((f) => ({
      id: f.id,
      quantity: f.quantity,
      couponId: f.couponId,
      roundList: f.roundList,
    })),
    quoteId: quote?.id,
    takeWayCode,
  });
  const latestSelection = useRef(selectionKey);
  latestSelection.current = selectionKey;
  const takeWays = (quote?.takeWayList || []).filter(
    (t) => typeof (t.code || t.takeWayCode) === 'string',
  );
  const nutrientTotal = (key: keyof NutritionValues) =>
    foods.every((f) => typeof f.nutrition?.[key] === 'number')
      ? foods.reduce((sum, f) => sum + (f.nutrition?.[key] ?? 0) * f.quantity, 0)
      : null;
  const hasFulfillment =
    context?.orderType === 2
      ? !!context.addressId
      : takeWays.some((t) => (t.code || t.takeWayCode) === takeWayCode);

  useEffect(() => {
    setFoods(plan?.foods.map((food) => ({ ...food })) ?? []);
    setQuote(null);
    setError('');
    if (!orderId && !orderUncertain) {
      setPaymentUrl('');
      setPaymentLabel('');
    }
    setTakeWayCode('');
    setReview(null);
  }, [plan, context]);
  useEffect(() => {
    const version = ++seq.current;
    setQuote(null);
    setReview(null);
    setAccepted(false);
    setTakeWayCode('');
    if (!foods.length || !context) {
      setBusy(false);
      return;
    }
    const controller = new AbortController();
    if (foods.some((f) => !f.productCode)) {
      setBusy(false);
      setError('此组合缺少可核价的商品编码，请重新查询餐厅菜单。');
      return;
    }
    setBusy(true);
    setError('');
    api<{ quote: Quote }>(
      '/quote',
      {
        storeContext: context,
        items: foods.map((f) => ({
          productCode: f.productCode,
          quantity: f.quantity,
          ...(f.roundList ? { roundList: f.roundList } : {}),
          ...(f.couponId ? { couponId: f.couponId } : {}),
          ...(f.couponCode ? { couponCode: f.couponCode } : {}),
        })),
      },
      controller.signal,
    )
      .then((r) => {
        if (seq.current === version) setQuote(r.quote);
      })
      .catch((e) => {
        if (e.name !== 'AbortError' && seq.current === version) setError(e.message);
      })
      .finally(() => {
        if (seq.current === version) setBusy(false);
      });
    return () => controller.abort();
  }, [foods, context]);

  function update(i: number, delta: number) {
    if (
      submitting.current ||
      orderUncertain ||
      paymentUrl ||
      (delta > 0 && drinkCount + drinksIn(foods[i]) > people)
    )
      return;
    setFoods((fs) =>
      fs
        .map((f, n) => (n === i ? { ...f, quantity: f.quantity + delta } : f))
        .filter((f) => f.quantity > 0),
    );
  }
  async function prepare() {
    if (!quote || !hasFulfillment || submitting.current || orderUncertain) return;
    setCheckoutNotice('');
    const requestKey = selectionKey;
    const snapshot = {
      selectionKey: requestKey,
      storeName: store?.name || store?.storeName || quote.id,
      storeAddress: store?.address || '',
      takeWayLabel:
        takeWays.find((t) => (t.code || t.takeWayCode) === takeWayCode)?.name || takeWayCode,
    };
    setBusy(true);
    setError('');
    setAccepted(false);
    try {
      const r = await api<Review>('/orders/prepare', {
        quoteId: quote.id,
        fulfillment: context?.orderType === 2 ? { addressId: context.addressId } : { takeWayCode },
      });
      if (
        latestSelection.current !== requestKey ||
        r.proposal.quoteId !== quote.id ||
        r.proposal.storeCode !== context?.storeCode
      )
        return;
      setReview({ ...r, snapshot });
    } catch (e) {
      if (latestSelection.current === requestKey) {
        setError((e as Error).message);
        if (e instanceof ApiError && e.code === 'QUOTE_EXPIRED')
          setFoods((current) => [...current]);
      }
    } finally {
      if (latestSelection.current === requestKey) setBusy(false);
    }
  }
  async function confirm() {
    if (!accepted || !review?.executionEnabled || !quote || submitting.current || orderUncertain)
      return;
    if (review.snapshot?.selectionKey !== latestSelection.current) {
      setReview(null);
      setAccepted(false);
      setError('餐品或门店已变化，请重新核价并确认。');
      return;
    }
    const submittedReview = review;
    submitting.current = true;
    setBusy(true);
    setError('');
    let submitted = false;
    try {
      const ownerStatus = await api<{ csrfToken?: string }>('/owner/setup/status');
      if (!ownerStatus.csrfToken) throw new Error('安全会话已过期，请刷新页面后重新核对订单。');
      if (submittedReview.snapshot?.selectionKey !== latestSelection.current)
        throw new Error('餐品或门店已变化，请重新确认。');
      submitted = true;
      storeOrder({ state: 'pending' }, orderStorageKey);
      const response = await fetch('/api/orders/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': ownerStatus.csrfToken },
        body: JSON.stringify({
          proposalId: review.proposal.id,
          confirmationNonce: review.proposal.confirmationNonce,
          confirmed: true,
          acceptedTerms: true,
          expectedTotal: review.proposal.total,
          currency: 'CNY',
          paymentMethod: 'provider-checkout',
        }),
      });
      const result = await response.json();
      if (!response.ok || result.error)
        throw new ApiError(
          result.error?.message || '订单结果未能确认，请到麦当劳查询订单状态。',
          result.error?.code || 'ORDER_OUTCOME_UNCERTAIN',
        );
      if (typeof result.orderId !== 'string' || !result.orderId)
        throw new ApiError('订单编号未能确认，请在麦当劳查看订单。', 'ORDER_OUTCOME_UNCERTAIN');
      const url = new URL(result.paymentUrl);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        !['mcd.cn', 'mcdchina.net'].some(
          (h) => url.hostname === h || url.hostname.endsWith(`.${h}`),
        )
      )
        throw new ApiError(
          '支付链接校验失败，请到麦当劳官方应用查看订单。',
          'ORDER_OUTCOME_UNCERTAIN',
        );
      setPaymentUrl(url.href);
      setOrderId(result.orderId);
      const label = `${submittedReview.snapshot?.storeName || submittedReview.proposal.storeCode} · ${submittedReview.proposal.items.map((i) => `${i.name} ×${i.quantity}`).join('、')}`;
      setPaymentLabel(label);
      storeOrder(
        { state: 'completed', orderId: result.orderId, paymentUrl: url.href, label },
        orderStorageKey,
      );
      setReview(null);
    } catch (e) {
      const code = e instanceof ApiError ? e.code : '';
      const uncertain =
        submitted &&
        (!code || ['ORDER_OUTCOME_UNCERTAIN', 'ORDER_RESPONSE_UNVERIFIED'].includes(code));
      if (uncertain) {
        setOrderUncertain(true);
        setReview(null);
        setError('');
      } else {
        storeOrder(null, orderStorageKey);
        setError((e as Error).message);
        if (
          [
            'QUOTE_EXPIRED',
            'PRICE_CHANGED',
            'CONFIRMATION_INVALID',
            'PICKUP_METHOD_CHANGED',
          ].includes(code)
        ) {
          setCheckoutNotice((e as Error).message);
          setReview(null);
          setQuote(null);
          if (
            code === 'QUOTE_EXPIRED' ||
            code === 'PRICE_CHANGED' ||
            code === 'PICKUP_METHOD_CHANGED'
          )
            setFoods((current) => [...current]);
        }
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <aside className="meal-summary" ref={summaryElement} tabIndex={-1}>
        <div className="summary-top">
          <h2>
            你的这一餐 <small>{people}人</small>
          </h2>
          {target && (
            <button className="summary-target" onClick={onEdit}>
              <Icon name="target" size={16} />
              {target} kcal <span>修改</span>
            </button>
          )}
        </div>
        {!plan || !foods.length ? (
          <>
            <div className="summary-empty">
              <Icon name="receipt" size={62} />
              <h3>还没选餐</h3>
              <p>选一份推荐搭配加入本餐。</p>
            </div>
          </>
        ) : (
          <>
            <div className="summary-store">
              <Icon name="store" size={17} />
              <span>{store?.name || store?.storeName || '已选择餐厅'}</span>
            </div>
            {context?.reservationDate && (
              <p className="micro">预约取餐时间：{context.reservationDate}（北京时间）</p>
            )}
            <div className="summary-foods">
              {foods.map((food, i) => (
                <div key={`${food.id}-${i}`} className="summary-food">
                  <div className="summary-food-info">
                    <strong>{food.name}</strong>
                    {food.components?.map((c, n) => (
                      <p className="micro" key={n}>
                        {roleLabels[c.role]} · {c.name} ×{c.quantity * food.quantity}
                      </p>
                    ))}
                  </div>
                  <div className="quantity">
                    <button
                      aria-label={`减少${food.name}`}
                      onClick={() => update(i, -1)}
                      disabled={busy || orderUncertain || !!paymentUrl}
                    >
                      <Icon name="minus" size={14} />
                    </button>
                    <span>{food.quantity}</span>
                    <button
                      aria-label={`增加${food.name}`}
                      title={
                        drinkCount + drinksIn(food) > people
                          ? `已达到 ${people} 人的饮品上限，请调整人数后重新规划`
                          : undefined
                      }
                      onClick={() => update(i, 1)}
                      disabled={
                        busy ||
                        orderUncertain ||
                        !!paymentUrl ||
                        food.quantity >= 10 ||
                        drinkCount + drinksIn(food) > people
                      }
                    >
                      <Icon name="plus" size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="nutrition-row summary-nutrition" aria-label="本餐营养合计">
              <span>
                本餐 <b>{formatNutrient(nutrientTotal('kcal'), '')}</b> kcal
              </span>
              <span>
                蛋白质 <b>{formatNutrient(nutrientTotal('proteinG'), 'g')}</b>
              </span>
              <span>
                糖 <b>{formatNutrient(nutrientTotal('sugarG'), 'g')}</b>
              </span>
            </div>
            <button className="text-button adjust-meal" onClick={onEdit}>
              调整搭配 <Icon name="arrow" size={15} />
            </button>
            {quote ? (
              <div className="price-summary">
                <div>
                  <span>商品金额</span>
                  <span>{money(quote.productTotal)}</span>
                </div>
                <div>
                  <span>配送费</span>
                  <span>{money(quote.deliveryFee)}</span>
                </div>
                {quote.tablewareFee != null && quote.tablewareFee > 0 && (
                  <div>
                    <span>餐具费</span>
                    <span>{money(quote.tablewareFee)}</span>
                  </div>
                )}
                <div>
                  <span>本次优惠</span>
                  <span>{quote.discount != null ? `−${money(quote.discount)}` : '未知'}</span>
                </div>
                <div className="total">
                  <span>实时合计</span>
                  <strong>{money(quote.total)}</strong>
                </div>
                <p className="micro">
                  价格有效至{' '}
                  {new Date(quote.expiresAt).toLocaleTimeString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                  ，提交前会重新核价
                </p>
              </div>
            ) : (
              <div className="price-pending">{busy ? '正在核对实时价格…' : '价格尚未确认'}</div>
            )}
            {quote && budget !== null && quote.total > budget && (
              <p className="error-note" role="status">
                当前金额超过本餐预算 ¥{budget.toFixed(2)}，请调整数量或预算后再核对。
              </p>
            )}
            {quote && context?.orderType === 1 && (
              <label>
                取餐方式
                <select
                  value={takeWayCode}
                  onChange={(e) => {
                    setTakeWayCode(e.target.value);
                    setReview(null);
                  }}
                  disabled={busy || orderUncertain}
                >
                  <option value="">请选择取餐方式</option>
                  {takeWays.map((t) => {
                    const code = t.code || t.takeWayCode || '';
                    return (
                      <option key={code} value={code}>
                        {t.name || t.takeWayName || code}
                      </option>
                    );
                  })}
                </select>
                {!takeWays.length && (
                  <p className="micro">暂无可用的取餐方式，请前往官方应用下单。</p>
                )}
              </label>
            )}
            <button
              className="button primary review-button"
              disabled={
                !quote ||
                !hasFulfillment ||
                busy ||
                orderUncertain ||
                !!paymentUrl ||
                (budget !== null && quote.total > budget)
              }
              onClick={() => void prepare()}
            >
              确认餐品与金额 <Icon name="arrow" size={17} />
            </button>
          </>
        )}
        {checkoutNotice && (
          <p className="error-note checkout-notice" role="status">
            {checkoutNotice}
          </p>
        )}
        {orderUncertain && (
          <div className="error-note" role="alert">
            <p>上次提交结果尚未确认，请先在麦当劳官方应用查看订单，勿重复提交。</p>
            <button
              className="text-button"
              onClick={() => {
                storeOrder(null, orderStorageKey);
                setOrderUncertain(false);
                setError('');
                setQuote(null);
                setFoods([]);
              }}
            >
              我已核查官方订单，开始新的搭配
            </button>
          </div>
        )}
        {error && (
          <div className="error-note" role="alert">
            {error}
          </div>
        )}
        {paymentUrl && (
          <div className="payment-ready">
            <h3>订单已创建，待支付</h3>
            <p>{paymentLabel}</p>
            <p className="micro">订单号：{orderId}</p>
            <a className="button primary" href={paymentUrl} target="_blank" rel="noreferrer">
              打开麦当劳支付页 <Icon name="link" size={17} />
            </a>
            <p className="micro">支付结果请在麦当劳官方页面查看。</p>
            <button
              className="text-button"
              onClick={() => {
                storeOrder(null, orderStorageKey);
                setPaymentUrl('');
                setPaymentLabel('');
                setOrderId('');
                setFoods([]);
              }}
            >
              开始新的搭配
            </button>
          </div>
        )}
        {!connected && (
          <div className="connection-note">
            <Icon name="info" size={19} />
            <div>
              <strong>尚未连接麦当劳服务</strong>
              <p>连接后可使用实时菜单与价格</p>
            </div>
          </div>
        )}
        {review && (
          <Modal
            title="确认这一餐"
            onClose={() => {
              if (!submitting.current) setReview(null);
            }}
          >
            <div className="checkout-review">
              <p>
                {review.snapshot?.storeName || review.proposal.storeCode} ·{' '}
                {review.proposal.storeCode}
              </p>
              {review.snapshot?.storeAddress && <p>{review.snapshot.storeAddress}</p>}
              {review.proposal.reservationDate && (
                <p>预约取餐时间：{review.proposal.reservationDate}（北京时间）</p>
              )}
              {review.proposal.items.map((f, i) => (
                <div className="checkout-item" key={i}>
                  <span>{f.name}</span>
                  <b>×{f.quantity}</b>
                </div>
              ))}
              <div className="checkout-total">
                <span>本次总额 · 人民币</span>
                <strong>{money(review.proposal.total)}</strong>
              </div>
              <p>
                服务方：麦当劳中国
                <br />
                方式：
                {review.proposal.service === 'delivery'
                  ? `麦乐送至：${review.proposal.destination?.label || review.proposal.destination?.addressId || '地址待核实'}`
                  : review.snapshot?.takeWayLabel || review.proposal.fulfillment?.takeWayCode}
                <br />
                付款：创建订单后，前往官方支付页面一次性支付
              </p>
              {review.proposal.cancellationDisclosure && (
                <p>{review.proposal.cancellationDisclosure}</p>
              )}
              {review.proposal.termsUrl && (
                <a href={review.proposal.termsUrl} target="_blank" rel="noreferrer">
                  查看适用服务条款
                </a>
              )}
              {review.executionEnabled ? (
                <>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={accepted}
                      onChange={(e) => setAccepted(e.target.checked)}
                      disabled={busy || orderUncertain}
                    />
                    <span>我已核对餐品、餐厅、取餐方式、总金额及适用条款，确认创建此订单</span>
                  </label>
                  <button
                    className="button primary full-width"
                    disabled={!accepted || busy || orderUncertain}
                    onClick={() => void confirm()}
                  >
                    {busy ? '正在提交，请勿重复操作…' : '确认创建订单，前往支付'}
                  </button>
                </>
              ) : (
                <div className="error-note">本站暂未开放下单，请前往麦当劳官方应用。</div>
              )}
              {error && (
                <p className="error-note" role="alert">
                  {error}
                </p>
              )}
            </div>
          </Modal>
        )}
      </aside>
      <div className="mobile-meal-bar">
        <div>
          <span>{people}人 · 你的这一餐</span>
          <strong>{quote ? money(quote.total) : foods.length ? '正在核价' : '尚未选择'}</strong>
        </div>
        <button
          className="button primary"
          onClick={() => {
            summaryElement.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            summaryElement.current?.focus({ preventScroll: true });
          }}
        >
          查看本餐 <Icon name="arrow" size={17} />
        </button>
      </div>
    </>
  );
}
