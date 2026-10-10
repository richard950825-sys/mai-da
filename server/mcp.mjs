import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { AppError, assert } from './errors.mjs';

export const MCD_ENDPOINT = 'https://mcp.mcd.cn';
export const READ_TOOLS = new Set([
  'list-nutrition-foods', 'delivery-query-addresses', 'delivery-query-stores',
  'query-nearby-stores', 'query-meals', 'query-meal-detail', 'query-store-coupons',
  'calculate-price', 'now-time-info',
]);
const PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
export const ORDER_CAPABILITY = Symbol('server-authorized-order');
const MAX_BYTES = 4 * 1024 * 1024;

// Generic calls remain read-only; the only write requires the separate order confirmation capability.
export class McdClient {
  #token; #fetch; #session; #protocol; #id = 0; #tools; #orderTool; #initializing; #initialized = false;
  constructor({ token, fetchImpl = globalThis.fetch, timeoutMs = 20000 }) {
    assert(typeof token === 'string' && token.trim(), 'MCD_NOT_CONFIGURED', '尚未配置麦当劳 MCP 凭据', 503);
    this.#token = token; this.#fetch = fetchImpl; this.timeoutMs = timeoutMs;
  }
  get connected() { return this.#initialized; }
  async #request(method, params, notification = false) {
    const id = ++this.#id;
    const headers = { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.#session) headers['Mcp-Session-Id'] = this.#session;
    if (this.#protocol) headers['MCP-Protocol-Version'] = this.#protocol;
    let response;
    try {
      response = await this.#fetch(MCD_ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, ...(params ? { params } : {}) }), signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
    } catch { throw new AppError('MCD_NETWORK_ERROR', '无法连接麦当劳服务，未使用模拟数据替代', 502); }
    if (!response.ok) {
      const code = response.status === 401 ? 'MCD_UNAUTHORIZED' : response.status === 429 ? 'MCD_RATE_LIMIT' : response.status === 404 && this.#session ? 'MCD_SESSION_EXPIRED' : 'MCD_HTTP_ERROR';
      throw new AppError(code, response.status === 401 ? '麦当劳凭据无效或已过期' : response.status === 429 ? '麦当劳服务请求过于频繁，请稍后重试' : '麦当劳服务暂时不可用', response.status === 429 ? 429 : 502);
    }
    const session = response.headers.get('mcp-session-id');
    if (session && method === 'initialize') this.#session = session;
    if (notification) { await response.body?.cancel(); return undefined; }
    let message;
    try {
      if ((response.headers.get('content-type') || '').includes('text/event-stream')) message = await readSseResponse(response, id);
      else {
        const text = await readLimited(response);
        message = JSON.parse(text);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('MCD_INVALID_RESPONSE', '麦当劳服务返回了无法解析的数据', 502);
    }
    assert(message?.jsonrpc === '2.0' && message.id === id, 'MCD_INVALID_RESPONSE', '麦当劳返回的响应与请求不匹配', 502);
    assert(!message.error, 'MCD_RPC_ERROR', '麦当劳工具请求未成功，请检查当前门店及参数', 502);
    assert(message.result !== undefined, 'MCD_INVALID_RESPONSE', '麦当劳服务未返回结果', 502);
    return message.result;
  }
  async initialize() {
    if (this.#initialized) return;
    if (!this.#initializing) this.#initializing = (async () => {
      const result = await this.#request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'meal-planner', version: '2.0.0' } });
      assert(PROTOCOLS.has(result.protocolVersion), 'MCP_PROTOCOL_UNSUPPORTED', '麦当劳服务协议版本尚未支持', 502);
      this.#protocol = result.protocolVersion;
      await this.#request('notifications/initialized', undefined, true);
      this.#initialized = true;
    })().finally(() => { this.#initializing = undefined; });
    return this.#initializing;
  }
  async #withSession(fn) {
    await this.initialize();
    try { return await fn(); }
    catch (error) {
      if (error.code !== 'MCD_SESSION_EXPIRED') throw error;
      this.#initialized = false; this.#session = undefined; this.#tools = undefined;
      await this.initialize();
      return fn(); // Only read operations can reach here; one bounded retry.
    }
  }
  async listTools({ refresh = false } = {}) {
    if (this.#tools && !refresh) return this.#tools;
    return this.#withSession(async () => {
      const tools = []; const cursors = new Set(); let cursor;
      do {
        const page = await this.#request('tools/list', cursor ? { cursor } : {});
        assert(Array.isArray(page.tools), 'MCD_SCHEMA_UNAVAILABLE', '无法读取麦当劳工具参数定义', 502);
        this.#orderTool = page.tools.find(t => t.name === 'create-order') || this.#orderTool;
        tools.push(...page.tools.filter(t => READ_TOOLS.has(t.name)).map(t => ({ name: t.name, description: typeof t.description === 'string' ? t.description : '', inputSchema: t.inputSchema })));
        cursor = page.nextCursor;
        if (cursor) {
          assert(typeof cursor === 'string' && !cursors.has(cursor) && cursors.size < 30, 'MCD_SCHEMA_UNAVAILABLE', '工具列表分页异常', 502);
          cursors.add(cursor);
        }
      } while (cursor);
      this.#tools = tools;
      return tools;
    });
  }
  async getOrderSchema() {
    await this.listTools();
    assert(this.#orderTool?.inputSchema, 'ORDER_TOOL_UNAVAILABLE', '当前账户未提供可验证的下单接口', 503);
    return this.#orderTool.inputSchema;
  }
  async createConfirmedOrder(args, capability) {
    assert(capability === ORDER_CAPABILITY, 'ORDER_NOT_AUTHORIZED', '下单必须经过独立确认', 403);
    validateArguments(await this.getOrderSchema(), args);
    await this.initialize();
    // Never use withSession/retries for a write: an uncertain response could still have created an order.
    return this.#request('tools/call', { name: 'create-order', arguments: args });
  }
  async callRead(name, args = {}) {
    assert(READ_TOOLS.has(name), 'TOOL_NOT_ALLOWED', '该操作不在只读查询范围内', 403);
    const tools = await this.listTools();
    const tool = tools.find(t => t.name === name);
    assert(tool?.inputSchema, 'MCD_TOOL_UNAVAILABLE', '当前麦当劳账户未提供此查询工具', 503);
    validateArguments(tool.inputSchema, args);
    return this.#withSession(() => this.#request('tools/call', { name, arguments: args }));
  }
}

export function validateArguments(schema, args) {
  assert(schema && typeof schema === 'object', 'MCD_SCHEMA_UNAVAILABLE', '工具参数定义不可用', 502);
  let validate;
  try {
    const Compiler = schema.$schema?.includes('2020-12') ? Ajv2020 : Ajv;
    const compiler = new Compiler({ allErrors: true, strict: false, strictSchema: true, coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true });
    addFormats(compiler);
    validate = compiler.compile(schema);
  } catch { throw new AppError('MCD_SCHEMA_UNSUPPORTED', '当前工具参数定义需要更新适配后才能使用', 503); }
  assert(validate(args), 'MCD_ARGUMENTS_INVALID', '请求参数与麦当劳当前接口定义不一致', 422, { fields: (validate.errors || []).map(e => ({ path: e.instancePath, rule: e.keyword, message: e.message })).slice(0, 12) });
}

async function readLimited(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder(); let text = ''; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      assert(bytes <= MAX_BYTES, 'MCD_RESPONSE_TOO_LARGE', '麦当劳返回的数据过大', 502);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}

async function readSseResponse(response, id) {
  const reader = response.body?.getReader();
  assert(reader, 'MCD_INVALID_RESPONSE', '麦当劳服务返回空数据', 502);
  const decoder = new TextDecoder(); let buffer = ''; let bytes = 0;
  const parseEvent = block => {
    const text = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!text) return;
    let message; try { message = JSON.parse(text); } catch { return; }
    // Server requests (sampling, elicitation, etc.) are never executed by this read-only client.
    if (message.id === id && !message.method) return message;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (value) {
        bytes += value.byteLength;
        assert(bytes <= MAX_BYTES, 'MCD_RESPONSE_TOO_LARGE', '麦当劳返回的数据过大', 502);
        buffer += decoder.decode(value, { stream: !done });
        buffer = buffer.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const result = parseEvent(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
          if (result) return result;
        }
      }
      if (done) { const result = parseEvent(buffer); if (result) return result; break; }
    }
  } finally { await reader.cancel().catch(() => {}); }
  throw new AppError('MCD_INCOMPLETE_RESPONSE', '麦当劳服务未返回完整结果', 502);
}
