import { LOCALES, LOCALE_CODES, createTranslator, type MessageKey } from '@rssflow/core';
import { DEFAULT_SERVER, api, effectiveLocale, loadMine, loadSettings, saveSettings, type Settings } from './bridge.ts';
import { loadSiteStyles, saveSiteStyles } from './style-store.ts';
import { checkForUpdate, currentVersion, setUpdateCheck, updateCheckEnabled } from './update.ts';

/** 新版本提示：自动检查（可关闭）或手动「检查更新」 */
async function renderUpdate(force = false): Promise<void> {
  const t = createTranslator(effectiveLocale(settings));
  $('version').textContent = t('popup.version', { version: currentVersion() });
  const enabled = await updateCheckEnabled();
  $<HTMLInputElement>('autoCheck').checked = enabled;
  if (!enabled && !force) return;
  const r = await checkForUpdate(force);
  const box = $('update');
  box.hidden = !r.newer;
  if (r.newer && r.latest) {
    $('updateText').textContent = t('popup.updateAvailable', { latest: r.latest.version, current: r.current });
    const zip = $<HTMLAnchorElement>('updateZip');
    zip.href = r.latest.extensionZip || r.latest.url;
    $<HTMLAnchorElement>('updateNotes').href = r.latest.url;
  }
  if (force) $('updateStatus').textContent = r.newer ? '' : r.latest ? '✓ ' + t('popup.upToDate') : t('popup.updateFailed');
}

async function injectTool(tabId: number, tool: 'rss' | 'style'): Promise<void> {
  if (tool === 'rss') await chrome.scripting.executeScript({ target: { tabId }, files: ['sniff.js'], world: 'MAIN' }).catch(() => {});
  await chrome.scripting.executeScript({ target: { tabId }, func: (t: 'rss' | 'style') => void (window.__RSSFLOW_TOOL__ = t), args: [tool] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

/** 当前网站有样式规则时，显示条数和「暂停 / 恢复」 */
async function renderSite(): Promise<void> {
  const t = createTranslator(effectiveLocale(settings));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    host = new URL(tab?.url || '').hostname;
  } catch {
    return;
  }
  if (!host) return;
  const site = await loadSiteStyles(host);
  const box = $('site');
  box.hidden = !site.rules.length;
  if (!site.rules.length) return;
  $('siteText').textContent = t('popup.siteRules', { count: site.rules.length }) + (site.paused ? ' ' + t('popup.sitePaused') : '');
  const btn = $('sitePause');
  btn.textContent = t(site.paused ? 'popup.resumeSite' : 'popup.pauseSite');
  btn.onclick = async () => {
    site.paused = !site.paused;
    await saveSiteStyles(site, host);
    void renderSite();
  };
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let settings: Settings;

function applyTexts(): void {
  const locale = effectiveLocale(settings);
  const t = createTranslator(locale);
  document.documentElement.lang = locale;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n as MessageKey)));
  const sel = $<HTMLSelectElement>('locale');
  sel.setAttribute('aria-label', t('common.language'));
  sel.innerHTML =
    `<option value="auto">Auto · ${LOCALES[effectiveLocale({ ...settings, locale: 'auto' })].name}</option>` +
    LOCALE_CODES.map((c) => `<option value="${c}">${LOCALES[c].name}</option>`).join('');
  sel.value = settings.locale;
  $<HTMLAnchorElement>('gallery').href = settings.serverUrl;
  renderMine(t);
}

async function renderMine(t: ReturnType<typeof createTranslator>): Promise<void> {
  const list = await loadMine();
  const ul = $('mine');
  ul.replaceChildren();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t('popup.mineEmpty');
    ul.append(li);
    return;
  }
  for (const m of list) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'n';
    a.href = m.pageUrl;
    a.target = '_blank';
    a.textContent = m.name;
    a.title = m.sourceUrl;
    const copy = document.createElement('button');
    copy.className = 'btn';
    copy.textContent = t('common.copy');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(m.feedUrl);
      copy.textContent = t('common.copied');
      setTimeout(() => (copy.textContent = t('common.copy')), 1500);
    });
    li.append(a, copy);
    ul.append(li);
  }
}

/** 弹窗打开时就查好当前标签页：点按钮后要立刻申请权限，不能再等 */
let activeTab: chrome.tabs.Tab | undefined;

async function main(): Promise<void> {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  settings = await loadSettings();
  $<HTMLInputElement>('server').value = settings.serverUrl;
  applyTexts();

  $('locale').addEventListener('change', async (e) => {
    settings.locale = (e.target as HTMLSelectElement).value as Settings['locale'];
    await saveSettings({ locale: settings.locale });
    applyTexts();
  });

  const showMsg = (text: string) => {
    const msg = $('pickMsg');
    msg.textContent = text;
    msg.hidden = false;
  };

  $('pick').addEventListener('click', async () => {
    const t = createTranslator(effectiveLocale(settings));
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await injectTool(tab.id!, 'rss');
      window.close();
    } catch {
      showMsg(t('popup.cannotInject'));
    }
  });

  // 隐藏 / 修改元素：先申请「这一个网站」的权限（以后打开时才能自动应用），再打开样式面板。
  // 注意：浏览器只接受「用户点击的那一刻」发出的权限申请，所以点击后第一件事就是申请，
  // 前面不能有任何 await（当前标签页在弹窗打开时就已经查好了）。
  $('style').addEventListener('click', () => {
    const t = createTranslator(effectiveLocale(settings));
    const tab = activeTab;
    let origin: string;
    try {
      const u = new URL(tab?.url || '');
      if (!/^https?:$/.test(u.protocol)) throw new Error('not a web page');
      origin = `${u.origin}/*`;
    } catch {
      return showMsg(t('popup.cannotInject'));
    }
    const request = chrome.permissions.request({ origins: [origin] });
    // 权限确认框出现时弹窗可能会被关掉，记下要打开面板的标签页，由后台接着做
    void chrome.storage.session.set({ pendingStyleTab: tab!.id });
    request.then(
      async (granted) => {
        await chrome.storage.session.remove('pendingStyleTab');
        if (!granted) return showMsg(t('popup.styleDenied'));
        await chrome.runtime.sendMessage({ type: 'sync-styles' }).catch(() => {});
        try {
          await injectTool(tab!.id!, 'style');
          window.close();
        } catch {
          showMsg(t('popup.cannotInject'));
        }
      },
      async (e: unknown) => {
        await chrome.storage.session.remove('pendingStyleTab');
        showMsg(`${t('popup.styleDenied')}（${e instanceof Error ? e.message : String(e)}）`);
      },
    );
  });

  void renderSite();
  void renderUpdate();
  $('autoCheck').addEventListener('change', async (e) => {
    await setUpdateCheck((e.target as HTMLInputElement).checked);
    void renderUpdate();
  });
  $('checkNow').addEventListener('click', () => void renderUpdate(true));

  const saveServer = async () => {
    const v = $<HTMLInputElement>('server').value.trim().replace(/\/+$/, '') || DEFAULT_SERVER;
    settings.serverUrl = v;
    await saveSettings({ serverUrl: v });
    $<HTMLAnchorElement>('gallery').href = v;
  };
  $('server').addEventListener('change', saveServer);

  $('test').addEventListener('click', async () => {
    await saveServer();
    const locale = effectiveLocale(settings);
    const t = createTranslator(locale);
    const status = $('status');
    try {
      await api('GET', '/api/health', undefined, locale);
      status.className = 'status ok';
      status.textContent = '✓ ' + t('popup.ok');
    } catch (e) {
      status.className = 'status fail';
      status.textContent = `✕ ${t('popup.fail')}: ${(e as Error).message}`;
    }
  });
}

void main();
