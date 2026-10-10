import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { assert, AppError } from './errors.mjs';
import { ORDER_CAPABILITY, validateArguments } from './mcp.mjs';
import { unwrapMcp } from './normalize.mjs';

function fingerprint(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function safePayUrl(value, hosts = ['mcd.cn', 'mcdchina.net']) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && hosts.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`)) ? u.href : null; } catch { return null; }
}
export class OrderGateway {
  #quotes = new Map(); #proposals = new Map();
  constructor({ enabled = false, termsUrl = null, cancellationDisclosure = null, clock = Date.now } = {}) {
    this.enabled = enabled; this.termsUrl = safePayUrl(termsUrl, ['mcd.cn', 'mcdchina.net', 'mcdonalds.com.cn']); this.cancellationDisclosure = typeof cancellationDisclosure === 'string' && cancellationDisclosure.trim() ? cancellationDisclosure.trim() : null; this.clock = clock;
  }
  hasPendingUser(userId) { return [...this.#proposals.values()].some(p => p.userId === userId && p.state === 'pending'); }
  invalidateUser(userId) {
    assert(!this.hasPendingUser(userId), 'ORDER_PENDING', '订单正在提交，请等待结果后再更换或清除账户', 409);
    for (const [id, quote] of this.#quotes) if (quote.userId === userId) this.#quotes.delete(id);
    for (const [id, proposal] of this.#proposals) if (proposal.userId === userId) this.#proposals.delete(id);
  }
  rememberQuote(userId, normalized, args) {
    this.#prune();
    const id = randomBytes(18).toString('base64url'); const expiresAt = this.clock() + 5 * 60 * 1000;
    const quote = { ...normalized.quote, id, expiresAt: new Date(expiresAt).toISOString() };
    this.#quotes.set(id, { quote, args: structuredClone(args), userId, expiresAt });
    return { ...normalized, quote };
  }
  #prune() {
    for (const [id, item] of this.#quotes) if (item.expiresAt < this.clock()) this.#quotes.delete(id);
    for (const [id, item] of this.#proposals) if (item.expiresAt + 60 * 60 * 1000 < this.clock()) this.#proposals.delete(id);
  }
  async prepare(userId, body, client) {
    this.#prune();
    const saved = this.#quotes.get(body.quoteId);
    assert(saved && saved.userId === userId && saved.expiresAt > this.clock(), 'QUOTE_EXPIRED', '算价已过期，请重新获取实付金额', 409);
    assert(!saved.execution, 'QUOTE_ALREADY_SUBMITTED', '这次算价已用于提交或结果待确认，请先核查订单状态', 409);
    const selection = body.fulfillment || {};
    const args = { ...structuredClone(saved.args) };
    let destination = { storeCode: saved.args.storeCode };
    if (args.orderType === 1) {
      assert(typeof selection.takeWayCode === 'string' && saved.quote.takeWayList.some(t => [t.code, t.takeWayCode].includes(selection.takeWayCode)), 'PICKUP_METHOD_REQUIRED', '请选择本次算价返回的取餐方式', 422);
      args.takeWayCode = selection.takeWayCode;
    } else {
      assert(typeof selection.addressId === 'string' && selection.addressId, 'DELIVERY_ADDRESS_REQUIRED', '请选择已验证的配送地址', 422);
      const addresses = unwrapMcp(await client.callRead('delivery-query-addresses', {})).data?.addresses;
      assert(Array.isArray(addresses) && addresses.some(a => a.addressId === selection.addressId), 'DELIVERY_ADDRESS_INVALID', '配送地址不属于当前账户', 422);
      const stores = unwrapMcp(await client.callRead('delivery-query-stores', { addressId: selection.addressId, beType: args.beType })).data;
      assert(Array.isArray(stores) && stores.some(s => s.storeCode === args.storeCode), 'DELIVERY_STORE_INVALID', '当前地址不可由所选门店配送', 422);
      args.addressId = selection.addressId;
      const selectedAddress = addresses.find(a => a.addressId === selection.addressId);
      destination = { addressId: selection.addressId, label: typeof selectedAddress.fullAddress === 'string' ? selectedAddress.fullAddress : null, contactName: typeof selectedAddress.contactName === 'string' ? selectedAddress.contactName : null, phone: typeof selectedAddress.phone === 'string' ? selectedAddress.phone : null };
    }
    if (body.remark !== undefined) {
      assert(args.orderType === 2 && typeof body.remark === 'string' && body.remark.length <= 50, 'INVALID_ORDER_REMARK', '外送备注最多 50 字');
      args.remark = body.remark;
    }
    // Exact create-order schema is checked but no write is made while preparing.
    const schema = await client.getOrderSchema();
    if (!Object.hasOwn(schema.properties || {}, 'orderType') && schema.additionalProperties === false) delete args.orderType;
    validateArguments(schema, args);
    const reviewedItems = [];
    for (const item of saved.args.items) {
      const fact = saved.quote.items.find(p => p.productCode === item.productCode);
      let name = typeof fact?.productName === 'string' ? fact.productName : item.productCode;
      if (item.roundList?.length) {
        const { items: ignoredItems, needTableware, ...context } = saved.args;
        const detail = unwrapMcp(await client.callRead('query-meal-detail', { ...context, code: item.productCode })).data;
        assert(detail?.code === item.productCode && Array.isArray(detail.rounds), 'ORDER_ITEMS_UNVERIFIED', '无法核实餐品规格，请重新选择', 422);
        assert(item.roundList.length === detail.rounds.length && new Set(item.roundList.map(r => r.round)).size === detail.rounds.length, 'ORDER_ITEMS_UNVERIFIED', '套餐轮次不完整，请重新选择', 422);
        const choices = item.roundList.flatMap(selected => {
          const round = detail.rounds.find(r => String(r.id) === selected.round);
          assert(round && Array.isArray(selected.comboItemList), 'ORDER_ITEMS_UNVERIFIED', '餐品规格已变化，请重新选择', 422);
          assert(new Set(selected.comboItemList.map(c => c.code)).size === selected.comboItemList.length, 'ORDER_ITEMS_UNVERIFIED', '套餐子项重复，请重新选择', 422);
          const count = selected.comboItemList.reduce((n, c) => n + c.quantity, 0);
          assert(Number.isSafeInteger(count) && count >= round.minQuantity && count <= round.maxQuantity, 'ORDER_ITEMS_UNVERIFIED', '套餐数量与餐厅规格不符，请重新选择', 422);
          return selected.comboItemList.map(choice => {
            const food = round.choices?.find(c => c.code === choice.code);
            assert(food && typeof food.name === 'string' && Number.isSafeInteger(choice.quantity) && choice.quantity > 0 && (food.maxQuantity == null || food.maxQuantity === -1 || choice.quantity <= food.maxQuantity), 'ORDER_ITEMS_UNVERIFIED', '餐品规格已变化，请重新选择', 422);
            return `${food.name} ×${choice.quantity}`;
          });
        });
        name = `${name}（${choices.join('、')}）`;
      }
      reviewedItems.push({ productCode: item.productCode, quantity: item.quantity, name });
    }
    const id = randomBytes(18).toString('base64url'); const nonce = randomBytes(32).toString('base64url');
    const review = { id, quoteId: saved.quote.id, total: saved.quote.total, currency: 'CNY', items: reviewedItems, destination, storeCode: saved.args.storeCode, reservationDate: saved.args.reservationDate || null, service: saved.args.orderType === 1 ? 'pickup' : 'delivery', fulfillment: selection, paymentMethod: 'provider-checkout', commitment: 'one-time', termsUrl: this.termsUrl, cancellationDisclosure: this.cancellationDisclosure, expiresAt: saved.quote.expiresAt, confirmationNonce: nonce };
    if (saved.activeProposal) { const previous = this.#proposals.get(saved.activeProposal); if (previous?.state === 'prepared') previous.state = 'superseded'; }
    saved.activeProposal = id;
    this.#proposals.set(id, { userId, nonce, args, quoteRecord: saved, quoteArgs: saved.args, quote: saved.quote, reviewHash: fingerprint(review), expiresAt: saved.expiresAt, state: 'prepared' });
    return { proposal: review, confirmationRequired: true, executionEnabled: this.enabled && !!this.termsUrl && !!this.cancellationDisclosure };
  }
  async confirm(userId, body, { client, reprice }) {
    assert(this.enabled, 'ORDERING_DISABLED', '真实下单尚未获得启用授权；未创建订单', 403);
    assert(this.termsUrl && this.cancellationDisclosure, 'ORDER_TERMS_UNVERIFIED', '请先核实服务协议和取消规则后再启用下单', 403);
    const p = this.#proposals.get(body.proposalId);
    assert(p && p.userId === userId, 'PROPOSAL_INVALID', '下单确认已失效', 409);
    const supplied = Buffer.from(typeof body.confirmationNonce === 'string' ? body.confirmationNonce : ''); const expected = Buffer.from(p.nonce);
    assert(supplied.length === expected.length && timingSafeEqual(supplied, expected), 'CONFIRMATION_INVALID', '下单确认凭证不匹配', 403);
    assert(body.confirmed === true && body.acceptedTerms === true && body.expectedTotal === p.quote.total && body.currency === 'CNY' && body.paymentMethod === 'provider-checkout', 'CONFIRMATION_REQUIRED', '请明确确认餐品、取餐方式、金额和服务协议', 422);
    if (p.state === 'completed') return p.result;
    if (p.state === 'pending') return p.promise;
    assert(p.state === 'prepared', 'ORDER_OUTCOME_UNCERTAIN', '上次提交的结果尚未确认，请先在麦当劳查询订单，不要重复下单', 409);
    assert(!p.quoteRecord.execution && p.quoteRecord.activeProposal === body.proposalId, 'QUOTE_ALREADY_SUBMITTED', '此算价已用于另一笔提交，请先核查订单状态', 409);
    assert(p.expiresAt > this.clock(), 'QUOTE_EXPIRED', '金额确认已过期，请重新算价', 409);
    p.state = 'pending';
    p.quoteRecord.execution = { state: 'pending', proposalId: body.proposalId };
    p.promise = (async () => {
      let attempted = false;
      try {
        const fresh = await reprice(p.quoteArgs);
        assert(fresh.quote.total === p.quote.total && fresh.quote.currency === p.quote.currency, 'PRICE_CHANGED', '实付金额已变化，请重新查看并确认', 409);
        if (p.args.orderType === 1) assert(fresh.quote.takeWayList?.some(t => [t.code, t.takeWayCode].includes(p.args.takeWayCode)), 'PICKUP_METHOD_CHANGED', '取餐方式已变化，请重新核对', 409);
        attempted = true;
        const result = unwrapMcp(await client.createConfirmedOrder(p.args, ORDER_CAPABILITY)).data;
        const paymentUrl = safePayUrl(result?.payH5Url);
        assert(typeof result?.orderId === 'string' && result.orderId && paymentUrl, 'ORDER_RESPONSE_UNVERIFIED', '订单返回结果不完整，请到麦当劳查询后再继续', 502);
        p.result = { orderId: result.orderId, paymentUrl, paymentStatus: 'not-verified', message: '订单已创建，请在麦当劳官方支付页面核对并完成支付' };
        p.state = 'completed'; p.quoteRecord.execution.state = 'completed'; return p.result;
      } catch (error) {
        p.state = attempted ? 'uncertain' : 'invalidated';
        p.quoteRecord.execution.state = p.state;
        if (attempted) throw new AppError('ORDER_OUTCOME_UNCERTAIN', '订单提交结果未能确认，请先在麦当劳查看订单，勿重复提交', 502);
        throw error;
      }
    })();
    return p.promise;
  }
}
