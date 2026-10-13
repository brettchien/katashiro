#!/usr/bin/env node
// smoke-glow-ranges.mjs — canvas_patch's exact-range glow (ADR docs/adr/canvas.md §3.10, #107) in
// the real canvas frame, under the real sandbox CSP. Needs a Chrome, so it is not part of `node --test`:
//
//   npm ci && npm run chrome     # once
//   node scripts/smoke-glow-ranges.mjs      # or `npm run smoke` for all of them
//
// (CHROME / PUPPETEER_CORE override the Chrome and puppeteer-core it uses: see scripts/smoke-env.mjs.)
//
// Same harness as smoke-mermaid.mjs (a local server serves the repo, canvas-frame.html gets the
// manifest's sandbox CSP). Each case renders v1, then v2 with glowPrev + glowRanges as canvas.js
// sends them after a canvas_patch, and checks which text glows:
//   - markdown: exactly the replaced words glow (inline), not their paragraph; a heading, a list item
//     and a table cell replaced whole glow as text, their syntax untouched; a deletion marks the block
//     now standing there (at the end: the last block's bottom edge); the §3.5 normalization re-render of the same version glows the same text;
//   - slides: the changed words on their slide, not the whole slide;
//   - a mermaid fence patched: the diagram's figure glows whole;
//   - ranges that do not fit the text: the block diff glows instead (whole changed blocks).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = (await import("node:module")).createRequire(import.meta.url);
const CanvasStore = require("../canvas-store.js");

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const HOST = `<!doctype html><meta charset="utf-8"><body>
<iframe id="f" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0" style="width:1000px;height:900px;border:0"></iframe>
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

const browser = await launch();
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);
const check = (cond, msg, got) => (cond ? ok(msg) : fail(`${msg}: ${JSON.stringify(got)}`));

const MD1 = `# Plan

Intro with an old word in it.

## Steps

- first step
- second step

| name | value |
|------|-------|
| a    | 1     |

Doomed paragraph.

Last paragraph.

\`\`\`mermaid
flowchart LR
  A --> B
\`\`\`
`;
const SL1 = "# One\n\nalpha beta\n\n---\n\n# Two\n\ngamma delta\n";

try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
  const waitFor = async (pred, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const found = (await page.evaluate(() => window.__msgs)).find(pred);
      if (found) return found;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await waitFor((m) => m.type === "ready", "ready");
  const frame = page.frames().find((f) => f.url().endsWith("#nonce0"));
  let seq = 0;
  const render = async (msg) => {
    const s = ++seq;
    await page.evaluate((m) => __send(m), { type: "render", seq: s, ...msg });
    await waitFor((m) => m.type === "rendered" && m.seq === s, `render ${s}`);
  };
  const glowing = () => frame.evaluate(() => ({
    ranges: Array.from(document.querySelectorAll(".ks-range.ks-changed"), (e) => e.textContent),
    blocks: Array.from(document.querySelectorAll(".ks-changed:not(.ks-range)"), (e) => `${e.tagName.toLowerCase()}:${e.textContent.trim().slice(0, 30)}`),
    removed: Array.from(document.querySelectorAll(".ks-removed-before"), (e) => `${e.tagName.toLowerCase()}:${e.textContent.trim().slice(0, 30)}`),
  }));
  // The ranges come from the store's own planPatch, as canvas_patch stores them.
  const patch = (text, edits) => { const p = CanvasStore.planPatch(text, edits); if (!p.ok) throw new Error(p.message); return p; };

  // 1. markdown
  await render({ kind: "markdown", version: 1, content: MD1 });
  const p = patch(MD1, [
    { find: "old word", replace: "new phrase" },
    { find: "## Steps", replace: "## Next steps" },
    { find: "- second step", replace: "- second step, revised" },
    { find: "| 1     |", replace: "| 42    |" },
    { find: "Doomed paragraph.\n\n", replace: "" },
  ]);
  await render({ kind: "markdown", version: 2, content: p.text, glowPrev: true, glowRanges: p.ranges });
  const g = await glowing();
  check(JSON.stringify(g.ranges) === JSON.stringify(["new phrase", "Next steps", "second step, revised", "42"]), "markdown: exactly the replaced text glows, inline (heading, list item, table cell included)", g);
  check(g.blocks.length === 0, "markdown: no whole block glows", g);
  check(JSON.stringify(g.removed) === JSON.stringify(["p:Last paragraph."]), "markdown: a deleted paragraph marks the block now in its place", g);
  // §3.5: the normalization re-render of the same version keeps the same exact glow
  await render({ kind: "markdown", version: 2, content: p.text.replace("- first", "* first").replace("- second", "* second") });
  const g2 = await glowing();
  check(JSON.stringify(g2.ranges) === JSON.stringify(g.ranges), "markdown: the normalization re-render glows the same text", g2);

  // A deletion at the very end: the last block keeps a marker on its bottom edge.
  await render({ kind: "markdown", version: 21, content: "Keep this.\n\nDrop this.\n" });
  const pe = patch("Keep this.\n\nDrop this.\n", [{ find: "\n\nDrop this.", replace: "" }]);
  await render({ kind: "markdown", version: 22, content: pe.text, glowPrev: true, glowRanges: pe.ranges });
  const ge = await glowing();
  const after = await frame.evaluate(() => Array.from(document.querySelectorAll(".ks-removed-after"), (e) => e.textContent.trim()));
  check(ge.ranges.length === 0 && ge.blocks.length === 0 && JSON.stringify(after) === JSON.stringify(["Keep this."]), "markdown: a deletion at the end marks the bottom of the last block", { ...ge, after });

  // 2. a patched mermaid fence: the figure glows whole (its SVG is not the source text)
  const p3 = patch(p.text, [{ find: "A --> B", replace: "A --> C" }]);
  await render({ kind: "markdown", version: 3, content: p3.text, glowPrev: true, glowRanges: p3.ranges });
  await frame.waitForSelector("#doc figure.ks-mermaid svg", { timeout: 20000 });
  await render({ kind: "markdown", version: 4, content: p3.text.replace("A --> C", "A --> D"), glowPrev: true, glowRanges: patch(p3.text, [{ find: "A --> C", replace: "A --> D" }]).ranges });
  const g3 = await glowing();
  check(g3.ranges.length === 0 && g3.blocks.length === 1 && g3.blocks[0].startsWith("figure:"), "mermaid fence: the diagram glows whole", g3);

  // 3. ranges that do not fit the text (stale): the block diff instead
  await render({ kind: "markdown", version: 5, content: "Alpha\n\nBeta\n" });
  await render({ kind: "markdown", version: 6, content: "Alpha\n\nGamma\n", glowPrev: true, glowRanges: [{ start: 100, end: 120 }] });
  const g4 = await glowing();
  check(g4.ranges.length === 0 && JSON.stringify(g4.blocks) === JSON.stringify(["p:Gamma"]), "stale ranges: the changed block glows (block diff)", g4);
} catch (e) {
  fail(e && e.stack || String(e));
}

// 4. slides, in a fresh frame (a frame shows one kind)
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
  const until = async (pred) => { for (let i = 0; i < 400; i++) { if ((await page.evaluate(() => window.__msgs)).some(pred)) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error("timed out"); };
  await until((m) => m.type === "ready");
  const frame = page.frames().find((f) => f.url().endsWith("#nonce0"));
  await page.evaluate((c) => __send({ type: "render", kind: "slides", version: 1, seq: 1, content: c }), SL1);
  await until((m) => m.type === "rendered" && m.seq === 1);
  const p = CanvasStore.planPatch(SL1, [{ find: "delta", replace: "epsilon" }]);
  await page.evaluate((m) => __send(m), { type: "render", kind: "slides", version: 2, seq: 2, content: p.text, glowPrev: true, glowRanges: p.ranges });
  await until((m) => m.type === "rendered" && m.seq === 2);
  const g = await frame.evaluate(() => ({
    ranges: Array.from(document.querySelectorAll(".ks-range.ks-changed"), (e) => e.textContent),
    sections: document.querySelectorAll("section.ks-changed").length,
  }));
  check(JSON.stringify(g.ranges) === JSON.stringify(["epsilon"]) && g.sections === 0, "slides: the changed word glows, not its whole slide", g);
  await page.close();
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nglow-ranges smoke test passed");
process.exit(failures.length ? 1 : 0);
