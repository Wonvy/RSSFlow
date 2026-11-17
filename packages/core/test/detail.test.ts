import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { commonBoilerplate, extractDetail, firstSentences, isChallengePage, summarize } from '../src/index.ts';

const page = (body: string, head = '') => parseHTML(`<!doctype html><html><head>${head}</head><body>${body}</body></html>`).document as unknown as Document;

describe('extractDetail', () => {
  it('reads meta tags, JSON-LD and the main content', () => {
    const doc = page(
      `<nav><a href="/">首页</a><a href="/a">分类</a></nav>
       <div class="post-content"><h2>小标题</h2><p>第一段正文，讲了这个作品的灵感来源和背景故事，内容比较长。</p>
       <p>第二段正文，介绍了设计过程中的取舍。<script>alert(1)</script><a href="/x" onclick="evil()">链接</a></p>
       <img data-src="/img/big.jpg" src="data:image/gif;base64,AA" onerror="x()"></div>
       <div class="comments"><p>评论一：很棒很棒很棒很棒很棒很棒</p></div>`,
      `<meta property="og:description" content="一段描述">
       <script type="application/ld+json">{"@type":"Article","headline":"标题","datePublished":"2026-11-16T08:00:00+08:00","author":{"name":"小王"},"keywords":"插画,品牌"}</script>`,
    );
    const d = extractDetail(doc, 'https://ex.com/p/1');
    expect(d).toMatchObject({ title: '标题', description: '一段描述', published: '2026-11-16T00:00:00.000Z', author: '小王', tags: ['插画', '品牌'] });
    expect(d.contentHtml).toContain('<h2>小标题</h2>');
    expect(d.contentHtml).toContain('<img src="https://ex.com/img/big.jpg"');
    expect(d.contentHtml).toContain('<a href="https://ex.com/x">链接</a>');
    expect(d.contentHtml).not.toMatch(/script|onclick|onerror|评论一/);
  });
});

describe('summary', () => {
  it('removes the repeated title and site-wide boilerplate', () => {
    const bp = commonBoilerplate(['甲作品,讲述了甲的故事,示例社区汇聚了上万名设计师。', '乙作品,讲述了乙的故事,示例社区汇聚了上万名设计师。']);
    expect(bp.suffix).toBe(',示例社区汇聚了上万名设计师。');
    const s = summarize({ description: '手绘风格,创作心得：先抓住人物的神态，再去刻画细节。示例社区汇聚了上万名设计师。' }, { title: '手绘风格', boilerplate: { prefix: '', suffix: '示例社区汇聚了上万名设计师。' } });
    expect(s).toBe('创作心得：先抓住人物的神态，再去刻画细节。');
  });

  it('works on a single page: drops the site-name tail and keyword-only descriptions', () => {
    expect(
      summarize({ title: '作品名_作者-示例设计社区', description: '作品名,一段真正的描述，讲了创作过程。,示例设计社区聚集了上千万设计师。' }, { title: '作品名' }),
    ).toBe('一段真正的描述，讲了创作过程。');
    expect(
      summarize({ title: '项目需求_招聘资讯-示例社区Demo', description: '项目需求,北京设计爱好者,示例社区,设计师互动平台.', text: '想接单的别错过。第二句。' }, { title: '项目需求' }),
    ).toBe('想接单的别错过。第二句。');
  });

  it('falls back to the first sentences of the text', () => {
    expect(summarize({ description: '短', text: '第一句话比较长，说明了背景。第二句话继续说明。第三句。' }, { max: 20 })).toBe('第一句话比较长，说明了背景。…');
    expect(firstSentences('a'.repeat(10), 20)).toBe('a'.repeat(10));
  });
});

describe('isChallengePage', () => {
  it('spots JS challenges and slider pages but not real articles', () => {
    expect(isChallengePage(`<html><script>var arg1='5dd11c71';</script><div>${'oHhbljdwUXHjoCxImhBkYzc4pn89'.repeat(40)}</div></html>`)).toBe(true);
    expect(isChallengePage('<html><title>Just a moment...</title><body>Checking your browser</body></html>')).toBe(true);
    expect(isChallengePage(`<html><body><article>${'如何设计更好的验证码体验。'.repeat(100)}</article></body></html>`)).toBe(false);
  });
});

describe('image galleries (work pages are mostly pictures)', () => {
  it('finds every work image in order and leaves out logos, avatars, comments and recommendations', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync(new URL('../../server/demo/work-gallery.html', import.meta.url), 'utf8');
    const doc = parseHTML(html).document as unknown as Document;
    const d = extractDetail(doc, 'https://www.design.example.cn/work/W1.html', { utcOffset: 480 });
    expect(d.images).toEqual(Array.from({ length: 8 }, (_, i) => `https://img.example-cdn.cn/community/work-${i + 1}.jpg?x-oss-process=image/resize,w_1280`));
    expect(d.contentHtml).toContain('创作心得');
    expect((d.contentHtml!.match(/<img /g) || []).length).toBe(8);
    expect(d.contentHtml).not.toMatch(/avatar|logo|qrcode|rec-1|赵四/);
    expect(d.published).toBe('2026-11-17T08:20:11.000Z');
    expect(summarize(d, { title: '手绘风格《城市漫游》', boilerplate: { prefix: '', suffix: ',示例设计社区聚集了上千万设计师、摄影师、插画师。' } })).toBe('创作心得：先抓住人物的神态，再去刻画细节。头像绘制课程下月开课～');
  });
});
