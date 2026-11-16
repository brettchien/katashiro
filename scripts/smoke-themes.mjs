#!/usr/bin/env node
// smoke-themes.mjs — the canvas theme setting (ADR docs/adr/canvas-themes.md §2.2) in the real
// canvas.html + canvas.js with the real sandboxed frame, chrome.* stubbed in memory. Needs a Chrome,
// so it is not part of `node --test` (`npm run smoke`). Checks:
//   - 跟隨系統 (no setting): the host root and the frame root follow prefers-color-scheme, both ways;
//   - the header button cycles 跟隨系統 → 深色 → 淺色 → 跟隨系統, stores canvas:theme each time, and
//     the frame gets the resolved value;
//   - a slides canvas keeps the frame dark whatever the setting; the host header still follows it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const MD = "cv_0123456789ab";
const DECK = "cv_0123456789ac";
const STUB = `(() => {
  const data = {
    "canvas:${MD}:meta": { id: "${MD}", title: "Doc", kind: "markdown", version: 1, agentVersion: 1, author: "agent", conversationId: "c_0123456789ab", normalized: true },
    "canvas:${MD}:latest": "# Doc\\n\\nText.\\n",
    "canvas:${DECK}:meta": { id: "${DECK}", title: "Deck", kind: "slides", version: 1, agentVersion: 1, author: "agent", conversationId: "c_0123456789ab" },
    "canvas:${DECK}:latest": "# Deck\\n\\n---\\n\\n## Two\\n",
    "conv:index": { c_0123456789ab: { title: "Chat" } },
  };
  const ev = () => ({ addListener() {}, removeListener() {} });
  const pick = (keys) => { const out = {}; for (const k of keys == null ? Object.keys(data) : [].concat(keys)) if (k in data) out[k] = data[k]; return out; };
  window.__data = data;
  window.chrome = {
    runtime: { id: "stub", getURL: (p) => location.origin + "/" + p, onMessage: ev(), lastError: undefined, sendMessage: async () => undefined },
    storage: { local: { get: async (k) => pick(k), set: async (o) => { Object.assign(data, o); }, remove: async () => {} }, session: { get: async () => ({}), set: async () => {} }, onChanged: ev() },
    tabs: { query: async () => [], getCurrent: (cb) => { const t = { id: 1, windowId: 3, index: 0 }; if (cb) cb(t); return Promise.resolve(t); }, onRemoved: ev(), onUpdated: ev(), onAttached: ev(), create: async () => ({}), update: async () => ({}), remove: async () => {} },
    windows: { getAll: async () => [], update: async () => ({}), onRemoved: ev() },
    sidePanel: { open: async () => {} },
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
    res.end(fs.readFileSync(file, "utf8").replace('<script src="src/core/canvas-store.js">', '<script src="__stub.js"></script><script src="src/core/canvas-store.js">'));
    return;
  }
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

async function open(id, scheme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/canvas.html?id=${id}`, { waitUntil: "load" });
  return page;
}
// → { host, frame, button, stored } once the frame root has settled on `want` (or after 10 s).
async function state(page, want) {
  const end = Date.now() + 10000;
  for (;;) {
    const frame = page.frames().find((f) => f.url().includes("canvas-frame.html"));
    const s = {
      host: await page.evaluate(() => document.documentElement.dataset.ksTheme),
      frame: frame ? await frame.evaluate(() => document.documentElement.dataset.ksTheme).catch(() => null) : null,
      button: await page.evaluate(() => document.getElementById("canvas-theme").textContent),
      hidden: await page.evaluate(() => document.getElementById("canvas-theme").hidden),
      stored: await page.evaluate(() => window.__data["canvas:theme"]),
    };
    if (s.frame === want || Date.now() > end) return s;
    await sleep(100);
  }
}

try {
  // 1. 跟隨系統, both OS appearances.
  for (const scheme of ["light", "dark"]) {
    const page = await open(MD, scheme);
    const s = await state(page, scheme);
    check(s.host === scheme && s.frame === scheme && s.button === "◑ 跟隨系統" && !s.hidden, `跟隨系統 on a ${scheme} OS: host + frame ${scheme}, button shown`, s);
    await page.close();
  }
  // 2. The button cycles, stores, and the frame follows (OS light, so 跟隨系統 = light).
  {
    const page = await open(MD, "light");
    await state(page, "light");
    const steps = [["dark", "☾ 深色", "dark"], ["light", "☀ 淺色", "light"], ["system", "◑ 跟隨系統", "light"]];
    for (const [stored, label, shown] of steps) {
      await page.click("#canvas-theme");
      const s = await state(page, shown);
      check(s.stored === stored && s.button === label && s.host === shown && s.frame === shown, `click → ${stored}: stored, "${label}", host + frame ${shown}`, s);
    }
    await page.close();
  }
  // 3. A deck stays dark in the frame; the header follows the setting.
  {
    const page = await open(DECK, "light");
    const s = await state(page, "dark");
    check(s.frame === "dark" && s.host === "light", "slides: frame dark on a light OS, header light", s);
    await page.close();
  }
} catch (e) {
  fail(`threw: ${(e && e.stack) || e}`);
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nall checks ok");
process.exit(failures.length ? 1 : 0);
