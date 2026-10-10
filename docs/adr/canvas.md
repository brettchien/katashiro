# ADR: Canvas — agent-rendered documents, slides and diagrams beside the chat

- **Status:** Proposed 2026-10-10
- **Date:** 2026-10-10
- **Author:** Brett Chien (drafted by Orca)
- **Related:** [chat markdown rendering](./chat-markdown-rendering.md) (§3.1 vendoring, §3.6 diagram
  engine, §3.7 CSP); `katashiro.show_image` (#59); reply-to (#61); multi-conversation (ADR pending).

> Citations are inline as `[Key]` at the point of the claim; each key resolves in **References**.

---

## 1. Context

### 1.1 Problem — the chat bubble is the only output surface

An agent can only answer with text in a chat bubble (rendered markdown) or a static bitmap
(`show_image`). This does not fit several kinds of output Brett asks for:

- **Long documents** (an ADR draft, a report). They are narrow in the side panel, scroll away, and
  every revision is re-sent in full as a new bubble, so you cannot see "the current version".
- **Slides.** There is no presentation surface at all.
- **Charts and diagrams.** The agent container has no browser. `mmdc` fails without
  chrome-headless-shell, so today a diagram means hand-written SVG pushed through `show_image`.
- **Iteration.** You cannot edit what the agent produced, and the agent cannot see your edits.

What we want is close to Claude's artifacts and ChatGPT's canvas `[Artifacts]` `[Canvas]`: a persistent,
versioned surface next to the conversation that the agent renders into and updates live.

### 1.2 Constraints

- **The panel holds the tokens.** The side panel's `chrome.storage` holds ACP keys and the Jev token.
  The markdown ADR's threat model `[MD-ADR §1.2]` applies with more force here: canvas content is
  agent-authored and may echo a web page the agent read. **Agent-authored HTML or JS must never run
  in an extension-page origin** (the panel, or any page that can reach `chrome.*`).
- **MV3 CSP.** Extension pages run under `script-src 'self'`, and `'unsafe-eval'` cannot be granted
  `[MV3-CSP]`. That is why the markdown ADR leaned towards dagre over mermaid `[MD-ADR §3.6]`.
  **Sandboxed pages** declared in `manifest.sandbox.pages` get a unique opaque origin, have no
  `chrome.*` extension APIs, and have their own `content_security_policy.sandbox` `[MV3-Sandbox]`.
  This is the escape hatch: rich and even scripted content runs there, cut off from the tokens.
- **Transport.** Agent → Katashiro is the MCP-over-ACP tunnel (tool calls), the same path
  `show_image` uses (≤ 5 MB decoded). The agent sends content as tool arguments, so bytes go into
  the model's context unless a shell helper posts them to the facade (the `show_image` skill pattern).
- **No build system.** Libraries are vendored as prebuilt bundles and pinned exactly
  (`vendor/BUILD.md`, `scripts/vendor-build/`).

---

## 2. Research — prior art and libraries (checked 2026-10-10)

- **Claude artifacts / ChatGPT canvas** `[Artifacts]` `[Canvas]`: content lives beside the chat,
  untrusted code runs in an isolated frame, and revisions are versions of one object rather than
  new messages. ChatGPT canvas lets the user edit, and the model then edits on top of those edits.
- **reveal.js 6.0.2** (MIT) `[Reveal6]`: 6.0 (2026-03) moved plugins to `dist/plugin/<name>.js`,
  renamed `.esm.js` to `.mjs`, and ships TS types plus an official `@revealjs/react`. The markdown
  plugin uses `---` as the slide separator. There is a new `sync` event and `removeHiddenSlides()`,
  which suit live re-render. Export is **PDF only**, via `?print-pdf` and the browser print dialog.
  There is no pptx import or export.
- **Mermaid 12.1.0** `[Mermaid12]`: ELK is now the default layout, and it needs ES2024 (fine in
  Chrome). The full package is 116 MB unpacked; **`@mermaid-js/tiny` is a 2.7 MB single file**.
- **Chart.js 4.5.1** (203 KB UMD), **uPlot 1.6.32** (~50 KB, time series).
- **pptx:** `pptxgenjs` 4.0.1 (MIT, 450 KB) writes pptx in the browser from a slide model.
  `pptxtojson` 2.2.0 (MIT) parses pptx into JSON. `dom-to-pptx` 2.1.2 converts rendered HTML into
  editable pptx (untested).
- **Editors:** `@milkdown/crepe` 7.22.2 (ProseMirror, markdown-native WYSIWYG) and CodeMirror 6.
  We do not use Quill: its Delta/HTML model loses tables, code-fence languages and `---` slide breaks
  on a markdown round trip.
- **eval scan (static grep of the dist files):** reveal.js has 0 `eval` and 0 `Function(`. Chart.js
  has none (only identifiers named `…Function(`). `mermaid.tiny.js` has 0 `eval` and 4
  `Function("return this")()` global-object fallbacks that sit behind `self` checks. pptxgenjs has
  core-js polyfill fallbacks. **Runtime behaviour has not been verified.** It does not change the
  decision, because all of these run inside the sandbox (§3.2).

---

## 3. Decision

### 3.1 Surface — a canvas tab, with a card in the chat

A canvas opens in **its own extension tab** (`canvas.html`), not inside the panel:

- The panel is ~400 px wide. Slides and documents need the full tab width, and `split_tabs` can
  put the canvas next to the page being discussed.
- The chat gets a **card** in the agent's turn, `📄 <title> · v<N> — Open`. Opening it focuses the
  existing canvas tab or creates one. One tab shows one canvas, with a version picker.
- The panel never renders canvas content itself.

### 3.2 Isolation — host page plus a sandboxed frame

```
canvas.html  (extension page — trusted chrome: title, versions, banner, export; NEVER agent HTML)
  └─ <iframe src="canvas-frame.html">  (manifest sandbox page — opaque origin, no chrome.*)
        renders the content: markdown / reveal / chart / mermaid / html
```

- **Host → frame:** `postMessage({type:"render", kind, content, version})`. The frame never fetches
  anything; everything it shows arrives in this message.
- **Frame → host:** a fixed, small schema only: `ready`, `rendered{version}`, `error{msg}`,
  `selection{text}` (phase 2), `save{content, baseVersion}` (phase 2 editing). The host checks
  `event.source === frame.contentWindow`, validates the type and fields, caps sizes, and ignores
  everything else. The host only ever treats frame output as data.
- **Sandbox CSP** (`content_security_policy.sandbox`):
  ```
  sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none';
  form-action 'none'; base-uri 'none'
  ```
  The `sandbox` token list is just `allow-scripts`: no `allow-same-origin`, `allow-popups`,
  `allow-forms`, `allow-top-navigation` or `allow-modals`. With `connect-src 'none'`, `img-src`
  limited to `data:`/`blob:`, no forms, no popups and no navigation, content in the frame has **no
  way out except `postMessage` to the host**, and the host accepts only the schema above.
- **Residual risk: phishing UI.** Agent HTML can draw a fake login form. Typed text cannot leave
  (no network, no form action), but the user could be misled. The host therefore shows a permanent
  banner: *"Agent-generated content — Katashiro never asks for passwords or keys here."*
- Chrome documents that a custom sandbox CSP may restrict further, but must keep the `sandbox`
  directive with `allow-scripts`. The default is `sandbox allow-scripts allow-forms allow-popups
  allow-modals; script-src 'self' 'unsafe-inline' 'unsafe-eval'; child-src 'self'` `[MV3-Sandbox]`, so
  ours is a strict tightening. To verify during implementation: Chrome loads the extension with it.

### 3.3 Content kinds, in phases

| Phase | `kind` | Engine (vendored, exact pin) | Notes |
|---|---|---|---|
| 1 | `markdown` | existing markdown-it + DOMPurify + hljs | same sink as the chat, full width |
| 1 | `slides` | reveal.js 6.0.2 + markdown plugin | `---` between slides (`data-separator`); PDF via print |
| 1 | `image` | existing `show_image` decode path | `imageId` (screenshot) or `data` |
| 2 | `chart` | Chart.js 4.5.1 | JSON config only; no JS callbacks |
| 2 | `html` | none (agent HTML + inline JS) | needs `script-src 'unsafe-inline'` in the sandbox only |
| 3 | `mermaid` | `@mermaid-js/tiny` 12.1.0 | also renders ```` ```mermaid ```` fences in `markdown` |

- Phase 1 runs **no agent-authored script**. Every engine is our own vendored code.
- Phase 2's `html` kind is the first to run agent script. It adds `'unsafe-inline'` to the sandbox
  `script-src` and nothing else: still no network and no eval.
- **Mermaid supersedes the markdown ADR's dagre lean** `[MD-ADR §3.6]`. That lean existed because
  mermaid could not run on an extension page, and in the sandbox it can. Chat bubbles keep showing
  mermaid fences as code; the canvas renders them.
- React/Babel: not planned. Babel needs eval, and `html` + Preact (`htm`, no build step) covers
  the cases.

### 3.4 Agent tools

| Tool | Does |
|---|---|
| `katashiro.canvas_open({title, kind, content \| imageId \| data, id?, baseVersion?})` | Without `id`: creates a canvas and returns `{id, version: 1}`. With `id`: a new version, re-rendered live. |
| `katashiro.canvas_read({id, version?})` | Returns content plus version history (author, time), including **user edits** |
| `katashiro.canvas_list()` | Lists the conversation's canvases: id, title, kind, latest version, last author |
| `katashiro.canvas_patch({id, baseVersion, edits:[{find, replace}]})` | Phase 2: patches a long document without resending it |

- Caps: 2 MB text per version, 5 MB images (as `show_image`). Writes are rate-limited like `notify`.
- Large payloads use a shell helper that posts to the facade (the `show_image` skill pattern), so
  the content does not pass through model output twice.
- Not gated by act mode: like `show_image`, it changes nothing on any web page.

### 3.5 Versions and concurrency (editing is phase 2)

- Each save is a version `{n, author: "agent" | "user", at, content}`.
- **Optimistic concurrency.** An agent update carries `baseVersion`. If the canvas has moved on
  (the user edited it), the call is **rejected** and returns the current version, so the agent
  reads and re-applies. A user's edit is never silently overwritten.
- While an agent write is rendering, the editor is briefly read-only.
- User edits reach the agent through `canvas_read`. Open question 4: should the next prompt also get
  a one-line note such as `[canvas "X" edited by user: v5 → v6]`?
- Editors (phase 2): Milkdown crepe for `markdown`, and CodeMirror 6 source + live preview for
  `slides`. **Both run inside the sandbox frame.** The host receives only the saved markdown string
  via `save{}`. Phase 1 is view-only.

### 3.6 Storage and ownership

- `chrome.storage.local`, with one key per canvas, `canvas:<id>` holding `{meta, versions[]}`, plus
  an index. Caps: 50 canvases and 20 versions each (oldest dropped, the first version kept).
  Consider the `unlimitedStorage` permission.
- **A canvas belongs to a conversation** (`conversationId`, already minted by #61). When
  multi-conversation lands, switching conversation switches the canvas list. Until then, the
  window's conversation owns it.
- Incognito panels use `storage.session`, mirroring the chat history (#54).

### 3.7 Chat integration

- The card sits in the agent's turn. Clicking it opens the canvas at the version that turn created.
- **Reply-to** (#61) may quote a canvas version, rendering `↩ 📄 title v3`.
- `chat_history` records `[canvas "title" v3]` placeholders, not the content (as with images).

### 3.8 Export and import

- **PDF** (phase 1): reveal's `?print-pdf` for slides, and the browser print dialog for markdown.
- **pptx export** (phase 2–3): `pptxgenjs` from **our slide model** (titles, bullets, images,
  code as monospace). The result is editable in PowerPoint but **not pixel-faithful**: reveal CSS
  and themes, fragments and transitions are lost. `dom-to-pptx` is the higher-fidelity candidate,
  to evaluate then.
- **pptx import** (phase 3+, not committed): `pptxtojson` → markdown slides, keeping titles, text and
  images. **Layout will not survive.** It is positioned as "bring the content in", not "round-trip".

---

## Consequences

### Positive
- Long and structured output gets a full-width, persistent, versioned home, and the chat stays short.
- Diagrams and charts render in Brett's Chrome. The agent container needs no browser.
- Agent-authored script is possible (phase 2) without touching the token-holding origin.
- One model (versioned canvas plus card) serves documents, slides, charts and diagrams.

### Negative / tradeoffs
- Vendor weight: reveal.js ~120 KB + CSS/themes, Chart.js ~200 KB, mermaid-tiny 2.7 MB (phase 3).
  The release zip grows by roughly 3 MB at full scope.
- A second rendering path (sandbox) beside the panel's markdown sink, with its own security review.
- Version storage can grow quickly for big slide decks. Caps are needed, and old versions are lost.
- pptx in either direction is lossy and must be described honestly in the UI.

### Neutral
- No openab changes: tools ride the existing MCP-over-ACP tunnel.
- The markdown ADR §3.6 dagre lean is superseded for the canvas. The chat is unchanged.

---

## 4. Alternatives considered

- **Render in the side panel.** Too narrow, and agent HTML would sit next to the tokens. Rejected.
- **Host the canvas on a remote origin** (artifacts-style separate domain, e.g. S3/CloudFront).
  That needs infra, network egress and auth, and the content leaves the machine. Rejected; the MV3
  sandbox gives the same isolation offline.
- **`data:` URL in a new tab.** Chrome restricts top-level `data:` navigation, a `data:` page has no
  channel back for versions/edits, and its CSP is not ours to set. Rejected.
- **Offscreen document.** Not visible, and it has `chrome.*` access. Wrong tool.
- **Render on the server and send images** (mmdc, headless Chrome in the agent). Heavy (a browser in
  every agent container, and not covered by state backup), static, and not editable. Kept only as
  `show_image` for one-off pictures.
- **Quill for editing.** It loses markdown structure on a round trip (§2). Rejected for Milkdown and
  CodeMirror.

## 5. Scope and non-goals

- **Phase 1 scope:** canvas tab and sandbox frame, `markdown`/`slides`/`image`, `canvas_open`/
  `canvas_read`/`canvas_list`, versions, card, PDF via print. **View-only.**
- Non-goals: real-time multi-user collaboration; network access from canvas content; arbitrary npm
  packages at runtime; pixel-faithful pptx.

## 6. Open questions (for Brett)

1. **Surface:** a canvas tab (proposed), or a resizable drawer inside the panel?
2. **`html` kind:** do we want agent-authored script at all (phase 2), or stop at
   markdown/slides/chart/mermaid?
3. **Caps:** are 50 canvases × 20 versions enough?
4. **Edit visibility:** auto-note user edits in the next prompt, or only via `canvas_read`?
5. **Order:** canvas phase 1 before multi-conversation (conversationId already exists), or after?

---

## References

- `[Artifacts]` Anthropic — What are artifacts and how do I use them? https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them
- `[Canvas]` OpenAI — Introducing canvas. https://openai.com/index/introducing-canvas/
- `[MV3-CSP]` Chrome for Developers — Manifest: content_security_policy. https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy
- `[MV3-Sandbox]` Chrome for Developers — Manifest: sandbox. https://developer.chrome.com/docs/extensions/reference/manifest/sandbox
- `[MD-ADR]` [chat-markdown-rendering.md](./chat-markdown-rendering.md)
- `[Reveal6]` reveal.js 6.0.0 release notes. https://github.com/hakimel/reveal.js/releases/tag/6.0.0
- `[Mermaid12]` mermaid 12.0.0 release notes. https://github.com/mermaid-js/mermaid/releases
- pptxgenjs https://github.com/gitbrent/PptxGenJS · pptxtojson https://www.npmjs.com/package/pptxtojson ·
  Milkdown https://milkdown.dev · Chart.js https://www.chartjs.org
