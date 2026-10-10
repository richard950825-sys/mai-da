import { useRef, useState } from 'react';
import { api, type Store, type StoreContext, type MenuContext } from '../lib/api';
import { reservationSlots, validSlotTime, chinaTime } from '../lib/meal-times';
import { Icon } from './Icon';
type Address = { id: string; addressId?: string; label: string };
export function StorePicker({
  store,
  context,
  menuInfo,
  menuLoading,
  menuError,
  onSelect,
  onClear,
}: {
  store: Store | null;
  context?: StoreContext | null;
  menuInfo?: MenuContext | null;
  menuLoading?: boolean;
  menuError?: string;
  onSelect: (s: Store, c: StoreContext) => void;
  onClear: () => void;
}) {
  const [mode, setMode] = useState<'pickup' | 'delivery'>('pickup');
  const [city, setCity] = useState('');
  const [query, setQuery] = useState('');
  const [stores, setStores] = useState<Store[]>([]);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [addressId, setAddressId] = useState('');
  const [selected, setSelected] = useState<Store | null>(null);
  const [reserve, setReserve] = useState(false);
  const [reserveDay, setReserveDay] = useState('');
  const [reserveTime, setReserveTime] = useState('');
  const [timePeriod, setTimePeriod] = useState<'breakfast' | 'regular' | null>(null);
  const [timeSlotKey, setTimeSlotKey] = useState('');
  const [chosenTime, setChosenTime] = useState('');
  const [timeError, setTimeError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const serial = useRef(0);
  const reservationOptions = selected?.reservationTimeOptions || [];
  const canReserve = selected?.reservation === true && reservationOptions.length > 0;
  const validReservation =
    canReserve &&
    reservationOptions.some((o) => o.date === reserveDay) &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(reserveTime);
  const canConfirm = reserve ? validReservation : selected?.businessStatus !== false;
  const slots = reservationSlots(store?.reservationTimeOptions || []);
  const chosenSlot = slots.find((slot) => slot.key === timeSlotKey && slot.period === timePeriod);
  function choosePeriod(period: 'breakfast' | 'regular') {
    const first = slots.find((slot) => slot.period === period);
    setTimePeriod(period);
    setTimeError('');
    setTimeSlotKey(first?.key || '');
    setChosenTime(first && chinaTime(first.date, first.start) > Date.now() ? first.start : '');
  }
  function useTime(reservationDate?: string) {
    if (!store || !context) return;
    const { reservationDate: previous, ...base } = context;
    onSelect(store, { ...base, ...(reservationDate ? { reservationDate } : {}) });
    setTimePeriod(null);
    setTimeError('');
  }
  function changeMode(m: 'pickup' | 'delivery') {
    serial.current++;
    setMode(m);
    setStores([]);
    setSelected(null);
    setError('');
    setSearched(false);
    setBusy(false);
    onClear();
  }
  async function search() {
    const version = ++serial.current;
    setBusy(true);
    setError('');
    setSelected(null);
    setStores([]);
    setSearched(false);
    try {
      const r = await api<{ stores: Store[] }>('/stores/search', {
        mode,
        city,
        query,
        ...(mode === 'delivery' ? { addressId } : {}),
      });
      if (version === serial.current) {
        setStores(r.stores);
        setSearched(true);
      }
    } catch (e) {
      if (version === serial.current) setError((e as Error).message);
    } finally {
      if (version === serial.current) setBusy(false);
    }
  }
  async function loadAddresses() {
    const version = ++serial.current;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ addresses: Address[] }>('/addresses');
      if (version !== serial.current) return;
      setAddresses(r.addresses);
      if (!r.addresses.length) setError('账户暂未返回可用的配送地址，请先在麦当劳官方应用中添加。');
    } catch (e) {
      if (version === serial.current) setError((e as Error).message);
    } finally {
      if (version === serial.current) setBusy(false);
    }
  }
  if (store)
    return (
      <section className="store-section">
        <div className="section-heading">
          <h2>取餐餐厅</h2>
          <button
            className="text-button"
            onClick={() => {
              onClear();
              setSelected(null);
              setStores([]);
            }}
          >
            更换
          </button>
        </div>
        <div className="confirmed-store">
          <div className="store-icon">
            <Icon name={mode === 'delivery' ? 'bike' : 'store'} size={24} />
          </div>
          <div>
            <h3>{store.name || store.storeName || store.storeCode}</h3>
            <p>{store.address || '地址暂缺'}</p>
            <span>{mode === 'delivery' ? '麦乐送' : '到店取餐'} · 已选择</span>
            {context?.reservationDate && <p>查询取餐时间：{context.reservationDate}（北京时间）</p>}
          </div>
          <Icon name="check" />
        </div>
        <div className="meal-context-panel" aria-label="餐厅与供餐情况">
          <p>
            即时点餐：
            {store.businessStatus === false
              ? '当前不可用'
              : store.businessStatus === true
                ? '营业中'
                : '状态待查询'}
            {store.businessStartTime &&
              store.businessEndTime &&
              ` · 营业时段 ${store.businessStartTime}–${store.businessEndTime}`}
          </p>
          <p>
            查询时间：
            {context?.reservationDate ? `${context.reservationDate}（北京时间）` : '现在'}
          </p>
          {menuLoading ? (
            <p role="status">正在读取这家餐厅的菜单…</p>
          ) : menuInfo ? (
            <>
              <p className="menu-period-label">
                <strong>{menuInfo.label}</strong> · {menuInfo.itemCount} 款餐品
              </p>
              {menuInfo.period === 'breakfast' && (
                <p className="micro">当前为早餐菜单，想选其他餐品可切换常规餐时段。</p>
              )}
            </>
          ) : (
            <p className="micro">尚未确认这个时间的菜单。</p>
          )}
          {menuError && (
            <p className="error-note" role="alert">
              {menuError}
            </p>
          )}
          <div className="meal-time-actions" role="group" aria-label="切换供餐时间">
            <button
              className="button secondary"
              disabled={store.businessStatus === false}
              onClick={() => useTime()}
            >
              查询即时菜单
            </button>
            <button
              className="button secondary"
              disabled={store.reservation !== true}
              onClick={() => choosePeriod('breakfast')}
            >
              选择早餐时段
            </button>
            <button
              className="button secondary"
              disabled={store.reservation !== true}
              onClick={() => choosePeriod('regular')}
            >
              选择常规餐时段
            </button>
          </div>
          {store.reservation !== true && <p className="micro">这家餐厅暂不支持预约。</p>}
          {timePeriod && (
            <div className="meal-time-editor">
              <label>
                餐厅提供的{timePeriod === 'breakfast' ? '早餐' : '常规餐'}时段
                <select
                  aria-label="餐厅供餐时段"
                  value={timeSlotKey}
                  onChange={(e) => {
                    setTimeSlotKey(e.target.value);
                    setTimeError('');
                    const slot = slots.find((s) => s.key === e.target.value);
                    setChosenTime(
                      slot && chinaTime(slot.date, slot.start) > Date.now() ? slot.start : '',
                    );
                  }}
                >
                  <option value="">请选择时段</option>
                  {slots
                    .filter((slot) => slot.period === timePeriod)
                    .map((slot) => (
                      <option key={slot.key} value={slot.key}>
                        {slot.date} · {slot.label} {slot.start}–{slot.end}
                      </option>
                    ))}
                </select>
              </label>
              {!slots.some((slot) => slot.period === timePeriod) && (
                <p className="micro">没有可选时段，试试更换餐厅。</p>
              )}
              <label>
                查询取餐时间（北京时间）
                <input
                  type="time"
                  aria-label="餐段内取餐时间"
                  value={chosenTime}
                  disabled={!chosenSlot}
                  min={chosenSlot?.start}
                  max={chosenSlot?.end}
                  onChange={(e) => setChosenTime(e.target.value)}
                />
              </label>
              <button
                className="button primary"
                disabled={!validSlotTime(chosenSlot, chosenTime)}
                onClick={() => {
                  if (!validSlotTime(chosenSlot, chosenTime)) {
                    setTimeError('请重新选择尚未过去的有效时段。');
                    return;
                  }
                  useTime(`${chosenSlot!.date} ${chosenTime}`);
                }}
              >
                使用这个取餐时间
              </button>
              {timeError && <p className="error-note">{timeError}</p>}
              <p className="micro">改好时间后请重新规划，不会自动下单。</p>
              <details className="micro">
                <summary>餐厅提供的全部预约时段</summary>
                {(store.reservationTimeOptions || []).map((o) => (
                  <p key={o.date}>
                    {o.date}：{o.reservationOptionText}
                  </p>
                ))}
              </details>
            </div>
          )}
        </div>
      </section>
    );
  return (
    <section className="store-section">
      <div className="section-heading">
        <h2>先选一家餐厅</h2>
        <span className="small-muted">价格以所选餐厅为准</span>
      </div>
      <div className="segmented" role="group" aria-label="取餐方式">
        <button className={mode === 'pickup' ? 'active' : ''} onClick={() => changeMode('pickup')}>
          <Icon name="store" /> 到店取餐
        </button>
        <button
          className={mode === 'delivery' ? 'active' : ''}
          onClick={() => changeMode('delivery')}
        >
          <Icon name="bike" /> 麦乐送
        </button>
      </div>
      {mode === 'pickup' ? (
        <>
          <form
            className="store-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <label>
              所在城市
              <input
                placeholder="例如：上海"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </label>
            <label>
              附近地标 <span>（选填）</span>
              <input
                placeholder="例如：人民广场"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <button className="button secondary search-button" disabled={busy} type="submit">
              {busy ? '查询中…' : '查找餐厅'}
              <Icon name="arrow" size={16} />
            </button>
          </form>
        </>
      ) : (
        <div className="delivery-form">
          <p>选择麦当劳账户中的配送地址。</p>
          {addresses.length ? (
            <>
              <label>
                配送地址
                <select
                  value={addressId}
                  onChange={(e) => {
                    setAddressId(e.target.value);
                    setStores([]);
                  }}
                >
                  <option value="">请选择配送地址</option>
                  {addresses.map((a) => (
                    <option key={a.id} value={a.addressId || a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button secondary"
                disabled={!addressId || busy}
                onClick={() => void search()}
              >
                查询可配送餐厅 <Icon name="arrow" size={16} />
              </button>
            </>
          ) : (
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void loadAddresses()}
            >
              {busy ? '读取中…' : '读取我的配送地址'}
            </button>
          )}
          <p className="micro">新增地址请前往麦当劳官方应用。</p>
        </div>
      )}
      {error && (
        <div className="error-note" role="alert">
          <Icon name="info" size={18} />
          <span>{error}</span>
        </div>
      )}
      {searched && !stores.length && (
        <p className="empty-inline">未找到可用餐厅，试试其他城市或地标。</p>
      )}
      {stores.length > 0 && (
        <div className="store-results">
          {stores.map((s) => (
            <button
              key={s.storeCode}
              className={`store-row ${selected?.storeCode === s.storeCode ? 'selected' : ''}`}
              onClick={() => {
                setSelected(s);
                setReserve(s.businessStatus === false && s.reservation === true);
                setReserveDay('');
                setReserveTime('');
              }}
            >
              <Icon name="store" />
              <span>
                <strong>{s.name || s.storeName || s.storeCode}</strong>
                <small>{s.address || '地址未提供'}</small>
                {s.businessStatus === false && (
                  <small>
                    当前不支持即时点餐
                    {s.businessStartTime && s.businessEndTime
                      ? ` · 营业 ${s.businessStartTime}–${s.businessEndTime}`
                      : ''}
                  </small>
                )}
              </span>
              {s.distance != null && <small>{s.distance}</small>}
              <span className="radio-mark" />
            </button>
          ))}
          {selected && (
            <div className="reservation-picker">
              {selected.businessStatus === false && (
                <p className="error-note">
                  这家餐厅当前不支持即时点餐。
                  {canReserve ? '可按以下时段查询预约菜单与价格。' : '当前没有可用预约时段。'}
                </p>
              )}
              {canReserve && (
                <>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={reserve}
                      disabled={selected.businessStatus === false}
                      onChange={(e) => setReserve(e.target.checked)}
                    />
                    <span>选择预约查询时间（北京时间）</span>
                  </label>
                  {reserve && (
                    <>
                      <label>
                        取餐日期
                        <select
                          value={reserveDay}
                          onChange={(e) => {
                            setReserveDay(e.target.value);
                            setReserveTime('');
                          }}
                        >
                          <option value="">请选择日期</option>
                          {reservationOptions.map((o) => (
                            <option key={o.date} value={o.date}>
                              {o.date}
                              {o.today ? '（今天）' : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="micro reservation-windows">
                        {reservationOptions
                          .filter((o) => !reserveDay || o.date === reserveDay)
                          .map((o) => (
                            <p key={o.date}>
                              {o.date}
                              {o.today ? '（今天）' : ''}：{o.reservationOptionText}
                            </p>
                          ))}
                      </div>
                      <label>
                        取餐时间
                        <input
                          type="time"
                          value={reserveTime}
                          disabled={!reserveDay}
                          onChange={(e) => setReserveTime(e.target.value)}
                        />
                      </label>
                      <p className="micro">这里只查询菜单，不会自动下单。</p>
                    </>
                  )}
                </>
              )}
            </div>
          )}
          {selected && (
            <button
              className="button primary"
              disabled={!canConfirm}
              onClick={() =>
                onSelect(selected, {
                  storeCode: selected.storeCode,
                  beCode: selected.beCode,
                  orderType: mode === 'delivery' ? 2 : 1,
                  beType: mode === 'delivery' ? 2 : 1,
                  ...(mode === 'delivery' ? { addressId } : {}),
                  ...(reserve ? { reservationDate: `${reserveDay} ${reserveTime}` } : {}),
                })
              }
            >
              确认这家餐厅 <Icon name="check" size={17} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
