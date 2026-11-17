/**
 * 把网页上五花八门的时间文本解析成 Date。
 * 支持：2026-11-17 10:30、2026年11月17日、11-17、3小时前、昨天 08:00、Nov 17, 2026、ISO 8601 等。
 * utcOffset：网站所在时区相对 UTC 的分钟数（东八区 480），用于没有时区信息的时间。
 */

const UNIT_MS: Record<string, number> = {
  秒: 1000, 分: 60_000, 分钟: 60_000, 小时: 3_600_000, 时: 3_600_000, 天: 86_400_000, 日: 86_400_000,
  周: 7 * 86_400_000, 星期: 7 * 86_400_000, 个月: 30 * 86_400_000, 月: 30 * 86_400_000, 年: 365 * 86_400_000,
  second: 1000, minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000,
  week: 7 * 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000,
};

export const DATE_LIKE_RE =
  /(\d{4}[-/.年]\s*\d{1,2}[-/.月]\s*\d{1,2})|(\d{1,2}[-/月]\d{1,2}日?(\s|$))|(\d+\s*(秒|分钟|分|小时|天|周|个月|年)前)|(刚刚|今天|昨天|前天)|(\d+\s*(seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?)\s+ago)|((jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})|(^\s*\d{1,2}:\d{2}\s*$)/i;

export function looksLikeDate(text: string): boolean {
  return text.length > 0 && text.length <= 40 && DATE_LIKE_RE.test(text);
}

/** 以「网站时区」解释年月日时分，返回真正的时间点 */
function zoned(y: number, mo: number, d: number, h: number, mi: number, s: number, utcOffset: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s) - utcOffset * 60_000);
}

/** 当前时间在网站时区下的年月日 */
function zonedNow(now: Date, utcOffset: number) {
  const t = new Date(now.getTime() + utcOffset * 60_000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function parseDate(input: string | null | undefined, opts: { now?: Date; utcOffset?: number } = {}): Date | undefined {
  const text = (input || '').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const now = opts.now ?? new Date();
  const off = opts.utcOffset ?? -now.getTimezoneOffset();
  const valid = (d: Date) => (isNaN(d.getTime()) ? undefined : d);

  // ISO 8601 带时区
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(text)) return valid(new Date(text));
  // 纯数字时间戳
  if (/^\d{10}$/.test(text)) return valid(new Date(Number(text) * 1000));
  if (/^\d{13}$/.test(text)) return valid(new Date(Number(text)));

  const time = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  const [h, mi, s] = time ? [Number(time[1]), Number(time[2]), Number(time[3] || 0)] : [0, 0, 0];

  // 刚刚 / N 单位前
  if (/刚刚|just now/i.test(text)) return now;
  const rel = text.match(/(\d+)\s*(秒|分钟|分|小时|时|天|日|周|星期|个月|月|年)前/) ||
    text.match(/(\d+)\s*(second|minute|min|hour|hr|day|week|month|year)s?\s+ago/i);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * (UNIT_MS[rel[2].toLowerCase()] ?? 0));

  // 今天 / 昨天 / 前天
  const today = zonedNow(now, off);
  const dayShift = /前天/.test(text) ? 2 : /昨天|yesterday/i.test(text) ? 1 : /今天|today/i.test(text) ? 0 : -1;
  if (dayShift >= 0) {
    const base = zoned(today.y, today.mo, today.d, h, mi, s, off);
    return new Date(base.getTime() - dayShift * 86_400_000);
  }

  // 完整年月日
  const full = text.match(/(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/);
  if (full) {
    if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
      const d = valid(new Date(text));
      if (d) return d;
    }
    return valid(zoned(Number(full[1]), Number(full[2]), Number(full[3]), h, mi, s, off));
  }

  // 英文月份等，交给 Date.parse
  if (/[a-z]{3}/i.test(text)) {
    const t = Date.parse(text);
    if (!isNaN(t)) {
      const hasZone = /(GMT|UTC|Z|[+-]\d{2}:?\d{2})\b/i.test(text);
      if (hasZone) return new Date(t);
      const d = new Date(t);
      return zoned(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), off);
    }
  }

  // 只有月日，补当前年；如果比现在晚太多，说明是去年
  const md = text.match(/(?:^|[^\d])(\d{1,2})\s*[-/月]\s*(\d{1,2})日?/);
  if (md) {
    const mo = Number(md[1]);
    const d = Number(md[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      let res = zoned(today.y, mo, d, h, mi, s, off);
      if (res.getTime() - now.getTime() > 2 * 86_400_000) res = zoned(today.y - 1, mo, d, h, mi, s, off);
      return res;
    }
  }

  // 只有时分 → 今天
  if (time && /^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return zoned(today.y, today.mo, today.d, h, mi, s, off);

  return undefined;
}

/** 国家/地区顶级域名 → 时区（分钟） */
const TLD_OFFSETS: Record<string, number> = {
  cn: 480, hk: 480, mo: 480, tw: 480, sg: 480, my: 480, ph: 480,
  jp: 540, kr: 540, th: 420, vn: 420, id: 420, in: 330,
  ru: 180, tr: 180, de: 60, fr: 60, it: 60, es: 60, nl: 60, se: 60, pl: 60, uk: 0, ie: 0, pt: 0, br: -180,
};

/** 页面语言 → 时区（分钟），只收录基本只在一个时区使用的语言 */
const LANG_OFFSETS: Record<string, number> = {
  zh: 480, ja: 540, ko: 540, th: 420, vi: 420, id: 420, de: 60, fr: 60, it: 60, nl: 60, pl: 60, tr: 180,
};

/**
 * 推断网站所在时区（相对 UTC 的分钟数）。
 * 用户本机时区不一定和网站一致（比如在海外看国内网站），所以优先看网址和页面语言。
 * 推断不出时返回 undefined。
 */
export function guessUtcOffset(pageUrl: string, lang?: string | null): number | undefined {
  try {
    const host = new URL(pageUrl).hostname;
    const tld = host.split('.').pop()!.toLowerCase();
    if (tld in TLD_OFFSETS) return TLD_OFFSETS[tld];
  } catch {
    /* 忽略 */
  }
  const base = (lang || '').toLowerCase().split(/[-_]/)[0];
  return base in LANG_OFFSETS ? LANG_OFFSETS[base] : undefined;
}
