/**
 * 让选取面板可以拖动：按住标题栏拖到网页上任意位置，松开后记住，下次打开还在那里。
 * - 不会拖出屏幕（至少留一截标题栏在可见范围内，方便拖回来）；
 * - 放得比较低时自动缩小最大高度，内容不会掉到屏幕外；
 * - 窗口大小变化时重新校正位置。
 */
const KEY = 'panelPos';
const MARGIN = 8;
/** 至少留在屏幕里的宽度 / 高度 */
const KEEP_X = 120;
const KEEP_Y = 44;

export interface PanelPos {
  x: number;
  y: number;
}

const hasExtensionApi = (): boolean => typeof chrome !== 'undefined' && !!chrome.runtime?.id;

export async function loadPanelPos(): Promise<PanelPos | null> {
  try {
    if (hasExtensionApi()) return ((await chrome.storage.local.get(KEY))[KEY] as PanelPos | undefined) ?? null;
    const raw = sessionStorage.getItem('rssflow-' + KEY);
    return raw ? (JSON.parse(raw) as PanelPos) : null;
  } catch {
    return null;
  }
}

async function savePanelPos(pos: PanelPos | null): Promise<void> {
  try {
    if (hasExtensionApi()) {
      if (pos) await chrome.storage.local.set({ [KEY]: pos });
      else await chrome.storage.local.remove(KEY);
    } else if (pos) sessionStorage.setItem('rssflow-' + KEY, JSON.stringify(pos));
    else sessionStorage.removeItem('rssflow-' + KEY);
  } catch {
    /* 记不住位置不影响使用 */
  }
}

/** 把面板放到 (x, y)，并限制在屏幕范围内 */
export function placePanel(panel: HTMLElement, x: number, y: number): PanelPos {
  const w = panel.offsetWidth || 372;
  const cx = Math.min(Math.max(x, KEEP_X - w), innerWidth - KEEP_X);
  const cy = Math.min(Math.max(y, MARGIN), innerHeight - KEEP_Y);
  Object.assign(panel.style, {
    left: `${cx}px`,
    top: `${cy}px`,
    right: 'auto',
    maxHeight: `${Math.max(innerHeight - cy - MARGIN, 160)}px`,
  });
  return { x: cx, y: cy };
}


/**
 * 启用拖动。事件挂在面板上（面板内容每次重绘都会替换，标题栏是新的元素，用事件委托）。
 */
export function enableDrag(panel: HTMLElement): { reset(): void } {
  let current: PanelPos | null = null;

  panel.addEventListener('pointerdown', (e) => {
    const target = e.target as Element;
    if (e.button !== 0 || !target.closest('header') || target.closest('button, input, select, textarea, a, label')) return;
    e.preventDefault();
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    panel.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
    const move = (ev: PointerEvent) => {
      current = placePanel(panel, ev.clientX - dx, ev.clientY - dy);
    };
    const end = () => {
      panel.removeEventListener('pointermove', move);
      panel.removeEventListener('pointerup', end);
      panel.removeEventListener('pointercancel', end);
      panel.classList.remove('dragging');
      if (current) void savePanelPos(current);
    };
    panel.addEventListener('pointermove', move);
    panel.addEventListener('pointerup', end);
    panel.addEventListener('pointercancel', end);
  });

  // 窗口变小时，别让面板留在屏幕外面
  addEventListener('resize', () => {
    if (current) current = placePanel(panel, current.x, current.y);
  });

  // 恢复上次的位置
  void loadPanelPos().then((pos) => {
    if (pos) current = placePanel(panel, pos.x, pos.y);
  });

  return {
    /** 回到默认位置（右上角，或者用「⇆」切到左上角），并忘掉拖动过的位置 */
    reset() {
      current = null;
      for (const p of ['left', 'top', 'right', 'maxHeight'] as const) panel.style[p] = '';
      void savePanelPos(null);
    },
  };
}
