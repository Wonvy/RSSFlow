import type { ApiSource, FieldRule, Recipe } from './types.ts';
import { I18nError } from './i18n/index.ts';

const FIELD_NAMES = ['title', 'link', 'date', 'image', 'summary', 'author'] as const;

function str(v: unknown, name: string, max: number, required = true): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new I18nError('err.missing', { name });
    return undefined;
  }
  if (typeof v !== 'string') throw new I18nError('err.notString', { name });
  if (v.length > max) throw new I18nError('err.tooLong', { name });
  return v;
}

function rule(v: unknown, name: string): FieldRule {
  if (!v || typeof v !== 'object') throw new I18nError('err.badField', { name });
  const r = v as Record<string, unknown>;
  const selector = typeof r.selector === 'string' ? r.selector : '';
  if (selector.length > 500) throw new I18nError('err.tooLong', { name: `${name}.selector` });
  const attr = str(r.attr, `${name}.attr`, 50, false);
  if (attr && !/^[a-zA-Z_:][\w:.-]*$/.test(attr)) throw new I18nError('err.badAttr', { name });
  if (r.from === 'data') {
    const prefixes = r.prefixes;
    if (!Array.isArray(prefixes) || !prefixes.length || prefixes.length > 8) throw new I18nError('err.badField', { name });
    for (const p of prefixes) {
      if (typeof p !== 'string' || p.length > 500 || !/^https?:\/\/\S+$/.test(p)) throw new I18nError('err.badField', { name });
    }
    return { selector: '', from: 'data', prefixes: prefixes as string[] };
  }
  return attr ? { selector, attr } : { selector };
}

const API_FIELDS = ['title', 'link', 'date', 'image', 'summary', 'author', 'tags'] as const;

function apiSource(v: unknown): ApiSource | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') throw new I18nError('err.badField', { name: 'api' });
  const o = v as Record<string, unknown>;
  const url = str(o.url, 'api.url', 2000)!;
  if (!/^https?:\/\//.test(url)) throw new I18nError('err.protocol');
  const method = o.method === 'POST' ? 'POST' : 'GET';
  const body = method === 'POST' ? str(o.body, 'api.body', 20_000, false) : undefined;
  const contentType = method === 'POST' ? str(o.contentType, 'api.contentType', 100, false) : undefined;
  if (contentType && !/^(application\/(json|x-www-form-urlencoded)|text\/plain)\b/i.test(contentType)) throw new I18nError('err.badField', { name: 'api.contentType' });
  const listPath = typeof o.listPath === 'string' ? o.listPath : '';
  if (listPath.length > 200 || !/^[\w$.-]*$/.test(listPath)) throw new I18nError('err.badField', { name: 'api.listPath' });
  const f = (o.fields || {}) as Record<string, unknown>;
  const fields = {} as ApiSource['fields'];
  for (const k of API_FIELDS) {
    const tpl = str(f[k], `api.fields.${k}`, 500, k === 'title');
    if (tpl !== undefined) {
      if (!/\{[\w$.-]+\}/.test(tpl)) throw new I18nError('err.badField', { name: `api.fields.${k}` });
      fields[k] = tpl;
    }
  }
  return { url, method, ...(body ? { body } : {}), ...(contentType ? { contentType } : {}), listPath, fields };
}

/** 校验并规范化外部传入的规则 */
export function validateRecipe(input: unknown): Recipe {
  if (!input || typeof input !== 'object') throw new I18nError('err.badRecipe');
  const o = input as Record<string, unknown>;
  const url = str(o.url, 'url', 2000)!;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new I18nError('err.badUrl');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new I18nError('err.protocol');
  const api = apiSource(o.api);
  const mode = o.mode === 'static' || o.mode === 'render' || (o.mode === 'api' && api) ? o.mode : 'auto';
  const f = (o.fields || {}) as Record<string, unknown>;
  if (!f.title) throw new I18nError('err.missingTitle');
  const fields = { title: rule(f.title, 'title') } as Recipe['fields'];
  for (const k of FIELD_NAMES) if (k !== 'title' && f[k]) fields[k] = rule(f[k], k);
  const refresh = Number(o.refreshMinutes);
  const utcOffset = Number(o.utcOffset);
  return {
    version: 1,
    name: (str(o.name, 'name', 120, false) || parsed.hostname).trim(),
    description: str(o.description, 'description', 500, false),
    url: parsed.href,
    mode,
    itemSelector: str(o.itemSelector, 'itemSelector', 1000)!,
    fields,
    ...(api ? { api } : {}),
    ...(o.detail && typeof o.detail === 'object' && (o.detail as { enabled?: unknown }).enabled === true ? { detail: { enabled: true } } : {}),
    ...(o.ai && typeof o.ai === 'object' && (o.ai as { summary?: unknown }).summary === true ? { ai: { summary: true } } : {}),
    refreshMinutes: Number.isFinite(refresh) && refresh > 0 ? Math.min(Math.max(Math.round(refresh), 10), 1440) : 60,
    utcOffset: o.utcOffset !== undefined && Number.isFinite(utcOffset) && Math.abs(utcOffset) <= 14 * 60 ? Math.round(utcOffset) : undefined,
  };
}
