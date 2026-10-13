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
//   - an open popover follows its selection on scroll, docks under the header button once the
//     selection scrolls out of view (#125e), and goes back beside it when it scrolls back;
//   - the excerpt's text is in a <bdi dir="auto"> between the 「」 (#125c);
//   - To chat input (Brett 2026-10-13 01:12): a 📨 right beside the 💬 and 📨 To chat input in the
//     header, both with the selection; a click pushes NOTHING to the agent — it asks the panel once
//     (katashiro-canvas-to-input) with exactly the selected text (no host line, no fence), both are
//     disabled while it is asked, it says 📨 已放進輸入框 (or the draft case), a refusal says
//     沒放進輸入框, and both go away with the selection. (The input box itself — empty → the
//     selection, a draft appended to, focus — is smoke-multi-conversation.mjs, in the real panel.);
//   - To chat input, then Enter (Brett 2026-10-13 16:31): after a 📨 the canvas says 按 Enter 送出、Esc
//     取消; Enter in the canvas asks the panel exactly once to send its input
//     (katashiro-canvas-submit-input, no text: the panel sends what its input holds) and says 已送出,
//     a second Enter sends nothing; Esc disarms (已取消), so do another key, Shift+Enter and a mouse
//     press; Enter with the focus in the frame is relayed (armedKey) and sends once; after the draft
//     case nothing is armed; a refusal (the conversation is not on screen) is shown;
//   - entering edit mode closes it (and the 📨).
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
const CONTENT = `# Plan\n\n${Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} has some words to select in it.`).join("\n\n")}\n`;
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
  window.__toInput = [];
  window.__inputAnswer = { ok: true };
  window.__submits = [];
  window.__submitAnswer = { ok: true };
  window.__prompts = 0;
  window.prompt = () => { window.__prompts++; return null; };
  window.chrome = {
    runtime: {
      id: "stub", getURL: (p) => location.origin + "/" + p, onMessage: ev(), lastError: undefined,
      sendMessage: async (msg) => {
        if (msg && msg.type === "katashiro-canvas-submit-input") { __submits.push(msg); return __submitAnswer; }
        const to = msg && msg.type === "katashiro-canvas-to-input";
        if (!msg || (msg.type !== "katashiro-canvas-push" && !to)) return undefined;
        (to ? __toInput : __pushes).push(msg);
        if (window.__delay) await new Promise((r) => setTimeout(r, window.__delay));
        return to ? __inputAnswer : __answer;
      },
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
    const sp = document.getElementById("send-pill").getBoundingClientRect();
    return {
      pill: vis("ask-pill"), pop: vis("ask-pop"), header: vis("canvas-ask"),
      sendPill: vis("send-pill"), sendHeader: vis("canvas-send-sel"),
      sendDisabled: document.getElementById("send-pill").disabled || document.getElementById("canvas-send-sel").disabled,
      notice: document.getElementById("canvas-notice").textContent,
      pillBox: { top: pill.top, left: pill.left, bottom: pill.bottom, right: pill.right },
      sendBox: { top: sp.top, left: sp.left, bottom: sp.bottom, right: sp.right },
      frameBox: (() => { const f = document.querySelector("#canvas-main iframe").getBoundingClientRect(); return { top: f.top, left: f.left }; })(),
      focus: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      note: document.getElementById("ask-note").value,
      status: document.getElementById("ask-status").textContent,
      excerpt: document.getElementById("ask-excerpt").textContent,
      role: document.getElementById("ask-pop").getAttribute("role"),
      pushes: window.__pushes.length, toInput: window.__toInput.length, prompts: window.__prompts, submits: window.__submits.length,
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
  check(s.sendPill && s.sendHeader, "the 📨 and the header 📨 To chat input show with the selection", s);
  check(Math.abs(s.sendBox.top - s.pillBox.top) <= 1 && s.sendBox.left >= s.pillBox.right && s.sendBox.left - s.pillBox.right <= 8,
    "the 📨 sits right beside the 💬, on its row, not over it", { pill: s.pillBox, send: s.sendBox });

  // 2. Open from the 💬.
  await page.click("#ask-pill");
  await until(() => !document.getElementById("ask-pop").hidden, "the popover");
  s = await state();
  check(s.pop && !s.pill && !s.sendPill && s.role === "dialog" && s.focus === "ask-note", "the 💬 opens the dialog, note focused, 💬 and 📨 hidden", s);
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

  // 7b. #125e: the open popover follows its selection, docks when it scrolls out of view, comes back.
  await frame.evaluate(() => window.scrollTo(0, 0));
  const sb2 = await select("Paragraph 3 ");
  await sleep(500);                       // past the frame's debounce: the 💬 is for THIS selection
  await until(() => !document.getElementById("ask-pill").hidden, "the 💬 (scroll)");
  await page.click("#ask-pill");
  await until(() => !document.getElementById("ask-pop").hidden, "the popover (scroll)");
  const popBox = () => page.evaluate(() => { const b = document.getElementById("ask-pop").getBoundingClientRect(); const h = document.getElementById("canvas-ask").getBoundingClientRect(); return { top: Math.round(b.top), btnBottom: Math.round(h.bottom), hidden: document.getElementById("ask-pop").hidden }; });
  const bdi = await page.evaluate(() => { const b = document.querySelector("#ask-excerpt > bdi"); return b && { dir: b.dir, text: b.textContent, iso: getComputedStyle(document.getElementById("ask-excerpt")).unicodeBidi }; });
  check(bdi && bdi.dir === "auto" && bdi.text === "some words" && bdi.iso === "isolate", "the excerpt is a <bdi dir=auto> inside an isolated .ask-excerpt", bdi);
  const p0 = await popBox();
  const fTop = (await state()).frameBox.top;
  check(p0.top >= fTop + sb2.bottom, "open: the popover is below its selection", { p0, sel: sb2 });
  await frame.evaluate(() => window.scrollBy(0, 30));
  await sleep(300);
  const p1 = await popBox();
  check(Math.abs((p0.top - p1.top) - 30) <= 2, "a small scroll: the popover follows its selection", { p0, p1 });
  await frame.evaluate(() => window.scrollBy(0, 3000));
  await sleep(400);
  const p2 = await popBox();
  check(!p2.hidden && p2.top >= p2.btnBottom && p2.top - p2.btnBottom < 20, "scrolled out of view: the popover docks under the header button", p2);
  await frame.evaluate(() => window.scrollTo(0, 0));
  await sleep(400);
  const p3 = await popBox();
  check(Math.abs(p3.top - p0.top) <= 2, "scrolled back: the popover is beside its selection again", { p0, p3 });
  s = await state();
  check(s.pop && s.pushes === 2, "scrolling neither closed the popover nor sent anything", s);
  await page.keyboard.press("Escape");
  // Esc dismisses this selection's 💬; clear it so the same words selected again count as new.
  await frame.evaluate(() => getSelection().removeAllRanges());
  await sleep(400);

  // 7c. To chat input (Brett 2026-10-13 01:12): the 📨 sends nothing to the agent; it hands the
  // panel exactly the selected text for its input box, once.
  await select("Paragraph 4 ");
  await until(() => !document.getElementById("send-pill").hidden, "the 📨 for a new selection");
  s = await state();
  check(s.pill && s.sendPill && s.header && s.sendHeader && !s.pop, "a selection: 💬 + 📨 beside it, header 💬 Ask agent + 📨 To chat input", s);
  const labels = await page.evaluate(() => { const b = document.getElementById("canvas-send-sel"), p = document.getElementById("send-pill"); return { text: b.textContent, title: b.title, icon: b.dataset.icon, pill: p.title }; });
  check(labels.text === "📨 To chat input" && /放進聊天輸入框/.test(labels.title) && labels.icon === "📨" && labels.pill === "放進聊天輸入框",
    "the controls say To chat input / 放進聊天輸入框", labels);
  const before = s.pushes, beforeIn = s.toInput;
  await page.evaluate(() => { window.__inputAnswer = { ok: true }; window.__delay = 400; });
  await page.click("#send-pill");
  await sleep(50);
  s = await state();
  check(s.sendDisabled && !s.pop, "in flight: both 📨 controls disabled, no popover", s);
  await page.evaluate(() => { document.getElementById("send-pill").click(); document.getElementById("canvas-send-sel").click(); });
  await until(() => /已放進輸入框/.test(document.getElementById("canvas-notice").textContent), "📨 已放進輸入框");
  s = await state();
  check(s.pushes === before, "📨 pushes NOTHING to the agent", { before, after: s.pushes });
  check(s.toInput === beforeIn + 1, "a click (and clicks while in flight) ask the panel exactly once", { beforeIn, after: s.toInput });
  const ti = await page.evaluate(() => window.__toInput[window.__toInput.length - 1]);
  check(ti.conversationId === "conv1" && ti.text === "some words" && typeof ti.reqId === "string" && !("note" in ti),
    "the panel gets exactly the selected text (no host line, no fence) for the canvas's conversation", ti);
  check(s.notice === "📨 已放進輸入框 — 按 Enter 送出、Esc 取消" && !s.sendDisabled, "📨 已放進輸入框 — 按 Enter 送出、Esc 取消; controls enabled again", s);
  const still = await frame.evaluate(() => getSelection().toString());
  check(still === "some words" && !s.pill && !s.sendPill && s.header && s.sendHeader, "after it went in: the selection stays, its 💬/📨 go away, the header buttons stay", { still, s });

  // 7d. To chat input, then Enter (Brett 2026-10-13 16:31): the side panel cannot take the focus,
  // so Enter in the canvas asks it to send its input, once.
  const noticeText = () => page.evaluate(() => document.getElementById("canvas-notice").textContent);
  const armedHint = /按 Enter 送出、Esc 取消/;
  const sub0 = s.submits, in0 = s.toInput;
  await page.keyboard.press("Enter");
  await until(() => document.getElementById("canvas-notice").textContent === "已送出", "已送出 after Enter");
  s = await state();
  check(s.submits === sub0 + 1, "Enter in the canvas asks the panel to send, exactly once", { sub0, now: s.submits });
  const sub = await page.evaluate(() => window.__submits[window.__submits.length - 1]);
  check(sub.conversationId === "conv1" && typeof sub.reqId === "string" && !("text" in sub),
    "the submit names the canvas's conversation and a request id, no text (the panel sends its own input)", sub);
  check(s.toInput === in0 && s.pushes === before, "Enter did not put the selection in again, nor push anything", s);
  await page.keyboard.press("Enter");
  await sleep(200);
  check((await state()).submits === sub0 + 1, "a second Enter sends nothing (disarmed)", await state());
  // The 📨 again (the header button), then Esc: disarmed, the text stays in the input.
  const arm = async (what) => {
    await page.click("#canvas-send-sel");
    await until(() => /按 Enter 送出、Esc 取消/.test(document.getElementById("canvas-notice").textContent), `armed (${what})`);
  };
  await arm("Esc");
  await page.keyboard.press("Escape");
  await sleep(150);
  check(/已取消/.test(await noticeText()), "Esc disarms: 已取消", await noticeText());
  await page.keyboard.press("Enter");
  await sleep(200);
  check((await state()).submits === sub0 + 1, "after Esc, Enter sends nothing", await state());
  // Another key disarms silently.
  await arm("another key");
  await page.keyboard.press("a");
  await sleep(150);
  check(!armedHint.test(await noticeText()), "another key disarms (the hint goes)", await noticeText());
  await page.keyboard.press("Enter");
  await sleep(200);
  check((await state()).submits === sub0 + 1, "after another key, Enter sends nothing", await state());
  // Shift+Enter never sends, and disarms.
  await arm("Shift+Enter");
  await page.keyboard.down("Shift");
  await page.keyboard.press("Enter");
  await page.keyboard.up("Shift");
  await sleep(200);
  check((await state()).submits === sub0 + 1 && !armedHint.test(await noticeText()), "Shift+Enter sends nothing and disarms", await state());
  await page.keyboard.press("Enter");
  await sleep(200);
  check((await state()).submits === sub0 + 1, "…and a later Enter sends nothing", await state());
  // A mouse press disarms.
  await arm("mouse");
  await page.mouse.click(5, 5);
  await sleep(150);
  await page.keyboard.press("Enter");
  await sleep(200);
  check((await state()).submits === sub0 + 1, "a mouse press disarms: Enter sends nothing", await state());
  // The focus in the frame: its Enter is relayed (armedKey) and sends, once.
  await arm("frame");
  await page.evaluate(() => document.querySelector("#canvas-main iframe").focus());
  await sleep(100);
  check(armedHint.test(await noticeText()), "the focus moving into the frame keeps it armed", await noticeText());
  await page.keyboard.press("Enter");
  await until(() => document.getElementById("canvas-notice").textContent === "已送出", "已送出 after Enter in the frame");
  await page.keyboard.press("Enter");
  await sleep(200);
  check((await state()).submits === sub0 + 2, "Enter in the frame sends once (relayed); a second does not", await state());
  // In the frame: a key other than Enter disarms.
  await page.evaluate(() => document.getElementById("canvas-title").focus());
  await arm("frame, other key");
  await page.evaluate(() => document.querySelector("#canvas-main iframe").focus());
  await sleep(100);
  await page.keyboard.press("ArrowDown");
  await sleep(150);
  check(!armedHint.test(await noticeText()), "a key in the frame other than Enter disarms", await noticeText());
  await page.keyboard.press("Enter");
  await sleep(200);
  check((await state()).submits === sub0 + 2, "…and Enter after it sends nothing", await state());
  // The panel refuses (the conversation is no longer the one on screen): said in the canvas.
  await page.evaluate(() => { window.__submitAnswer = { ok: false, notCurrent: true, error: "那段對話不是側邊欄目前的對話，沒送出（文字留在它的輸入框）" }; });
  await arm("refused");
  await page.keyboard.press("Enter");
  await until(() => /沒送出/.test(document.getElementById("canvas-notice").textContent), "沒送出");
  check(/不是側邊欄目前的對話/.test(await noticeText()) && (await state()).submits === sub0 + 3, "a refusal is shown in the canvas", await noticeText());
  await page.evaluate(() => { window.__submitAnswer = { ok: true }; });
  // The header button, when the panel could not switch (the current conversation is replying): the draft.
  await page.evaluate(() => { window.__inputAnswer = { ok: true, draft: true }; window.__delay = 0; });
  await page.click("#canvas-send-sel");
  await until(() => /草稿/.test(document.getElementById("canvas-notice").textContent), "已放進…草稿");
  s = await state();
  check(s.toInput === beforeIn + 9 && s.pushes === before && /那段對話的草稿/.test(s.notice), "the draft case says so; still nothing pushed", s);
  check(await page.evaluate(() => document.activeElement !== document.getElementById("canvas-send-sel")), "not armed: the 📨 gave up the focus", null);
  await page.keyboard.press("Enter");
  await sleep(200);
  s = await state();
  check(s.submits === sub0 + 3 && s.toInput === beforeIn + 9, "the draft case is not armed: Enter sends nothing, nor clicks the 📨 again", s);
  // A refusal says so; nothing stays disabled.
  await page.evaluate(() => { window.__inputAnswer = { ok: false, error: "這段對話已封存，先從總覽重新打開" }; });
  await page.click("#canvas-send-sel");
  await until(() => /沒放進輸入框/.test(document.getElementById("canvas-notice").textContent), "沒放進輸入框");
  s = await state();
  check(s.toInput === beforeIn + 10 && /已封存/.test(s.notice) && !s.sendDisabled, "a refusal: 沒放進輸入框 with the reason, controls enabled", s);
  // No panel answering at all: the same notice as a push, nothing pushed.
  await page.evaluate(() => { window.__inputAnswer = undefined; });
  await page.click("#canvas-send-sel");
  await until(() => /沒放進輸入框|沒有回應/.test(document.getElementById("canvas-notice").textContent), "no panel");
  s = await state();
  check(s.pushes === before && /側邊面板沒有回應/.test(s.notice), "no panel: says the panel did not answer; nothing pushed", s);
  await page.evaluate(() => { window.__inputAnswer = { ok: true }; });
  // The selection goes away: so do the 📨 and the header button.
  await frame.evaluate(() => getSelection().removeAllRanges());
  await until(() => document.getElementById("canvas-send-sel").hidden, "the header 📨 to hide with the selection", 3000);
  s = await state();
  check(!s.pill && !s.sendPill && !s.header && !s.sendHeader, "no selection: no 💬, no 📨, no header buttons", s);
  await sleep(300);

  // 8. A new selection brings the 💬 back; open it, then enter edit mode: it closes.
  await select("Paragraph 5 ");
  await until(() => !document.getElementById("ask-pill").hidden, "the 💬 for a new selection");
  await page.click("#ask-pill");
  await until(() => !document.getElementById("ask-pop").hidden, "the popover (edit)");
  await page.evaluate(() => document.getElementById("canvas-edit").click());
  await sleep(200);
  s = await state();
  check(!s.pop && !s.pill && !s.header && !s.sendPill && !s.sendHeader, "edit mode closes the popover, the 💬 and the 📨 (both)", s);
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
