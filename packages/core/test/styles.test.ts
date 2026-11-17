import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { buildCss, describeElement, normalizeValue, parseDeclarations, serializeDeclarations, isSafeSelector, ruleCss, sanitizeDeclarations, selectorChoices, smartTarget } from '../src/index.ts';

const doc = () =>
  parseHTML(`<!doctype html><html><body>
    <div class="banner-top"><img src="/ad.jpg" alt="双十一大促"></div>
    <div class="Xy3abC_cardGrid">
      <div class="Xy3abC_cardCell"><div class="card">作品一</div></div>
      <div class="Xy3abC_cardCell"><article class="Mn5OpQ_promoCard promo-ad"><p>推广内容</p></article></div>
      <div class="Xy3abC_cardCell"><div class="card">作品二</div></div>
      <div class="Xy3abC_cardCell"><article class="Mn5OpQ_promoCard promo-ad"><p>另一个推广</p></article></div>
    </div></body></html>`).document as unknown as Document;

describe('style rules', () => {
  it('builds CSS for each action and skips disabled or paused rules', () => {
    const rules = [
      { id: '1', selector: '.banner-top', action: 'hide' as const, label: '', enabled: true, createdAt: 0 },
      { id: '2', selector: '.side', action: 'dim' as const, label: '', enabled: false, createdAt: 0 },
      { id: '3', selector: 'h1', action: 'custom' as const, css: 'color: red; font-size: 20px', label: '', enabled: true, createdAt: 0 },
    ];
    expect(buildCss({ rules })).toBe('.banner-top { display: none !important; }\nh1 { color: red !important; font-size: 20px !important; }');
    expect(buildCss({ rules, paused: true })).toBe('');
  });

  it('reveals the original on hover when asked', () => {
    expect(ruleCss({ selector: '.ad', action: 'blur', revealOnHover: true })).toBe(
      '.ad { transition: opacity .15s ease, filter .15s ease !important; }\n.ad:not(:hover) { filter: blur(10px) !important; }',
    );
    // 隐藏 + 悬停显示：透明但保留位置，否则鼠标没地方悬停
    expect(ruleCss({ selector: 'div:has(a, b), .x', action: 'hide', revealOnHover: true })).toContain('div:has(a, b):not(:hover), .x:not(:hover) { opacity: 0 !important; }');
  });

  it('refuses selectors and declarations that could break out or load remote resources', () => {
    expect(isSafeSelector('div } body { display:none')).toBe(false);
    expect(isSafeSelector('a[href*="x"]')).toBe(true);
    expect(ruleCss({ selector: '.a{', action: 'hide' })).toBe('');
    expect(sanitizeDeclarations('color: red; } body { x: y; background: url(https://evil/x.png); @import "x"; width: 10px !important')).toBe(
      'color: red !important; width: 10px !important;',
    );
  });

  it('offers "just this one" and "all similar" selectors, hash-free', () => {
    const d = doc();
    const ad = d.querySelectorAll('article')[1];
    const c = selectorChoices(ad, d);
    expect(d.querySelectorAll(c.single)).toHaveLength(1);
    expect(d.querySelector(c.single)).toBe(ad);
    expect(c.similar).toBe('article[class*="_promoCard"].promo-ad');
    expect(d.querySelectorAll(c.similar!)).toHaveLength(2);
  });

  it('widening to the grid slot only targets slots that hold an ad', () => {
    const d = doc();
    const ad = d.querySelector('article')!;
    const slot = ad.parentElement!;
    const c = selectorChoices(slot, d, ad);
    expect(c.similar).toBe('div[class*="_cardCell"]:has(article[class*="_promoCard"].promo-ad)');
  });

  it('clicking inside an ad card selects the whole grid slot; clicking a banner keeps the banner', () => {
    const d = doc();
    const slot = smartTarget(d.querySelector('article p')!, d);
    expect(slot.getAttribute('class')).toBe('Xy3abC_cardCell');
    expect(selectorChoices(slot, d, d.querySelector('article p')!).similar).toBe('div[class*="_cardCell"]:has(article[class*="_promoCard"].promo-ad > p)');
    const banner = d.querySelector('.banner-top img')!;
    expect(smartTarget(banner, d)).toBe(banner);
  });

  it('round-trips declarations edited in the inspector', () => {
    const decls = parseDeclarations('font-size: 18px !important; color:#333;\nbackground: url(x.png); margin-top : 4px');
    expect(decls).toEqual([['font-size', '18px'], ['color', '#333'], ['margin-top', '4px']]);
    expect(serializeDeclarations(decls)).toBe('font-size: 18px;\ncolor: #333;\nmargin-top: 4px;');
    expect(normalizeValue('font-size', '18')).toBe('18px');
    expect(normalizeValue('opacity', '0.5')).toBe('0.5');
    expect(normalizeValue('margin-top', '0')).toBe('0');
  });

  it('describes elements in words', () => {
    const d = doc();
    expect(describeElement(d.querySelector('article')!)).toBe('推广内容');
    expect(describeElement(d.querySelector('.banner-top')!)).toBe('双十一大促');
  });
});
