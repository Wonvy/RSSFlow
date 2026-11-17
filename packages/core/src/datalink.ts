/**
 * 从页面内嵌数据里找回条目链接。
 *
 * 很多 React / Vue / Next.js 网站的卡片是 `<div role="button">`，点击后靠 JS 跳转，DOM 里没有链接。
 * 但页面里通常内嵌了数据（<script> 里的 JSON、Next.js flight data、window.__INITIAL_STATE__ 等），
 * 数据里每条内容的标题后面不远处，就是它的详情页地址。
 *
 * 做法：在脚本文本里找到条目标题，往后找第一个符合「链接前缀」的网址（例如 https://www.example.com/work/）。
 * 链接前缀是在选取时从几条样本里自动学习出来的。
 */
import { safeQueryAll } from './dom.ts';

const MAX_DATA = 8 * 1024 * 1024;
const WINDOW = 4000;

export const PROFILE_URL_RE = /\/(u|user|users|author|authors|people|member|members|profile|space|uid|channel|creator)\/|\/@[\w.-]+\/?$/i;
const NON_PAGE_RE = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|woff2?|ttf|otf|map|mp4|mp3|m3u8|webm)(\?|#|$)|x-oss-process=|imageView2|imageMogr/i;
const ASSET_HOST_RE = /^(img|image|images|static|cdn|assets|pic|pics|avatar|res|s|js|css|fonts?)\d*[.-]/i;
const URL_RE = /https?:\/\/[^\s"'<>\\,[\]{}()|^`]+/g;

/** 去掉 JSON / JS 字符串里的转义，让网址和标题恢复原样 */
export function unescapeData(s: string): string {
  let out = s;
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"');
  }
  return out.replace(/&amp;/g, '&');
}

/** 收集页面里所有 <script> 的文本（已去转义） */
export function collectDataText(root: ParentNode): string {
  let total = 0;
  const parts: string[] = [];
  for (const s of safeQueryAll(root, 'script')) {
    const t = s.textContent || '';
    if (t.length < 40) continue;
    total += t.length;
    if (total > MAX_DATA) break;
    parts.push(t);
  }
  // 空白归一化方式和提取标题时（cleanText）一致，否则含 &nbsp; 等特殊空白的标题会匹配不上
  return unescapeData(parts.join('\n')).replace(/\s+/g, ' ');
}

/** 是否像一个内容页地址（排除图片、脚本、样式、静态资源域名） */
export function isPageUrl(u: string): boolean {
  if (NON_PAGE_RE.test(u)) return false;
  try {
    const url = new URL(u);
    return !ASSET_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

/** 网址的「形状」：去掉最后一段，例如 https://x.com/work/abc.html → https://x.com/work/ */
export function urlShape(u: string): string | undefined {
  try {
    const url = new URL(u);
    const dir = url.pathname.replace(/[^/]*$/, '');
    return url.origin + dir;
  } catch {
    return undefined;
  }
}

/** 标题每次出现后的数据片段（遇到其它条目的标题就截断） */
function segmentsAfter(data: string, title: string, stops: string[]): string[] {
  const segs: string[] = [];
  if (title.length < 2) return segs;
  let from = 0;
  for (let n = 0; n < 20; n++) {
    const i = data.indexOf(title, from);
    if (i < 0) break;
    from = i + title.length;
    let seg = data.slice(from, from + WINDOW);
    for (const s of stops) {
      if (s.length < 4 || s === title || title.includes(s)) continue;
      const j = seg.indexOf(s);
      if (j >= 0) seg = seg.slice(0, j);
    }
    segs.push(seg);
  }
  return segs;
}

/** 在数据里找标题对应的、以任一前缀开头的链接 */
export function linkFromData(data: string, title: string, prefixes: string[], stops: string[] = []): string | undefined {
  for (const seg of segmentsAfter(data, title, stops)) {
    for (const m of seg.matchAll(URL_RE)) {
      if (prefixes.some((p) => m[0].startsWith(p)) && isPageUrl(m[0])) return m[0];
    }
  }
  return undefined;
}

/**
 * 从条目标题学习「链接前缀」。
 * 每个标题之后第一个内容页网址的形状进行投票：得票过半的形状胜出；
 * 同一网站下另有至少 2 条不同网址的形状也一并保留（列表里混着作品、文章等不同类型）。
 */
export function learnDataLinkPrefixes(data: string, titles: string[]): string[] | undefined {
  const sample = [...new Set(titles.filter((t) => t.length >= 2))].slice(0, 100);
  if (sample.length < 2 || !data) return undefined;
  const votes = new Map<string, Set<string>>(); // shape → 不同的网址
  for (const title of sample) {
    const seen = new Set<string>();
    for (const seg of segmentsAfter(data, title, sample)) {
      for (const m of seg.matchAll(URL_RE)) {
        const u = m[0];
        if (!isPageUrl(u) || PROFILE_URL_RE.test(u)) continue;
        const shape = urlShape(u);
        if (shape && !seen.has(shape)) {
          seen.add(shape);
          if (!votes.has(shape)) votes.set(shape, new Set());
          votes.get(shape)!.add(u);
        }
        break; // 每次出现只看第一个内容页网址
      }
    }
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [shape, urls] of votes) {
    if (urls.size > bestCount) {
      best = shape;
      bestCount = urls.size;
    }
  }
  if (!best || bestCount < Math.max(2, Math.ceil(sample.length * 0.5))) return undefined;
  const origin = new URL(best).origin;
  const sig = (u: string) => {
    const p = new URL(u).pathname;
    return `${p.split('/').length}|${p.match(/\.[a-z0-9]+$/i)?.[0] ?? ''}`;
  };
  const bestSig = sig([...votes.get(best)!][0]);
  // 其它形状：出现至少 2 次；或者和主形状结构相同（同层级、同后缀，如 /work/x.html 与 /article/y.html）
  const extra = [...votes]
    .filter(([shape, urls]) => shape !== best && shape.startsWith(origin) && shape !== origin + '/' && (urls.size >= 2 || [...urls].every((u) => sig(u) === bestSig)))
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 4)
    .map(([shape]) => shape);
  return [best, ...extra];
}
