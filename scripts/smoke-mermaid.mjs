#!/usr/bin/env node
// smoke-mermaid.mjs — the diagram engine smoke test of ADR docs/adr/canvas.md §2 and
// canvas-diagram-engine §5: render fixtures in the real canvas frame, under the real sandbox CSP, once
// per engine (Pele, the default, then Mermaid; render{engine}), and fail on any
// `securitypolicyviolation` that is not on the allow-list below. Needs a Chrome, so it is not part of
// `node --test`:
//
//   npm ci && npm run chrome     # once
//   node scripts/smoke-mermaid.mjs [screenshot.png]      # or `npm run smoke` for all of them
//
// (CHROME / PUPPETEER_CORE override the Chrome and puppeteer-core it uses: see scripts/lib/smoke-env.mjs.)
//
// How it is faithful: a local HTTP server serves the repo, and canvas-frame.html with the manifest's
// `content_security_policy.sandbox` as a CSP header (read from manifest.json, so it cannot drift; its
// `sandbox` directive gives the frame an opaque origin like an extension sandbox page), on top of the
// page's own meta CSP. A host page embeds it like canvas.html does (sandbox="allow-scripts
// allow-modals", nonce in the fragment) and drives it with the same render{} messages. Checks:
//   - a markdown canvas with flowchart, sequence, state and class diagrams draws 4 SVGs with the
//     chosen engine, and one bad diagram (which both engines reject) shows both errors inline, posts
//     diagramError{} (not error{}), and the canvas still renders;
//   - a diagram the chosen engine cannot draw (or an engine that does not load) falls back to the
//     other one, with a note on the figure and diagramFallback{}; both failing → diagramError{};
//   - with Pele, a canvas without a bad diagram never loads mermaid; mermaid-only syntax (%%{init}%%,
//     classDef, style, linkStyle) keeps every label under Pele;
//   - a `mermaid` canvas, and a slides canvas with a diagram, render;
//   - each diagram type in KINDS draws with all of mermaid's text kept through the frame's DOMPurify
//     pass (foreignObject labels included), hostile HTML labels keep no handler / script URL, and
//     an engine that fails to load is reported, not hung;
//   - no Worker is constructed (mermaid-tiny has no ELK) and no CSP violation outside the allow-list;
//   - re-renders leave no stray SVG / <style> / mermaid temp nodes behind; print: Mermaid re-themes
//     and back, with edge labels on an opaque white box on paper and the screen ones unchanged; Pele
//     switches to the light CSS variables under print media, with no re-render;
//   - Milkdown's normalization (§3.5) keeps ```mermaid fences as they are.
// The screenshot (default /tmp/ks11-mermaid.png) is the markdown fixture as rendered (Pele; the
// Mermaid run's shots carry "-mermaid" in their name).
// <name>-print.png beside it (or $PRINT_SHOT) is the same fixture as printed: light diagrams with
// edge labels on solid white, plus a small table, under print media.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = process.argv[2] || "/tmp/ks11-mermaid.png";

// Reviewed violations (ADR §2: directive + source file + sample). Empty: none fired in mermaid 12.1.0
// — the four Function("return this") fallbacks sit behind `self` checks and are not reached in a
// browser — nor in Pele 1.12.0.
// A new or changed violation fails until someone reviews it and adds it here.
const ALLOW = [
  // { directive: "script-src", sourceFile: "vendor/mermaid/mermaid.tiny.js", sample: "" },
];

const FIXTURE = `# Mermaid smoke fixture

A flowchart:

\`\`\`mermaid
flowchart LR
  A[Agent] -->|canvas_open| B(Canvas tab)
  B --> C{Has a mermaid fence?}
  C -->|yes| D[Load mermaid-tiny]
  C -->|no| E[Markdown only]
  click A "https://example.com/" "a link"
  click B callback
\`\`\`

A sequence diagram:

\`\`\`mermaid
sequenceDiagram
  participant H as canvas.html
  participant F as canvas-frame.html
  H->>F: render{kind, content}
  F-->>H: rendered{version}
  F-->>H: diagramError{msg}
\`\`\`

A state diagram:

\`\`\`mermaid
stateDiagram-v2
  [*] --> Loading
  Loading --> Rendered
  Loading --> Failed
  Rendered --> [*]
\`\`\`

A class diagram:

\`\`\`mermaid
classDiagram
  class CanvasStore {
    +agentWrite()
    +agentPatch()
  }
  class CanvasFrame {
    +render()
  }
  CanvasStore <.. CanvasFrame : reads via host
\`\`\`

A broken one (must show its error, the rest still renders):

\`\`\`mermaid
flowchart LR
  A -->
\`\`\`

Plain code stays code:

\`\`\`js
const x = 1;
\`\`\`
`;
const MERMAID_CANVAS = "flowchart TD\n  start([Start]) --> work[Work] --> done([Done])\n";
// One per diagram type, each shown as a `mermaid` canvas: every label must survive the frame's
// sanitizing. The last two turn HTML labels back on through a directive (not a secure key).
const KINDS = [
  ["ER", "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n    string id\n  }\n"],
  ["gantt", "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Mermaid :a1, 2026-10-01, 3d\n  Review :after a1, 2d\n"],
  ["pie", "pie title Pets\n  \"Dogs\" : 3\n  \"Cats\" : 2\n"],
  ["timeline", "timeline\n  title History\n  2025 : Katashiro\n  2026 : Canvas : Mermaid\n"],
  ["journey", "journey\n  title A day\n  section Work\n    Write the doc: 5: Me\n    Review: 3: Jelly\n"],
  ["C4", "C4Context\n  Person(u, \"User\", \"Reads canvases\")\n  System(s, \"Katashiro\", \"Side panel\")\n  Rel(u, s, \"uses\")\n"],
  ["venn", "venn-beta\n  set A[\"Apples\"]\n  set B[\"Bananas\"]\n  union A,B[\"Both\"]\n"],
  ["quadrant", "quadrantChart\n  title Effort\n  x-axis Low --> High\n  y-axis Small --> Big\n  Mermaid: [0.3, 0.6]\n"],
  ["gitGraph", "gitGraph\n  commit id: \"base\"\n  branch feat\n  commit id: \"mermaid\"\n  checkout main\n  merge feat\n"],
  ["kanban", "kanban\n  todo[Todo]\n    t1[Write smoke test]\n  done[Done]\n    t2[Vendor mermaid]\n"],
  ["requirement", "requirementDiagram\n  requirement r1 {\n    id: 1\n    text: Draw diagrams\n    risk: low\n    verifymethod: test\n  }\n"],
  ["xychart", "xychart-beta\n  title Sizes\n  x-axis [a, b, c]\n  bar [1, 3, 2]\n"],
  ["flowchart htmlLabels", "%%{init: {\"htmlLabels\": true}}%%\nflowchart LR\n  A[Alpha] --> B[Beta]\n"],
  ["flowchart.htmlLabels", "%%{init: {\"flowchart\": {\"htmlLabels\": true}}}%%\nflowchart LR\n  C[Gamma] -->|edge| D[Delta]\n"],
];
// HTML labels with hostile markup: whatever mermaid lets through, the frame's pass (which allows
// HTML in foreignObject) must leave no handler and no script URL; an HTML link still goes to the host.
const HOSTILE = "%%{init: {\"htmlLabels\": true}}%%\nflowchart LR\n" +
  "  A[\"<img src=data:image/gif;base64,AAAA onerror=alert(1)><b onclick=alert(2)>bold</b>\"] --> B[\"<a href='javascript:alert(3)'>js</a>\"]\n" +
  "  B --> C[\"<a href='https://example.com/fo'>fo link</a>\"]\n" +
  "  C --> D[\"<svg><a href='javascript:alert(4)'><text>s</text></a></svg><math><mi xlink:href='javascript:alert(5)'>m</mi></math>\"]\n";
// Diagram types the mermaid-tiny build does not have: Pele draws them; chosen Mermaid falls back to Pele.
const PELE_ONLY = [
  ["mindmap", "mindmap\n  root((Katashiro))\n    Chat\n    Canvas\n"],
  ["architecture", "architecture-beta\n  group api(cloud)[API]\n  service db(database)[DB] in api\n  service srv(server)[Server] in api\n  db:L -- R:srv\n"],
];
// Mermaid-only styling syntax (#210 review): Pele may skip it without throwing, so there is no
// fallback — every label must still be drawn.
const MERMAID_STYLED = "%%{init: {\"theme\": \"forest\"}}%%\nflowchart LR\n  A[Alpha] --> B[Beta] --> C[Gamma]\n" +
  "  classDef hot fill:#f96,stroke:#333\n  class A hot\n  style B fill:#bbf\n  linkStyle 0 stroke:#f00\n";
const SLIDES = "# Slide one\n\nText\n\n---\n\n## A diagram\n\n```mermaid\nflowchart LR\n  X --> Y --> Z\n```\n";

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222">
<iframe id="md" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0md" style="width:1100px;height:1200px;border:0;display:block"></iframe>
<iframe id="mm" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0mm" style="width:800px;height:500px;border:0;display:block"></iframe>
<iframe id="sl" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0sl" style="width:960px;height:540px;border:0;display:block"></iframe>
<iframe id="nl" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0nl" style="width:600px;height:200px;border:0;display:block"></iframe>
<iframe id="nb" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0nb" style="width:600px;height:200px;border:0;display:block"></iframe>
<iframe id="pm" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0pm" style="width:800px;height:400px;border:0;display:block"></iframe>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => { if (e.data && typeof e.data.nonce === "string") __msgs.push(e.data); });
  window.__send = (id, msg) => document.getElementById(id).contentWindow.postMessage({ ...msg, nonce: "nonce0" + id }, "*");
</script>`;

const ENGINE_FILE = { pele: "/vendor/pele/pele.global.js", mermaid: "/vendor/mermaid/mermaid.tiny.js" };
const failing = new Set();              // engine files answered 404 (section 7)
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // Section 7 makes an engine fail to load for frames that have not loaded it yet.
  if (failing.has(url.pathname)) { res.writeHead(404); res.end(); return; }
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
let tag = "";
const fail = (msg) => { failures.push(`${tag}${msg}`); console.log(`FAIL ${tag}${msg}`); };
const ok = (msg) => console.log(`ok   ${tag}${msg}`);
const NAME = { pele: "Pele", mermaid: "Mermaid" };

async function suite(engine) {
  const other = engine === "pele" ? "mermaid" : "pele";
  const shot = (suffix = "") => SHOT.replace(/\.png$/, `${engine === "pele" ? "" : "-mermaid"}${suffix}.png`);
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  // Injected by CDP into every frame before its scripts (CSP does not apply to it): record CSP
  // violations with their source and sample, and every Worker the page tries to start.
  await page.evaluateOnNewDocument(() => {
    window.__ksViolations = [];
    window.__ksWorkers = 0;
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__ksViolations.push({ directive: e.effectiveDirective || e.violatedDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile, line: e.lineNumber, sample: e.sample });
    });
    for (const name of ["Worker", "SharedWorker"]) {
      const Orig = window[name];
      if (!Orig) continue;
      window[name] = function (...args) { window.__ksWorkers += 1; return new Orig(...args); };
    }
  });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
  const msgs = () => page.evaluate(() => window.__msgs);
  const waitFor = async (pred, what, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const found = (await msgs()).find(pred);
      if (found) return found;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  // Every render of this run goes with the engine under test.
  const send = (id, msg) => page.evaluate((i, m) => __send(i, m), id, { engine, ...msg });
  for (const id of ["md", "mm", "sl", "nl", "nb", "pm"]) await waitFor((m) => m.nonce === `nonce0${id}` && m.type === "ready", `${id} ready`);
  const frameOf = (id) => page.frames().find((f) => f.url().endsWith(`#nonce0${id}`));
  // The header's sandbox directive must have made the frame an opaque origin, like the extension's.
  (await frameOf("md").evaluate(() => self.origin)) === "null" ? ok("frame runs in an opaque origin (sandbox CSP applied)") : fail("frame origin is not opaque");

  // 0. With Pele, a canvas without a bad diagram never loads mermaid's 2.7 MB.
  if (engine === "pele") {
    await send("pm", { type: "render", kind: "mermaid", version: 1, seq: 1, content: MERMAID_CANVAS });
    const r0 = await waitFor((m) => m.nonce === "nonce0pm" && m.type === "rendered", "pele-only canvas rendered");
    const loaded = await frameOf("pm").evaluate(() => ({ pele: typeof window.pele, mermaid: typeof window.mermaid, engine: document.querySelector("#doc figure.ks-mermaid") && document.querySelector("#doc figure.ks-mermaid").dataset.engine }));
    loaded.pele === "object" && loaded.mermaid === "undefined" && loaded.engine === "pele" && JSON.stringify(r0.diagrams) === '[{"engine":"pele","fallback":false}]'
      ? ok("a Pele canvas loads Pele only (no mermaid), rendered{diagrams} says Pele drew it") : fail(`pele-only canvas: ${JSON.stringify({ loaded, diagrams: r0.diagrams })}`);
  }

  // 1. markdown with five fences (one bad) + a js fence.
  await send("md", { type: "render", kind: "markdown", version: 1, seq: 1, content: FIXTURE });
  const r1 = await waitFor((m) => m.nonce === "nonce0md" && m.type === "rendered" && m.version === 1, "markdown rendered");
  const de = await waitFor((m) => m.nonce === "nonce0md" && m.type === "diagramError", "diagramError");
  const md = frameOf("md");
  const shape = () => md.evaluate(() => ({
    figures: document.querySelectorAll("#doc figure.ks-mermaid").length,
    svgs: document.querySelectorAll("#doc figure.ks-mermaid svg").length,
    engines: Array.from(document.querySelectorAll("#doc figure.ks-mermaid"), (f) => f.dataset.engine),
    fallbackNotes: document.querySelectorAll("#doc .ks-mermaid-fallback").length,
    errors: Array.from(document.querySelectorAll("#doc .ks-mermaid-error"), (e) => e.textContent),
    fencesLeft: document.querySelectorAll("#doc pre > code.language-mermaid").length,
    jsFence: !!document.querySelector("#doc pre.hljs code.language-js"),
    styles: document.querySelectorAll("style").length,
    allSvgs: document.querySelectorAll("svg").length,
    bodyChildren: document.body.children.length,
    temp: document.querySelectorAll('[id^="dks-mmd"], [id^="iks-mmd"]').length,
    workers: window.__ksWorkers,
    hasMermaid: typeof window.mermaid === "object",
    elk: !!(window.mermaid && window.mermaid.mermaidAPI && JSON.stringify(window.mermaid.mermaidAPI.getConfig()).includes('"layout":"elk"')),
    theme: window.mermaid && window.mermaid.mermaidAPI.getConfig().theme,
    nodeFill: (() => { const r = document.querySelector('#doc figure.ks-mermaid[data-engine="mermaid"] .node rect'); return r && getComputedStyle(r).fill; })(),
  }));
  const s1 = await shape();
  s1.figures === 4 && s1.svgs === 4 && s1.engines.every((e) => e === engine) && s1.fallbackNotes === 0
    ? ok(`4 diagrams drawn by ${NAME[engine]} (flowchart, sequence, state, class)`) : fail(`expected 4 ${engine} diagrams, got ${JSON.stringify(s1)}`);
  const both = (t) => new RegExp(`^${NAME[engine]} diagram 5:`).test(t) && new RegExp(`\n${NAME[other]} diagram 5:`).test(t);
  s1.errors.length === 1 && both(s1.errors[0]) && s1.fencesLeft === 1 ? ok(`bad diagram shows both engines' errors inline and keeps its source: ${JSON.stringify(s1.errors[0].split("\n")[0])}`) : fail(`bad diagram: ${JSON.stringify(s1)}`);
  both(de.msg) && de.seq === 1 ? ok("diagramError{} reported to the host, with its render's seq (#96)") : fail(`diagramError: ${JSON.stringify(de)}`);
  JSON.stringify(r1.diagrams) === JSON.stringify([...Array(4).fill({ engine, fallback: false }), { engine: "none", fallback: false }])
    ? ok("rendered{diagrams}: 4 by the chosen engine, 1 failed with both") : fail(`rendered{diagrams}: ${JSON.stringify(r1.diagrams)}`);
  (await msgs()).some((m) => m.nonce === "nonce0md" && (m.type === "error" || m.type === "diagramFallback")) ? fail("an error{} or diagramFallback{} was posted") : ok("no error{} / diagramFallback{} posted");
  // No click handlers; a link, if the engine draws one, is an SVG <a> that the frame's capture-phase
  // listener turns into openLink{} (the host asks before opening).
  const clicks = await md.evaluate(() => {
    const fig = document.querySelector("#doc figure.ks-mermaid");
    return { anchors: Array.from(fig.querySelectorAll("a"), (a) => a.getAttribute("href") || a.getAttribute("xlink:href")), handlers: fig.querySelectorAll("[onclick]").length };
  });
  clicks.handlers === 0 ? ok(`click directives: no handlers in the SVG (links: ${JSON.stringify(clicks.anchors)})`) : fail(`onclick in SVG: ${JSON.stringify(clicks)}`);
  if (clicks.anchors.length) {
    await md.evaluate(() => document.querySelector("#doc figure.ks-mermaid a").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    const link = await waitFor((m) => m.nonce === "nonce0md" && m.type === "openLink", "openLink", 5000).catch(() => null);
    const still = await md.evaluate(() => location.pathname);
    link && link.url === "https://example.com/" && still === "/canvas-frame.html" ? ok("a diagram link goes to the host as openLink{} and the frame stays put") : fail(`diagram link: ${JSON.stringify(link)} ${still}`);
  }
  s1.jsFence ? ok("a js fence stays highlighted code") : fail("js fence lost");
  if (engine === "mermaid") s1.theme === "dark" ? ok(`theme dark (node fill ${s1.nodeFill})`) : fail(`theme ${s1.theme}`);
  else {
    const vars = await md.evaluate(() => { const f = document.querySelector('#doc figure.ks-mermaid[data-engine="pele"]'); const cs = getComputedStyle(f); return { bg: cs.getPropertyValue("--pele-bg").trim(), font: cs.getPropertyValue("--pele-font").trim(), body: getComputedStyle(document.body).fontFamily }; });
    vars.bg === "#0f172a" && vars.font === vars.body ? ok(`Pele takes the canvas colours and font (--pele-bg ${vars.bg})`) : fail(`pele vars: ${JSON.stringify(vars)}`);
  }

  // Screenshot: the frame sized to its content.
  const h = await md.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate((hh) => { document.getElementById("md").style.height = `${hh}px`; }, h);
  await new Promise((r) => setTimeout(r, 300));
  await (await page.$("#md")).screenshot({ path: shot() });
  ok(`screenshot ${shot()} (${h}px tall)`);

  // 2. Re-renders: the same and a changed text; nothing must pile up.
  await send("md", { type: "render", kind: "markdown", version: 2, content: FIXTURE });
  await waitFor((m) => m.nonce === "nonce0md" && m.type === "rendered" && m.version === 2, "re-render 2");
  await send("md", { type: "render", kind: "markdown", version: 3, content: FIXTURE.replace("A[Agent]", "A[Agent v3]"), glowPrev: true });
  await waitFor((m) => m.nonce === "nonce0md" && m.type === "rendered" && m.version === 3, "re-render 3");
  const s3 = await shape();
  s3.styles === s1.styles && s3.allSvgs === s1.allSvgs && s3.bodyChildren === s1.bodyChildren && s3.temp === 0 ? ok(`re-renders leak nothing (styles ${s3.styles}, svgs ${s3.allSvgs}, body children ${s3.bodyChildren})`) : fail(`leak after re-render: before ${JSON.stringify(s1)} after ${JSON.stringify(s3)}`);
  const glowing = await md.evaluate(() => Array.from(document.querySelectorAll(".ks-changed"), (e) => e.tagName.toLowerCase() + (e.classList.contains("ks-mermaid") ? ".ks-mermaid" : "")));
  glowing.length === 1 && glowing[0] === "figure.ks-mermaid" ? ok("an agent write that changed one diagram glows that diagram only") : fail(`glow: ${JSON.stringify(glowing)}`);

  // 3. Print. print() is replaced to see what would print.
  if (engine === "mermaid") {
    // Mermaid: light theme for paper, dark again after.
    await md.evaluate(() => {
      window.print = () => {
        const r = document.querySelector("#doc figure.ks-mermaid .node rect"); window.__printFill = r && getComputedStyle(r).fill;
        // Edge labels on paper: a solid white box, or the edge line runs through the text.
        window.__printLabels = Array.from(document.querySelectorAll("#doc figure.ks-mermaid .edgeLabel rect"),
          (e) => `${getComputedStyle(e).fill} ${getComputedStyle(e).opacity}`);
        window.__printDoc = document.getElementById("doc").innerHTML;    // for the print screenshot below
      };
    });
    const screenLabels = await md.evaluate(() => Array.from(document.querySelectorAll("#doc figure.ks-mermaid .edgeLabel rect"),
      (e) => `${getComputedStyle(e).fill} ${getComputedStyle(e).opacity}`));
    await page.evaluate(() => __send("md", { type: "print" }));
    await waitFor((m) => m.nonce === "nonce0md" && m.type === "printed", "printed");
    await new Promise((r) => setTimeout(r, 1500));
    const s4 = await shape();
    const printFill = await md.evaluate(() => window.__printFill);
    printFill && printFill !== s1.nodeFill ? ok(`printed with the light theme (node fill ${printFill})`) : fail(`print theme: node fill ${printFill} (screen ${s1.nodeFill})`);
    s4.theme === "dark" && s4.nodeFill === s1.nodeFill && s4.figures === 4 && s4.styles === s1.styles ? ok("back to dark after printing, nothing leaked") : fail(`after print: ${JSON.stringify(s4)}`);
    const printLabels = await md.evaluate(() => window.__printLabels);
    printLabels.length && printLabels.every((l) => l === "rgb(255, 255, 255) 1") ? ok(`printed edge labels on solid white (${printLabels.length})`) : fail(`print edge labels: ${JSON.stringify(printLabels)}`);
    const darkLabels = await md.evaluate(() => Array.from(document.querySelectorAll("#doc figure.ks-mermaid .edgeLabel rect"),
      (e) => `${getComputedStyle(e).fill} ${getComputedStyle(e).opacity}`));
    darkLabels.length === screenLabels.length && darkLabels.every((l, i) => l === screenLabels[i] && !/^none /.test(l))
      ? ok(`screen edge labels keep their background (${darkLabels[0]})`) : fail(`screen edge labels: ${JSON.stringify(darkLabels)} (before ${JSON.stringify(screenLabels)})`);
  } else {
    // Pele: no re-render (the same SVG nodes), light variables under print media, dark again after.
    await md.evaluate(() => {
      window.__svgsBefore = Array.from(document.querySelectorAll("#doc figure.ks-mermaid svg"));
      window.print = () => { window.__printed = true; };
    });
    await page.evaluate(() => __send("md", { type: "print" }));
    await waitFor((m) => m.nonce === "nonce0md" && m.type === "printed", "printed");
    const same = await md.evaluate(() => Array.from(document.querySelectorAll("#doc figure.ks-mermaid svg")).every((s, i) => s === window.__svgsBefore[i]) && window.__printed === true);
    same ? ok("Pele diagrams print without a re-render (same SVG nodes)") : fail("Pele diagrams were re-rendered for print");
  }
  // The colours as printed, under print media; then back.
  const pv = async () => md.evaluate(() => { const f = document.querySelector('#doc figure.ks-mermaid[data-engine="pele"]'); return f ? getComputedStyle(f).getPropertyValue("--pele-bg").trim() : null; });
  await page.emulateMediaType("print");
  const printBg = await pv();
  if (engine === "pele") printBg === "#ffffff" ? ok("under print media Pele's figures take the light variables (--pele-bg #ffffff)") : fail(`pele print vars: ${printBg}`);
  // Print screenshot: the diagrams as printed, plus a small table, under print media.
  const PRINT_SHOT = process.env.PRINT_SHOT && engine === "pele" ? process.env.PRINT_SHOT : shot("-print");
  await md.evaluate((t) => {
    const d = document.getElementById("doc");
    window.__screenDoc = d.innerHTML;
    if (window.__printDoc) d.innerHTML = window.__printDoc;
    d.insertAdjacentHTML("beforeend", t);
  }, "<table><thead><tr><th>Diagram</th><th>Printed</th></tr></thead><tbody><tr><td>flowchart</td><td>light</td></tr><tr><td>slides</td><td>dark</td></tr></tbody></table>");
  const ph = await md.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate((hh) => { document.getElementById("md").style.height = `${hh}px`; }, ph);
  await new Promise((r) => setTimeout(r, 300));
  await (await page.$("#md")).screenshot({ path: PRINT_SHOT });
  await md.evaluate(() => { document.getElementById("doc").innerHTML = window.__screenDoc; });
  await page.emulateMediaType(null);
  if (engine === "pele") (await pv()) === "#0f172a" ? ok("back on screen: dark variables again") : fail("pele vars stayed light after print media");
  ok(`print screenshot ${PRINT_SHOT}`);

  // 4. Milkdown normalization keeps the fences.
  await send("md", { type: "render", kind: "markdown", version: 4, content: FIXTURE, normalizeText: FIXTURE });
  const n = await waitFor((m) => m.nonce === "nonce0md" && m.type === "rendered" && m.version === 4, "normalized render", 60000);
  const fences = (t) => (String(t).match(/```mermaid\n[\s\S]*?```/g) || []);
  if (typeof n.normalized !== "string") fail("no normalized text came back");
  else JSON.stringify(fences(n.normalized)) === JSON.stringify(fences(FIXTURE)) ? ok(`normalization keeps all ${fences(FIXTURE).length} mermaid fences unchanged`) : fail(`normalization changed fences:\n${n.normalized}`);

  // 5. A mermaid canvas, and slides with a diagram.
  await send("mm", { type: "render", kind: "mermaid", version: 1, content: MERMAID_CANVAS });
  await waitFor((m) => m.nonce === "nonce0mm" && m.type === "rendered", "mermaid canvas rendered");
  const mm = await frameOf("mm").evaluate((e) => document.querySelectorAll(`#doc figure.ks-mermaid[data-engine="${e}"] svg`).length, engine);
  mm === 1 ? ok("kind mermaid renders its diagram") : fail(`kind mermaid: ${mm} svgs`);
  await send("sl", { type: "render", kind: "slides", version: 1, content: SLIDES });
  await waitFor((m) => m.nonce === "nonce0sl" && m.type === "rendered", "slides rendered");
  const sl = await frameOf("sl").evaluate(() => document.querySelectorAll(".slides section figure.ks-mermaid svg").length);
  sl === 1 ? ok("a mermaid fence on a slide renders") : fail(`slides: ${sl} svgs`);
  if (engine === "pele") {
    const deckBg = await frameOf("sl").evaluate(() => getComputedStyle(document.querySelector(".slides figure.ks-mermaid")).getPropertyValue("--pele-bg").trim());
    deckBg === "#191919" ? ok("on a slide Pele sits on the deck's background (--pele-bg #191919)") : fail(`deck --pele-bg ${deckBg}`);
  }
  await page.evaluate(() => __send("sl", { type: "goto", slide: 2 }));
  await waitFor((m) => m.nonce === "nonce0sl" && m.type === "slide", "slide 2");
  await new Promise((r) => setTimeout(r, 800));
  await (await page.$("#sl")).screenshot({ path: shot("-slide") });
  await (await page.$("#mm")).screenshot({ path: shot("-kind") });

  // 6. Every diagram type the tool description names (and a few more) draws with all its text: the
  // frame's DOMPurify pass must not drop a label (a <foreignObject> one, say) that the engine drew.
  // Compared with the same source through the engine alone, <style> left out of both.
  const mmFrame = frameOf("mm");
  const drawAndCompare = async (name, source, version, want) => {
    await page.evaluate(() => { window.__msgs = window.__msgs.filter((m) => m.nonce !== "nonce0mm" || (m.type !== "diagramError" && m.type !== "diagramFallback")); });
    await send("mm", { type: "render", kind: "mermaid", version, content: source });
    const rr = await waitFor((m) => m.nonce === "nonce0mm" && m.type === "rendered" && m.version === version, `${name} rendered`);
    const errMsg = (await msgs()).find((m) => m.nonce === "nonce0mm" && m.type === "diagramError");
    const fb = (await msgs()).find((m) => m.nonce === "nonce0mm" && m.type === "diagramFallback");
    const r = await mmFrame.evaluate(async (src) => {
      const text = (root) => { const c = root.cloneNode(true); c.querySelectorAll("style, .copy-btn").forEach((e) => e.remove()); return c.textContent.replace(/\s+/g, " ").trim(); };
      const figEl = document.querySelector("#doc figure.ks-mermaid");
      const fig = figEl && figEl.querySelector(".ks-mermaid-svg");
      if (!fig) return { drawn: false };
      const by = figEl.dataset.engine;
      const t = document.createElement("template");
      t.innerHTML = by === "pele" ? window.pele.render(src, { fontFamily: getComputedStyle(document.body).fontFamily, images: false }).svg : (await window.mermaid.render("probe-raw", src)).svg;
      return { drawn: true, by, note: figEl.querySelector(".ks-mermaid-fallback") ? figEl.querySelector(".ks-mermaid-fallback").textContent : "", shown: text(fig), raw: text(t.content), fo: fig.querySelectorAll("foreignObject").length };
    }, source);
    if (errMsg || !r.drawn) { fail(`${name}: not drawn (${errMsg ? errMsg.msg.split("\n")[0] : "no figure"})`); return null; }
    if (r.by !== want) { fail(`${name}: drawn by ${r.by}, expected ${want}${r.note ? ` (${r.note})` : ""}`); return null; }
    if (!r.raw) { fail(`${name}: ${r.by} drew no text at all`); return null; }
    r.shown === r.raw ? ok(`${name}: all text kept (${r.raw.length} chars${r.fo ? `, ${r.fo} foreignObject` : ""}, by ${NAME[r.by]})`) : fail(`${name}: text lost in sanitizing\n  ${r.by}: ${r.raw.slice(0, 200)}\n  shown:   ${r.shown.slice(0, 200)}`);
    return { ...r, fb, diagrams: rr.diagrams };
  };
  for (const [i, [name, source]] of KINDS.entries()) await drawAndCompare(name, source, 10 + i, engine);
  // Types mermaid-tiny lacks: Pele draws them; chosen Mermaid falls back to Pele, with a note.
  for (const [i, [name, source]] of PELE_ONLY.entries()) {
    const r = await drawAndCompare(name, source, 30 + i, "pele");
    if (!r) continue;
    if (engine === "pele") !r.note && !r.fb ? ok(`${name}: drawn by Pele directly`) : fail(`${name}: unexpected fallback ${JSON.stringify(r.note)}`);
    else r.note.startsWith("以 Pele 繪製（Mermaid diagram 1:") && r.fb && /^Mermaid diagram 1: .* → drawn by Pele$/s.test(r.fb.msg) && JSON.stringify(r.diagrams) === '[{"engine":"pele","fallback":true}]'
      ? ok(`${name}: Mermaid cannot, Pele drew it as the fallback — note ${JSON.stringify(r.note.slice(0, 60))}, diagramFallback{} sent`)
      : fail(`${name}: fallback ${JSON.stringify({ note: r.note, fb: r.fb, diagrams: r.diagrams })}`);
  }
  // Mermaid-only styling under Pele: no throw (so no fallback), and every label still drawn.
  if (engine === "pele") {
    const r = await drawAndCompare("mermaid-only styling", MERMAID_STYLED, 40, "pele");
    if (r) ["Alpha", "Beta", "Gamma"].every((w) => r.shown.includes(w)) && !r.fb ? ok("%%{init}%% / classDef / style / linkStyle: Pele keeps every label (styling itself may be ignored)") : fail(`mermaid-only styling: ${JSON.stringify(r.shown)}`);
  }

  // 6b. Hostile HTML labels (htmlLabels on: mermaid puts them in foreignObject; Pele draws text).
  await send("mm", { type: "render", kind: "mermaid", version: 50, content: HOSTILE });
  await waitFor((m) => m.nonce === "nonce0mm" && m.type === "rendered" && m.version === 50, "hostile rendered");
  const hz = await mmFrame.evaluate(() => {
    const box = document.querySelector("#doc figure.ks-mermaid .ks-mermaid-svg");
    if (!box) return null;
    const all = Array.from(box.querySelectorAll("*"));
    return {
      by: box.parentElement.dataset.engine,
      fo: box.querySelectorAll("foreignObject").length,
      handlers: all.flatMap((e) => Array.from(e.attributes, (a) => a.name)).filter((n) => /^on/i.test(n)),
      scriptUrls: all.flatMap((e) => Array.from(e.attributes, (a) => a.value)).filter((v) => /^\s*(java|vb)script:/i.test(v)),
      foLinks: Array.from(box.querySelectorAll("foreignObject a"), (a) => a.getAttribute("href")),
      text: box.textContent.replace(/\s+/g, " "),
    };
  });
  if (!hz) fail("hostile: not drawn");
  else if (hz.by !== engine) fail(`hostile: drawn by ${hz.by}`);
  else if (hz.handlers.length || hz.scriptUrls.length) fail(`hostile labels: ${JSON.stringify(hz)}`);
  else if (engine === "mermaid" && !hz.fo) fail(`hostile labels: no foreignObject: ${JSON.stringify(hz)}`);
  else ok(`hostile labels: ${hz.fo} foreignObject, no on* attribute, no script URL (links ${JSON.stringify(hz.foLinks)})`);
  if (engine === "mermaid") {
    if (hz && hz.foLinks.includes("https://example.com/fo")) {
      await page.evaluate(() => { window.__msgs = window.__msgs.filter((m) => m.type !== "openLink"); });
      await mmFrame.evaluate(() => Array.from(document.querySelectorAll("#doc foreignObject a")).find((a) => a.getAttribute("href") === "https://example.com/fo").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
      const fl = await waitFor((m) => m.nonce === "nonce0mm" && m.type === "openLink", "foreignObject openLink", 5000).catch(() => null);
      const still = await mmFrame.evaluate(() => location.pathname);
      fl && fl.url === "https://example.com/fo" && still === "/canvas-frame.html" ? ok("an HTML link in a foreignObject goes to the host as openLink{}, the frame stays put") : fail(`foreignObject link: ${JSON.stringify(fl)} ${still}`);
    } else fail(`hostile: the https link in a foreignObject was not kept: ${JSON.stringify(hz && hz.foLinks)}`);
  }

  // 7. Engines that do not load (frames that have not loaded them yet). The chosen one failing: the
  // other draws every diagram, with a note and one diagramFallback{}. Both failing: every fence keeps
  // its source with both errors, diagramError{}, and the render still completes.
  const LOADFAIL = "# x\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\npie\n  \"a\" : 1\n```\n";
  failing.add(ENGINE_FILE[engine]);
  await send("nl", { type: "render", kind: "markdown", version: 7, seq: 7, content: LOADFAIL });
  const nlDone = await waitFor((m) => m.nonce === "nonce0nl" && m.type === "rendered" && m.version === 7, "rendered without the chosen engine");
  const nlFb = await waitFor((m) => m.nonce === "nonce0nl" && m.type === "diagramFallback", "diagramFallback without the chosen engine", 5000).catch(() => null);
  const nl = await frameOf("nl").evaluate(() => ({ by: Array.from(document.querySelectorAll("#doc figure.ks-mermaid"), (f) => f.dataset.engine), notes: Array.from(document.querySelectorAll("#doc .ks-mermaid-fallback"), (e) => e.textContent), errors: document.querySelectorAll("#doc .ks-mermaid-error").length }));
  nlFb && nlFb.seq === 7 && new RegExp(`^${NAME[engine]} diagram 1: ${NAME[engine]} failed to load → drawn by ${NAME[other]}`).test(nlFb.msg) && nl.by.join() === `${other},${other}` && nl.notes.length === 2 && nl.errors === 0 && !(await msgs()).some((m) => m.nonce === "nonce0nl" && m.type === "diagramError")
    ? ok(`${NAME[engine]} does not load: ${NAME[other]} drew both diagrams, each noted (${JSON.stringify(nl.notes[0])})`) : fail(`chosen engine load failure: ${JSON.stringify({ nlFb, nl, diagrams: nlDone.diagrams })}`);
  failing.add(ENGINE_FILE[other]);
  await send("nb", { type: "render", kind: "markdown", version: 8, seq: 8, content: LOADFAIL });
  await waitFor((m) => m.nonce === "nonce0nb" && m.type === "rendered" && m.version === 8, "rendered without either engine");
  const nbErr = await waitFor((m) => m.nonce === "nonce0nb" && m.type === "diagramError", "diagramError without either engine", 5000).catch(() => null);
  failing.clear();
  const nb = await frameOf("nb").evaluate(() => ({ notes: Array.from(document.querySelectorAll("#doc .ks-mermaid-error"), (e) => e.textContent), fences: document.querySelectorAll("#doc pre > code.language-mermaid").length }));
  nbErr && nbErr.seq === 8 && new RegExp(`^${NAME[engine]} diagram 1: ${NAME[engine]} failed to load\n${NAME[other]} diagram 1: ${NAME[other]} failed to load`).test(nbErr.msg) && nb.notes.length === 2 && nb.fences === 2
    ? ok("neither engine loads: both fences kept with both errors, one diagramError{}") : fail(`both engines fail to load: ${JSON.stringify({ nbErr, nb })}`);

  // 8. Worker / ELK, and CSP violations in every frame. First a control: the recorder must be in
  // each canvas frame, and must see a violation we cause on purpose (img-src allows data:/blob: only).
  const CONTROL = "http://control.invalid/x.png";
  await md.evaluate((u) => { const i = document.createElement("img"); i.src = u; document.body.appendChild(i); }, CONTROL);
  await new Promise((r) => setTimeout(r, 500));
  for (const id of ["md", "mm", "sl", "nl", "nb", "pm"]) {
    if (!(await frameOf(id).evaluate(() => Array.isArray(window.__ksViolations)))) fail(`violation recorder missing in frame ${id}`);
  }
  let workers = 0;
  const violations = [];
  let controlSeen = false;
  for (const fr of page.frames()) {
    const r = await fr.evaluate((u) => ({ v: (window.__ksViolations || []).filter((x) => x.blockedURI !== u), c: (window.__ksViolations || []).some((x) => x.blockedURI === u), w: window.__ksWorkers || 0 }), CONTROL);
    controlSeen = controlSeen || r.c;
    workers += r.w;
    for (const v of r.v) violations.push({ frame: fr.url().replace(origin, ""), ...v, sourceFile: String(v.sourceFile || "").replace(origin + "/", "") });
  }
  controlSeen ? ok("control: the recorder sees a violation caused on purpose") : fail("control violation not recorded: the recorder is blind");
  workers === 0 ? ok("no Worker constructed") : fail(`${workers} Worker(s) constructed`);
  if (s1.hasMermaid) s1.elk ? fail("mermaid config asks for ELK") : ok("layout: dagre (mermaid-tiny registers dagre + swimlane only, no ELK)");
  const allowed = (v) => ALLOW.some((a) => a.directive === v.directive && v.sourceFile.endsWith(a.sourceFile) && (a.sample || "") === (v.sample || ""));
  const bad = violations.filter((v) => !allowed(v));
  console.log(`CSP violations: ${violations.length} (${violations.length - bad.length} allow-listed)`);
  for (const v of violations) console.log(`  ${allowed(v) ? "allowed" : "NEW    "} ${JSON.stringify(v)}`);
  if (bad.length) fail(`${bad.length} CSP violation(s) not on the allow-list`);
  const frameErrors = (await msgs()).filter((m) => m.type === "error" && !String(m.msg).includes("control.invalid"));
  if (frameErrors.length) fail(`frame error{} messages: ${JSON.stringify(frameErrors)}`);
  await page.close();
}

try {
  for (const engine of ["pele", "mermaid"]) {
    tag = `[${engine}] `;
    console.log(`\n--- engine: ${NAME[engine]} ---`);
    try { await suite(engine); } catch (e) { fail(e && e.stack || String(e)); }
  }
  tag = "";
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nmermaid smoke test passed");
process.exit(failures.length ? 1 : 0);
