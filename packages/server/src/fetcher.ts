import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { I18nError, parseJsonLoose } from '@rssflow/core';
import { config } from './config.ts';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 RSSFlow/0.1';

export interface FetchedPage {
  html: string;
  finalUrl: string;
}

// ---------- 防 SSRF：不允许公共实例去抓内网 ----------

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new I18nError('err.badUrl');
  }
  if (!/^https?:$/.test(url.protocol)) throw new I18nError('err.protocol');
  if (config.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new I18nError('err.privateAddr');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new I18nError('err.privateAddr');
  return url;
}

// ---------- 编码识别（很多中文网站还是 GBK） ----------

function sniffCharset(buf: Uint8Array, contentType: string | null): string {
  const fromHeader = contentType?.match(/charset=["']?([\w-]+)/i)?.[1];
  if (fromHeader) return fromHeader;
  const head = Buffer.from(buf.subarray(0, 4096)).toString('latin1');
  return head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] || 'utf-8';
}

export function decodeHtml(buf: Uint8Array, contentType: string | null): string {
  const charset = sniffCharset(buf, contentType).toLowerCase();
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function readLimited(res: Response, max: number): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) throw new I18nError('err.tooLarge', { size: Math.round(max / 1048576) }, 502);
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > max) throw new I18nError('err.tooLarge', { size: Math.round(max / 1048576) }, 502);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---------- 静态抓取 ----------

export async function fetchStatic(url: string, acceptLanguage = 'zh-CN,zh;q=0.9,en;q=0.8'): Promise<FetchedPage> {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current);
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': acceptLanguage,
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new I18nError('err.fetchFailed', { reason: (e as Error).cause ? String((e as Error).cause) : (e as Error).message }, 502);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) throw new I18nError('err.upstream', { status: res.status }, 502);
    const buf = await readLimited(res, config.maxPageBytes);
    return { html: decodeHtml(buf, res.headers.get('content-type')), finalUrl: current };
  }
  throw new I18nError('err.tooManyRedirects', undefined, 502);
}

// ---------- 数据接口（JSON） ----------

export interface ApiRequest {
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
  /** 来源网页，作为 Referer 发送（不少接口会检查） */
  referer?: string;
}

export async function fetchJson(req: ApiRequest, acceptLanguage = 'zh-CN,zh;q=0.9,en;q=0.8'): Promise<unknown> {
  let current = req.url;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(current);
    let res: Response;
    try {
      res = await fetch(current, {
        method: req.method || 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json, text/plain, */*',
          'accept-language': acceptLanguage,
          ...(req.referer ? { referer: req.referer } : {}),
          ...(req.method === 'POST' ? { 'content-type': req.contentType || 'application/json' } : {}),
        },
        body: req.method === 'POST' ? req.body : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new I18nError('err.fetchFailed', { reason: (e as Error).cause ? String((e as Error).cause) : (e as Error).message }, 502);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) throw new I18nError('err.upstream', { status: res.status }, 502);
    const text = decodeHtml(await readLimited(res, config.maxPageBytes), res.headers.get('content-type'));
    try {
      return parseJsonLoose(text);
    } catch {
      throw new I18nError('err.apiNotJson', undefined, 502);
    }
  }
  throw new I18nError('err.tooManyRedirects', undefined, 502);
}

// ---------- 浏览器渲染（动态网页） ----------

type Browser = import('playwright').Browser;
let browserPromise: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = import('playwright')
      .then((pw) => pw.chromium.launch({ headless: true }))
      .then((b) => {
        b.on('disconnected', () => (browserPromise = null));
        return b;
      })
      .catch((e) => {
        browserPromise = null;
        console.error('[render] cannot launch browser:', (e as Error).message.split('\n')[0]);
        throw new I18nError('err.renderUnavailable', undefined, 503);
      });
  }
  return browserPromise;
}

let running = 0;
const queue: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= config.renderConcurrency) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

export async function fetchRendered(url: string, waitSelector?: string, acceptLanguage = 'zh-CN,zh;q=0.9,en;q=0.8'): Promise<FetchedPage> {
  await assertPublicUrl(url);
  const browser = await getBrowser();
  return withSlot(async () => {
    const ctx = await browser.newContext({ userAgent: USER_AGENT, extraHTTPHeaders: { 'accept-language': acceptLanguage } });
    try {
      const page = await ctx.newPage();
      await page.route('**/*', async (route) => {
        const req = route.request();
        if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort();
        // 页面里发出的请求同样不允许打到内网
        if (!config.allowPrivate && req.isNavigationRequest()) {
          try {
            await assertPublicUrl(req.url());
          } catch {
            return route.abort();
          }
        }
        return route.continue();
      });
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch (e) {
        throw new I18nError('err.fetchFailed', { reason: (e as Error).message.split('\n')[0] }, 502);
      }
      if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 12_000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {});
      // 滚动一次，触发懒加载
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
      await page.waitForTimeout(400);
      return { html: await page.content(), finalUrl: page.url() };
    } finally {
      await ctx.close().catch(() => {});
    }
  });
}

export async function closeBrowser(): Promise<void> {
  const p = browserPromise;
  browserPromise = null;
  if (p) await (await p.catch(() => null))?.close();
}
