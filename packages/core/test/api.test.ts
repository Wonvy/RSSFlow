import { describe, expect, it } from 'vitest';
import { extractApiItems, firstPageBody, firstPageUrl, matchApi, parseJsonLoose, renderTemplate, type CapturedResponse } from '../src/index.ts';

/** 参照常见社区信息流接口的结构合成的数据 */
function discoverJson() {
  const work = (n: number, title: string, kind: 'work' | 'article' = 'work') => ({
    objectType: 3,
    content: {
      id: 18600000 + n,
      idStr: `W${n}`,
      title,
      cover: `https://img.example-cdn.cn/community/${n}.JPG?k=abc&t=1`,
      cover1x: `https://img.example-cdn.cn/community/${n}.JPG?k=abc&t=1&x-oss-process=image/resize,w_260`,
      typeStr: '原创',
      creator: { id: 900 + n, username: `作者${n}`, avatar: `https://img.example-cdn.cn/avatar/${n}.jpg`, pageUrl: `https://www.design.example.cn/u/U${n}` },
      publishTimeDiffStr: `${n}小时前`,
      timeTitleStr: `最近更新时间：2026-11-17 16:${10 + n}:00&#10;首次审核通过：2026-11-17 16:${n}:00`,
      createTime: 1794900000000 + n,
      publishTime: 1794903600000 - n * 3_600_000,
      viewCount: 700 + n,
      pageUrl: `https://www.design.example.cn/${kind}/W${n}.html`,
      schemeUrl: '',
    },
  });
  return {
    resultCode: 0,
    data: { aiRooms: [{ id: 1, name: '直播间', teachers: [] }, { id: 2, name: '直播间 2', teachers: [] }] },
    datas: [
      work(1, '手绘风格《城市漫游》'),
      work(2, '漫画 / 一次去月球的旅行'),
      { objectType: 26, adId: 77, adTitle: '冬季设计灵感' },
      work(3, '十一月设计趋势观察', 'article'),
      work(4, '国潮包装设计全案'),
    ],
    total: 600,
    page: 2,
    hasNext: true,
    tdk: { description: '编辑推荐作品分为三个等级，是作品可获得的最高推荐等级。' },
  };
}

const PAGE = 'https://www.design.example.cn/';

describe('matchApi', () => {
  it('finds the list behind a card feed and infers every field', () => {
    const res: CapturedResponse = { url: 'https://www.design.example.cn/api/feed/recommend?p=2&ps=60&column=4', method: 'GET', json: discoverJson() };
    const m = matchApi([res], ['手绘风格《城市漫游》', '漫画 / 一次去月球的旅行', '国潮包装设计全案', '冬季设计灵感'], PAGE)!;
    expect(m.api).toMatchObject({
      url: 'https://www.design.example.cn/api/feed/recommend?p=1&ps=60&column=4',
      method: 'GET',
      listPath: 'datas',
      fields: { title: '{content.title}', link: '{content.pageUrl}', date: '{content.publishTime}', image: '{content.cover}' },
    });
    expect(m.api.fields.summary).toBeUndefined(); // timeTitleStr 是元数据，不是摘要
    expect(m.api.fields.author).toBe('{content.creator.username}');
    expect(m.api.fields.tags).toBe('{content.typeStr}');
    const items = extractApiItems(res.json, m.api, PAGE, { utcOffset: 480 });
    expect(items).toHaveLength(4); // 广告条目没有标题，被跳过
    expect(items[2]).toMatchObject({ title: '十一月设计趋势观察', link: 'https://www.design.example.cn/article/W3.html', date: new Date(1794903600000 - 3 * 3_600_000).toISOString() });
  });

  it('prefers the content link over the author link, and resolves relative URLs', () => {
    const json = {
      code: 0,
      data: {
        list: [1, 2, 3].map((n) => ({
          id: n,
          title: `作品集 · 第 ${n} 期`,
          summary: `这是第 ${n} 期作品的简介，记录了完整的设计过程。`,
          url: `/posts/${n}`,
          cover: `/covers/${n}.jpg`,
          published_at: 1794900000 - n * 3600,
          author: { name: `设计师${n}`, home: `/u/designer${n}`, avatar: `/avatars/${n}.jpg` },
        })),
      },
    };
    const m = matchApi([{ url: 'https://ex.com/api/posts?page=3&size=8', method: 'GET', json }], ['作品集 · 第 1 期', '作品集 · 第 2 期'], 'https://ex.com/feed')!;
    expect(m.api.fields).toEqual({ title: '{title}', link: '{url}', date: '{published_at}', image: '{cover}', summary: '{summary}', author: '{author.name}' });
    expect(m.api.url).toBe('https://ex.com/api/posts?page=1&size=8');
    const [first] = extractApiItems(json, m.api, 'https://ex.com/feed');
    expect(first.link).toBe('https://ex.com/posts/1');
    expect(first.date).toBe(new Date((1794900000 - 3600) * 1000).toISOString());
  });

  it('learns a link template from links seen on the page when the API has no URL field', () => {
    const json = { items: ['alpha-post', 'beta-post', 'gamma-post'].map((slug, i) => ({ id: 100 + i, slug, headline: `Post number ${i + 1} about RSS` })) };
    const dom = new Map([
      ['Post number 1 about RSS', 'https://blog.example.com/p/alpha-post.html'],
      ['Post number 2 about RSS', 'https://blog.example.com/p/beta-post.html'],
    ]);
    const m = matchApi([{ url: 'https://blog.example.com/api/list', method: 'GET', json }], [...dom.keys()], 'https://blog.example.com/', dom)!;
    expect(m.api.fields.link).toBe('https://blog.example.com/p/{slug}.html');
    expect(extractApiItems(json, m.api, 'https://blog.example.com/')[2].link).toBe('https://blog.example.com/p/gamma-post.html');
  });

  it('keeps POST bodies and resets their paging', () => {
    const json = { data: { feed: [{ title: 'Alpha story here' }, { title: 'Beta story here' }] } };
    const m = matchApi(
      [{ url: 'https://ex.com/graphql', method: 'POST', body: '{"query":"q","variables":{"page":4,"cursor":"abc"}}', contentType: 'application/json', json }],
      ['Alpha story here', 'Beta story here'],
      'https://ex.com/',
    )!;
    expect(m.api).toMatchObject({ method: 'POST', body: '{"query":"q","variables":{"page":1}}', contentType: 'application/json', listPath: 'data.feed' });
  });

  it('ignores responses that do not match the page', () => {
    const json = { list: [{ title: 'Something else entirely' }, { title: 'Unrelated item' }] };
    expect(matchApi([{ url: 'https://ex.com/a', method: 'GET', json }], ['Alpha story here', 'Beta story here'], 'https://ex.com/')).toBeUndefined();
  });
});

describe('api helpers', () => {
  it('resets paging parameters', () => {
    expect(firstPageUrl('https://x.com/api?p=3&ps=20&_=1700000')).toBe('https://x.com/api?p=1&ps=20');
    expect(firstPageUrl('https://x.com/api?offset=40&limit=20&cursor=abc')).toBe('https://x.com/api?offset=0&limit=20');
    expect(firstPageBody('{"pageNo":5,"size":10}')).toBe('{"pageNo":1,"size":10}');
  });

  it('strips personal credentials before a recipe can be shared', () => {
    expect(firstPageUrl('https://u:pw@x.com/api?page=2&access_token=abc&sign=xyz&uid=7&size=10')).toBe('https://x.com/api?page=1&size=10');
    expect(firstPageBody('{"page":2,"token":"t","filter":{"csrfToken":"c","tag":"ui"}}')).toBe('{"page":1,"filter":{"tag":"ui"}}');
    expect(firstPageBody('page=2&session_id=s&q=rss')).toBe('page=2&q=rss');
  });

  it('parses JSON with XSSI prefixes and JSONP', () => {
    expect(parseJsonLoose(")]}'\n{\"a\":1}")).toEqual({ a: 1 });
    expect(parseJsonLoose('jQuery123({"a":2});')).toEqual({ a: 2 });
    expect(() => parseJsonLoose('<html>')).toThrow();
  });

  it('renders templates', () => {
    expect(renderTemplate('https://x.com/p/{a.b}.html', { a: { b: 'k' } })).toBe('https://x.com/p/k.html');
    expect(renderTemplate('{missing}', { a: 1 })).toBeUndefined();
  });
});
