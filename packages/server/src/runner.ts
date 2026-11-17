import { parseHTML } from 'linkedom';
import { I18nError, extractApiItems, extractItems, type FeedItem, type Recipe } from '@rssflow/core';
import { fetchJson, fetchRendered, fetchStatic } from './fetcher.ts';
import { isVerificationPage } from './runner-utils.ts';
import { DetailService, type EnrichStats } from './details.ts';
import type { AiService, AiStats } from './ai.ts';

export { isVerificationPage };
import { config } from './config.ts';
import type { Store, StoredRecipe } from './store.ts';

export type ResolvedMode = 'api' | 'static' | 'render';

export interface RunResult {
  items: FeedItem[];
  mode: ResolvedMode;
  fetchedAt: number;
  pageTitle?: string;
  finalUrl: string;
  /** 例如静态抓到 0 条、而动态渲染不可用时，附带的提示 */
  warning?: I18nError;
  /** 详情页抓取情况（开启了详情页时） */
  details?: EnrichStats;
  /** AI 摘要情况（开启了 AI 摘要时） */
  ai?: AiStats;
}

/** 选择器语法检查：写错的选择器在保存前就报出来 */
export function assertSelectors(recipe: Recipe): void {
  const { document } = parseHTML('<!doctype html><html><body><div></div></body></html>');
  const sels = [recipe.itemSelector, ...Object.values(recipe.fields).map((f) => f?.selector).filter(Boolean)] as string[];
  for (const s of sels) {
    try {
      document.querySelectorAll(s);
    } catch {
      throw new I18nError('err.badSelector', { selector: s });
    }
  }
}

function parsePage(html: string, finalUrl: string, recipe: Recipe) {
  const { document } = parseHTML(html);
  const baseHref = document.querySelector('base[href]')?.getAttribute('href');
  let baseUrl = finalUrl;
  try {
    if (baseHref) baseUrl = new URL(baseHref, finalUrl).href;
  } catch {
    /* 忽略错误的 base */
  }
  const items = extractItems(document as unknown as ParentNode, recipe, baseUrl);
  const pageTitle = document.querySelector('title')?.textContent?.trim() || undefined;
  const blocked = !items.length && isVerificationPage(pageTitle || '', document.body?.textContent || '');
  return { items, pageTitle, blocked };
}



/** 抓取顺序：有数据接口时先用接口；auto 模式下静态抓不到再用浏览器渲染 */
export function fetchOrder(recipe: Recipe, preferMode?: ResolvedMode): ResolvedMode[] {
  if (recipe.mode === 'api') return recipe.api ? ['api'] : ['static'];
  if (recipe.mode === 'static') return ['static'];
  if (recipe.mode === 'render') return ['render'];
  const pageModes: ResolvedMode[] = preferMode === 'render' ? ['render'] : ['static', 'render'];
  return recipe.api ? ['api', ...pageModes] : pageModes;
}

async function runApi(recipe: Recipe): Promise<RunResult> {
  const api = recipe.api!;
  const json = await fetchJson({ ...api, referer: recipe.url });
  const items = extractApiItems(json, api, recipe.url, { utcOffset: recipe.utcOffset });
  return { items, mode: 'api', finalUrl: api.url, fetchedAt: Date.now() };
}

/** 执行一次规则 */
export async function runRecipe(recipe: Recipe, preferMode?: ResolvedMode): Promise<RunResult> {
  const order = fetchOrder(recipe, preferMode);
  let lastError: unknown;
  let best: RunResult | undefined;
  for (const mode of order) {
    try {
      if (mode === 'api') {
        const r = await runApi(recipe);
        if (r.items.length) return r;
        lastError = new I18nError('err.apiEmpty', undefined, 502);
        best ??= r;
        continue;
      }
      const page = mode === 'static' ? await fetchStatic(recipe.url) : await fetchRendered(recipe.url, recipe.itemSelector);
      const { items, pageTitle, blocked } = parsePage(page.html, page.finalUrl, recipe);
      best = { items, mode, pageTitle, finalUrl: page.finalUrl, fetchedAt: Date.now() };
      if (items.length) return best;
      if (blocked) lastError = new I18nError('err.blocked', undefined, 502);
    } catch (e) {
      lastError = e;
      if (e instanceof I18nError && ['err.privateAddr', 'err.badUrl', 'err.protocol'].includes(e.key)) throw e;
    }
  }
  if (best) {
    if (lastError instanceof I18nError) best.warning = lastError;
    return best;
  }
  throw lastError;
}

/** 带缓存的订阅服务：同一规则在刷新间隔内只抓一次，并发请求合并为一次 */
export class FeedService {
  private cache = new Map<string, { at: number; result: RunResult }>();
  private inflight = new Map<string, Promise<RunResult>>();
  private store: Store;
  private details: DetailService;
  private ai: AiService | null;

  constructor(store: Store, ai: AiService | null = null) {
    this.store = store;
    this.details = new DetailService(store);
    this.ai = ai;
  }

  private ttl(recipe: Recipe): number {
    return Math.max(recipe.refreshMinutes ?? 60, config.minRefreshMinutes) * 60_000;
  }

  peek(id: string): RunResult | undefined {
    return this.cache.get(id)?.result;
  }

  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /**
   * 页面上没有时间的条目，用「首次发现时间」作为发布时间。
   * 这样 RSS 阅读器能正确排序、标出新内容，而且时间不会每次刷新都变。
   */
  private stampFirstSeen(id: string, result: RunResult): void {
    const undated = result.items.filter((it) => !it.date);
    if (!undated.length) return;
    const seen = this.store.firstSeen(id, undated.map((it) => it.link || it.title));
    for (const it of undated) {
      const t = seen.get(it.link || it.title);
      if (t) it.date = new Date(t).toISOString();
    }
  }

  /**
   * @param maxNewDetails 这次最多抓多少个新详情页。创建订阅时用较小的值，保证很快返回，其余的在之后刷新时补上
   */
  async get(stored: StoredRecipe, force = false, maxNewDetails = 15, opts: { aiInBackground?: boolean } = {}): Promise<RunResult> {
    const hit = this.cache.get(stored.id);
    if (!force && hit && Date.now() - hit.at < this.ttl(stored.recipe)) return hit.result;
    const pending = this.inflight.get(stored.id);
    if (pending) return pending;
    const p = runRecipe(stored.recipe, stored.lastMode)
      .then(async (result) => {
        if (stored.recipe.detail?.enabled && result.items.length) {
          result.details = await this.details.enrich(result.items, stored.recipe, maxNewDetails);
          if (this.ai?.available && stored.recipe.ai?.summary) {
            // 创建订阅时 AI 摘要放到后台慢慢生成，不让用户干等；生成好的摘要直接写进缓存里的条目
            const job = this.ai.enrich(result.items, stored.recipe).then((s) => (result.ai = s));
            if (!opts.aiInBackground) await job;
            else job.catch((e) => console.error('[ai]', e));
          }
        }
        return result;
      })
      .then((result) => {
        // 这次一条都没抓到（比如被验证页拦住），但之前有数据：继续用旧数据，等下次刷新
        if (!result.items.length && hit?.result.items.length) {
          this.store.recordRun(stored.id, { count: 0, error: result.warning?.message });
          return hit.result;
        }
        this.stampFirstSeen(stored.id, result);
        this.cache.set(stored.id, { at: Date.now(), result });
        this.store.recordRun(stored.id, { mode: result.mode, count: result.items.length, error: result.items.length ? undefined : result.warning?.message });
        return result;
      })
      .catch((e) => {
        this.store.recordRun(stored.id, { count: 0, error: e instanceof Error ? e.message : String(e) });
        // 出错时如果有旧数据，继续用旧数据
        if (hit) return hit.result;
        throw e;
      })
      .finally(() => this.inflight.delete(stored.id));
    this.inflight.set(stored.id, p);
    return p;
  }
}
