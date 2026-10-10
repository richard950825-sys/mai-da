# 运行与部署

## 完整源码

- `src/`：React 界面、浏览器本地热量估算、API 客户端。
- `server/`：Node HTTP 服务、McDonald's MCP、DeepSeek、套餐组合、核价、订单确认、目录与每日额度数据库。
- `cloudflare/`：公开前端的同源网关。
- `tests/`：单元、接口与 Playwright 检查；离线数据只用于测试。
- `scripts/`：真实供应商只读验证脚本。
- `public/`：公开静态素材与安全响应头。
- `ops/`：进程托管示例。

运行数据、密钥、真实用户日志、历史交接包、旧的未完成移植、`node_modules/` 和 `dist/` 不纳入源码版本。运行所需的当前前后端代码、静态证据数据、锁文件、测试与配置模板全部保留。

## 本机启动

需要 Node.js 22.13+ 的 `node:sqlite`；建议使用当前 Node.js LTS。

```sh
npm ci
cp .env.example .env.local
# 编辑 .env.local：设置自己的 DEEPSEEK_API_KEY
npm run build
npm start
```

访问 `/` 先浏览产品首页；点击“开始搭配”进入 `/connect`，连接成功后到 `/plan`。旧的 `/owner/setup` 连接地址继续可用。首页不调用账户或供应商接口。

默认示例端口是 8798。`PUBLIC_ACCESS=true` 表示每位访客使用个人麦当劳 Token；不是把服务直接监听到公网。服务仍绑定 `127.0.0.1`。本机开发不设置 `PUBLIC_ORIGIN`，保持 `TRUST_CLOUDFLARE_PROXY=false`。

`npm run dev` 启动 Vite，`/api` 自动代理到后端。任何密钥都不能使用 `VITE_` 前缀。

## 密钥和持久化

- `DEEPSEEK_API_KEY` 只从服务端环境读取，浏览器无需提交。
- 访客 Token 通过官方 MCP 验证后留在独立服务端会话，30 分钟无活动或重启后失效，不写入数据库。
- `data/catalog.sqlite` 为商品目录与分类缓存，`data/ai-quota.sqlite` 为按日 IP 哈希和 AI 使用次数。目录不要作为静态文件发布。
- 一次规划中多次模型处理共计一次操作；AI 菜单处理和 AI 检查使用同一日额度。开始 AI 处理后失败仍计次。非 AI 查询不占用额度。
- 每 IP 每天 10 次，北京时间零点重置。并发使用原子 SQLite 更新，换会话或重启不清零。
- 备份应保存在访问受限的目录中，绝不加入 Git。

## Cloudflare 公网前端

应用使用 **Cloudflare Workers Static Assets** 提供公开网页，地址为 `workers.dev`；不需要使用者建立 SSH 隧道。业务 API 由同源 `/api/*` 经 Workers VPC 私有绑定连到 Node 后端。模型密钥留在后端，不需要上传到 Cloudflare Worker。

1. 在部署机器上通过 `npx wrangler@4.149.0 login --device` 登录 Cloudflare。
2. 创建命名 Tunnel，并在后端机器常驻运行 `cloudflared`。凭据用权限 0600 的 token 文件或受保护的环境文件提供，不写进命令行、源代码、仓库或日志。
3. 建立指向 `127.0.0.1:8799` 的 HTTP VPC Service，将 ID 填入 `wrangler.jsonc` 的 `vpc_services`。仓库中的 Service ID 是本作品部署的非密钥标识；自行部署时必须替换成自己账号的 Service ID。
4. 后端环境设置 `PORT=8799`、`PUBLIC_ACCESS=true`、`PUBLIC_ORIGIN=https://你的正式站点.workers.dev`、`TRUST_CLOUDFLARE_PROXY=true`，并私密设置 `DEEPSEEK_API_KEY`。
5. 执行 `npm run build` 和 `npx wrangler@4.149.0 deploy`。只上传 `dist/` 与 `cloudflare/worker.mjs` 构成的部署产物。
6. 从正式 HTTPS 域名检查登录、规划和额度。确认真实访客 IP 经过 Cloudflare 传递，不能用客户端可任意指定的 `X-Forwarded-For` 计数。

`cloudflare/worker.mjs` 固定转发目的地，不接受客户端指定的上游地址。保留 Cookie、CSRF 和 Origin；拒绝跨站请求。后端仅在 loopback 私有入口信任 `CF-Connecting-IP`，HTTPS 下使用 Secure、HttpOnly、SameSite=Strict Cookie。API 禁止缓存。

VPC 连接需要 QUIC；遇到连接问题按 Cloudflare 官方文档检查服务器出站网络。单独的静态前端发布不能替代业务 API。多进程后端须共用同一持久化额度数据库。

官方参考：[Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/) · [Workers VPC](https://developers.cloudflare.com/workers-vpc/get-started/) · [Tunnel](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/)

## 真实下单

默认 `ALLOW_CONFIRMED_ORDERS=false`。若运营者决定开放，需配置有效的 `MCD_ORDER_TERMS_URL`、`MCD_CANCELLATION_DISCLOSURE`，并显式设置 `ALLOW_CONFIRMED_ORDERS=true`。无论该开关是否开启，模型都没有下单权限。

创建订单需要用户核对明细并提交最终确认。后端再次核价；金额变化需重新确认。重复请求合并处理，结果不确定时要求核对官方订单，不自动重试。支付在官方页面由用户完成。

## 检查

```sh
npm test
npm run build
npm run qa
npm run qa:landing
npm run qa:public
npm run qa:checkout
npm run qa:ordering
```

浏览器脚本使用 Playwright 与 Chromium/Chrome。可用 `CHROMIUM_PATH` 指定本机浏览器，`QA_OUTPUT` 指定仓库外截图目录。

`qa:live` 等真实供应商脚本会读取本机私密环境并消耗供应商请求额度；仅在你希望进行真实验证时运行。不得将包含 Token、地址、订单号或付款链接的调试材料公开。

## 参赛材料

根目录的 `CONTEST_DECLARATION.md` 从官方仓库原样复制。`MCP_INTEGRATION.md` 说明实际调用的工具及业务价值，`mcp-config.example.json` 使用环境变量占位符。README 保留产品介绍、目标用户、示例和安装方式。

官方报名需另外在赛事仓库提交标准格式 Issue，正文不超过 1000 字且不附图片。源码公开不代表已自动报名或获得资格确认。使用者应先确认官方声明与活动资格要求；本项目不申请 WorkBuddy 专项奖励。
