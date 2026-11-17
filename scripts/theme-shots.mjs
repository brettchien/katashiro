#!/usr/bin/env node
// theme-shots.mjs — screenshot fixed canvas fixtures in the real canvas frame, so a CSS refactor can
// be checked pixel for pixel against main (ADR docs/adr/canvas-themes.md, "dark byte-identical").
// Not a smoke (no checks of its own): CI's theme-shots job runs it twice and compares the PNGs.
//
//   node scripts/theme-shots.mjs <outdir> [<root>]
//
// <root> is the checkout whose canvas-frame.html / src/ / vendor/ are served (default: this repo), so
// the same script shoots a `git worktree` of origin/main for the baseline. Chrome and puppeteer-core
// come from THIS repo (scripts/lib/smoke-env.mjs), pinned — both runs use the same browser.
// Fixed viewport, animations off, one PNG per fixture (and per engine for diagrams, and per media
// for print): <outdir>/<name>.png.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/smoke-env.mjs";

const OUT = process.argv[2];
const ROOT = path.resolve(process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
if (!OUT) { console.error("usage: theme-shots.mjs <outdir> [<root>]"); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });

// Every existing block kind (canvas.md §3.3 / §3.4): headings, inline marks, lists, task list, table,
// code, quote, callouts (GitHub + emoji), cards, definition list, footnote, a diagram.
const MARKDOWN = `# Theme fixture

A paragraph with **bold**, *italic*, \`code\`, ==highlight==, ++underline++, ~~strike~~, a [link](https://example.com) and a footnote[^1].

## Lists

- one
- two
  - nested
1. first
2. second
- [x] done
- [ ] open

## Table

| plan | price | note |
|---|--:|---|
| spot | $1 | can be reclaimed |
| on-demand | $3 | steady |

## Code

\`\`\`js
// a comment
const x = { a: 1, b: "two" };
function f(y) { return y * 2; }
\`\`\`

> A plain quote.

> [!NOTE]
> Useful information.

> [!TIP]
> A tip.

> [!IMPORTANT]
> Crucial.

> [!WARNING]
> Careful.

> [!CAUTION]
> Dangerous.

> ⚠️ An emoji callout.

::: cards
### Spot
Cheap, can be reclaimed.
### On-demand
Steady.
### Savings plan
Committed.
:::

Term
: Its definition.

## Diagram

\`\`\`mermaid
flowchart LR
  A[Agent] -->|asks| B{Gateway}
  B --> C[(Store)]
  B -.-> D[Browser]
\`\`\`

---

[^1]: The footnote text.
`;

// The briefing blocks (canvas-themes §2.4), one section each as they land.
const BLOCKS = `# Briefing blocks

::: stats
- **3** 天
- **42** 場
- **9** 家公司
:::

## Accent cards

::: cards accent
### Card 1\nOrange.\n### Card 2\nBlue.\n### Card 3\nPurple.\n### Card 4\nGreen.\n### Card 5\nYellow.\n### Card 6\nPink.\n### Card 7\nTeal.\n### Card 8\nSand.\n### Card 9\nSlate.
:::

A new block restarts the order:

::: cards accent
### Card 1
Orange.
### Card 2
Blue.
:::

## Matrix

::: matrix
| Day | 場次 | 信任 | 工廠 | 記憶 | 提及 / 18 |
|---|---|:-:|:-:|:-:|---|
| D1 | Keynote | ● | ○ |  | 5/18 |
| D1 | Panel | ◐ | ● | ● | 12/18 |
| D2 | Workshop |  | ● | ○ | 3/18 |
| **合計** | | 2 (1●) | 3 (2●) | 2 (1●) | |
:::
`;

const MERMAID = `sequenceDiagram
  participant U as User
  participant K as Katashiro
  participant A as Agent
  U->>K: prompt
  K->>A: session/prompt
  A-->>K: canvas_write
  K-->>U: canvas
`;

const SLIDES = `# Deck

---

## Options

::: cards
### Spot
Cheap.
### On-demand
Steady.
:::

---

## Prices

| plan | price |
|---|--:|
| spot | $1 |
| on-demand | $3 |
`;

// 4×3 two-colour PNG: deterministic bytes, no file in the repo.
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAGElEQVR4nGN4VqHxrEJDI++ORt4dBpwcAF0yEdFkPHH3AAAAAElFTkSuQmCC";

const FIXTURES = [
  { name: "markdown-pele", kind: "markdown", engine: "pele", content: MARKDOWN },
  { name: "markdown-mermaid", kind: "markdown", engine: "mermaid", content: MARKDOWN },
  { name: "markdown-print", kind: "markdown", engine: "pele", content: MARKDOWN, media: "print" },
  { name: "diagram-pele", kind: "mermaid", engine: "pele", content: MERMAID },
  { name: "diagram-mermaid", kind: "mermaid", engine: "mermaid", content: MERMAID },
  { name: "slides", kind: "slides", content: SLIDES },
  { name: "slides-2", kind: "slides", content: SLIDES, slide: 1 },
  { name: "image", kind: "image", content: { dataUrl: IMAGE, caption: "A caption" } },
  { name: "blocks", kind: "markdown", engine: "pele", content: BLOCKS },
];
// The same under the light theme (canvas-themes §2.2: the host sends {type:"theme"}; a deck stays dark).
for (const fx of FIXTURES.filter((x) => !x.media && x.kind !== "slides")) FIXTURES.push({ ...fx, name: `${fx.name}-light`, theme: "light" });

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0" style="width:1100px;height:900px;border:0;display:block"></iframe>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => { if (e.data && e.data.nonce === "nonce0") __msgs.push(e.data); });
  window.__send = (msg) => document.getElementById("f").contentWindow.postMessage({ ...msg, nonce: "nonce0" }, "*");
</script>`;
// The extension pages (canvas.html's header, the gallery) with the chrome.* they read stubbed in memory
// (as scripts/smoke-ask-popover.mjs). Fixed past timestamps, so the time labels do not move.
const ID = "cv_0123456789ab";
const AT = Date.UTC(2026, 0, 15, 9, 30);
const STUB = `(() => {
  const data = {
    "canvas:${ID}:meta": { id: "${ID}", title: "Theme fixture", kind: "markdown", version: 4, agentVersion: 4, author: "agent", conversationId: "c_0123456789ab", normalized: true, createdAt: ${AT}, updatedAt: ${AT} },
    "canvas:${ID}:latest": ${JSON.stringify(MARKDOWN)},
    "canvas:cv_0123456789ac:meta": { id: "cv_0123456789ac", title: "Deck", kind: "slides", version: 1, author: "agent", conversationId: "c_0123456789ab", createdAt: ${AT - 864e5}, updatedAt: ${AT - 864e5} },
    "conv:index": {
      c_0123456789ab: { title: "Plan chat", createdAt: ${AT - 2 * 864e5}, lastMessageAt: ${AT} },
      c_0123456789ac: { title: "Archived chat", createdAt: ${AT - 9 * 864e5}, lastMessageAt: ${AT - 5 * 864e5}, archivedAt: ${AT - 4 * 864e5} },
    },
  };
  const ev = () => ({ addListener() {}, removeListener() {} });
  const pick = (keys) => { const out = {}; for (const k of keys == null ? Object.keys(data) : [].concat(keys)) if (k in data) out[k] = data[k]; return out; };
  window.chrome = {
    runtime: { id: "stub", getURL: (p) => location.origin + "/" + p, onMessage: ev(), lastError: undefined, sendMessage: async () => undefined },
    storage: { local: { get: async (k) => pick(k), set: async (o) => { Object.assign(data, o); }, remove: async () => {} }, session: { get: async () => ({}), set: async () => {} }, onChanged: ev() },
    tabs: { query: async () => [], getCurrent: (cb) => { const t = { id: 1, windowId: 3, index: 0 }; if (cb) cb(t); return Promise.resolve(t); }, onRemoved: ev(), onUpdated: ev(), onAttached: ev(), create: async () => ({}), update: async () => ({}), remove: async () => {} },
    windows: { getAll: async () => [], update: async () => ({}), onRemoved: ev() },
    sidePanel: { open: async () => {} },
  };
})();`;
// 跟隨系統 (no setting stored): the OS appearance decides, so each page is shot both ways.
const PAGES = [
  { name: "page-canvas", path: `/canvas.html?id=${ID}`, scheme: "dark" },
  { name: "page-gallery", path: "/canvas-gallery.html", scheme: "dark" },
  { name: "page-canvas-light", path: `/canvas.html?id=${ID}`, scheme: "light" },
  { name: "page-gallery-light", path: "/canvas-gallery.html", scheme: "light" },
];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__host.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(HOST); return; }
  if (url.pathname === "/__stub.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(STUB); return; }
  if (url.pathname === "/canvas.html" || url.pathname === "/canvas-gallery.html") {
    const html = fs.readFileSync(path.join(ROOT, url.pathname), "utf8");
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html.replace('<script src="src/core/canvas-store.js">', '<script src="__stub.js"></script><script src="src/core/canvas-store.js">'));
    return;
  }
  const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const headers = { "content-type": TYPES[path.extname(file)] || "application/octet-stream" };
  if (url.pathname === "/canvas-frame.html") headers["content-security-policy"] = sandboxCsp;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A full repaint before a shot: the viewport one pixel wider and back makes Chrome lay out and raster
// the whole page again. Without it the bytes depended on timing — a page whose last paint was partial
// (only the header, say) anti-aliases a few edge pixels ±1 differently from a full paint, and that
// alone made the same commit differ from itself (page-canvas-light on main, bb89b2f).
async function fullRepaint(page) {
  const vp = page.viewport();
  await page.setViewport({ ...vp, width: vp.width + 1 });
  await page.setViewport(vp);
  await sleep(200);
}

// Deterministic raster: the same page must give the same bytes on every launch. Without these the
// header buttons' rounded corners came out ±1–2 differently now and then (1 run in 3 on CI): software
// raster on one thread, no partial raster, every compositor stage before a frame, a fixed colour
// profile, grayscale text without hinting.
const DETERMINISTIC = [
  "--disable-gpu", "--num-raster-threads=1", "--disable-partial-raster", "--run-all-compositor-stages-before-draw",
  "--force-color-profile=srgb", "--disable-skia-runtime-opts", "--disable-lcd-text", "--font-render-hinting=none",
];
const browser = await launch(DETERMINISTIC);
let failed = 0;
try {
  for (const fx of FIXTURES) {
    // A fresh page per fixture: no state (engine loaded, Reveal, scroll) leaks into the next shot.
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => { console.log(`FAIL ${fx.name}: page error: ${e.message}`); failed++; });
    await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
    const waitFor = async (pred, what, ms = 30000) => {
      const end = Date.now() + ms;
      for (;;) {
        const found = (await page.evaluate(() => window.__msgs)).find(pred);
        if (found) return found;
        if (Date.now() > end) throw new Error(`${fx.name}: timed out waiting for ${what}`);
        await sleep(50);
      }
    };
    await waitFor((m) => m.type === "ready", "ready");
    const frame = page.frames().find((f) => f.url().endsWith("#nonce0"));
    await frame.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
    if (fx.theme) await page.evaluate((v) => __send({ type: "theme", value: v }), fx.theme);
    // Print: what the frame does before the paper (beforeprint → light theme), then print media.
    if (fx.media === "print") await frame.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    if (fx.media) await page.emulateMediaType(fx.media);
    await page.evaluate((m) => __send(m), { type: "render", kind: fx.kind, version: 1, seq: 1, content: fx.content, ...(fx.engine ? { engine: fx.engine } : {}) });
    await waitFor((m) => m.type === "rendered" && m.seq === 1, "rendered");
    await frame.evaluate(() => document.fonts.ready);
    if (fx.slide) await frame.evaluate((i) => Reveal.slide(i), fx.slide);
    // The whole document in one shot (slides keep their fixed frame).
    if (fx.kind !== "slides") {
      const h = await frame.evaluate(() => document.documentElement.scrollHeight);
      await page.evaluate((x) => { document.getElementById("f").style.height = x + "px"; }, h);
    }
    await sleep(300);
    await fullRepaint(page);
    const file = path.join(OUT, `${fx.name}.png`);
    await (await page.$("#f")).screenshot({ path: file });
    console.log(`shot ${file}`);
    await page.close();
  }
  for (const pg of PAGES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 1 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: pg.scheme }]);
    page.on("pageerror", (e) => { console.log(`FAIL ${pg.name}: page error: ${e.message}`); failed++; });
    await page.goto(`${origin}${pg.path}`, { waitUntil: "networkidle0" });
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}" });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await sleep(1500);                     // the canvas frame renders after the page's load
    await fullRepaint(page);
    // Settled: two shots in a row the same (a late repaint must not decide the bytes).
    const file = path.join(OUT, `${pg.name}.png`);
    let prev = await page.screenshot();
    for (let i = 0; i < 5; i++) {
      await sleep(300);
      const next = await page.screenshot();
      if (Buffer.compare(Buffer.from(prev), Buffer.from(next)) === 0) break;
      console.log(`${pg.name}: still changing (${i + 1})`);
      prev = next;
    }
    fs.writeFileSync(file, prev);
    console.log(`shot ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
