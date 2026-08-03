# ADR: Markdown rendering in the chat (sanitized)

- **Status:** Proposed
- **Date:** 2026-08-03
- **Author:** Brett Chien
- **Related:** [ROADMAP](../../ROADMAP.md), [a11y-snapshot ADR](./a11y-snapshot-and-element-refs.md) (vendoring pattern)

> Citations are inline as `[Key]` at the point of the claim; each key resolves in **References**.

---

## 1. Context

### 1.1 Problem — the chat renders raw markdown as literal text

Agent replies arrive as markdown but are shown verbatim: `**bold**`, `### headings`, fenced code, and —
worst — **GFM tables** appear as a wall of literal `|`/`---` pipes. A real captured reply (a hardware
comparison with a table) was unreadable: the table was pure pipe-soup. This is the top readability
complaint.

### 1.2 Current rendering (and why it's security-critical)

Messages render with `createElement` + **`textContent` only** (`sidepanel.js` `appendMessage`, and the
streaming bubble `bubble.textContent = text`). The code carries an explicit anti-XSS rationale: agent
output is **remote-controlled** (a compromised/MITM ACP server, or a page the agent read, can inject a
string), so an `innerHTML` sink there is a **remote-XSS that could exfiltrate the `chrome.storage`
tokens** the side panel holds. **`textContent` is currently the only thing preventing that.**

Therefore: moving to rich rendering means moving to `innerHTML`, which means the XSS guard must be
replaced by a **sanitizer that is not optional**.

### 1.3 MV3 constraints

`manifest.json` has no `content_security_policy` → the MV3 default
`script-src 'self'; object-src 'self'` applies, and Chrome enforces a **minimum** of
`script-src 'self' 'wasm-unsafe-eval'` that cannot be relaxed — critically, **`'unsafe-eval'` cannot be
added to extension pages at all** (rejected at install as insecure) `[MV3-CSP]`. So: no CDN, no inline
scripts, no `eval`/`new Function`. Every library must be **vendored locally as a prebuilt, eval-free
bundle** — the same offline pattern already used for `dom-accessibility-api`
([a11y ADR](./a11y-snapshot-and-element-refs.md) §3.7). (This is also why the diagram engine can't be
mermaid-on-the-panel — §3.6.)

---

## 2. Research — prior art

The "render markdown → **sanitize the HTML** → insert" pipeline is the settled pattern for showing
untrusted/remote markdown in a browser UI.

- **`markdown-it` `[markdown-it]`** — CommonMark + configurable; **GFM-style pipe tables are on in the
  default preset** (markdown-it isn't full GFM — strikethrough/autolink extensions differ — but tables
  specifically render out of the box); large plugin ecosystem (katex/task-lists/etc. for later phases);
  pure JS, no `eval`; ships a browser UMD bundle (v15: `dist/browser/markdown-it.umd.min.js`, exposes
  global `markdownit` — pin the path to the version vendored). A `highlight` hook `(str, lang) => html`
  lets a syntax highlighter run per fenced block. (The lighter `marked` (~⅓ the size) is an
  alternative, but markdown-it's plugin surface pays off for mermaid/katex; both are eval-free.)
- **`DOMPurify` `[DOMPurify]`** — the reference HTML/SVG sanitizer (cure53). Standalone, no `eval`,
  browser-droppable UMD. It is the mandated guard for §1.2: `DOMPurify.sanitize(html)` strips scripts,
  event handlers, and dangerous URLs. Supports hooks (for link hardening) and an SVG profile (relevant
  to a later diagram phase).
- **`highlight.js` `[hljs]`** — eval-free syntax highlighter, vendorable as a prebuilt bundle;
  supports **curated-language builds** so we ship ~a dozen common languages, not all ~190.
- Convention: **highlight runs inside markdown-it's fence renderer, then the whole output is
  DOMPurify-sanitized once** before it touches the DOM.

---

## 3. Decision

Render agent (and user) message markdown to sanitized HTML. Syntax highlighting and copy-code are
**core, not optional**.

### 3.1 Vendored libraries (offline IIFE, `'self'`)
Vendor three prebuilt, eval-free bundles into `vendor/` (same flow as `dom-accessibility-api`,
`vendor/BUILD.md`): **`markdown-it`**, **`DOMPurify`**, **`highlight.js`** (curated language set:
js, ts, python, rust, go, bash/shell, json, yaml, html, css, sql, diff — extend as needed). Loaded via
`<script src>` in `sidepanel.html` before `sidepanel.js`.

### 3.2 Render pipeline — sanitize is non-negotiable
```
html = markdownIt.render(text)            // markdown-it, GFM tables on, fenced code via highlight.js
safe = DOMPurify.sanitize(html, CONFIG)   // MANDATORY — replaces the textContent XSS guard (§1.2)
bubble.innerHTML = safe
```
Applied at **both** render sites: `finalizeStream` (the streamed agent bubble) and `appendMessage`
(non-streamed / room-relayed messages). User messages render through the same sanitized pipeline.

### 3.3 Streaming stays plain; render at finalize
During streaming, keep the current `textContent` append (`appendToStream`). Markdown is rendered **once
at `finalizeStream`**, not per chunk — re-parsing markdown on every token flickers on half-open fences
and is O(n²). (A debounced during-stream render is a later, optional polish.)

### 3.4 Syntax highlighting + copy-code (core)
- `highlight.js` runs in markdown-it's `highlight` fence hook; unknown/omitted languages fall back to
  plain `<code>`.
- Every `<pre>` gets a **copy button** (overlay) using `navigator.clipboard.writeText`.

### 3.5 Link hardening
A DOMPurify `afterSanitizeAttributes` hook forces `target="_blank"` + `rel="noopener noreferrer"` on
anchors, and drops non-`http(s)`/`mailto` schemes.

### 3.6 Fence renderer is mermaid-ready (hook only, no engine yet)
The fence renderer routes by language. A ```` ```mermaid ```` block is, for now, rendered as a normal
(highlighted) code block, but through a **named hook** so a diagram engine can later replace it without
touching the markdown core. The diagram engine is a **separate decision** (see §5); the current lean is
**dagre + SVG** (eval-free, no sandbox iframe, and shared with the future whiteboard) rather than
mermaid.js — mermaid's UMD runs `Function(...)` at module load, and since an MV3 extension page
**cannot** be granted `'unsafe-eval'` (§1.3), it could only run inside a sandboxed iframe / offscreen
document, never directly on the panel.

---

## Consequences

### Positive
- The readability problem (§1.1) is fixed: bold/headings/lists/**tables**/code all render.
- Code blocks are highlighted and one-click copyable — agent-provided commands/code become usable.
- The `innerHTML` sink is guarded by DOMPurify, a stronger and more explicit posture than "never use
  innerHTML" once the content must be rich.

### Negative / tradeoffs
- Three vendored bundles (largest is highlight.js — mitigated by the curated language set).
- DOMPurify is now load-bearing: a misconfig or a bypassed path reintroduces the §1.2 XSS. Every
  rich-render path MUST go through it; no direct `innerHTML` of remote text anywhere.
- Streaming shows plain text until the turn finalizes (acceptable; rich render on completion).

### Neutral
- markdown-it/DOMPurify/highlight.js are all eval-free → **no CSP change** needed (unlike mermaid).

---

## 4. Alternatives Considered
- **Keep `textContent`.** Rejected — the captured screenshot is the counter-argument.
- **`marked` instead of `markdown-it`.** Viable, lighter; rejected for markdown-it's plugin ecosystem
  (mermaid/katex/task-lists in later phases) and default GFM tables `[markdown-it]`.
- **CDN-loaded libs.** Rejected — MV3 `script-src 'self'` forbids it `[MV3-CSP]`; vendor locally.
- **Render markdown during streaming.** Rejected for v1 — half-open-fence flicker + O(n²) reparse;
  finalize-only is simpler and safe (§3.3).
- **`innerHTML` without DOMPurify.** Rejected — reintroduces the token-exfil XSS (§1.2).
- **mermaid.js now (in a sandbox iframe).** Deferred — it's a separate, larger decision with a
  different security model (`eval` → sandboxed iframe); the fence hook (§3.6) keeps the door open.

---

## 5. Scope & Non-Goals
- **In scope:** markdown-it + DOMPurify + GFM tables + syntax highlighting + copy-code + link
  hardening + finalize-only rendering + the mermaid-ready fence hook.
- **Out of scope (separate follow-ups):** the diagram engine itself (mermaid vs dagre+SVG — its own
  ADR, leaning dagre+SVG for whiteboard synergy), KaTeX/math, surfacing dropped `session/update` types
  (tool-call traces / inline screenshots), auto-scroll fix, error bubbles, stop/retry. All tracked in
  the messaging plan.

---

## References
- **[markdown-it]** markdown-it (CommonMark + default-on pipe tables, plugin ecosystem, eval-free UMD; MIT; v15) — https://github.com/markdown-it/markdown-it
- **[DOMPurify]** DOMPurify (cure53 HTML/MathML/SVG sanitizer, eval-free UMD, `addHook`; MPL-2.0 OR Apache-2.0; v3) — https://github.com/cure53/DOMPurify
- **[hljs]** highlight.js (eval-free highlighter, curated-subset builds; BSD-3-Clause; v11) — https://github.com/highlightjs/highlight.js
- **[MV3-CSP]** Chrome — MV3 content security policy (min `script-src 'self' 'wasm-unsafe-eval'`; `'unsafe-eval'` not allowed on extension pages) — https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- Local: `/workspace/drafts/katashiro_capability_and_messaging_plan.md` (Part 2, messaging); the diagram-engine synergy with Part 3 (whiteboard).
