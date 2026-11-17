/**
 * 网络嗅探钩子：必须运行在网页自己的 JS 环境（MAIN world）里，才能看到网页发出的请求。
 * 包装 fetch 和 XMLHttpRequest，把看起来是 JSON 的响应通过 postMessage 交给选取面板。
 * 只在用户打开选取面板后安装，不会常驻在所有网页里。
 */

export interface SniffEntry {
  url: string;
  method: string;
  body?: string;
  contentType?: string;
  text: string;
}

const MAX_TEXT = 3_000_000;
const MAX_BODY = 20_000;

declare global {
  interface Window {
    __rssflowSniffer?: { log: SniffEntry[] };
  }
}

export function installSniffer(): void {
  if (window.__rssflowSniffer) return;
  const log: SniffEntry[] = [];
  window.__rssflowSniffer = { log };

  const post = (e: SniffEntry) => {
    log.push(e);
    if (log.length > 60) log.shift();
    window.postMessage({ __rssflow: 'net', entry: e }, '*');
  };
  const looksJson = (ct: string, text: string) => /json|javascript/i.test(ct) || /^\s*(\)\]\}'|[[{])/.test(text);
  const skipType = (ct: string) => /image|video|audio|font|css|html|octet-stream/i.test(ct);

  const origFetch = window.fetch;
  window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    const res = await origFetch.call(this, input, init);
    try {
      const req = input instanceof Request ? input : null;
      const url = new URL(req ? req.url : String(input), location.href).href;
      const method = (init?.method || req?.method || 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? init.body.slice(0, MAX_BODY) : undefined;
      const headers = new Headers(init?.headers || req?.headers);
      const ct = res.headers.get('content-type') || '';
      if (!skipType(ct)) {
        res
          .clone()
          .text()
          .then((text) => {
            if (text.length < MAX_TEXT && looksJson(ct, text)) post({ url, method, body, contentType: headers.get('content-type') || undefined, text });
          })
          .catch(() => {});
      }
    } catch {
      /* 嗅探失败不能影响网页本身 */
    }
    return res;
  };

  type Tagged = XMLHttpRequest & { __rf?: { method: string; url: string; contentType?: string } };
  const xo = XMLHttpRequest.prototype.open;
  const xs = XMLHttpRequest.prototype.send;
  const xh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (this: Tagged, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      this.__rf = { method: String(method).toUpperCase(), url: new URL(String(url), location.href).href };
    } catch {
      /* 忽略 */
    }
    return (xo as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.setRequestHeader = function (this: Tagged, name: string, value: string) {
    if (this.__rf && name.toLowerCase() === 'content-type') this.__rf.contentType = value;
    return xh.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (this: Tagged, body?: Document | XMLHttpRequestBodyInit | null) {
    const info = this.__rf;
    if (info) {
      const reqBody = typeof body === 'string' ? body.slice(0, MAX_BODY) : undefined;
      this.addEventListener('load', () => {
        try {
          const ct = this.getResponseHeader('content-type') || '';
          if (skipType(ct)) return;
          let text = '';
          if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
          else if (this.responseType === 'json') text = JSON.stringify(this.response);
          else return;
          if (text.length < MAX_TEXT && looksJson(ct, text)) post({ url: info.url, method: info.method, body: reqBody, contentType: info.contentType, text });
        } catch {
          /* 忽略 */
        }
      });
    }
    return xs.call(this, body);
  };

  // 面板打开晚于钩子时，把已经记下的请求再发一遍
  window.addEventListener('message', (ev) => {
    if (ev.source === window && (ev.data as { __rssflow?: string })?.__rssflow === 'net-dump') {
      for (const e of log) window.postMessage({ __rssflow: 'net', entry: e }, '*');
    }
  });
}
