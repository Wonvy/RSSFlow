import { createHash } from 'node:crypto';
import type { FeedItem } from '@rssflow/core';
import type { Translator } from '@rssflow/core';
import type { StoredRecipe } from './store.ts';
import type { RunResult } from './runner.ts';

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
    // 去掉 XML 不允许的控制字符
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

const escapeHtml = escapeXml;

/** 按网址猜图片类型（一些图床会在参数里指定输出格式，如 format,webp） */
function imageType(url: string): string {
  const fmt = url.match(/format[,/=](webp|png|jpe?g|gif|avif)/i)?.[1] || url.split('?')[0].match(/\.(webp|png|jpe?g|gif|avif|svg)$/i)?.[1];
  const ext = (fmt || 'jpeg').toLowerCase().replace('jpg', 'jpeg');
  return ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
}

function guidOf(item: FeedItem): string {
  return item.link || 'urn:rssflow:' + createHash('sha1').update(item.title).digest('hex');
}

function itemHtml(item: FeedItem, aiLabel = ''): string {
  let html = '';
  // 很多图床有防盗链：带着阅读器自己的 Referer 去请求会 403，所以让阅读器不发 Referer
  if (item.image) html += `<p><img src="${escapeHtml(item.image)}" alt="" referrerpolicy="no-referrer"></p>`;
  if (item.summary) html += `<p>${item.aiSummary && aiLabel ? `<small>[${escapeHtml(aiLabel)}]</small> ` : ''}${escapeHtml(item.summary)}</p>`;
  // 作者和分类：没有摘要的条目（比如以图片为主的作品）也能看出是什么内容
  const meta = [item.author, item.tags?.join(' / ')].filter(Boolean).join(' · ');
  if (meta) html += `<p><small>${escapeHtml(meta)}</small></p>`;
  return html;
}

/** 全文：摘要之外再附上详情页正文 */
function fullHtml(item: FeedItem): string {
  return (item.image && !item.contentHtml?.includes(item.image) ? `<p><img src="${escapeHtml(item.image)}" alt="" referrerpolicy="no-referrer"></p>` : '') + (item.contentHtml ?? '');
}

/** CDATA 里不能出现 ]]>，拆开写 */
function cdata(s: string): string {
  return `<![CDATA[${s.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]>`;
}

export interface FeedContext {
  stored: StoredRecipe;
  result: RunResult;
  feedUrl: string;
  t: Translator;
}

export function toRss({ stored, result, feedUrl, t }: FeedContext): string {
  const r = stored.recipe;
  const description = r.description || t('feed.description', { url: r.url });
  const items = result.items
    .map((it) => {
      const parts = [
        `<title>${escapeXml(it.title)}</title>`,
        it.link ? `<link>${escapeXml(it.link)}</link>` : '',
        `<guid isPermaLink="${it.link ? 'true' : 'false'}">${escapeXml(guidOf(it))}</guid>`,
        it.date ? `<pubDate>${new Date(it.date).toUTCString()}</pubDate>` : '',
        itemHtml(it) ? `<description>${escapeXml(itemHtml(it, t('feed.aiLabel')))}</description>` : '',
        it.image ? `<enclosure url="${escapeXml(it.image)}" type="${imageType(it.image)}" length="0"/>` : '',
        it.author ? `<dc:creator>${escapeXml(it.author)}</dc:creator>` : '',
        ...(it.tags ?? []).map((tag) => `<category>${escapeXml(tag)}</category>`),
        it.contentHtml ? `<content:encoded>${cdata(fullHtml(it))}</content:encoded>` : '',
      ];
      return `    <item>\n      ${parts.filter(Boolean).join('\n      ')}\n    </item>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${escapeXml(r.name)}</title>
    <link>${escapeXml(r.url)}</link>
    <description>${escapeXml(description)}</description>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <generator>RSSFlow</generator>
    <lastBuildDate>${new Date(result.fetchedAt).toUTCString()}</lastBuildDate>
    <ttl>${r.refreshMinutes ?? 60}</ttl>
${items}
  </channel>
</rss>
`;
}

export function toJsonFeed({ stored, result, feedUrl, t }: FeedContext): string {
  const r = stored.recipe;
  return JSON.stringify(
    {
      version: 'https://jsonfeed.org/version/1.1',
      title: r.name,
      home_page_url: r.url,
      feed_url: feedUrl,
      description: r.description || t('feed.description', { url: r.url }),
      items: result.items.map((it) => ({
        id: guidOf(it),
        url: it.link,
        title: it.title,
        content_html: (it.contentHtml ? itemHtml(it, t('feed.aiLabel')) + fullHtml(it) : itemHtml(it, t('feed.aiLabel'))) || undefined,
        summary: it.summary,
        authors: it.author ? [{ name: it.author }] : undefined,
        tags: it.tags,
        image: it.image,
        date_published: it.date,
      })),
    },
    null,
    2,
  );
}
