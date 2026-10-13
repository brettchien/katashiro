#!/usr/bin/env node
// smoke-ask-selection.mjs — Ask agent's selection{rect} (ADR docs/adr/canvas.md §3.7, Brett
// 2026-10-12 option a) in the real canvas frame, under the real sandbox CSP. Needs a Chrome, so it
// is not part of `node --test`:
//
//   npm ci && npm run chrome     # once
//   node scripts/smoke-ask-selection.mjs      # or `npm run smoke` for all of them
//
// (CHROME / PUPPETEER_CORE override the Chrome and puppeteer-core it uses: see scripts/lib/smoke-env.mjs.)
//
// Same harness as smoke-editor-undo.mjs. The host page offsets the iframe (as canvas.html's header
// does) and places a 💬-sized box with CanvasCore.askPlace, and a 📨-sized one beside it with
// CanvasCore.askBeside, as canvas.js does. Checks:
//   - a selection posts selection{text, seq, rect}, rect = the range's box in the frame viewport;
//   - the placed 💬 does not cover the selection (below it, or above it near the bottom);
//   - the 📨 (To chat input, Brett 2026-10-13) goes on the 💬's row, right beside it, inside the frame;
//   - scrolling re-posts only the rect, as selectionRect{seq, rect?} — no selection{} with the
//     text again (#125d); scrolled out of view, the rect is left out (the 💬 hides);
//   - slides: a selection on slide 1 has a rect; moving to slide 2 clears it or drops the rect;
//   - where (Brett 2026-10-12 17:43): the heading path and the STORED source lines of a selection —
//     through the "<br />" lines the view drops, in a table row, a list item, across two blocks, in a
//     rendered mermaid diagram, and on a slide (with its number); none above → no path.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<div style="height:40px">header</div>
<iframe id="f" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0" style="display:block;margin-left:30px;width:900px;height:500px;border:0"></iframe>
<script src="/canvas-core.js"></script>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => { if (e.data && e.data.nonce === "nonce0") __msgs.push(e.data); });
  window.__send = (msg) => document.getElementById("f").contentWindow.postMessage({ ...msg, nonce: "nonce0" }, "*");
  // As canvas.js: the frame's rect, the iframe's box → where the 💬 (30 × 26) goes, in page
  // coordinates, and the 📨 (30 × 26) beside it.
  window.__place = (rect) => {
    const fb = document.getElementById("f").getBoundingClientRect();
    const box = { left: fb.left, top: fb.top, width: fb.width, height: fb.height };
    const p = CanvasCore.askPlace({ rect, box, size: { w: 30, h: 26 } });
    return { box, p, q: p && CanvasCore.askBeside({ anchor: { left: p.left, top: p.top, w: 30, h: 26 }, box, size: { w: 30, h: 26 } }) };
  };
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
  await page.setViewport({ width: 1000, height: 600 });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
  const msgs = () => page.evaluate(() => window.__msgs);
  const waitFor = async (pred, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const found = (await msgs()).filter(pred).pop();
      if (found) return found;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };
  // The next selection{} after `act` (run once the messages so far are counted).
  const nextSelection = async (act, pred, what) => {
    const n = (await msgs()).length;
    await act();
    const end = Date.now() + 5000;
    for (;;) {
      const found = (await msgs()).slice(n).filter((m) => m.type === "selection" && pred(m)).pop();
      if (found) return found;
      if (Date.now() > end) { fail(`${what}: no such selection{} (last: ${JSON.stringify((await msgs()).filter((m) => m.type === "selection").pop())})`); return null; }
      await sleep(50);
    }
  };
  // The next selectionRect{} after `act` (#125d: what a scroll posts instead of selection{}).
  const nextRect = async (act, pred, what) => {
    const n = (await msgs()).length;
    await act();
    const end = Date.now() + 5000;
    for (;;) {
      const found = (await msgs()).slice(n).filter((m) => m.type === "selectionRect" && pred(m)).pop();
      if (found) return found;
      if (Date.now() > end) { fail(`${what}: no such selectionRect{} (last: ${JSON.stringify((await msgs()).filter((m) => m.type === "selectionRect").pop())})`); return null; }
      await sleep(50);
    }
  };
  await waitFor((m) => m.type === "ready", "ready");
  let frame = page.frames().find((f) => f.url().endsWith("#nonce0"));
  const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} has some words to select in it.`);
  await page.evaluate((c) => __send({ type: "render", kind: "markdown", version: 1, seq: 1, content: c }), `# Doc\n\n${paras.join("\n\n")}\n`);
  await waitFor((m) => m.type === "rendered" && m.seq === 1, "render");

  // Select "some words" in a paragraph; returns the range's box in the frame viewport.
  const select = (needle) => frame.evaluate((needle) => {
    const p = Array.from(document.querySelectorAll("#doc p")).find((e) => e.textContent.startsWith(needle));
    const t = p.firstChild, at = t.data.indexOf("some words");
    const r = document.createRange();
    r.setStart(t, at);
    r.setEnd(t, at + "some words".length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    const b = r.getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  }, needle);

  let box;
  const s1 = await nextSelection(async () => { box = await select("Paragraph 3 "); }, (m) => m.text === "some words", "a selection");
  check(s1 && s1.seq === 1 && s1.rect, "selection{text, seq, rect} posted", s1);
  if (s1 && s1.rect) {
    const near = (a, b) => Math.abs(a - b) <= 1;
    check(near(s1.rect.top, box.top) && near(s1.rect.bottom, box.bottom) && near(s1.rect.left, box.left) && near(s1.rect.right, box.right), "rect is the range's box in the frame viewport", { rect: s1.rect, box });
    check(near(s1.rect.x, box.right), "rect.x is the selection's end", s1.rect);
    const { box: fb, p } = await page.evaluate((r) => __place(r), s1.rect);
    check(p && p.placement === "below" && p.top >= fb.top + s1.rect.bottom, "the 💬 goes below the selection (page coordinates, frame offset added)", { p, fb, rect: s1.rect });
    check(p && p.left >= fb.left && p.left + 30 <= fb.left + fb.width, "the 💬 is inside the frame box", { p, fb });
    const { q } = await page.evaluate((r) => __place(r), s1.rect);
    check(q && q.side === "right" && q.top === p.top && q.left === p.left + 30 + 4 && q.left + 30 <= fb.left + fb.width,
      "the 📨 goes right beside the 💬, on its row, inside the frame box", { p, q, fb });
  }

  // Near the bottom of the view: above it, still not over it.
  const lastVisible = await frame.evaluate(() => {
    const ps = Array.from(document.querySelectorAll("#doc p"));
    return ps.filter((p) => p.getBoundingClientRect().bottom < innerHeight - 2).pop().textContent.split(" has")[0] + " ";
  });
  const s2 = await nextSelection(() => select(lastVisible), (m) => m.text === "some words" && m.rect && m.rect.top !== (s1 && s1.rect && s1.rect.top), "a selection near the bottom");
  if (s2) {
    const { box: fb, p } = await page.evaluate((r) => __place(r), s2.rect);
    check(p && (p.placement === "above" ? p.top + 26 <= fb.top + s2.rect.top : p.top >= fb.top + s2.rect.bottom), `near the bottom the 💬 does not cover the selection (${p && p.placement})`, { p, rect: s2.rect });
  }

  // Scrolling moves the rect, and only the rect (#125d); out of view the rect is left out.
  const s3 = await nextSelection(() => select("Paragraph 3 "), (m) => m.rect && s1 && s1.rect && m.rect.top === s1.rect.top, "back to paragraph 3");
  await sleep(400);                                       // past the selectionchange debounce
  const scrollFrom = (await msgs()).length;
  const s4 = await nextRect(() => frame.evaluate(() => window.scrollBy(0, 40)), (m) => !!m.rect, "after a small scroll");
  check(s3 && s4 && s4.seq === 1 && s4.rect && Math.abs(s4.rect.top - (s3.rect.top - 40)) <= 1, "a scroll posts selectionRect{seq, rect}, moved by the scroll", { s3, s4 });
  const s5 = await nextRect(() => frame.evaluate(() => window.scrollBy(0, 2000)), () => true, "scrolled away");
  check(s5 && s5.rect === undefined, "scrolled out of view: selectionRect{} with no rect", s5);
  // Many scroll steps: rect messages only, at most one per animation frame, never the text again.
  const s6 = await nextRect(() => frame.evaluate(async () => {
    for (let i = 0; i < 20; i++) { window.scrollTo(0, 2000 - i * 100); await new Promise((r) => requestAnimationFrame(r)); }
    window.scrollTo(0, 0);
  }), (m) => !!m.rect, "scrolled back");
  check(s6 && s6.rect, "scrolled back: the rect returns", s6);
  await sleep(300);
  const during = (await msgs()).slice(scrollFrom);
  check(during.length > 2 && during.every((m) => m.type === "selectionRect" && !("text" in m) && !("where" in m)),
    "while scrolling the frame posts only selectionRect{} (no text, no where)", during.map((m) => m.type));
  // Bad rects never leave the frame: the host's check would refuse the message.
  const accepted = await page.evaluate(() => __msgs.filter((m) => m.type === "selection" || m.type === "selectionRect").every((m) => m.rect === undefined || CanvasCore.askRect(m.rect)));
  check(accepted, "every rect the frame posted passes CanvasCore.askRect", null);
  const valid = await page.evaluate(() => __msgs.filter((m) => m.type === "selectionRect").every((m) => CanvasCore.acceptFrameMessage({ source: 1, data: m }, { frameWindow: 1, nonce: m.nonce })));
  check(valid, "every selectionRect{} passes the host's frame-message check", null);

  // where: the heading path and the stored lines. The stored text has Milkdown "<br />" lines and a
  // run of blank lines that the view drops (cleanEditorMarkdown), so rendered lines != stored lines.
  const stored = [
    "intro words here",                  // 1  (no heading above)
    "",
    "# 計畫",                             // 3
    "",
    "<br />",
    "",
    "<br />",
    "",
    "## 背景",                            // 9
    "",
    "background words",                  // 11
    "",
    "## 決定紀錄",                         // 13
    "",
    "",
    "",
    "### 2026-10-12",                    // 17
    "",
    "first line of the target",          // 19
    "second line of the target",         // 20
    "",
    "- item one",                        // 22
    "- item two",                        // 23
    "",
    "| a | b |",                         // 25
    "|---|---|",
    "| cell words | 2 |",                // 27
    "",
    "```mermaid",                        // 29
    "flowchart LR",
    "  Alpha --> Beta",
    "```",                               // 32
    "",
  ].join("\n");
  await page.evaluate((c) => __send({ type: "render", kind: "markdown", version: 3, seq: 3, content: c }), stored);
  await waitFor((m) => m.type === "rendered" && m.seq === 3, "structured render");
  await frame.evaluate(() => window.scrollTo(0, 0));
  // Select from `a` (in the first element whose text includes it) to `b` (likewise; default: a's end).
  const selectSpan = (a, b) => frame.evaluate((a, b) => {
    const textNode = (needle) => {
      const w = document.createTreeWalker(document.getElementById("doc"), NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.includes(needle)) return n;
      throw new Error(`no text "${needle}"`);
    };
    const ta = textNode(a), tb = b ? textNode(b) : ta;
    const r = document.createRange();
    r.setStart(ta, ta.data.indexOf(a));
    r.setEnd(tb, tb.data.indexOf(b || a) + (b || a).length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }, a, b || null);
  const whereOf = async (a, b, what) => {
    const m = await nextSelection(() => selectSpan(a, b), (x) => x.seq === 3 && x.text.endsWith(b || a), what);
    return m && m.where;
  };
  const storedLines = stored.split("\n");
  const linesAre = (w, from, to, what) => {
    check(w && w.lines && w.lines.from === from && w.lines.to === to, `${what}: source lines ${from}–${to}`, w);
    if (w && w.lines) console.log(`       ${JSON.stringify(storedLines.slice(w.lines.from - 1, w.lines.to))}`);
  };
  let w = await whereOf("target", null, "a word in a paragraph");
  check(w && JSON.stringify(w.headings) === JSON.stringify(["計畫", "決定紀錄", "2026-10-12"]), "heading path 計畫 › 決定紀錄 › 2026-10-12", w);
  linesAre(w, 19, 20, "paragraph (after dropped <br /> and blank lines)");
  check(w && w.slide === undefined, "a document has no slide", w);
  w = await whereOf("background", null, "under 背景");
  check(w && JSON.stringify(w.headings) === JSON.stringify(["計畫", "背景"]), "a sibling h2 replaces the other", w);
  linesAre(w, 11, 11, "one-line paragraph");
  w = await whereOf("intro", null, "above every heading");
  check(w && w.headings === undefined, "no heading above → no path", w);
  linesAre(w, 1, 1, "first line");
  w = await whereOf("two", null, "list item");
  linesAre(w, 23, 23, "tight list item");
  w = await whereOf("cell words", null, "table cell");
  linesAre(w, 27, 27, "table row");
  w = await whereOf("second line", "item one", "across blocks");
  linesAre(w, 19, 22, "a selection across two blocks");
  w = await whereOf("決定紀錄", null, "a heading itself");
  check(w && JSON.stringify(w.headings) === JSON.stringify(["計畫", "決定紀錄"]), "a selected heading ends the path", w);
  linesAre(w, 13, 13, "heading line");
  // The mermaid diagram replaces its <pre>: the figure keeps the fence's lines.
  const hasFig = await frame.waitForSelector("#doc figure.ks-mermaid svg", { timeout: 20000 }).then(() => true, () => false);
  check(hasFig, "the mermaid fence rendered as a diagram", null);
  if (hasFig) {
    const wm = await nextSelection(() => frame.evaluate(() => {
      const fig = document.querySelector("#doc figure.ks-mermaid");
      const t = Array.from(fig.querySelectorAll("svg text, svg tspan, svg p, svg span")).find((e) => /Alpha/.test(e.textContent));
      const r = document.createRange();
      r.selectNodeContents(t);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    }), (x) => x.seq === 3 && /Alpha/.test(x.text), "a label in the diagram");
    linesAre(wm && wm.where, 29, 32, "mermaid diagram (its fence)");
  }
  const allOk = await page.evaluate(() => __msgs.filter((m) => m.type === "selection" && m.where).every((m) => JSON.stringify(CanvasCore.askWhere(m.where)) === JSON.stringify(m.where)));
  check(allOk, "every where the frame posted passes CanvasCore.askWhere unchanged", null);
  await page.evaluate(() => __send({ type: "render", kind: "markdown", version: 1, seq: 4, content: "x" }));

  // Slides: the rect goes when the deck moves away from the selection's slide. A fresh frame, as
  // in canvas.html (a canvas keeps its kind; a frame never switches from a document to a deck).
  await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
  await waitFor((m) => m.type === "ready", "ready (slides)");
  frame = page.frames().find((f) => f.url().endsWith("#nonce0"));
  await page.evaluate(() => __send({ type: "render", kind: "slides", version: 2, seq: 2, content: "# One\n\nFirst slide has some words here.\n\n---\n\n# Two\n\nSecond slide.\n" }));
  await waitFor((m) => m.type === "rendered" && m.seq === 2, "slides render");
  await sleep(500);
  const s8 = await nextSelection(() => frame.evaluate(() => {
    const p = Array.from(document.querySelectorAll("#deck p")).find((e) => e.textContent.startsWith("First slide"));
    const t = p.firstChild, at = t.data.indexOf("some words");
    const r = document.createRange();
    r.setStart(t, at);
    r.setEnd(t, at + "some words".length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }), (m) => m.text === "some words" && m.seq === 2, "a selection on slide 1");
  check(s8 && s8.rect, "slides: selection with a rect", s8);
  check(s8 && s8.where && s8.where.slide === 1 && JSON.stringify(s8.where.headings) === JSON.stringify(["One"]) && s8.where.lines && s8.where.lines.from === 3 && s8.where.lines.to === 3,
    "slides: where = slide 1, its heading, the deck text's line 3", s8 && s8.where);
  // A slide change is a move under the same selection: selectionRect{} with no rect (#125d), or
  // reveal clears the selection itself (selection{text: ""}).
  const goFrom = (await msgs()).length;
  await page.evaluate(() => __send({ type: "goto", slide: 2 }));
  let s9 = null;
  for (const end = Date.now() + 5000; !s9 && Date.now() < end; await sleep(50)) {
    s9 = (await msgs()).slice(goFrom).find((m) => (m.type === "selection" && m.text === "") || (m.type === "selectionRect" && m.rect === undefined)) || null;
  }
  // Chrome 155 + reveal: the slide change clears the selection itself (text ""); either way the 💬 hides.
  check(!!s9, `slides: moving to slide 2 hides the 💬 (${s9 && s9.type === "selection" ? "selection cleared" : "rect dropped"})`, s9);
  await sleep(800);                                       // the slide transition
  // On slide 2: lines offset by where the slide starts in the deck text.
  const s8b = await nextSelection(() => frame.evaluate(() => {
    const p = Array.from(document.querySelectorAll("#deck p")).find((e) => e.textContent.startsWith("Second slide"));
    const r = document.createRange();
    r.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  }), (m) => m.text === "Second slide." && m.seq === 2, "a selection on slide 2");
  check(s8b && s8b.where && s8b.where.slide === 2 && JSON.stringify(s8b.where.headings) === JSON.stringify(["Two"]) && s8b.where.lines && s8b.where.lines.from === 9 && s8b.where.lines.to === 9,
    "slides: slide 2 — its own heading only, the deck text's line 9", s8b && s8b.where);
  await page.close();
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nask-selection smoke test passed");
process.exit(failures.length ? 1 : 0);
