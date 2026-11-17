/**
 * 选取面板这一侧的网络记录：
 * - 接收 sniff-hook 发来的 JSON 响应；
 * - 面板打开之前网页已经发过的 GET 请求，从 Performance 资源记录里找出来，重新请求一次。
 */
import { parseJsonLoose, type CapturedResponse } from '@rssflow/core';
import type { SniffEntry } from './sniff-hook.ts';

/** 统计、埋点、监控之类的请求，不可能是内容接口 */
const IGNORE_HOST_RE = /google-analytics|googletagmanager|doubleclick|googlesyndication|sentry|hm\.baidu|cnzz|umeng|growingio|sensorsdata|mixpanel|segment\.io|hotjar|clarity\.ms|meitustat|facebook\.com\/tr|bat\.bing/i;
const IGNORE_PATH_RE = /(^|[/._-])(stat|stats|track|tracking|beacon|collect|report|log|logs|analytics|metrics|telemetry|envelope|ping|heartbeat|ab_allot\w*)([/._?-]|$)|\.(js|mjs|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|map)(\?|$)/i;

export function ignoredUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return IGNORE_HOST_RE.test(u.hostname + u.pathname) || IGNORE_PATH_RE.test(u.pathname);
  } catch {
    return true;
  }
}

export class NetLog {
  readonly responses: CapturedResponse[] = [];
  private keys = new Set<string>();
  private onNew: () => void = () => {};

  private onMessage = (ev: MessageEvent) => {
    const data = ev.data as { __rssflow?: string; entry?: SniffEntry };
    if (ev.source !== window || data?.__rssflow !== 'net' || !data.entry) return;
    this.add(data.entry);
  };

  start(onNew: () => void): void {
    this.onNew = onNew;
    window.addEventListener('message', this.onMessage);
    window.postMessage({ __rssflow: 'net-dump' }, '*');
    void this.refetchPast();
  }

  stop(): void {
    window.removeEventListener('message', this.onMessage);
  }

  private add(e: SniffEntry): void {
    const key = `${e.method} ${e.url} ${e.body ?? ''}`;
    if (this.keys.has(key) || ignoredUrl(e.url)) return;
    let json: unknown;
    try {
      json = parseJsonLoose(e.text);
    } catch {
      return;
    }
    if (!json || typeof json !== 'object') return;
    this.keys.add(key);
    this.responses.push({ url: e.url, method: e.method, body: e.body, contentType: e.contentType, json });
    if (this.responses.length > 60) this.responses.shift();
    this.onNew();
  }

  /** 面板打开前网页已经发过的 GET 请求：重新请求一次拿到内容 */
  private async refetchPast(): Promise<void> {
    const entries = (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((e) => e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest')
      .map((e) => e.name)
      .filter((u, i, all) => all.indexOf(u) === i && !ignoredUrl(u))
      .slice(-30);
    for (const url of entries) {
      if (this.keys.has(`GET ${url} `)) continue;
      try {
        const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json, text/plain, */*' } });
        const ct = res.headers.get('content-type') || '';
        if (!res.ok || /image|video|audio|font|css|html/i.test(ct)) continue;
        const text = await res.text();
        if (text.length < 3_000_000) this.add({ url, method: 'GET', text });
      } catch {
        /* 跨域不允许等情况，跳过 */
      }
    }
  }
}
