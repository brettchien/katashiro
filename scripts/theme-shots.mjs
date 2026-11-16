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
  { name: "image", kind: "image", content: { dataUrl: IMAGE, caption: "A caption" } },
];

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0" style="width:1100px;height:900px;border:0;display:block"></iframe>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => { if (e.data && e.data.nonce === "nonce0") __msgs.push(e.data); });
  window.__send = (msg) => document.getElementById("f").contentWindow.postMessage({ ...msg, nonce: "nonce0" }, "*");
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__host.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(HOST); return; }
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

const browser = await launch();
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
    if (fx.media) await page.emulateMediaType(fx.media);
    await page.evaluate((m) => __send(m), { type: "render", kind: fx.kind, version: 1, seq: 1, content: fx.content, ...(fx.engine ? { engine: fx.engine } : {}) });
    await waitFor((m) => m.type === "rendered" && m.seq === 1, "rendered");
    await frame.evaluate(() => document.fonts.ready);
    // The whole document in one shot (slides keep their fixed frame).
    if (fx.kind !== "slides") {
      const h = await frame.evaluate(() => document.documentElement.scrollHeight);
      await page.evaluate((x) => { document.getElementById("f").style.height = x + "px"; }, h);
    }
    await sleep(300);
    const file = path.join(OUT, `${fx.name}.png`);
    await (await page.$("#f")).screenshot({ path: file });
    console.log(`shot ${file}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
