// 在线更新：拉取 GitHub 上的最新代码，安装依赖，重新构建扩展。
//   npm run update
// 适用于用 git clone 部署的服务器。更新完需要重启服务端；浏览器扩展在扩展管理页点「重新加载」。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getVersion } from './version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const read = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const fail = (msg) => {
  console.error(`\n✕ ${msg}`);
  process.exit(1);
};

try {
  read('git', ['rev-parse', '--is-inside-work-tree']);
} catch {
  fail('这里不是 Git 仓库，无法在线更新。请用 git clone 部署，或到 GitHub Releases 下载最新版本。\n  Not a git checkout; download the latest release from GitHub instead.');
}

// 有未提交的修改时不更新，免得覆盖你的改动
const dirty = read('git', ['status', '--porcelain', '--untracked-files=no']);
if (dirty) fail(`有未提交的修改，先提交或暂存（git stash）再更新：\n${dirty}\n  You have local changes; commit or stash them first.`);

const before = getVersion();
console.log(`RSSFlow v${before}：检查更新… / checking for updates…`);
run('git', ['pull', '--ff-only', '--tags']);
const after = getVersion();

if (after === before && process.argv.includes('--if-newer')) {
  console.log('\n✓ 已经是最新版本 / already up to date');
  process.exit(0);
}

console.log('\n安装依赖 / installing dependencies…');
run('npm', ['install', '--no-audit', '--no-fund']);
console.log('\n构建扩展 / building the extension…');
run('npm', ['run', 'build:ext']);

console.log(`\n✓ 更新完成 / updated: v${before} → v${after}`);
console.log('  1. 重启服务端（例如 Ctrl+C 后再 npm start）/ restart the server');
console.log('  2. 浏览器扩展管理页里点 RSSFlow 的「重新加载」/ reload the extension in your browser');
