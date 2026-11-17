/**
 * 元素样式规则的存储与应用（网页加载时的自动应用、选取面板的实时预览都用这里）。
 * 规则按网站（hostname）保存在 chrome.storage.local；开发页面里没有扩展 API 时存在 localStorage。
 */
// 只从 styles.ts 引入，不经过核心库的总入口，也不引入 bridge：
// styles.js 会在每次打开网页时运行，越小越好（不带词典和识别算法）
import { buildCss, type SiteStyles } from '../../core/src/styles.ts';

const hasExtensionApi = (): boolean => typeof chrome !== 'undefined' && !!chrome.runtime?.id;

const key = (host: string) => `styles:${host}`;

export async function loadSiteStyles(host = location.hostname): Promise<SiteStyles> {
  try {
    if (hasExtensionApi()) {
      const v = (await chrome.storage.local.get(key(host)))[key(host)] as SiteStyles | undefined;
      return v && Array.isArray(v.rules) ? v : { rules: [] };
    }
    const raw = localStorage.getItem('rssflow-' + key(host));
    return raw ? (JSON.parse(raw) as SiteStyles) : { rules: [] };
  } catch {
    return { rules: [] };
  }
}

export async function saveSiteStyles(site: SiteStyles, host = location.hostname): Promise<void> {
  if (hasExtensionApi()) {
    if (site.rules.length || site.paused) await chrome.storage.local.set({ [key(host)]: site });
    else await chrome.storage.local.remove(key(host));
    return;
  }
  try {
    localStorage.setItem('rssflow-' + key(host), JSON.stringify(site));
  } catch {
    /* 隐私模式等情况下存不了，只影响开发页面 */
  }
}

/** 规则变化时通知（其它标签页、弹窗里改了规则，这里马上生效） */
export function onSiteStylesChanged(host: string, cb: (site: SiteStyles) => void): void {
  if (!hasExtensionApi()) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && key(host) in changes) cb((changes[key(host)].newValue as SiteStyles) || { rules: [] });
  });
}

const STYLE_ID = 'rssflow-styles';

/**
 * 把 CSS 放进网页。有些网站会在加载过程中重建 <head>，所以监听一下，被移除了就再放回去。
 */
export function applyCss(css: string, id = STYLE_ID): void {
  let el = document.getElementById(id) as HTMLStyleElement | null;
  if (!css) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    el.setAttribute('data-rssflow', '');
  }
  if (el.textContent !== css) el.textContent = css;
  if (!el.isConnected) (document.head || document.documentElement).appendChild(el);
}

export function applySiteStyles(site: SiteStyles): void {
  applyCss(buildCss(site));
}

let guard: MutationObserver | null = null;
/** 盯住样式节点，被网页脚本移除时放回去 */
export function keepStylesAttached(): void {
  if (guard) return;
  guard = new MutationObserver(() => {
    const el = document.getElementById(STYLE_ID);
    if (!el && lastCss) applyCss(lastCss);
  });
  guard.observe(document.documentElement, { childList: true, subtree: true });
}

let lastCss = '';
export function applyAndRemember(site: SiteStyles): void {
  lastCss = buildCss(site);
  applyCss(lastCss);
}
