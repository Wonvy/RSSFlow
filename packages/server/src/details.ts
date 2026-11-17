/**
 * 详情页抓取：打开每条内容的详情页，补充摘要、正文、作者、标签和准确的发布时间。
 *
 * 对目标网站要客气：
 * - 详情页按网址永久缓存（内容发布后很少改），失败的一天后才重试；
 * - 每次刷新最多抓 maxNew 个新详情页，同一网站同时只发 2 个请求，请求之间稍作间隔；
 * - 同一类网址（如 /work/）连续 3 次遇到反爬挑战/验证页，就在 6 小时内跳过这类网址；
 *   同一网站的其它网址（如 /article/）不受影响。RSSFlow 不会尝试破解。
 */
import { parseHTML } from 'linkedom';
import { I18nError, commonBoilerplate, extractDetail, isChallengePage, summarize, urlShape, type DetailData, type FeedItem, type Recipe } from '@rssflow/core';
import { fetchStatic } from './fetcher.ts';
import { isVerificationPage } from './runner-utils.ts';
import type { Store } from './store.ts';

const RETRY_ERROR_MS = 24 * 3600_000;
const BLOCKED_SHAPE_MS = 6 * 3600_000;
const GAP_MS = 400;

export type DetailStatus = 'ok' | 'blocked' | 'error';

export interface DetailResult {
  status: DetailStatus;
  data?: DetailData;
  error?: string;
}

/** 被反爬拦住的网址形状 → 恢复时间 */
const blockedShapes = new Map<string, number>();
const shapeOf = (u: string) => urlShape(u) || u;
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};

/** 抓一个详情页 */
export async function fetchDetail(url: string, utcOffset?: number): Promise<DetailResult> {
  try {
    const page = await fetchStatic(url);
    if (isChallengePage(page.html)) return { status: 'blocked' };
    const { document } = parseHTML(page.html);
    const text = document.body?.textContent || '';
    if (isVerificationPage(document.querySelector('title')?.textContent || '', text)) return { status: 'blocked' };
    return { status: 'ok', data: extractDetail(document as unknown as Document, page.finalUrl, { utcOffset }) };
  } catch (e) {
    return { status: 'error', error: e instanceof I18nError ? e.message : String(e) };
  }
}

export interface EnrichStats {
  ok: number;
  blocked: number;
  error: number;
  pending: number;
}

export class DetailService {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 给条目补上详情页信息（会修改传入的条目） */
  async enrich(items: FeedItem[], recipe: Recipe, maxNew = 15): Promise<EnrichStats> {
    const links = [...new Set(items.map((i) => i.link).filter((l): l is string => !!l))];
    const cached = this.store.getDetails(links);
    const now = Date.now();
    const todo = links.filter((u) => {
      const c = cached.get(u);
      if (!c) return true;
      return c.status === 'error' && now - c.fetchedAt > RETRY_ERROR_MS;
    });

    // 不同形状的网址轮流排队（作品、文章、作品、文章…），免得某一类被拦住时把名额都占光
    const shapes = new Map<string, string[]>();
    for (const u of todo) {
      const k = shapeOf(u);
      if ((blockedShapes.get(k) ?? 0) > now) continue;
      if (!shapes.has(k)) shapes.set(k, []);
      shapes.get(k)!.push(u);
    }
    const queue: string[] = [];
    while (queue.length < maxNew && [...shapes.values()].some((l) => l.length)) {
      for (const l of shapes.values()) if (l.length && queue.length < maxNew) queue.push(l.shift()!);
    }
    // 按网站分组，每个网站两个并发

    const byHost = new Map<string, string[]>();
    for (const u of queue) {
      const h = hostOf(u);
      if ((blockedShapes.get(shapeOf(u)) ?? 0) > now) continue;
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h)!.push(u);
    }
    await Promise.all(
      [...byHost].map(async ([, urls]) => {
        const blockedInRow = new Map<string, number>();
        const worker = async () => {
          while (urls.length) {
            const u = urls.shift()!;
            const shape = shapeOf(u);
            if ((blockedShapes.get(shape) ?? 0) > Date.now()) continue;
            const r = await fetchDetail(u, recipe.utcOffset);
            this.store.saveDetail(u, r.status, r.data);
            cached.set(u, { status: r.status, fetchedAt: Date.now(), data: r.data });
            const n = r.status === 'blocked' ? (blockedInRow.get(shape) ?? 0) + 1 : 0;
            blockedInRow.set(shape, n);
            if (n >= 3) blockedShapes.set(shape, Date.now() + BLOCKED_SHAPE_MS);
            await new Promise((res) => setTimeout(res, GAP_MS));
          }
        };
        await Promise.all([worker(), worker()]);
      }),
    );

    // 合并：页面上的全站套话要先找出来，摘要里去掉
    const okDetails = links.map((u) => cached.get(u)).filter((c) => c?.status === 'ok' && c.data) as { data: DetailData }[];
    const boilerplate = commonBoilerplate(okDetails.map((c) => c.data.description || ''));
    const stats: EnrichStats = { ok: 0, blocked: 0, error: 0, pending: 0 };
    for (const item of items) {
      const c = item.link ? cached.get(item.link) : undefined;
      if (!c) {
        if ((blockedShapes.get(shapeOf(item.link || '')) ?? 0) > Date.now()) stats.blocked++;
        else stats.pending++;
        continue;
      }
      stats[c.status as DetailStatus]++;
      if (c.status !== 'ok' || !c.data) continue;
      mergeDetail(item, c.data, boilerplate);
    }
    return stats;
  }
}

export function mergeDetail(item: FeedItem, d: DetailData, boilerplate?: { prefix: string; suffix: string }): void {
  const summary = summarize(d, { title: item.title, boilerplate });
  if (summary && (!item.summary || item.summary.length < summary.length / 2)) item.summary = summary;
  if (d.contentHtml && d.contentHtml.length > 40) item.contentHtml = d.contentHtml;
  if (!item.date && d.published) item.date = d.published;
  if (!item.image && d.image) item.image = d.image;
  if (!item.author && d.author) item.author = d.author;
  if (!item.tags?.length && d.tags?.length) item.tags = d.tags;
}
