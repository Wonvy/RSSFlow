/** 一个字段怎么从「条目」元素里取值 */
export interface FieldRule {
  /** 相对于条目元素的 CSS 选择器；空字符串表示条目元素本身 */
  selector: string;
  /** 读取方式：不填/`text` 取文本，`href`/`src` 取链接（自动补全为绝对地址），其它为任意属性名 */
  attr?: string;
  /**
   * `data`：不从 DOM 取值，而是到页面内嵌数据（<script> 里的 JSON 等）中，
   * 找条目标题后面第一个以 `prefixes` 之一开头的网址。用于卡片没有 <a> 链接的网站。
   * 一个列表里可能混着不同类型的内容（如作品 /work/ 和文章 /article/），所以前缀可以有多个。
   */
  from?: 'data';
  prefixes?: string[];
}

export type FieldName = 'title' | 'link' | 'date' | 'image' | 'summary' | 'author';

export interface RecipeFields {
  title: FieldRule;
  link?: FieldRule;
  date?: FieldRule;
  image?: FieldRule;
  summary?: FieldRule;
  author?: FieldRule;
}

export type FetchMode = 'auto' | 'static' | 'render' | 'api';

/** 网站自己的数据接口（JSON） */
export interface ApiSource {
  url: string;
  method?: 'GET' | 'POST';
  /** POST 请求体 */
  body?: string;
  contentType?: string;
  /** 列表在 JSON 里的路径，例如 `datas`、`data.list`；空字符串表示根节点就是数组 */
  listPath: string;
  /** 字段模板：`{content.title}` 取值，`https://x.com/p/{id}.html` 拼网址 */
  fields: { title: string; link?: string; date?: string; image?: string; summary?: string; author?: string;
    /** 分类/标签，可以写多个，用英文逗号分隔，如 `{cate},{subCate}` */
    tags?: string };
}

/** 规则（Recipe）：可以分享、复用的「网页 → RSS」转换说明 */
export interface Recipe {
  version: 1;
  name: string;
  description?: string;
  /** 要抓取的网页地址 */
  url: string;
  /**
   * auto：有数据接口时先用接口，再静态抓取，最后浏览器渲染；
   * static：只静态；render：总是浏览器渲染；api：只用数据接口
   */
  mode: FetchMode;
  /** 匹配每一条内容的 CSS 选择器 */
  itemSelector: string;
  fields: RecipeFields;
  /** 选取时嗅探到的数据接口（可选）。网页字段始终保留，接口失效时作为后备 */
  api?: ApiSource;
  /** 是否打开每条内容的详情页，抓取正文、摘要、作者、标签和准确的发布时间 */
  detail?: { enabled: boolean };
  /** 用 AI 根据详情页正文写摘要（需要同时开启 detail，服务器需配置 Anthropic 凭证） */
  ai?: { summary: boolean };
  /** 刷新间隔（分钟） */
  refreshMinutes?: number;
  /** 网站时间所在时区相对 UTC 的分钟数（东八区为 480），用于解析没有时区的时间 */
  utcOffset?: number;
}

export interface FeedItem {
  title: string;
  link?: string;
  /** ISO 8601 */
  date?: string;
  /** 原始时间文本 */
  dateText?: string;
  image?: string;
  summary?: string;
  author?: string;
  tags?: string[];
  /** 详情页正文（已清理过的 HTML） */
  contentHtml?: string;
  /** 摘要是否由 AI 生成 */
  aiSummary?: boolean;
}
