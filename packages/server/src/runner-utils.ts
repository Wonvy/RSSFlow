/** 反爬验证页识别（静态抓取、浏览器渲染、详情页共用） */
export const VERIFY_RE =
  /access verification|verify you are human|are you a robot|just a moment|attention required|checking your browser|captcha|slide to (complete|verify)|安全验证|人机验证|滑动验证|滑块验证|请完成验证|访问验证|验证码|异常访问|访问过于频繁/i;

/** 是不是反爬虫的验证页（滑块、Cloudflare 等）。只看内容很少的页面，避免误判正文里提到「验证码」的文章 */
export function isVerificationPage(title: string, bodyText: string): boolean {
  const text = bodyText.replace(/\s+/g, ' ').trim();
  return text.length < 3000 && (VERIFY_RE.test(title) || VERIFY_RE.test(text.slice(0, 1500)));
}
