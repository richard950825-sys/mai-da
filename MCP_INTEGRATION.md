# 麦搭的麦当劳 MCP 接入

## 使用的服务

麦搭实际调用麦当劳中国提供的远程 MCP Server：`https://mcp.mcd.cn`。官方说明见 [M-China/mcd-mcp-server](https://github.com/M-China/mcd-mcp-server)。客户端使用 Streamable HTTP、JSON-RPC、官方运行时工具 Schema，并处理会话、SSE 响应、超时与错误。

每位使用者在官方平台申请个人 Token，经网页提交至本站服务端验证。Token 不写入浏览器存储，不发送给 DeepSeek，不出现在源代码或提交材料中。配置示例位于根目录 `mcp-config.example.json`，授权字段仅使用环境变量占位符。

## 实际调用的工具与价值

| 官方 Tool | 在麦搭中的用途 | 用户价值 |
| --- | --- | --- |
| `query-nearby-stores` | 按城市和地标查询自取餐厅 | 先选具体餐厅，避免脱离门店推荐 |
| `delivery-query-addresses` | 由用户主动读取已有配送地址 | 复用官方账户地址，不把地址发送给模型 |
| `delivery-query-stores` | 查询所选地址可配送的餐厅 | 在真实可送范围内规划 |
| `query-meals` | 查询餐厅在指定取餐时间的菜单 | 按当次供餐情况选择餐品 |
| `query-meal-detail` | 查询单品与多轮套餐可选规格 | 保留套餐内实际主食、配餐和饮品 |
| `list-nutrition-foods` | 读取官方营养记录 | 支持热量与营养偏好；缺失值保持未知 |
| `query-store-coupons` | 读取当前餐厅可用优惠券 | 核验可用的优惠，而非凭券名猜折扣 |
| `calculate-price` | 查询餐品、数量、优惠后的完整价格 | 用官方核价确认预算和结算金额 |
| `create-order` | 单独的用户确认流程后创建订单 | 用户先核对明细，再进入官方支付页面 |

`now-time-info` 在只读白名单中保留，但不是当前主界面的必要调用；不将其列为已展示功能。未调用的领券、积分兑换、取消订单、写地址等工具不开放给模型或通用接口。

## 从一句需求到一份可核对的餐

1. 使用者连接个人 MCP Token；服务端执行 MCP 初始化及 `tools/list` 校验，成功后建立独立会话。
2. 使用者选择餐厅和取餐时间，页面读取当前菜单概况。
3. 在使用者同意后，DeepSeek 将用餐文字解析成预算、人数、口味和营养条件。模型不持有麦当劳 Token，不具有下单工具。
4. 服务端读取实时菜单、商品规格、营养和优惠券。未提供的事实不会由模型补齐。
5. 程序按照人数和条件组合餐品，用 `calculate-price` 核对价格，展示符合条件的候选。
6. 使用者选餐、改数量后重新核价，随后核对不可变的订单明细、取餐方式、金额与条款。
7. 只有部署者启用了下单，且使用者主动勾选并提交最终确认，服务端才调用 `create-order`。提交前再核价；重复提交合并处理，结果不确定时不会自动重试。
8. 使用者前往麦当劳返回的官方 HTTPS 支付页面。麦搭不代为支付，也不把跳转支付页当成付款成功。

## 可以从源码核查的实现

- `server/mcp.mjs`：真实 MCP 传输、官方 Schema 验证、只读工具白名单及独立订单能力。
- `server/app.mjs`：身份、CSRF、接口路由、实时菜单和规划流程。
- `server/owner.mjs`：个人 Token 会话与超时。
- `server/catalog.mjs`、`server/product-mapping.mjs`、`server/meal-composition.mjs`：商品理解、目录缓存与多轮套餐配置。
- `server/recommend.mjs`、`server/coupons.mjs`：有界候选搜索与实际券价比较，不承诺全局最低价。
- `server/orders.mjs`：订单复核、一次性确认、价格变化与不确定结果保护。
- `server/ai-quota.mjs`：每 IP 每日 10 次 AI 操作，持久化和原子计数。
- `cloudflare/worker.mjs`：公开前端的同源 API 网关；供应商密钥留在后端。

## 验证说明

README 中的桌面和手机画面来自实际应用，使用真实麦当劳菜单和实时核价生成；截图过程没有创建真实订单或付款。自动化单元/接口测试中的供应商响应是明确标注的离线测试数据，不会作为应用运行时的后备菜单。

价格、供应、优惠资格与取餐选项均依赖所选餐厅及查询时间。营养数据缺失、套餐规格不支持或上游服务异常时会明确提示，不以成功结果替代失败。完整操作说明见 `docs/DEVELOPMENT.md`。
