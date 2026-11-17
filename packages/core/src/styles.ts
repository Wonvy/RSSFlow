/**
 * 元素样式规则：把网页上选中的元素隐藏、模糊、变淡或改成自定义样式，按网站保存，下次打开自动生效。
 * 最常见的用途就是去广告。
 *
 * 规则最终变成一段 CSS 注入网页。CSS 对后来动态加载出来的元素同样生效，所以不需要监听页面变化。
 */
import { pathSelector, safeQueryAll, simpleSelector, stableClasses, tagOf } from './dom.ts';

export type StyleAction = 'hide' | 'blur' | 'dim' | 'custom';

export interface StyleRule {
  id: string;
  selector: string;
  action: StyleAction;
  /** action 为 custom 时的 CSS 声明，例如 `font-size: 18px; color: #333` */
  css?: string;
  /** 鼠标悬停时显示原样，移开后恢复（隐藏会改成「透明但保留位置」，否则鼠标没地方悬停） */
  revealOnHover?: boolean;
  /** 给人看的说明，例如「广告卡片」 */
  label: string;
  enabled: boolean;
  createdAt: number;
}

export interface SiteStyles {
  rules: StyleRule[];
  /** 暂停本站的全部规则 */
  paused?: boolean;
}

const ACTION_CSS: Record<Exclude<StyleAction, 'custom'>, string> = {
  hide: 'display: none !important;',
  blur: 'filter: blur(10px) !important; pointer-events: none !important;',
  dim: 'opacity: 0.12 !important; transition: opacity .2s !important;',
};

/**
 * 选择器安全检查：不能带 `{` `}` `<` `@` 和反斜杠，否则可能跳出这条规则、注入任意 CSS。
 * 再交给浏览器解析一次，语法错的直接拒绝。
 */
export function isSafeSelector(sel: string, doc?: ParentNode): boolean {
  if (!sel || sel.length > 1000 || /[{}<@\\]|\/\*/.test(sel)) return false;
  if (doc) {
    try {
      doc.querySelector(sel);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 自定义样式只允许「属性: 值;」这种声明：去掉花括号、@规则、url()、expression、注释和 HTML，
 * 防止加载外部资源或跳出这条规则。每条声明自动加上 !important。
 */
export function sanitizeDeclarations(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/;|\n/)
    .map((d) => d.trim())
    .filter((d) => /^-?[a-z][a-z-]*\s*:\s*[^{}<>@\\]+$/i.test(d))
    .filter((d) => !/url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding|image-set\s*\(/i.test(d))
    .map((d) => d.replace(/\s*!important\s*$/i, '') + ' !important;')
    .slice(0, 30)
    .join(' ')
    .slice(0, 2000);
}

/** 不带单位时默认是 px 的属性之外，这些属性的数字本身就是合法值 */
const UNITLESS = /^(opacity|z-index|font-weight|line-height|flex|flex-grow|flex-shrink|order|zoom|orphans|widows|column-count|fill-opacity|stroke-opacity|scale)$/;

/** 用户在输入框里填了纯数字时，按属性补上单位：font-size 填 18 → 18px */
export function normalizeValue(prop: string, value: string): string {
  const v = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(v) && !UNITLESS.test(prop) && v !== '0') return v + 'px';
  return v;
}

/** 把「属性: 值;」文本解析成有序的属性表（只保留安全的声明，去掉 !important） */
export function parseDeclarations(css: string): [string, string][] {
  return sanitizeDeclarations(css)
    .split(/;\s*/)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const i = d.indexOf(':');
      return [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).replace(/\s*!important\s*$/i, '').trim()] as [string, string];
    });
}

/** 属性表 → 「属性: 值;」文本（给人看、可以再编辑） */
export function serializeDeclarations(decls: Iterable<[string, string]>): string {
  return [...decls].map(([p, v]) => `${p}: ${v};`).join('\n');
}

/** 「悬停显示」时，隐藏改为透明（保留位置，鼠标才有地方悬停） */
const HOVER_HIDE_CSS = 'opacity: 0 !important;';
const HOVER_TRANSITION = 'transition: opacity .15s ease, filter .15s ease !important;';

/** 给选择器的每一部分（逗号分隔，括号里的逗号不算）加上后缀，例如 :not(:hover) */
export function appendToEach(selector: string, suffix: string): string {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean).map((p) => p + suffix).join(', ');
}

export function ruleCss(rule: Pick<StyleRule, 'selector' | 'action' | 'css' | 'revealOnHover'>): string {
  if (!isSafeSelector(rule.selector)) return '';
  if (rule.revealOnHover) {
    // pointer-events: none 会让鼠标「悬停」不上去，悬停显示时去掉
    const base = rule.action === 'custom' ? sanitizeDeclarations(rule.css || '') : rule.action === 'hide' ? HOVER_HIDE_CSS : ACTION_CSS[rule.action];
    const decl = base.replace(/pointer-events\s*:[^;]*;?/gi, '').trim();
    if (!decl) return '';
    return `${rule.selector} { ${HOVER_TRANSITION} }\n${appendToEach(rule.selector, ':not(:hover)')} { ${decl} }`;
  }
  const decl = rule.action === 'custom' ? sanitizeDeclarations(rule.css || '') : ACTION_CSS[rule.action];
  return decl ? `${rule.selector} { ${decl} }` : '';
}

/** 把一个网站的全部规则变成一段 CSS */
export function buildCss(site: SiteStyles | undefined): string {
  if (!site || site.paused) return '';
  return site.rules
    .filter((r) => r.enabled)
    .map(ruleCss)
    .filter(Boolean)
    .join('\n');
}

// ---------- 为选中的元素生成选择器 ----------

export interface SelectorChoice {
  /** 只命中这一个 */
  single: string;
  /** 命中所有同类（例如所有广告卡片）；没有可靠的同类写法时为 undefined */
  similar?: string;
}

/** 元素自己的「同类」写法：标签 + 稳定的 class；没有 class 时带上父元素 */
function similarOf(el: Element): string | undefined {
  if (stableClasses(el).length) return simpleSelector(el);
  const parent = el.parentElement;
  if (parent && stableClasses(parent).length && !['body', 'html'].includes(tagOf(parent))) return `${simpleSelector(parent)} > ${tagOf(el)}`;
  return undefined;
}

/**
 * @param target 要设置样式的元素
 * @param anchor 用户最初点中的元素（扩大到外层时，用它来限定「哪一种外层」：
 *   比如「装着广告卡片的那种格子」，而不是所有格子）
 */
export function selectorChoices(target: Element, doc: ParentNode, anchor: Element = target): SelectorChoice {
  const single = pathSelector(target, doc);
  let similar: string | undefined;
  if (anchor === target || !target.contains(anchor)) {
    similar = similarOf(target);
  } else {
    const inner = similarOf(anchor);
    const outer = stableClasses(target).length ? simpleSelector(target) : tagOf(target);
    if (inner) similar = `${outer}:has(${inner})`;
  }
  if (similar && !isSafeSelector(similar, doc)) similar = undefined;
  // 同类写法如果把整页大部分元素都选进去了（比如所有 div），就不提供
  if (similar && safeQueryAll(doc, similar).length > 300) similar = undefined;
  return { single, similar };
}

/** 给规则起个能看懂的名字：元素里的文字，或者它的 class / 标签 */
export function describeElement(el: Element): string {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 24 ? text.slice(0, 24) + '…' : text;
  const alt = el.getAttribute('alt') || el.querySelector('img')?.getAttribute('alt');
  if (alt) return alt.slice(0, 24);
  const cls = stableClasses(el)[0];
  return `<${tagOf(el)}${cls ? ' ' + cls.replace(/^\*/, '') : ''}>`;
}

export function newRuleId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
