/**
 * 选取面板：注入到网页里，让用户「点一下」就把列表变成 RSS。
 * 所有界面都放在 Shadow DOM 里，不受网页样式影响，也不影响网页。
 */
import {
  bestCandidateIndex,
  collectDataText,
  urlShape,
  extractApiItems,
  matchApi,
  type ApiMatch,
  createTranslator,
  guessUtcOffset,
  detectFields,
  extractItems,
  ruleFor,
  safeQueryAll,
  type FeedItem,
  type FetchMode,
  type FieldName,
  type ListCandidate,
  type Locale,
  type RecipeFields,
  type Translator,
  findListCandidates,
} from '@rssflow/core';
import { NetworkError, api, effectiveLocale, hasExtensionApi, loadSettings, saveMine } from './bridge.ts';
import { NetLog } from './netlog.ts';
import { installSniffer } from './sniff-hook.ts';
import { PANEL_CSS } from './panel-css.ts';
import { enableDrag } from './drag.ts';
import { StylePicker } from './style-picker.ts';

type Phase = 'pick' | 'review' | 'field' | 'creating' | 'done';

interface CreateResponse {
  id: string;
  editToken: string;
  feedUrl: string;
  pageUrl: string;
  count: number;
  mode?: 'static' | 'render' | 'api';
  warning?: string;
  details?: { ok: number; blocked: number; error: number; pending: number };
  aiPending?: boolean;
}

/** 详情页试抓结果 */
interface DetailProbe {
  state: 'testing' | 'ok' | 'partial' | 'blocked' | 'error' | 'nolink';
  summary?: string;
  chars?: number;
  images?: number;
  okShapes?: string[];
  blockedShapes?: string[];
  error?: string;
}

/**
 * 详情页抓取（以及依赖它的 AI 摘要）暂时搁置：面板里不显示这个选项，也不会试抓详情页。
 * 服务端和核心代码都保留着，改成 true 就能恢复。
 */
const DETAIL_FEATURE = false;

const FIELD_ORDER: FieldName[] = ['title', 'link', 'date', 'image', 'summary', 'author'];
const MAX_BOXES = 200;

/** 网址形状的简短显示：https://x.com/work/ → /work/ */
const shortShape = (shape: string) => {
  try {
    return new URL(shape).pathname;
  } catch {
    return shape;
  }
};

const NEXT_TEXT_RE = /^(加载更多|查看更多|显示更多|更多内容|点击加载更多|下一页|下页|后一页|next|next page|load more|show more|more|›|»|>|→)$/i;

/** 找「下一页 / 加载更多」按钮：只要不会让整个页面跳走的那种 */
function findNextControl(own: Element): Element | undefined {
  const safe = (el: Element) => {
    if (own.contains(el) || (el as HTMLElement).offsetParent === null) return false;
    if (el.tagName === 'A') {
      const href = (el.getAttribute('href') || '').trim();
      return !href || href.startsWith('#') || href.startsWith('javascript:');
    }
    return !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
  };
  const clickable = Array.from(document.querySelectorAll('button, a, [role="button"], [role="link"]')).filter(safe);
  const label = (el: Element) => (el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  const byText = clickable.find((el) => NEXT_TEXT_RE.test(label(el)) || /next/i.test(el.getAttribute('aria-label') || ''));
  if (byText) return byText;
  // 分页条里的「2」
  return clickable.find((el) => label(el) === '2' && !!el.closest('nav, [class*="pag"], [class*="Pag"]'));
}

/** 页面的真实地址。开发用的「服务器视角」页面会通过 __RSSFLOW_PAGE_URL__ 告诉我们原网址 */
const pageUrl = (): string => window.__RSSFLOW_PAGE_URL__ || location.href;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

class Picker {
  private host!: HTMLElement;
  private root!: ShadowRoot;
  private panel!: HTMLElement;
  private layer!: HTMLElement;
  private hoverBox!: HTMLElement;
  private toastEl!: HTMLElement;

  private t: Translator = createTranslator('en');
  private locale: Locale = 'en';
  private phase: Phase = 'pick';
  private cands: ListCandidate[] = [];
  private idx = 0;
  private hint: Element | null = null;
  private fields: RecipeFields = { title: { selector: '' } };
  private pickingField: FieldName | null = null;
  private customSelector: string | null = null;
  private name = '';
  private isPublic = true;
  private mode: FetchMode = 'auto';
  private refresh = 60;
  private dockLeft = false;
  /** 标题栏拖动 */
  private drag: { reset(): void } | null = null;
  private error = '';
  private result: CreateResponse | null = null;
  private rafPending = false;
  private opened = false;
  /** 网络嗅探记录与匹配到的数据接口 */
  private net = new NetLog();
  private apiMatch: ApiMatch | null = null;
  private useApi = true;
  private apiTimer = 0;
  /** 暂停选取：让用户正常操作网页（翻页、加载更多） */
  private paused = false;
  /** 「帮我找数据接口」进行中 / 结果提示 */
  private findingApi = false;
  private findApiNote = '';
  /** 详情页 */
  private detailProbe: DetailProbe | null = null;
  private detailEnabled = false;
  private detailProbeKey = '';
  /** 服务器是否开启了 AI 摘要；用户是否选择使用 */
  private serverAi = false;
  private aiEnabled = true;

  /** 当前草稿规则（调试用：try-site 脚本会读取它） */
  draft() {
    return {
      version: 1,
      name: this.name.trim() || new URL(pageUrl()).hostname,
      url: pageUrl(),
      mode: this.mode,
      itemSelector: this.itemSelector,
      fields: this.fields,
      ...(this.apiActive ? { api: this.apiMatch!.api } : {}),
      ...(this.detailEnabled ? { detail: { enabled: true } } : {}),
      ...(this.detailEnabled && this.serverAi && this.aiEnabled ? { ai: { summary: true } } : {}),
      refreshMinutes: this.refresh,
      utcOffset: this.utcOffset(),
    };
  }

  private get apiActive(): boolean {
    return !!this.apiMatch && this.useApi;
  }

  /** 新的网络响应进来时（比如用户翻页、滚动加载），重新尝试匹配数据接口 */
  private onNet = () => {
    clearTimeout(this.apiTimer);
    this.apiTimer = window.setTimeout(() => {
      if (this.phase !== 'review' || this.customSelector !== null && !this.items.length) return;
      this.matchApi();
      // 用户正在输入时不重绘，免得打断输入
      if (!this.root.activeElement) this.render();
    }, 300);
  };

  private matchApi(): void {
    const dom = this.domPreview(200);
    const links = new Map(dom.filter((i) => i.link).map((i) => [i.title, i.link!] as [string, string]));
    const m = matchApi(this.net.responses, dom.map((i) => i.title), pageUrl(), links);
    // 只在找到更好的匹配时替换，避免用户翻页后被更差的结果覆盖
    if (m && (!this.apiMatch || m.hits >= this.apiMatch.hits)) this.apiMatch = m;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    const settings = await loadSettings();
    this.locale = effectiveLocale(settings);
    this.t = createTranslator(this.locale);
    this.name = document.title.trim().slice(0, 120);
    this.mount();
    this.listen();
    // 开发页面里没有扩展注入的 MAIN world 脚本，面板和网页在同一个环境，直接装钩子
    if (!hasExtensionApi()) installSniffer();
    this.net.start(this.onNet);
    this.render();
    // 问一下服务器有没有开 AI 摘要（失败不影响其它功能）
    api<{ ai?: boolean }>('GET', '/api/health', undefined, this.locale)
      .then((h) => {
        this.serverAi = !!h.ai;
        if (this.phase === 'review') this.render();
      })
      .catch(() => {});
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.unlisten();
    this.net.stop();
    this.host.remove();
    this.reset();
  }

  private reset(): void {
    this.phase = 'pick';
    this.cands = [];
    this.idx = 0;
    this.hint = null;
    this.customSelector = null;
    this.pickingField = null;
    this.error = '';
    this.result = null;
    this.dataCache = null;
    this.apiMatch = null;
    this.useApi = true;
    this.paused = false;
    this.findingApi = false;
    this.findApiNote = '';
    this.detailProbe = null;
    this.detailEnabled = false;
    this.detailProbeKey = '';
  }

  // ---------- 挂载 ----------

  private mount(): void {
    this.host = document.createElement('rssflow-picker');
    this.host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${PANEL_CSS}</style><div class="layer"></div><div class="hover"></div><section class="panel" role="dialog" aria-label="RSSFlow"></section><div class="toast" role="status"></div>`;
    this.layer = this.root.querySelector('.layer')!;
    this.hoverBox = this.root.querySelector('.hover')!;
    this.panel = this.root.querySelector('.panel')!;
    this.toastEl = this.root.querySelector('.toast')!;
    this.panel.lang = this.locale;
    this.drag = enableDrag(this.panel);
    this.panel.addEventListener('click', (e) => this.onPanelClick(e));
    this.panel.addEventListener('input', (e) => this.onPanelInput(e));
    this.panel.addEventListener('change', (e) => this.onPanelInput(e));
    document.documentElement.appendChild(this.host);
  }

  // ---------- 页面事件 ----------

  private isOwn(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }

  private get intercepting(): boolean {
    return !this.paused && (this.phase === 'pick' || this.phase === 'field' || this.phase === 'review');
  }

  private onMove = (e: MouseEvent) => {
    if (this.paused || this.isOwn(e) || (this.phase !== 'pick' && this.phase !== 'field')) return this.hideHover();
    const el = e.target as Element;
    if (this.phase === 'field' && !this.itemOf(el)) return this.hideHover();
    this.showBox(this.hoverBox, el.getBoundingClientRect());
  };

  private block = (e: Event) => {
    if (!this.isOwn(e) && this.intercepting) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  private onClick = (e: MouseEvent) => {
    if (this.isOwn(e) || !this.intercepting) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = e.target as Element;
    if (this.phase === 'pick') this.pickList(el);
    else if (this.phase === 'field') this.pickFieldAt(el);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (this.phase === 'field') {
      this.phase = 'review';
      this.pickingField = null;
      this.render();
    } else this.close();
  };

  private onViewport = () => {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.drawItems();
    });
  };

  private listen(): void {
    window.addEventListener('mousemove', this.onMove, true);
    window.addEventListener('click', this.onClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'submit']) window.addEventListener(t, this.block, true);
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('scroll', this.onViewport, true);
    window.addEventListener('resize', this.onViewport);
  }

  private unlisten(): void {
    window.removeEventListener('mousemove', this.onMove, true);
    window.removeEventListener('click', this.onClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'auxclick', 'dblclick', 'submit']) window.removeEventListener(t, this.block, true);
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('scroll', this.onViewport, true);
    window.removeEventListener('resize', this.onViewport);
  }

  // ---------- 列表与字段 ----------

  private get current(): ListCandidate | undefined {
    return this.cands[this.idx];
  }

  private get itemSelector(): string {
    return this.customSelector ?? this.current?.itemSelector ?? '';
  }

  private get items(): Element[] {
    if (this.customSelector !== null) return safeQueryAll(document, this.customSelector);
    // 每次按选择器重新查询：用户点了「加载更多」后，新出现的条目也算进来
    const c = this.current;
    if (!c) return [];
    const fresh = safeQueryAll(document, c.itemSelector);
    return fresh.length >= c.items.length ? fresh : c.items;
  }

  private itemOf(el: Element): Element | undefined {
    return this.items.find((i) => i.contains(el));
  }

  private pickList(el: Element): void {
    const cands = findListCandidates(el, document);
    if (!cands.length) return this.toast(this.t('pick.noList'));
    this.cands = cands;
    this.idx = bestCandidateIndex(cands);
    this.hint = el;
    this.customSelector = null;
    this.redetect();
    this.phase = 'review';
    this.hideHover();
    this.render();
    void this.probeDetails();
  }

  private redetect(): void {
    const items = this.items;
    if (items.length) this.fields = detectFields(items, this.hint, { dataText: this.dataText() });
    this.apiMatch = null;
    this.matchApi();
  }

  private pickFieldAt(el: Element): void {
    const field = this.pickingField;
    const item = this.itemOf(el);
    if (!field || !item) return;
    let target: Element | null = el;
    if (field === 'link') {
      const a = el.closest('a[href]');
      target = a && item.contains(a) ? a : el.querySelector('a[href]');
    } else if (field === 'image') {
      target = el.tagName === 'IMG' ? el : el.querySelector('img') ?? el;
    }
    if (!target) return this.toast(this.t('pick.noList'));
    this.fields = { ...this.fields, [field]: ruleFor(item, target, field) };
    this.pickingField = null;
    this.phase = 'review';
    this.hideHover();
    this.render();
  }

  private dataCache: string | null = null;
  /** 页面内嵌数据（只收集一次） */
  private dataText(): string {
    if (this.dataCache === null) this.dataCache = collectDataText(document);
    return this.dataCache;
  }

  /** 网站所在时区：按网址和页面语言推断，推断不出时用本机时区 */
  private utcOffset(): number {
    return guessUtcOffset(pageUrl(), document.documentElement.lang) ?? -new Date().getTimezoneOffset();
  }

  /** 预览：用数据接口时显示接口里的内容，否则显示从网页解析的内容 */
  private preview(limit = 5): FeedItem[] {
    if (this.apiActive) {
      const m = this.apiMatch!;
      return extractApiItems(m.response.json, m.api, pageUrl(), { utcOffset: this.utcOffset(), limit });
    }
    return this.domPreview(limit);
  }

  private domPreview(limit = 5): FeedItem[] {
    if (!this.itemSelector) return [];
    return extractItems(document, { itemSelector: this.itemSelector, fields: this.fields, utcOffset: this.utcOffset() }, pageUrl(), { limit, dataText: this.dataText() });
  }

  private sampleOf(field: FieldName, first: FeedItem | undefined): string {
    if (!first) return '';
    if (field === 'date') return first.date ? new Date(first.date).toLocaleString(this.locale) : first.dateText ?? '';
    return (first[field] as string | undefined) ?? '';
  }

  // ---------- 绘制高亮 ----------

  private showBox(box: HTMLElement, r: DOMRect): void {
    box.style.display = 'block';
    box.style.transform = `translate(${r.left}px, ${r.top}px)`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  }

  private hideHover(): void {
    this.hoverBox.style.display = 'none';
  }

  private drawItems(): void {
    if (!this.layer) return;
    const show = this.phase === 'review' || this.phase === 'field';
    const items = show ? this.items.slice(0, MAX_BOXES) : [];
    while (this.layer.children.length > items.length) this.layer.lastElementChild!.remove();
    while (this.layer.children.length < items.length) {
      const b = document.createElement('div');
      b.className = 'item';
      this.layer.appendChild(b);
    }
    items.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      const b = this.layer.children[i] as HTMLElement;
      const visible = r.bottom > 0 && r.top < innerHeight && r.width > 0;
      b.style.display = visible ? 'block' : 'none';
      if (visible) this.showBox(b, r);
    });
  }

  // ---------- 面板 ----------

  private render(): void {
    const t = this.t;
    this.panel.classList.toggle('left', this.dockLeft);
    const head = `<header><div class="brand" title="${esc(t('panel.dragHint'))}"><span class="grip" aria-hidden="true">⋮⋮</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="6" cy="18" r="1.8" fill="currentColor"/></svg>${esc(t('app.name'))}</div>
      <div class="head-actions">${this.phase !== 'done' ? `<button class="icon ${this.paused ? 'on' : ''}" data-act="pause" title="${esc(t(this.paused ? 'pick.resume' : 'pick.pause'))}" aria-label="${esc(t(this.paused ? 'pick.resume' : 'pick.pause'))}" aria-pressed="${this.paused}">${this.paused ? '▶' : 'Ⅱ'}</button>` : ''}<button class="icon" data-act="dock" title="${esc(t('panel.dock'))}" aria-label="${esc(t('panel.dock'))}">⇆</button><button class="icon" data-act="close" title="${esc(t('common.close'))}" aria-label="${esc(t('common.close'))}">✕</button></div></header>`;
    let body = '';
    if (this.phase === 'pick') body = this.renderPick();
    else if (this.phase === 'field') body = this.renderField();
    else if (this.phase === 'done') body = this.renderDone();
    else body = this.renderReview();
    const pausedBar = this.paused ? `<div class="paused"><span>${esc(t('pick.paused'))}</span><button class="btn sm primary" data-act="pause">▶ ${esc(t('pick.resume'))}</button></div>` : '';
    this.panel.innerHTML = head + pausedBar + `<div class="body">${body}</div>`;
    this.drawItems();
  }

  private renderPick(): string {
    const t = this.t;
    const feeds = safeQueryAll(document, 'link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]')
      .map((l) => ({ href: (l as HTMLLinkElement).href, title: l.getAttribute('title') || (l as HTMLLinkElement).href }))
      .filter((f) => f.href)
      .slice(0, 3);
    return `<div class="step"><span class="num">1</span><div><p class="big">${esc(t('pick.hint'))}</p><p class="muted">${esc(t('pick.sub'))}</p></div></div>
      ${feeds.length ? `<div class="note"><p>${esc(t('pick.hasFeed'))}</p>${feeds.map((f) => `<div class="copyline"><input readonly value="${esc(f.href)}" aria-label="RSS"><button class="btn" data-act="copy" data-value="${esc(f.href)}">${esc(t('common.copy'))}</button></div>`).join('')}</div>` : ''}`;
  }

  private renderField(): string {
    const t = this.t;
    const field = t(`field.${this.pickingField!}` as const);
    return `<div class="step"><span class="num">✎</span><div><p class="big">${esc(t('review.fieldPickHint', { field }))}</p><p class="muted">Esc</p></div></div>
      <div class="actions"><button class="btn" data-act="cancel-field">${esc(t('common.cancel'))}</button></div>`;
  }

  /** 一行「能拿到哪些内容」的小标签 */
  private renderChips(first: FeedItem | undefined): string {
    const t = this.t;
    const has: Record<FieldName, boolean> = {
      title: !!first?.title,
      link: !!first?.link,
      date: !!first?.date,
      image: !!first?.image,
      summary: !!first?.summary || this.detailEnabled,
      author: !!first?.author,
    };
    const chips = FIELD_ORDER.map((f) => `<span class="chip ${has[f] ? 'yes' : 'no'}">${has[f] ? '✓' : '○'} ${esc(t(`field.${f}` as const))}</span>`).join('');
    const source = t('review.source', { source: t(this.apiActive ? 'review.sourceApi' : 'review.sourcePage') });
    return `<div class="chips">${chips}<span class="src">${esc(source)}</span></div>`;
  }

  private renderDetailRow(): string {
    const t = this.t;
    const p = this.detailProbe;
    let status = '';
    if (!p || p.state === 'testing') status = `<span class="muted">${esc(t('review.detailTesting'))}</span>`;
    else if (p.state === 'ok') status = `<span class="ok">✓ ${esc(t('review.detailOk', { summary: p.summary || '—', chars: p.chars ?? 0, images: p.images ?? 0 }))}</span>`;
    else if (p.state === 'partial') status = `<span class="ok">✓ ${esc(t('review.detailPartial', { ok: p.okShapes!.map(shortShape).join('、'), blocked: p.blockedShapes!.map(shortShape).join('、') }))}</span>`;
    else if (p.state === 'blocked') status = `<span class="muted">${esc(t('review.detailBlocked'))}</span>`;
    else if (p.state === 'nolink') status = `<span class="muted">${esc(t('review.detailNoLink'))}</span>`;
    else status = `<span class="muted">${esc(t('review.detailError', { reason: p.error || '' }))}</span>`;
    const usable = p && (p.state === 'ok' || p.state === 'partial');
    const aiOk = this.serverAi && this.detailEnabled;
    const aiNote = !this.serverAi ? t('review.aiOff') : !this.detailEnabled ? t('review.aiNeedsDetail') : '';
    const aiRow = usable
      ? `<label class="check sub"><input type="checkbox" data-in="ai" ${aiOk && this.aiEnabled ? 'checked' : ''} ${aiOk ? '' : 'disabled'}> ✨ ${esc(t('review.ai'))}</label>${aiNote ? `<div class="status">${esc(aiNote)}</div>` : ''}`
      : '';
    return `<div class="detail"><label class="check"><input type="checkbox" data-in="detail" ${this.detailEnabled ? 'checked' : ''} ${usable ? '' : 'disabled'}> ${esc(t('review.detail'))}</label><div class="status">${status}</div>${aiRow}</div>`;
  }

  private renderReview(): string {
    const t = this.t;
    const items = this.items;
    const preview = this.preview(5);
    const first = preview[0];
    const busy = this.phase === 'creating';
    const api = this.apiActive ? this.apiMatch!.api : null;

    // 「微调」里的字段表
    const fieldRows = FIELD_ORDER.map((f) => {
      if (api) {
        const tpl = api.fields[f];
        const sample = tpl ? this.sampleOf(f, first) : '';
        return `<div class="field"><span class="fname">${esc(t(`field.${f}` as const))}</span>
          <span class="fval ${sample ? '' : 'muted'}" title="${esc(sample)}">${esc(tpl ? sample || '—' : t('review.fieldEmpty'))}</span>
          <span class="fbtns"><span class="tag" title="${esc(t('review.apiField'))}">${esc(tpl ? tpl.replace(/^\{|\}$/g, '') : '')}</span></span></div>`;
      }
      const has = !!this.fields[f];
      let sample = has ? this.sampleOf(f, first) : '';
      if (f === 'link' && this.fields.link?.from === 'data' && sample) sample = `${sample}（${t('review.fromData')}）`;
      if (f === 'date' && !has) sample = t('review.dateFallback');
      return `<div class="field"><span class="fname">${esc(t(`field.${f}` as const))}</span>
        <span class="fval ${has && sample ? '' : 'muted'}" title="${esc(sample)}">${esc(has ? sample || '—' : sample || t('review.fieldEmpty'))}</span>
        <span class="fbtns"><button class="link" data-act="pick-field" data-field="${f}">${esc(t('review.fieldRepick'))}</button>${has && f !== 'title' ? `<button class="link" data-act="clear-field" data-field="${f}">${esc(t('review.fieldClear'))}</button>` : ''}</span></div>`;
    }).join('');

    const previewHtml = preview
      .map(
        (it) => `<li>${it.image ? `<img src="${esc(it.image)}" alt="" referrerpolicy="no-referrer">` : ''}<div class="pv"><div class="pt">${esc(it.title)}</div>${it.date || it.dateText || it.author ? `<div class="pd">${esc([it.author, it.date ? new Date(it.date).toLocaleString(this.locale) : it.dateText].filter(Boolean).join(' · '))}</div>` : ''}${it.summary ? `<div class="ps">${esc(it.summary)}</div>` : ''}</div></li>`,
      )
      .join('');

    // 没有发布时间时，引导用户一键寻找数据接口
    let apiRow = '';
    if (this.apiMatch) {
      apiRow = `<label class="check api"><input type="checkbox" data-in="useApi" ${this.useApi ? 'checked' : ''}> ${esc(t('review.useApi', { count: this.apiMatch.count }))}</label>`;
    } else if (this.findingApi) {
      apiRow = `<p class="tip">⏳ ${esc(t('review.findingApi'))}</p>`;
    } else if (!first?.date) {
      apiRow = `<div class="tip"><span>💡 ${esc(this.findApiNote || t('review.noDate'))}</span><button class="btn sm" data-act="find-api">${esc(t('review.findApi'))}</button></div>`;
    }

    const modeOpt = (m: FetchMode) => `<option value="${m}" ${this.mode === m ? 'selected' : ''}>${esc(t(`mode.${m}` as const))}</option>`;
    return `<div class="found"><strong>${esc(t('review.found', { count: items.length }))}</strong><button class="link" data-act="repick">↺ ${esc(t('review.repickShort'))}</button></div>
      ${this.renderChips(first)}
      ${apiRow}
      <ul class="preview">${previewHtml}</ul>
      ${DETAIL_FEATURE ? this.renderDetailRow() : ''}
      <label class="lbl">${esc(t('review.name'))}<input type="text" data-in="name" value="${esc(this.name)}" maxlength="120"></label>
      <label class="check"><input type="checkbox" data-in="public" ${this.isPublic ? 'checked' : ''}> ${esc(t('review.public'))}</label>
      ${this.error ? `<p class="error" role="alert">${esc(this.error)}</p>` : ''}
      <button class="btn primary block" data-act="create" ${busy || !items.length ? 'disabled' : ''}>${esc(busy ? t('review.creating') : t('review.create'))}</button>
      <details class="tune"><summary>${esc(t('review.tune'))}</summary>
        <div class="seg">
          <button class="btn sm" data-act="smaller" ${this.idx <= 0 || this.customSelector !== null ? 'disabled' : ''}>− ${esc(t('review.smaller'))}</button>
          <button class="btn sm" data-act="larger" ${this.idx >= this.cands.length - 1 || this.customSelector !== null ? 'disabled' : ''}>+ ${esc(t('review.larger'))}</button>
        </div>
        ${!this.apiMatch && !this.findingApi ? `<div class="tip"><span>${esc(this.findApiNote || t('review.sourcePage'))}</span><button class="btn sm" data-act="find-api">${esc(t('review.findApi'))}</button></div>` : ''}
        <h4>${esc(t('review.fields'))}</h4><div class="fields">${fieldRows}</div>
        <label class="lbl">${esc(t('review.selector'))}<input type="text" data-in="selector" value="${esc(this.itemSelector)}" spellcheck="false" class="mono"></label>
        <label class="lbl">${esc(t('review.mode'))}<select data-in="mode">${modeOpt('auto')}${modeOpt('static')}${modeOpt('render')}${this.apiActive ? modeOpt('api') : ''}</select></label>
        ${api ? `<label class="lbl">${esc(t('review.apiUrl'))}<input type="text" data-in="apiUrl" value="${esc(api.url)}" spellcheck="false" class="mono"></label>` : ''}
        <label class="lbl">${esc(t('review.refresh'))}<input type="number" data-in="refresh" min="10" max="1440" step="5" value="${this.refresh}"></label>
      </details>`;
  }

  private renderDone(): string {
    const t = this.t;
    const r = this.result!;
    const modeName = r.mode ? t(`mode.short.${r.mode}` as const) : '—';
    return `<div class="done-head">✓ ${esc(t('done.title'))}</div>
      <div class="copyline"><input readonly value="${esc(r.feedUrl)}" aria-label="RSS"><button class="btn primary" data-act="copy" data-value="${esc(r.feedUrl)}">${esc(t('common.copy'))}</button></div>
      <p class="muted">${esc(t('done.hint'))}</p>
      <p>${esc(t('done.serverCount', { count: r.count, mode: modeName }))}</p>
      ${r.details ? `<p class="muted">${esc(t('done.details', { ok: r.details.ok, blocked: r.details.blocked }))}</p>` : ''}
      ${r.aiPending ? `<p class="muted">✨ ${esc(t('done.ai'))}</p>` : ''}
      ${r.count === 0 ? `<p class="warn">${esc(t('done.zero'))}</p>` : ''}
      ${r.warning ? `<p class="warn">${esc(r.warning)}</p>` : ''}
      <div class="actions"><a class="btn" href="${esc(r.pageUrl)}" target="_blank" rel="noopener">${esc(t('done.gallery'))}</a><button class="btn" data-act="again">${esc(t('done.again'))}</button></div>`;
  }

  private onPanelInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    const key = el.dataset.in;
    if (!key) return;
    if (key === 'name') this.name = el.value;
    else if (key === 'detail') {
      this.detailEnabled = el.checked;
      this.render();
    } else if (key === 'ai') {
      this.aiEnabled = el.checked;
      this.render();
    }
    else if (key === 'useApi') {
      this.useApi = el.checked;
      if (!this.useApi && this.mode === 'api') this.mode = 'auto';
      this.render();
      void this.probeDetails();
    } else if (key === 'apiUrl' && e.type === 'change' && this.apiMatch && /^https?:\/\//.test(el.value.trim())) {
      this.apiMatch = { ...this.apiMatch, api: { ...this.apiMatch.api, url: el.value.trim() } };
    }
    else if (key === 'public') this.isPublic = el.checked;
    else if (key === 'mode') this.mode = el.value as FetchMode;
    else if (key === 'refresh') this.refresh = Math.min(Math.max(Number(el.value) || 60, 10), 1440);
    else if (key === 'selector' && e.type === 'change') {
      const v = el.value.trim();
      this.customSelector = v && v !== this.current?.itemSelector ? v : null;
      this.redetect();
      this.render();
    }
  }

  private async onPanelClick(e: Event): Promise<void> {
    const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    switch (act) {
      case 'close':
        return this.close();
      case 'pause':
        this.paused = !this.paused;
        this.hideHover();
        if (!this.paused && this.phase === 'review') this.matchApi();
        return this.render();
      case 'dock':
        // 回到默认位置，并在右上角 / 左上角之间切换
        this.drag?.reset();
        this.dockLeft = !this.dockLeft;
        return this.render();
      case 'copy':
        await navigator.clipboard.writeText(btn.dataset.value || '').catch(() => {});
        return this.toast(this.t('common.copied'));
      case 'smaller':
      case 'larger':
        this.idx = Math.min(Math.max(this.idx + (act === 'larger' ? 1 : -1), 0), this.cands.length - 1);
        this.redetect();
        return this.render();
      case 'repick':
      case 'again':
        this.reset();
        return this.render();
      case 'pick-field':
        this.pickingField = btn.dataset.field as FieldName;
        this.phase = 'field';
        return this.render();
      case 'cancel-field':
        this.pickingField = null;
        this.phase = 'review';
        return this.render();
      case 'clear-field': {
        const f = btn.dataset.field as FieldName;
        const next = { ...this.fields };
        if (f !== 'title') delete next[f];
        this.fields = next;
        return this.render();
      }
      case 'find-api':
        return this.findApi();
      case 'create':
        return this.create();
    }
  }

  /**
   * 「帮我找数据接口」：在网页上找「下一页 / 加载更多」按钮点一下，看看网页请求了什么接口。
   * 只点不会跳走的按钮（button、没有真实 href 的链接），避免页面整体刷新把面板关掉。
   */
  private async findApi(): Promise<void> {
    const t = this.t;
    const btn = findNextControl(this.host);
    if (!btn) {
      this.findApiNote = t('review.findApiNone');
      return this.render();
    }
    this.findingApi = true;
    this.render();
    const y = window.scrollY;
    // 选取时网页上的点击都会被拦下，这一下要放行，否则网页收不到「加载更多」
    const wasPaused = this.paused;
    this.paused = true;
    (btn as HTMLElement).click();
    this.paused = wasPaused;
    for (let i = 0; i < 16 && !this.apiMatch; i++) {
      await new Promise((r) => setTimeout(r, 250));
      this.matchApi();
    }
    window.scrollTo(0, y);
    this.findingApi = false;
    this.findApiNote = this.apiMatch ? '' : t('review.findApiFail');
    if (this.apiMatch) this.toast(t('review.findApiOk'));
    this.render();
    this.probeDetails();
  }

  /**
   * 试抓详情页：每种网址形状（如 /work/ 和 /article/）各试一个，告诉用户能不能抓、摘要长什么样。
   */
  private async probeDetails(): Promise<void> {
    if (!DETAIL_FEATURE) return;
    const items = this.preview(30);
    const byShape = new Map<string, FeedItem>();
    for (const it of items) {
      if (!it.link) continue;
      const shape = urlShape(it.link) || it.link;
      if (!byShape.has(shape)) byShape.set(shape, it);
    }
    const key = [...byShape.keys()].join('|');
    if (key === this.detailProbeKey && this.detailProbe) return;
    this.detailProbeKey = key;
    if (!byShape.size) {
      this.detailProbe = { state: 'nolink' };
      this.detailEnabled = false;
      return this.render();
    }
    this.detailProbe = { state: 'testing' };
    this.render();
    const okShapes: string[] = [];
    const blockedShapes: string[] = [];
    let summary: string | undefined;
    let chars = 0;
    let images = 0;
    let error: string | undefined;
    for (const [shape, it] of [...byShape].slice(0, 3)) {
      try {
        const r = await api<{ status: string; summary?: string; error?: string; textLength?: number; imageCount?: number }>('POST', '/api/detail-preview', { url: it.link, title: it.title, utcOffset: this.utcOffset() }, this.locale);
        if (r.status === 'ok') {
          okShapes.push(shape);
          if (summary === undefined) {
            summary = r.summary;
            chars = r.textLength ?? 0;
            images = r.imageCount ?? 0;
          }
        } else if (r.status === 'blocked') blockedShapes.push(shape);
        else error = r.error;
      } catch (e) {
        error = (e as Error).message;
      }
      if (this.detailProbeKey !== key) return; // 用户已经换了列表
    }
    this.detailProbe = okShapes.length
      ? { state: blockedShapes.length ? 'partial' : 'ok', summary, chars, images, okShapes, blockedShapes }
      : blockedShapes.length
        ? { state: 'blocked' }
        : { state: 'error', error };
    this.detailEnabled = okShapes.length > 0;
    if (!this.root.activeElement) this.render();
  }

  private async create(): Promise<void> {
    this.phase = 'creating';
    this.error = '';
    this.render();
    const recipe = this.draft();
    try {
      const r = await api<CreateResponse>('POST', '/api/recipes', { recipe, public: this.isPublic }, this.locale);
      this.result = r;
      this.phase = 'done';
      await saveMine({ id: r.id, name: recipe.name, feedUrl: r.feedUrl, pageUrl: r.pageUrl, editToken: r.editToken, sourceUrl: recipe.url, createdAt: Date.now() });
    } catch (err) {
      this.error = err instanceof NetworkError ? this.t('ext.serverError', { reason: (err as Error).message }) : (err as Error).message;
      this.phase = 'review';
    }
    this.render();
  }

  private toastTimer = 0;
  private toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1800);
  }
}

declare global {
  interface Window {
    __rssflowPicker?: { open(): Promise<void>; close(): void; draft(): unknown };
    __rssflowStyle?: { open(): Promise<void>; close(): void };
    __RSSFLOW_PAGE_URL__?: string;
    /** 注入前由扩展设置：'rss'（选取列表生成订阅）或 'style'（隐藏/修改元素） */
    __RSSFLOW_TOOL__?: 'rss' | 'style';
  }
}

// 开发页面（服务器视角 / 示例页）里暴露核心函数，方便调试
if (window.__RSSFLOW_SERVER__) (window as unknown as { __rssflowCore: unknown }).__rssflowCore = { findListCandidates, bestCandidateIndex, detectFields, extractItems, collectDataText };

// 两个工具同一时间只开一个；重复注入时只是重新打开
const tool = window.__RSSFLOW_TOOL__ ?? (new URLSearchParams(location.hash.slice(1)).get('rssflow') === 'style' ? 'style' : 'rss');
window.__RSSFLOW_TOOL__ = undefined;
if (tool === 'style') {
  window.__rssflowPicker?.close();
  window.__rssflowStyle ??= new StylePicker();
  void window.__rssflowStyle.open();
} else {
  window.__rssflowStyle?.close();
  window.__rssflowPicker ??= new Picker();
  void window.__rssflowPicker.open();
}
