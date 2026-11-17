/**
 * 与 DOM 实现无关的小工具：浏览器原生 DOM 和服务端的 linkedom 都能用。
 * 只使用 querySelector / children / parentElement / getAttribute 等基础 API。
 */

const STATE_CLASSES = new Set([
  'active', 'selected', 'current', 'cur', 'on', 'hover', 'focus', 'first', 'last',
  'odd', 'even', 'show', 'hide', 'hidden', 'open', 'visible', 'clearfix', 'clear',
  'new', 'hot', 'top', 'read', 'unread', 'loaded', 'lazyloaded', 'lazyload',
]);

/** 判断 class 是否「稳定」：排除状态类、构建工具生成的哈希类和需要转义的类 */
export function isStableClass(c: string): boolean {
  if (c.length > 40) return false;
  if (!/^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(c)) return false;
  if (STATE_CLASSES.has(c.toLowerCase())) return false;
  if (/^(css|sc|jsx|svelte|emotion|styled|tw)-/i.test(c)) return false;
  if (/\d{4,}/.test(c)) return false;
  // CSS Modules / 哈希类，如 Title__a1B2c 或 _3xYz9Q
  if (/(__|_|-)[a-zA-Z0-9]{5,8}$/.test(c) && /\d/.test(c.slice(-8)) && /[a-z]/.test(c.slice(-8)) && /[A-Z]/.test(c.slice(-8))) return false;
  if (/^_?[a-zA-Z0-9]{5,10}$/.test(c) && /\d/.test(c) && /[A-Z]/.test(c) && /[a-z]/.test(c)) return false;
  return true;
}

export function isStableId(id: string): boolean {
  return /^[a-zA-Z][\w-]*$/.test(id) && !/\d{3,}/.test(id) && id.length <= 40 && !/^(ember|react|vue|ng|radix|headlessui)/i.test(id);
}

export function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

const hasMixedCaseOrDigit = (s: string) => (/[A-Z]/.test(s) && /[a-z]/.test(s)) || /\d/.test(s);

/**
 * 把一个 class 转成「稳定的 class 键」：
 * - 普通类名原样返回，如 `news-item`；
 * - CSS Modules 之类带哈希的类名，去掉会随发版变化的哈希部分，返回以 `*` 开头的子串键：
 *   `Kx7pQa_title` → `*_title`，`Card_title__a1B2c` → `*Card_title__`；
 * - 不稳定的类（状态类、纯哈希类）返回 null。
 */
export function classKey(c: string): string | null {
  if (c.length > 60 || !/^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(c)) return null;
  // 哈希在前：Kx7pQa_title、_3fRtYw_badgeBox
  let m = c.match(/^_?([A-Za-z0-9]{5,8})_([A-Za-z][A-Za-z0-9-]{2,}(?:_[A-Za-z0-9-]+)*)$/);
  if (m && hasMixedCaseOrDigit(m[1]) && !/^[A-Z][a-z]+$/.test(m[1])) return '*_' + m[2];
  // 哈希在后：Card_title__a1B2c、title-xY3z9
  m = c.match(/^([A-Za-z][\w-]*?(?:__|_|-))([A-Za-z0-9]{5,8})$/);
  if (m && m[1].length >= 4 && /\d/.test(m[2]) && /[a-zA-Z]/.test(m[2])) return '*' + m[1];
  return isStableClass(c) ? c : null;
}

/** class 键对应的 CSS 片段 */
export function classSelector(key: string): string {
  return key.startsWith('*') ? `[class*="${key.slice(1)}"]` : '.' + key;
}

/** 元素的稳定 class 键（见 classKey） */
export function stableClasses(el: Element): string[] {
  const raw = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
  const keys = raw.map(classKey).filter((k): k is string => !!k);
  return [...new Set(keys)];
}

export function simpleSelector(el: Element, classes: string[] = stableClasses(el)): string {
  return tagOf(el) + classes.map(classSelector).join('');
}

export function elementChildren(el: Element): Element[] {
  return Array.from(el.children);
}

export function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

export function safeQuery(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

export function cleanText(s: string | null | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

export function textOf(el: Element | null | undefined): string {
  return cleanText(el?.textContent);
}

/** 在父元素中加上 :nth-of-type，让选择器在兄弟中唯一 */
function partWithIndex(el: Element): string {
  let part = simpleSelector(el);
  const parent = el.parentElement;
  if (parent) {
    const siblings = elementChildren(parent);
    const same = siblings.filter((c) => c !== el && matchesSafe(c, part));
    if (same.length > 0) {
      const sameTag = siblings.filter((c) => tagOf(c) === tagOf(el));
      part += `:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
  }
  return part;
}

function matchesSafe(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

/** 为元素生成一个在文档中唯一、尽量短的选择器 */
export function pathSelector(el: Element, doc: ParentNode): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && tagOf(cur) !== 'html') {
    if (cur.id && isStableId(cur.id) && safeQueryAll(doc, '#' + cur.id).length === 1) {
      parts.unshift('#' + cur.id);
      break;
    }
    if (tagOf(cur) === 'body') {
      parts.unshift('body');
      break;
    }
    parts.unshift(partWithIndex(cur));
    const sel = parts.join(' > ');
    const hits = safeQueryAll(doc, sel);
    if (hits.length === 1 && hits[0] === el) break;
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

const GENERIC_TAGS = new Set(['a', 'span', 'div', 'p', 'em', 'b', 'i', 'strong', 'small', 'li', 'section']);

/** 文本的「信息量」长度：中日韩文字一个字顶两个字母 */
export function weightedLength(text: string): number {
  let n = 0;
  for (const ch of text) n += /[぀-ヿ㐀-鿿가-힯]/.test(ch) ? 2 : 1;
  return n;
}

/** 为条目内部的元素生成相对选择器（item.querySelector(sel) === el） */
export function relativeSelector(item: Element, el: Element): string {
  if (item === el) return '';
  if (!item.contains(el)) throw new Error('element is not inside the item');
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== item) {
    parts.unshift(simpleSelector(cur));
    cur = cur.parentElement;
  }
  // 从最短的后缀开始尝试；`a`、`span` 这类没有 class 的通用标签单独出现时太脆弱，至少带上父级
  for (let k = parts.length - 1; k >= 0; k--) {
    const suffix = parts.slice(k);
    if (suffix.length === 1 && k > 0 && GENERIC_TAGS.has(suffix[0])) continue;
    const sel = suffix.join(' > ');
    if (safeQuery(item, sel) === el) return sel;
  }
  // 需要位置信息
  const indexed: string[] = [];
  cur = el;
  while (cur && cur !== item) {
    indexed.unshift(partWithIndex(cur));
    cur = cur.parentElement;
  }
  for (let k = indexed.length - 1; k >= 0; k--) {
    const sel = indexed.slice(k).join(' > ');
    if (safeQuery(item, sel) === el) return sel;
  }
  return indexed.join(' > ');
}
