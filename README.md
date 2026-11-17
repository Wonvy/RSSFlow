# RSSFlow

**English** | [简体中文](README.zh-CN.md)

**Turn any web page into an RSS feed with one click — and hide the ads while you're at it.**

RSSFlow is a browser extension plus a small server. It does two things:

1. **Web page → RSS.** Many sites have no feed. Install the extension, click any entry in a list, and you get a feed URL for any RSS reader. Recipes can be shared with others.
2. **Hide / restyle page elements.** Click an ad or anything else you don't want to see, then hide, blur or dim it — or restyle it the way you would in the browser's developer tools. Rules are saved per site and apply every time you open it.

No CSS, APIs or JSON knowledge needed. The interface is available in English and Simplified Chinese.

```
[Extension: pick a list, build a recipe] → [Server: fetch on a schedule, serve RSS] → any RSS reader
                                                   ↓
                                       [Recipe gallery: share / reuse]
```

## Contents

- [Features](#features)
- [Getting started](#getting-started)
- [Project layout and commands](#project-layout-and-commands)
- [Developer tools](#developer-tools)
- [Configuration](#configuration-environment-variables)
- [Recipe format](#recipe-format)
- [API](#api)
- [Adding a language](#adding-a-language)
- [Known limitations](#known-limitations)
- [Paused features](#paused-features)

## Features

### Web page → RSS

- **One click finds the whole list.** RSSFlow finds all entries of the same kind and works out the title, link, date, image, summary and author.
  - Clicking an ad card, or the gap between cards, still finds the right list.
  - Masonry layouts that split one list across several containers are merged.
  - Hashed class names from CSS Modules (like `Kx7pQa_title`) become selectors that survive redeploys (`[class*="_title"]`).
  - If a guess is wrong, you can re-pick any field or widen / narrow the list.
- **Recovers links that aren't `<a>` tags.** Many cards navigate with JavaScript and only contain an author link. RSSFlow skips author and avatar links and finds each entry's URL in the page's embedded data (JSON, Next.js flight data, …) by its title. Lists mixing several kinds of content (e.g. works and articles) are handled too.
- **Data API sniffing.** While you pick, RSSFlow watches the page's fetch / XHR requests. If a JSON response matches the list you clicked, the feed uses that API instead: more reliable, lighter, and it usually has exact publish times the page doesn't show.
  - Fields (title, link, date, image, summary, author, categories) are mapped automatically.
  - Paging parameters are reset to page 1.
  - Personal credentials in the API URL (token, sign, …) are removed before saving, so sharing a recipe never leaks a login.
  - If the page has no dates, click "Find the data API for me": the extension clicks "Next page / Load more" once to discover the API.
  - If the API stops working, the server falls back to parsing the page.
- **Dynamic pages.** The server tries the data API, then a plain fetch, then a headless browser (Playwright) — all automatically.
- **Sensible order without dates.** The server remembers when each entry was first seen and uses that as its publish time.
- **Dates in Chinese and English.** `2026年11月17日`, `3小时前`, `昨天 08:00`, `Nov 15, 2026`, ISO 8601 and more, interpreted in the site's time zone (guessed from the domain and page language).
- **Bot-check pages are recognized.** Slider CAPTCHAs, Cloudflare checks and similar pages produce a clear message and the last good content is kept. RSSFlow does **not** try to bypass them.
- **Hotlink-protected images.** Feed images carry `referrerpolicy="no-referrer"`.
- **Sharing.** Public recipes appear in the recipe gallery, where anyone can copy the feed URL or download the recipe JSON.
- **RSS 2.0 and JSON Feed**, with `dc:creator` and `category`; the server has caching, rate limiting and SSRF protection.

### Hide / restyle page elements (ad blocking)

- **Click to preview.** Choose "Hide / restyle page elements" in the extension popup and click an ad on the page. You see the effect immediately and save only if you like it.
- **Quick actions:** hide, blur or dim — just this element, or all similar ones.
- **Selects the whole card.** If you click a line of text or an image inside a card, the whole card is selected, so hiding it leaves no empty slot. "All similar" builds rules like "grid slots that contain this kind of ad" instead of hiding every slot.
- **Style editor**, like the browser's developer tools, with live preview:
  - a blue outline on the page with the tag and size, e.g. `div.card · 320 × 240`;
  - a breadcrumb (`… › div.grid › div.slot › article`) to select any level;
  - an editable box model (margin, border, padding on all four sides);
  - common properties grouped by layout, text, background & border and effects, with color pickers and sliders; plain numbers get `px` added;
  - the element's attributes, and every computed style (hundreds, searchable and editable);
  - changed values are highlighted and can be reset one by one or all at once; the generated CSS can be edited directly.
- **Show the original on hover.** Elements are hidden / blurred / dimmed normally and shown as they are while the mouse is over them.
- **Applies on every visit.** Rules are stored per site in the browser. `styles.js` (about 4 KB) injects the CSS as the page starts loading, so ads don't flash in first; elements added later are covered too.
- **Per-site permissions.** The browser asks for permission the first time you use this on a site, instead of requesting access to every site at install time.
- **Manageable.** Pause all rules for a site from the popup or the panel, toggle or delete single rules.
- **Safe.** Selectors and custom CSS are checked: they can't break out of their rule or load external resources (`url()`, `@import`, … are removed).

### General

- **Draggable panels.** Drag the title bar (⋮⋮) anywhere; the position is remembered and the panel can't be dragged off screen. "⇆" puts it back in a corner.
- **Pause picking** when you need to use the page first (close a pop-up, go to the next page).
- **Multilingual.** The extension, web pages and error messages are in English and Chinese; see [Adding a language](#adding-a-language).

## Getting started

Requires Node.js 22.13 or newer (24 recommended).

```bash
npm install
```

```bash
npx playwright install chromium
```

```bash
npm run dev
```

The server runs at http://localhost:8787. In development mode it also serves demo pages:

| Page | Shows |
|---|---|
| `/demo/news.html` | A plain static news list |
| `/demo/dynamic.html` | Content loaded by JavaScript |
| `/demo/card-feed.html` | A design-community style card feed: hashed classes, an ad card, links only in embedded data |
| `/demo/api-feed.html` | Cards loaded from a data API with "Load more" (add `?ssr=1` to simulate a first page rendered into the HTML) |

### Install the browser extension

1. Open `chrome://extensions` (Edge: `edge://extensions`) and turn on Developer mode.
2. Click "Load unpacked" and choose `packages/extension/dist`.
3. Open any page and click the RSSFlow icon:
   - **Make a feed:** click "Pick a list on this page" (or press `Alt+Shift+R`), click an entry in the list, check the preview, then "Create RSS feed link".
   - **Block ads:** click "Hide / restyle page elements", allow RSSFlow to change this site, then click the element.

The extension talks to `http://localhost:8787` by default; change it at the bottom of the popup to use your own server. After changing code, run `npm run build:ext` and click "Reload" on the extensions page.

## Project layout and commands

| Directory | Contents |
|---|---|
| `packages/core` | Shared core: list detection, field extraction, API matching, date parsing, style rules, recipe validation, i18n. The browser and the server run the same code |
| `packages/server` | Server: API, static / browser fetching, RSS output, recipe gallery. Uses Node's built-in SQLite, no native dependencies |
| `packages/extension` | Browser extension (Manifest V3): picker panel, style panel, network sniffer, popup, background script |

| Command | What it does |
|---|---|
| `npm run dev` | Build the extension, then start the dev server (restarts on changes) |
| `npm start` | Start the server for production |
| `npm run build:ext` | Build the extension into `packages/extension/dist` |
| `npm test` | Run the tests (core + server end-to-end, including browser rendering) |
| `npm run typecheck` | TypeScript type check |

## Developer tools

**Server view** (development mode only): open the URL below to see the page as the server fetched it, with the picker injected. The page's own scripts are disabled but their data is kept. Add `#rssflow=style` to open the style panel instead.

```
http://localhost:8787/dev/view?url=https://example.com/
```

**try-site** opens a page in a headless browser, injects the picker, clicks an entry, prints what was detected and takes a screenshot.

```bash
node packages/server/scripts/try-site.ts https://example.com/news "some text from one headline"
```

- The second argument can be text inside an entry, or `css:selector` (useful for feeds that change on every load).
- `--via-server` opens the page through the server view, for sites that block headless browsers.
- `--create` also saves the recipe on the local server and prints what the server fetched.
- `--scroll N` scrolls down N screens first, for infinite-scroll pages.

**try-detail** shows what can be extracted from one entry page and writes a preview HTML file.

```bash
node packages/server/scripts/try-detail.ts "https://example.com/article/123"
```

```bash
node packages/server/scripts/try-detail.ts ~/Downloads/page.html --url "https://example.com/article/123"
```

- With a URL it fetches the page the way the server does and reports bot checks.
- With a local file ("Save as → Web page, HTML only" in your browser) it works offline; `--url` gives the original address so images and links resolve.

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Listen address; set `HOST=0.0.0.0` to serve others |
| `RSSFLOW_PUBLIC_URL` | from the request | Public base URL used in feed links, e.g. `https://rss.example.com` |
| `RSSFLOW_DATA_DIR` | `./data` | Where the SQLite database lives |
| `RSSFLOW_ALLOW_PRIVATE` | off | Allow fetching private / intranet addresses. **Never** turn on for a public server |
| `RSSFLOW_MIN_REFRESH` | `10` | Minimum refresh interval (minutes) |
| `RSSFLOW_RENDER_CONCURRENCY` | `2` | Concurrent headless-browser renders |
| `RSSFLOW_WRITE_RATE` | `30` | Write requests per IP per minute |
| `ANTHROPIC_API_KEY` | unset | For AI summaries (see [Paused features](#paused-features)) |
| `RSSFLOW_AI` / `RSSFLOW_AI_MODEL` / `RSSFLOW_AI_MAX_PER_HOUR` | auto / `claude-opus-5-5` / `200` | AI summary switch, model and hourly cap |

## Recipe format

```json
{
  "version": 1,
  "name": "Example news",
  "url": "https://news.example.com/list",
  "mode": "auto",
  "itemSelector": "li.news-item",
  "fields": {
    "title":   { "selector": "h3" },
    "link":    { "selector": "h3 > a", "attr": "href" },
    "date":    { "selector": "span.time" },
    "image":   { "selector": "img", "attr": "src" },
    "summary": { "selector": "p.desc" },
    "author":  { "selector": "span.author" }
  },
  "refreshMinutes": 60,
  "utcOffset": 480
}
```

- `mode`: `auto` (data API first if there is one, then a plain fetch, then a browser), `static`, `render`, or `api` (API only).
- `selector` is relative to the entry element; an empty string means the entry itself.
- Without `attr` the text is used; `href` and `src` are made absolute, and `src` understands lazy-loading attributes such as `data-src`.
- Links can come from embedded page data: `"link": { "selector": "", "from": "data", "prefixes": ["https://example.com/work/", "https://example.com/article/"] }` finds, after each title, the first URL starting with one of these prefixes.
- `api` (optional) describes a data API. `listPath` is where the list is in the JSON; each field is a template: `{content.title}` reads that path, and templates can build URLs such as `https://example.com/p/{slug}.html`. `tags` may list several paths separated by commas.

```json
"api": {
  "url": "https://example.com/api/feed?page=1&size=20",
  "method": "GET",
  "listPath": "data.list",
  "fields": {
    "title": "{title}",
    "link": "{url}",
    "date": "{published_at}",
    "image": "{cover}",
    "author": "{author.name}",
    "tags": "{category},{sub_category}"
  }
}
```

## API

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Server status |
| `POST` | `/api/preview` | `{ recipe }` → test-fetch without saving |
| `POST` | `/api/recipes` | `{ recipe, public }` → save; returns the feed URL and an `editToken` |
| `GET` | `/api/recipes?q=` | Public recipes |
| `GET` | `/api/recipes/:id` | One recipe (`?download=1` downloads the JSON) |
| `PUT` / `DELETE` | `/api/recipes/:id` | Update or delete; needs the `x-edit-token` header |
| `GET` | `/feed/:id.xml` / `/feed/:id.json` | RSS 2.0 / JSON Feed |

Errors follow the `Accept-Language` header or the `?lang=` parameter and look like `{ "error": "...", "code": "err.xxx" }`.

## Adding a language

1. Copy `packages/core/src/i18n/en.ts` to a new file such as `ja.ts` and translate it. Partial translations are fine; missing strings fall back to English.
2. Add `ja: { name: '日本語', messages: ja }` to `LOCALES` in `packages/core/src/i18n/index.ts`.
3. For the extension store listing, also add `packages/extension/public/_locales/ja/messages.json`.

The popup, panels, gallery pages and API errors pick up the new language automatically. Language choice: the user's own setting, then the browser language, then English.

## Known limitations

- Recommendation feeds are personalized; a feed shows what an anonymous visitor (the server) sees.
- Content behind a login can't be fetched. Sites with CAPTCHAs are reported, never bypassed.
- Data APIs that need a login or a request signature can't be used by the server (credentials are removed); RSSFlow falls back to parsing the page.
- API sniffing sees requests made after the panel opens, plus earlier GET requests. Earlier POST requests (e.g. GraphQL) need to happen again after the panel opens, for example by going to the next page.
- Hotlink-protected images may still break in the few readers that rewrite HTML.

## Paused features

The code and tests for these are kept, but they are hidden in the picker. To bring them back, set `DETAIL_FEATURE` to `true` in `packages/extension/src/content.ts` and rebuild the extension.

- **Entry pages:** open each entry's own page to add a summary, full text, author, tags and an exact publish time; image-heavy pages yield all their content images in order. Entry pages are cached per URL, at most 15 new ones are fetched per refresh, and URL patterns that hit bot checks are skipped.
- **AI summaries:** with Anthropic credentials on the server (`ANTHROPIC_API_KEY`), Claude writes a 2–3 sentence summary from the full text. Each link is summarized once, there is an hourly cap, and page text is treated strictly as material to summarize, never as instructions.
- Known issue: some pages leave an undecoded `&amp;` in summaries and image URLs; fix this before turning the feature back on.

## Roadmap

- **AI fallback:** build a recipe from just a URL, and repair selectors when a site changes
- **Recipe import** from other RSSFlow servers; sharing style (ad-blocking) rules too
- Keyword filters, push to Telegram or email
- Publish to the Chrome, Edge and Firefox extension stores
