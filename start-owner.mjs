// Explicit local-user launch mode. No credentials or provider requests are created at startup.
// Personal MCP tokens enter through the form; the AI key stays in the server environment.
import { createApp } from './server/app.mjs';
const port = Number(process.env.PORT || 8788);
createApp({ catalogPath: process.env.MCD_CATALOG_DB || new URL('./data/catalog.sqlite', import.meta.url).pathname, logger: event => console.log(JSON.stringify(event)), port, visitorAccess: true, quotaPath: process.env.MCD_QUOTA_DB || new URL('./data/ai-quota.sqlite', import.meta.url).pathname, providerAccessEnabled: true, orderingEnabled: false })
  .createServer()
  .listen(port, '127.0.0.1', () => {
    console.log(`Private local app: http://127.0.0.1:${port}/`);
    console.log(`Direct owner entry: http://127.0.0.1:${port}/owner/setup`);
    console.log('Personal MCP session and server-side AI key; no real orders are enabled.');
  });
