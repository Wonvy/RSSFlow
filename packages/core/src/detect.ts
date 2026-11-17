/**
 * 「点一下，认出整个列表」的核心算法。
 *
 * 用户点中页面上的任意元素后，沿着祖先链往上找：
 * 每一层看它的父元素里有多少个「长得像它」的兄弟。兄弟够多、内容像文章条目的那一层，就是列表条目。
 */
import type { FieldName, FieldRule, RecipeFields } from './types.ts';
import { classSelector, elementChildren, pathSelector, relativeSelector, safeQueryAll, simpleSelector, stableClasses, tagOf, textOf, weightedLength } from './dom.ts';
import { looksLikeDate } from './date.ts';
import { PROFILE_URL_RE, learnDataLinkPrefixes } from './datalink.ts';
import { queryField } from './extract.ts';

export interface ListCandidate {
  /** 用户点中元素所在的那个条目 */
  item: Element;
  /** 同一列表里的所有条目 */
  items: Element[];
  itemSelector: string;
  score: number;
  /** 祖先链上的层级，0 最靠近点击位置 */
  depth: number;
}

const SKIP_TAGS = new Set(['html', 'body', 'head', 'script', 'style', 'noscript', 'svg', 'path']);
const INVISIBLE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'iframe', 'br', 'hr']);

/** 两个兄弟元素是否「长得像」：标签相同，稳定 class 至少一半重合 */
export function similar(a: Element, b: Element): boolean {
  if (a.tagName !== b.tagName) return false;
  const ca = stableClasses(a);
  const cb = stableClasses(b);
  if (!ca.length && !cb.length) return true;
  if (!ca.length || !cb.length) return false;
  const inter = ca.filter((c) => cb.includes(c)).length;
  return inter / Math.max(ca.length, cb.length) >= 0.5;
}

function isRealHref(href: string | null): boolean {
  return !!href && !/^(javascript:|#$|#\s*$)/i.test(href.trim()) && href.trim() !== '#';
}

function linksIn(el: Element): Element[] {
  const self = tagOf(el) === 'a' && isRealHref(el.getAttribute('href')) ? [el] : [];
  return self.concat(safeQueryAll(el, 'a[href]').filter((a) => isRealHref(a.getAttribute('href'))));
}

function scoreGroup(items: Element[]): number {
  const n = items.length;
  const texts = items.map((i) => Math.min(weightedLength(textOf(i)), 300));
  const avgText = texts.reduce((a, b) => a + b, 0) / n;
  const linkCounts = items.map((i) => linksIn(i).length);
  const linkRatio = linkCounts.filter((c) => c > 0).length / n;
  const avgLinks = linkCounts.reduce((a, b) => a + b, 0) / n;
  const nonEmpty = texts.filter((t) => t > 0).length / n;

  let s = Math.log2(n + 1) * Math.sqrt(Math.min(avgText, 150) + 1);
  s *= linkRatio >= 0.6 ? 1.5 : 0.6;
  if (avgLinks > 8) s *= 0.3; // 一个条目里链接太多，多半是整块导航/侧栏
  if (avgText < 8) s *= 0.4; // 太短，多半是标签、按钮
  s *= nonEmpty;
  return s;
}

/** 为一组条目生成选择器：优先用最短且恰好命中这组条目的写法 */
export function buildItemSelector(items: Element[], doc: ParentNode): string {
  const first = items[0];
  const common = stableClasses(first).filter((c) => items.every((i) => stableClasses(i).includes(c)));
  const itemPart = tagOf(first) + common.map(classSelector).join('');
  const set = new Set(items);
  const parent = first.parentElement;
  /**
   * 选择器命中的元素可以比当前这组多，但多出来的必须在「长得一样的兄弟容器」里。
   * 典型场景：瀑布流 / 无限滚动把同一个列表拆成好几个容器（每屏一个 grid）。
   */
  // 「纯」容器：子元素基本都是同类条目（带小标题的侧栏小部件不算，它们是各自独立的列表）
  const pure = (box: Element) => {
    const kids = elementChildren(box);
    const others = kids.filter((k) => !similar(k, first));
    const headingLike = others.some((k) => /^(h[1-6]|header|b|strong|legend|caption|dt)$/.test(tagOf(k)) || /title|head/i.test(k.getAttribute('class') || ''));
    return kids.length > 0 && !headingLike && others.length / kids.length <= 0.1;
  };
  const acceptable = (sel: string) => {
    const m = safeQueryAll(doc, sel);
    if (m.length < items.length || !items.every((i) => m.includes(i))) return false;
    if (m.length === items.length) return true;
    if (!parent || !pure(parent)) return false;
    return m.every((e) => set.has(e) || (!!e.parentElement && e.parentElement !== parent && similar(e.parentElement, parent) && pure(e.parentElement)));
  };
  if (common.length && acceptable(itemPart)) return itemPart;
  if (!parent) return itemPart;
  const parentKeys = stableClasses(parent);
  if (parentKeys.length) {
    const sel = `${tagOf(parent)}${parentKeys.map(classSelector).join('')} > ${itemPart}`;
    if (acceptable(sel)) return sel;
    // 兄弟容器的 class 可能略有不同（如 grid 与 gridTop），只用它们共有的 class
    const loose = `${tagOf(parent)}${parentKeys.slice(0, 1).map(classSelector).join('')} > ${itemPart}`;
    if (acceptable(loose)) return loose;
  }
  return `${pathSelector(parent, doc)} > ${itemPart}`;
}

/** 一组元素里占多数（≥60%）的同类子组 */
function majorGroup(kids: Element[], minItems: number): Element[] | undefined {
  if (kids.length < 3) return undefined;
  const groups: Element[][] = [];
  for (const k of kids) {
    const g = groups.find((x) => similar(x[0], k));
    if (g) g.push(k);
    else groups.push([k]);
  }
  const major = groups.sort((a, b) => b.length - a.length)[0];
  return major.length >= Math.max(3, minItems) && major.length >= kids.length * 0.6 ? major : undefined;
}

/** 从点击的元素出发，列出祖先链上所有可能的「列表」，按层级从内到外排列 */
export function findListCandidates(target: Element, doc: ParentNode, minItems = 3): ListCandidate[] {
  const result: ListCandidate[] = [];
  // 点在了条目之间的空隙上（点中的是列表容器本身）：它的子元素就是列表
  const own = majorGroup(elementChildren(target).filter((k) => !INVISIBLE_TAGS.has(tagOf(k))), minItems);
  if (own) result.push({ item: own[0], items: own, itemSelector: '', score: scoreGroup(own), depth: -1 });
  let node: Element | null = target;
  let depth = 0;
  while (node && node.parentElement && !SKIP_TAGS.has(tagOf(node))) {
    const parent: Element = node.parentElement;
    const cur: Element = node;
    const kids = elementChildren(parent).filter((k) => !INVISIBLE_TAGS.has(tagOf(k)));
    const siblings = kids.filter((c) => c === cur || similar(c, cur));
    if (siblings.length >= minItems) {
      result.push({ item: cur, items: siblings, itemSelector: '', score: scoreGroup(siblings), depth });
    } else if (kids.length >= 4) {
      // 点中的是列表里的「异类」（比如插在作品流里的广告卡）：改用占多数的那一组兄弟
      const major = majorGroup(kids, minItems);
      if (major) result.push({ item: major[0], items: major, itemSelector: '', score: scoreGroup(major), depth });
    }
    node = parent;
    depth++;
  }
  if (!result.length && minItems > 2) return findListCandidates(target, doc, 2);
  for (const c of result) {
    c.itemSelector = buildItemSelector(c.items, doc);
    // 选择器可能命中更多同类元素（比如分页后的兄弟列表），以选择器结果为准
    const matched = safeQueryAll(doc, c.itemSelector);
    if (matched.length >= c.items.length && c.items.every((i) => matched.includes(i))) c.items = matched;
  }
  return result;
}

/** 返回得分最高的候选下标 */
export function bestCandidateIndex(cands: ListCandidate[]): number {
  let best = -1;
  let bestScore = -Infinity;
  cands.forEach((c, i) => {
    if (c.score > bestScore) {
      best = i;
      bestScore = c.score;
    }
  });
  return best;
}

/** 字段规则在多少比例的条目上能取到值 */
export function fieldCoverage(items: Element[], rule: FieldRule): number {
  if (!items.length) return 0;
  return items.filter((i) => {
    const el = queryField(i, rule);
    return !!el && (rule.attr && rule.attr !== 'text' ? true : textOf(el).length > 0);
  }).length / items.length;
}

const HEADING = 'h1,h2,h3,h4,h5,h6';

function closestWithin(el: Element, selector: string, stop: Element): Element | null {
  let cur: Element | null = el;
  while (cur && cur !== stop) {
    try {
      if (cur.matches(selector)) return cur;
    } catch {
      return null;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** 在条目里为某个元素生成字段规则 */
export function ruleFor(item: Element, el: Element, field: FieldName): FieldRule {
  const selector = relativeSelector(item, el);
  if (field === 'link') return { selector, attr: 'href' };
  if (field === 'image') return { selector, attr: 'src' };
  if (field === 'date' && tagOf(el) === 'time' && el.getAttribute('datetime')) return { selector, attr: 'datetime' };
  return { selector };
}

const AUTHOR_CLASS_RE = /author|user|creator|avatar|nickname|byline|owner|uploader|profile/i;

/** 元素（含祖先，直到条目为止）是否处在作者/头像区域 */
function inAuthorArea(el: Element, item: Element): boolean {
  let cur: Element | null = el;
  while (cur && cur !== item) {
    if (AUTHOR_CLASS_RE.test(cur.getAttribute('class') || '')) return true;
    cur = cur.parentElement;
  }
  return false;
}

/** 给条目里的链接打分：越像「这条内容的详情页」分越高；作者主页、头像链接扣分 */
function anchorScore(a: Element, item: Element, titleEl: Element | undefined, longest: Element | undefined): number {
  const href = a.getAttribute('href') || '';
  let s = 0;
  if (titleEl && (a.contains(titleEl) || titleEl.contains(a))) s += 4;
  if (titleEl && textOf(a) && textOf(a) === textOf(titleEl)) s += 3;
  if (closestWithin(a, HEADING, item) || safeQueryAll(a, HEADING).length) s += 2;
  if (a === item) s += 2;
  if (!titleEl && a === longest) s += 1;
  if (a.querySelector('img') && !inAuthorArea(a, item)) s += 1;
  if (PROFILE_URL_RE.test(href)) s -= 4;
  if (inAuthorArea(a, item)) s -= 3;
  return s;
}

function isSmallImage(img: Element): boolean {
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  return (w > 0 && w <= 48) || (h > 0 && h <= 48);
}

export interface DetectOptions {
  /** 页面内嵌数据（collectDataText 的结果），用于在卡片没有链接时找回链接 */
  dataText?: string;
}

/**
 * 自动猜测各字段。
 * 先按用户点中的那一条来猜；如果那一条不典型（比如混在列表里的广告卡），
 * 猜出的标题在大多数条目里都取不到，就换几条别的条目重新猜，取覆盖率最高的结果。
 */
export function detectFields(items: Element[], hint?: Element | null, opts: DetectOptions = {}): RecipeFields {
  if (!items.length) return { title: { selector: '' } };
  const hintItem = (hint && items.find((i) => i.contains(hint))) || items[0];
  let best = detectFieldsFor(hintItem, items, hint, opts);
  let bestCov = fieldCoverage(items, best.title);
  if (bestCov >= 0.6) return best;
  const step = Math.max(1, Math.floor(items.length / 8));
  for (let i = 0; i < items.length && i < step * 8; i += step) {
    if (items[i] === hintItem) continue;
    const f = detectFieldsFor(items[i], items, null, opts);
    const cov = fieldCoverage(items, f.title);
    if (cov > bestCov) {
      best = f;
      bestCov = cov;
      if (cov >= 0.9) break;
    }
  }
  return best;
}

function detectFieldsFor(item: Element, items: Element[], hint: Element | null | undefined, opts: DetectOptions): RecipeFields {
  const anchors = linksIn(item);
  const longest = [...anchors].sort((a, b) => textOf(b).length - textOf(a).length)[0];

  // 标题：标题标签 > class 带 title 的元素 > 点击的元素（不在作者区域时）
  const heading = safeQueryAll(item, HEADING).find((h) => textOf(h).length > 0);
  const titleClass = safeQueryAll(item, '[class*="title"],[class*="Title"]').find(
    (e) => textOf(e).length >= 2 && textOf(e).length <= 200 && !inAuthorArea(e, item),
  );
  let titleEl: Element | undefined =
    heading || titleClass || (hint && item.contains(hint) && hint !== item && textOf(hint).length >= 2 && !inAuthorArea(hint, item) && !looksLikeDate(textOf(hint)) ? hint : undefined);

  // 链接：打分选最像详情页的那个；都不像就当作没有
  const ranked = anchors
    .map((a) => ({ a, s: anchorScore(a, item, titleEl, longest) }))
    .sort((x, y) => y.s - x.s);
  let linkEl: Element | undefined = ranked[0] && ranked[0].s > 0 ? ranked[0].a : undefined;

  if (!titleEl) {
    titleEl =
      (linkEl && textOf(linkEl).length >= 2 ? linkEl : undefined) ||
      safeQueryAll(item, '*')
        .filter((e) => e.children.length === 0 && textOf(e).length >= 2 && !inAuthorArea(e, item))
        .sort((a, b) => textOf(b).length - textOf(a).length)[0] ||
      item;
  }
  if (!linkEl) linkEl = linksIn(titleEl).find((a) => !PROFILE_URL_RE.test(a.getAttribute('href') || ''));

  const fields: RecipeFields = { title: ruleFor(item, titleEl, 'title') };
  if (linkEl) {
    fields.link = ruleFor(item, linkEl, 'link');
  } else {
    // 没有 <a>：先看 data-href 这类属性，再到页面内嵌数据里找
    const attrEl = [item, ...safeQueryAll(item, '[data-href],[data-url],[data-link]')].find((e) => ['data-href', 'data-url', 'data-link'].some((n) => e.hasAttribute(n)));
    const attr = attrEl && ['data-href', 'data-url', 'data-link'].find((n) => attrEl.hasAttribute(n));
    if (attrEl && attr) fields.link = { selector: relativeSelector(item, attrEl), attr };
    else if (opts.dataText) {
      const titleRule = fields.title;
      const titles = items.slice(0, 100).map((i) => textOf(queryField(i, titleRule))).filter(Boolean);
      const prefixes = learnDataLinkPrefixes(opts.dataText, titles);
      if (prefixes) fields.link = { selector: '', from: 'data', prefixes };
    }
  }

  // 时间
  const timeEl =
    safeQueryAll(item, 'time')[0] ||
    safeQueryAll(item, '*').find((e) => e.children.length <= 1 && e !== titleEl && !titleEl!.contains(e) && looksLikeDate(textOf(e)));
  if (timeEl) fields.date = ruleFor(item, timeEl, 'date');

  // 图片：跳过头像、小图标
  const img = safeQueryAll(item, 'img').find((i) => !inAuthorArea(i, item) && !isSmallImage(i));
  if (img) fields.image = ruleFor(item, img, 'image');

  // 摘要：除标题外文字最长的段落
  const titleText = textOf(titleEl);
  const summaryEl = safeQueryAll(item, 'p,div,span,section')
    .filter((e) => e !== titleEl && !e.contains(titleEl!) && !titleEl!.contains(e) && e !== timeEl && !(timeEl && e.contains(timeEl)) && !inAuthorArea(e, item))
    .filter((e) => {
      const t = textOf(e);
      return t.length >= 15 && t !== titleText && safeQueryAll(e, 'p,div').length <= 2;
    })
    .sort((a, b) => (tagOf(b) === 'p' ? 20 : 0) + textOf(b).length - ((tagOf(a) === 'p' ? 20 : 0) + textOf(a).length))[0];
  if (summaryEl) fields.summary = ruleFor(item, summaryEl, 'summary');

  // 作者：作者区域里文字最短的那个名字（不是头像、不是链接里的图片）
  const authorEl = safeQueryAll(item, '[class*="name"], [class*="Name"], [class*="author"], [class*="user"], [class*="creator"], [rel="author"]')
    .filter((e) => inAuthorArea(e, item) || /author|creator|user|name/i.test(e.getAttribute('class') || ''))
    .filter((e) => {
      const t = textOf(e);
      return t.length >= 1 && t.length <= 30 && e !== titleEl && !e.contains(titleEl!) && !looksLikeDate(t) && e.children.length <= 2;
    })
    .sort((a, b) => textOf(a).length - textOf(b).length)[0];
  if (authorEl) fields.author = ruleFor(item, authorEl, 'author');

  // 去掉覆盖率太低的字段（标题除外；来自页面数据的链接已在学习时验证过）
  for (const k of ['link', 'date', 'image', 'summary', 'author'] as const) {
    const r = fields[k];
    if (r && !r.from && fieldCoverage(items, r) < 0.3) delete fields[k];
  }
  return fields;
}

export { simpleSelector };
