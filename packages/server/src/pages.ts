import { LOCALES, LOCALE_CODES, type Locale, type Translator } from '@rssflow/core';
import { escapeXml as esc } from './feed.ts';
import type { StoredRecipe } from './store.ts';
import type { RunResult } from './runner.ts';

const CSS = `
:root{--bg:#f7f7f5;--surface:#fff;--text:#1d1d1f;--muted:#6b6b70;--border:#e4e4e0;--accent:#e8590c;--accent-text:#fff;--accent-soft:#fff1e8;--danger:#c92a2a;--radius:12px}
@media (prefers-color-scheme:dark){:root{--bg:#141415;--surface:#1e1e20;--text:#ececed;--muted:#9d9da3;--border:#2e2e32;--accent:#ff8a3d;--accent-text:#141415;--accent-soft:#3a2416;--danger:#ff6b6b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
a{color:inherit}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}
header.top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:20px 0}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:18px;text-decoration:none}
.brand svg{width:24px;height:24px;color:var(--accent)}
.lang{display:flex;gap:4px}
.lang a{font-size:13px;padding:4px 10px;border-radius:999px;text-decoration:none;color:var(--muted);border:1px solid transparent}
.lang a[aria-current]{border-color:var(--border);color:var(--text);background:var(--surface)}
h1{font-size:28px;line-height:1.25;margin:16px 0 4px}
.tagline{color:var(--muted);margin:0 0 24px}
.search{width:100%;padding:12px 14px;border-radius:var(--radius);border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;padding-bottom:48px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:6px;min-width:0}
.card h2{font-size:16px;margin:0;overflow-wrap:anywhere}
.card h2 a{text-decoration:none}
.meta{color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto;padding-top:8px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;font-size:13px;cursor:pointer;text-decoration:none}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-text);font-weight:600}
.empty{color:var(--muted);text-align:center;padding:48px 16px;border:1px dashed var(--border);border-radius:var(--radius)}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:16px}
.panel h3{margin:0 0 10px;font-size:15px}
.copyline{display:flex;gap:8px}
.copyline input{flex:1;min-width:0;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:13px ui-monospace,monospace}
.items{list-style:none;margin:0;padding:0}
.items li{display:flex;gap:12px;padding:10px 0;border-top:1px solid var(--border)}
.items li:first-child{border-top:0}
.items img{width:72px;height:54px;object-fit:cover;border-radius:6px;flex:none;background:var(--bg)}
.items .t{font-weight:600;text-decoration:none;overflow-wrap:anywhere}
.items .s{color:var(--muted);font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.err{color:var(--danger)}
pre{background:var(--bg);border-radius:8px;padding:12px;overflow:auto;font-size:12px;margin:0}
.foot{color:var(--muted);font-size:12.5px;padding:8px 0 32px;text-align:center}
.badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--accent-soft);color:var(--accent)}
`;

const LOGO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="6" cy="18" r="1.6" fill="currentColor" stroke="none"/></svg>`;

const COPY_JS = `document.addEventListener('click',e=>{const b=e.target.closest('[data-copy]');if(!b)return;navigator.clipboard.writeText(b.dataset.copy).then(()=>{const o=b.textContent;b.textContent=b.dataset.done;setTimeout(()=>b.textContent=o,1500)})});`;

/** 页面底部：版本号，有新版本时提示怎么更新 */
export interface PageFooter {
  version: string;
  latest?: string;
  releaseUrl?: string;
}

let footerInfo: PageFooter | null = null;
export function setFooter(f: PageFooter): void {
  footerInfo = f;
}

function footer(t: Translator): string {
  if (!footerInfo) return '';
  const upd = footerInfo.latest
    ? ` · <a href="${esc(footerInfo.releaseUrl || '#')}" target="_blank" rel="noopener noreferrer">${esc(t('gallery.updateAvailable', { latest: footerInfo.latest }))}</a>`
    : '';
  return `<footer class="foot">${esc(t('gallery.version', { version: footerInfo.version }))}${upd}</footer>`;
}

function layout(locale: Locale, t: Translator, title: string, body: string, path: string): string {
  const langLinks = LOCALE_CODES.map(
    (code) => `<a href="${esc(path)}${path.includes('?') ? '&' : '?'}lang=${code}" hreflang="${code}"${code === locale ? ' aria-current="true"' : ''}>${esc(LOCALES[code].name)}</a>`,
  ).join('');
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<header class="top"><a class="brand" href="/">${LOGO}${esc(t('app.name'))}</a><nav class="lang" aria-label="${esc(t('common.language'))}">${langLinks}</nav></header>
${body}
${footer(t)}
</div>
<script>${COPY_JS}</script>
</body>
</html>`;
}

function fmtTime(ts: number | undefined, locale: Locale): string {
  if (!ts) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function galleryPage(opts: { locale: Locale; t: Translator; recipes: StoredRecipe[]; q: string; base: string }): string {
  const { locale, t, recipes, q, base } = opts;
  const cards = recipes
    .map((s) => {
      const feed = `${base}/feed/${s.id}.xml`;
      return `<article class="card">
  <h2><a href="/r/${s.id}">${esc(s.recipe.name)}</a></h2>
  <div class="meta">${esc(hostOf(s.recipe.url))}${s.lastCount !== undefined ? ' · ' + esc(t('gallery.items', { count: s.lastCount })) : ''}</div>
  <div class="meta">${esc(t('gallery.updated', { time: fmtTime(s.updatedAt, locale) }))}</div>
  <div class="row"><button class="btn primary" data-copy="${esc(feed)}" data-done="${esc(t('common.copied'))}">${esc(t('gallery.copy'))}</button><a class="btn" href="/r/${s.id}">${esc(t('gallery.view'))}</a></div>
</article>`;
    })
    .join('\n');
  const body = `<h1>${esc(t('gallery.title'))}</h1>
<p class="tagline">${esc(t('gallery.tagline'))}</p>
<form method="get" action="/"><input class="search" type="search" name="q" value="${esc(q)}" placeholder="${esc(t('gallery.search'))}" aria-label="${esc(t('gallery.search'))}"></form>
${recipes.length ? `<div class="grid">${cards}</div>` : `<div class="empty">${esc(q ? t('gallery.noResult') : t('gallery.empty'))}</div>`}`;
  return layout(locale, t, `${t('gallery.title')} · ${t('app.name')}`, body, q ? `/?q=${encodeURIComponent(q)}` : '/');
}

export function detailPage(opts: { locale: Locale; t: Translator; stored: StoredRecipe; result?: RunResult; error?: string; base: string }): string {
  const { locale, t, stored, result, error, base } = opts;
  const r = stored.recipe;
  const rss = `${base}/feed/${stored.id}.xml`;
  const json = `${base}/feed/${stored.id}.json`;
  const items = result?.items ?? [];
  const list = items.length
    ? `<ul class="items">${items
        .slice(0, 20)
        .map(
          (it) => `<li>${it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<div>
  ${it.link ? `<a class="t" href="${esc(it.link)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>` : `<span class="t">${esc(it.title)}</span>`}
  ${it.date || it.dateText || it.author || it.tags?.length ? `<div class="meta">${esc([it.author, it.date ? fmtTime(Date.parse(it.date), locale) : it.dateText, it.tags?.join(' / ')].filter(Boolean).join(' · '))}</div>` : ''}
  ${it.summary ? `<div class="s">${esc(it.summary)}</div>` : ''}
</div></li>`,
        )
        .join('')}</ul>`
    : `<p class="meta">${esc(t('detail.noItems'))}</p>`;
  const copyLine = (label: string, url: string) => `<div class="panel"><h3>${esc(label)}</h3><div class="copyline"><input readonly value="${esc(url)}" aria-label="${esc(label)}"><button class="btn primary" data-copy="${esc(url)}" data-done="${esc(t('common.copied'))}">${esc(t('common.copy'))}</button></div></div>`;
  const modeBadge = result ? ` <span class="badge">${esc(t(`mode.short.${result.mode}` as const))}</span>` : '';
  const recipeJson = JSON.stringify(r, null, 2);
  const body = `<p><a class="meta" href="/">← ${esc(t('detail.back'))}</a></p>
<h1>${esc(r.name)}${modeBadge}</h1>
<p class="tagline">${esc(t('detail.source'))}: <a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a></p>
${copyLine(t('detail.feedUrl'), rss)}
${copyLine(t('detail.jsonFeed'), json)}
<div class="panel"><h3>${esc(t('detail.latest'))}</h3>${error ? `<p class="err">${esc(t('detail.error', { error }))}</p>` : ''}${list}</div>
<div class="panel"><h3>${esc(t('detail.recipe'))}</h3><pre>${esc(recipeJson)}</pre><div class="row"><a class="btn" href="/api/recipes/${stored.id}?download=1">${esc(t('detail.download'))}</a></div></div>`;
  return layout(locale, t, `${r.name} · ${t('app.name')}`, body, `/r/${stored.id}`);
}
