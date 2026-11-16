#!/usr/bin/env node
// smoke-blocks.mjs — the briefing blocks (ADR docs/adr/canvas-themes.md §2.4) in the real canvas frame,
// under the real sandbox CSP and the real DOMPurify, in both themes, and through Milkdown (§3.5 of
// canvas.md): every block must survive normalization and an editor load + save unchanged. Needs a
// Chrome, so it is not part of `node --test` (`npm run smoke`). Checks:
//   - `::: cards accent`: the constant class; each card takes its hue in the accent order (orange,
//     blue, purple, …), restarting per block and repeating after nine; the hue's mark colour on the
//     top edge and its text colour on the ###, dark and light; a plain `::: cards` gets none of it;
//   - `::: stats` after # Title: three tiles, the number in the accent colour, beside the title on a
//     wide frame and below it on a narrow one;
//   - `::: matrix` / `::: bars`: vertical mark headers in their hue, dots drawn in the column's mark
//     colour with a text-colour edge (the character hidden), the totals row, <progress> bars that
//     keep value/max through DOMPurify; in both themes;
//   - numbered sections: the ## get a number in the light theme and on paper, not in dark;
//   - the round trip: normalized text and the editor's saved text keep `::: cards accent` and the
//     stats block, and render the same.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const cards = (n) => Array.from({ length: n }, (_, i) => `### Card ${i + 1}\nText ${i + 1}.`).join("\n");
const FIXTURE = `# Blocks

::: stats
- **3** 天
- **42** 場
- **9** 家公司
:::

## First section

::: cards accent
${cards(10)}
:::

::: cards accent
${cards(2)}
:::

::: cards
${cards(2)}
:::

## Second section

::: matrix
| Day | 信任 | 工廠 | 提及 / 18 |
|---|:-:|:-:|---|
| D1 | ● | ○ | 5/18 |
| D2 | ◐ |  | 12/18 |
| **合計** | 5 (4●) | 1 | |
:::

::: bars
| x | n / 4 |
|---|---|
| a | 3/4 |
:::
`;
// Accent order (§2.3) and the ramps the CSS must resolve to: [mark, text] per theme.
const ORDER = ["orange", "blue", "purple", "green", "yellow", "pink", "teal", "sand", "slate"];
const RAMP = {
  dark: { orange: ["#f0883e", "#f0883e"], blue: ["#58a6ff", "#58a6ff"], purple: ["#bc8cff", "#bc8cff"] },
  light: { orange: ["#e8a983", "#9a5630"], blue: ["#86addb", "#2f5d8a"], purple: ["#a898d8", "#6a55b0"] },
};
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
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

const browser = await launch();
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);
const check = (cond, msg, got) => (cond ? ok(msg) : fail(`${msg}: ${JSON.stringify(got)}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
  const waitFor = async (pred, what, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const found = (await page.evaluate(() => window.__msgs)).find(pred);
      if (found) return found;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };
  const send = (m) => page.evaluate((x) => __send(x), m);
  await waitFor((m) => m.type === "ready", "ready");
  const frame = page.frames().find((f) => f.url().endsWith("#nonce0"));

  // → per cards block: { cls, cards: [{ edge, h3 }] } (computed colours).
  const blocks = () => frame.evaluate(() => Array.from(document.querySelectorAll("#doc .cards"), (b) => ({
    cls: b.className,
    cards: Array.from(b.children, (c) => ({ edge: getComputedStyle(c).borderTopColor, width: getComputedStyle(c).borderTopWidth, h3: getComputedStyle(c.querySelector("h3")).color })),
  })));
  const hues = async (theme, what) => {
    const bs = await blocks();
    check(bs.length === 3 && bs[0].cls === "cards cards-accent" && bs[1].cls === "cards cards-accent" && bs[2].cls === "cards", `${what}: two accent rows and a plain one`, bs.map((b) => b.cls));
    const [a, b, plain] = bs;
    const want = (i) => RAMP[theme][ORDER[i % 9]];
    const at = (card, i) => card.edge === rgb(want(i)[0]) && card.h3 === rgb(want(i)[1]) && card.width === "3px";
    check(a && [0, 1, 2].every((i) => at(a.cards[i], i)), `${what} (${theme}): orange, blue, purple — mark edge 3 px, text-colour ###`, a && a.cards.slice(0, 3));
    check(a && at(a.cards[9], 9), `${what} (${theme}): the tenth card is orange again`, a && a.cards[9]);
    check(b && at(b.cards[0], 0) && at(b.cards[1], 1), `${what} (${theme}): the order restarts in the next block`, b && b.cards);
    check(plain && plain.cards.every((c) => c.width === "1px"), `${what} (${theme}): a plain ::: cards has no accent edge`, plain && plain.cards);
  };

  const stats = () => frame.evaluate(() => {
    const row = document.querySelector("#doc > .ks-title-row");
    const h1 = row && row.querySelector(":scope > h1");
    const tiles = Array.from(document.querySelectorAll("#doc .stats li"));
    const num = tiles[0] && tiles[0].querySelector("strong");
    const a = h1 && h1.getBoundingClientRect(), b = tiles[0] && tiles[0].getBoundingClientRect();
    return { row: !!row, tiles: tiles.length, num: num && getComputedStyle(num).color, accent: getComputedStyle(document.documentElement).getPropertyValue("--ks-accent").trim(),
      beside: !!(a && b && b.left > a.right && b.top < a.bottom), below: !!(a && b && b.top >= a.bottom - 1) };
  });
  const matrix = () => frame.evaluate(() => {
    const th = document.querySelector("#doc .matrix th.ks-mark");
    const dot = document.querySelector("#doc .matrix td.ks-dot-full");
    const ring = document.querySelector("#doc .matrix td.ks-dot-ring");
    const bars = Array.from(document.querySelectorAll("#doc progress.ks-bar-track"), (p) => [p.value, p.max, getComputedStyle(p.closest("tr")).getPropertyValue("--ks-hue-mid").trim()]);
    const b = dot && getComputedStyle(dot, "::before");
    return { marks: document.querySelectorAll("#doc .matrix th.ks-mark").length, wm: th && getComputedStyle(th).writingMode,
      dotFill: b && b.backgroundColor, dotEdge: b && b.borderTopColor, dotText: dot && getComputedStyle(dot).color,
      ringFill: ring && getComputedStyle(ring, "::before").backgroundColor,
      total: !!document.querySelector("#doc .matrix tr.ks-total .ks-sub"), bars,
      orangeMid: getComputedStyle(document.documentElement).getPropertyValue("--ks-orange-mid").trim(),
      orange: getComputedStyle(document.documentElement).getPropertyValue("--ks-orange").trim() };
  });
  const matrixOk = async (what) => {
    const m = await matrix();
    check(m.marks === 2 && m.wm === "vertical-rl" && m.total, `${what}: ::: matrix — 2 vertical mark headers, a totals row`, m);
    check(m.dotFill === rgb(m.orangeMid) && m.dotEdge === rgb(m.orange) && m.dotText === "rgba(0, 0, 0, 0)" && m.ringFill === "rgba(0, 0, 0, 0)", `${what}: ● filled in the mark colour with a text-colour edge, ○ a ring, characters hidden`, m);
    check(JSON.stringify(m.bars.map((b) => [b[0], b[1]])) === "[[5,18],[12,18],[3,4]]" && m.bars[0][2] !== "", `${what}: three bars keep value/max, each row has a hue`, m.bars);
  };
  const numbered = () => frame.evaluate(() => Array.from(document.querySelectorAll("#doc > h2"), (h) => getComputedStyle(h, "::before").content));
  const statsOk = async (what) => {
    const s = await stats();
    check(s.row && s.tiles === 3 && s.num === rgb(s.accent), `${what}: ::: stats — a title row, 3 tiles, the number in the accent`, s);
    return s;
  };

  // 1. As written, dark then light.
  await send({ type: "render", kind: "markdown", version: 1, seq: 1, content: FIXTURE });
  await waitFor((m) => m.type === "rendered" && m.seq === 1, "render 1");
  const wide = await statsOk("as written");
  check(wide.beside, "wide frame: the tiles sit right of the title", wide);
  await page.evaluate(() => { document.getElementById("f").style.width = "360px"; });
  await sleep(300);
  const narrowS = await stats();
  check(narrowS.below, "narrow frame: the tiles drop below the title", narrowS);
  await page.evaluate(() => { document.getElementById("f").style.width = "1100px"; });
  await sleep(200);
  await hues("dark", "as written");
  await matrixOk("dark");
  const nd = await numbered();
  check(nd.length === 2 && nd.every((c) => c === "none" || c === "normal"), "dark: ## not numbered", nd);
  await send({ type: "theme", value: "light" });
  await sleep(200);
  await hues("light", "as written");
  await statsOk("light");
  await matrixOk("light");
  const nl = await numbered();
  check(nl.length === 2 && nl.every((c) => /counter\(ks-sec\)/.test(c)), "light: each ## numbered", nl);
  await send({ type: "theme", value: "dark" });
  await sleep(200);
  await frame.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await page.emulateMediaType("print");
  const np = await numbered();
  check(np.length === 2 && np.every((c) => /counter\(ks-sec\)/.test(c)), "print from dark: each ## numbered (paper is light)", np);
  await page.emulateMediaType(null);
  await frame.evaluate(() => window.dispatchEvent(new Event("afterprint")));

  // 2. Normalization (the agent-write path) keeps the info word.
  await send({ type: "render", kind: "markdown", version: 2, seq: 2, content: FIXTURE, normalizeText: FIXTURE });
  const n = await waitFor((m) => m.type === "rendered" && m.seq === 2, "normalized render", 60000);
  const norm = n.normalized;
  check(typeof norm === "string" && (norm.match(/^::: cards accent$/gm) || []).length === 2 && /^::: cards$/m.test(norm), "normalized text keeps both `::: cards accent` and the plain `::: cards`", norm);
  if (typeof norm === "string") {
    await send({ type: "render", kind: "markdown", version: 3, seq: 3, content: norm });
    await waitFor((m) => m.type === "rendered" && m.seq === 3, "render normalized");
    await hues("dark", "after normalization");
    await statsOk("after normalization");
    await matrixOk("after normalization");
    check(/^::: matrix$/m.test(norm) && /^::: bars$/m.test(norm) && /5\/18/.test(norm) && /\*\*合計\*\*/.test(norm), "normalized text keeps ::: matrix / ::: bars, n/N and the bold total", norm);
    check(/^::: stats$/m.test(norm) && /\*\*42\*\* 場/.test(norm), "normalized text keeps ::: stats and its bold numbers", norm);
  }

  // 3. The editor: load, save, render the saved text.
  await send({ type: "edit", version: 3, content: FIXTURE });
  await frame.waitForSelector("#editor .ProseMirror", { timeout: 20000 });
  await sleep(200);
  await send({ type: "requestSave" });
  const sv = await waitFor((m) => m.type === "save", "save");
  await send({ type: "leaveEdit" });
  check((sv.content.match(/^::: cards accent$/gm) || []).length === 2, "the editor saves `::: cards accent` back", sv.content);
  await send({ type: "render", kind: "markdown", version: 4, seq: 4, content: sv.content });
  await waitFor((m) => m.type === "rendered" && m.seq === 4, "render saved");
  await hues("dark", "after an editor load + save");
  await statsOk("after an editor load + save");
  await matrixOk("after an editor load + save");
  const v = await frame.evaluate(() => window.__ksViolations || []);
  check(v.length === 0, "no CSP violation", v);
} catch (e) {
  fail(`threw: ${(e && e.stack) || e}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks ok");
process.exit(failures.length ? 1 : 0);
