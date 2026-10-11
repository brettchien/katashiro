#!/usr/bin/env node
// smoke-mermaid.mjs — the mermaid engine smoke test of ADR docs/adr/canvas.md §2: render a fixture in
// the real canvas frame, under the real sandbox CSP, and fail on any `securitypolicyviolation` that
// is not on the allow-list below. Needs a Chrome, so it is not part of `node --test`:
//
//   CHROME=/path/to/chrome-headless-shell PUPPETEER_CORE=/path/to/node_modules/puppeteer-core \
//     node scripts/smoke-mermaid.mjs [screenshot.png]
//
// How it is faithful: a local HTTP server serves the repo, and canvas-frame.html with the manifest's
// `content_security_policy.sandbox` as a CSP header (read from manifest.json, so it cannot drift; its
// `sandbox` directive gives the frame an opaque origin like an extension sandbox page), on top of the
// page's own meta CSP. A host page embeds it like canvas.html does (sandbox="allow-scripts
// allow-modals", nonce in the fragment) and drives it with the same render{} messages. Checks:
//   - a markdown canvas with flowchart, sequence, state and class diagrams draws 4 SVGs, and one bad
//     diagram shows its error inline, posts diagramError{} (not error{}), and the canvas still renders;
//   - a `mermaid` canvas, and a slides canvas with a diagram, render;
//   - no Worker is constructed (mermaid-tiny has no ELK) and no CSP violation outside the allow-list;
//   - re-renders leave no stray SVG / <style> / mermaid temp nodes behind; print re-themes and back;
//   - Milkdown's normalization (§3.5) keeps ```mermaid fences as they are.
// The screenshot (default /tmp/ks11-mermaid.png) is the markdown fixture as rendered.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/tmp/pptr/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell";
const PPTR = process.env.PUPPETEER_CORE || "/usr/local/share/mise/installs/npm-mermaid-js-mermaid-cli/12.0.0/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core";
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
const SLIDES = "# Slide one\n\nText\n\n---\n\n## A diagram\n\n```mermaid\nflowchart LR\n  X --> Y --> Z\n```\n";

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222">
<iframe id="md" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0md" style="width:1100px;height:1200px;border:0;display:block"></iframe>
<iframe id="mm" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0mm" style="width:800px;height:500px;border:0;display:block"></iframe>
<iframe id="sl" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0sl" style="width:960px;height:540px;border:0;display:block"></iframe>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => { if (e.data && typeof e.data.nonce === "string") __msgs.push(e.data); });
  window.__send = (id, msg) => document.getElementById(id).contentWindow.postMessage({ ...msg, nonce: "nonce0" + id }, "*");
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
  for (const id of ["md", "mm", "sl"]) await waitFor((m) => m.nonce === `nonce0${id}` && m.type === "ready", `${id} ready`);
  const frameOf = (id) => page.frames().find((f) => f.url().endsWith(`#nonce0${id}`));
  // The header's `sandbox` directive must have made the frame an opaque origin, like the extension's.
  (await frameOf("md").evaluate(() => self.origin)) === "null" ? ok("frame runs in an opaque origin (sandbox CSP applied)") : fail("frame origin is not opaque");

  // 1. markdown with five fences (one bad) + a js fence.
  await page.evaluate((c) => __send("md", { type: "render", kind: "markdown", version: 1, content: c }), FIXTURE);
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
  /mermaid diagram 5:/.test(de.msg) ? ok("diagramError{} reported to the host") : fail(`diagramError msg: ${de.msg}`);
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
    window.print = () => { const r = document.querySelector("#doc figure.ks-mermaid .node rect"); window.__printFill = r && getComputedStyle(r).fill; };
  });
  await page.evaluate(() => __send("md", { type: "print" }));
  await waitFor((m) => m.nonce === "nonce0md" && m.type === "printed", "printed");
  await new Promise((r) => setTimeout(r, 1500));
  const s4 = await shape();
  const printFill = await md.evaluate(() => window.__printFill);
  printFill && printFill !== s1.nodeFill ? ok(`printed with the light theme (node fill ${printFill})`) : fail(`print theme: node fill ${printFill} (screen ${s1.nodeFill})`);
  s4.theme === "dark" && s4.nodeFill === s1.nodeFill && s4.figures === 4 && s4.styles === s1.styles ? ok("back to dark after printing, nothing leaked") : fail(`after print: ${JSON.stringify(s4)}`);

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

  // 6. Worker / ELK, and CSP violations in every frame. First a control: the recorder must be in
  // each canvas frame, and must see a violation we cause on purpose (img-src allows data:/blob: only).
  const CONTROL = "http://control.invalid/x.png";
  await md.evaluate((u) => { const i = document.createElement("img"); i.src = u; document.body.appendChild(i); }, CONTROL);
  await new Promise((r) => setTimeout(r, 500));
  for (const id of ["md", "mm", "sl"]) {
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
