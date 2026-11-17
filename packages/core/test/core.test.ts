import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import {
  bestCandidateIndex,
  detectFields,
  extractItems,
  findListCandidates,
  isStableClass,
  parseDate,
  parseAcceptLanguage,
  resolveLocale,
  translate,
  validateRecipe,
  I18nError,
} from '../src/index.ts';

const html = readFileSync(fileURLToPath(new URL('../../server/demo/news.html', import.meta.url)), 'utf8');
const load = () => parseHTML(html).document as unknown as Document;
const BASE = 'https://news.example.com/list';

describe('list detection', () => {
  it('clicking a headline finds the whole news list', () => {
    const doc = load();
    const target = doc.querySelectorAll('.news-item h3 a')[2];
    const cands = findListCandidates(target, doc);
    const best = cands[bestCandidateIndex(cands)];
    expect(best.items).toHaveLength(5);
    expect(best.itemSelector).toBe('li.news-item');
  });

  it('clicking a tag still prefers the news items over the tag group', () => {
    const doc = load();
    const target = doc.querySelector('.tags a')!;
    const cands = findListCandidates(target, doc);
    expect(cands[bestCandidateIndex(cands)].itemSelector).toBe('li.news-item');
  });

  it('clicking a sidebar link finds the links of that widget', () => {
    const doc = load();
    const target = doc.querySelector('aside .widget a')!;
    const cands = findListCandidates(target, doc);
    const best = cands[bestCandidateIndex(cands)];
    expect(best.items.length).toBe(9);
    expect(best.items.every((i) => i.tagName.toLowerCase() === 'a')).toBe(true);
  });

  it('detects fields and extracts items', () => {
    const doc = load();
    const target = doc.querySelector('.news-item .desc')!;
    const cands = findListCandidates(target, doc);
    const best = cands[bestCandidateIndex(cands)];
    const fields = detectFields(best.items, target);
    expect(fields.title.selector).toBe('h3');
    expect(fields.link).toEqual({ selector: 'h3 > a', attr: 'href' });
    expect(fields.date?.selector).toBe('span.time');
    expect(fields.image?.attr).toBe('src');
    expect(fields.summary?.selector).toBe('p.desc');

    const items = extractItems(doc, { itemSelector: best.itemSelector, fields, utcOffset: 480 }, BASE);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({
      title: '国产大模型发布新版本，推理能力大幅提升',
      link: 'https://news.example.com/news/1001.html',
      image: 'https://news.example.com/img/1.jpg',
      date: '2026-11-17T01:30:00.000Z',
    });
    expect(items[0].summary).toContain('推理速度');
  });
});

describe('parseDate', () => {
  const now = new Date('2026-11-17T12:00:00Z');
  const opts = { now, utcOffset: 480 };
  it.each([
    ['2026-11-17 09:30', '2026-11-17T01:30:00.000Z'],
    ['2026年11月17日', '2026-11-16T16:00:00.000Z'],
    ['11-15', '2026-11-14T16:00:00.000Z'],
    ['12-30', '2025-12-29T16:00:00.000Z'],
    ['3小时前', '2026-11-17T09:00:00.000Z'],
    ['昨天 08:00', '2026-11-16T00:00:00.000Z'],
    ['2 days ago', '2026-11-15T12:00:00.000Z'],
    ['2026-11-17T10:00:00+08:00', '2026-11-17T02:00:00.000Z'],
    ['Nov 15, 2026', '2026-11-14T16:00:00.000Z'],
  ])('%s', (input, expected) => {
    expect(parseDate(input, opts)?.toISOString()).toBe(expected);
  });
  it('returns undefined for non-dates', () => {
    expect(parseDate('hello world', opts)).toBeUndefined();
  });
});

describe('stable classes', () => {
  it('filters hashed and state classes', () => {
    expect(isStableClass('news-item')).toBe(true);
    expect(isStableClass('active')).toBe(false);
    expect(isStableClass('css-1x2y3z')).toBe(false);
    expect(isStableClass('Title_aB3xZ')).toBe(false);
    expect(isStableClass('md:flex')).toBe(false);
  });
});

describe('i18n', () => {
  it('resolves locales', () => {
    expect(resolveLocale(parseAcceptLanguage('zh-TW,zh;q=0.9,en;q=0.8'))).toBe('zh-CN');
    expect(resolveLocale(parseAcceptLanguage('fr-FR,en;q=0.5'))).toBe('en');
    expect(resolveLocale(['de'])).toBe('en');
  });
  it('translates with params', () => {
    expect(translate('zh-CN', 'review.found', { count: 5 })).toBe('识别到 5 条内容');
    expect(translate('en', 'review.found', { count: 5 })).toBe('Found 5 entries');
  });
  it('validation errors carry a translatable key', () => {
    try {
      validateRecipe({ url: 'ftp://x', itemSelector: 'li', fields: { title: { selector: '' } } });
      throw new Error('should fail');
    } catch (e) {
      expect(e).toBeInstanceOf(I18nError);
      expect((e as I18nError).localize('zh-CN')).toBe('只支持 http / https 网址');
    }
  });
});

describe('versions and releases', async () => {
  const { compareVersions, parseRelease } = await import('../src/index.ts');
  it('compares versions numerically', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('v0.3.0', '0.2.99')).toBeGreaterThan(0);
    expect(compareVersions('0.2.5', '0.2.5')).toBe(0);
  });
  it('reads a GitHub release and only trusts github.com links', () => {
    const r = parseRelease({
      tag_name: 'v0.2.7',
      html_url: 'https://github.com/Wonvy/RSSFlow/releases/tag/v0.2.7',
      assets: [{ name: 'rssflow-extension.zip', browser_download_url: 'https://github.com/Wonvy/RSSFlow/releases/download/v0.2.7/rssflow-extension.zip' }],
    });
    expect(r).toEqual({ version: '0.2.7', url: 'https://github.com/Wonvy/RSSFlow/releases/tag/v0.2.7', extensionZip: 'https://github.com/Wonvy/RSSFlow/releases/download/v0.2.7/rssflow-extension.zip', publishedAt: undefined });
    expect(parseRelease({ tag_name: 'v1.0.0', html_url: 'https://evil.example/x' })?.url).toBe('');
    expect(parseRelease({ tag_name: 'nightly' })).toBeUndefined();
  });
});
