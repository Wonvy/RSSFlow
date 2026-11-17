/**
 * 服务端检查新版本：每 12 小时最多问一次 GitHub，结果显示在 /api/health 和规则市场页面底部。
 * 设置 RSSFLOW_UPDATE_CHECK=0 可以关闭。更新方法：在服务器目录运行 npm run update。
 */
import { compareVersions, latestReleaseApi, parseRelease, type ReleaseInfo } from '@rssflow/core';
import { config } from './config.ts';

const TTL = 12 * 3600_000;
let cache: { at: number; latest?: ReleaseInfo } | null = null;
let pending: Promise<void> | null = null;

async function refresh(): Promise<void> {
  try {
    const res = await fetch(latestReleaseApi(config.updateRepo), {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'RSSFlow-Server' },
      signal: AbortSignal.timeout(8000),
    });
    cache = { at: Date.now(), latest: res.ok ? parseRelease(await res.json()) : cache?.latest };
  } catch {
    cache = { at: Date.now(), latest: cache?.latest };
  }
}

export interface UpdateStatus {
  version: string;
  latest?: ReleaseInfo;
  updateAvailable: boolean;
}

/** 立即返回已知的结果；缓存过期时在后台刷新，不拖慢请求 */
export function updateStatus(): UpdateStatus {
  if (config.updateCheck && (!cache || Date.now() - cache.at > TTL) && !pending) {
    pending = refresh().finally(() => (pending = null));
  }
  const latest = cache?.latest;
  return { version: config.version, latest, updateAvailable: !!latest && compareVersions(latest.version, config.version) > 0 };
}
