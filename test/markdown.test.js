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
const { md, DP_CONFIG } = require("../src/core/markdown.js");

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

// --- Source lines (ADR canvas §3.7, Ask agent) ---------------------------------------------------
const C = require("../src/core/canvas-core.js");
const lineTags = (html) => Array.from(html.matchAll(/<(\w+) data-line-start="(\d+)" data-line-end="(\d+)"/g)).map((m) => [m[1], +m[2], +m[3]]);

test("source lines: only with env.sourceLines — the chat renders without them", () => {
  const src = "# H\n\npara\n\n- a\n- b\n";
  assert.doesNotMatch(md.render(src), /data-line/);
  assert.doesNotMatch(md.render(src, {}), /data-line/);
  assert.deepEqual(lineTags(md.render(src, { sourceLines: true })), [["h1", 0, 1], ["p", 2, 3], ["ul", 4, 6], ["li", 4, 5], ["li", 5, 6]]);
});

test("source lines: tables rows, blockquotes, rules, fences (highlighted or not), indented code", () => {
  const src = "| a | b |\n|---|---|\n| 1 | 2 |\n\n> q\n\n---\n\n```js\nx\n```\n\n```mermaid\ngraph TD\n```\n\n    code\n";
  const tags = lineTags(md.render(src, { sourceLines: true }));
  assert.deepEqual(tags.filter(([t]) => t === "tr"), [["tr", 0, 1], ["tr", 2, 3]]);
  assert.deepEqual(tags.find(([t]) => t === "blockquote"), ["blockquote", 4, 5]);
  assert.deepEqual(tags.find(([t]) => t === "hr"), ["hr", 6, 7]);
  assert.deepEqual(tags.filter(([t]) => t === "pre"), [["pre", 8, 11], ["pre", 12, 15], ["pre", 16, 17]]);
  // the highlighted <pre> keeps its class and the mermaid tag the canvas looks for
  assert.match(md.render("```mermaid\ngraph TD\n```", { sourceLines: true }), /<pre data-line-start="0" data-line-end="3" class="hljs"><code class="language-mermaid">/);
});

test("source lines: numbers only — the text never reaches the attributes", () => {
  const h = md.render('# "><img src=x onerror=alert(1)> data-line-start="99"\n', { sourceLines: true });
  assert.deepEqual(lineTags(h), [["h1", 0, 1]]);
  assert.doesNotMatch(h, /<img/);
});

test("DP_CONFIG keeps data-* attributes (DOMPurify's default) — the source lines survive sanitizing", () => {
  assert.notEqual(DP_CONFIG.ALLOW_DATA_ATTR, false);
  assert.equal(DP_CONFIG.FORBID_ATTR, undefined);
});

test("source lines map back to the stored text through cleanEditorMarkdown (the canvas document view)", () => {
  // Milkdown "<br />" lines and runs of blank lines are dropped before rendering: the rendered lines
  // shift, the map takes them back to the stored ones.
  const stored = "# Top\n\n<br />\n\n<br />\n\n## 決定紀錄\n\n\n\nfirst line\nsecond line\n\n- item\n";
  const clean = C.cleanEditorMarkdownMap(stored);
  const tags = lineTags(md.render(clean.text, { sourceLines: true }));
  const p = tags.find(([t]) => t === "p");
  const lines = C.askSourceLines([{ start: p[1], end: p[2], offset: 0 }], { map: clean.lines, stored });
  const sl = stored.split("\n");
  assert.deepEqual(sl.slice(lines.from - 1, lines.to), ["first line", "second line"]);
  const h2 = tags.find(([t]) => t === "h2");
  const hl = C.askSourceLines([{ start: h2[1], end: h2[2], offset: 0 }], { map: clean.lines, stored });
  assert.equal(sl[hl.from - 1], "## 決定紀錄");
  assert.equal(hl.from, hl.to);
});

test("source lines of a slide are offset by where it starts in the deck text", () => {
  const stored = "# One\n\nfirst\n\n---\n\n# Two\n\n```\n---\n```\n\nsecond **here**\n";
  const slides = C.splitSlidesAt(stored);
  assert.equal(slides.length, 2);
  const tags = lineTags(md.render(slides[1].text, { sourceLines: true }));
  const p = tags.find(([t]) => t === "p");
  const lines = C.askSourceLines([{ start: p[1], end: p[2], offset: slides[1].line }], { stored });
  assert.equal(stored.split("\n")[lines.from - 1], "second **here**");
});

// --- The user's own messages keep their line breaks (mdUser, breaks:true) ------------------------
const { mdUser } = require("../src/core/markdown.js");

test("user messages: each typed newline is a <br> (Shift+Enter lines stay lines)", () => {
  assert.equal(mdUser.render("a\nb\nc"), "<p>a<br>\nb<br>\nc</p>\n");
  // a blank line still starts a new paragraph
  assert.equal(mdUser.render("a\n\nb"), "<p>a</p>\n<p>b</p>\n");
});

test("agent messages are unchanged: a single newline is still a soft break (a space)", () => {
  assert.equal(md.render("a\nb"), "<p>a\nb</p>\n");
  assert.doesNotMatch(md.render("a\nb\nc"), /<br/);
});

test("user messages: fenced code is rendered exactly as for the agent (no <br> inside)", () => {
  for (const src of ["```js\nconst x = 1;\nconst y = 2;\n```", "```\nline 1\nline 2\n```", "```mermaid\ngraph TD\n  A --> B\n```"]) {
    assert.equal(mdUser.render(src), md.render(src));
    assert.doesNotMatch(mdUser.render(src), /<br/);
  }
  // a canvas push: a note line, then a fence — the note keeps its break, the fence is untouched
  const push = "📤 from canvas\nsee below\n\n```md\n# Title\nbody\n```";
  const h = mdUser.render(push);
  assert.match(h, /<p>📤 from canvas<br>\nsee below<\/p>/);
  assert.match(h, /<pre class="hljs"><code># Title\nbody\n<\/code><\/pre>/);
});

test("user messages: lists, quotes, task lists and html escaping still work with breaks", () => {
  const list = mdUser.render("- one\n- two\n\n1. a\n2. b");
  assert.match(list, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(list, /<ol>\n<li>a<\/li>\n<li>b<\/li>\n<\/ol>/);
  assert.match(mdUser.render("> q1\n> q2"), /<blockquote>\n<p>q1<br>\nq2<\/p>\n<\/blockquote>/);
  assert.match(mdUser.render("- [x] done"), /checked disabled> done/);
  assert.match(mdUser.render("<img src=x onerror=alert(1)>\nnext"), /&lt;img src=x onerror=alert\(1\)&gt;<br>\nnext/);
  assert.equal(mdUser.options.html, false);
  assert.equal(md.options.breaks, false);
});
