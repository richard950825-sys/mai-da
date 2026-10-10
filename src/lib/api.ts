let csrfToken: string | undefined;

export class ApiError extends Error {
  code: string;
  details: unknown;
  requestId?: string;
  constructor(message: string, code = 'REQUEST_FAILED', details?: unknown, requestId?: string) {
    const id = requestId && /^[a-f0-9]{18}$/.test(requestId) ? requestId : undefined;
    super(id ? `${message}（请求编号：${id}）` : message);
    this.requestId = id;
    this.code = code;
    this.details = details;
  }
}
export async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined
          ? {}
          : {
              'Content-Type': 'application/json',
              ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
            },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError('暂时无法连接服务，请稍后重试。', 'NETWORK_ERROR');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    if (
      typeof window !== 'undefined' &&
      ['AUTH_REQUIRED', 'CSRF_INVALID'].includes(data?.error?.code)
    )
      window.dispatchEvent(new Event('mcd-session-expired'));
    throw new ApiError(
      data?.error?.message || '服务暂时不可用，请稍后重试。',
      data?.error?.code || String(response.status),
      data?.error?.details,
      data?.error?.requestId ?? response.headers.get('X-Request-Id') ?? undefined,
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new ApiError(
      '服务返回的数据格式无效，请重试。',
      'INVALID_RESPONSE',
      undefined,
      response.headers.get('X-Request-Id') ?? undefined,
    );
  if (typeof data.csrfToken === 'string') csrfToken = data.csrfToken;
  return data as T;
}
export type ServiceStatus = {
  accessMode?: 'visitor' | 'private';
  receiptScope?: string;
  aiQuota?: { limit: number; remaining: number; resetsAt: string; timezone: string };
  mcd?: { configured?: boolean; connected?: boolean; status?: string };
  deepseek?: { configured?: boolean; connected?: boolean; model?: string };
  ordering?: { enabled?: boolean };
  [key: string]: unknown;
};
export type Store = {
  storeCode: string;
  storeName?: string;
  name?: string;
  address?: string;
  distance?: string | number;
  beCode?: string;
  orderType?: number;
  beType?: number;
  businessStatus?: boolean | null;
  businessStartTime?: string | null;
  businessEndTime?: string | null;
  reservation?: boolean | null;
  reservationTimeOptions?: { date: string; today: boolean; reservationOptionText: string }[];
};
export type StoreContext = {
  storeCode: string;
  beCode?: string;
  orderType: number;
  beType: number;
  addressId?: string;
  reservationDate?: string;
};
export type Nutrition = {
  energyKcal: number | null;
  protein: number | null;
  fat: number | null;
  carbohydrate: number | null;
  sodium: number | null;
  sugar?: number | null;
};
export type MealItem = {
  code: string;
  name: string;
  quantity: number;
  imageUrl?: string;
  priceYuan?: number;
  nutrition?: Nutrition | null;
};
export type Recommendation = {
  id: string;
  title?: string;
  items: MealItem[];
  reasons?: string[];
  warnings?: string[];
  totalPriceYuan?: number | null;
  totalKcal?: number | null;
  nutrition?: Nutrition;
  quote?: unknown;
  [key: string]: unknown;
};

export type MenuContext = {
  storeCode: string;
  requestedTime: string | null;
  period: 'breakfast' | 'regular' | 'mixed' | 'unknown';
  label: string;
  source: string;
  itemCount: number;
  retrievedAt: string;
};
export function isMenuContext(value: unknown): value is MenuContext {
  if (!value || typeof value !== 'object') return false;
  const m = value as MenuContext;
  return (
    typeof m.storeCode === 'string' &&
    typeof m.label === 'string' &&
    ['breakfast', 'regular', 'mixed', 'unknown'].includes(m.period) &&
    Number.isSafeInteger(m.itemCount) &&
    m.itemCount >= 0 &&
    typeof m.retrievedAt === 'string' &&
    Number.isFinite(Date.parse(m.retrievedAt))
  );
}
