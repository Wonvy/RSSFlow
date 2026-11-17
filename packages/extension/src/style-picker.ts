/**
 * 元素样式面板：点选网页元素 → 马上预览 → 保存成本站规则，下次打开这个网站自动生效。
 *
 * 选中元素后有两个页签：
 * - 快速处理：隐藏 / 模糊 / 变淡；
 * - 样式编辑：像浏览器开发者工具一样查看盒模型、常用属性、元素属性和全部计算样式，直接修改并即时预览。
 */
import {
  buildCss,
  createTranslator,
  describeElement,
  isSafeSelector,
  newRuleId,
  normalizeValue,
  parseDeclarations,
  ruleCss,
  selectorChoices,
  serializeDeclarations,
  smartTarget,
  type Locale,
  type SiteStyles,
  type StyleAction,
  type StyleRule,
  type Translator,
} from '@rssflow/core';
import { effectiveLocale, loadSettings } from './bridge.ts';
import { PANEL_CSS } from './panel-css.ts';
import { enableDrag } from './drag.ts';
import { INSPECTOR_CSS, elementTag, renderInspector } from './inspector.ts';
import { applyAndRemember, applyCss, keepStylesAttached, loadSiteStyles, saveSiteStyles } from './style-store.ts';

const PREVIEW_ID = 'rssflow-style-preview';
const QUICK_ACTIONS: StyleAction[] = ['hide', 'blur', 'dim'];

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE_PANEL_CSS = `
.hover.del{border-color:#e03131;background:rgba(224,49,49,.14)}
.rules{list-style:none;margin:0;padding:0;border:1px solid var(--border);border-radius:10px;max-height:260px;overflow:auto}
.rules li{display:grid;grid-template-columns:auto 1fr auto auto;gap:8px;align-items:center;padding:7px 10px;border-top:1px solid var(--border);font-size:13px}
.rules li:first-child{border-top:0}
.rules .rl{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rules .rl small{display:block;color:var(--muted);font:11px ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis}
.rules .cnt{color:var(--muted);font-size:11.5px;white-space:nowrap}
.acts{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px}
.acts .btn.on{background:var(--accent);border-color:var(--accent);color:var(--accent-text)}
.radio{display:flex;flex-direction:column;gap:6px;margin-top:6px;font-size:13px}
.radio label{display:flex;gap:8px;align-items:center;cursor:pointer}
.radio input{accent-color:var(--accent)}
textarea{width:100%;min-height:72px;margin-top:6px;padding:8px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:12px ui-monospace,Menlo,monospace}
.sel-box{padding:10px;border-radius:10px;background:var(--surface);font-size:13px}
.sel-box strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hover-note{margin:2px 0 0 22px}
`;

type Tab = 'quick' | 'edit';

export class StylePicker {
  private host!: HTMLElement;
  private root!: ShadowRoot;
  private panel!: HTMLElement;
  private hoverBox!: HTMLElement;
  private inspectBox!: HTMLElement;
  private inspectLabel!: HTMLElement;
  private toastEl!: HTMLElement;
  private t: Translator = createTranslator('en');
  private locale: Locale = 'en';
  private opened = false;
  private paused = false;
  private dockLeft = false;
  /** 标题栏拖动 */
  private drag: { reset(): void } | null = null;

  private site: SiteStyles = { rules: [] };
  private phase: 'pick' | 'edit' = 'pick';
  private anchor: Element | null = null;
  private target: Element | null = null;
  private scope: 'single' | 'similar' = 'similar';
  private tab: Tab = 'quick';
  private action: StyleAction = 'hide';
  /** 样式编辑里改过的属性：属性名 → 值（保持修改顺序） */
  private overrides = new Map<string, string>();
  private allOpen = false;
  private filter = '';
  /** 鼠标悬停时显示原样 */
  private revealOnHover = false;
  private customSelector: string | null = null;
  private error = '';
  /** 层级导航里每一项对应的元素 */
  private crumbChain: Element[] = [];
  private rafPending = false;

  async open(): Promise<void> {
    if (this.opened) return;
    this.opened = true;
    this.locale = effectiveLocale(await loadSettings());
    this.t = createTranslator(this.locale);
    this.site = await loadSiteStyles();
    this.mount();
    this.listen();
    this.render();
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    applyCss('', PREVIEW_ID);
    this.unlisten();
    this.host.remove();
    this.phase = 'pick';
    this.anchor = this.target = null;
  }

  private mount(): void {
    this.host = document.createElement('rssflow-picker');
    this.host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = `<style>${PANEL_CSS}${STYLE_PANEL_CSS}${INSPECTOR_CSS}</style><div class="hover del"></div><div class="inspect-box"></div><div class="inspect-label"></div><section class="panel" role="dialog" aria-label="RSSFlow"></section><div class="toast" role="status"></div>`;
    this.hoverBox = this.root.querySelector('.hover')!;
    this.inspectBox = this.root.querySelector('.inspect-box')!;
    this.inspectLabel = this.root.querySelector('.inspect-label')!;
    this.panel = this.root.querySelector('.panel')!;
    this.toastEl = this.root.querySelector('.toast')!;
    this.panel.lang = this.locale;
    this.drag = enableDrag(this.panel);
    this.panel.addEventListener('click', (e) => this.onPanelClick(e));
    this.panel.addEventListener('input', (e) => this.onPanelInput(e));
    this.panel.addEventListener('change', (e) => this.onPanelInput(e));
    document.documentElement.appendChild(this.host);
  }

  // ---------- 网页事件 ----------

  private isOwn(e: Event): boolean {
    return e.composedPath().includes(this.host);
  }

  private onMove = (e: MouseEvent) => {
    if (this.paused || this.phase !== 'pick' || this.isOwn(e)) {
      this.hoverBox.style.display = 'none';
      return;
    }
    const r = (e.target as Element).getBoundingClientRect();
    Object.assign(this.hoverBox.style, { display: 'block', transform: `translate(${r.left}px, ${r.top}px)`, width: `${r.width}px`, height: `${r.height}px` });
  };

  private block = (e: Event) => {
    if (!this.paused && !this.isOwn(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  private onClick = (e: MouseEvent) => {
    if (this.paused || this.isOwn(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.phase === 'pick') this.select(e.target as Element);
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    if (this.phase === 'edit') this.cancelEdit();
    else this.close();
  };

  private onViewport = () => {
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      this.drawInspectBox();
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

  // ---------- 选中与预览 ----------

  private select(el: Element): void {
    if (['html', 'body'].includes(el.tagName.toLowerCase())) return;
    this.anchor = el;
    // 点中的是列表里某一项的一部分时，默认选中整项（整张卡片）
    this.target = smartTarget(el, document);
    this.customSelector = null;
    this.error = '';
    this.scope = selectorChoices(this.target, document, el).similar ? 'similar' : 'single';
    this.tab = 'quick';
    this.action = 'hide';
    this.overrides.clear();
    this.allOpen = false;
    this.filter = '';
    this.revealOnHover = false;
    this.phase = 'edit';
    this.hoverBox.style.display = 'none';
    this.preview();
    this.render();
  }

  private get choices() {
    return this.target ? selectorChoices(this.target, document, this.anchor ?? this.target) : { single: '' };
  }

  private get selector(): string {
    if (this.customSelector !== null) return this.customSelector;
    const c = this.choices;
    return this.scope === 'similar' && c.similar ? c.similar : c.single;
  }

  /** 选择器命中的元素数（不算 RSSFlow 自己的面板） */
  private count(sel: string): number {
    try {
      return Array.from(document.querySelectorAll(sel)).filter((e) => !this.host.contains(e) && e !== this.host).length;
    } catch {
      return 0;
    }
  }

  private get cssText(): string {
    return serializeDeclarations(this.overrides);
  }

  private draftRule(): Pick<StyleRule, 'selector' | 'action' | 'css' | 'revealOnHover'> {
    return this.tab === 'edit'
      ? { selector: this.selector, action: 'custom', css: this.cssText, revealOnHover: this.revealOnHover }
      : { selector: this.selector, action: this.action, revealOnHover: this.revealOnHover };
  }

  private preview(): void {
    applyCss(this.phase === 'edit' ? ruleCss(this.draftRule()) : '', PREVIEW_ID);
    this.onViewport();
  }

  /** 在网页上给选中的元素画框，并标出标签名和尺寸（和开发者工具一样） */
  private drawInspectBox(): void {
    if (this.phase !== 'edit' || !this.target || !this.target.isConnected) {
      this.inspectBox.style.display = this.inspectLabel.style.display = 'none';
      return;
    }
    const r = this.target.getBoundingClientRect();
    if (!r.width && !r.height) {
      this.inspectBox.style.display = this.inspectLabel.style.display = 'none';
      return;
    }
    Object.assign(this.inspectBox.style, { display: 'block', transform: `translate(${r.left}px, ${r.top}px)`, width: `${r.width}px`, height: `${r.height}px` });
    this.inspectLabel.textContent = `${elementTag(this.target)} · ${Math.round(r.width)} × ${Math.round(r.height)}`;
    const ly = r.top > 22 ? r.top - 22 : r.bottom + 4;
    Object.assign(this.inspectLabel.style, { display: 'block', transform: `translate(${Math.max(r.left, 0)}px, ${ly}px)` });
  }

  private cancelEdit(): void {
    this.phase = 'pick';
    this.anchor = this.target = null;
    this.preview();
    this.render();
  }

  private async persist(): Promise<void> {
    await saveSiteStyles(this.site);
    applyAndRemember(this.site);
    if (this.site.rules.length) keepStylesAttached();
  }

  private async save(): Promise<void> {
    const sel = this.selector;
    if (!isSafeSelector(sel, document)) {
      this.error = this.t('style.badSelector');
      return this.render();
    }
    if (this.tab === 'edit' && !this.overrides.size) {
      this.error = this.t('style.noChanges');
      return this.render();
    }
    const draft = this.draftRule();
    this.site.rules.push({
      id: newRuleId(),
      selector: sel,
      action: draft.action,
      ...(draft.css ? { css: draft.css } : {}),
      ...(this.revealOnHover ? { revealOnHover: true } : {}),
      label: describeElement(this.anchor ?? this.target!),
      enabled: true,
      createdAt: Date.now(),
    });
    await this.persist();
    this.cancelEdit();
    this.toast(this.t('style.savedToast'));
  }

  // ---------- 面板 ----------

  private render(): void {
    const t = this.t;
    this.panel.classList.toggle('left', this.dockLeft);
    this.panel.classList.toggle('wide', this.phase === 'edit' && this.tab === 'edit');
    const pauseLabel = t(this.paused ? 'pick.resume' : 'pick.pause');
    const head = `<header><div class="brand" title="${esc(t('panel.dragHint'))}"><span class="grip" aria-hidden="true">⋮⋮</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="6" cy="18" r="1.8" fill="currentColor"/></svg>${esc(t('style.title'))}</div>
      <div class="head-actions"><button class="icon ${this.paused ? 'on' : ''}" data-act="pause" title="${esc(pauseLabel)}" aria-label="${esc(pauseLabel)}">${this.paused ? '▶' : 'Ⅱ'}</button><button class="icon" data-act="dock" title="${esc(t('panel.dock'))}" aria-label="${esc(t('panel.dock'))}">⇆</button><button class="icon" data-act="close" title="${esc(t('common.close'))}" aria-label="${esc(t('common.close'))}">✕</button></div></header>`;
    const pausedBar = this.paused ? `<div class="paused"><span>${esc(t('pick.paused'))}</span><button class="btn sm primary" data-act="pause">▶ ${esc(t('pick.resume'))}</button></div>` : '';
    // 重绘会替换输入框，记下滚动位置，免得每改一个值面板就跳回顶部
    const scroll = this.panel.scrollTop;
    const allScroll = this.panel.querySelector('.crows')?.scrollTop ?? 0;
    this.panel.innerHTML = head + pausedBar + `<div class="body">${this.phase === 'edit' ? this.renderEdit() : this.renderPick()}</div>`;
    this.panel.scrollTop = scroll;
    const crows = this.panel.querySelector('.crows');
    if (crows) crows.scrollTop = allScroll;
    this.drawInspectBox();
  }

  private renderRules(): string {
    const t = this.t;
    if (!this.site.rules.length) return `<p class="muted">${esc(t('style.none'))}</p>`;
    const items = this.site.rules
      .map(
        (r) => `<li><input type="checkbox" data-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''} aria-label="${esc(r.label)}">
          <span class="rl" title="${esc(r.selector)}${r.css ? '\n' + esc(r.css) : ''}">${esc(r.label)}<small>${esc(t(`style.action.${r.action}` as const))}${r.revealOnHover ? ' · ' + esc(t('style.hoverTag')) : ''} · ${esc(r.selector)}</small></span>
          <span class="cnt">${esc(t('style.matches', { count: this.count(r.selector) }))}</span>
          <button class="link" data-act="delete" data-id="${esc(r.id)}">${esc(t('style.deleteRule'))}</button></li>`,
      )
      .join('');
    return `<ul class="rules">${items}</ul>
      <label class="check"><input type="checkbox" data-in="pauseSite" ${this.site.paused ? 'checked' : ''}> ${esc(t('style.pauseAll'))}</label>`;
  }

  private renderPick(): string {
    const t = this.t;
    return `<div class="step"><span class="num">1</span><div><p class="big">${esc(t('style.hint'))}</p><p class="muted">${esc(t('style.sub'))}</p></div></div>
      <h4>${esc(t('style.saved'))}（${this.site.rules.length}）</h4>${this.renderRules()}`;
  }

  /** 层级导航：… › div.grid › div.slot › article（点哪一层就选中哪一层） */
  private renderCrumbs(): string {
    const chain: Element[] = [];
    let cur: Element | null = this.target;
    while (cur && !['body', 'html'].includes(cur.tagName.toLowerCase()) && chain.length < 5) {
      chain.unshift(cur);
      cur = cur.parentElement;
    }
    // 目标里面、通往点中元素的下一层，也放进来，方便往里走
    if (this.anchor && this.target && this.anchor !== this.target && this.target.contains(this.anchor)) {
      let child: Element | null = this.anchor;
      while (child && child.parentElement !== this.target) child = child.parentElement;
      if (child) chain.push(child);
    }
    this.crumbChain = chain;
    return `<nav class="crumbs" aria-label="DOM">${cur ? '<span class="sep">…</span>' : ''}${chain
      .map((el, i) => `${i ? '<span class="sep">›</span>' : ''}<button data-act="crumb" data-i="${i}" class="${el === this.target ? 'on' : ''}" title="${esc(elementTag(el))}">${esc(elementTag(el))}</button>`)
      .join('')}</nav>`;
  }

  private renderEdit(): string {
    const t = this.t;
    const c = this.choices;
    const sel = this.selector;
    const actBtn = (a: StyleAction) => `<button class="btn sm ${this.action === a ? 'on' : ''}" data-act="action" data-action="${a}">${esc(t(`style.action.${a}` as const))}</button>`;
    const body =
      this.tab === 'quick'
        ? `<div class="acts">${QUICK_ACTIONS.map(actBtn).join('')}</div>`
        : `<div class="mod"><span>${esc(t('style.modified', { count: this.overrides.size }))}</span>${this.overrides.size ? `<button class="link" data-act="reset-all">${esc(t('style.resetAll'))}</button>` : ''}</div>
           ${renderInspector({ el: this.target!, overrides: this.overrides, allOpen: this.allOpen, filter: this.filter, t })}
           <details class="grp"><summary>${esc(t('style.cssText'))}</summary><textarea data-in="csstext" spellcheck="false" placeholder="${esc(t('style.customPlaceholder'))}">${esc(this.cssText)}</textarea></details>`;
    return `<div class="sel-box">${esc(t('style.selected'))}<strong>${esc(describeElement(this.target!))}</strong>${this.renderCrumbs()}</div>
      <div class="radio">
        <label><input type="radio" name="scope" data-in="scope" value="single" ${this.scope === 'single' || !c.similar ? 'checked' : ''}> ${esc(t('style.single'))}</label>
        <label><input type="radio" name="scope" data-in="scope" value="similar" ${this.scope === 'similar' && c.similar ? 'checked' : ''} ${c.similar ? '' : 'disabled'}> ${esc(c.similar ? t('style.similar', { count: this.count(c.similar) }) : t('style.noSimilar'))}</label>
      </div>
      <div class="tabs" role="tablist">
        <button role="tab" data-act="tab" data-tab="quick" class="${this.tab === 'quick' ? 'on' : ''}" aria-selected="${this.tab === 'quick'}">${esc(t('style.tab.quick'))}</button>
        <button role="tab" data-act="tab" data-tab="edit" class="${this.tab === 'edit' ? 'on' : ''}" aria-selected="${this.tab === 'edit'}">${esc(t('style.tab.edit'))}</button>
      </div>
      ${body}
      <label class="check"><input type="checkbox" data-in="hover" ${this.revealOnHover ? 'checked' : ''}> ${esc(t('style.revealHover'))}</label>
      ${this.revealOnHover && this.tab === 'quick' && this.action === 'hide' ? `<p class="muted hover-note">${esc(t('style.revealHoverHide'))}</p>` : ''}
      <p class="tip">👁 ${esc(t('style.preview', { count: this.count(sel) }))}</p>
      <details><summary>${esc(t('review.advanced'))}</summary>
        <label class="lbl">${esc(t('style.selector'))}<input type="text" data-in="selector" value="${esc(sel)}" spellcheck="false" class="mono"></label>
      </details>
      ${this.error ? `<p class="error" role="alert">${esc(this.error)}</p>` : ''}
      <button class="btn primary block" data-act="save">${esc(t('style.save'))}</button>
      <div class="actions"><button class="btn" data-act="cancel">${esc(t('common.cancel'))}</button></div>`;
  }

  // ---------- 输入 ----------

  /** 样式编辑里的控件：data-prop 指明改哪个 CSS 属性 */
  private onPropInput(el: HTMLInputElement | HTMLSelectElement, e: Event): void {
    const prop = el.dataset.prop!;
    let value = el.value;
    if (el instanceof HTMLInputElement && el.type === 'range') value = value + (el.dataset.unit ?? '');
    if (el instanceof HTMLInputElement && el.type === 'text') value = normalizeValue(prop, value);
    // 滑块、取色器和旁边的文本框保持同步
    if (el instanceof HTMLInputElement && (el.type === 'range' || el.type === 'color')) {
      const peer = el.parentElement?.querySelector<HTMLInputElement>('input[type=text]');
      if (peer) peer.value = value;
    }
    if (value.trim()) this.overrides.set(prop, value.trim());
    else this.overrides.delete(prop);
    this.error = '';
    this.preview();
    // 拖滑块、打字时只预览不重绘（重绘会打断输入）；确认修改（change）后再刷新面板里的数值
    if (e.type === 'change') this.render();
  }

  private async onPanelInput(e: Event): Promise<void> {
    const el = e.target as HTMLInputElement;
    if (el.dataset.prop) return this.onPropInput(el, e);
    if (el.dataset.rule) {
      const r = this.site.rules.find((x) => x.id === el.dataset.rule);
      if (r) r.enabled = el.checked;
      await this.persist();
      return this.render();
    }
    const key = el.dataset.in;
    if (key === 'pauseSite') {
      this.site.paused = el.checked;
      await this.persist();
      return this.render();
    }
    if (key === 'filter') {
      // 搜索只显示/隐藏行，不重绘
      this.filter = el.value;
      const q = el.value.toLowerCase();
      this.panel.querySelectorAll<HTMLElement>('[data-row]').forEach((row) => {
        const v = row.querySelector('input')?.value.toLowerCase() ?? '';
        row.hidden = !!q && !row.dataset.row!.includes(q) && !v.includes(q);
      });
      return;
    }
    if (key === 'csstext') {
      if (e.type !== 'change') return;
      this.overrides = new Map(parseDeclarations(el.value));
    } else if (key === 'hover') {
      this.revealOnHover = el.checked;
    } else if (key === 'scope' && e.type === 'change') {
      this.scope = el.value as 'single' | 'similar';
      this.customSelector = null;
    } else if (key === 'selector' && e.type === 'change') {
      const v = el.value.trim();
      this.customSelector = v || null;
      this.error = v && !isSafeSelector(v, document) ? this.t('style.badSelector') : '';
    } else return;
    this.preview();
    this.render();
  }

  private async onPanelClick(e: Event): Promise<void> {
    // 「全部计算样式」展开时才渲染几百行
    const summary = (e.target as Element).closest('details[data-all] > summary');
    if (summary) {
      e.preventDefault();
      this.allOpen = !this.allOpen;
      return this.render();
    }
    const btn = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'close':
        return this.close();
      case 'dock':
        // 回到默认位置，并在右上角 / 左上角之间切换
        this.drag?.reset();
        this.dockLeft = !this.dockLeft;
        return this.render();
      case 'pause':
        this.paused = !this.paused;
        this.hoverBox.style.display = 'none';
        return this.render();
      case 'crumb': {
        const el = this.crumbChain[Number(btn.dataset.i)];
        if (el) this.target = el;
        this.customSelector = null;
        if (!this.choices.similar) this.scope = 'single';
        break;
      }
      case 'tab':
        this.tab = btn.dataset.tab as Tab;
        this.error = '';
        break;
      case 'action':
        this.action = btn.dataset.action as StyleAction;
        break;
      case 'reset-prop':
        this.overrides.delete(btn.dataset.prop!);
        break;
      case 'reset-all':
        this.overrides.clear();
        break;
      case 'cancel':
        return this.cancelEdit();
      case 'save':
        return this.save();
      case 'delete':
        this.site.rules = this.site.rules.filter((r) => r.id !== btn.dataset.id);
        await this.persist();
        return this.render();
      default:
        return;
    }
    this.preview();
    this.render();
  }

  private toastTimer = 0;
  private toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 2200);
  }
}

/** 当前页面的规则 CSS（测试用） */
export async function currentSiteCss(): Promise<string> {
  return buildCss(await loadSiteStyles());
}
