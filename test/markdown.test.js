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
