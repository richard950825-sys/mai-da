# HTTP API

所有接口位于同源 `/api` 下，JSON 请求使用 `Content-Type: application/json`。供应商密钥不出现在响应中。

## 连接与身份

| 接口 | 行为 |
| --- | --- |
| `GET /status`、`GET /health` | 返回版本、账户是否已连接、AI 是否配置及 `aiQuota`，不回传密钥 |
| `GET /owner/setup/status` | 创建或更新 HttpOnly、SameSite=Strict 会话，返回 CSRF token；公网 HTTPS 增加 Secure |
| `POST /owner/setup` | 仅接受 `{mcdToken}`，验证官方 MCP 后连接当前访客账户；不接受浏览器提供 LLM key |
| `DELETE /owner/setup` | 清除当前会话的账户凭据及关联报价 |
| `POST /owner/setup/verify` | `{provider:"mcd"}` 检查 MCP，或 `{provider:"deepseek",aiConsent:true}` 检查 AI；后者计入每日额度 |

公开模式下，连接之后的数据接口要求有效个人 Token 会话。POST/DELETE 还要求同源 `Origin` 和匹配会话的 `X-CSRF-Token`。会话在 30 分钟无活动或重启后失效。`receiptScope` 是非认证用途的账户哈希，仅用于浏览器订单回执隔离，不能代替 Cookie 或 Token。

私密调试兼容接口 `/providers/verify` 和自定义 `resolveUser` 模式不用于公开站点；不得把本机共享账户模式直接暴露给 Cloudflare 请求。

## 查询与规划

| 接口 | 输入要点 | 结果 |
| --- | --- | --- |
| `GET /mcp/tools` | 无 | 官方当前只读工具 Schema |
| `GET /nutrition` | 无 | 官方营养，缺失值为 null |
| `GET /addresses` | 由用户主动选择配送场景 | 当前账户已有配送地址 |
| `POST /stores/search` | `{mode,city,query}`；配送时提供 `addressId` | 可用餐厅、营业与预约信息 |
| `POST /menu/overview` | `{storeContext}` | 当前餐厅/时间的菜单和供餐概况 |
| `POST /menu` | `{storeContext,aiConsent?}` | 商品、可选规格、营养和目录状态 |
| `POST /coupons` | `{storeContext}` | 当前餐厅可用优惠券 |
| `POST /quote` | `{storeContext,items}` | 官方完整报价、取餐选项和报价有效期 |
| `POST /recommendations` | 用餐需求、结构化偏好及所选餐厅 | 已核价候选、条件摘要和未满足原因 |
| `POST /mcp/read` | `{name,arguments}` | 仅支持源码中的只读白名单，按官方 Schema 验证 |

`storeContext` 包含 `storeCode`、`orderType`、`beType`，以及需要时的 `beCode`、`reservationDate`。预约时间为北京时间 `YYYY-MM-DD HH:mm`，需使用餐厅提供的可用时段。

`items` 含 `productCode`、正整数 `quantity`，以及适用的 `roundList`、`couponId`、`couponCode`。餐品、规格和数量都需由官方核价确认。

规划输入支持 `text`、`mealTarget`、`budget`、`preferences`、`storeContext`、`aiConsent`。人数为 1–6，预算和营养按整餐计算。自然语言需要 `aiConsent:true`。手动设置通过 `preferStructuredTarget`、`preferStructuredBudget`、`preferStructuredPreferences`、`preferStructuredPeople` 明确优先级。

营养不能核实的餐品不会满足对应营养硬限制。无糖与普通可乐按有依据的商品属性筛选，糖克数不从名称或碳水推算。候选搜索和优惠比较有界，不承诺穷尽组合或全局最低价。

## AI 日额度

每个 IP 每天最多 10 次 AI 操作，北京时间零点重置。一次请求中的解析、商品分类和排序共享一次额度；AI 检查及同意 AI 的菜单请求使用同一入口。开始 AI 处理后失败或重试均计次。非 AI 的查询、核价和订单确认不计次。

额度持久化在 SQLite，并原子更新。额度不足返回 HTTP 429，代码为 `AI_DAILY_LIMIT`，附 `Retry-After`、`resetsAt` 和剩余次数；不会继续调用模型。直接连接只使用 socket IP；只有显式配置的本机 Cloudflare Tunnel 入口才接受有效 `CF-Connecting-IP`。不信任 `X-Forwarded-For`。

## 下单

- `POST /orders/prepare` 接受当前账户的 `quoteId` 与 `fulfillment`，返回不可变订单提案、确认 nonce、适用条款及是否允许执行。
- `POST /orders/confirm` 需要提案 ID、确认 nonce、`confirmed:true`、`acceptedTerms:true`、已核对的金额与币种，并通过 CSRF 校验。
- 创建前重新核价。报价变化或取餐方式变化需重新确认，重复提交合并，未知结果不会自动重试。
- 成功结果包含订单号和官方 HTTPS 支付页，不代表已经付款。Token 更换后旧账户提案不可提交。

## 错误与隐私

错误统一为 `{error:{code,message,requestId,details?}}`。常见状态包括 401 未连接、403 来源/CSRF 不通过、422 输入或条件无效、429 额度/上游限流、502 上游异常。请求 ID 可用于定位受控日志，日志不记录密钥、请求正文、私人地址或订单明细。

协议与字段校验以 `server/` 实现及官方运行时 Schema 为准。界面、网关、供应商传输与订单路径均有测试，可运行 `npm test` 核查。
