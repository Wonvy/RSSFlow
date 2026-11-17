/**
 * 样式审查面板：像浏览器开发者工具一样查看选中元素的属性、盒模型和计算样式，并直接修改。
 * 这里只负责「生成 HTML」和「数值换算」，事件处理在 style-picker.ts。
 *
 * 所有可编辑的控件都带 data-prop="CSS 属性名"，修改后写进 overrides（属性 → 值），
 * 再由面板生成 CSS 规则即时预览、保存。
 */
import type { MessageKey, Translator } from '@rssflow/core';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

type Control =
  | { type: 'text' }
  | { type: 'select'; options: string[] }
  | { type: 'color' }
  | { type: 'range'; min: number; max: number; step: number; unit: string };

interface PropDef {
  prop: string;
  control: Control;
}

interface Group {
  key: MessageKey;
  props: PropDef[];
}

const text: Control = { type: 'text' };
const color: Control = { type: 'color' };
const select = (...options: string[]): Control => ({ type: 'select', options });
const range = (min: number, max: number, step: number, unit: string): Control => ({ type: 'range', min, max, step, unit });

/** 常用属性，按开发者工具的习惯分组 */
export const GROUPS: Group[] = [
  {
    key: 'style.group.layout',
    props: [
      { prop: 'display', control: select('block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'none') },
      { prop: 'position', control: select('static', 'relative', 'absolute', 'fixed', 'sticky') },
      { prop: 'width', control: text },
      { prop: 'height', control: text },
      { prop: 'max-width', control: text },
      { prop: 'overflow', control: select('visible', 'hidden', 'auto', 'scroll') },
      { prop: 'z-index', control: text },
    ],
  },
  {
    key: 'style.group.text',
    props: [
      { prop: 'color', control: color },
      { prop: 'font-size', control: range(8, 72, 1, 'px') },
      { prop: 'font-weight', control: select('100', '200', '300', '400', '500', '600', '700', '800', '900') },
      { prop: 'line-height', control: text },
      { prop: 'letter-spacing', control: text },
      { prop: 'text-align', control: select('left', 'center', 'right', 'justify', 'start', 'end') },
      { prop: 'text-decoration-line', control: select('none', 'underline', 'line-through', 'overline') },
      { prop: 'font-family', control: text },
    ],
  },
  {
    key: 'style.group.bg',
    props: [
      { prop: 'background-color', control: color },
      { prop: 'border-style', control: select('none', 'solid', 'dashed', 'dotted', 'double') },
      { prop: 'border-color', control: color },
      { prop: 'border-radius', control: range(0, 60, 1, 'px') },
    ],
  },
  {
    key: 'style.group.effect',
    props: [
      { prop: 'opacity', control: range(0, 1, 0.05, '') },
      { prop: 'visibility', control: select('visible', 'hidden') },
      { prop: 'filter', control: text },
      { prop: 'box-shadow', control: text },
      { prop: 'transform', control: text },
    ],
  },
];

// ---------- 数值换算 ----------

/** rgb()/rgba() → #rrggbb（取色器只认这种格式）；透明返回 null */
export function toHex(value: string): string | null {
  const m = value.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)/i);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (alpha === 0) return null;
    return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) return '#' + [...value.slice(1)].map((c) => c + c).join('').toLowerCase();
  return null;
}

/** 盒模型输入框里显示的数字：「12px」→「12」，其它原样 */
const short = (v: string) => (/^-?[\d.]+px$/.test(v) ? String(Math.round(parseFloat(v) * 10) / 10) : v || '0');

// ---------- 渲染 ----------

export interface InspectorState {
  el: Element;
  overrides: Map<string, string>;
  /** 「全部计算样式」是否展开、搜索词 */
  allOpen: boolean;
  filter: string;
  t: Translator;
}

function valueOf(state: InspectorState, cs: CSSStyleDeclaration, prop: string): string {
  return state.overrides.get(prop) ?? cs.getPropertyValue(prop).trim();
}

function resetBtn(state: InspectorState, prop: string): string {
  return state.overrides.has(prop) ? `<button class="link rst" data-act="reset-prop" data-prop="${esc(prop)}" title="${esc(state.t('style.reset'))}">↺</button>` : '';
}

function row(state: InspectorState, cs: CSSStyleDeclaration, def: PropDef): string {
  const { prop, control } = def;
  const v = valueOf(state, cs, prop);
  const changed = state.overrides.has(prop) ? ' changed' : '';
  const label = state.t(`prop.${prop}` as MessageKey);
  let input = '';
  if (control.type === 'select') {
    const opts = control.options.includes(v) ? control.options : [v, ...control.options];
    input = `<select data-prop="${prop}">${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  } else if (control.type === 'color') {
    const hex = toHex(v);
    input = `<span class="pair"><input type="color" data-prop="${prop}" value="${hex ?? '#ffffff'}" ${hex ? '' : 'data-transparent'} aria-label="${esc(label)}"><input type="text" data-prop="${prop}" value="${esc(v)}" spellcheck="false"></span>`;
  } else if (control.type === 'range') {
    const n = parseFloat(v);
    input = `<span class="pair"><input type="range" data-prop="${prop}" data-unit="${control.unit}" min="${control.min}" max="${control.max}" step="${control.step}" value="${Number.isFinite(n) ? n : control.min}" aria-label="${esc(label)}"><input type="text" data-prop="${prop}" value="${esc(v)}" spellcheck="false"></span>`;
  } else {
    input = `<input type="text" data-prop="${prop}" value="${esc(v)}" spellcheck="false">`;
  }
  return `<div class="prow${changed}"><label title="${esc(prop)}">${esc(label)}<small>${esc(prop)}</small></label>${input}${resetBtn(state, prop)}</div>`;
}

/** 盒模型图：外边距 › 边框 › 内边距 › 内容，四个方向都能直接改 */
function boxModel(state: InspectorState, cs: CSSStyleDeclaration): string {
  const t = state.t;
  const side = (prefix: string, suffix: string, s: 'top' | 'right' | 'bottom' | 'left') => {
    const prop = `${prefix}-${s}${suffix}`;
    const v = valueOf(state, cs, prop);
    return `<input class="bm-${s}${state.overrides.has(prop) ? ' changed' : ''}" data-prop="${prop}" value="${esc(short(v))}" title="${esc(prop)}: ${esc(v)}" spellcheck="false">`;
  };
  const ring = (name: MessageKey, prefix: string, suffix: string, inner: string, cls: string) =>
    `<div class="bm ${cls}"><span class="bm-name">${esc(t(name))}</span>${side(prefix, suffix, 'top')}${side(prefix, suffix, 'left')}${inner}${side(prefix, suffix, 'right')}${side(prefix, suffix, 'bottom')}</div>`;
  const r = state.el.getBoundingClientRect();
  const content = `<div class="bm bm-content">${Math.round(r.width * 10) / 10} × ${Math.round(r.height * 10) / 10}</div>`;
  return ring('style.box.margin', 'margin', '', ring('style.box.border', 'border', '-width', ring('style.box.padding', 'padding', '', content, 'bm-padding'), 'bm-border'), 'bm-margin');
}

function attributes(state: InspectorState): string {
  const attrs = Array.from(state.el.attributes);
  if (!attrs.length) return `<p class="muted">${esc(state.t('style.attrsNone'))}</p>`;
  return `<dl class="attrs">${attrs
    .slice(0, 40)
    .map((a) => `<dt>${esc(a.name)}</dt><dd title="${esc(a.value)}">${esc(a.value.length > 200 ? a.value.slice(0, 200) + '…' : a.value)}</dd>`)
    .join('')}</dl>`;
}

/** 全部计算样式（几百条），展开后才渲染，带搜索 */
function allComputed(state: InspectorState, cs: CSSStyleDeclaration): string {
  const t = state.t;
  if (!state.allOpen) return `<details class="all" data-all><summary>${esc(t('style.group.all', { count: cs.length }))}</summary></details>`;
  const props = Array.from({ length: cs.length }, (_, i) => cs.item(i))
    .filter((p) => !p.startsWith('-webkit-') || state.filter)
    .sort();
  const q = state.filter.toLowerCase();
  const rows = props
    .map((p) => {
      const v = valueOf(state, cs, p);
      const hidden = q && !p.includes(q) && !v.toLowerCase().includes(q) ? ' hidden' : '';
      return `<div class="crow${state.overrides.has(p) ? ' changed' : ''}" data-row="${esc(p)}"${hidden}><span>${esc(p)}</span><input type="text" data-prop="${esc(p)}" value="${esc(v)}" spellcheck="false">${resetBtn(state, p)}</div>`;
    })
    .join('');
  return `<details class="all" data-all open><summary>${esc(t('style.group.all', { count: props.length }))}</summary>
    <input type="search" class="search" data-in="filter" value="${esc(state.filter)}" placeholder="${esc(t('style.search'))}">
    <div class="crows">${rows}</div></details>`;
}

export function renderInspector(state: InspectorState): string {
  const t = state.t;
  const cs = getComputedStyle(state.el);
  const groups = GROUPS.map((g) => `<details class="grp" open><summary>${esc(t(g.key))}</summary>${g.props.map((d) => row(state, cs, d)).join('')}</details>`).join('');
  return `<div class="insp">
    <details class="grp" open><summary>${esc(t('style.group.box'))}</summary>${boxModel(state, cs)}</details>
    ${groups}
    <details class="grp"><summary>${esc(t('style.group.attrs'))}</summary>${attributes(state)}</details>
    ${allComputed(state, cs)}
  </div>`;
}

/** 选中元素的简短名字，用于网页上的标注和层级导航：div.card#main */
export function elementTag(el: Element): string {
  const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean)[0] : '';
  return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
}

export const INSPECTOR_CSS = `
.panel.wide{width:min(460px,calc(100vw - 32px))}
.tabs{display:flex;gap:4px;margin:10px 0 4px;border-bottom:1px solid var(--border)}
.tabs button{border:0;background:none;padding:6px 10px;cursor:pointer;color:var(--muted);border-bottom:2px solid transparent;font-size:13px}
.tabs button.on{color:var(--accent);border-bottom-color:var(--accent);font-weight:600}
.crumbs{display:flex;flex-wrap:wrap;gap:2px;font:11.5px ui-monospace,Menlo,monospace;margin-top:6px}
.crumbs button{border:0;background:none;padding:1px 4px;border-radius:4px;cursor:pointer;color:var(--muted);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.crumbs button.on{background:var(--accent);color:var(--accent-text)}
.crumbs .sep{color:var(--muted)}
.insp details.grp{border-top:1px solid var(--border);padding:6px 0}
.insp summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--muted);padding:4px 0}
.prow{display:grid;grid-template-columns:96px 1fr 18px;gap:6px;align-items:center;padding:3px 0}
.prow label{font-size:12.5px;line-height:1.2}
.prow label small{display:block;color:var(--muted);font:10.5px ui-monospace,Menlo,monospace}
.prow.changed label{color:var(--accent);font-weight:600}
.insp input[type=text],.insp select,.insp input[type=search]{width:100%;min-width:0;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font:12px ui-monospace,Menlo,monospace}
.prow.changed input[type=text],.prow.changed select,.crow.changed input{border-color:var(--accent)}
.pair{display:flex;gap:6px;align-items:center;min-width:0}
.pair input[type=range]{flex:1;min-width:60px;accent-color:var(--accent)}
.pair input[type=text]{flex:0 0 84px;width:84px}
.pair input[type=color]{flex:none;width:30px;height:24px;padding:0;border:1px solid var(--border);border-radius:5px;background:none}
.rst{padding:0;font-size:13px}
.bm{position:relative;display:grid;grid-template-columns:38px 1fr 38px;grid-template-rows:auto 1fr auto;gap:2px;align-items:center;justify-items:center;padding:4px;border:1px dashed var(--muted);border-radius:4px;font-size:10px}
.bm-margin{background:rgba(249,204,157,.35)}
.bm-border{background:rgba(255,221,170,.6);border-style:solid;border-color:#222}
.bm-padding{background:rgba(195,208,139,.55)}
.bm-content{display:block;background:rgba(139,182,192,.6);padding:8px 10px;font:11px ui-monospace,Menlo,monospace;color:#111;border:1px solid #6a8f99;text-align:center}
.bm>.bm{grid-column:2;grid-row:2;width:100%}
.bm-name{position:absolute;top:2px;left:4px;color:#333;font-size:9.5px}
.bm input{width:36px;padding:1px 2px;border:1px solid transparent;border-radius:3px;background:rgba(255,255,255,.7);color:#111;text-align:center;font:10.5px ui-monospace,Menlo,monospace}
.bm input:hover,.bm input:focus{border-color:#555}
.bm input.changed{background:#fff3bf;border-color:var(--accent)}
.bm-top{grid-column:2;grid-row:1}.bm-bottom{grid-column:2;grid-row:3}.bm-left{grid-column:1;grid-row:2}.bm-right{grid-column:3;grid-row:2}
dl.attrs{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin:4px 0;font:11.5px ui-monospace,Menlo,monospace}
dl.attrs dt{color:#a0522d}
dl.attrs dd{margin:0;overflow-wrap:anywhere;color:var(--text)}
.all .search{margin:6px 0}
.crows{max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px}
.crow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.1fr) 18px;gap:6px;align-items:center;padding:2px 6px;border-top:1px solid var(--border);font:11.5px ui-monospace,Menlo,monospace}
.crow:first-child{border-top:0}
.crow span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#a0522d}
.crow input[type=text]{padding:2px 4px;font-size:11.5px}
.mod{display:flex;justify-content:space-between;align-items:center;font-size:12.5px;margin:8px 0}
.inspect-box{position:fixed;left:0;top:0;display:none;pointer-events:none;border:2px solid #1c7ed6;background:rgba(28,126,214,.10);border-radius:2px}
.inspect-label{position:fixed;left:0;top:0;display:none;pointer-events:none;background:#1c7ed6;color:#fff;font:11px ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:3px;white-space:nowrap}
`;
