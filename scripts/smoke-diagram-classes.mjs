#!/usr/bin/env node
// smoke-diagram-classes.mjs — the theme-aware diagram classes (ADR docs/adr/canvas-themes.md §2.5) in
// the real canvas frame: `class A ks-blue-strong` in a flowchart (and a state diagram, which has no ks-*
// support — both grammars reject the "-" — and must still draw), with the classDef lines the frame
// appends, under each engine (Pele, Mermaid) and each theme. Needs a Chrome (`npm run smoke`). Checks,
// per engine and theme: some shape of the diagram is filled with the hue's tint, outlined in its mark
// colour, and the -strong one is 3 px; no fallback note (the engine drew it itself); a theme switch
// recolours it — Pele by the CSS variables alone (same SVG), Mermaid by its light SVG (drawn in the
// background, shown at once — beforeprint relies on that).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = "# Classes\n\n```mermaid\nflowchart LR\n  A[Alpha] --> B[Beta]\n  class A ks-blue-strong\n  class B ks-orange\n```\n\n```mermaid\nstateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy\n  class Idle ks-blue-strong\n  class Busy ks-orange\n```\n";
const KINDS = ["flowchart", "state"];
const TINT = { dark: { blue: "#162333", orange: "#281f1c" }, light: { blue: "#e6f0fb", orange: "#fdeee4" } };
const MID = { dark: { blue: "#58a6ff", orange: "#f0883e" }, light: { blue: "#86addb", orange: "#e8a983" } };
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0" style="width:1100px;height:700px;border:0;display:block"></iframe>
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
  for (const engine of ["pele", "mermaid"]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 700 });
    page.on("pageerror", (e) => fail(`${engine}: page error: ${e.message}`));
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
    await waitFor((m) => m.type === "ready", "ready");
    const frame = page.frames().find((f) => f.url().endsWith("#nonce0"));
    // Every shape's computed fill / stroke / stroke-width, and the figure's engine + fallback note.
    const shapes = () => frame.evaluate(() => Array.from(document.querySelectorAll("#doc figure.ks-mermaid"), (fig, i) => {
      const svg = fig.querySelector("svg");
      if (svg && !svg.dataset.smokeId) svg.dataset.smokeId = String(i) + ":" + Math.random();
      return {
        engine: fig.dataset.engine, note: fig.querySelector(".ks-mermaid-fallback") ? fig.querySelector(".ks-mermaid-fallback").textContent : null,
        svgId: svg ? svg.dataset.smokeId : null,
        shapes: Array.from(fig.querySelectorAll("svg rect, svg polygon, svg path, svg circle, svg ellipse"), (e) => { const c = getComputedStyle(e); return [c.fill, c.stroke, c.strokeWidth]; }),
      };
    }));
    const verify = async (theme, what) => {
      const figs = await shapes();
      figs.forEach((s, i) => {
        const has = (hue, strong) => s.shapes.some(([f, st, w]) => f === rgb(TINT[theme][hue]) && st === rgb(MID[theme][hue]) && (!strong || w === "3px"));
        const k = KINDS[i];
        if (k === "state") {   // no ks-* support (a "-" in a class name): drawn, uncoloured, never broken
          check(s.engine === engine && !s.note && s.shapes.length > 0, `${engine} state ${what}: a state diagram with class ks-* is drawn as is`, { engine: s.engine, note: s.note });
          return;
        }
        check(s.engine === engine && !s.note, `${engine} ${k} ${what}: drawn by ${engine}, no fallback note`, { engine: s.engine, note: s.note });
        check(has("blue", true), `${engine} ${k} ${what} (${theme}): ks-blue-strong — blue tint, mark stroke, 3 px`, s.shapes.slice(0, 12));
        check(has("orange", false), `${engine} ${k} ${what} (${theme}): ks-orange — orange tint, mark stroke`, s.shapes.slice(0, 12));
      });
      return figs;
    };
    await page.evaluate((m) => __send(m), { type: "render", kind: "markdown", version: 1, seq: 1, content: FIXTURE, engine });
    await waitFor((m) => m.type === "rendered" && m.seq === 1, "rendered");
    const before = await verify("dark", "as rendered");
    const errs = await frame.evaluate(() => Array.from(document.querySelectorAll("#doc .ks-mermaid-error, #doc pre"), (e) => e.textContent.slice(0, 300)));
    check(before.length === 2, `${engine}: both diagrams drawn`, { figures: before.length, errors: errs });
    if (engine === "mermaid") {
      // Native print (the browser menu) cannot wait for a redraw: once the light SVGs are drawn in the
      // background, beforeprint must show them synchronously, and afterprint the dark ones again.
      await sleep(2500);
      const p = await frame.evaluate(() => {
        const themes = () => Array.from(document.querySelectorAll("#doc figure.ks-mermaid"), (f) => f.dataset.mermaidTheme);
        window.dispatchEvent(new Event("beforeprint"));
        const during = themes();
        window.dispatchEvent(new Event("afterprint"));
        return { during, after: themes() };
      });
      check(p.during.length === 2 && p.during.every((t) => t === "default") && p.after.every((t) => t === "dark"), "mermaid: beforeprint shows the light SVGs at once (kept), afterprint the dark ones", p);
    }
    await page.evaluate(() => __send({ type: "theme", value: "light" }));
    await sleep(1500);   // Mermaid redraws in its light theme; Pele only restyles (the classes are var()s)
    const after = await verify("light", "after a switch to light");
    if (engine === "pele") check(after.every((s, i) => s.svgId && s.svgId === before[i].svgId), "pele: the switch restyles the same SVGs (no redraw)", after.map((s) => s.svgId));
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
