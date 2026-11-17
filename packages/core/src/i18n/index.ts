/**
 * 多语言支持。
 *
 * 新增一种语言（例如日语）：
 *   1. 复制 en.ts 为 ja.ts，翻译其中的文案（可以只翻一部分，缺的会回退到英文）；
 *   2. 在下面的 LOCALES 里加一行 `ja: { name: '日本語', messages: ja }`。
 * 扩展、服务端页面、错误提示都会自动支持。
 */
import zhCN from './zh-CN.ts';
import en from './en.ts';
import type { MessageKey, MessageParams, Messages } from './types.ts';

export type { MessageKey, MessageParams, Messages };

export interface LocaleInfo {
  /** 用该语言书写的语言名称，用于语言切换菜单 */
  name: string;
  messages: Partial<Messages>;
}

export const LOCALES = {
  'zh-CN': { name: '简体中文', messages: zhCN },
  en: { name: 'English', messages: en },
} satisfies Record<string, LocaleInfo>;

export type Locale = keyof typeof LOCALES;
export const DEFAULT_LOCALE: Locale = 'en';
export const LOCALE_CODES = Object.keys(LOCALES) as Locale[];

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && v in LOCALES;
}

/** 解析 Accept-Language 头，按优先级返回语言标签 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part) => {
      const [tag, ...rest] = part.trim().split(';');
      const q = rest.find((r) => r.trim().startsWith('q='));
      return { tag: tag.trim(), q: q ? Number(q.trim().slice(2)) || 0 : 1 };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q)
    .map((x) => x.tag);
}

/** 从一组语言偏好里挑出支持的语言：先精确匹配，再按主语言匹配（zh-TW → zh-CN） */
export function resolveLocale(prefs: string | readonly (string | null | undefined)[] | null | undefined): Locale {
  const list = (Array.isArray(prefs) ? prefs : [prefs]).filter((x): x is string => !!x);
  const lower = LOCALE_CODES.map((c) => c.toLowerCase());
  for (const p of list) {
    const exact = lower.indexOf(p.toLowerCase().replace('_', '-'));
    if (exact >= 0) return LOCALE_CODES[exact];
    const base = p.toLowerCase().split(/[-_]/)[0];
    const i = lower.findIndex((c) => c.split('-')[0] === base);
    if (i >= 0) return LOCALE_CODES[i];
  }
  return DEFAULT_LOCALE;
}

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const msg: string = (LOCALES[locale]?.messages as Partial<Messages>)[key] ?? en[key] ?? key;
  if (!params) return msg;
  return msg.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

export type Translator = (key: MessageKey, params?: MessageParams) => string;

export function createTranslator(locale: Locale): Translator {
  return (key, params) => translate(locale, key, params);
}

/** 带翻译 key 的错误：抛出时不关心语言，展示时再按用户语言翻译 */
export class I18nError extends Error {
  readonly key: MessageKey;
  readonly params?: MessageParams;
  readonly status: number;
  constructor(key: MessageKey, params?: MessageParams, status = 400) {
    super(translate(DEFAULT_LOCALE, key, params));
    this.name = 'I18nError';
    this.key = key;
    this.params = params;
    this.status = status;
  }
  localize(locale: Locale): string {
    return translate(locale, this.key, this.params);
  }
}
