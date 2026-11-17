/** 样式面板用的「智能选中」：单独放一个文件，免得页面加载时运行的 styles.js 带上列表识别算法 */
import { findListCandidates } from './detect.ts';

/**
 * 用户点中的往往只是广告卡片里的一行字或一张图。如果它位于一个重复列表（作品流、新闻列表）的某一项里，
 * 默认选中整项，隐藏后不会留下空白格子；不在列表里（比如顶部横幅）就保持原样。
 */
export function smartTarget(clicked: Element, doc: ParentNode): Element {
  const cands = findListCandidates(clicked, doc).filter((c) => c.depth >= 0 && c.depth <= 8 && c.items.length >= 3);
  // 最靠近点击位置、又真的是「内容条目」的那一层（得分最高的候选）
  const best = cands.sort((a, b) => b.score - a.score)[0];
  const item = best?.items.find((i) => i.contains(clicked)) ?? (best && best.item.contains(clicked) ? best.item : undefined);
  return item ?? clicked;
}

