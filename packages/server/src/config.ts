import { fileURLToPath } from 'node:url';
import path from 'node:path';

const env = process.env;
const flag = (v: string | undefined) => v === '1' || v === 'true';

export const config = {
  port: Number(env.PORT || 8787),
  host: env.HOST || '127.0.0.1',
  /** 对外访问地址，用于生成订阅链接；不填则按请求的 Host 推断 */
  publicUrl: (env.RSSFLOW_PUBLIC_URL || '').replace(/\/+$/, ''),
  dataDir: env.RSSFLOW_DATA_DIR || path.resolve(fileURLToPath(new URL('../../../data', import.meta.url))),
  /** 允许抓取内网地址（本地开发/自己部署在内网时打开） */
  allowPrivate: flag(env.RSSFLOW_ALLOW_PRIVATE),
  /** 开发模式：提供 /demo 示例页面和 /dev/picker.js */
  dev: flag(env.RSSFLOW_DEV),
  /** 订阅最短刷新间隔（分钟） */
  minRefreshMinutes: Number(env.RSSFLOW_MIN_REFRESH || 10),
  /** 同时运行的浏览器渲染任务数 */
  renderConcurrency: Number(env.RSSFLOW_RENDER_CONCURRENCY || 2),
  maxPageBytes: 5 * 1024 * 1024,
  /** 每个 IP 每分钟允许的写操作次数 */
  writeRatePerMinute: Number(env.RSSFLOW_WRITE_RATE || 30),
  /**
   * AI 摘要：配置了 Anthropic 凭证（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_PROFILE）时自动开启，
   * 也可以用 RSSFLOW_AI=1 强制开启（例如用 ant auth login 登录的默认凭证），RSSFLOW_AI=0 关闭。
   */
  aiEnabled: env.RSSFLOW_AI === '1' || (env.RSSFLOW_AI !== '0' && !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE)),
  aiModel: env.RSSFLOW_AI_MODEL || 'claude-opus-5-5',
  /** 整个服务器每小时最多调用多少次 AI（控制费用） */
  aiMaxPerHour: Number(env.RSSFLOW_AI_MAX_PER_HOUR || 200),
};

export const ROOT_DIR = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
