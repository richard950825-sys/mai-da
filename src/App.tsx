import { useEffect, useRef, useState } from 'react';
import { Icon } from './components/Icon';
import { Modal } from './components/Modal';
import { CaloriePlanner } from './components/CaloriePlanner';
import { StorePicker } from './components/StorePicker';
import { MealSummary } from './components/MealSummary';
import { Recommendations, isPlan, type Plan } from './components/Recommendations';
import { OwnerSetup } from './components/OwnerSetup';
import { VerificationPanel } from './components/VerificationPanel';
import { buildMealPrompt, buildManualControls } from './lib/meal-context';
import {
  api,
  ApiError,
  type ServiceStatus,
  type Store,
  type StoreContext,
  type MenuContext,
  isMenuContext,
} from './lib/api';

function Brand() {
  return (
    <a href="/" className="brand" aria-label="麦搭首页">
      <span className="official-mark">
        <img src="/brand/mcdonalds-golden-arches.jpg" alt="麦当劳金色拱门" />
      </span>
      <span className="brand-wordmark">
        麦搭<small>非官方用餐助手</small>
      </span>
    </a>
  );
}
function Intro({ onChoose }: { onChoose: (calorie: boolean) => void }) {
  return (
    <main className="intro-layout">
      <section className="intro-content">
        <h1 aria-label="是否需要帮你规划本餐热量？">
          是否需要帮你
          <br className="intro-linebreak" />
          规划本餐热量？
        </h1>
        <div className="intro-choices">
          <button className="intro-choice highlighted" onClick={() => onChoose(true)}>
            <span>
              <strong>需要，帮我估算</strong>
            </span>
            <span className="circle-arrow">
              <Icon name="arrow" size={24} />
            </span>
          </button>
          <button className="intro-choice" onClick={() => onChoose(false)}>
            <span>
              <strong>不用，直接开始</strong>
            </span>
            <span className="circle-arrow">
              <Icon name="arrow" size={24} />
            </span>
          </button>
        </div>
        <p className="intro-legal">非麦当劳官方产品 · 营养估算仅作参考</p>
      </section>
      <aside className="intro-art" aria-hidden="true">
        <img className="intro-food-image" src="/brand/big-mac.png" alt="" />
      </aside>
    </main>
  );
}
export default function App() {
  const [screen, setScreen] = useState<'intro' | 'calories' | 'planner'>('intro');
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [modal, setModal] = useState<'connections' | 'target' | 'budget' | 'taste' | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const [structuredTarget, setStructuredTarget] = useState(false);
  const [targetInput, setTargetInput] = useState('');
  const [budget, setBudget] = useState<number | null>(null);
  const [budgetInput, setBudgetInput] = useState('');
  const [people, setPeople] = useState(1);
  const [structuredPeople, setStructuredPeople] = useState(false);
  const [orderLocked, setOrderLocked] = useState(false);
  const [goal, setGoal] = useState('balanced');
  const [goalExplicit, setGoalExplicit] = useState(false);
  const [resolved, setResolved] = useState<Record<string, unknown>>({});
  const [structuredBudget, setStructuredBudget] = useState(false);
  const [avoid, setAvoid] = useState('');
  const [draftGoal, setDraftGoal] = useState('balanced');
  const [draftAvoid, setDraftAvoid] = useState('');
  const [store, setStore] = useState<Store | null>(null);
  const [context, setContext] = useState<StoreContext | null>(null);
  const [text, setText] = useState('');
  const [sentText, setSentText] = useState('');
  const [aiConsent, setAiConsent] = useState(false);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selected, setSelected] = useState<Plan | null>(null);
  const [retrievedAt, setRetrievedAt] = useState('');
  const [menuInfo, setMenuInfo] = useState<MenuContext | null>(null);
  const [menuLoading, setMenuLoading] = useState(false);
  const [menuError, setMenuError] = useState('');
  const [requirementSummary, setRequirementSummary] = useState<string[]>([]);
  const [catalogNotice, setCatalogNotice] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  async function refreshStatus() {
    setStatusError('');
    try {
      setStatus(await api<ServiceStatus>('/status'));
    } catch (e) {
      setStatusError((e as Error).message);
    }
  }
  useEffect(() => {
    void refreshStatus();
    const expired = () => {
      clearStore();
      setStatus((s) =>
        s?.accessMode === 'visitor' ? { ...s, mcd: { configured: false, connected: false } } : s,
      );
    };
    window.addEventListener('mcd-session-expired', expired);
    return () => window.removeEventListener('mcd-session-expired', expired);
  }, []);
  const connected = status?.mcd?.connected === true;
  const configured = status?.mcd?.configured === true;
  const calorieLabel =
    target !== null
      ? `${target} kcal`
      : typeof resolved.kcalMin === 'number' && typeof resolved.kcalMax === 'number'
        ? `${resolved.kcalMin}–${resolved.kcalMax} kcal`
        : typeof resolved.kcalMin === 'number'
          ? `≥${resolved.kcalMin} kcal`
          : typeof resolved.kcalMax === 'number'
            ? `≤${resolved.kcalMax} kcal`
            : '本餐热量';
  const goalText =
    goal === 'balanced'
      ? '均衡搭配'
      : goal === 'high-protein'
        ? '高蛋白'
        : goal === 'low-calorie'
          ? '热量优先'
          : '关注糖含量';
  function invalidate() {
    request.current++;
    setError('');
    setWarnings([]);
    setCatalogNotice('');
    setMenuLoading(false);
    setRequirementSummary([]);
    setBusy(false);
    setPlans([]);
    setSelected(null);
  }
  function changeTarget(n: number | null) {
    invalidate();
    setTarget(n);
    setStructuredTarget(true);
    setResolved((r) => ({ ...r, kcalTarget: n, kcalMin: null, kcalMax: null }));
    setSelected(null);
    setPlans([]);
    setScreen('planner');
    setModal(null);
  }
  function clearStore() {
    request.current++;
    setError('');
    setWarnings([]);
    setCatalogNotice('');
    setMenuLoading(false);
    setRequirementSummary([]);
    setStore(null);
    setMenuInfo(null);
    setMenuError('');
    setContext(null);
    setPlans([]);
    setSelected(null);
    setBusy(false);
  }
  function chooseStore(s: Store, c: StoreContext) {
    const version = ++request.current;
    setWarnings([]);
    setCatalogNotice('');
    setRequirementSummary([]);
    setMenuInfo(null);
    setMenuError('');
    setMenuLoading(true);
    setStore(s);
    setContext(c);
    setPlans([]);
    setSelected(null);
    setError('');
    setBusy(false);
    void api<{ menuContext: MenuContext }>('/menu/overview', { storeContext: c })
      .then((r) => {
        if (version !== request.current) return;
        if (!isMenuContext(r.menuContext) || r.menuContext.storeCode !== c.storeCode)
          throw new Error('餐厅菜单信息不完整，请重新查询。');
        setMenuInfo(r.menuContext);
        void refreshStatus();
      })
      .catch((e) => {
        if (version === request.current) setMenuError((e as Error).message);
      })
      .finally(() => {
        if (version === request.current) setMenuLoading(false);
      });
  }
  async function generate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = text.trim();
    if (!trimmed) {
      setError('请输入想吃的餐品、口味或预算。');
      textarea.current?.focus();
      return;
    }
    const nextTarget = target;
    if (!context) {
      setError('先在下方选一家餐厅。');
      document
        .querySelector('.store-section')
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (!aiConsent) {
      setError('请先勾选下方的 AI 使用同意项。');
      return;
    }
    const version = ++request.current;
    setBusy(true);
    setError('');
    setPlans([]);
    setSelected(null);
    setWarnings([]);
    setCatalogNotice('');
    setMenuLoading(false);
    setRequirementSummary([]);
    try {
      const r = await api<{
        recommendations: Plan[];
        requestId?: string;
        noMatch?: { code: string; message: string } | null;
        menuContext?: MenuContext;
        requirementSummary?: string[];
        catalogSync?: { notice: string };
        warnings?: string[];
        retrievedAt?: string;
        constraints?: {
          kcalTarget?: number | null;
          budget?: number | null;
          goal?: string;
          avoid?: string[];
          [key: string]: unknown;
        };
      }>('/recommendations', {
        text: buildMealPrompt(
          trimmed,
          {
            ...resolved,
            people,
            kcalTarget: target,
            budget,
            ...(goalExplicit ? { goal, avoid: avoid.split(/[，,、]/).filter(Boolean) } : {}),
          },
          {
            ...(structuredPeople ? { people } : {}),
            ...(structuredTarget ? { kcalTarget: target, kcalMin: null, kcalMax: null } : {}),
            ...(structuredBudget ? { budget } : {}),
            ...(goalExplicit ? { goal, avoid: avoid.split(/[，,、]/).filter(Boolean) } : {}),
          },
        ),
        ...buildManualControls({
          mealTarget: nextTarget,
          budget,
          preferStructuredTarget: structuredTarget,
          preferStructuredBudget: structuredBudget,
          preferStructuredPreferences: goalExplicit,
        }),
        preferStructuredPeople: structuredPeople,
        preferences: {
          people,
          ...(goalExplicit ? { goal } : {}),
          ...(goalExplicit
            ? {
                avoid: avoid
                  .split(/[，,、]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              }
            : {}),
        },
        storeContext: context,
        aiConsent: true,
      });
      if (version !== request.current) return;
      if (
        !Array.isArray(r.recommendations) ||
        !r.recommendations.every(isPlan) ||
        (r.menuContext !== undefined &&
          (!isMenuContext(r.menuContext) || r.menuContext.storeCode !== context.storeCode)) ||
        (r.requirementSummary !== undefined &&
          (!Array.isArray(r.requirementSummary) ||
            !r.requirementSummary.every((s) => typeof s === 'string'))) ||
        (r.noMatch != null &&
          (typeof r.noMatch.code !== 'string' || typeof r.noMatch.message !== 'string')) ||
        (r.catalogSync !== undefined &&
          (!r.catalogSync || typeof r.catalogSync.notice !== 'string')) ||
        (r.warnings !== undefined &&
          (!Array.isArray(r.warnings) || !r.warnings.every((w) => typeof w === 'string'))) ||
        (r.constraints != null &&
          (typeof r.constraints !== 'object' ||
            Array.isArray(r.constraints) ||
            (r.constraints.avoid !== undefined &&
              (!Array.isArray(r.constraints.avoid) ||
                !r.constraints.avoid.every((v) => typeof v === 'string')))))
      )
        throw new ApiError(
          '服务返回的方案数据不完整，请重试。',
          'INVALID_RECOMMENDATIONS',
          undefined,
          r.requestId,
        );
      setPlans(r.recommendations);
      setRequirementSummary(r.requirementSummary || []);
      if (r.menuContext) {
        setMenuInfo(r.menuContext);
        setMenuError('');
      }
      setCatalogNotice(r.catalogSync?.notice || '');
      if (r.constraints) {
        setResolved(r.constraints);
        if (typeof r.constraints.people === 'number') setPeople(r.constraints.people);
        if (r.constraints.kcalTarget !== undefined) setTarget(r.constraints.kcalTarget);
        if (r.constraints.budget !== undefined) setBudget(r.constraints.budget);
        if (r.constraints.goal) setGoal(r.constraints.goal);
        if (r.constraints.avoid) setAvoid(r.constraints.avoid.join('，'));
      }
      setStructuredPeople(false);
      setStructuredTarget(false);
      setStructuredBudget(false);
      setGoalExplicit(false);
      setWarnings(r.warnings ?? []);
      setRetrievedAt(r.retrievedAt ?? '');
      setSentText(trimmed);
      if (!r.recommendations.length)
        setError(
          `${r.noMatch?.message || '没有合适的搭配，试试调整预算或口味。'}${r.requestId ? `（请求编号：${r.requestId}）` : ''}`,
        );
    } catch (e) {
      if (version === request.current) setError((e as Error).message);
    } finally {
      if (version === request.current) {
        setBusy(false);
        void refreshStatus();
      }
    }
  }
  if (location.pathname === '/owner/setup') return <OwnerSetup />;
  if (status?.accessMode === 'visitor' && !configured)
    return (
      <OwnerSetup
        onConnected={() => {
          setScreen('intro');
          void refreshStatus();
        }}
      />
    );
  if (!status && !statusError)
    return (
      <main className="owner-setup" role="status">
        正在加载…
      </main>
    );
  if (!status && statusError)
    return (
      <main className="owner-setup">
        <p role="alert">{statusError}</p>
        <button className="button primary" onClick={() => void refreshStatus()}>
          重试
        </button>
      </main>
    );
  if (location.pathname === '/verify') return <VerificationPanel />;
  return (
    <div className="app">
      <header className="app-header">
        <Brand />
        <div className="header-actions">
          {screen === 'planner' && (
            <button
              className="text-button restart-button"
              disabled={orderLocked}
              onClick={() => window.location.reload()}
            >
              重新开始
            </button>
          )}
          <button
            className="connection-button"
            onClick={() => {
              setModal('connections');
              void refreshStatus();
            }}
          >
            数据连接
          </button>
          <span className={`connection-state ${connected ? 'live' : ''}`}>
            <i />
            {connected ? '已连接' : configured ? '待验证' : '待连接'}
          </span>
        </div>
      </header>
      {screen === 'intro' ? (
        <Intro onChoose={(yes) => setScreen(yes ? 'calories' : 'planner')} />
      ) : screen === 'calories' ? (
        <div className="calorie-layout">
          <CaloriePlanner onDone={changeTarget} onBack={() => setScreen('intro')} />
          <aside className="calorie-aside">
            <span className="large-number">约</span>
            <h2>
              热量作参考，
              <br />
              吃什么你来定。
            </h2>
          </aside>
        </div>
      ) : (
        <main className="workspace">
          <section className="planner-main" inert={orderLocked}>
            <div className="planner-heading">
              <h1>这一餐，想怎么吃？</h1>
            </div>
            <div className="people-control">
              <span>用餐人数</span>
              <div role="group" aria-label="用餐人数">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    aria-pressed={people === n}
                    onClick={() => {
                      invalidate();
                      setPeople(n);
                      setStructuredPeople(true);
                      setResolved((r) => ({ ...r, people: n }));
                    }}
                  >
                    {n}人
                  </button>
                ))}
              </div>
            </div>
            <p className="people-hint">预算和热量按整餐计算</p>
            <form className="composer" onSubmit={generate}>
              <label className="sr-only" htmlFor="meal-request">
                描述你的本餐需求
              </label>
              <textarea
                ref={textarea}
                id="meal-request"
                placeholder="例如：不超过60元，牛肉，无糖可乐，套餐优先"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setStructuredPeople(false);
                  setStructuredTarget(false);
                  setStructuredBudget(false);
                  setGoalExplicit(false);
                }}
                rows={4}
                maxLength={1600}
              />
              <div className="composer-toolbar">
                <div className="composer-options">
                  <button
                    type="button"
                    className={`chip ${budget ? 'set' : ''}`}
                    onClick={() => {
                      setBudgetInput(budget?.toString() ?? '');
                      setModal('budget');
                    }}
                  >
                    <Icon name="tag" size={16} />
                    {budget ? `¥${budget} 内` : '预算'}
                  </button>
                  <button
                    type="button"
                    className={`chip ${goal !== 'balanced' || avoid ? 'set' : ''}`}
                    onClick={() => {
                      setDraftGoal(goal);
                      setDraftAvoid(avoid);
                      setModal('taste');
                    }}
                  >
                    <Icon name="taste" size={16} />
                    {goal !== 'balanced' ? goalText : '口味'}
                  </button>
                  <button
                    type="button"
                    className={`chip ${calorieLabel !== '本餐热量' ? 'set' : ''}`}
                    onClick={() => {
                      setTargetInput(target?.toString() ?? '');
                      setModal('target');
                    }}
                  >
                    <Icon name="target" size={16} />
                    {calorieLabel}
                  </button>
                </div>
                <button
                  className="submit-request"
                  type="submit"
                  disabled={busy}
                  aria-label={busy ? '正在规划' : '开始规划'}
                >
                  {busy ? (
                    <span className="spinner" />
                  ) : (
                    <>
                      开始规划 <Icon name="arrow" size={18} />
                    </>
                  )}
                </button>
              </div>
              <label className="check-row consent-row">
                <input
                  type="checkbox"
                  checked={aiConsent}
                  onChange={(e) => setAiConsent(e.target.checked)}
                />
                <span>同意由 DeepSeek 处理用餐需求和公开餐品资料。请勿填写个人隐私。</span>
              </label>
            </form>
            {status?.aiQuota && (
              <p className="micro" role="status">
                今日 AI 剩余 {status.aiQuota.remaining} / {status.aiQuota.limit} 次 · 同一 IP
                共用，北京时间零点重置
              </p>
            )}
            {requirementSummary.length > 0 && (
              <div className="requirement-summary" aria-label="已理解的本餐需求">
                <strong>本餐需求</strong>
                <ul>
                  {requirementSummary.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && (
              <div className="error-note" role="alert">
                <Icon name="info" size={18} />
                <span>{error}</span>
              </div>
            )}
            <StorePicker
              store={store}
              context={context}
              menuInfo={menuInfo}
              menuLoading={menuLoading}
              menuError={menuError}
              onSelect={chooseStore}
              onClear={clearStore}
            />
            {busy && (
              <div className="planning-loader" role="status">
                <span className="spinner" />
                <div>
                  <strong>正在搭配，稍等一下…</strong>
                  <p>正在查询菜单和价格</p>
                </div>
              </div>
            )}
            {catalogNotice && (
              <p className="micro catalog-notice" role="status">
                {catalogNotice}
              </p>
            )}
            {plans.length > 0 && (
              <>
                <div className="conversation-note">
                  <Icon name="taste" size={17} />
                  <span>{sentText}</span>
                  <button
                    className="text-button"
                    onClick={() => {
                      textarea.current?.focus();
                      textarea.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }}
                  >
                    继续调整
                  </button>
                </div>
                <Recommendations
                  plans={plans}
                  retrievedAt={retrievedAt}
                  onChoose={(plan) => setSelected({ ...plan })}
                  selectedId={selected?.id}
                />
              </>
            )}
            {warnings.length > 0 && (
              <div className="service-warnings">
                {warnings.map((w, i) => (
                  <p key={i}>
                    <Icon name="info" size={14} />
                    {w}
                  </p>
                ))}
              </div>
            )}
            <footer className="planner-footer">
              <span>非麦当劳官方产品</span>
              <span>营养数据按常见单品匹配，定制餐品可能有差异</span>
            </footer>
          </section>
          <MealSummary
            key={status?.receiptScope || 'private'}
            receiptScope={status?.receiptScope}
            store={store}
            context={context}
            plan={selected}
            target={target}
            budget={budget}
            connected={connected}
            people={people}
            onOrderLock={setOrderLocked}
            onEdit={() => {
              textarea.current?.focus();
              textarea.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }}
          />
        </main>
      )}
      {modal === 'connections' && (
        <Modal title="数据连接" onClose={() => setModal(null)}>
          <div className="connection-service">
            <div className="official-mark">
              <img src="/brand/mcdonalds-golden-arches.jpg" alt="麦当劳" />
            </div>
            <div>
              <h3>麦当劳中国 MCP</h3>
              <p>餐厅、菜单、营养、优惠与实时价格</p>
            </div>
            <span className={`status-label ${connected ? 'good' : ''}`}>
              {connected ? '已连接' : configured ? '已配置，待验证' : '未配置'}
            </span>
          </div>
          <div className="connection-service">
            <div className="service-logo deepseek">D</div>
            <div>
              <h3>DeepSeek</h3>
              <p>AI 用餐规划</p>
            </div>
            <span className="status-label">
              {status?.deepseek?.configured ? '已配置' : '未配置'}
            </span>
          </div>
          <div className="privacy-note">
            <Icon name="lock" size={17} /> AI 服务由本站提供，无需填写密钥
          </div>
          {statusError && (
            <p className="error-note" role="alert">
              {statusError}
            </p>
          )}
          {status?.accessMode === 'visitor' && (
            <a
              className="button secondary full-width"
              href="/owner/setup"
              aria-disabled={orderLocked}
              onClick={(e) => {
                if (orderLocked) e.preventDefault();
              }}
            >
              更换麦当劳账户
            </a>
          )}
          <button className="button secondary full-width" onClick={() => void refreshStatus()}>
            <Icon name="refresh" size={16} /> 刷新连接状态
          </button>
        </Modal>
      )}
      {modal === 'target' && (
        <Modal title="本餐热量目标" onClose={() => setModal(null)}>
          <label>
            本餐目标 <span>kcal</span>
            <input
              autoFocus
              inputMode="numeric"
              type="number"
              min="1"
              max="10000"
              value={targetInput}
              placeholder="例如：650"
              onChange={(e) => setTargetInput(e.target.value)}
            />
          </label>
          <p className="micro">按目标上下 10% 匹配餐品，仅作参考。</p>
          <button
            className="button primary full-width"
            disabled={!targetInput || Number(targetInput) <= 0 || Number(targetInput) > 10000}
            onClick={() => changeTarget(Math.round(Number(targetInput)))}
          >
            保存目标 <Icon name="check" size={16} />
          </button>
          <div className="modal-bottom">
            <button className="text-button" onClick={() => changeTarget(null)}>
              不限制本餐热量
            </button>
            <button
              className="text-button"
              onClick={() => {
                setScreen('calories');
                setModal(null);
              }}
            >
              帮我粗略估算 <Icon name="arrow" size={15} />
            </button>
          </div>
        </Modal>
      )}
      {modal === 'budget' && (
        <Modal title="这一餐的预算" onClose={() => setModal(null)}>
          <p className="modal-lede">按实时核价筛选，配送费也计入总额。</p>
          <label>
            最高预算 <span>人民币 / 元</span>
            <input
              autoFocus
              inputMode="decimal"
              type="number"
              min="0.01"
              max="10000"
              step="0.01"
              value={budgetInput}
              placeholder="例如：35"
              onChange={(e) => setBudgetInput(e.target.value)}
            />
          </label>
          <button
            className="button primary full-width"
            disabled={
              !budgetInput ||
              !Number.isFinite(Number(budgetInput)) ||
              Number(budgetInput) <= 0 ||
              Number(budgetInput) > 10000
            }
            onClick={() => {
              invalidate();
              setStructuredBudget(true);
              setBudget(Number(budgetInput));
              setResolved((r) => ({ ...r, budget: Number(budgetInput) }));
              setModal(null);
            }}
          >
            保存预算
          </button>
          <button
            className="text-button modal-bottom"
            onClick={() => {
              invalidate();
              setStructuredBudget(true);
              setBudget(null);
              setResolved((r) => ({ ...r, budget: null }));
              setModal(null);
            }}
          >
            暂不限制预算
          </button>
        </Modal>
      )}
      {modal === 'taste' && (
        <Modal title="口味与营养偏好" onClose={() => setModal(null)}>
          <label>
            搭配方向
            <select value={draftGoal} onChange={(e) => setDraftGoal(e.target.value)}>
              <option value="balanced">均衡搭配</option>
              <option value="high-protein">优先蛋白质</option>
              <option value="low-calorie">优先较低热量</option>
              <option value="low-sugar">关注糖含量</option>
            </select>
          </label>
          <label>
            不想吃的食材或单品
            <input
              value={draftAvoid}
              onChange={(e) => setDraftAvoid(e.target.value)}
              placeholder="用逗号分隔，例如：牛肉，咖啡"
            />
          </label>
          <p className="micro">有食物过敏？请核对官方信息并联系餐厅，筛选结果不能保证无过敏原。</p>
          <button
            className="button primary full-width"
            onClick={() => {
              invalidate();
              setGoal(draftGoal);
              setGoalExplicit(true);
              setAvoid(draftAvoid);
              setResolved((r) => ({
                ...r,
                goal: draftGoal,
                avoid: draftAvoid
                  .split(/[，,、]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              }));
              setModal(null);
            }}
          >
            保存偏好
          </button>
        </Modal>
      )}
    </div>
  );
}
