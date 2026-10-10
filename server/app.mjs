import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AppError, assert, publicError } from './errors.mjs';
import { McdClient } from './mcp.mjs';
import { DeepSeekClient, DEEPSEEK_MODEL, MAX_MEAL_PROMPT_CHARS, requireMealIntent, mealClarification } from './deepseek.mjs';
import { OwnerSessions } from './owner.mjs';
import { AiQuota, requestIp } from './ai-quota.mjs';
import { OrderGateway } from './orders.mjs';
import { unwrapMcp, normalizeNutrition, normalizeStores, normalizeAddresses, normalizeCoupons, normalizeQuote, normalizeMenu } from './normalize.mjs';
import { normalizeConstraints, generateCandidates } from './recommend.mjs';
import { couponQuoteVariants } from './coupons.mjs';
import { readStoreMenu } from './menu.mjs';
import { createDiagnostics } from './diagnostics.mjs';
import { ProductCatalog } from './catalog.mjs';
import { describeMenu, summarizeRequirements } from './menu-context.mjs';

export const SOURCE_VERSION = '2026.10.10-rc10';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const contextKeys = ['storeCode', 'beCode', 'orderType', 'beType', 'reservationDate'];
function storeContext(input) {
  assert(input && typeof input === 'object' && !Array.isArray(input) && typeof input.storeCode === 'string' && input.storeCode, 'STORE_REQUIRED', '请先选择门店', 422);
  assert([1, 2].includes(input.orderType) && [1, 2, 5, 6].includes(input.beType), 'FULFILLMENT_REQUIRED', '请确认取餐或配送方式', 422);
  assert(input.orderType === 1 ? [1, 5].includes(input.beType) : [2, 6].includes(input.beType), 'FULFILLMENT_INVALID', '门店业务类型与取餐方式不匹配', 422);
  if (input.reservationDate !== undefined) {
    assert(typeof input.reservationDate === 'string' && /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(input.reservationDate), 'RESERVATION_TIME_INVALID', '请提供有效的北京时间取餐日期和时间', 422);
    const date = new Date(input.reservationDate.slice(0, 10) + 'T00:00:00Z');
    assert(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === input.reservationDate.slice(0, 10), 'RESERVATION_TIME_INVALID', '取餐日期无效，请重新选择', 422);
  }
  return Object.fromEntries(contextKeys.filter(k => input[k] !== undefined && input[k] !== null).map(k => [k, input[k]]));
}
function quoteArgs(body) {
  const context = storeContext(body.storeContext || body.context);
  assert(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= 30, 'ITEMS_REQUIRED', '请选择需要算价的餐品', 422);
  const items = body.items.map(i => {
    assert(i && typeof i.productCode === 'string' && i.productCode && Number.isSafeInteger(i.quantity) && i.quantity >= 1 && i.quantity <= 99, 'INVALID_ITEMS', '餐品编码或数量无效', 422);
    assert(!Object.keys(i).some(k => !['productCode', 'quantity', 'couponId', 'couponCode', 'roundList', 'modification'].includes(k)), 'INVALID_ITEMS', '餐品参数包含未支持的字段', 422);
    return structuredClone(i);
  });
  return { ...context, items, ...(typeof body.needTableware === 'boolean' ? { needTableware: body.needTableware } : {}) };
}
async function readBody(req) {
  assert((req.headers['content-type'] || '').split(';')[0] === 'application/json', 'JSON_REQUIRED', '请求必须使用 JSON', 415);
  let buffer = ''; let length = 0;
  for await (const chunk of req) { length += chunk.length; assert(length <= 64000, 'BODY_TOO_LARGE', '请求内容过长', 413); buffer += chunk; }
  try { const value = JSON.parse(buffer); assert(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSON', '请求内容格式无效'); return value; }
  catch (e) { if (e instanceof AppError) throw e; throw new AppError('INVALID_JSON', '请求内容格式无效'); }
}

export function createApp(options = {}) {
  const visitorAccess = options.visitorAccess === true;
  const quota = visitorAccess ? new AiQuota(options.quotaPath || ':memory:', options.clock) : null;
  const clientIp = req => requestIp(req, options.trustCloudflare === true);
  const diagnostics = createDiagnostics(options);
  const catalog = new ProductCatalog(options.catalogPath || ':memory:');
  const port = options.port ?? 8788;
  const allowedOrigins = new Set(options.allowedOrigins || [`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5178', 'http://localhost:5178']);
  const hosts = new Set([...allowedOrigins].map(o => new URL(o).host));
  const owner = new OwnerSessions({ enabled: visitorAccess || options.ownerSetupEnabled === true, securitySessions: options.orderingEnabled === true, secure: options.secureCookies === true, clock: options.clock });
  const gateway = new OrderGateway({ enabled: options.orderingEnabled === true, termsUrl: options.orderTermsUrl, cancellationDisclosure: options.cancellationDisclosure, clock: options.clock });
  const contexts = new Map();
  const now = options.clock || Date.now;
  const cleanup = setInterval(() => {
    owner.prune();
    for (const [id, context] of contexts) if (context.expiresAt < now()) contexts.delete(id);
  }, 60000);
  cleanup.unref();
  const providerAccessEnabled = options.providerAccessEnabled === true;
  const envCredentials = !visitorAccess && options.allowLocalEnvCredentials && process.env.NODE_ENV !== 'production' ? { mcdToken: process.env.MCD_MCP_TOKEN, deepseekApiKey: process.env.DEEPSEEK_API_KEY } : {};
  const getIdentity = async req => {
    const session = owner.get(req);
    if (visitorAccess) return { id: session?.accountId || 'unconnected', credentials: { mcdToken: session?.credentials.mcdToken, deepseekApiKey: process.env.DEEPSEEK_API_KEY }, session, req };
    if (options.resolveUser) {
      const user = await options.resolveUser(req);
      assert(user?.id, 'AUTH_REQUIRED', '请先登录', 401);
      return { id: user.id, credentials: { ...(await options.resolveCredentials?.(user.id) || {}) }, session };
    }
    assert(process.env.NODE_ENV !== 'production' || !providerAccessEnabled, 'AUTH_NOT_CONFIGURED', '生产环境尚未配置用户身份验证', 503);
    return { id: owner.enabled ? session?.id || 'local-owner' : 'local-owner', credentials: { ...(owner.enabled ? session?.credentials || {} : envCredentials) }, session };
  };
  const getClient = (identity, kind) => {
    const key = kind === 'mcd' ? identity.credentials.mcdToken : identity.credentials.deepseekApiKey;
    const previous = contexts.get(identity.id);
    if (kind === 'mcd' && previous?.mcdKey && previous.mcdKey !== key) { gateway.invalidateUser(identity.id); contexts.delete(identity.id); }
    assert(key, kind === 'mcd' ? 'MCD_NOT_CONFIGURED' : 'DEEPSEEK_NOT_CONFIGURED', kind === 'mcd' ? '尚未连接麦当劳账户，无法读取真实营养、门店和菜单' : '尚未连接 DeepSeek，无法解析自然语言需求', 503);
    assert(providerAccessEnabled, 'PROVIDER_ACCESS_DISABLED', '凭据已暂存，但真实服务查询尚未获启用授权', 403);
    if (kind === 'deepseek' && quota && !identity.aiUsage) identity.aiUsage = quota.consume(clientIp(identity.req));
    let context = contexts.get(identity.id);
    if (!context || context[`${kind}Key`] !== key) {
      if (kind === 'mcd' && context?.mcdKey) gateway.invalidateUser(identity.id);
      // Replacement creates a new object: an older in-flight read cannot fill the new account's cache.
      context = { ...context, [kind]: kind === 'mcd' ? new McdClient({ token: key, fetchImpl: diagnostics.fetch }) : new DeepSeekClient({ apiKey: key, model: options.deepseekModel || DEEPSEEK_MODEL, fetchImpl: diagnostics.fetch }), [`${kind}Key`]: key, nutrition: undefined };
      contexts.set(identity.id, context);
    }
    context.expiresAt = now() + 30 * 60 * 1000;
    return context[kind];
  };
  const nutrition = async identity => {
    const client = getClient(identity, 'mcd'); const context = contexts.get(identity.id);
    if (context.nutrition && Date.now() - context.nutritionAt < 5 * 60 * 1000) return context.nutrition;
    const normalized = normalizeNutrition(await client.callRead('list-nutrition-foods', {}));
    context.nutrition = normalized; context.nutritionAt = Date.now(); return normalized;
  };
  const readMenu = async (identity, context, foods, coupons = [], aiConsent = false) => {
    const menu = await readStoreMenu(getClient(identity, 'mcd'), context, foods, coupons, snapshot => catalog.observe(identity.id, snapshot));
    diagnostics.event('menu_context', { period: menu.menuContext.period, itemCount: menu.menuContext.itemCount, scheduled: !!context.reservationDate });
    diagnostics.stage('sync-product-catalog');
    const ai = aiConsent && identity.credentials.deepseekApiKey ? getClient(identity, 'deepseek') : null;
    await catalog.sync(identity.id, menu, ai, options.deepseekModel || DEEPSEEK_MODEL);
    diagnostics.event('catalog_sync', Object.fromEntries(Object.entries(menu.catalogSync).filter(([key, value]) => typeof value === 'number' || key === 'complete')));
    return menu;
  };
  const doQuote = async (identity, args, remember = true) => {
    const normalized = normalizeQuote(await getClient(identity, 'mcd').callRead('calculate-price', args), args.items);
    return remember ? gateway.rememberQuote(identity.id, normalized, args) : normalized;
  };
  const status = identity => ({ sourceVersion: SOURCE_VERSION, mode: 'live', accessMode: visitorAccess ? 'visitor' : 'private', ...(visitorAccess && identity.credentials.mcdToken ? { receiptScope: createHash('sha256').update(`mcd-receipt:${identity.credentials.mcdToken}`).digest('hex') } : {}), ...(visitorAccess && identity.session ? { csrfToken: identity.session.csrf } : {}), ...(quota ? { aiQuota: quota.status(clientIp(identity.req)) } : {}), catalog: { persistent: catalog.persistent, sync: 'on-request' }, mcd: { configured: !!identity.credentials.mcdToken, connected: !!identity.credentials.mcdToken && contexts.get(identity.id)?.mcdKey === identity.credentials.mcdToken && !!contexts.get(identity.id)?.mcd?.connected, state: !identity.credentials.mcdToken ? 'not-configured' : !providerAccessEnabled ? 'access-disabled' : contexts.get(identity.id)?.mcdKey === identity.credentials.mcdToken && contexts.get(identity.id)?.mcd?.connected ? 'connected' : 'not-verified' }, deepseek: { configured: !!identity.credentials.deepseekApiKey, model: options.deepseekModel || DEEPSEEK_MODEL }, ordering: { enabled: gateway.enabled && providerAccessEnabled && !!gateway.termsUrl && !!gateway.cancellationDisclosure, reason: '真实下单需要独立确认与授权配置' }, readOnly: !gateway.enabled, providerAccessEnabled });
  const handler = (req, res) => diagnostics.run(req, res, async trace => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    const send = (value, code = 200) => {
      if (value.error) { trace.errorCode = value.error.code; value.error.requestId = trace.requestId; }
      if (Array.isArray(value.recommendations)) value.requestId = trace.requestId;
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      assert(visitorAccess || !req.headers['cf-connecting-ip'], 'VISITOR_ACCESS_REQUIRED', '公网访问需要启用独立账户模式', 403);
      assert(hosts.has(req.headers.host), 'HOST_NOT_ALLOWED', '访问地址未获得授权', 403);
      const origin = req.headers.origin;
      if (origin) assert(allowedOrigins.has(origin), 'ORIGIN_NOT_ALLOWED', '仅允许同源访问', 403);
      assert(req.headers['sec-fetch-site'] !== 'cross-site', 'CROSS_SITE_DENIED', '不允许跨站请求', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') throw new AppError('NOT_FOUND', '未找到此页面', 404);
        return await serveStatic(url.pathname, res, options.staticDir || path.join(ROOT, 'dist'));
      }
      const route = `${req.method} ${url.pathname.slice(4)}`;
      if (route === 'GET /owner/setup/status') {
        assert(visitorAccess || loopback(req.socket.remoteAddress), 'OWNER_LOCAL_ONLY', '凭据设置仅能在本机进行', 403);
        const session = owner.enabled || owner.securitySessions ? owner.open(req, res) : owner.get(req);
        return send({ ...owner.status(session), ...(!owner.enabled ? { mcdConfigured: !!envCredentials.mcdToken, deepseekConfigured: !!envCredentials.deepseekApiKey } : {}), ...(visitorAccess ? { deepseekConfigured: !!process.env.DEEPSEEK_API_KEY } : {}), providerAccessEnabled, credentialMode: visitorAccess ? 'visitor' : owner.enabled ? 'session' : Object.values(envCredentials).some(Boolean) ? 'local-file' : 'unconfigured', persistentStorage: !owner.enabled && Object.values(envCredentials).some(Boolean) });
      }
      if (url.pathname.startsWith('/api/owner/setup')) {
        assert(owner.enabled, 'OWNER_SETUP_DISABLED', '凭据设置尚未获得启用授权', 403);
        assert((visitorAccess || loopback(req.socket.remoteAddress)) && origin && allowedOrigins.has(origin), 'OWNER_LOCAL_ONLY', '凭据设置仅能通过本机同源页面进行', 403);
        const session = owner.requireCsrf(req);
        if (route === 'POST /owner/setup') {
          const input = await readBody(req);
          let verifiedClient;
          if (visitorAccess) {
            assert(Object.keys(input).length === 1 && typeof input.mcdToken === 'string', 'INVALID_CREDENTIAL_INPUT', '请填写麦当劳 MCP Token');
            // Validate before replacing the current account; a failed connection keeps it usable.
            const pending = { credentials: {} };
            owner.setCredentials(pending, input);
            assert(providerAccessEnabled, 'PROVIDER_ACCESS_DISABLED', '服务暂未开放，请稍后再试', 403);
            verifiedClient = new McdClient({ token: pending.credentials.mcdToken, fetchImpl: diagnostics.fetch });
            await verifiedClient.listTools();
          }
          gateway.invalidateUser(session.id); gateway.invalidateUser(session.accountId);
          contexts.delete(session.accountId);
          owner.setCredentials(session, input); contexts.delete(session.id);
          if (verifiedClient) contexts.set(session.accountId, { mcd: verifiedClient, mcdKey: session.credentials.mcdToken, expiresAt: now() + 30 * 60 * 1000 });
          return send({ saved: true, mcdConfigured: !!session.credentials.mcdToken, deepseekConfigured: visitorAccess ? !!process.env.DEEPSEEK_API_KEY : !!session.credentials.deepseekApiKey, persistentStorage: false, verified: visitorAccess });
        }
        if (route === 'DELETE /owner/setup') { gateway.invalidateUser(session.id); gateway.invalidateUser(session.accountId); contexts.delete(session.accountId); owner.clear(session); contexts.delete(session.id); return send({ cleared: true }); }
        if (route === 'POST /owner/setup/verify') {
          const body = await readBody(req); const identity = visitorAccess ? await getIdentity(req) : { id: session.id, credentials: session.credentials, session };
          if (visitorAccess) assert(identity.credentials.mcdToken, 'AUTH_REQUIRED', '请先连接麦当劳账户', 401);
          if (body.provider === 'mcd') { const tools = await getClient(identity, 'mcd').listTools({ refresh: true }); return send({ provider: 'mcd', verified: true, readToolCount: tools.length, readOnly: true }); }
          assert(body.provider === 'deepseek' && body.aiConsent === true, 'VERIFICATION_CONSENT_REQUIRED', '请确认用一次最小请求验证 DeepSeek', 422);
          await getClient(identity, 'deepseek').parseMealText('单餐偏好：均衡');
          return send({ provider: 'deepseek', verified: true });
        }
        throw new AppError('NOT_FOUND', '接口不存在', 404);
      }
      if (route === 'GET /status' && !visitorAccess && !options.resolveUser && owner.securitySessions) {
        assert(visitorAccess || loopback(req.socket.remoteAddress), 'OWNER_LOCAL_ONLY', '下单会话仅能通过本机私密连接打开', 403);
        owner.open(req, res);
      }
      const identity = await getIdentity(req);
      if (visitorAccess && identity.session) owner.open(req, res);
      if (route === 'GET /status' || route === 'GET /health') return send(status(identity));
      if (visitorAccess) {
        assert(identity.session && identity.credentials.mcdToken, 'AUTH_REQUIRED', '请先连接麦当劳账户', 401);
        if (req.method !== 'GET') {
          assert(origin && allowedOrigins.has(origin), 'ORIGIN_NOT_ALLOWED', '请通过本站操作', 403);
          owner.requireCsrf(req);
        }
      }
      // Requests that can create an order also require the owner session CSRF token.
      if (route === 'POST /orders/confirm') {
        if (!options.resolveUser) owner.requireCsrf(req);
        else assert(await options.verifyCsrf?.(req), 'CSRF_INVALID', '请重新验证下单安全会话', 403);
      }
      if (route === 'GET /nutrition') return send(await nutrition(identity));
      if (route === 'GET /mcp/tools') return send({ tools: await getClient(identity, 'mcd').listTools(), source: 'mcd-live', retrievedAt: new Date().toISOString() });
      if (route === 'GET /addresses') return send(normalizeAddresses(await getClient(identity, 'mcd').callRead('delivery-query-addresses', {})));
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (route === 'POST /providers/verify') {
        assert(!owner.enabled && options.allowLocalEnvCredentials && loopback(req.socket.remoteAddress) && origin && allowedOrigins.has(origin), 'VERIFICATION_NOT_ALLOWED', '请使用当前私密连接入口验证服务', 403);
        if (body.provider === 'mcd') { const tools = await getClient(identity, 'mcd').listTools({ refresh: true }); return send({ provider: 'mcd', verified: true, readToolCount: tools.length, readOnly: true }); }
        assert(body.provider === 'deepseek' && body.aiConsent === true, 'VERIFICATION_CONSENT_REQUIRED', '请确认用一次最小请求验证 DeepSeek', 422);
        await getClient(identity, 'deepseek').parseMealText('单餐偏好：均衡');
        return send({ provider: 'deepseek', verified: true, model: options.deepseekModel || DEEPSEEK_MODEL });
      }
      if (route === 'POST /mcp/read') return send(unwrapMcp(await getClient(identity, 'mcd').callRead(body.name, body.arguments || {})));
      if (route === 'POST /stores/search' || route === 'POST /stores') {
        const mode = body.mode || body.fulfillment || 'pickup'; let args; let name;
        if (mode === 'delivery') {
          assert(typeof body.addressId === 'string' && body.addressId, 'ADDRESS_REQUIRED', '请选择现有的麦当劳配送地址', 422);
          name = 'delivery-query-stores'; args = { addressId: body.addressId, beType: 2 };
        } else {
          assert(['pickup', 'drive-through'].includes(mode), 'INVALID_MODE', '不支持的取餐方式');
          assert(!body.coordinates, 'LOCATION_SEARCH_UNAVAILABLE', '当前麦当劳接口不支持经纬度查询，请填写城市和地标', 422);
          assert(typeof body.city === 'string' && body.city.trim(), 'CITY_REQUIRED', '请输入要搜索的城市', 422);
          const keyword = body.query ?? body.keyword ?? '';
          assert(typeof keyword === 'string', 'INVALID_SEARCH', '门店位置关键词无效');
          name = 'query-nearby-stores';
          args = { searchType: 2, beType: mode === 'drive-through' ? 5 : 1, city: body.city.trim(), keyword: keyword.trim() || '麦当劳' };
        }
        return send(normalizeStores(await getClient(identity, 'mcd').callRead(name, args)));
      }
      if (route === 'POST /menu/overview') {
        const context = storeContext(body.storeContext || body.context);
        diagnostics.stage('read-menu-overview');
        const menu = normalizeMenu(await getClient(identity, 'mcd').callRead('query-meals', context));
        return send({ menuContext: describeMenu(menu, context), source: menu.source, retrievedAt: menu.retrievedAt });
      }
      if (route === 'POST /menu') {
        const context = storeContext(body.storeContext || body.context); const client = getClient(identity, 'mcd');
        let foods = []; let warning;
        try { foods = (await nutrition(identity)).foods; } catch { warning = '营养读取未成功，菜单中的营养暂显示为未知'; }
        const menu = await readMenu(identity, context, foods, [], body.aiConsent === true); if (warning) menu.warnings.push(warning); return send(menu);
      }
      if (route === 'POST /coupons') return send(normalizeCoupons(await getClient(identity, 'mcd').callRead('query-store-coupons', storeContext(body.storeContext || body.context))));
      if (route === 'POST /quote') return send(await doQuote(identity, quoteArgs(body)));
      if (route === 'POST /recommendations') {
        // Resolve intent and constraints before ANY McDonald's MCP traffic, including initialization.
        // The model extracts preferences only; authoritative food facts are still required below.
        diagnostics.stage('parse-input');
        let parsed = {}; let ai;
        if (Object.hasOwn(body, 'text')) assert(typeof body.text === 'string' && body.text.length <= MAX_MEAL_PROMPT_CHARS, 'INVALID_MEAL_TEXT', '用餐需求与偏好上下文过长，请缩短后重试', 422);
        if (typeof body.text === 'string' && body.text.trim()) {
          assert(body.aiConsent === true, 'AI_CONSENT_REQUIRED', '请先同意由 DeepSeek 处理用餐需求。', 422);
          ai = getClient(identity, 'deepseek'); parsed = await ai.parseMealText(body.text.trim());
          requireMealIntent(parsed);
        } else if (!hasStructuredMealRequest(body)) {
          throw mealClarification('missing_meal_intent');
        }
        diagnostics.stage('validate-constraints');
        let constraints;
        try { constraints = normalizeConstraints(body, parsed); }
        catch (error) {
          if (error instanceof AppError && error.details?.reason === 'conflicting_constraints') throw mealClarification('conflicting_constraints');
          throw error;
        }
        diagnostics.stage('read-nutrition');
        const facts = await nutrition(identity); let foods = facts.foods; const contextInput = body.storeContext || body.context;
        let coupons = []; let catalogSync; let menuContext; const providerWarnings = [];
        if (contextInput) {
          const context = storeContext(contextInput); const client = getClient(identity, 'mcd');
          diagnostics.stage('read-store-menu');
          try { coupons = normalizeCoupons(await client.callRead('query-store-coupons', context)).coupons; }
          catch (error) { if (error.code === 'MCD_RATE_LIMIT') throw error; providerWarnings.push('优惠券暂时查询失败，价格未计入券优惠。'); }
          const menu = await readMenu(identity, context, facts.foods, coupons, body.aiConsent === true);
          catalogSync = menu.catalogSync; menuContext = menu.menuContext;
          providerWarnings.push(...menu.warnings);
          foods = menu.items.map(m => ({ ...m, standardVerified: m.standardVerified === true, configurationStatus: m.configurationStatus, id: m.id, name: m.name, nutrition: m.nutrition, productCode: m.code, menuPrice: m.menuPrice, ...(m.roundList ? { roundList: m.roundList } : {}), category: m.category, productMapping: m.productMapping, basis: { kind: m.nutrition.kcal !== null ? 'serving' : 'unknown' } }));
          if (!coupons.length) providerWarnings.push('这家餐厅暂无可用优惠券。');
        }
        diagnostics.stage('generate-candidates', { foodCount: foods.length });
        const generated = generateCandidates(foods, constraints); let candidates = generated.candidates; let noMatch = generated.noMatch;
        diagnostics.event('candidate_counts', { generated: candidates.length, ...(noMatch ? { reasonCode: noMatch.code, menuCount: noMatch.menuCount, eligibleCount: noMatch.eligibleCount, missingFeatures: noMatch.missingFeatures } : {}) });
        let warnings = [...facts.warnings, ...generated.warnings, ...providerWarnings];
        if (contextInput) {
          diagnostics.stage('quote-candidates');
          const priced = [];
          const quoteFailures = {}; let overBudget = 0;
          const preferredCombos = candidates.filter(c => c.officialCombo).slice(0, 8);
          const quoteQueue = constraints.preferCombo ? [...preferredCombos, ...candidates.filter(c => !c.officialCombo).slice(0, 12 - preferredCombos.length)] : candidates.slice(0, 12);
          for (const candidate of quoteQueue) {
            const baseArgs = quoteArgs({ storeContext: contextInput, items: candidate.foods.map(f => ({ productCode: f.productCode, quantity: f.quantity, ...(f.roundList ? { roundList: f.roundList } : {}) })) });
            const variants = couponQuoteVariants(baseArgs, coupons);
            const attempts = await Promise.allSettled(variants.map(async variant => ({ ...variant, response: await doQuote(identity, variant.args) })));
            const successes = attempts.filter(a => a.status === 'fulfilled').map(a => a.value).sort((a, b) => a.response.quote.total - b.response.quote.total || (constraints.preferCoupons ? Number(!!b.coupon) - Number(!!a.coupon) : 0));
            for (const attempt of attempts) if (attempt.status === 'rejected') { const code = attempt.reason instanceof AppError ? attempt.reason.code : 'INTERNAL_ERROR'; quoteFailures[code] = (quoteFailures[code] || 0) + 1; }
            const best = successes[0];
            if (best && constraints.budget !== null && best.response.quote.total > constraints.budget) overBudget++;
            if (best && (constraints.budget === null || best.response.quote.total <= constraints.budget)) {
              priced.push({ ...candidate, foods: candidate.foods.map((f, i) => best.itemIndex === i && best.coupon ? { ...f, couponId: best.coupon.couponId, couponCode: best.coupon.couponCode } : f), price: best.response.quote.total, priceStatus: 'quoted', quote: best.response.quote, appliedCoupon: best.coupon, reasons: [...candidate.reasons, ...(best.coupon ? [`已使用当前门店可用优惠券核价：${best.coupon.title || '已选优惠券'}`] : [])] });
            } else if (!best && constraints.budget === null) {
              priced.push({ ...candidate, warnings: [...candidate.warnings, '实时算价未成功，价格未知'] });
            }
            if (attempts.some(a => a.status === 'rejected' && a.reason?.code === 'MCD_RATE_LIMIT')) { warnings.push('查询达到服务限流，部分候选价格尚未核实'); break; }
            if (priced.length >= 5) break;
          }
          candidates = priced;
          diagnostics.event('quote_counts', { returned: priced.length, overBudget, failures: quoteFailures });
          if (!candidates.length && !noMatch) {
            noMatch = overBudget > 0 ? { code: 'QUOTED_OVER_BUDGET', message: '已核价的搭配均超出预算，试试提高预算或换些餐品。' } : { code: 'QUOTE_UNVERIFIED', message: '已找到餐品，但暂时无法核价，请稍后重试。' };
            warnings.push(noMatch.message);
          }
          if (coupons.length && !candidates.some(c => c.appliedCoupon)) warnings.push('暂未找到更优惠的券价。');
        } else if (constraints.budget !== null) warnings.push('尚未选择门店，预算暂无法验证；下列方案不代表满足预算');
        if (ai && candidates.length) {
          diagnostics.stage('rank-candidates');
          try { const ids = await ai.rankCandidates(constraints, candidates.slice(0, 15)); candidates = ids.map(id => candidates.find(c => c.id === id)); if (constraints.preferCombo) candidates.sort((a, b) => Number(b.officialCombo) - Number(a.officialCombo)); }
          catch (error) { diagnostics.event('ranking_fallback', { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' }); warnings.push('AI 排序暂不可用，已按营养条件排序。'); }
        }
        diagnostics.stage('complete', { returned: candidates.slice(0, 5).length, outcome: candidates.length ? 'recommendations' : 'no-matching-candidates' });
        return send({ intent: parsed.intent || 'meal', recommendations: candidates.slice(0, 5), noMatch, menuContext, requirementSummary: summarizeRequirements(constraints), constraints, warnings, ai: { used: !!ai, model: ai?.model || null }, ...(catalogSync ? { catalogSync } : {}), source: 'mcd-live', retrievedAt: facts.retrievedAt });
      }
      if (route === 'POST /orders/prepare') return send(await gateway.prepare(identity.id, body, getClient(identity, 'mcd')));
      if (route === 'POST /orders/confirm') return send(await gateway.confirm(identity.id, body, { client: getClient(identity, 'mcd'), reprice: args => doQuote(identity, args, false) }));
      throw new AppError('NOT_FOUND', '接口不存在', 404);
    } catch (error) { if (!res.headersSent) { if (error.code === 'AI_DAILY_LIMIT') res.setHeader('Retry-After', String(error.details.retryAfter)); send(publicError(error), error instanceof AppError ? error.status : 500); } else res.end(); }
  });
  return { handler, createServer: () => {
    const server = createServer(handler);
    server.once('close', () => { clearInterval(cleanup); contexts.clear(); owner.clearAll(); quota?.close(); void catalog.close(); });
    return server;
  } };
}
function hasStructuredMealRequest(body) {
  if (body.mealTarget != null || body.budget != null) return true;
  const preferences = body.preferences;
  if (Array.isArray(preferences)) return preferences.some(value => ['balanced', 'high-protein', 'low-calorie', 'low-sugar'].includes(value));
  if (!preferences || typeof preferences !== 'object') return false;
  return ['goal', 'people', 'proteinMin', 'sugarMax', 'sodiumMax'].some(key => preferences[key] != null)
    || ['avoid', 'includeKeywords', 'includeAnyKeywords'].some(key => Array.isArray(preferences[key]) && preferences[key].length)
    || ['preferCoupons', 'preferCombo', 'unsweetenedDrink', 'beverageOnlyAllowed'].some(key => preferences[key] === true);
}
async function serveStatic(urlPath, res, staticDir) {
  const decoded = decodeURIComponent(urlPath); const candidate = path.resolve(staticDir, `.${decoded}`);
  assert(candidate.startsWith(path.resolve(staticDir) + path.sep) || candidate === path.resolve(staticDir), 'NOT_FOUND', '页面不存在', 404);
  let filename = candidate;
  try { if (!(await stat(filename)).isFile()) filename = path.join(staticDir, 'index.html'); }
  catch { filename = path.join(staticDir, 'index.html'); }
  let buffer;
  try { buffer = await readFile(filename); } catch { throw new AppError('FRONTEND_NOT_BUILT', '前端尚未构建，请使用开发页面', 503); }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
  res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); res.end(buffer);
}
