#!/usr/bin/env node
// smoke-mermaid.mjs — the mermaid engine smoke test of ADR docs/adr/canvas.md §2: render a fixture in
// the real canvas frame, under the real sandbox CSP, and fail on any `securitypolicyviolation` that
// is not on the allow-list below. Needs a Chrome, so it is not part of `node --test`:
//
//   npm ci && npm run chrome     # once
//   node scripts/smoke-mermaid.mjs [screenshot.png]      # or `npm run smoke` for all of them
//
// (CHROME / PUPPETEER_CORE override the Chrome and puppeteer-core it uses: see scripts/smoke-env.mjs.)
//
// How it is faithful: a local HTTP server serves the repo, and canvas-frame.html with the manifest's
// `content_security_policy.sandbox` as a CSP header (read from manifest.json, so it cannot drift; its
// `sandbox` directive gives the frame an opaque origin like an extension sandbox page), on top of the
// page's own meta CSP. A host page embeds it like canvas.html does (sandbox="allow-scripts
// allow-modals", nonce in the fragment) and drives it with the same render{} messages. Checks:
//   - a markdown canvas with flowchart, sequence, state and class diagrams draws 4 SVGs, and one bad
//     diagram shows its error inline, posts diagramError{} (not error{}), and the canvas still renders;
//   - a `mermaid` canvas, and a slides canvas with a diagram, render;
//   - each diagram type in KINDS draws with all of mermaid's text kept through the frame's DOMPurify
//     pass (foreignObject labels included), hostile HTML labels keep no handler / script URL, and
//     an engine that fails to load is reported, not hung;
//   - no Worker is constructed (mermaid-tiny has no ELK) and no CSP violation outside the allow-list;
//   - re-renders leave no stray SVG / <style> / mermaid temp nodes behind; print re-themes and back,
//     with edge labels on an opaque white box on paper and the screen ones unchanged;
//   - Milkdown's normalization (§3.5) keeps ```mermaid fences as they are.
// The screenshot (default /tmp/ks11-mermaid.png) is the markdown fixture as rendered.
// <name>-print.png beside it (or $PRINT_SHOT) is the same fixture as printed: light diagrams with
// edge labels on solid white, plus a small table, under print media.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = process.argv[2] || "/tmp/ks11-mermaid.png";

// Reviewed violations (ADR §2: directive + source file + sample). Empty: none fired in 12.1.0 — the
// four Function("return this") fallbacks sit behind `self` checks and are not reached in a browser.
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
const SLIDES = "# Slide one\n\nText\n\n---\n\n## A diagram\n\n```mermaid\nflowchart LR\n  X --> Y --> Z\n```\n";

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222">
<iframe id="md" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0md" style="width:1100px;height:1200px;border:0;display:block"></iframe>
<iframe id="mm" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0mm" style="width:800px;height:500px;border:0;display:block"></iframe>
<iframe id="sl" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0sl" style="width:960px;height:540px;border:0;display:block"></iframe>
<iframe id="nl" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0nl" style="width:600px;height:200px;border:0;display:block"></iframe>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => { if (e.data && typeof e.data.nonce === "string") __msgs.push(e.data); });
  window.__send = (id, msg) => document.getElementById(id).contentWindow.postMessage({ ...msg, nonce: "nonce0" + id }, "*");
</script>`;

let failMermaid = false;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  // Section 7 makes the engine fail to load for the "nl" frame (the only one that has not loaded it).
  if (url.pathname === "/vendor/mermaid/mermaid.tiny.js" && failMermaid) { res.writeHead(404); res.end(); return; }
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
try {
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
  for (const id of ["md", "mm", "sl", "nl"]) await waitFor((m) => m.nonce === `nonce0${id}` && m.type === "ready", `${id} ready`);
  const frameOf = (id) => page.frames().find((f) => f.url().endsWith(`#nonce0${id}`));
  // The header's `sandbox` directive must have made the frame an opaque origin, like the extension's.
  (await frameOf("md").evaluate(() => self.origin)) === "null" ? ok("frame runs in an opaque origin (sandbox CSP applied)") : fail("frame origin is not opaque");

  // 1. markdown with five fences (one bad) + a js fence.
  await page.evaluate((c) => __send("md", { type: "render", kind: "markdown", version: 1, seq: 1, content: c }), FIXTURE);
  await waitFor((m) => m.nonce === "nonce0md" && m.type === "rendered" && m.version === 1, "markdown rendered");
  const de = await waitFor((m) => m.nonce === "nonce0md" && m.type === "diagramError", "diagramError");
  const md = frameOf("md");
  const shape = () => md.evaluate(() => ({
    figures: document.querySelectorAll("#doc figure.ks-mermaid").length,
    svgs: document.querySelectorAll("#doc figure.ks-mermaid svg").length,
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
    nodeFill: (() => { const r = document.querySelector("#doc figure.ks-mermaid .node rect"); return r && getComputedStyle(r).fill; })(),
  }));
  const s1 = await shape();
  s1.figures === 4 && s1.svgs === 4 ? ok("4 diagrams drawn (flowchart, sequence, state, class)") : fail(`expected 4 diagrams, got ${JSON.stringify(s1)}`);
  s1.errors.length === 1 && /mermaid diagram 5:/.test(s1.errors[0]) && s1.fencesLeft === 1 ? ok(`bad diagram shows its error inline and keeps its source: ${JSON.stringify(s1.errors[0].split("\n")[0])}`) : fail(`bad diagram: ${JSON.stringify(s1)}`);
  /mermaid diagram 5:/.test(de.msg) && de.seq === 1 ? ok("diagramError{} reported to the host, with its render's seq (#96)") : fail(`diagramError: ${JSON.stringify(de)}`);
  (await msgs()).some((m) => m.nonce === "nonce0md" && m.type === "error") ? fail("an error{} was posted (would mark the render failed)") : ok("no error{} posted");
  // securityLevel 'strict': no click handlers; a link, if mermaid draws one, is an SVG <a> that the
  // frame's capture-phase listener turns into openLink{} (the host asks before opening).
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
  s1.theme === "dark" ? ok(`theme dark (node fill ${s1.nodeFill})`) : fail(`theme ${s1.theme}`);

  // Screenshot: the frame sized to its content.
  const h = await md.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate((hh) => { document.getElementById("md").style.height = `${hh}px`; }, h);
  await new Promise((r) => setTimeout(r, 300));
  await (await page.$("#md")).screenshot({ path: SHOT });
  ok(`screenshot ${SHOT} (${h}px tall)`);

  // 2. Re-renders: the same and a changed text; nothing must pile up.
  await page.evaluate((c) => __send("md", { type: "render", kind: "markdown", version: 2, content: c }), FIXTURE);
  await waitFor((m) => m.nonce === "nonce0md" && m.type === "rendered" && m.version === 2, "re-render 2");
  await page.evaluate((c) => __send("md", { type: "render", kind: "markdown", version: 3, content: c, glowPrev: true }), FIXTURE.replace("A[Agent]", "A[Agent v3]"));
  await waitFor((m) => m.nonce === "nonce0md" && m.type === "rendered" && m.version === 3, "re-render 3");
  const s3 = await shape();
  s3.styles === s1.styles && s3.allSvgs === s1.allSvgs && s3.bodyChildren === s1.bodyChildren && s3.temp === 0 ? ok(`re-renders leak nothing (styles ${s3.styles}, svgs ${s3.allSvgs}, body children ${s3.bodyChildren})`) : fail(`leak after re-render: before ${JSON.stringify(s1)} after ${JSON.stringify(s3)}`);
  const glowing = await md.evaluate(() => Array.from(document.querySelectorAll(".ks-changed"), (e) => e.tagName.toLowerCase() + (e.classList.contains("ks-mermaid") ? ".ks-mermaid" : "")));
  glowing.length === 1 && glowing[0] === "figure.ks-mermaid" ? ok("an agent write that changed one diagram glows that diagram only") : fail(`glow: ${JSON.stringify(glowing)}`);

  // 3. Print: light theme for paper, dark again after. print() is replaced to see what would print.
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
  // Print screenshot: the light SVGs as printed, under print media (tables, labels), then back.
  const PRINT_SHOT = process.env.PRINT_SHOT || SHOT.replace(/\.png$/, "-print.png");
  await page.emulateMediaType("print");
  await md.evaluate((t) => {
    const d = document.getElementById("doc");
    window.__screenDoc = d.innerHTML;
    d.innerHTML = window.__printDoc;
    d.insertAdjacentHTML("beforeend", t);
  }, "<table><thead><tr><th>Diagram</th><th>Printed</th></tr></thead><tbody><tr><td>flowchart</td><td>light</td></tr><tr><td>slides</td><td>dark</td></tr></tbody></table>");
  const ph = await md.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate((hh) => { document.getElementById("md").style.height = `${hh}px`; }, ph);
  await new Promise((r) => setTimeout(r, 300));
  await (await page.$("#md")).screenshot({ path: PRINT_SHOT });
  await md.evaluate(() => { document.getElementById("doc").innerHTML = window.__screenDoc; });
  await page.emulateMediaType(null);
  ok(`print screenshot ${PRINT_SHOT}`);

  // 4. Milkdown normalization keeps the fences.
  await page.evaluate((c) => __send("md", { type: "render", kind: "markdown", version: 4, content: c, normalizeText: c }), FIXTURE);
  const n = await waitFor((m) => m.nonce === "nonce0md" && m.type === "rendered" && m.version === 4, "normalized render", 60000);
  const fences = (t) => (String(t).match(/```mermaid\n[\s\S]*?```/g) || []);
  if (typeof n.normalized !== "string") fail("no normalized text came back");
  else JSON.stringify(fences(n.normalized)) === JSON.stringify(fences(FIXTURE)) ? ok(`normalization keeps all ${fences(FIXTURE).length} mermaid fences unchanged`) : fail(`normalization changed fences:\n${n.normalized}`);

  // 5. A mermaid canvas, and slides with a diagram.
  await page.evaluate((c) => __send("mm", { type: "render", kind: "mermaid", version: 1, content: c }), MERMAID_CANVAS);
  await waitFor((m) => m.nonce === "nonce0mm" && m.type === "rendered", "mermaid canvas rendered");
  const mm = await frameOf("mm").evaluate(() => document.querySelectorAll("#doc figure.ks-mermaid svg").length);
  mm === 1 ? ok("kind mermaid renders its diagram") : fail(`kind mermaid: ${mm} svgs`);
  await page.evaluate((c) => __send("sl", { type: "render", kind: "slides", version: 1, content: c }), SLIDES);
  await waitFor((m) => m.nonce === "nonce0sl" && m.type === "rendered", "slides rendered");
  const sl = await frameOf("sl").evaluate(() => document.querySelectorAll(".slides section figure.ks-mermaid svg").length);
  sl === 1 ? ok("a mermaid fence on a slide renders") : fail(`slides: ${sl} svgs`);
  await page.evaluate(() => __send("sl", { type: "goto", slide: 2 }));
  await waitFor((m) => m.nonce === "nonce0sl" && m.type === "slide", "slide 2");
  await new Promise((r) => setTimeout(r, 800));
  await (await page.$("#sl")).screenshot({ path: SHOT.replace(/\.png$/, "-slide.png") });
  await (await page.$("#mm")).screenshot({ path: SHOT.replace(/\.png$/, "-kind.png") });

  // 6. Every diagram type the tool description names (and a few more) draws with all its text: the
  // frame's DOMPurify pass must not drop a label (a <foreignObject> one, say) that mermaid drew.
  // Compared with the same source through mermaid.render alone, <style> left out of both.
  const mmFrame = frameOf("mm");
  for (const [i, [name, source]] of KINDS.entries()) {
    const version = 10 + i;
    await page.evaluate((c, v) => { window.__msgs = window.__msgs.filter((m) => m.nonce !== "nonce0mm" || m.type !== "diagramError"); __send("mm", { type: "render", kind: "mermaid", version: v, content: c }); }, source, version);
    await waitFor((m) => m.nonce === "nonce0mm" && m.type === "rendered" && m.version === version, `${name} rendered`);
    const errMsg = (await msgs()).find((m) => m.nonce === "nonce0mm" && m.type === "diagramError");
    const r = await mmFrame.evaluate(async (src) => {
      const text = (root) => { const c = root.cloneNode(true); c.querySelectorAll("style, .copy-btn").forEach((e) => e.remove()); return c.textContent.replace(/\s+/g, " ").trim(); };
      const fig = document.querySelector("#doc figure.ks-mermaid .ks-mermaid-svg");
      if (!fig) return { drawn: false };
      const t = document.createElement("template");
      t.innerHTML = (await window.mermaid.render("probe-raw", src)).svg;
      return { drawn: true, shown: text(fig), raw: text(t.content), fo: fig.querySelectorAll("foreignObject").length };
    }, source);
    if (errMsg || !r.drawn) fail(`${name}: not drawn (${errMsg ? errMsg.msg.split("\n")[0] : "no figure"})`);
    else if (!r.raw) fail(`${name}: mermaid drew no text at all`);
    else r.shown === r.raw ? ok(`${name}: all text kept (${r.raw.length} chars${r.fo ? `, ${r.fo} foreignObject` : ""})`) : fail(`${name}: text lost in sanitizing\n  mermaid: ${r.raw.slice(0, 200)}\n  shown:   ${r.shown.slice(0, 200)}`);
  }

  // 6b. Hostile HTML labels (htmlLabels on, so they sit in foreignObject).
  await page.evaluate((c) => __send("mm", { type: "render", kind: "mermaid", version: 50, content: c }), HOSTILE);
  await waitFor((m) => m.nonce === "nonce0mm" && m.type === "rendered" && m.version === 50, "hostile rendered");
  const hz = await mmFrame.evaluate(() => {
    const box = document.querySelector("#doc figure.ks-mermaid .ks-mermaid-svg");
    if (!box) return null;
    const all = Array.from(box.querySelectorAll("*"));
    return {
      fo: box.querySelectorAll("foreignObject").length,
      handlers: all.flatMap((e) => Array.from(e.attributes, (a) => a.name)).filter((n) => /^on/i.test(n)),
      scriptUrls: all.flatMap((e) => Array.from(e.attributes, (a) => a.value)).filter((v) => /^\s*(java|vb)script:/i.test(v)),
      foLinks: Array.from(box.querySelectorAll("foreignObject a"), (a) => a.getAttribute("href")),
      text: box.textContent.replace(/\s+/g, " "),
    };
  });
  !hz ? fail("hostile: not drawn")
    : hz.fo && !hz.handlers.length && !hz.scriptUrls.length ? ok(`hostile labels: ${hz.fo} foreignObject, no on* attribute, no script URL (links ${JSON.stringify(hz.foLinks)})`)
    : fail(`hostile labels: ${JSON.stringify(hz)}`);
  if (hz && hz.foLinks.includes("https://example.com/fo")) {
    await page.evaluate(() => { window.__msgs = window.__msgs.filter((m) => m.type !== "openLink"); });
    await mmFrame.evaluate(() => Array.from(document.querySelectorAll("#doc foreignObject a")).find((a) => a.getAttribute("href") === "https://example.com/fo").dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    const fl = await waitFor((m) => m.nonce === "nonce0mm" && m.type === "openLink", "foreignObject openLink", 5000).catch(() => null);
    const still = await mmFrame.evaluate(() => location.pathname);
    fl && fl.url === "https://example.com/fo" && still === "/canvas-frame.html" ? ok("an HTML link in a foreignObject goes to the host as openLink{}, the frame stays put") : fail(`foreignObject link: ${JSON.stringify(fl)} ${still}`);
  } else fail(`hostile: the https link in a foreignObject was not kept: ${JSON.stringify(hz && hz.foLinks)}`);

  // 7. The engine does not load (a frame that has not loaded it yet): every fence keeps its source
  // with a note, one diagramError{} without a diagram number, and the render still completes.
  failMermaid = true;
  await page.evaluate(() => __send("nl", { type: "render", kind: "markdown", version: 7, seq: 7, content: "# x\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\npie\n  \"a\" : 1\n```\n" }));
  await waitFor((m) => m.nonce === "nonce0nl" && m.type === "rendered" && m.version === 7, "rendered without the engine");
  const nlErr = await waitFor((m) => m.nonce === "nonce0nl" && m.type === "diagramError", "diagramError without the engine", 5000).catch(() => null);
  failMermaid = false;
  const nl = await frameOf("nl").evaluate(() => ({ notes: Array.from(document.querySelectorAll("#doc .ks-mermaid-error"), (e) => e.textContent), fences: document.querySelectorAll("#doc pre > code.language-mermaid").length }));
  nlErr && nlErr.seq === 7 && /^mermaid: mermaid failed to load$/.test(nlErr.msg) && nl.notes.length === 2 && nl.fences === 2
    ? ok(`engine load failure: ${JSON.stringify(nlErr.msg)}, both fences kept with a note`) : fail(`engine load failure: ${JSON.stringify({ nlErr, nl })}`);

  // 8. Worker / ELK, and CSP violations in every frame. First a control: the recorder must be in
  // each canvas frame, and must see a violation we cause on purpose (img-src allows data:/blob: only).
  const CONTROL = "http://control.invalid/x.png";
  await md.evaluate((u) => { const i = document.createElement("img"); i.src = u; document.body.appendChild(i); }, CONTROL);
  await new Promise((r) => setTimeout(r, 500));
  for (const id of ["md", "mm", "sl", "nl"]) {
    if (!(await frameOf(id).evaluate(() => Array.isArray(window.__ksViolations)))) fail(`violation recorder missing in frame ${id}`);
  }
  let workers = 0;
  const violations = [];
  let controlSeen = false;
  for (const f of page.frames()) {
    const r = await f.evaluate((u) => ({ v: (window.__ksViolations || []).filter((x) => x.blockedURI !== u), c: (window.__ksViolations || []).some((x) => x.blockedURI === u), w: window.__ksWorkers || 0 }), CONTROL);
    controlSeen = controlSeen || r.c;
    workers += r.w;
    for (const v of r.v) violations.push({ frame: f.url().replace(origin, ""), ...v, sourceFile: String(v.sourceFile || "").replace(origin + "/", "") });
  }
  controlSeen ? ok("control: the recorder sees a violation caused on purpose") : fail("control violation not recorded: the recorder is blind");
  workers === 0 ? ok("no Worker constructed") : fail(`${workers} Worker(s) constructed`);
  s1.elk ? fail("mermaid config asks for ELK") : ok("layout: dagre (mermaid-tiny registers dagre + swimlane only, no ELK)");
  const allowed = (v) => ALLOW.some((a) => a.directive === v.directive && v.sourceFile.endsWith(a.sourceFile) && (a.sample || "") === (v.sample || ""));
  const bad = violations.filter((v) => !allowed(v));
  console.log(`CSP violations: ${violations.length} (${violations.length - bad.length} allow-listed)`);
  for (const v of violations) console.log(`  ${allowed(v) ? "allowed" : "NEW    "} ${JSON.stringify(v)}`);
  if (bad.length) fail(`${bad.length} CSP violation(s) not on the allow-list`);
  const frameErrors = (await msgs()).filter((m) => m.type === "error" && !String(m.msg).includes("control.invalid"));
  if (frameErrors.length) fail(`frame error{} messages: ${JSON.stringify(frameErrors)}`);
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nmermaid smoke test passed");
process.exit(failures.length ? 1 : 0);
