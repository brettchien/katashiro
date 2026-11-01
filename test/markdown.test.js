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

// --- Cards and callouts (ADR canvas §3.3 "Cards and callouts") ------------------------------------
// The class survives DOMPurify (html profile keeps `class` on div/p/blockquote) and no <svg> reaches
// the sink: both checked on the real sanitizer by scripts/smoke-cards.mjs (no DOM under node --test).
const cardsOf = (html) => {
  const m = /<div class="cards">([\s\S]*)<\/div>\s*$/.exec(html);
  return m ? (m[1].match(/<div class="card">/g) || []).length : -1;
};

test("tables: each <table> sits in a constant .table-wrap div; source lines stay on the table", () => {
  const h = md.render("| a | b |\n|---|--:|\n| 1 | 2 |\n");
  assert.match(h, /^<div class="table-wrap">\n<table>\n[\s\S]*<\/table>\n<\/div>\n$/);
  assert.match(h, /<td style="text-align:right">2<\/td>/);
  const s = md.render("x\n\n| a |\n|---|\n| 1 |\n", { sourceLines: true });
  assert.match(s, /<div class="table-wrap">\n<table data-line-start="2" data-line-end="5">/);
  assert.equal((md.render("| a |\n|---|\n| 1 |\n\n| b |\n|---|\n| 2 |\n").match(/<div class="table-wrap">/g) || []).length, 2);
});

test("cards: the plugins are bundled with markdown-it (one vendor file, load order unchanged)", () => {
  assert.equal(typeof globalThis.markdownitContainer, "function");
  assert.equal(typeof globalThis.markdownitGithubAlerts, "function");
});

test("cards: every direct-child ### starts a card; text before the first ### is a card of its own", () => {
  const h = md.render("::: cards\nIntro **text**.\n\n### One\nBody 1\n\n### Two\n- a\n- b\n\n### Three\n| x |\n|---|\n| 1 |\n:::\n");
  assert.equal(cardsOf(h), 4);
  assert.match(h, /^<div class="cards">\n<div class="card">\n<p>Intro <strong>text<\/strong>\.<\/p>\n<\/div>\n<div class="card">\n<h3>One<\/h3>\n<p>Body 1<\/p>\n<\/div>\n<div class="card">\n<h3>Two<\/h3>/);
  assert.match(h, /<h3>Three<\/h3>\n<div class="table-wrap">\n<table>[\s\S]*<\/table>\n<\/div>\n<\/div>\n<\/div>\n$/);
  // no preamble: the first card is the first ###
  assert.match(md.render("::: cards\n### A\nx\n### B\ny\n:::"), /^<div class="cards">\n<div class="card">\n<h3>A<\/h3>/);
  assert.equal(cardsOf(md.render("::: cards\n### A\nx\n### B\ny\n:::")), 2);
  // only text, no ###: one card
  assert.equal(cardsOf(md.render("::: cards\njust text\n:::")), 1);
});

test("cards: an h3 in a list, quote, alert or other heading level never splits a card", () => {
  const h = md.render("::: cards\n### A\n- ### in a list\n\n> ### in a quote\n\n> [!NOTE]\n> ### in an alert\n\n## h2 stays\n#### h4 stays\n### B\nend\n:::");
  assert.equal(cardsOf(h), 2);
  assert.match(h, /<li>\n<h3>in a list<\/h3>\n<\/li>/);
  assert.match(h, /<blockquote>\n<h3>in a quote<\/h3>\n<\/blockquote>/);
});

test("cards: a nested cards container (longer fence) has its own cards; the outer split is unchanged", () => {
  const h = md.render(":::: cards\n### Outer A\n::: cards\n### Inner 1\n### Inner 2\n:::\n### Outer B\n::::");
  assert.equal((h.match(/<div class="cards">/g) || []).length, 2);
  assert.equal((h.match(/<div class="card">/g) || []).length, 4);
  assert.match(h, /<h3>Outer A<\/h3>\n<div class="cards">\n<div class="card">\n<h3>Inner 1<\/h3>\n<\/div>\n<div class="card">\n<h3>Inner 2<\/h3>\n<\/div>\n<\/div>\n<\/div>\n<div class="card">\n<h3>Outer B<\/h3>/);
});

test("cards: only `cards` is a container; the info string never reaches the markup", () => {
  assert.equal(md.render("::: foo\nx\n:::"), "<p>::: foo\nx\n:::</p>\n");
  assert.equal(md.render("::: cardsx\nx\n:::"), "<p>::: cardsx\nx\n:::</p>\n");
  const h = md.render('::: cards "><img src=x onerror=alert(1)> class="evil\n### A\n:::');
  assert.match(h, /^<div class="cards">\n<div class="card">\n<h3>A<\/h3>\n<\/div>\n<\/div>\n$/);
  assert.doesNotMatch(h, /evil|<img|onerror/);
  // the ### text is ordinary (escaped) heading text
  assert.match(md.render("::: cards\n### <b>x</b>\n:::"), /<h3>&lt;b&gt;x&lt;\/b&gt;<\/h3>/);
  // an unclosed container runs to the end of the document (markdown-it-container)
  assert.equal(cardsOf(md.render("::: cards\n### A\n### B")), 2);
});

test("cards: source lines on the container, each card (first block → next card / closing :::) and inside", () => {
  const src = "# T\n\n::: cards\nintro\n\n### A\ntext\n\n### B\n- x\n:::\n";
  const tags = lineTags(md.render(src, { sourceLines: true }));
  const cards = Array.from(md.render(src, { sourceLines: true }).matchAll(/<div class="card" data-line-start="(\d+)" data-line-end="(\d+)"/g)).map((m) => [+m[1], +m[2]]);
  assert.deepEqual(cards, [[3, 5], [5, 8], [8, 10]]);
  assert.deepEqual(tags.filter(([t]) => t === "div"), [["div", 2, 10]]);
  assert.deepEqual(tags.find(([t]) => t === "h3"), ["h3", 5, 6]);
  assert.deepEqual(tags.find(([t]) => t === "ul"), ["ul", 9, 10]);
  assert.match(md.render(src, { sourceLines: true }), /<div data-line-start="2" data-line-end="10" class="cards">\n<div class="card" data-line-start="3"/);
});

test("alerts: GitHub [!NOTE] … [!CAUTION] become constant-class callouts with a title row, no svg", () => {
  for (const [marker, type, title] of [["NOTE", "note", "Note"], ["TIP", "tip", "Tip"], ["IMPORTANT", "important", "Important"], ["WARNING", "warning", "Warning"], ["caution", "caution", "Caution"]]) {
    const h = md.render(`> [!${marker}]\n> Body *here*.`);
    assert.equal(h, `<div class="markdown-alert markdown-alert-${type}"><p class="markdown-alert-title">${title}</p>\n<p>Body <em>here</em>.</p>\n</div>\n`);
  }
  assert.doesNotMatch(md.render("> [!WARNING]\n> x"), /<svg/i);
  assert.match(md.render("> [!UNKNOWN]\n> x"), /^<blockquote>\n<p>\[!UNKNOWN\]/);   // not one of the five
  assert.match(md.render("> plain quote"), /^<blockquote>\n<p>plain quote<\/p>/);
});

test("alerts: the escaped `> \\[!NOTE]` Milkdown normalization writes is still an alert (ADR canvas §3.5)", () => {
  assert.equal(md.render("> \\[!NOTE]\n> Useful information."),
    '<div class="markdown-alert markdown-alert-note"><p class="markdown-alert-title">Note</p>\n<p>Useful information.</p>\n</div>\n');
  assert.match(md.render("> \\[!WARNING]\n>\n> Careful."), /^<div class="markdown-alert markdown-alert-warning">/);
});

test("alerts: a custom title is escaped text (the plugin would paste it raw); source lines kept", () => {
  const h = md.render('> [!TIP] <img src=x onerror=alert(1)> & "q"\n> body');
  assert.match(h, /^<div class="markdown-alert markdown-alert-tip"><p class="markdown-alert-title">&lt;img src=x onerror=alert\(1\)&gt; &amp; &quot;q&quot;<\/p>/);
  assert.doesNotMatch(h, /<img/);
  assert.match(md.render("x\n\n> [!NOTE]\n> y", { sourceLines: true }), /<div class="markdown-alert markdown-alert-note" data-line-start="2" data-line-end="4">/);
});

test("emoji callouts: ℹ️ / ✅ / ⚠️ (with or without U+FE0F) at the start of a quote get the alert classes", () => {
  const cls = (src) => { const m = /^<blockquote class="([^"]+)">/.exec(md.render(src)); return m && m[1]; };
  assert.equal(cls("> ℹ️ Info"), "markdown-alert markdown-alert-note markdown-alert-emoji");
  assert.equal(cls("> \u2139 Info"), "markdown-alert markdown-alert-note markdown-alert-emoji");
  assert.equal(cls("> ✅ Done"), "markdown-alert markdown-alert-tip markdown-alert-emoji");
  assert.equal(cls("> \u2705\uFE0F Done"), "markdown-alert markdown-alert-tip markdown-alert-emoji");
  assert.equal(cls("> ⚠️ Careful"), "markdown-alert markdown-alert-warning markdown-alert-emoji");
  assert.equal(cls("> \u26A0 Careful"), "markdown-alert markdown-alert-warning markdown-alert-emoji");
  // the emoji stays in the text; no title row
  assert.match(md.render("> ⚠️ Careful *now*"), /<p>⚠️ Careful <em>now<\/em><\/p>/);
  assert.doesNotMatch(md.render("> ⚠️ Careful"), /markdown-alert-title/);
  // only at the start of the quote's first paragraph
  assert.equal(cls("> text ⚠️ later"), null);
  assert.equal(cls("> first\n>\n> ⚠️ second paragraph"), null);
  assert.equal(cls("> - ⚠️ in a list"), null);
  assert.equal(cls("> 🔥 other emoji"), null);
});

test("cards and callouts: the chat renders them too (agent and user parsers share buildMd)", () => {
  const src = "::: cards\n### A\n> [!NOTE]\n> n\n\n### B\n> ⚠️ w\n:::";
  for (const p of [md, mdUser]) {
    const h = p.render(src);
    assert.equal((h.match(/<div class="card">/g) || []).length, 2);
    assert.match(h, /<div class="markdown-alert markdown-alert-note">/);
    assert.match(h, /<blockquote class="markdown-alert markdown-alert-warning markdown-alert-emoji">/);
  }
});

// --- footnotes, ==highlight==, ++underline++, definition lists (ADR canvas §3.3) ---------------------
test("plugins: footnote, mark, ins and deflist are bundled with markdown-it", () => {
  for (const g of ["markdownitFootnote", "markdownitMark", "markdownitIns", "markdownitDeflist"]) {
    assert.equal(typeof globalThis[g], "function", g);
  }
});

test("plugins: ==highlight== is <mark>, ++underline++ is <ins>, in the chat path too", () => {
  assert.match(md.render("a ==hot== b"), /<p>a <mark>hot<\/mark> b<\/p>/);
  assert.match(md.render("a ++new++ b"), /<p>a <ins>new<\/ins> b<\/p>/);
  const { mdUser } = require("../src/core/markdown.js");
  assert.match(mdUser.render("==x== ++y++"), /<mark>x<\/mark> <ins>y<\/ins>/);
});

test("plugins: a definition list is <dl><dt><dd>", () => {
  assert.match(md.render("Term\n: Its definition.\n"), /<dl>\n<dt>Term<\/dt>\n<dd>Its definition\.<\/dd>\n<\/dl>/);
});

test("plugins: footnotes render a superscript reference and a footnotes section", () => {
  const h = md.render("Text[^1].\n\n[^1]: The note.\n");
  assert.match(h, /<sup class="footnote-ref"><a href="#fn1" id="fnref1">\[1\]<\/a><\/sup>/);
  assert.match(h, /<hr class="footnotes-sep">\n<section class="footnotes">\n<ol class="footnotes-list">\n<li id="fn1" class="footnote-item"><p>The note\./);
});

test("plugins: source lines still reach a definition list and the footnotes section", () => {
  const h = md.render("x\n\nTerm\n: def\n", { sourceLines: true });
  assert.match(h, /<dl data-line-start="2" data-line-end="4">/);
});
