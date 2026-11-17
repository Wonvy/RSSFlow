/**
 * 详情页：从一篇文章 / 作品的页面里抽取正文、摘要、发布时间、作者和标签。
 *
 * 数据来源按可靠程度依次尝试：JSON-LD（schema.org）→ Open Graph / meta 标签 → 正文区域。
 * 正文区域用一个简化的「可读性」算法找：段落文字最多、链接比例最低的那块。
 */
import { cleanText, safeQuery, safeQueryAll, tagOf, textOf } from './dom.ts';
import { parseDate } from './date.ts';
import { imageSrc, resolveUrl } from './extract.ts';

export interface DetailData {
  title?: string;
  description?: string;
  image?: string;
  /** ISO 8601 */
  published?: string;
  author?: string;
  tags?: string[];
  /** 正文纯文本 */
  text?: string;
  /** 清理过的正文 HTML（只保留安全的标签） */
  contentHtml?: string;
  /** 正文里的内容图片（作品图、插图），按页面顺序；不含头像、图标、推荐区的小图 */
  images?: string[];
}

const MAX_HTML = 60_000;

function meta(doc: ParentNode, ...names: string[]): string | undefined {
  for (const n of names) {
    const el = safeQuery(doc, `meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = cleanText(el?.getAttribute('content'));
    if (v) return v;
  }
  return undefined;
}

/** 读取 JSON-LD 里的文章信息 */
function jsonLd(doc: ParentNode): Record<string, unknown> | undefined {
  for (const s of safeQueryAll(doc, 'script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent || '') as unknown;
      const list = (Array.isArray(data) ? data : [data]).flatMap((d) => {
        const g = (d as { '@graph'?: unknown[] })?.['@graph'];
        return Array.isArray(g) ? g : [d];
      }) as Record<string, unknown>[];
      const hit = list.find((d) => d && /Article|Posting|CreativeWork|BlogPosting|NewsArticle|VisualArtwork|ImageObject/i.test(String(d['@type'])));
      if (hit) return hit;
    } catch {
      /* 忽略格式错误的 JSON-LD */
    }
  }
  return undefined;
}

function ldString(v: unknown): string | undefined {
  if (typeof v === 'string') return cleanText(v) || undefined;
  if (Array.isArray(v)) return ldString(v[0]);
  if (v && typeof v === 'object') return ldString((v as { name?: unknown; url?: unknown }).name ?? (v as { url?: unknown }).url);
  return undefined;
}

// ---------- 正文区域 ----------

const NOISE_RE = /comment|footer|header|sidebar|related|recommend|share|social|nav|menu|breadcrumb|banner|advert|\bad\b|promo|login|signup|subscribe|copyright|toolbar|popup|modal/i;
const CONTENT_HINT_RE = /article|content|post|entry|detail|body|rich-?text|markdown|main|story|text/i;
const BLOCK_TAGS = new Set(['p', 'li', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'figcaption', 'td']);

function linkDensity(el: Element): number {
  const total = textOf(el).length || 1;
  const linked = safeQueryAll(el, 'a').reduce((n, a) => n + textOf(a).length, 0);
  return linked / total;
}

// ---------- 内容图片 ----------

const NOISE_TAGS = new Set(['header', 'nav', 'footer', 'aside']);
const IMG_NOISE_RE = /avatar|logo|icon|emoji|badge|honor|qrcode|\bqr\b|sprite|loading|placeholder|spacer|blank\.gif/i;

/** 网址里写着的缩放尺寸，如 w_80、width=120、/80x80/ */
function urlSizeHint(src: string): number | undefined {
  const m = src.match(/[,_/?&](?:w|width)[_=](\d{2,4})\b/i) || src.match(/\/(\d{2,4})x\d{2,4}\//);
  return m ? Number(m[1]) : undefined;
}

/** 是不是正文里的「内容图」：不是头像/图标/小图，也不在导航、页脚、侧栏、评论、推荐区里 */
export function isContentImage(img: Element): boolean {
  const src = imageSrc(img) || '';
  if (!src || /\.svg(\?|#|$)/i.test(src)) return false;
  const w = Number(img.getAttribute('width'));
  const h = Number(img.getAttribute('height'));
  if ((w > 0 && w <= 120) || (h > 0 && h <= 120)) return false;
  const hint = urlSizeHint(src);
  if (hint !== undefined && hint <= 160) return false;
  if (IMG_NOISE_RE.test(src) || IMG_NOISE_RE.test(img.getAttribute('class') || '')) return false;
  let cur: Element | null = img.parentElement;
  while (cur && !['body', 'html'].includes(tagOf(cur))) {
    if (NOISE_TAGS.has(tagOf(cur))) return false;
    const sig = (cur.getAttribute('class') || '') + ' ' + (cur.id || '');
    if (NOISE_RE.test(sig) || /avatar|author|user-?info|creator/i.test(sig)) return false;
    cur = cur.parentElement;
  }
  return true;
}

export function contentImages(root: ParentNode): Element[] {
  return safeQueryAll(root, 'img').filter(isContentImage);
}

/** 找正文所在的元素（文字段落和内容图都计分，所以以图片为主的作品页也能找对） */
export function findMainContent(doc: Document | ParentNode): Element | undefined {
  const preferred = safeQuery(doc, '[itemprop="articleBody"], article .article-content, .article-content, .post-content, .entry-content, .rich_media_content, #js_content');
  if (preferred && textOf(preferred).length > 80) return preferred;

  const scores = new Map<Element, number>();
  const add = (el: Element | null, v: number) => {
    if (!el || ['html', 'body'].includes(tagOf(el))) return;
    scores.set(el, (scores.get(el) || 0) + v);
  };
  const blocks = safeQueryAll(doc, 'p, li, h2, h3, blockquote, pre, div, section, span').filter((el) => {
    if (!BLOCK_TAGS.has(tagOf(el))) {
      // div / section / span 只有在「直接装着文字」时才算一个段落
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent || '').join('').trim();
      return own.length >= 25;
    }
    return true;
  });
  for (const b of blocks) {
    const text = textOf(b);
    if (text.length < 15) continue;
    if (NOISE_RE.test((b.getAttribute('class') || '') + ' ' + (b.id || ''))) continue;
    const v = 1 + Math.min(text.length / 50, 6) + (text.match(/[，。,.！？]/g)?.length ?? 0) * 0.3;
    add(b.parentElement, v);
    add(b.parentElement?.parentElement ?? null, v / 2);
  }
  // 每张内容图往上 5 层都加分：作品图通常一张一个包装层，它们共同的容器得分最高
  const IMG_WEIGHTS = [4, 3, 2.5, 2, 1.5];
  for (const img of contentImages(doc)) {
    let cur = img.parentElement;
    for (const w of IMG_WEIGHTS) {
      if (!cur) break;
      add(cur, w);
      cur = cur.parentElement;
    }
  }
  let best: Element | undefined;
  let bestScore = 0;
  for (const [el, s] of scores) {
    const sig = (el.getAttribute('class') || '') + ' ' + (el.id || '');
    let score = s * (1 - linkDensity(el));
    if (CONTENT_HINT_RE.test(sig)) score *= 1.25;
    if (NOISE_RE.test(sig)) score *= 0.3;
    if (tagOf(el) === 'article' || tagOf(el) === 'main') score *= 1.2;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return bestScore >= 5 ? best : undefined;
}

// ---------- 正文 HTML 清理 ----------

const KEEP_TAGS = new Set(['p', 'br', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'strong', 'b', 'em', 'i', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tr', 'td', 'th']);
const DROP_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'form', 'button', 'input', 'select', 'textarea', 'svg', 'canvas', 'video', 'audio', 'object', 'embed', 'nav', 'footer', 'header', 'aside']);

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 只保留安全的标签和必要的属性（a 的 href、img 的 src），网址补全为绝对地址 */
export function sanitizeContent(root: Element, baseUrl: string): string {
  let out = '';
  const walk = (node: Node) => {
    if (out.length > MAX_HTML) return;
    if (node.nodeType === 3) {
      out += escapeHtml(node.textContent || '');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = tagOf(el);
    if (DROP_TAGS.has(tag)) return;
    if (NOISE_RE.test((el.getAttribute('class') || '') + ' ' + (el.id || '')) && el !== root && textOf(el).length < 400) return;
    if (tag === 'img') {
      if (!isContentImage(el)) return;
      const src = resolveUrl(imageSrc(el), baseUrl);
      if (src) out += `<img src="${escapeHtml(src)}" alt="${escapeHtml(cleanText(el.getAttribute('alt')))}" referrerpolicy="no-referrer">`;
      return;
    }
    if (tag === 'br') {
      out += '<br>';
      return;
    }
    const keep = KEEP_TAGS.has(tag) && el !== root;
    // div 之类的容器：里面没有块级元素时当成一个段落，否则只展开它的内容，避免 <p><p> 嵌套
    const hasBlockChild = Array.from(el.children).some((c) => /^(p|div|section|article|ul|ol|h[1-6]|blockquote|pre|figure|table)$/.test(tagOf(c)));
    const blockish = !keep && /^(div|section|article|main)$/.test(tag) && el !== root && !hasBlockChild;
    if (keep) {
      if (tag === 'a') {
        const href = resolveUrl(el.getAttribute('href'), baseUrl);
        out += href && /^https?:/.test(href) ? `<a href="${escapeHtml(href)}">` : '<a>';
      } else out += `<${tag}>`;
    } else if (blockish) out += '<p>';
    el.childNodes.forEach(walk);
    if (keep) out += `</${tag}>`;
    else if (blockish) out += '</p>';
  };
  walk(root);
  return out
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/(<br>\s*){3,}/g, '<br><br>')
    .replace(/\s{2,}/g, ' ')
    .slice(0, MAX_HTML)
    .trim();
}

// ---------- 抽取 ----------

export function extractDetail(doc: Document | ParentNode, pageUrl: string, opts: { utcOffset?: number } = {}): DetailData {
  const ld = jsonLd(doc);
  const d: DetailData = {};
  d.title = ldString(ld?.headline) || meta(doc, 'og:title', 'twitter:title') || cleanText(safeQuery(doc, 'title')?.textContent) || undefined;
  d.description = ldString(ld?.description) || meta(doc, 'og:description', 'description', 'twitter:description');
  const img = ldString(ld?.image) || meta(doc, 'og:image', 'twitter:image');
  if (img) d.image = resolveUrl(img, pageUrl);
  const dateText =
    ldString(ld?.datePublished) ||
    meta(doc, 'article:published_time', 'og:release_date', 'datePublished', 'publishdate', 'pubdate', 'publish_date') ||
    safeQuery(doc, 'time[datetime]')?.getAttribute('datetime') ||
    undefined;
  const date = dateText ? parseDate(dateText, { utcOffset: opts.utcOffset }) : undefined;
  if (date) d.published = date.toISOString();
  d.author = ldString(ld?.author) || meta(doc, 'author', 'article:author', 'og:article:author') || undefined;
  if (d.author && /^https?:/.test(d.author)) d.author = undefined;
  const tags = [
    ...safeQueryAll(doc, 'meta[property="article:tag"]').map((m) => cleanText(m.getAttribute('content'))),
    ...String(ldString(ld?.keywords) || '').split(/[,，]/).map(cleanText),
  ].filter((t) => t && t.length <= 20);
  if (tags.length) d.tags = [...new Set(tags)].slice(0, 8);

  const main = findMainContent(doc);
  if (main) {
    d.text = textOf(main);
    d.contentHtml = sanitizeContent(main, pageUrl);
  }
  // 内容图片：优先取正文区域里的；正文区域里几乎没有图、整页却有不少时，用整页的
  let imgs = main ? contentImages(main) : [];
  const all = contentImages(doc);
  if (imgs.length < 2 && all.length >= 3) imgs = all;
  const urls = [...new Set(imgs.map((i) => resolveUrl(imageSrc(i), pageUrl)).filter((u): u is string => !!u))].slice(0, 80);
  if (urls.length) {
    d.images = urls;
    // 正文 HTML 里没带上的图补在后面，保证订阅里能看到全部作品图
    const missing = urls.filter((u) => !d.contentHtml?.includes(escapeHtml(u)));
    if (missing.length) d.contentHtml = (d.contentHtml || '') + missing.map((u) => `<p><img src="${escapeHtml(u)}" alt="" referrerpolicy="no-referrer"></p>`).join('');
  }
  if (!d.image && urls[0]) d.image = urls[0];
  return d;
}

// ---------- 摘要 ----------

/** 网页描述里常带的全站套话（例如「本站汇聚了上万名设计师…」）：在多篇描述里都出现的公共前缀/后缀 */
export function commonBoilerplate(descriptions: string[]): { prefix: string; suffix: string } {
  const list = descriptions.filter(Boolean);
  if (list.length < 2) return { prefix: '', suffix: '' };
  let prefix = list[0];
  let suffix = list[0];
  for (const s of list.slice(1)) {
    while (prefix && !s.startsWith(prefix)) prefix = prefix.slice(0, -1);
    while (suffix && !s.endsWith(suffix)) suffix = suffix.slice(1);
  }
  // 边界落在标点上：「…的故事,本站汇聚了…」里的「的故事」属于正文，不能当成套话去掉
  const SEP = /[,，。.;；|｜·\-–—_:：!！?？\s]/;
  const p = [...prefix].findLastIndex((c) => SEP.test(c));
  prefix = p >= 0 ? prefix.slice(0, p + 1) : '';
  const q = [...suffix].findIndex((c) => SEP.test(c));
  suffix = q >= 0 ? suffix.slice(q) : '';
  return { prefix: prefix.length >= 12 ? prefix : '', suffix: suffix.length >= 12 ? suffix : '' };
}

/** 按句子截断，不超过 max 个字符 */
export function firstSentences(text: string, max = 160): string {
  const t = cleanText(text);
  if (t.length <= max) return t;
  const sentences = t.match(/[^。！？!?.；;]+[。！？!?.；;]?/g) || [t];
  let out = '';
  for (const s of sentences) {
    if ((out + s).length > max) break;
    out += s;
  }
  return (out || t.slice(0, max)).trim() + (out.length < t.length ? '…' : '');
}

/**
 * 生成摘要：优先用网页描述（去掉标题重复和全站套话），描述太短或没有时用正文前几句。
 */
export function summarize(d: DetailData, opts: { title?: string; boilerplate?: { prefix: string; suffix: string }; max?: number } = {}): string | undefined {
  const max = opts.max ?? 160;
  let desc = d.description || '';
  const bp = opts.boilerplate;
  if (bp?.prefix && desc.startsWith(bp.prefix)) desc = desc.slice(bp.prefix.length);
  if (bp?.suffix && desc.endsWith(bp.suffix)) desc = desc.slice(0, -bp.suffix.length);
  // 去掉开头重复的标题，如「标题,正文…」
  for (const t of [opts.title, d.title].filter(Boolean) as string[]) {
    const head = t.split(/[_|｜\-–—]/)[0].trim();
    if (head && desc.startsWith(head)) desc = desc.slice(head.length).replace(/^[\s,，:：|｜\-–—]+/, '');
  }
  // 去掉结尾带网站名的套话：网站名取自标题末尾，如「…-示例社区Demo」→「示例社区」
  const site = (d.title || '').split(/[_|｜\-–—]/).pop()?.trim() || '';
  const brand = site.replace(/[A-Za-z0-9\s.]+/g, '') || site;
  if (brand.length >= 2) {
    const parts = desc.split(/(?<=[,，])/);
    while (parts.length > 1 && parts[parts.length - 1].includes(brand)) parts.pop();
    desc = parts.join('');
  }
  desc = desc.replace(/[\s,，;；]+$/, '').trim();
  // 只是一串关键词（「北京设计爱好者,某某网,设计师互动平台」）不算摘要
  const pieces = desc.split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
  if (pieces.length >= 3 && !/[。！？!?]/.test(desc) && pieces.every((x) => x.replace(/[.。]$/, '').length <= 12)) desc = '';
  const fromText = d.text ? firstSentences(d.text, max) : '';
  if (desc.length >= 20 || (desc && !fromText)) return firstSentences(desc, max);
  return fromText || undefined;
}

// ---------- 反爬挑战页 ----------

/**
 * 是不是反爬虫的 JS 挑战 / 验证页（页面很短、几乎没有正文，却带着计算 cookie 或跳转的脚本）。
 * 识别出来之后直接跳过，RSSFlow 不会尝试破解。
 */
export function isChallengePage(html: string): boolean {
  if (html.length > 60_000) return false;
  // 去掉脚本、标签和挑战页常带的超长乱码（base64 等），只留下人能读的文字
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')
    .replace(/\S{80,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const challengeScript = /acw_sc__v2|var\s+arg1\s*=|__jsl_clearance|_0x[0-9a-f]{4}|cf-browser-verification|cf_chl_|challenge-platform|document\.cookie\s*=.*location\.(reload|href)/i.test(html);
  const verifyText = /access verification|verify you are human|just a moment|captcha|安全验证|人机验证|滑动验证|请完成验证|访问验证/i.test(text);
  return (challengeScript && text.length < 2000) || (verifyText && text.length < 600);
}
