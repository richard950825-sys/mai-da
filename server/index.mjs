import { createApp } from './app.mjs';
const port = Number(process.env.PORT || 8788);
const publicOrigin = process.env.PUBLIC_ORIGIN;
if (publicOrigin && (new URL(publicOrigin).origin !== publicOrigin || !publicOrigin.startsWith('https://'))) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin');
if (publicOrigin && process.env.PUBLIC_ACCESS !== 'true') throw new Error('PUBLIC_ORIGIN requires PUBLIC_ACCESS=true');
if (process.env.TRUST_CLOUDFLARE_PROXY === 'true' && !publicOrigin) throw new Error('Trusted Cloudflare ingress requires PUBLIC_ORIGIN');
const app = createApp({
  visitorAccess: process.env.PUBLIC_ACCESS === 'true',
  quotaPath: process.env.MCD_QUOTA_DB || new URL('../data/ai-quota.sqlite', import.meta.url).pathname,
  trustCloudflare: process.env.TRUST_CLOUDFLARE_PROXY === 'true',
  secureCookies: !!publicOrigin,
  ...(publicOrigin ? { allowedOrigins: [publicOrigin, `http://127.0.0.1:${port}`, `http://localhost:${port}`] } : {}),
  catalogPath: process.env.MCD_CATALOG_DB || new URL('../data/catalog.sqlite', import.meta.url).pathname,
  logger: event => console.log(JSON.stringify(event)),
  port,
  ownerSetupEnabled: process.env.ALLOW_LOCAL_OWNER_SETUP === 'true',
  providerAccessEnabled: process.env.ALLOW_PROVIDER_ACCESS === 'true',
  allowLocalEnvCredentials: process.env.ALLOW_LOCAL_ENV_CREDENTIALS === 'true',
  orderingEnabled: process.env.ALLOW_CONFIRMED_ORDERS === 'true',
  orderTermsUrl: process.env.MCD_ORDER_TERMS_URL || null,
  cancellationDisclosure: process.env.MCD_CANCELLATION_DISCLOSURE || null,
  deepseekModel: process.env.DEEPSEEK_MODEL,
});
app.createServer().listen(port, '127.0.0.1', () => {
  console.log(`Meal planner listening on http://127.0.0.1:${port}; credentials are never logged`);
});
