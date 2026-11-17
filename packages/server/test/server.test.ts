import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.RSSFLOW_DEV = '1';
process.env.RSSFLOW_ALLOW_PRIVATE = '1';
process.env.RSSFLOW_UPDATE_CHECK = '0'; // 测试不访问 GitHub

const { Store } = await import('../src/store.ts');
const { createApp } = await import('../src/app.ts');
const { closeBrowser } = await import('../src/fetcher.ts');

let server: Server;
let base = '';

beforeAll(async () => {
  server = createApp(new Store(':memory:'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await closeBrowser();
});

const newsRecipe = () => ({
  name: '示例新闻',
  url: `${base}/demo/news.html`,
  mode: 'auto',
  itemSelector: 'li.news-item',
  utcOffset: 480,
  fields: {
    title: { selector: 'h3' },
    link: { selector: 'h3 > a', attr: 'href' },
    date: { selector: 'span.time' },
    image: { selector: 'img', attr: 'src' },
    summary: { selector: 'p.desc' },
  },
});

describe('server', () => {
  it('creates a recipe and serves RSS + JSON Feed', async () => {
    const res = await fetch(`${base}/api/recipes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recipe: newsRecipe(), public: true }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.count).toBe(5);
    expect(created.mode).toBe('static');
    expect(created.editToken).toBeTruthy();

    const rss = await (await fetch(created.feedUrl)).text();
    expect(rss).toContain('<title>示例新闻</title>');
    expect(rss).toContain(`<link>${base}/news/1001.html</link>`);
    expect(rss).toContain('<pubDate>Tue, 17 Nov 2026 01:30:00 GMT</pubDate>');
    expect((rss.match(/<item>/g) || []).length).toBe(5);

    const json = await (await fetch(created.jsonFeedUrl)).json();
    expect(json.items[0].image).toBe(`${base}/img/1.jpg`);

    const gallery = await (await fetch(`${base}/?lang=en`)).text();
    expect(gallery).toContain('Recipe Gallery');
    expect(gallery).toContain('示例新闻');
    const galleryZh = await (await fetch(`${base}/`, { headers: { 'accept-language': 'zh-CN' } })).text();
    expect(galleryZh).toContain('规则市场');

    const detail = await (await fetch(created.pageUrl)).text();
    expect(detail).toContain('国产大模型发布新版本');
  });

  it('localizes API errors', async () => {
    const bad = { ...newsRecipe(), url: 'ftp://example.com' };
    const zh = await fetch(`${base}/api/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-language': 'zh-CN' },
      body: JSON.stringify({ recipe: bad }),
    });
    expect(zh.status).toBe(400);
    expect(await zh.json()).toEqual({ error: '只支持 http / https 网址', code: 'err.protocol' });
    const en = await fetch(`${base}/api/preview?lang=en`, { method: 'POST', body: JSON.stringify({ recipe: bad }) });
    expect((await en.json()).error).toBe('Only http / https URLs are supported');
  });

  it('rejects edits without the edit token', async () => {
    const created = await (
      await fetch(`${base}/api/recipes`, { method: 'POST', body: JSON.stringify({ recipe: newsRecipe() }) })
    ).json();
    const denied = await fetch(`${base}/api/recipes/${created.id}`, { method: 'DELETE' });
    expect(denied.status).toBe(403);
    const ok = await fetch(`${base}/api/recipes/${created.id}`, { method: 'DELETE', headers: { 'x-edit-token': created.editToken } });
    expect(ok.status).toBe(200);
  });

  it('falls back to browser rendering for JS-only pages', async () => {
    const res = await fetch(`${base}/api/preview`, {
      method: 'POST',
      body: JSON.stringify({
        recipe: {
          url: `${base}/demo/dynamic.html`,
          itemSelector: 'article.post-card',
          fields: { title: { selector: 'a.post-title' }, link: { selector: 'a.post-title', attr: 'href' }, date: { selector: 'time', attr: 'datetime' } },
        },
      }),
    });
    const data = await res.json();
    if (data.warning?.includes('playwright')) {
      console.warn('skipped: chromium not installed —', data.warning);
      return;
    }
    expect(data.mode).toBe('render');
    expect(data.count).toBe(4);
    expect(data.items[0]).toMatchObject({ title: 'Why RSS is still the best way to follow the web', date: '2026-11-16T08:00:00.000Z' });
  });
});

const { isVerificationPage } = await import('../src/runner.ts');
const { serverView } = await import('../src/app.ts');

describe('card feeds without <a> links', () => {
  it('serves links recovered from page data and stable first-seen dates', async () => {
    const recipe = {
      name: 'Card feed',
      url: `${base}/demo/card-feed.html`,
      itemSelector: 'div[class*="_cardCell"]',
      fields: {
        title: { selector: 'span[class*="_title"]' },
        link: { selector: '', from: 'data', prefixes: ['https://www.design.example.cn/work/', 'https://www.design.example.cn/article/'] },
        image: { selector: 'img[class*="_CardImage"]', attr: 'src' },
      },
    };
    const created = await (await fetch(`${base}/api/recipes`, { method: 'POST', body: JSON.stringify({ recipe }) })).json();
    expect(created.count).toBe(7);
    const feed = await (await fetch(created.jsonFeedUrl)).json();
    expect(feed.items[2].url).toBe('https://www.design.example.cn/article/Ar201.html');
    // 没有时间的条目使用首次发现时间：按页面顺序递减
    const dates = feed.items.map((i: { date_published: string }) => Date.parse(i.date_published));
    expect(dates.every((d: number, i: number) => i === 0 || d < dates[i - 1])).toBe(true);
    const rss = await (await fetch(created.feedUrl)).text();
    expect(rss).toContain('referrerpolicy=&quot;no-referrer&quot;');
    expect(rss).toContain('type="image/webp"');
  });

  it('keeps first-seen dates stable across refreshes', async () => {
    const store = new Store(':memory:');
    const first = store.firstSeen('r1', ['a', 'b'], 1_000_000);
    const again = store.firstSeen('r1', ['c', 'a', 'b'], 2_000_000);
    expect(again.get('a')).toBe(first.get('a'));
    expect(again.get('b')).toBe(first.get('b'));
    expect(again.get('c')).toBe(2_000_000);
  });
});

describe('anti-bot pages', () => {
  it('recognises verification pages but not normal articles', () => {
    expect(isVerificationPage('Verification', 'Access Verification For better experience, please slide to complete the verification')).toBe(true);
    expect(isVerificationPage('安全验证', '请完成下方验证后继续访问')).toBe(true);
    expect(isVerificationPage('Just a moment...', 'Checking your browser before accessing')).toBe(true);
    expect(isVerificationPage('如何设计更好的验证码', '正文'.repeat(2000))).toBe(false);
  });
});

describe('server view (dev)', () => {
  it('disables scripts but keeps their data, and injects the picker', () => {
    const out = serverView(
      '<html><head><meta http-equiv="Content-Security-Policy" content="script-src none"></head><body><script type="module">self.x=1</script></body></html>',
      'https://example.com/list',
      'http://localhost:8787',
    );
    expect(out).not.toContain('Content-Security-Policy');
    expect(out).toContain('<script type="text/rssflow-disabled">self.x=1</script>');
    expect(out).toContain('<base href="https://example.com/list">');
    expect(out).toContain('src="http://localhost:8787/dev/picker.js?v=');
  });
});

describe('data API mode', () => {
  const apiRecipe = (apiPath: string) => ({
    name: 'API feed',
    url: `${base}/demo/news.html`,
    itemSelector: 'li.news-item',
    fields: { title: { selector: 'h3' }, link: { selector: 'h3 > a', attr: 'href' } },
    api: {
      url: `${base}${apiPath}`,
      listPath: 'data.list',
      fields: { title: '{title}', link: '{url}', date: '{published_at}', image: '{cover}', summary: '{summary}' },
    },
  });

  it('fetches from the data API first', async () => {
    const created = await (await fetch(`${base}/api/recipes`, { method: 'POST', body: JSON.stringify({ recipe: apiRecipe('/demo/api/posts?page=1&size=8') }) })).json();
    expect(created.mode).toBe('api');
    expect(created.count).toBe(8);
    const feed = await (await fetch(created.jsonFeedUrl)).json();
    expect(feed.items[0]).toMatchObject({ url: `${base}/posts/post-5001`, title: '品牌设计作品集 · 第 1 期' });
    expect(feed.items[0].date_published).toBeTruthy();
  });

  it('falls back to the page when the API breaks', async () => {
    const res = await (await fetch(`${base}/api/preview`, { method: 'POST', body: JSON.stringify({ recipe: apiRecipe('/demo/api/missing') }) })).json();
    expect(res.mode).toBe('static');
    expect(res.count).toBe(5);
  });

  it('rejects unsafe API settings', async () => {
    const recipe = { ...apiRecipe('/x'), api: { ...apiRecipe('/x').api, method: 'POST', contentType: 'text/html' } };
    const res = await fetch(`${base}/api/preview`, { method: 'POST', body: JSON.stringify({ recipe }) });
    expect(res.status).toBe(400);
  });
});

describe('detail pages', () => {
  it('adds summaries, full text, authors and tags from each entry page', async () => {
    const recipe = {
      name: 'With details',
      url: `${base}/demo/api-feed.html`,
      itemSelector: 'div.card',
      fields: { title: { selector: 'span' } },
      api: { url: `${base}/demo/api/posts?page=1&size=4`, listPath: 'data.list', fields: { title: '{title}', link: '{url}', date: '{published_at}' } },
      detail: { enabled: true },
    };
    const created = await (await fetch(`${base}/api/recipes`, { method: 'POST', body: JSON.stringify({ recipe }) })).json();
    expect(created.details).toMatchObject({ ok: 4, blocked: 0 });
    const feed = await (await fetch(created.jsonFeedUrl)).json();
    const first = feed.items[0];
    // 全站套话「示例社区汇聚了上万名设计师与创作者」被去掉，标题重复也被去掉
    expect(first.summary).toBe('本期主题是品牌设计，分享了配色与排版的取舍');
    expect(first.authors).toEqual([{ name: '设计师1' }]);
    expect(first.tags).toEqual(['设计']);
    expect(first.content_html).toContain('街头采风');
    expect(first.content_html).not.toContain('相关推荐');
    const rss = await (await fetch(created.feedUrl)).text();
    expect(rss).toContain('<dc:creator>设计师1</dc:creator>');
    expect(rss).toContain('<content:encoded><![CDATA[');
  });

  it('skips pages protected by bot challenges', async () => {
    const r = await (await fetch(`${base}/api/detail-preview`, { method: 'POST', body: JSON.stringify({ url: `${base}/demo/protected` }) })).json();
    expect(r.status).toBe('blocked');
  });
});

describe('AI summaries', async () => {
  const { AiService } = await import('../src/ai.ts');
  const { FeedService } = await import('../src/runner.ts');

  it('summarizes entries that have full text, once per link, within the hourly budget', async () => {
    const store = new Store(':memory:');
    const calls: string[] = [];
    const ai = new AiService(store, async ({ title, text }) => {
      calls.push(title);
      expect(text).toContain('街头采风');
      return `「${title}」的 AI 摘要`;
    }, 3);
    const feeds = new FeedService(store, ai);
    const recipe = {
      version: 1 as const, name: 'AI', url: `${base}/demo/api-feed.html`, mode: 'auto' as const, itemSelector: 'x', fields: { title: { selector: 'x' } },
      api: { url: `${base}/demo/api/posts?page=1&size=5`, listPath: 'data.list', fields: { title: '{title}', link: '{url}' } },
      detail: { enabled: true }, ai: { summary: true },
    };
    const { id } = store.create(recipe, false);
    const result = await feeds.get(store.get(id)!, true);
    expect(calls).toHaveLength(3); // 每小时上限 3 次
    expect(result.ai).toEqual({ done: 3, pending: 2, failed: 0 });
    expect(result.items[0]).toMatchObject({ summary: '「品牌设计作品集 · 第 1 期」的 AI 摘要', aiSummary: true });
    expect(result.items[4].aiSummary).toBeUndefined();
    // 再刷新：已生成的直接用缓存，不再调用
    const again = await feeds.get(store.get(id)!, true);
    expect(calls).toHaveLength(3);
    expect(again.ai?.done).toBe(3);
  });

  it('labels AI summaries in the feed and reports availability', async () => {
    const health = await (await fetch(`${base}/api/health`)).json();
    expect(health.ai).toBe(false); // 测试服务器没有配置凭证
  });

  it('skips pages without enough text (image galleries) and model refusals', async () => {
    const store = new Store(':memory:');
    const ai = new AiService(store, async ({ title }) => (title.includes('拒绝') ? undefined : 'ok'));
    const items: import('@rssflow/core').FeedItem[] = [
      { title: '只有图片', link: 'https://x/1', contentHtml: '<p><img src="https://x/a.jpg"></p>' },
      { title: '被拒绝', link: 'https://x/2', contentHtml: `<p>${'正文'.repeat(60)}</p>` },
    ];
    const stats = await ai.enrich(items, { ai: { summary: true } } as never);
    expect(stats).toEqual({ done: 0, pending: 0, failed: 1 });
    expect(items[0].summary).toBeUndefined();
  });
});
