import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { READ_TOOLS, MCD_ENDPOINT } from './mcp.mjs';
import { DEEPSEEK_ENDPOINT } from './deepseek.mjs';

const paths = new Set(['/status', '/health', '/owner/setup/status', '/owner/setup', '/owner/setup/verify', '/nutrition', '/mcp/tools', '/addresses', '/providers/verify', '/mcp/read', '/stores/search', '/stores', '/menu', '/menu/overview', '/coupons', '/quote', '/recommendations', '/orders/prepare', '/orders/confirm']);
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

export function createDiagnostics({ logger, fetchImpl = globalThis.fetch } = {}) {
  const scope = new AsyncLocalStorage();
  const record = (trace, event, details = {}) => {
    if (!logger || !trace?.isApi) return;
    // Only caller-selected metadata enters this sink; no headers, bodies, URLs, messages or stacks.
    try { logger({ at: new Date().toISOString(), requestId: trace.requestId, event, ...details }); } catch { /* Logging cannot break a meal request. */ }
  };
  return {
    run(req, res, handler) {
      let pathname = '';
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { /* The app reports malformed requests. */ }
      const trace = { requestId: randomBytes(9).toString('hex'), isApi: pathname.startsWith('/api/'), route: paths.has(pathname.slice(4)) ? pathname : '/api/unknown', phase: 'request', started: performance.now() };
      const method = ['GET', 'POST', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
      if (trace.isApi) res.setHeader('X-Request-Id', trace.requestId);
      record(trace, 'request_started', { method, route: trace.route });
      let finished = false;
      const finish = aborted => {
        if (finished) return; finished = true;
        record(trace, 'request_finished', { method, route: trace.route, phase: trace.phase, status: aborted ? null : res.statusCode, aborted, durationMs: Math.round(performance.now() - trace.started), ...(trace.errorCode ? { code: trace.errorCode } : {}) });
      };
      res.once('finish', () => finish(false));
      res.once('close', () => finish(!res.writableFinished));
      return scope.run(trace, () => handler(trace));
    },
    stage(phase, counts) {
      const trace = scope.getStore();
      if (trace) { trace.phase = phase; record(trace, 'stage', { phase, ...counts }); }
    },
    event(event, details) { record(scope.getStore(), event, details); },
    async fetch(url, options) {
      const trace = scope.getStore();
      const provider = url === MCD_ENDPOINT ? 'mcd' : url === DEEPSEEK_ENDPOINT ? 'deepseek' : 'other';
      let operation = provider === 'deepseek' ? 'chat/completions' : 'unknown';
      if (provider === 'mcd') {
        try {
          const body = JSON.parse(options.body);
          if (['initialize', 'notifications/initialized', 'tools/list'].includes(body.method)) operation = body.method;
          else if (body.method === 'tools/call' && (READ_TOOLS.has(body.params?.name) || body.params?.name === 'create-order')) operation = body.params.name;
        } catch { /* Invalid transport input must not enter the log. */ }
      }
      const started = performance.now();
      try {
        const response = await fetchImpl(url, options);
        record(trace, 'provider_http', { provider, operation, status: response.status, headersMs: Math.round(performance.now() - started) });
        return response;
      } catch (error) {
        record(trace, 'provider_http', { provider, operation, status: null, code: networkCodes.has(error.cause?.code) ? error.cause.code : ['TimeoutError', 'AbortError'].includes(error.name) ? error.name : 'NETWORK_ERROR', headersMs: Math.round(performance.now() - started) });
        throw error;
      }
    },
  };
}
