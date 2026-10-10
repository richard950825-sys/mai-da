// The public Worker serves static UI and forwards API traffic through a private binding.
// Provider credentials remain exclusively on the Node backend.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol !== 'https:') { url.protocol = 'https:'; return Response.redirect(url.href, 308); }
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const fail = (code, message, status) => Response.json({ error: { code, message } }, { status, headers: { 'Cache-Control': 'no-store' } });
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') return fail('ORIGIN_NOT_ALLOWED', '请通过本站操作', 403);
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) return fail('METHOD_NOT_ALLOWED', '不支持此请求方式', 405);
    if (request.method !== 'GET' && !origin) return fail('ORIGIN_NOT_ALLOWED', '请通过本站操作', 403);
    const ip = request.headers.get('CF-Connecting-IP');
    if (!ip) return fail('CLIENT_IP_REQUIRED', '无法确认访问地址，请稍后重试', 403);
    const headers = new Headers(request.headers);
    headers.delete('X-Forwarded-For');
    headers.delete('X-Real-IP');
    headers.set('CF-Connecting-IP', ip);
    headers.set('Host', '127.0.0.1:8799');
    const target = `http://127.0.0.1:8799${url.pathname}${url.search}`;
    try {
      return await env.MCD_API.fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual', ...(request.body ? { duplex: 'half' } : {}) }));
    } catch {
      return fail('BACKEND_UNAVAILABLE', '服务暂时无法连接，请稍后重试', 503);
    }
  },
};
