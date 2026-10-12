#!/usr/bin/env node
// smoke-diagram-notice.mjs — a mermaid diagram error notice in the canvas header is tied to the
// render it came from (real Chrome 2026-10-12, canvas v22→v23: the fixed diagram drew, the header
// kept v22's 「圖表有錯誤」). Real canvas.html + canvas.js with the real sandboxed frame. Needs a
// Chrome, so it is not part of `node --test`:
//
//   CHROME=/path/to/chrome-headless-shell PUPPETEER_CORE=/path/to/node_modules/puppeteer-core \
//     node scripts/smoke-diagram-notice.mjs
//
// canvas.html is served over http with a stub of the chrome.* APIs it uses (storage whose writes
// fire onChanged like Chrome's, runtime.sendMessage recording the push). Checks:
//   - v22 with a broken diagram: the header says 圖表有錯誤（v22） with 送給 agent 修;
//   - 送給 agent 修 pushes a header naming v22;
//   - v23 with the diagram fixed renders with no diagram notice;
//   - v24 broken again: a fresh notice for v24; v25 fixes it and, once rendered, the notice is gone
//     (the bug: v24's stayed — this step fails on the code before the fix).
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
const doc = (diagram) => `# Plan\n\nSome text.\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n`;
const BAD = doc("flowchart LR\n  A --> B -->");
const GOOD = doc("flowchart LR\n  A --> B");
const STUB = `
(() => {
  const data = {
    "canvas:${ID}:meta": { id: "${ID}", title: "Plan", kind: "markdown", version: 22, agentVersion: 22, author: "agent", conversationId: "conv1", normalized: true },
    "canvas:${ID}:latest": ${JSON.stringify(BAD)},
  };
  const listeners = [];
  const ev = () => ({ addListener() {}, removeListener() {} });
  const pick = (keys) => {
    const out = {};
    for (const k of keys == null ? Object.keys(data) : [].concat(keys)) if (k in data) out[k] = data[k];
    return out;
  };
  window.__pushes = [];
  // Write a new version like the store does, and tell the page like chrome.storage.onChanged.
  window.__write = (version, content) => {
    const mk = "canvas:${ID}:meta", lk = "canvas:${ID}:latest";
    const changes = { [mk]: { oldValue: data[mk] }, [lk]: { oldValue: data[lk] } };
    data[mk] = { ...data[mk], version, agentVersion: version };
    data[lk] = content;
    changes[mk].newValue = data[mk];
    changes[lk].newValue = content;
    for (const fn of listeners) fn(changes, "local");
  };
  window.chrome = {
    runtime: {
      id: "stub", getURL: (p) => location.origin + "/" + p, onMessage: ev(), lastError: undefined,
      sendMessage: async (msg) => { if (msg && msg.type === "katashiro-canvas-push") { __pushes.push(msg); return { ok: true, agent: "Jelly" }; } return undefined; },
    },
    storage: { local: { get: async (k) => pick(k), set: async (o) => { Object.assign(data, o); }, remove: async () => {} }, onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} } },
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
  const until = async (fn, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await page.evaluate(fn);
      if (v) return v;
      if (Date.now() > end) { fail(`timed out: ${what}`); return v; }
      await sleep(50);
    }
  };
  const state = () => page.evaluate(() => ({
    bar: !document.getElementById("canvas-notice-bar").hidden,
    text: document.getElementById("canvas-notice").textContent,
    action: !document.getElementById("canvas-notice-action").hidden && document.getElementById("canvas-notice-action").textContent,
    pushes: window.__pushes.map((p) => p.text),
  }));
  const frameOf = () => page.frames().find((f) => f.url().includes("canvas-frame.html"));

  // 1. v22: the diagram fails; the notice names v22 and offers the push.
  await until(() => /圖表有錯誤/.test(document.getElementById("canvas-notice").textContent), "v22's diagram notice");
  let s = await state();
  check(s.bar && /圖表有錯誤（v22）/.test(s.text) && s.action === "送給 agent 修", "v22: 圖表有錯誤（v22） with 送給 agent 修", s);

  // 2. The push names v22.
  await page.click("#canvas-notice-action");
  await until(() => window.__pushes.length === 1, "the push");
  s = await state();
  check(/v22 \(markdown\) has a mermaid diagram that failed/.test(s.pushes[0]) && !/is now v/.test(s.pushes[0]), "送給 agent 修 sends v22's error as v22", s.pushes[0]);

  // 3. v23 draws the diagram fine (the push already replaced the notice with 已把錯誤送給).
  await page.evaluate((c) => window.__write(23, c), GOOD);
  await frameOf().waitForFunction(() => document.querySelectorAll("#doc svg").length === 1 && !document.querySelector("#doc .mermaid-error, #doc [class*='error']"), { timeout: 20000 });
  await sleep(300);                                   // rendered{} reaches the host after the svg
  s = await state();
  check(!/圖表有錯誤/.test(s.text), "v23 rendered: no diagram notice", s);

  // 4. v24 breaks it: a fresh notice for v24. Then v25 fixes it: the notice clears.
  await page.evaluate((c) => window.__write(24, c), BAD);
  await until(() => /圖表有錯誤（v24）/.test(document.getElementById("canvas-notice").textContent), "v24's diagram notice");
  ok("v24: a fresh notice names v24");
  await page.evaluate((c) => window.__write(25, c), GOOD);
  await until(() => document.getElementById("canvas-notice-bar").hidden, "v25 rendered: v24's notice to clear");
  s = await state();
  check(!s.bar && s.text === "", "v25 rendered: v24's diagram notice is gone (the bug: it stayed)", s);
  await page.close();
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\ndiagram-notice smoke test passed");
process.exit(failures.length ? 1 : 0);
