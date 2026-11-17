/**
 * 卡片流网站（参照常见设计社区的结构合成的测试页）：
 * CSS Modules 哈希类名、多个 grid 容器、插在中间的广告卡、没有 <a> 的卡片、内嵌的 Next.js flight data。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  bestCandidateIndex,
  classKey,
  collectDataText,
  detectFields,
  extractItems,
  findListCandidates,
  guessUtcOffset,
  learnDataLinkPrefixes,
} from '../src/index.ts';

const html = readFileSync(fileURLToPath(new URL('../../server/demo/card-feed.html', import.meta.url)), 'utf8');
const load = () => parseHTML(html).document as unknown as Document;
const PAGE = 'https://www.design.example.cn/';

function pick(doc: Document, target: Element) {
  const cands = findListCandidates(target, doc);
  return cands[bestCandidateIndex(cands)];
}

describe('hashed class names', () => {
  it('turns CSS-module classes into stable substring keys', () => {
    expect(classKey('Kx7pQa_title')).toBe('*_title');
    expect(classKey('_3fRtYw_badgeBox')).toBe('*_badgeBox');
    expect(classKey('Card_title__a1B2c')).toBe('*Card_title__');
    expect(classKey('news-item')).toBe('news-item');
    expect(classKey('header_title')).toBe('header_title');
    expect(classKey('active')).toBeNull();
  });
});

describe('card feed', () => {
  it('finds every card across all grid containers, with a hash-free selector', () => {
    const doc = load();
    const best = pick(doc, doc.querySelector('[class*="_title"] span')!);
    expect(best.itemSelector).toBe('div[class*="_cardCell"]');
    expect(best.items).toHaveLength(8); // 7 张作品/文章卡 + 1 张广告卡
  });

  it('still finds the list when the user clicks the ad card', () => {
    const doc = load();
    expect(pick(doc, doc.querySelector('.promo-info-title')!).itemSelector).toBe('div[class*="_cardCell"]');
  });

  it('still finds the list when the user clicks the gap between cards', () => {
    const doc = load();
    expect(pick(doc, doc.querySelector('[class*="_cardGridTop"]')!).itemSelector).toBe('div[class*="_cardCell"]');
  });

  it('learns link prefixes from embedded page data', () => {
    const doc = load();
    const data = collectDataText(doc);
    expect(learnDataLinkPrefixes(data, ['山间小屋品牌设计', '城市夜景插画系列', '十一月设计趋势观察', '国潮包装设计全案'])).toEqual([
      'https://www.design.example.cn/work/',
      'https://www.design.example.cn/article/',
    ]);
  });

  it('ignores author links and recovers detail links from page data', () => {
    const doc = load();
    const hint = doc.querySelector('[class*="_title"] span')!;
    const best = pick(doc, hint);
    const fields = detectFields(best.items, hint, { dataText: collectDataText(doc) });
    expect(fields.title.selector).toBe('span[class*="_title"]');
    expect(fields.link).toEqual({
      selector: '',
      from: 'data',
      prefixes: ['https://www.design.example.cn/work/', 'https://www.design.example.cn/article/'],
    });
    expect(fields.image).toEqual({ selector: 'img[class*="_CardImage"]', attr: 'src' });

    const items = extractItems(doc, { itemSelector: best.itemSelector, fields }, PAGE);
    expect(items.map((i) => i.link)).toEqual([
      'https://www.design.example.cn/work/Wk101.html',
      'https://www.design.example.cn/work/Wk102.html',
      'https://www.design.example.cn/article/Ar201.html',
      'https://www.design.example.cn/work/Wk103.html', // 标题里有 &nbsp;
      'https://www.design.example.cn/work/Wk104.html',
      'https://www.design.example.cn/work/Wk105.html',
      'https://www.design.example.cn/article/Ar202.html',
    ]);
  });

  it('uses a typical card when the clicked card is an outlier', () => {
    const doc = load();
    const hint = doc.querySelector('.promo-info-title')!;
    const fields = detectFields(pick(doc, hint).items, hint, { dataText: collectDataText(doc) });
    expect(fields.title.selector).toBe('span[class*="_title"]');
  });
});

describe('guessUtcOffset', () => {
  it('prefers the site over the viewer', () => {
    expect(guessUtcOffset('https://www.example.com.cn/')).toBe(480);
    expect(guessUtcOffset('https://example.jp/news')).toBe(540);
    expect(guessUtcOffset('https://example.com/', 'zh-CN')).toBe(480);
    expect(guessUtcOffset('https://example.com/', 'en')).toBeUndefined();
  });
});
