# ADR: Markdown rendering in the chat (sanitized)

- **Status:** Proposed
- **Date:** 2026-08-03
- **Author:** Brett Chien
- **Related:** [ROADMAP](../../ROADMAP.md), [a11y-snapshot ADR](./a11y-snapshot-and-element-refs.md) (vendoring pattern)

> Citations are inline as `[Key]` at the point of the claim; each key resolves in **References**.
>
> **Rev. 2 (2026-08-03):** incorporated round-1 security review (Falcon / Mira / Orca). Added: a
> hardened extension-page CSP as an independent egress lock (§3.7); a pinned, no-relax DOMPurify config
> + `markdown-it({html:false})` + single `renderMarkdown` sink (§3.2); link **and media** scheme
> hardening + click→`chrome.tabs.create` (§3.5); DOMPurify/markdown-it treated as security
> dependencies (§3.1). No factual conflicts among reviewers; all approved the direction.
>
> **Rev. 3 (2026-08-03):** round-2 — evaluated Orca's O1 and scoped §3.7 honestly (the egress lock
> defends against *third-party* exfil, **not** a malicious ACP endpoint itself — that's the trust
> boundary + `wss`/TLS + DOMPurify; and even `connect-src 'self'` wouldn't close the `panel→SW→ACP`
> relay). Moving the socket to the SW is deferred to a separate **[ACP connection ownership ADR](./acp-connection-ownership.md)**.
> `default-src 'none'` base; Neutral wording fixed; stop/error SHOULD finalize.

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

**DOMPurify (and secondarily markdown-it) are *security* dependencies, not pure-compute libs like
`dom-accessibility-api`** (Orca S3). mXSS bypasses are found and patched periodically, so a frozen
bundle accrues latent XSS over time. Pin exact versions, track cure53 / GHSA advisories, and keep an
explicit update path — this is *not* "vendor once and forget" like a computation library.

### 3.2 Render pipeline — one sanitized sink, config locked to safe defaults
```
const md = markdownIt({ html: false, linkify: true });  // html:false ⇒ any raw HTML in the message is
                                                         // ESCAPED to text before sanitizing (double defense)
function renderMarkdown(text) {                          // the ONLY path from remote text to innerHTML
  const html = md.render(text);                          // highlight.js runs in the fence hook (§3.4)
  return DOMPurify.sanitize(html, DP_CONFIG);            // MANDATORY — this is the XSS guard now (§1.2)
}
```
`appendMessage` and `finalizeStream` may reach the DOM **only** via `renderMarkdown` → `bubble.innerHTML`;
a lint/grep rule bans any other `innerHTML =` of remote text. User and agent messages both go through it.

**`DP_CONFIG` is pinned to safe defaults and relaxing it is forbidden** — the config is where this
defense is most easily broken (Falcon/Orca):
- `USE_PROFILES: { html: true }` (HTML only — **no `svg`/`mathMl` profile**) and `SANITIZE_DOM: true`
  (blocks DOM-clobbering, e.g. `<form id="document">` / `<input name="DOMPurify">` shadowing globals).
- **Do NOT** set `ALLOW_UNKNOWN_PROTOCOLS`, loosen `ALLOWED_URI_REGEXP`, or `ADD_TAGS` / add `style`
  or event-handler attributes. The **only** permitted `ADD_ATTR` is `['target']` — DOMPurify strips
  `target` by default, so the `target="_blank"` hook (§3.5) is a silent no-op without it.

### 3.3 Streaming stays plain; render at finalize
During streaming, keep the current `textContent` append (`appendToStream`). Markdown is rendered **once
at `finalizeStream`**, not per chunk — re-parsing markdown on every token flickers on half-open fences
and is O(n²). (A debounced during-stream render is a later, optional polish; if added, **every frame
still sanitizes** — never skip it for speed.) A stream that stops or errors **SHOULD still call
`finalizeStream`** so the message renders; a message that never finalizes stays as (roughly readable)
raw markdown.

### 3.4 Syntax highlighting + copy-code (core)
- `highlight.js` runs in markdown-it's `highlight` fence hook; unknown/omitted languages fall back to
  plain `<code>`.
- Every `<pre>` gets a **copy button**, built with `createElement` **after** sanitize and reading the
  code via `textContent` — never concatenated into the markdown HTML string before sanitizing.

### 3.5 Link + media hardening
A DOMPurify `afterSanitizeAttributes` hook forces `target="_blank"` + `rel="noopener noreferrer"` on
anchors (needs `ADD_ATTR:['target']`, §3.2) and drops non-`http(s)`/`mailto` schemes. The **same scheme
check covers `<img>`/media `src`** at sanitize time, so an image `src` can't carry a non-`http(s)`
scheme past the anchor rule (remote-image *beaconing* is separately blocked by the §3.7 `img-src`).
Because navigating inside a side panel is broken UX, a delegated click handler on the message container
opens anchors via `chrome.tabs.create({url})` — **re-validating the scheme (`http(s):`/`mailto:` only)
at click time**, never trusting the post-sanitize `href` blindly.

### 3.6 Fence renderer is mermaid-ready (hook only, no engine yet)
The fence renderer routes by language. A ```` ```mermaid ```` block is, for now, rendered as a normal
(highlighted) code block, but through a **named hook** so a diagram engine can later replace it without
touching the markdown core. The diagram engine is a **separate decision** (see §5); the current lean is
**dagre + SVG** (eval-free, no sandbox iframe, and shared with the future whiteboard) rather than
mermaid.js — mermaid's UMD runs `Function(...)` at module load, and since an MV3 extension page
**cannot** be granted `'unsafe-eval'` (§1.3), it could only run inside a sandboxed iframe / offscreen
document, never directly on the panel.

### 3.7 Defense in depth — a hardened extension-page CSP (independent egress lock)

DOMPurify is one wall; §1.2's threat is token **exfiltration**, so add a second, independent lock that
holds **even if the sanitizer is bypassed** (a 0-day or a future config slip). `manifest.json` has no
`content_security_policy` today (§1.3); add `content_security_policy.extension_pages`:
```
"content_security_policy": {
  "extension_pages":
    "default-src 'none'; script-src 'self'; connect-src 'self' <the ACP endpoint origin(s)>;
     img-src 'self' data:; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
}
```
`default-src 'none'` is the base (so `frame-src`/`font-src`/`media-src`/`worker-src` don't sit open),
then `connect-src` (fetch/WS egress) + `img-src` (no remote `<img>` beacon) + `form-action 'none'` +
`base-uri 'none'` mean an injected `<img>` / `fetch` / form-post **cannot ship the `chrome.storage`
tokens off-box** — the sanitizer and the CSP would both have to fail. This is the biggest gap in a
sanitizer-only design (Orca S1). `connect-src` lists exactly the origins the side panel legitimately
talks to (the ACP endpoints), nothing wildcard.

**Scope of this backstop (Orca O1, evaluated).** The egress lock is strong against a **third-party**
attacker (XSS from a page the agent read, or a MITM redirecting to `attacker.com`). It is **not** a
defense against a **compromised/MITM ACP endpoint itself**: that origin is on the trusted channel.
Crucially, even narrowing panel `connect-src` to `'self'` would not close it — the panel relays prompts
to the ACP (today directly; if the socket moved to the service worker, via `panel → SW → ACP`), so
injected XSS could read the token from `chrome.storage` and **smuggle it out as prompt content over
that legitimate channel**. Against a malicious ACP the real controls are the **trust boundary** (the
ACP is the user's own openab broker), **`wss`/TLS + the transport-auth key** (vs MITM), and **DOMPurify**
(so ACP content never becomes script) — not the CSP. A *capability* nuance (Orca): markdown adds the
`innerHTML` sink, i.e. a **new XSS foothold** absent in the `textContent` era; the trust boundary is
unchanged, but that foothold makes **keeping DOMPurify patched (§3.1) load-bearing against a malicious
broker too**, not only third parties — it is what stops the foothold from becoming token theft.
Narrowing panel egress to `'self'` still
meaningfully closes the *third-party* path, but that requires moving the ACP socket out of the panel
into the service worker — a **larger refactor tracked as its own ADR** (ACP connection ownership). This
markdown ADR sets `connect-src` as tight as today's panel-owned socket allows and does not over-claim.

---

## Consequences

### Positive
- The readability problem (§1.1) is fixed: bold/headings/lists/**tables**/code all render.
- Code blocks are highlighted and one-click copyable — agent-provided commands/code become usable.
- The `innerHTML` sink is guarded by **two independent layers** — DOMPurify (§3.2) and a hardened
  egress CSP (§3.7) — so a sanitizer bypass alone cannot exfil the `chrome.storage` tokens **to a
  third party** (a malicious ACP endpoint itself is a separate trust-boundary matter — §3.7).

### Negative / tradeoffs
- Three vendored bundles (largest is highlight.js — mitigated by the curated language set).
- DOMPurify is load-bearing (though no longer the *sole* guard — the CSP is the backstop): every
  rich-render path MUST go through the single `renderMarkdown` sink; no other `innerHTML` of remote text.
- The `connect-src` allowlist (§3.7) must track the real ACP endpoints, and DOMPurify must be kept
  patched (§3.1) — both are ongoing obligations, not one-time.
- Streaming shows plain text until the turn finalizes (acceptable; rich render on completion). A stream
  that never finalizes leaves that message as (roughly readable) raw markdown.

### Neutral
- markdown-it/DOMPurify/highlight.js are all eval-free → **no CSP *relaxation*** needed (unlike
  mermaid). This ADR does *tighten* the CSP — it **adds** an egress lock (§3.7); that's orthogonal to
  the eval question.

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
- **In scope:** markdown-it (`html:false`) + DOMPurify (pinned, no-relax config) + the single
  `renderMarkdown` sink + GFM tables + syntax highlighting + copy-code + link/media hardening +
  the hardened extension-page CSP (§3.7) + finalize-only rendering + the mermaid-ready fence hook.
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
