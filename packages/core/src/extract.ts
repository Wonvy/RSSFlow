import type { FeedItem, FieldRule, Recipe } from './types.ts';
import { cleanText, safeQuery, safeQueryAll, tagOf } from './dom.ts';
import { parseDate } from './date.ts';
import { PROFILE_URL_RE, collectDataText, linkFromData } from './datalink.ts';

export function resolveUrl(href: string | null | undefined, baseUrl: string): string | undefined {
  const h = (href || '').trim();
  if (!h || h.startsWith('javascript:') || h === '#' || h.startsWith('data:')) return undefined;
  try {
    return new URL(h, baseUrl).href;
  } catch {
    return undefined;
  }
}

const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-lazy', 'data-url', 'data-echo', 'data-actualsrc'];

/** 读取图片地址，兼容各种懒加载写法 */
export function imageSrc(el: Element): string | null {
  const img = tagOf(el) === 'img' ? el : el.querySelector('img');
  if (img) {
    for (const a of LAZY_ATTRS) {
      const v = img.getAttribute(a);
      if (v && !v.startsWith('data:')) return v;
    }
    const src = img.getAttribute('src');
    if (src && !src.startsWith('data:')) return src;
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    if (srcset) return srcset.split(',')[0].trim().split(/\s+/)[0];
  }
  // 背景图
  const style = el.getAttribute('style') || '';
  const m = style.match(/background(?:-image)?\s*:[^;]*url\((['"]?)(.*?)\1\)/i);
  return m ? m[2] : null;
}

export function queryField(item: Element, rule: FieldRule): Element | null {
  return rule.selector ? safeQuery(item, rule.selector) : item;
}

export function readField(item: Element, rule: FieldRule, baseUrl: string): string | undefined {
  const el = queryField(item, rule);
  if (!el) return undefined;
  const attr = rule.attr || 'text';
  if (attr === 'text') return cleanText(el.textContent) || undefined;
  if (attr === 'href') return resolveUrl(el.getAttribute('href') ?? el.querySelector('a[href]')?.getAttribute('href'), baseUrl);
  if (attr === 'src') return resolveUrl(imageSrc(el), baseUrl);
  if (attr === 'html') return el.innerHTML;
  return cleanText(el.getAttribute(attr)) || undefined;
}

function firstLink(item: Element, baseUrl: string): string | undefined {
  if (tagOf(item) === 'a') return resolveUrl(item.getAttribute('href'), baseUrl);
  for (const a of safeQueryAll(item, 'a[href]')) {
    const u = resolveUrl(a.getAttribute('href'), baseUrl);
    if (u && !PROFILE_URL_RE.test(u)) return u;
  }
  return undefined;
}

export interface ExtractOptions {
  limit?: number;
  now?: Date;
  /** 页面内嵌数据；不传时如有需要会自动从 root 里收集 */
  dataText?: string;
}

/** 按规则从页面中提取条目 */
export function extractItems(root: ParentNode, recipe: Pick<Recipe, 'itemSelector' | 'fields' | 'utcOffset'>, baseUrl: string, opts: ExtractOptions = {}): FeedItem[] {
  const limit = opts.limit ?? 100;
  const f = recipe.fields;
  const nodes = safeQueryAll(root, recipe.itemSelector);
  const titles = nodes.map((item) => readField(item, f.title, baseUrl));
  const dataLink = f.link?.from === 'data' && f.link.prefixes?.length ? f.link.prefixes : undefined;
  const dataText = dataLink ? (opts.dataText ?? collectDataText(root)) : '';
  const stops = dataLink ? (titles.filter(Boolean) as string[]) : [];

  const out: FeedItem[] = [];
  const seen = new Set<string>();
  nodes.forEach((item, idx) => {
    if (out.length >= limit) return;
    const title = titles[idx];
    if (!title) return;
    const link = dataLink
      ? linkFromData(dataText, title, dataLink, stops)
      : (f.link && readField(item, f.link, baseUrl)) || firstLink(item, baseUrl);
    const key = link || title;
    if (seen.has(key)) return;
    seen.add(key);
    const entry: FeedItem = { title: title.slice(0, 500) };
    if (link) entry.link = link;
    if (f.date) {
      const dateText = readField(item, f.date, baseUrl);
      if (dateText) {
        entry.dateText = dateText;
        const d = parseDate(dateText, { now: opts.now, utcOffset: recipe.utcOffset });
        if (d) entry.date = d.toISOString();
      }
    }
    if (f.image) {
      const image = readField(item, f.image, baseUrl);
      if (image) entry.image = image;
    }
    if (f.summary) {
      const summary = readField(item, f.summary, baseUrl);
      if (summary && summary !== title) entry.summary = summary.slice(0, 2000);
    }
    if (f.author) {
      const author = readField(item, f.author, baseUrl);
      if (author && author !== title) entry.author = author.slice(0, 100);
    }
    out.push(entry);
  });
  return out;
}
