// 构建浏览器扩展：打包脚本、复制静态文件、生成图标。
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const watch = process.argv.includes('--watch');
const out = new URL('./dist/', import.meta.url).pathname;

rmSync(out, { recursive: true, force: true });
mkdirSync(out + 'icons', { recursive: true });
cpSync(new URL('./public/', import.meta.url).pathname, out, { recursive: true });
cpSync(new URL('./src/popup.html', import.meta.url).pathname, out + 'popup.html');

// ---- 生成 RSS 图标 PNG（橙色圆角方块 + 白色信号弧线），不依赖任何图片库 ----
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) {
    c = (crc ^ b) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function icon(size) {
  const S = 4; // 超采样抗锯齿
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const inside = (x, y) => {
    const r = 0.22, m = Math.min(x, 1 - x), n = Math.min(y, 1 - y);
    if (m < r && n < r) return Math.hypot(r - m, r - n) <= r ? 1 : 0;
    return 1;
  };
  const white = (x, y) => {
    const cx = 0.28, cy = 0.72;
    if (Math.hypot(x - cx, y - cy) <= 0.085) return true;
    if (x < cx - 0.06 || y > cy + 0.06) return false;
    const d = Math.hypot(x - (cx - 0.06), y - (cy + 0.06));
    return (d >= 0.28 && d <= 0.39) || (d >= 0.5 && d <= 0.61);
  };
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let a = 0, w = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const x = (px + (sx + 0.5) / S) / size, y = (py + (sy + 0.5) / S) / size;
        if (inside(x, y)) { a++; if (white(x, y)) w++; }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const wf = a ? w / a : 0;
      raw[o] = Math.round(232 + (255 - 232) * wf);
      raw[o + 1] = Math.round(89 + (255 - 89) * wf);
      raw[o + 2] = Math.round(12 + (255 - 12) * wf);
      raw[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [16, 32, 48, 128]) writeFileSync(`${out}icons/${s}.png`, icon(s));

const options = {
  entryPoints: { content: 'src/content.ts', sniff: 'src/sniff.ts', styles: 'src/styles.ts', background: 'src/background.ts', popup: 'src/popup.ts' },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: ['chrome110', 'firefox115', 'safari16'],
  charset: 'utf8',
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
