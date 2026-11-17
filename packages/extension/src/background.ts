import { NetworkError, callServer, loadSettings, type ApiMessage, type ApiReply } from './bridge.ts';

/** 在指定标签页里打开选取面板。tool：'rss' 选取列表生成订阅；'style' 隐藏/修改元素 */
export async function injectTool(tabId: number, tool: 'rss' | 'style' = 'rss'): Promise<void> {
  // 生成订阅时先在网页自己的环境里装上网络嗅探（用来发现数据接口）
  if (tool === 'rss') await chrome.scripting.executeScript({ target: { tabId }, files: ['sniff.js'], world: 'MAIN' }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, func: (t: 'rss' | 'style') => void (window.__RSSFLOW_TOOL__ = t), args: [tool] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

// ---------- 样式规则：在用户授权过的网站上，网页一开始加载就注入 ----------

const STYLE_SCRIPT_ID = 'rssflow-styles';

/** 让 styles.js 在所有已授权的网站上自动运行（授权是按网站单独申请的） */
export async function syncStyleScript(): Promise<void> {
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = origins.filter((o) => /^https?:\/\/[^*]+\/\*$/.test(o));
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [STYLE_SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [STYLE_SCRIPT_ID] });
    return;
  }
  const def = { id: STYLE_SCRIPT_ID, js: ['styles.js'], matches, runAt: 'document_start' as const, persistAcrossSessions: true };
  if (existing.length) await chrome.scripting.updateContentScripts([def]);
  else await chrome.scripting.registerContentScripts([def]);
}

chrome.runtime.onInstalled.addListener(() => void syncStyleScript());
chrome.runtime.onStartup.addListener(() => void syncStyleScript());
chrome.permissions.onAdded.addListener(async () => {
  await syncStyleScript();
  // 弹窗在权限确认框出现时可能已经关闭：由后台接着打开样式面板
  const { pendingStyleTab } = await chrome.storage.session.get('pendingStyleTab');
  if (typeof pendingStyleTab === 'number') {
    await chrome.storage.session.remove('pendingStyleTab');
    await injectTool(pendingStyleTab, 'style').catch(() => {});
  }
});
chrome.permissions.onRemoved.addListener(() => void syncStyleScript());

chrome.runtime.onMessage.addListener((msg: ApiMessage, _sender, sendResponse: (r: ApiReply) => void) => {
  if ((msg as unknown as { type?: string })?.type === 'sync-styles') {
    syncStyleScript().then(() => sendResponse({ ok: true, data: null }), (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg?.type !== 'api') return false;
  (async () => {
    const s = await loadSettings();
    try {
      const data = await callServer(s.serverUrl, msg.method, msg.path, msg.body, msg.locale);
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: (e as Error).message, network: e instanceof NetworkError });
    }
  })();
  return true; // 异步回复
});

// 快捷键 Alt+Shift+R 直接打开选取面板
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-picker') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) await injectTool(tab.id, 'rss').catch(() => {});
});
