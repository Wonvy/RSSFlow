// 版本号：发布时由 GitHub Actions 打上 vX.Y.Z 标签。
// 顺序：环境变量 RSSFLOW_VERSION → 最近的 Git 标签 → 根目录 package.json 的 version。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function getVersion() {
  const fromEnv = process.env.RSSFLOW_VERSION?.replace(/^v/, '');
  if (fromEnv && /^\d+\.\d+\.\d+$/.test(fromEnv)) return fromEnv;
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
      .replace(/^v/, '');
    if (/^\d+\.\d+\.\d+$/.test(tag)) return tag;
  } catch {
    /* 不是 Git 仓库或还没有标签 */
  }
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
}
