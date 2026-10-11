// Tests for the chat markdown pipeline (markdown.js + vendored markdown-it).
//
// Runs under `node --test` with NO DOM: markdown-it is pure JS, so we exercise it directly and
// lock the pinned DOMPurify config (DP_CONFIG) against relaxation (ADR §3.2 — the config is where
// the XSS defense is most easily broken). The sanitize step itself needs a DOM (DOMPurify) and is
// covered by the jsdom smoke test in vendor/BUILD.md + live browser validation.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Load the vendored markdown-it + highlight.js IIFEs (no DOM needed) so markdown.js can build `md`
// (with its highlight hook) at import.
for (const f of ["../vendor/markdown-it.iife.js", "../vendor/highlight.iife.js"]) {
  new Function(fs.readFileSync(path.join(__dirname, f), "utf8")).call(globalThis);
}
const { md, DP_CONFIG } = require("../markdown.js");

test("markdown-it renders GFM tables and inline formatting", () => {
  assert.match(md.render("**b**"), /<strong>b<\/strong>/);
  const t = md.render("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(t, /<table>/);
  assert.match(t, /<td>1<\/td>/);
});

test("markdown-it escapes raw HTML (html:false) — double defense before sanitize", () => {
  assert.match(md.render("<img src=x onerror=alert(1)>"), /&lt;img/);
  assert.doesNotMatch(md.render("<script>alert(1)</script>"), /<script/i);
});

test("markdown-it's validateLink drops javascript: hrefs before DOMPurify even runs", () => {
  assert.doesNotMatch(md.render("[x](javascript:alert(1))"), /<a[^>]+href/i);
  // a legit link still renders as a real anchor
  assert.match(md.render("[ok](https://x.com)"), /<a[^>]+href="https:\/\/x\.com"/);
});

test("fenced code is highlighted via the hljs hook, unknown langs fall back to plain", () => {
  const js = md.render("```javascript\nconst x = 1;\n```");
  assert.match(js, /<pre class="hljs">/);
  assert.match(js, /<span class="hljs-keyword">const<\/span>/);
  // an unknown language still renders a code block, just without tokens
  const unknown = md.render("```nosuchlang\nplain text\n```");
  assert.match(unknown, /<pre class="hljs"><code>plain text/);
  assert.doesNotMatch(unknown, /hljs-/);
});

test("fence language is normalized (case/whitespace) before lookup", () => {
  const up = md.render("```JavaScript\nconst x = 1;\n```");
  assert.match(up, /class="language-javascript"/); // normalized to the registered lowercase id
  assert.match(up, /<span class="hljs-keyword">const<\/span>/);
});

test("DP_CONFIG is pinned to the no-relax security defaults (ADR §3.2)", () => {
  assert.deepEqual(DP_CONFIG.USE_PROFILES, { html: true }); // HTML only — no svg/mathMl profile
  assert.equal(DP_CONFIG.SANITIZE_DOM, true);               // blocks DOM-clobbering
  assert.deepEqual(DP_CONFIG.ADD_ATTR, ["target"]);         // the ONLY permitted added attribute
  // Any of these being set would reopen the token-exfil XSS — they must stay absent.
  assert.equal(DP_CONFIG.ALLOW_UNKNOWN_PROTOCOLS, undefined);
  assert.equal(DP_CONFIG.ADD_TAGS, undefined);
  assert.equal(DP_CONFIG.ALLOWED_URI_REGEXP, undefined);
});

test("vendored markdown bundles are eval-free (MV3 script-src 'self')", () => {
  for (const f of ["markdown-it.iife.js", "dompurify.iife.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "../vendor", f), "utf8");
    assert.equal(/\beval\(|new Function\(/.test(src), false, `${f} must be eval-free`);
  }
});

test("GFM task lists: [ ] / [x] list items get a read-only checkbox; other text is untouched", () => {
  const h = md.render("- [ ] todo\n- [x] done\n- [X] DONE\n- plain\n- [ ]no-space\n\n[ ] not a list item");
  assert.match(h, /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled> todo<\/li>/);
  assert.match(h, /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" checked disabled> done<\/li>/);
  assert.match(h, /checked disabled> DONE/);
  assert.match(h, /<li>plain<\/li>/);
  assert.match(h, /<li>\[ \]no-space<\/li>/);
  assert.match(h, /<p>\[ \] not a list item<\/p>/);
  assert.equal((h.match(/<input/g) || []).length, 3);
});

test("task lists never let message text into the checkbox markup (html stays escaped)", () => {
  const h = md.render('- [x] <img src=x onerror=alert(1)> "quoted"');
  assert.match(h, /checked disabled> &lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot;/);
  assert.doesNotMatch(h, /<img/);
});

test("```mermaid fences keep their text as code, tagged language-mermaid for the canvas (ADR canvas §3.3)", () => {
  const tagged = (src) => (md.render(src).match(/<code class="language-mermaid">/g) || []).length;
  assert.match(md.render("```mermaid\nflowchart LR\n  A --> B\n```"), /<pre class="hljs"><code class="language-mermaid">flowchart LR\n {2}A --&gt; B\n<\/code><\/pre>/);
  assert.equal(tagged("~~~mermaid\ngraph TD\n~~~"), 1);
  assert.equal(tagged("```Mermaid \ngraph TD\n```"), 1);                 // normalized like other languages
  assert.equal(tagged("- item\n\n  ```mermaid\n  graph TD\n  ```"), 1);  // inside a list item
  assert.equal(tagged("> ```mermaid\n> graph TD\n> ```"), 1);           // inside a blockquote
  assert.equal(tagged("```mermaidx\ngraph TD\n```"), 0);
  assert.equal(tagged("```\nmermaid\n```"), 0);
  assert.equal(tagged("    ```mermaid\n    graph TD"), 0);                // an indented code block is not a fence
  assert.equal(tagged("text `mermaid` text"), 0);
  // The source is escaped like any code: a label never becomes markup.
  assert.match(md.render('```mermaid\nA["<img src=x onerror=alert(1)>"]\n```'), /A\[&quot;&lt;img src=x onerror=alert\(1\)&gt;&quot;\]/);
});
