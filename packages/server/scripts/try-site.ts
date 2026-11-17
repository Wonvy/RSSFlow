/**
 * 开发工具：在真实网站上试用选取面板（无头浏览器，绕过网页 CSP）。
 *
 *   node packages/server/scripts/try-site.ts <网址> <条目里的一段文字> [--create] [--out 截图.png] [--scroll N]
 *
 * 文字也可以写成 css:选择器，例如 css:.card .title（适合内容每次都不一样的推荐流）。
 * 会打开网页 → 注入扩展的选取脚本 → 点击包含该文字的元素 → 打印识别出的规则和预览 → 截图。
 * 加 --create 时，还会让本地服务器（http://localhost:8787）保存规则并打印服务器的抓取结果。
 * 加 --via-server 时，通过开发服务器的「服务器视角」页面打开（/dev/view），
 *   适合会拦截无头浏览器的网站（比如有滑块验证的站点）；需要先运行 npm run dev。
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith('--') ? 2 : 1);
  return v && !v.startsWith('--') ? v : 'true';
};
const create = !!flag('--create');
const viaServer = !!flag('--via-server');
const out = flag('--out') || 'try-site.png';
const scrolls = Number(flag('--scroll') || 0);
const server = flag('--server') || 'http://localhost:8787';
const [url, text] = args;
if (!url || !text) {
  console.error('usage: node packages/server/scripts/try-site.ts <url> <text-in-an-item> [--create] [--out file.png] [--scroll N]');
  process.exit(1);
}

const picker = fileURLToPath(new URL('../../extension/dist/content.js', import.meta.url));
const browser = await chromium.launch();
const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
try {
  await page.goto(viaServer ? `${server}/dev/view?url=${encodeURIComponent(url)}` : url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  for (let i = 0; i < scrolls; i++) {
    await page.evaluate('window.scrollBy(0, window.innerHeight)');
    await page.waitForTimeout(800);
  }
  if (!viaServer) {
    await page.evaluate(`window.__RSSFLOW_SERVER__ = ${JSON.stringify(server)}`);
    await page.addScriptTag({ path: picker });
  }
  await page.waitForSelector('rssflow-picker', { state: 'attached' });

  const target = await page.evaluateHandle((t) => {
    if (t.startsWith('css:')) return document.querySelector(t.slice(4));
    const all = [...document.querySelectorAll('body *')].filter((e) => !e.closest('rssflow-picker'));
    return all.find((e) => e.children.length === 0 && (e.textContent || '').includes(t)) || all.find((e) => (e.textContent || '').includes(t) && e.children.length < 3) || null;
  }, text);
  const el = target.asElement();
  if (!el) throw new Error(`no element contains: ${text}`);
  await el.scrollIntoViewIfNeeded();
  await el.click({ force: true });
  await page.waitForTimeout(400);

  const panel = () => page.evaluate(() => (document.querySelector('rssflow-picker')!.shadowRoot!.querySelector('.body') as HTMLElement).innerText);
  console.log('===== panel =====\n' + (await panel()));
  console.log('===== draft recipe =====\n' + JSON.stringify(await page.evaluate('window.__rssflowPicker.draft()'), null, 2));
  await page.screenshot({ path: out });
  console.log(`screenshot: ${out}`);

  if (create) {
    await page.evaluate(() => (document.querySelector('rssflow-picker')!.shadowRoot!.querySelector('[data-act="create"]') as HTMLElement).click());
    await page.waitForFunction(() => !document.querySelector('rssflow-picker')!.shadowRoot!.querySelector('[data-act="create"]'), null, { timeout: 90_000 }).catch(() => {});
    console.log('===== after create =====\n' + (await panel()));
  }
} finally {
  await browser.close();
}
