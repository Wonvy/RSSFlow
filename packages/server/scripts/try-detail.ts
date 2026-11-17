/**
 * 测试详情页（内容页）的抽取效果。
 *
 *   node packages/server/scripts/try-detail.ts <网址 或 本地 HTML 文件> [--title 标题] [--url 原网址] [--out 预览.html]
 *
 * - 传网址：用服务器同样的方式去抓（能看出会不会被反爬拦住）；
 * - 传本地文件：比如在自己浏览器里「另存为 → 网页，仅 HTML」保存下来的页面，离线测试，不用访问网站；
 *   这时用 --url 告诉脚本原网址，图片和链接才能补全成正确的地址。
 *
 * 会打印抽取结果（标题、发布时间、作者、标签、摘要、正文字数、图片列表），
 * 并生成一个预览网页（默认 detail-preview.html），用浏览器打开就能看到订阅里这一条的样子。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { extractDetail, isChallengePage, summarize } from '@rssflow/core';
import { fetchStatic } from '../src/fetcher.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const title = flag('--title');
const pageUrlFlag = flag('--url');
const out = path.resolve(flag('--out') || 'detail-preview.html');
const target = args[0];
if (!target) {
  console.error('用法：node packages/server/scripts/try-detail.ts <网址或本地HTML文件> [--title 标题] [--url 原网址] [--out 预览.html]');
  process.exit(1);
}

let html: string;
let pageUrl: string;
if (/^https?:\/\//.test(target)) {
  const page = await fetchStatic(target);
  html = page.html;
  pageUrl = page.finalUrl;
} else {
  html = readFileSync(target, 'utf8');
  // 浏览器另存的网页里常带着原网址（canonical / og:url）
  pageUrl =
    pageUrlFlag ||
    html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)/i)?.[1] ||
    'https://example.com/';
}

if (isChallengePage(html)) {
  console.log('✕ 这是反爬挑战 / 验证页，拿不到内容（RSSFlow 会跳过这类页面）。');
  process.exit(2);
}

const { document } = parseHTML(html);
const d = extractDetail(document as unknown as Document, pageUrl, { utcOffset: 480 });
const summary = summarize(d, { title });
const line = (k: string, v: unknown) => console.log(`${k.padEnd(6, '　')}${v ?? '—'}`);

console.log(`\n来源：${pageUrl}\n`);
line('标题', d.title);
line('发布时间', d.published && new Date(d.published).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
line('作者', d.author);
line('标签', d.tags?.join(' / '));
line('摘要', summary);
line('正文字数', d.text?.length ?? 0);
line('图片数', d.images?.length ?? 0);
for (const [i, u] of (d.images ?? []).slice(0, 10).entries()) console.log(`  ${i + 1}. ${u}`);
if ((d.images?.length ?? 0) > 10) console.log(`  …还有 ${d.images!.length - 10} 张`);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
writeFileSync(
  out,
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">
<title>详情页预览 · ${esc(d.title || '')}</title>
<style>body{font:15px/1.7 system-ui,"PingFang SC",sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222}img{max-width:100%;height:auto;display:block;margin:12px 0;border-radius:6px}.meta{color:#777;font-size:13px}.sum{background:#fff4e6;padding:12px 14px;border-radius:8px}</style></head>
<body><p class="meta">RSSFlow 详情页预览 · <a href="${esc(pageUrl)}">原网页</a></p>
<h1>${esc(d.title || '')}</h1>
<p class="meta">${esc([d.author, d.published && new Date(d.published).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }), d.tags?.join(' / ')].filter(Boolean).join(' · '))}</p>
${summary ? `<p class="sum">${esc(summary)}</p>` : ''}
${d.contentHtml || '<p class="meta">没有找到正文</p>'}
</body></html>`,
);
console.log(`\n预览网页：${out}`);
