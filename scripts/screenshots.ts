/**
 * 生成 README 里的界面截图（中英文各一套），保存到 docs/images/。
 *
 *   npm run screenshots
 *
 * 会单独启动一个使用临时空数据库的服务端（端口 8790），只用项目自带的示例页面，
 * 所以截图里不会出现任何真实网站或你自己的数据。需要先运行过 npm run build:ext。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = path.join(ROOT, 'docs/images');
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const LOCALES = ['zh-CN', 'en'] as const;
type Loc = (typeof LOCALES)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 临时服务端 ----------

const dataDir = mkdtempSync(path.join(tmpdir(), 'rssflow-shots-'));
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'packages/server/src/index.ts'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), RSSFLOW_DATA_DIR: dataDir, RSSFLOW_DEV: '1', RSSFLOW_ALLOW_PRIVATE: '1', RSSFLOW_UPDATE_CHECK: '0', ANTHROPIC_API_KEY: '' },
  stdio: 'ignore',
});
const cleanup = () => {
  server.kill();
  rmSync(dataDir, { recursive: true, force: true });
};
process.on('exit', cleanup);

for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${BASE}/api/health`)).ok) break;
  } catch {
    /* 还没启动 */
  }
  await sleep(200);
}

// 规则市场里放几条示例规则
const seed = async (name: string, recipe: Record<string, unknown>) =>
  fetch(`${BASE}/api/recipes`, { method: 'POST', body: JSON.stringify({ recipe: { name, ...recipe }, public: true }) });
await seed('示例新闻 · 今日要闻', {
  url: `${BASE}/demo/news.html`,
  itemSelector: 'li.news-item',
  utcOffset: 480,
  fields: { title: { selector: 'h3' }, link: { selector: 'h3 > a', attr: 'href' }, date: { selector: 'span.time' }, image: { selector: 'img', attr: 'src' }, summary: { selector: 'p.desc' } },
});
await seed('示例社区 · 最新作品', {
  url: `${BASE}/demo/api-feed.html`,
  itemSelector: 'div[class*="_card"]',
  fields: { title: { selector: 'span[class*="_title"]' } },
  api: { url: `${BASE}/demo/api/posts?page=1&size=8`, listPath: 'data.list', fields: { title: '{title}', link: '{url}', date: '{published_at}', image: '{cover}', summary: '{summary}', author: '{author.name}' } },
});
await seed('Demo Blog', {
  url: `${BASE}/demo/dynamic.html`,
  mode: 'render',
  itemSelector: 'article.post-card',
  fields: { title: { selector: 'a.post-title' }, link: { selector: 'a.post-title', attr: 'href' }, date: { selector: 'time', attr: 'datetime' }, summary: { selector: 'p.excerpt' } },
});

// ---------- 截图 ----------

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

async function newPage(loc: Loc, width = 1280, height = 800): Promise<Page> {
  const ctx = await browser.newContext({ locale: loc, viewport: { width, height }, deviceScaleFactor: 1 });
  return ctx.newPage();
}

async function injectPicker(page: Page, tool: 'rss' | 'style'): Promise<void> {
  await page.evaluate(`window.__RSSFLOW_SERVER__ = ${JSON.stringify(BASE)}; window.__RSSFLOW_TOOL__ = ${JSON.stringify(tool)};`);
  await page.addScriptTag({ url: `${BASE}/dev/picker.js?v=${Date.now()}` });
  await page.waitForSelector('rssflow-picker', { state: 'attached' });
  await sleep(300);
}

const shadow = (page: Page, sel: string) => page.locator('rssflow-picker').locator(sel);

/** 1. 生成 RSS：点一张卡片，识别出整个列表，并发现数据接口 */
async function shotPicker(loc: Loc): Promise<void> {
  const page = await newPage(loc);
  await page.goto(`${BASE}/demo/api-feed.html`);
  await page.waitForSelector('.Fe3dQx_card');
  await injectPicker(page, 'rss');
  await page.locator('.Fe3dQx_title').nth(1).click();
  await shadow(page, '.check.api').waitFor({ timeout: 5000 });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, `picker-${loc}.png`) });
  await page.context().close();
}

/** 2. 去广告 / 样式编辑：选中一张卡片，改背景色和圆角，看盒模型 */
async function shotStyleEditor(loc: Loc): Promise<void> {
  const page = await newPage(loc);
  await page.goto(`${BASE}/demo/api-feed.html`);
  await page.waitForSelector('.Fe3dQx_card');
  await injectPicker(page, 'style');
  await page.locator('.Fe3dQx_title').nth(4).click();
  await shadow(page, '[data-tab="edit"]').click();
  await shadow(page, 'input[type=text][data-prop="background-color"]').fill('#fff4e6');
  await shadow(page, 'input[type=text][data-prop="background-color"]').press('Enter');
  await shadow(page, 'input[type=range][data-prop="border-radius"]').fill('28');
  await shadow(page, 'input[type=range][data-prop="border-radius"]').dispatchEvent('change');
  await sleep(300);
  await page.screenshot({ path: path.join(OUT, `style-editor-${loc}.png`) });
  await page.context().close();
}

/** 3. 扩展弹窗：两个主按钮、我的订阅、本站样式规则、新版本提示 */
async function shotPopup(loc: Loc): Promise<void> {
  const page = await newPage(loc, 360, 640);
  const zh = loc === 'zh-CN';
  const mine = [
    { id: 'a1', name: zh ? '示例新闻 · 今日要闻' : 'Example News · Today', feedUrl: `${BASE}/feed/a1.xml`, pageUrl: `${BASE}/r/a1`, editToken: '', sourceUrl: 'https://news.example.com/', createdAt: 0 },
    { id: 'a2', name: zh ? '示例社区 · 最新作品' : 'Example Community · New', feedUrl: `${BASE}/feed/a2.xml`, pageUrl: `${BASE}/r/a2`, editToken: '', sourceUrl: 'https://community.example.com/', createdAt: 0 },
    { id: 'a3', name: 'Demo Blog', feedUrl: `${BASE}/feed/a3.xml`, pageUrl: `${BASE}/r/a3`, editToken: '', sourceUrl: 'https://blog.example.com/', createdAt: 0 },
  ];
  const rules = [1, 2, 3].map((i) => ({ id: `r${i}`, selector: `.ad-${i}`, action: 'hide', label: 'ad', enabled: true, createdAt: 0 }));
  // 截图环境里没有真正的扩展 API：用一个假的 chrome 对象代替
  await page.addInitScript(
    ({ base, mine, rules }) => {
      const local: Record<string, unknown> = { mine, 'styles:news.example.com': { rules } };
      const area = (store: Record<string, unknown>) => ({
        get: async (k?: string | string[]) => {
          const keys = k === undefined ? Object.keys(store) : Array.isArray(k) ? k : [k];
          return Object.fromEntries(keys.filter((x) => x in store).map((x) => [x, store[x]]));
        },
        set: async (o: Record<string, unknown>) => void Object.assign(store, o),
        remove: async () => {},
      });
      (window as unknown as { chrome: unknown }).chrome = {
        runtime: { id: 'rssflow', getManifest: () => ({ version: '0.2.5' }), sendMessage: async () => ({ ok: true, data: { ok: true } }) },
        storage: { sync: area({ serverUrl: base, locale: 'auto' }), local: area(local), session: area({}), onChanged: { addListener() {} } },
        tabs: { query: async () => [{ id: 1, url: 'https://news.example.com/' }] },
        permissions: { request: async () => true },
        scripting: { executeScript: async () => [] },
      };
    },
    { base: BASE, mine, rules },
  );
  // 新版本提示：模拟 GitHub 上有一个更新的版本
  await page.route('https://api.github.com/**', (route) =>
    route.fulfill({
      json: {
        tag_name: 'v0.2.8',
        html_url: 'https://github.com/Wonvy/RSSFlow/releases/tag/v0.2.8',
        assets: [{ name: 'rssflow-extension.zip', browser_download_url: 'https://github.com/Wonvy/RSSFlow/releases/download/v0.2.8/rssflow-extension.zip' }],
      },
    }),
  );
  await page.goto(`${BASE}/dev/ext/popup.html`);
  await page.locator('#update:not([hidden])').waitFor({ timeout: 5000 });
  await sleep(200);
  await page.locator('body').screenshot({ path: path.join(OUT, `popup-${loc}.png`) });
  await page.context().close();
}

/** 4. 规则市场 */
async function shotGallery(loc: Loc): Promise<void> {
  const page = await newPage(loc, 1100, 560);
  await page.goto(`${BASE}/?lang=${loc}`);
  await sleep(200);
  await page.screenshot({ path: path.join(OUT, `gallery-${loc}.png`) });
  await page.context().close();
}

try {
  for (const loc of LOCALES) {
    await shotPicker(loc);
    await shotStyleEditor(loc);
    await shotPopup(loc);
    await shotGallery(loc);
    console.log(`✓ ${loc}`);
  }
  console.log(`截图已保存到 ${path.relative(ROOT, OUT)}/`);
} finally {
  await browser.close();
  cleanup();
}
