import path from 'node:path';
import { config } from './config.ts';
import { Store } from './store.ts';
import { createApp } from './app.ts';
import { closeBrowser } from './fetcher.ts';
import { createAiService } from './ai.ts';

const store = new Store(path.join(config.dataDir, 'rssflow.db'));
const ai = createAiService(store);
const server = createApp(store, ai);

server.listen(config.port, config.host, () => {
  const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`RSSFlow server: ${url}`);
  if (config.dev) console.log(`Demo pages:     ${url}/demo/news.html  ${url}/demo/dynamic.html`);
  console.log(ai.available ? `AI summaries:   on (${config.aiModel}, max ${config.aiMaxPerHour}/hour)` : 'AI summaries:   off (set ANTHROPIC_API_KEY to turn on)');
  if (config.allowPrivate) console.log('Note: fetching private/intranet addresses is allowed (RSSFLOW_ALLOW_PRIVATE=1)');
});

async function shutdown() {
  server.close();
  await closeBrowser();
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
