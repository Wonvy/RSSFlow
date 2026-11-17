/**
 * 接口模式：直接读取网站自己的数据接口（JSON），而不是解析网页。
 *
 * 选取时，扩展会记录页面发出的 fetch / XHR 请求。用户点中一个列表后，
 * 在这些 JSON 响应里找一个「标题能和网页上的列表对上」的数组，再推断出链接、时间、图片、摘要各在哪个字段。
 *
 * 字段用模板表示：`{content.title}` 取路径上的值；`https://x.com/p/{id}.html` 把值拼进网址。
 */
import type { ApiSource, FeedItem } from './types.ts';
import { cleanText } from './dom.ts';
import { parseDate } from './date.ts';
import { PROFILE_URL_RE, isPageUrl } from './datalink.ts';
import { resolveUrl } from './extract.ts';

type Json = unknown;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** 按路径取值：`data.list`、`content.title`、`items.0.name`；空路径表示自身 */
export function getPath(obj: Json, path: string): unknown {
  if (!path) return obj;
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = cur[Number(key)];
    else if (typeof cur === 'object') cur = (cur as Obj)[key];
    else return undefined;
  }
  return cur;
}

function primitive(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

/** 渲染字段模板；用到的任一路径没有值时返回 undefined */
export function renderTemplate(tpl: string, obj: Json): string | undefined {
  let missing = false;
  const out = tpl.replace(/\{([^{}]+)\}/g, (_m, path: string) => {
    const v = primitive(getPath(obj, path.trim()));
    if (v === undefined || v === '') missing = true;
    return v ?? '';
  });
  return missing || !out.trim() ? undefined : out;
}

/** 去掉 HTML 标签和常见实体（搜索接口常把关键词包在 <em> 里） */
export function plainText(s: string): string {
  return cleanText(
    s
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&#10;/g, ' '),
  );
}

/** 找出 JSON 里所有「对象数组」及其路径 */
export function findObjectArrays(json: Json, maxDepth = 6): { path: string; items: Obj[] }[] {
  const out: { path: string; items: Obj[] }[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (depth > maxDepth) return;
    if (Array.isArray(v)) {
      const objs = v.filter(isObj);
      if (objs.length >= 2 && objs.length >= v.length * 0.6) out.push({ path, items: objs });
      // 数组里的对象也可能嵌套数组，只看第一个
      if (objs[0]) walk(objs[0], path ? `${path}.0` : '0', depth + 1);
      return;
    }
    if (isObj(v)) for (const [k, child] of Object.entries(v)) walk(child, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(json, '', 0);
  // 路径里不能带「.0」（那是示例元素内部的数组，不是真正的列表位置）
  return out.filter((a) => !/(^|\.)0(\.|$)/.test(a.path));
}

/** 对象里所有叶子字段的路径 → 值（不进入数组） */
export function leafPaths(obj: Obj, maxDepth = 4): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (v: unknown, path: string, depth: number) => {
    const p = primitive(v);
    if (p !== undefined) {
      out.set(path, p);
      return;
    }
    if (depth >= maxDepth || !isObj(v)) return;
    for (const [k, child] of Object.entries(v)) {
      if (/^[\w$-]+$/.test(k)) walk(child, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(obj, '', 0);
  return out;
}

const norm = (s: string) => plainText(s).toLowerCase();

/** 两个标题是否算同一个（网页上可能被截断成「…」） */
export function sameTitle(a: string, b: string): boolean {
  const x = norm(a).replace(/[.…]+$/, '');
  const y = norm(b).replace(/[.…]+$/, '');
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.startsWith(short) && short.length / long.length >= 0.6;
}

const parentOf = (path: string) => path.split('.').slice(0, -1).join('.');
const lastKey = (path: string) => path.split('.').pop()!.toLowerCase();

function coverage(items: Obj[], fn: (o: Obj) => boolean): number {
  return items.length ? items.filter(fn).length / items.length : 0;
}

/** 候选字段路径：所有样本对象叶子路径的并集 */
function candidatePaths(items: Obj[]): string[] {
  const set = new Set<string>();
  for (const o of items.slice(0, 15)) for (const p of leafPaths(o).keys()) set.add(p);
  return [...set];
}

const IMAGE_URL_RE = /\.(jpe?g|png|gif|webp|avif)(\?|#|$)|x-oss-process=image|imageView2|imageMogr|\/(images?|img|pics?|covers?|thumbs?)\//i;
const AUTHOR_PATH_RE = /author|user|creator|owner|member|avatar|uploader|profile|publisher|account/i;
const looksUrl = (v: string) => /^(https?:)?\/\/|^\/[\w-]/.test(v);
const isTimestamp = (v: string) => {
  if (!/^\d{10}(\d{3})?$/.test(v)) return false;
  const ms = v.length === 13 ? Number(v) : Number(v) * 1000;
  return ms > Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1);
};

export interface ApiFieldGuess {
  fields: ApiSource['fields'];
}

/**
 * 推断字段模板。
 * @param domLinks 网页上已知的「标题 → 链接」，用来在接口没有直接给出网址时，学习链接的拼法（如 /p/{id}.html）
 */
export function inferApiFields(items: Obj[], titlePath: string, pageUrl: string, domLinks: Map<string, string> = new Map()): ApiSource['fields'] {
  const paths = candidatePaths(items);
  const base = parentOf(titlePath);
  const near = (p: string) => (parentOf(p) === base ? 3 : p.startsWith(base) ? 1 : 0);
  const val = (o: Obj, p: string) => primitive(getPath(o, p));
  const fields: ApiSource['fields'] = { title: `{${titlePath}}` };

  const best = (scored: { p: string; s: number }[]) => scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0]?.p;

  // 链接：值是网址、不是图片和作者主页、每条都不同
  const linkPath = best(
    paths
      .filter((p) => p !== titlePath)
      .map((p) => {
        const vals = items.map((o) => val(o, p)).filter((v): v is string => !!v);
        if (coverage(items, (o) => !!val(o, p) && looksUrl(val(o, p)!)) < 0.6) return { p, s: 0 };
        const abs = vals.map((v) => resolveUrl(v, pageUrl) || '');
        if (abs.some((u) => !isPageUrl(u)) || abs.filter((u) => PROFILE_URL_RE.test(u)).length > abs.length / 2) return { p, s: 0 };
        if (new Set(abs).size < abs.length * 0.8) return { p, s: 0 };
        let s = 2 + near(p);
        if (/url|link|href|path|permalink/.test(lastKey(p))) s += 2;
        if (AUTHOR_PATH_RE.test(p)) s -= 4;
        if (/scheme|app|deeplink|share/.test(lastKey(p))) s -= 2;
        return { p, s };
      }),
  );
  if (linkPath) fields.link = `{${linkPath}}`;
  else if (domLinks.size) {
    // 用网页上已知的链接学习拼法：找出出现在链接里的那个字段值
    const votes = new Map<string, number>();
    for (const o of items) {
      const title = val(o, titlePath);
      const link = title && [...domLinks].find(([t]) => sameTitle(t, title))?.[1];
      if (!link) continue;
      for (const [p, v] of leafPaths(o)) {
        if (p === titlePath || v.length < 2 || !link.includes(v)) continue;
        const tpl = link.replace(v, `{${p}}`);
        votes.set(tpl, (votes.get(tpl) || 0) + 1);
      }
    }
    const top = [...votes].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) fields.link = top[0];
  }

  // 时间：时间戳或可解析的日期，字段名里带 publish 的优先
  const datePath = best(
    paths.map((p) => {
      const ok = coverage(items, (o) => {
        const v = val(o, p);
        return !!v && (isTimestamp(v) || (/\d{4}-\d{2}-\d{2}|\d{4}\/\d{1,2}\/\d{1,2}|年|前$/.test(v) && !!parseDate(v)));
      });
      if (ok < 0.6) return { p, s: 0 };
      const k = lastKey(p);
      let s = 1 + near(p);
      // 时间戳、完整日期比「3小时前」这种相对时间精确
      const sample = items.map((o) => val(o, p)).find(Boolean) || '';
      if (isTimestamp(sample) || /\d{4}-\d{2}-\d{2}/.test(sample)) s += 2;
      if (/前$/.test(sample) || /diff|ago|relative|str$/.test(k)) s -= 2;
      if (/publish|pub|release|post(ed)?_?(at|time|date)|online/.test(k)) s += 4;
      else if (/create|ctime|add|date|time/.test(k)) s += 2;
      if (/update|modif|edit|mtime|recommend|last|expire|end/.test(k)) s -= 1;
      if (AUTHOR_PATH_RE.test(p)) s -= 3;
      return { p, s };
    }),
  );
  if (datePath) fields.date = `{${datePath}}`;

  // 图片：图片网址，不在作者/头像下面
  const imagePath = best(
    paths.map((p) => {
      if (coverage(items, (o) => { const v = val(o, p); return !!v && looksUrl(v) && (IMAGE_URL_RE.test(v) || /cover|img|image|thumb|pic|poster|banner/.test(lastKey(p))); }) < 0.5) return { p, s: 0 };
      if (AUTHOR_PATH_RE.test(p) || /avatar|icon|logo|qr/.test(lastKey(p))) return { p, s: 0 };
      let s = 1 + near(p);
      if (/^(cover|image|img|thumb|thumbnail|pic|poster)$/.test(lastKey(p))) s += 3;
      if (/\d+x$|small|mini/.test(lastKey(p))) s -= 1;
      return { p, s };
    }),
  );
  if (imagePath) fields.image = `{${imagePath}}`;

  // 摘要：较长的文字，不是标题、不是网址
  const summaryPath = best(
    paths
      .filter((p) => p !== titlePath)
      .map((p) => {
        const vals = items.map((o) => val(o, p)).filter((v): v is string => !!v && !looksUrl(v));
        if (vals.length < items.length * 0.5) return { p, s: 0 };
        const avg = vals.reduce((a, v) => a + plainText(v).length, 0) / vals.length;
        if (avg < 20 || /^\d+$/.test(vals[0])) return { p, s: 0 };
        let s = 1 + near(p) + Math.min(avg / 50, 2);
        if (/desc|summary|intro|excerpt|abstract|brief|digest|content|text/.test(lastKey(p))) s += 3;
        if (/title|name|tdk|seo|keyword|time|tip|label|tag|status/.test(lastKey(p)) || AUTHOR_PATH_RE.test(p)) s -= 6;
        return { p, s };
      }),
  );
  if (summaryPath) fields.summary = `{${summaryPath}}`;

  // 作者：作者/用户对象下面的名字字段
  const authorPath = best(
    paths.map((p) => {
      if (!AUTHOR_PATH_RE.test(parentOf(p)) && !/^(author|creator|user_?name|nickname)$/.test(lastKey(p))) return { p, s: 0 };
      if (!/name|nick|screen/.test(lastKey(p)) || /id$|url|avatar|home/.test(lastKey(p))) return { p, s: 0 };
      const ok = coverage(items, (o) => { const v = val(o, p); return !!v && v.length <= 40 && !looksUrl(v) && !/^\d+$/.test(v); });
      return { p, s: ok >= 0.6 ? 1 + near(p) + (/^(username|nickname|name|screen_?name|display_?name)$/.test(lastKey(p)) ? 2 : 0) : 0 };
    }),
  );
  if (authorPath) fields.author = `{${authorPath}}`;

  // 分类/标签：短文字，字段名像 category / tag / cate
  const tagPaths = paths
    .filter((p) => p !== titlePath && !AUTHOR_PATH_RE.test(p) && /cate|categor|tag|channel|topic|genre|column|section|type(str|name)/.test(lastKey(p)) && !/id$|ids$|code$|count|num/.test(lastKey(p)))
    .filter((p) => coverage(items, (o) => { const v = val(o, p); return !!v && v.length <= 16 && !/^\d+$/.test(v) && !looksUrl(v); }) >= 0.6)
    .sort((a, b) => near(b) - near(a))
    .slice(0, 3);
  if (tagPaths.length) fields.tags = tagPaths.map((p) => `{${p}}`).join(',');
  return fields;
}

/**
 * 可能是用户个人凭证的参数名。规则会被公开分享，这些参数必须在保存前去掉，
 * 否则会把用户的登录态泄露给所有人。
 */
export const SECRET_PARAM_RE = /token|auth|session|sess_?id|^sid$|sign(ature)?$|^sig$|secret|passw|ticket|csrf|xsrf|cookie|credential|api_?key|access_?key|^key$|^uid$|^userid$|^user_id$|^openid$|^unionid$/i;

/** 把翻页参数改回第一页（订阅总是从最新的内容开始），并去掉可能是个人凭证的参数 */
export function firstPageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const [k, v] of [...url.searchParams]) {
      const key = k.toLowerCase();
      if (SECRET_PARAM_RE.test(k)) url.searchParams.delete(k);
      else if (/^(p|page|pn|pageno|page_no|pagenum|page_num|pageindex|page_index|current|curpage)$/.test(key) && /^\d+$/.test(v)) url.searchParams.set(k, '1');
      else if (/^(offset|start|skip|from)$/.test(key) && /^\d+$/.test(v)) url.searchParams.set(k, '0');
      else if (/^(cursor|after|last_?id|max_?id|since|next|lastid|maxid|searchafter|search_after|_|t|ts|timestamp|callback)$/.test(key)) url.searchParams.delete(k);
    }
    return url.href;
  } catch {
    return raw;
  }
}

/** 同样处理 POST 请求体：翻页参数改回第一页，去掉个人凭证（JSON 或表单格式） */
export function firstPageBody(body: string | undefined): string | undefined {
  if (!body) return body;
  try {
    const obj = JSON.parse(body) as unknown;
    const fix = (v: unknown) => {
      if (!isObj(v)) return;
      for (const [k, child] of Object.entries(v)) {
        const key = k.toLowerCase();
        if (SECRET_PARAM_RE.test(k)) delete v[k];
        else if (/^(p|page|pn|pageno|pagenum|pageindex|current)$/.test(key) && typeof child === 'number') v[k] = 1;
        else if (/^(offset|start|skip)$/.test(key) && typeof child === 'number') v[k] = 0;
        else if (/^(cursor|after|lastid|maxid|searchafter)$/.test(key)) delete v[k];
        else fix(child);
      }
    };
    fix(obj);
    return JSON.stringify(obj);
  } catch {
    // 表单格式：a=1&b=2
    if (/^[\w.%-]+=/.test(body)) {
      const form = new URLSearchParams(body);
      for (const k of [...form.keys()]) if (SECRET_PARAM_RE.test(k)) form.delete(k);
      return form.toString();
    }
    return undefined;
  }
}

/** 解析接口响应：兼容 XSSI 前缀和 JSONP */
export function parseJsonLoose(text: string): unknown {
  const t = text.trim().replace(/^\)\]\}',?\s*/, '').replace(/^while\s*\(1\);\s*/, '').replace(/^for\s*\(;;\);\s*/, '');
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/);
    if (m) return JSON.parse(m[1]);
    throw new Error('not json');
  }
}

export interface CapturedResponse {
  url: string;
  method: string;
  /** 请求体（POST） */
  body?: string;
  contentType?: string;
  json: unknown;
}

export interface ApiMatch {
  api: ApiSource;
  /** 和网页列表对上的标题数 */
  hits: number;
  /** 接口里的条目数 */
  count: number;
  /** 匹配上的那次响应（用于预览） */
  response: CapturedResponse;
}

/**
 * 在抓到的接口响应里找和网页列表对应的那一个。
 * @param titles 网页上识别出的条目标题
 * @param domLinks 网页上已知的「标题 → 链接」
 */
export function matchApi(responses: CapturedResponse[], titles: string[], pageUrl: string, domLinks: Map<string, string> = new Map()): ApiMatch | undefined {
  const want = titles.filter((t) => t && t.length >= 2);
  if (want.length < 2) return undefined;
  let best: (ApiMatch & { score: number }) | undefined;
  for (const res of responses) {
    for (const arr of findObjectArrays(res.json)) {
      for (const p of candidatePaths(arr.items)) {
        const values = arr.items.map((o) => primitive(getPath(o, p))).filter((v): v is string => typeof v === 'string' && v.length >= 2);
        if (values.length < 2) continue;
        const hits = want.filter((t) => values.some((v) => sameTitle(t, v))).length;
        if (hits < 2) continue;
        const ratio = hits / Math.min(want.length, arr.items.length);
        if (ratio < 0.3) continue;
        // 标题对上得越多越好；同分时字段名像 title 的优先
        const score = hits + ratio + (/title|name|subject|headline/.test(lastKey(p)) ? 0.5 : 0);
        if (!best || score > best.score) {
          best = {
            score,
            hits,
            count: arr.items.length,
            response: res,
            api: {
              url: firstPageUrl(res.url),
              method: res.method === 'POST' ? 'POST' : 'GET',
              ...(res.method === 'POST' && res.body ? { body: firstPageBody(res.body), contentType: res.contentType || 'application/json' } : {}),
              listPath: arr.path,
              fields: inferApiFields(arr.items, p, pageUrl, domLinks),
            },
          };
        }
      }
    }
  }
  if (!best) return undefined;
  const { score: _score, ...match } = best;
  return match;
}

/** 按接口规则从 JSON 里提取条目 */
export function extractApiItems(json: unknown, api: Pick<ApiSource, 'listPath' | 'fields'>, baseUrl: string, opts: { utcOffset?: number; limit?: number; now?: Date } = {}): FeedItem[] {
  const list = getPath(json, api.listPath);
  if (!Array.isArray(list)) return [];
  const out: FeedItem[] = [];
  const seen = new Set<string>();
  for (const obj of list) {
    if (out.length >= (opts.limit ?? 100)) break;
    if (!isObj(obj)) continue;
    const rawTitle = renderTemplate(api.fields.title, obj);
    const title = rawTitle && plainText(rawTitle);
    if (!title) continue;
    const link = api.fields.link ? resolveUrl(renderTemplate(api.fields.link, obj), baseUrl) : undefined;
    const key = link || title;
    if (seen.has(key)) continue;
    seen.add(key);
    const item: FeedItem = { title: title.slice(0, 500) };
    if (link) item.link = link;
    const dateText = api.fields.date && renderTemplate(api.fields.date, obj);
    if (dateText) {
      item.dateText = dateText;
      const d = parseDate(dateText, { utcOffset: opts.utcOffset, now: opts.now });
      if (d) item.date = d.toISOString();
    }
    const image = api.fields.image && resolveUrl(renderTemplate(api.fields.image, obj), baseUrl);
    if (image) item.image = image;
    const summary = api.fields.summary && renderTemplate(api.fields.summary, obj);
    if (summary && plainText(summary) !== title) item.summary = plainText(summary).slice(0, 2000);
    const author = api.fields.author && renderTemplate(api.fields.author, obj);
    if (author) item.author = plainText(author).slice(0, 100);
    if (api.fields.tags) {
      // 每个 {路径} 单独渲染，缺的跳过；值里本身带逗号的也拆开
      const tags = api.fields.tags
        .split(',')
        .map((tpl) => renderTemplate(tpl.trim(), obj))
        .flatMap((v) => (v ? v.split(/[,，、]/) : []))
        .map((v) => plainText(v))
        .filter((v) => v && v.length <= 30);
      if (tags.length) item.tags = [...new Set(tags)].slice(0, 8);
    }
    out.push(item);
  }
  return out;
}
