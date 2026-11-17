/**
 * 版本比较与 GitHub Release 解析（扩展和服务端检查更新都用）。
 * 版本号格式：0.2.15（发布时由 GitHub Actions 打成 v0.2.15 标签）。
 */

/** a > b 返回正数，a < b 返回负数，相等返回 0；无法解析的版本当作 0.0.0 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export interface ReleaseInfo {
  version: string;
  /** 发布页 */
  url: string;
  /** 扩展安装包下载地址（可能没有） */
  extensionZip?: string;
  publishedAt?: string;
}

/** 从 GitHub 的 /releases/latest 响应里取出需要的信息 */
export function parseRelease(json: unknown): ReleaseInfo | undefined {
  if (!json || typeof json !== 'object') return undefined;
  const r = json as { tag_name?: unknown; html_url?: unknown; published_at?: unknown; assets?: unknown };
  if (typeof r.tag_name !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(r.tag_name)) return undefined;
  const assets = Array.isArray(r.assets) ? (r.assets as { name?: unknown; browser_download_url?: unknown }[]) : [];
  const zip = assets.find((a) => typeof a.name === 'string' && /extension.*\.zip$/i.test(a.name));
  const safeUrl = (u: unknown) => (typeof u === 'string' && /^https:\/\/github\.com\//.test(u) ? u : undefined);
  return {
    version: r.tag_name.replace(/^v/i, ''),
    url: safeUrl(r.html_url) ?? '',
    extensionZip: safeUrl(zip?.browser_download_url),
    publishedAt: typeof r.published_at === 'string' ? r.published_at : undefined,
  };
}

export const latestReleaseApi = (repo: string) => `https://api.github.com/repos/${repo}/releases/latest`;
