#!/usr/bin/env node
// smoke-ask-popover.mjs — the Ask agent popover (ADR docs/adr/canvas.md §3.7, Brett 2026-10-12
// option a) in the real canvas.html + canvas.js, with the real sandboxed frame. Needs a Chrome, so
// it is not part of `node --test`:
//
//   CHROME=/path/to/chrome-headless-shell PUPPETEER_CORE=/path/to/node_modules/puppeteer-core \
//     node scripts/smoke-ask-popover.mjs
//
// canvas.html is served over http with a stub of the chrome.* APIs it uses (storage with one
// markdown canvas, runtime.sendMessage recording the push and answering like the side panel).
// Headless Chrome is not the extension: focus between the page and the frame, IME and the real
// side panel still need the manual checks in TESTING.md. Checks:
//   - selecting text shows the 💬 below the selection, over the frame, not over the text;
//   - the 💬 opens the popover (role=dialog, excerpt, note focused); no window.prompt;
//   - an empty note: an inline hint, nothing sent; Shift+Enter is a new line; an IME Enter does not send;
//   - Enter sends composeAskAgent's text with the version captured at open, shows 已問, then closes;
//   - a failed push keeps the popover and the note; Esc closes it; the note comes back on reopen;
//   - the header 💬 Ask agent opens the same popover; a click in the header or the canvas closes it;
//   - entering edit mode closes it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/tmp/pptr/chrome-headless-shell/linux-155.0.8059.39/chrome-headless-shell-linux64/chrome-headless-shell";
const PPTR = process.env.PUPPETEER_CORE || "/usr/local/share/mise/installs/npm-mermaid-js-mermaid-cli/12.0.0/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core";

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const ID = "cv_0123456789ab";
const CONTENT = `# Plan\n\n${Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} has some words to select in it.`).join("\n\n")}\n`;
// The chrome.* surface canvas.js touches, in memory. window.__pushes records katashiro-canvas-push;
// window.__answer is what the "side panel" replies.
const STUB = `
(() => {
  const data = {
    "canvas:${ID}:meta": { id: "${ID}", title: "Plan", kind: "markdown", version: 4, agentVersion: 4, author: "agent", conversationId: "conv1", normalized: true },
    "canvas:${ID}:latest": ${JSON.stringify(CONTENT)},
  };
  const ev = () => ({ addListener() {}, removeListener() {} });
  const pick = (keys) => {
    const out = {};
    for (const k of keys == null ? Object.keys(data) : [].concat(keys)) if (k in data) out[k] = data[k];
    return out;
  };
  window.__pushes = [];
  window.__answer = { ok: true, agent: "Jelly" };
  window.__prompts = 0;
  window.prompt = () => { window.__prompts++; return null; };
  window.chrome = {
    runtime: {
      id: "stub", getURL: (p) => location.origin + "/" + p, onMessage: ev(), lastError: undefined,
      sendMessage: async (msg) => { if (msg && msg.type === "katashiro-canvas-push") { __pushes.push(msg); return __answer; } return undefined; },
    },
    storage: { local: { get: async (k) => pick(k), set: async (o) => { Object.assign(data, o); }, remove: async () => {} }, onChanged: ev() },
    tabs: { query: async () => [], getCurrent: (cb) => { const t = { id: 1 }; if (cb) cb(t); return Promise.resolve(t); }, onRemoved: ev(), onUpdated: ev(), create: async () => ({}), update: async () => ({}), remove: async () => {} },
  };
})();`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__stub.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(STUB); return; }
  const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const headers = { "content-type": TYPES[path.extname(file)] || "application/octet-stream" };
  if (url.pathname === "/canvas-frame.html") headers["content-security-policy"] = sandboxCsp;
  if (url.pathname === "/canvas.html") {
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file, "utf8").replace('<script src="canvas-store.js">', '<script src="__stub.js"></script><script src="canvas-store.js">'));
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const pkg = JSON.parse(fs.readFileSync(path.join(PPTR, "package.json"), "utf8"));
const puppeteer = (await import(pathToFileURL(path.join(PPTR, pkg.exports["."].import)).href)).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "shell", args: ["--no-sandbox"] });
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);
const check = (cond, msg, got) => (cond ? ok(msg) : fail(`${msg}: ${JSON.stringify(got)}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/canvas.html?id=${ID}`, { waitUntil: "load" });
  const until = async (fn, what, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await page.evaluate(fn);
      if (v) return v;
      if (Date.now() > end) { fail(`timed out: ${what}`); return v; }
      await sleep(50);
    }
  };
  const frameOf = () => page.frames().find((f) => f.url().includes("canvas-frame.html"));
  await until(() => !!document.querySelector("#canvas-main iframe"), "the frame");
  let frame = frameOf();
  await frame.waitForSelector("#doc p", { timeout: 20000 });
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
  const state = () => page.evaluate(() => {
    const vis = (id) => { const e = document.getElementById(id); return !e.hidden && getComputedStyle(e).display !== "none"; };
    const pill = document.getElementById("ask-pill").getBoundingClientRect();
    return {
      pill: vis("ask-pill"), pop: vis("ask-pop"), header: vis("canvas-ask"),
      pillBox: { top: pill.top, left: pill.left, bottom: pill.bottom, right: pill.right },
      frameBox: (() => { const f = document.querySelector("#canvas-main iframe").getBoundingClientRect(); return { top: f.top, left: f.left }; })(),
      focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      note: document.getElementById("ask-note").value,
      status: document.getElementById("ask-status").textContent,
      excerpt: document.getElementById("ask-excerpt").textContent,
      role: document.getElementById("ask-pop").getAttribute("role"),
      pushes: window.__pushes.length, prompts: window.__prompts,
    };
  });

  // 1. A selection: the 💬 below it, over the frame.
  const sb = await select("Paragraph 2 ");
  await until(() => !document.getElementById("ask-pill").hidden, "the 💬 after selecting");
  let s = await state();
  check(s.pill && s.header, "selecting text shows the 💬 and the header 💬 Ask agent", s);
  check(s.pillBox.top >= s.frameBox.top + sb.bottom && s.pillBox.top - (s.frameBox.top + sb.bottom) < 20, "the 💬 sits just below the selection (not over it)", { pill: s.pillBox, sel: sb, frame: s.frameBox });
  const endX = s.frameBox.left + sb.right;
  check(s.pillBox.left <= endX && s.pillBox.right >= endX, "the 💬 is at the selection's end", { pill: s.pillBox, endX });

  // 2. Open from the 💬.
  await page.click("#ask-pill");
  await until(() => !document.getElementById("ask-pop").hidden, "the popover");
  s = await state();
  check(s.pop && !s.pill && s.role === "dialog" && s.focus === "ask-note", "the 💬 opens the dialog, note focused, 💬 hidden", s);
  check(s.excerpt === "「some words」", "the excerpt is the selection", s.excerpt);

  // 3. Empty → hint, nothing sent. Shift+Enter is a new line. An IME Enter does not send.
  await page.keyboard.press("Enter");
  s = await state();
  check(s.pushes === 0 && s.pop && /請寫下/.test(s.status), "an empty note: inline hint, nothing sent", s);
  await page.keyboard.type("make it");
  await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
  await page.keyboard.type("shorter");
  s = await state();
  check(s.note === "make it\nshorter" && s.pushes === 0, "Shift+Enter is a new line", s.note);
  await page.evaluate(() => document.getElementById("ask-note").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await page.evaluate(() => document.getElementById("ask-note").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true, cancelable: true })));
  await sleep(100);
  s = await state();
  check(s.pushes === 0 && s.pop, "IME Enter / Esc neither send nor close", s);

  // 4. A failed push keeps the popover and the note.
  await page.evaluate(() => { window.__answer = { ok: false, error: "no agent connected" }; });
  await page.keyboard.press("Enter");
  await until(() => /送出失敗/.test(document.getElementById("ask-status").textContent), "the failure");
  s = await state();
  check(s.pop && s.note === "make it\nshorter" && s.pushes === 1 && /no agent connected/.test(s.status), "a failed push: still open, note kept, error shown", s);

  // 5. Enter sends: the captured version, the note, the selection; then 已問 and it closes.
  await page.evaluate(() => { window.__answer = { ok: true, agent: "Jelly" }; });
  await page.focus("#ask-note");
  await page.keyboard.press("Enter");
  await until(() => /已問 Jelly/.test(document.getElementById("ask-status").textContent), "已問");
  const push = await page.evaluate(() => window.__pushes[window.__pushes.length - 1]);
  check(push.conversationId === "conv1" && push.note === "make it\nshorter" && push.text.startsWith("make it\nshorter\n\n[canvas \"Plan\" (cv_0123456789ab) v4, text selected by the user")
    && push.text.includes("```\nsome words\n```"), "the push is composeAskAgent's text (note, host line with v4, selection fenced)", push);
  await until(() => document.getElementById("ask-pop").hidden, "the popover to close after 已問", 4000);
  s = await state();
  check(!s.pop && !s.pill && s.header && s.focus === "IFRAME", "after a send: closed, the 💬 stays away for this selection, focus back in the canvas", s);

  // 6. The header button opens the same popover; Esc closes and focus returns to it; the note comes back.
  await page.click("#canvas-ask");
  await until(() => !document.getElementById("ask-pop").hidden, "the popover from the header");
  await page.keyboard.type("draft note");
  await page.keyboard.press("Escape");
  s = await state();
  check(!s.pop && s.focus === "canvas-ask", "Esc closes; focus back on the header button", s);
  await page.click("#canvas-ask");
  await until(() => !document.getElementById("ask-pop").hidden, "the popover again");
  s = await state();
  check(s.note === "draft note", "reopened on the same selection: the unsent note is back", s.note);

  // 7. A click in the header (outside) closes it.
  await page.click("#canvas-title");
  s = await state();
  check(!s.pop, "a click outside closes the popover", s);
  // …and so does a click into the canvas (focus leaves this page for the frame).
  await page.click("#canvas-ask");
  await until(() => !document.getElementById("ask-pop").hidden, "the popover (frame click)");
  const fb = (await state()).frameBox;
  await page.mouse.click(fb.left + 600, fb.top + 15);
  await until(() => document.getElementById("ask-pop").hidden, "the popover to close on a click into the canvas", 3000);
  ok("a click into the canvas closes the popover");

  // 8. A new selection brings the 💬 back; open it, then enter edit mode: it closes.
  await select("Paragraph 5 ");
  await until(() => !document.getElementById("ask-pill").hidden, "the 💬 for a new selection");
  await page.click("#ask-pill");
  await until(() => !document.getElementById("ask-pop").hidden, "the popover (edit)");
  await page.evaluate(() => document.getElementById("canvas-edit").click());
  await sleep(200);
  s = await state();
  check(!s.pop && !s.pill && !s.header, "edit mode closes the popover and the 💬", s);
  check(s.prompts === 0, "no window.prompt anywhere in Ask agent", s.prompts);
  await page.close();
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nask-popover smoke test passed");
process.exit(failures.length ? 1 : 0);
