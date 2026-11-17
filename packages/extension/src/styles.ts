/**
 * 打包成 styles.js：在用户授权过的网站上，网页一开始加载（document_start）就运行，
 * 读出本站的样式规则并注入 CSS，所以广告不会先闪一下再消失。
 */
import { applyAndRemember, keepStylesAttached, loadSiteStyles, onSiteStylesChanged } from './style-store.ts';

const host = location.hostname;

void loadSiteStyles(host).then((site) => {
  if (!site.rules.length) return;
  applyAndRemember(site);
  keepStylesAttached();
});

onSiteStylesChanged(host, (site) => {
  applyAndRemember(site);
  if (site.rules.length) keepStylesAttached();
});
