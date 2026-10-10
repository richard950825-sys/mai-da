import { useState } from 'react';
import {
  estimateMaintenance,
  allocateMealTarget,
  ACTIVITY_OPTIONS,
  type MaintenanceInput,
} from '../lib/calories';
import { Icon } from './Icon';
export function CaloriePlanner({
  onDone,
  onBack,
}: {
  onDone: (target: number | null) => void;
  onBack: () => void;
}) {
  const [input, setInput] = useState<MaintenanceInput>({
    sexParameter: 'unspecified',
    eligibilityConfirmed: false,
  });
  const [percent, setPercent] = useState(30);
  const [daily, setDaily] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [manual, setManual] = useState('');
  const set = (key: keyof MaintenanceInput, value: unknown) => {
    setInput((i) => ({ ...i, [key]: value }));
    setDaily(null);
    setError('');
  };
  function calculate(e: React.FormEvent) {
    e.preventDefault();
    const r = estimateMaintenance(input);
    if (!r.ok) {
      setError(r.issues.map((i) => i.message).join('；'));
      return;
    }
    setDaily(r.maintenanceKcal);
    setError('');
  }
  const target = daily ? allocateMealTarget(daily, percent) : null;
  return (
    <section className="calorie-screen">
      <button className="text-button back-button" onClick={onBack}>
        <Icon name="back" /> 返回
      </button>
      <h1>估算本餐热量</h1>
      <p className="lede">先估算每日所需热量，或直接填写本餐目标。</p>
      <div className="privacy-note">
        <Icon name="lock" size={16} /> 身体信息仅在本页计算，不会上传
      </div>
      <form onSubmit={calculate} className="calorie-form">
        <div className="form-grid three">
          <label>
            年龄
            <input
              required
              inputMode="numeric"
              type="number"
              min="18"
              max="120"
              placeholder="周岁"
              value={input.age ?? ''}
              onChange={(e) =>
                set('age', e.target.value === '' ? undefined : Number(e.target.value))
              }
            />
          </label>
          <label>
            身高 <span>cm</span>
            <input
              required
              inputMode="decimal"
              type="number"
              step="0.1"
              placeholder="厘米"
              value={input.heightCm ?? ''}
              onChange={(e) =>
                set('heightCm', e.target.value === '' ? undefined : Number(e.target.value))
              }
            />
          </label>
          <label>
            体重 <span>kg</span>
            <input
              required
              inputMode="decimal"
              type="number"
              step="0.1"
              placeholder="千克"
              value={input.weightKg ?? ''}
              onChange={(e) =>
                set('weightKg', e.target.value === '' ? undefined : Number(e.target.value))
              }
            />
          </label>
        </div>
        <div className="form-grid">
          <label>
            公式使用的性别参数
            <select
              aria-label="公式使用的性别参数"
              value={input.sexParameter}
              onChange={(e) => set('sexParameter', e.target.value)}
            >
              <option value="unspecified">请选择，或使用下方手动目标</option>
              <option value="female">女性参数</option>
              <option value="male">男性参数</option>
            </select>
          </label>
          <label>
            日常活动量
            <select
              aria-label="日常活动量"
              required
              value={input.activity ?? ''}
              onChange={(e) => set('activity', e.target.value)}
            >
              <option value="" disabled>
                选择接近的一项
              </option>
              {ACTIVITY_OPTIONS.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.label} · {a.description}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={input.eligibilityConfirmed ?? false}
            onChange={(e) => set('eligibilityConfirmed', e.target.checked)}
          />
          <span>我已满 18 岁，非孕期、哺乳期，无进食障碍或需要专业指导的临床饮食需求</span>
        </label>
        <p className="micro">不适用时请跳过估算，或填写专业人士提供的目标。</p>
        {error && (
          <div className="error-note" role="alert">
            {error}
          </div>
        )}
        {daily === null ? (
          <button className="button primary" type="submit">
            粗略估算 <Icon name="arrow" />
          </button>
        ) : (
          <div className="estimate-result">
            <div>
              <span>估算每日维持能量</span>
              <strong>
                {Math.round(daily).toLocaleString()}
                <small> kcal / 天</small>
              </strong>
            </div>
            <label>
              这一餐分配 <b>{percent}%</b>
              <input
                type="range"
                min="10"
                max="60"
                step="5"
                value={percent}
                onChange={(e) => setPercent(Number(e.target.value))}
              />
            </label>
            <div className="meal-target">
              <span>本餐参考目标</span>
              <strong>
                {target}
                <small> kcal</small>
              </strong>
            </div>
            <p className="micro">估算采用 Mifflin–St Jeor 公式，仅作参考，不是减重建议。</p>
            <button className="button primary" type="button" onClick={() => onDone(target)}>
              用这个目标继续 <Icon name="arrow" />
            </button>
          </div>
        )}
      </form>
      <div className="manual-target">
        <h3>已经有本餐目标？</h3>
        <div className="inline-form">
          <label className="sr-only" htmlFor="manual-kcal">
            直接输入本餐热量
          </label>
          <input
            id="manual-kcal"
            type="number"
            min="1"
            max="10000"
            step="1"
            inputMode="numeric"
            placeholder="本餐 kcal"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
          />
          <button
            className="button secondary"
            onClick={() => {
              const n = Number(manual);
              if (Number.isFinite(n) && n > 0 && n <= 10000) onDone(Math.round(n));
              else setError('请输入有效的本餐热量目标');
            }}
          >
            直接使用
          </button>
        </div>
      </div>
      <button className="text-button skip" onClick={() => onDone(null)}>
        跳过估算 <Icon name="arrow" size={16} />
      </button>
    </section>
  );
}
