import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  I18nError,
  createTranslator,
  isLocale,
  parseAcceptLanguage,
  resolveLocale,
  summarize,
  validateRecipe,
  type Locale,
  type Translator,
} from '@rssflow/core';
import { ROOT_DIR, config } from './config.ts';
import { FeedService, assertSelectors, runRecipe } from './runner.ts';
import { toJsonFeed, toRss } from './feed.ts';
import { detailPage, galleryPage } from './pages.ts';
import { assertPublicUrl, fetchStatic } from './fetcher.ts';
import { fetchDetail } from './details.ts';
import type { AiService } from './ai.ts';
import type { Store, StoredRecipe } from './store.ts';

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  locale: Locale;
  t: Translator;
  base: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
};

const LANG_COOKIE = 'rssflow_lang';

function cookie(req: IncomingMessage, name: string): string | undefined {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

function pickLocale(req: IncomingMessage, url: URL): Locale {
  const q = url.searchParams.get('lang');
  if (isLocale(q)) return q;
  const c = cookie(req, LANG_COOKIE);
  if (isLocale(c)) return c;
  return resolveLocale(parseAcceptLanguage(req.headers['accept-language']));
}

function baseUrl(req: IncomingMessage): string {
  if (config.publicUrl) return config.publicUrl;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] || 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined) || req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });
}

async function readJson(req: IncomingMessage, max = 200_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > max) throw new I18nError('err.bodyTooLarge', undefined, 413);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new I18nError('err.badJson');
  }
}

// 简单的按 IP 限流
const buckets = new Map<string, { count: number; reset: number }>();
function rateLimit(req: IncomingMessage): void {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() || req.socket.remoteAddress || '?';
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.reset < now) {
    buckets.set(ip, { count: 1, reset: now + 60_000 });
    if (buckets.size > 10_000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
    return;
  }
  if (++b.count > config.writeRatePerMinute) throw new I18nError('err.rateLimited', undefined, 429);
}

function publicView(s: StoredRecipe, base: string) {
  return {
    id: s.id,
    recipe: s.recipe,
    public: s.isPublic,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastCount: s.lastCount,
    lastMode: s.lastMode,
    lastRunAt: s.lastRunAt,
    feedUrl: `${base}/feed/${s.id}.xml`,
    jsonFeedUrl: `${base}/feed/${s.id}.json`,
    pageUrl: `${base}/r/${s.id}`,
  };
}

async function serveFile(res: ServerResponse, dir: string, rel: string): Promise<boolean> {
  const file = path.resolve(dir, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(dir + path.sep)) return false;
  try {
    const buf = await readFile(file);
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把抓到的网页改造成可在本地查看的样子：
 * 禁用原有脚本（保留内容，因为里面常有作品链接等数据）、去掉 CSP、补上 <base>，并注入选取面板。
 */
export function serverView(html: string, pageUrl: string, base: string): string {
  const inject = `<script>window.__RSSFLOW_SERVER__=${JSON.stringify(base)};window.__RSSFLOW_PAGE_URL__=${JSON.stringify(pageUrl)};</script><script src="${base}/dev/picker.js?v=${Date.now()}"></script>`;
  let out = html
    .replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi, '')
    .replace(/<script\b([^>]*)>/gi, (_m, attrs: string) => `<script${attrs.replace(/\stype=("[^"]*"|'[^']*'|\S+)/i, '')} type="text/rssflow-disabled">`);
  // styles.js 放在 <head> 最前面，模拟扩展在网页一开始加载时注入样式规则
  const baseTag = `<base href="${pageUrl.replace(/"/g, '&quot;')}"><meta name="referrer" content="no-referrer"><script src="${base}/dev/styles.js?v=${Date.now()}"></script>`;
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + baseTag) : baseTag + out;
  return /<\/body>/i.test(out) ? out.replace(/<\/body>(?![\s\S]*<\/body>)/i, inject + '</body>') : out + inject;
}

/** 示例接口：分页返回帖子（开发模式的 /demo/api-feed.html 用） */
function demoPosts(page: number, size: number) {
  const topics = ['品牌设计', '插画', '海报', '包装', 'UI 界面', '字体设计', '摄影', '动效', '空间设计', '产品设计'];
  const colors = [['#fed7aa', '#fca5a5'], ['#bfdbfe', '#c4b5fd'], ['#bbf7d0', '#99f6e4'], ['#fde68a', '#fdba74']];
  const now = Math.floor(Date.now() / 1000);
  const total = 30;
  const list = [];
  for (let i = (page - 1) * size; i < Math.min(page * size, total); i++) {
    const n = i + 1;
    list.push({
      id: 5000 + n,
      slug: `post-${5000 + n}`,
      title: `${topics[i % topics.length]}作品集 · 第 ${n} 期`,
      summary: `这是第 ${n} 期作品的简介，记录了从灵感、草图到最终交付的完整过程。`,
      url: `/posts/post-${5000 + n}`,
      cover: `/demo/covers/${n}.jpg`,
      published_at: now - n * 3 * 3600,
      time_ago: `${n * 3}小时前`,
      color: colors[i % colors.length],
      author: { id: 900 + n, name: `设计师${n}`, home: `/u/designer${n}`, avatar: `/demo/avatars/${n}.jpg` },
    });
  }
  return { code: 0, message: 'ok', data: { page, size, total, has_more: page * size < total, list } };
}

/** 示例详情页（开发模式）：带 og 标签、发布时间、正文，以及每页都一样的站点套话 */
function demoPostPage(id: number): string {
  const n = id - 5000;
  const topic = ['品牌设计', '插画', '海报', '包装', 'UI 界面', '字体设计', '摄影', '动效', '空间设计', '产品设计'][(n - 1) % 10];
  const angle = ['记录了从灵感到交付的过程', '分享了配色与排版的取舍', '复盘了与客户沟通的经验'][n % 3];
  const published = new Date(Date.now() - n * 3 * 3600_000).toISOString();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>作品集 · 第 ${n} 期 - 示例社区</title>
<meta property="og:title" content="作品集 · 第 ${n} 期">
<meta property="og:description" content="${topic}作品集 · 第 ${n} 期，本期主题是${topic}，${angle}，示例社区汇聚了上万名设计师与创作者。">
<meta property="og:image" content="/demo/covers/${n}.jpg">
<meta property="article:published_time" content="${published}">
<meta property="article:tag" content="设计"><meta name="author" content="设计师${n}"></head>
<body><header><nav><a href="/">首页</a><a href="/hot">热门</a></nav></header>
<main><article class="post-content"><h1>作品集 · 第 ${n} 期</h1>
<p>这一期我们从一次街头采风开始，记录下城市里被忽视的色彩和字体。设计师把这些素材整理成一套可以复用的视觉语言。</p>
<p>草图阶段尝试了十几个方向，最后保留了两个：一个偏向几何，一个偏向手写。经过三轮讨论，团队选择了把两者结合。</p>
<img src="/demo/covers/${n}-detail.jpg" alt="细节">
<p>最终交付包含标志、配色、海报模板和一组动效，客户反馈新的形象让品牌显得更年轻、更有温度。</p>
</article><aside class="related"><a href="/posts/post-5001">相关推荐一</a><a href="/posts/post-5002">相关推荐二</a></aside></main>
<footer>© 示例社区</footer></body></html>`;
}

export function createApp(store: Store, ai: AiService | null = null): http.Server {
  const feeds = new FeedService(store, ai);

  async function getStored(id: string): Promise<StoredRecipe> {
    const s = /^[a-z0-9]{6,20}$/.test(id) ? store.get(id) : undefined;
    if (!s) throw new I18nError('err.notFound', undefined, 404);
    return s;
  }

  async function handle(ctx: Ctx): Promise<void> {
    const { req, res, url, t, locale, base } = ctx;
    const p = url.pathname;
    const m = req.method || 'GET';

    if (m === 'OPTIONS') return send(res, 204, '', 'text/plain');

    // ---------- 页面 ----------
    if (m === 'GET' && p === '/') {
      const q = (url.searchParams.get('q') || '').slice(0, 100);
      return send(res, 200, galleryPage({ locale, t, recipes: store.listPublic({ q }), q, base }), MIME['.html']);
    }
    let r = p.match(/^\/r\/([a-z0-9]+)$/);
    if (m === 'GET' && r) {
      const stored = await getStored(r[1]);
      let result;
      let error: string | undefined;
      try {
        result = await feeds.get(stored);
      } catch (e) {
        error = e instanceof I18nError ? e.localize(locale) : t('err.internal');
      }
      return send(res, 200, detailPage({ locale, t, stored, result, error, base }), MIME['.html']);
    }

    // ---------- 订阅输出 ----------
    r = p.match(/^\/feed\/([a-z0-9]+)(\.xml|\.rss|\.json)?$/);
    if (m === 'GET' && r) {
      const stored = await getStored(r[1]);
      const result = await feeds.get(stored);
      const isJson = r[2] === '.json';
      const feedUrl = `${base}/feed/${stored.id}${isJson ? '.json' : '.xml'}`;
      const body = isJson ? toJsonFeed({ stored, result, feedUrl, t }) : toRss({ stored, result, feedUrl, t });
      const maxAge = Math.max(stored.recipe.refreshMinutes ?? 60, config.minRefreshMinutes) * 60;
      return send(res, 200, body, isJson ? 'application/feed+json; charset=utf-8' : 'application/rss+xml; charset=utf-8', {
        'cache-control': `public, max-age=${Math.min(maxAge, 600)}`,
      });
    }

    // ---------- API ----------
    if (m === 'GET' && p === '/api/health') {
      return sendJson(res, 200, { ok: true, name: 'rssflow', version: '0.1.0', locale, ai: !!ai?.available });
    }

    if (m === 'POST' && p === '/api/preview') {
      rateLimit(req);
      const body = (await readJson(req)) as { recipe?: unknown };
      const recipe = validateRecipe(body.recipe);
      assertSelectors(recipe);
      await assertPublicUrl(recipe.url);
      const result = await runRecipe(recipe);
      return sendJson(res, 200, {
        items: result.items.slice(0, 20),
        count: result.items.length,
        mode: result.mode,
        warning: result.warning?.localize(locale),
      });
    }

    // 试抓一个详情页：选取面板用它来告诉用户「详情页能不能抓、摘要长什么样」
    if (m === 'POST' && p === '/api/detail-preview') {
      rateLimit(req);
      const body = (await readJson(req)) as { url?: unknown; title?: unknown; utcOffset?: unknown };
      if (typeof body.url !== 'string') throw new I18nError('err.badUrl');
      await assertPublicUrl(body.url);
      const r = await fetchDetail(body.url, typeof body.utcOffset === 'number' ? body.utcOffset : undefined);
      store.saveDetail(body.url, r.status, r.data);
      const d = r.data;
      return sendJson(res, 200, {
        status: r.status,
        error: r.error,
        summary: d ? summarize(d, { title: typeof body.title === 'string' ? body.title : undefined }) : undefined,
        published: d?.published,
        image: d?.image,
        author: d?.author,
        tags: d?.tags,
        textLength: d?.text?.length ?? 0,
        imageCount: d?.images?.length ?? 0,
      });
    }

    if (p === '/api/recipes' && m === 'POST') {
      rateLimit(req);
      const body = (await readJson(req)) as { recipe?: unknown; public?: boolean };
      const recipe = validateRecipe(body.recipe);
      assertSelectors(recipe);
      await assertPublicUrl(recipe.url);
      const isPublic = body.public !== false;
      const { id, editToken } = store.create(recipe, isPublic);
      const stored = store.get(id)!;
      let result;
      let warning: string | undefined;
      try {
        result = await feeds.get(stored, true, 6, { aiInBackground: true });
        warning = result.warning?.localize(locale);
      } catch (e) {
        warning = e instanceof I18nError ? e.localize(locale) : t('err.internal');
      }
      return sendJson(res, 201, {
        ...publicView(store.get(id)!, base),
        editToken,
        count: result?.items.length ?? 0,
        mode: result?.mode,
        items: result?.items.slice(0, 5) ?? [],
        details: result?.details,
        aiPending: !!(ai?.available && stored.recipe.ai?.summary && stored.recipe.detail?.enabled),
        warning,
      });
    }

    if (p === '/api/recipes' && m === 'GET') {
      const list = store.listPublic({
        q: url.searchParams.get('q') || undefined,
        limit: Number(url.searchParams.get('limit')) || 50,
        offset: Number(url.searchParams.get('offset')) || 0,
      });
      return sendJson(res, 200, { recipes: list.map((s) => publicView(s, base)) });
    }

    r = p.match(/^\/api\/recipes\/([a-z0-9]+)$/);
    if (r) {
      const stored = await getStored(r[1]);
      if (m === 'GET') {
        if (url.searchParams.get('download')) {
          return send(res, 200, JSON.stringify(stored.recipe, null, 2), 'application/json; charset=utf-8', {
            'content-disposition': `attachment; filename="rssflow-${stored.id}.json"`,
          });
        }
        return sendJson(res, 200, publicView(stored, base));
      }
      if (!store.checkToken(stored.id, req.headers['x-edit-token'] as string | undefined)) throw new I18nError('err.forbidden', undefined, 403);
      if (m === 'PUT') {
        rateLimit(req);
        const body = (await readJson(req)) as { recipe?: unknown; public?: boolean };
        const recipe = validateRecipe(body.recipe);
        assertSelectors(recipe);
        await assertPublicUrl(recipe.url);
        store.update(stored.id, recipe, body.public ?? stored.isPublic);
        feeds.invalidate(stored.id);
        return sendJson(res, 200, publicView(store.get(stored.id)!, base));
      }
      if (m === 'DELETE') {
        store.delete(stored.id);
        feeds.invalidate(stored.id);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ---------- 开发用：示例页面与选取脚本 ----------
    if (config.dev && m === 'GET') {
      if (p.startsWith('/demo/') && (await serveFile(res, path.join(ROOT_DIR, 'packages/server/demo'), p.slice(6)))) return;
      const post = p.match(/^\/posts\/post-(\d+)$/);
      if (post) return send(res, 200, demoPostPage(Number(post[1])), MIME['.html']);
      if (p === '/demo/protected') return send(res, 200, '<html><script>var arg1="3f2a";document.cookie="acw_sc__v2="+arg1;location.reload()</script></html>', MIME['.html']);
      if (p === '/demo/api/posts') return sendJson(res, 200, demoPosts(Number(url.searchParams.get('page')) || 1, Number(url.searchParams.get('size')) || 8));
      if (p === '/dev/styles.js' && (await serveFile(res, path.join(ROOT_DIR, 'packages/extension/dist'), 'styles.js'))) return;
      if (p === '/dev/picker.js' && (await serveFile(res, path.join(ROOT_DIR, 'packages/extension/dist'), 'content.js'))) return;
      if (p === '/dev/view') {
        // 「服务器视角」：展示服务器静态抓到的网页，并注入选取面板
        const page = await fetchStatic(url.searchParams.get('url') || '');
        return send(res, 200, serverView(page.html, page.finalUrl, base), MIME['.html'], { 'cache-control': 'no-store' });
      }
    }

    throw new I18nError('err.notFound', undefined, 404);
  }

  return http.createServer(async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type,x-edit-token,accept-language');
    // 允许 https 网页里的脚本访问本机服务（Chrome 的 Private Network Access）
    res.setHeader('access-control-allow-private-network', 'true');
    res.setHeader('x-content-type-options', 'nosniff');
    const url = new URL(req.url || '/', 'http://localhost');
    const locale = pickLocale(req, url);
    const t = createTranslator(locale);
    if (isLocale(url.searchParams.get('lang'))) {
      res.setHeader('set-cookie', `${LANG_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`);
    }
    try {
      await handle({ req, res, url, locale, t, base: baseUrl(req) });
    } catch (e) {
      if (res.headersSent) return void res.end();
      const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/feed/');
      const status = e instanceof I18nError ? e.status : 500;
      const message = e instanceof I18nError ? e.localize(locale) : t('err.internal');
      if (!(e instanceof I18nError)) console.error(e);
      if (isApi) sendJson(res, status, { error: message, code: e instanceof I18nError ? e.key : 'err.internal' });
      else send(res, status, message, 'text/plain; charset=utf-8');
    }
  });
}
