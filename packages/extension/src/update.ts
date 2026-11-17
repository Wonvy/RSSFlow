/**
 * 扩展检查新版本：弹窗打开时问一下 GitHub 上最新的 Release（每 6 小时最多一次，可以在弹窗里关掉）。
 *
 * 说明：从文件夹加载的扩展（开发者模式），浏览器不允许它替换自己的文件，
 * 所以这里只负责发现新版本、给出下载链接和更新步骤；要做到全自动更新，需要上架扩展商店。
 */
import { compareVersions, latestReleaseApi, parseRelease, type ReleaseInfo } from '@rssflow/core';

declare const __RSSFLOW_VERSION__: string;

export const UPDATE_REPO = 'Wonvy/RSSFlow';
const TTL = 6 * 3600_000;

export const currentVersion = (): string => {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return typeof __RSSFLOW_VERSION__ === 'string' ? __RSSFLOW_VERSION__ : '0.0.0';
  }
};

export async function updateCheckEnabled(): Promise<boolean> {
  const { checkUpdates } = await chrome.storage.sync.get('checkUpdates');
  return checkUpdates !== false;
}

export async function setUpdateCheck(on: boolean): Promise<void> {
  await chrome.storage.sync.set({ checkUpdates: on });
}

export interface UpdateResult {
  current: string;
  latest?: ReleaseInfo;
  newer: boolean;
}

/** force：忽略缓存，立即检查（弹窗里点「检查更新」时） */
export async function checkForUpdate(force = false): Promise<UpdateResult> {
  const current = currentVersion();
  const { updateInfo } = (await chrome.storage.local.get('updateInfo')) as { updateInfo?: { at: number; latest?: ReleaseInfo } };
  let latest = updateInfo?.latest;
  if (force || !updateInfo || Date.now() - updateInfo.at > TTL) {
    try {
      const res = await fetch(latestReleaseApi(UPDATE_REPO), { headers: { accept: 'application/vnd.github+json' } });
      if (res.ok) latest = parseRelease(await res.json());
      await chrome.storage.local.set({ updateInfo: { at: Date.now(), latest } });
    } catch {
      /* 没网或 GitHub 限流：沿用上次的结果 */
    }
  }
  return { current, latest, newer: !!latest && compareVersions(latest.version, current) > 0 };
}
