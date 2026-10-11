#!/usr/bin/env node
// smoke-editor-undo.mjs — the edit-mode ↶ 復原 / ↷ 重做 (ADR docs/adr/canvas.md §3.5, Brett
// 2026-10-11: "just use editor's undo/redo") in the real canvas frame, under the real sandbox CSP.
// Needs a Chrome, so it is not part of `node --test`:
//
//   CHROME=/path/to/chrome-headless-shell PUPPETEER_CORE=/path/to/node_modules/puppeteer-core \
//     node scripts/smoke-editor-undo.mjs
//
// Same harness as smoke-glow-ranges.mjs. The host page has a button that, like canvas.html's ↶ / ↷,
// keeps focus in the frame on mousedown and sends editCmd{cmd} on click. Checks:
//   - opening the editor reports undoState{false, false} (loading is not an undoable step);
//   - typing enables undo; editCmd undo / redo run the editor's own history and report undoState;
//   - Ctrl+Z inside the editor walks the same stack (reported after the key is released);
//   - after a host button click the editor still has focus: typing goes on in the editor;
//   - an unknown editCmd does nothing; editCmd after leaving edit mode is ignored.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/tmp/pptr/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell";
const PPTR = process.env.PUPPETEER_CORE || "/usr/local/share/mise/installs/npm-mermaid-js-mermaid-cli/12.0.0/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core";

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const HOST = `<!doctype html><meta charset="utf-8"><body>
<button id="undo">↶ 復原</button><button id="redo">↷ 重做</button>
<iframe id="f" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0" style="width:1000px;height:700px;border:0"></iframe>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => { if (e.data && e.data.nonce === "nonce0") __msgs.push(e.data); });
  window.__send = (msg) => document.getElementById("f").contentWindow.postMessage({ ...msg, nonce: "nonce0" }, "*");
  for (const cmd of ["undo", "redo"]) {
    const b = document.getElementById(cmd);
    b.addEventListener("mousedown", (e) => e.preventDefault());       // as canvas.js: focus stays in the editor
    b.addEventListener("click", () => __send({ type: "editCmd", cmd }));
  }
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
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
  const msgs = () => page.evaluate(() => window.__msgs);
  const waitFor = async (pred, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const found = (await msgs()).find(pred);
      if (found) return found;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };
  // The latest undoState once it equals `want` (it is only posted on a change).
  const undoState = async (want, what) => {
    const end = Date.now() + 5000;
    let last;
    for (;;) {
      last = (await msgs()).filter((m) => m.type === "undoState").pop();
      if (last && last.canUndo === want.canUndo && last.canRedo === want.canRedo) return last;
      if (Date.now() > end) { fail(`${what}: undoState ${JSON.stringify(last)}, want ${JSON.stringify(want)}`); return last; }
      await sleep(50);
    }
  };
  await waitFor((m) => m.type === "ready", "ready");
  const frame = page.frames().find((f) => f.url().endsWith("#nonce0"));
  const CONTENT = "# Title\n\nHello world.\n";
  await page.evaluate((c) => __send({ type: "render", kind: "markdown", version: 1, seq: 1, content: c }), CONTENT);
  await waitFor((m) => m.type === "rendered" && m.seq === 1, "render");
  await page.evaluate((c) => __send({ type: "edit", version: 1, content: c }), CONTENT);
  await frame.waitForSelector("#editor .ProseMirror", { timeout: 20000 });
  const first = await waitFor((m) => m.type === "undoState", "the first undoState");
  check(first.canUndo === false && first.canRedo === false, "opening the editor: nothing to undo or redo", first);
  const text = () => frame.evaluate(() => document.querySelector("#editor .ProseMirror").textContent);

  // Type at the end of the paragraph.
  await frame.evaluate(() => {
    const p = Array.from(document.querySelectorAll("#editor .ProseMirror p")).find((e) => e.textContent.includes("Hello"));
    const r = document.createRange();
    r.selectNodeContents(p);
    r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    document.querySelector("#editor .ProseMirror").focus();
  });
  await page.keyboard.type(" XYZ");
  await undoState({ canUndo: true, canRedo: false }, "after typing");
  check((await text()).includes("Hello world. XYZ"), "typed text is in the editor", await text());

  // Host ↶ (mousedown keeps focus in the frame).
  await page.click("#undo");
  await undoState({ canUndo: false, canRedo: true }, "after ↶");
  check(!(await text()).includes("XYZ"), "↶ undoes the typing", await text());
  check(await frame.evaluate(() => document.hasFocus() && !!document.activeElement.closest(".ProseMirror")), "the editor keeps focus after ↶", null);

  await page.click("#redo");
  await undoState({ canUndo: true, canRedo: false }, "after ↷");
  check((await text()).includes("Hello world. XYZ"), "↷ redoes it", await text());

  // Typing right after a host button click goes on in the editor.
  await sleep(600);                                 // a new history group (prosemirror-history: 500 ms)
  await page.keyboard.type("!");
  await sleep(300);
  check((await text()).includes("XYZ!"), "typing after a ↷ click lands in the editor", await text());

  // Ctrl+Z inside the editor walks the same stack.
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await undoState({ canUndo: true, canRedo: true }, "after Ctrl+Z in the editor");
  check((await text()).includes("XYZ") && !(await text()).includes("XYZ!"), "Ctrl+Z undid the last typing group only", await text());

  // An unknown command does nothing.
  const before = await text();
  await page.evaluate(() => __send({ type: "editCmd", cmd: "selectAll" }));
  await sleep(200);
  check((await text()) === before, "an unknown editCmd changes nothing", await text());

  // After leaving edit mode, editCmd is ignored (no editor, no error).
  const n = (await msgs()).length;
  await page.evaluate(() => __send({ type: "leaveEdit" }));
  await page.evaluate(() => __send({ type: "editCmd", cmd: "undo" }));
  await sleep(300);
  const late = (await msgs()).slice(n).filter((m) => m.type === "undoState" || m.type === "error");
  check(late.length === 0, "editCmd after leaving edit mode: nothing posted", late);
  await page.close();
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\neditor-undo smoke test passed");
process.exit(failures.length ? 1 : 0);
