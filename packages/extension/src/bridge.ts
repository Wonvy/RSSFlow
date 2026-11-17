/**
 * 扩展各部分（选取面板、弹窗、后台）共用的设置与服务器通信。
 * 在没有 chrome.* API 的环境（开发用的示例页面）里，自动退化为直接 fetch。
 */
import { isLocale, resolveLocale, type Locale } from '@rssflow/core';

export const DEFAULT_SERVER = 'http://localhost:8787';

export interface Settings {
  serverUrl: string;
  /** 'auto' 表示跟随浏览器语言 */
  locale: 'auto' | Locale;
}

export interface MyFeed {
  id: string;
  name: string;
  feedUrl: string;
  pageUrl: string;
  editToken: string;
  sourceUrl: string;
  createdAt: number;
}

export const hasExtensionApi = (): boolean => typeof chrome !== 'undefined' && !!chrome.runtime?.id;

declare global {
  interface Window {
    __RSSFLOW_SERVER__?: string;
  }
}

export async function loadSettings(): Promise<Settings> {
  if (hasExtensionApi()) {
    const s = await chrome.storage.sync.get(['serverUrl', 'locale']);
    return {
      serverUrl: typeof s.serverUrl === 'string' && s.serverUrl ? s.serverUrl : DEFAULT_SERVER,
      locale: isLocale(s.locale) ? s.locale : 'auto',
    };
  }
  return { serverUrl: (typeof window !== 'undefined' && window.__RSSFLOW_SERVER__) || location.origin, locale: 'auto' };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  if (hasExtensionApi()) await chrome.storage.sync.set(patch);
}

export function effectiveLocale(s: Settings): Locale {
  if (s.locale !== 'auto') return s.locale;
  return resolveLocale(typeof navigator !== 'undefined' ? navigator.languages : []);
}

export class NetworkError extends Error {}

/** 真正发请求的地方（在后台 service worker 或开发页面里执行） */
export async function callServer(serverUrl: string, method: string, path: string, body: unknown, locale: Locale): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(serverUrl.replace(/\/+$/, '') + path, {
      method,
      headers: { 'content-type': 'application/json', 'accept-language': locale },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new NetworkError((e as Error).message);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export interface ApiMessage {
  type: 'api';
  method: string;
  path: string;
  body?: unknown;
  locale: Locale;
}

export type ApiReply = { ok: true; data: unknown } | { ok: false; error: string; network?: boolean };

/** 给选取面板和弹窗用：通过后台转发请求（绕开网页的 CORS / 混合内容限制） */
export async function api<T>(method: string, path: string, body: unknown, locale: Locale): Promise<T> {
  if (hasExtensionApi()) {
    const msg: ApiMessage = { type: 'api', method, path, body, locale };
    const reply = (await chrome.runtime.sendMessage(msg)) as ApiReply;
    if (!reply.ok) throw reply.network ? new NetworkError(reply.error) : new Error(reply.error);
    return reply.data as T;
  }
  const s = await loadSettings();
  return (await callServer(s.serverUrl, method, path, body, locale)) as T;
}

export async function loadMine(): Promise<MyFeed[]> {
  if (!hasExtensionApi()) return [];
  const { mine } = await chrome.storage.local.get('mine');
  return Array.isArray(mine) ? (mine as MyFeed[]) : [];
}

export async function saveMine(entry: MyFeed): Promise<void> {
  if (!hasExtensionApi()) return;
  const list = (await loadMine()).filter((m) => m.id !== entry.id);
  list.unshift(entry);
  await chrome.storage.local.set({ mine: list.slice(0, 200) });
}
