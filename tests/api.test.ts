import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/lib/api';

test('API errors display a safe request ID without changing server error classification', async t => {
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  globalThis.fetch = async () => Response.json({ error: { code: 'DEEPSEEK_HTTP_ERROR', message: '测试模型请求未成功', requestId: '0123456789abcdef01' } }, { status: 429 });
  await assert.rejects(api('/recommendations', { text: '测试请求' }), error => {
    assert(error instanceof ApiError); assert.equal(error.code, 'DEEPSEEK_HTTP_ERROR'); assert.equal(error.requestId, '0123456789abcdef01'); assert.match(error.message, /请求编号：0123456789abcdef01/); return true;
  });
  assert.equal(new ApiError('安全消息', 'TEST', undefined, 'untrusted-private-value').message, '安全消息');
});

test('successful HTTP responses containing non-object JSON or invalid JSON fail safely', async t => {
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  for (const body of ['not-json', 'null', '[]', '42']) {
    globalThis.fetch = async () => new Response(body, { headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(api('/recommendations', {}), { code: 'INVALID_RESPONSE' });
  }
});

// New package metadata is checked before rendering or using its quantities.
import { isPlan } from '../src/components/Recommendations';
test('invalid package components are rejected before rendering', () => {
  const plan = { id:'p',title:'套餐',price:20,foods:[{id:'f',name:'套餐',quantity:1,role:'combo',components:[{code:'c',name:'饮品',quantity:1,role:'drink'}]}] };
  assert.equal(isPlan(plan),true);
  for (const components of [{},[],[{code:'c',name:'饮品',quantity:-1,role:'drink'}],[{code:'c',name:'饮品',quantity:1,role:'__proto__'}]]) assert.equal(isPlan({...plan,foods:[{...plan.foods[0],components}]}),false);
});

test('client mutations attach the server-issued CSRF token and never provider credentials', async t => {
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  let headers: HeadersInit | undefined;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ csrfToken: 'offline-csrf-for-test', mcdConfigured: true });
    headers = init?.headers;
    return Response.json({ saved: true });
  };
  await api('/owner/setup/status');
  await api('/stores/search', { city: '测试' });
  assert.equal(new Headers(headers).get('X-CSRF-Token'), 'offline-csrf-for-test');
  assert.equal(new Headers(headers).get('Authorization'), null);
});
