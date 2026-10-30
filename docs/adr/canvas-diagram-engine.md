# ADR: Diagram engine — Pele by default, Mermaid as the other engine

- **Status:** Accepted 2026-10-30 (Brett: all three layers, Pele by default; implemented in the PR after #210, with the #210 review folded in — marked *(#210 review)*)
- **Date:** 2026-10-30
- **Author:** Brett Chien (drafted by Orca)
- **Related:** [canvas](./canvas.md) §3.2 (sandboxed `canvas-frame.html`), §3.3 (mermaid as
  implemented), §3.8 (print re-themes diagrams), §3.10 (diagram blocks keyed by source), §3.11
  (agent equivalents of view switches); `vendor/BUILD.md` (`mermaid/`, reproducible rebuild,
  `THIRD_PARTY_NOTICES.md`); Pele (<https://github.com/obsidianmd/pele>, MIT, npm `pele`);
  Archify (`explainer/charts.mjs` vendors a Pele subset; prior art below).

> Brett, 2026-10-30: **all three** — a global setting, a per-tab header switch, and automatic
> fallback to the other engine — and **Pele is the default**.

---

## 1. Context

### 1.1 What draws diagrams today

Every diagram in a canvas — a ```` ```mermaid ```` fence in a `markdown` or `slides` canvas, and a
`kind: "mermaid"` canvas — is drawn by `@mermaid-js/tiny@12.1.0`, loaded on demand into the
sandboxed `canvas-frame.html` (canvas §3.3; `src/canvas/canvas-frame.js` `loadMermaid`,
`renderDiagram`, `renderDiagrams`, `rethemeDiagrams`). It is 2,811,019 bytes (746 KB gzip), lays
out with dagre only (no ELK), and the tiny build has **no `mindmap` and no `architecture`**:
`canvas_open`'s description tells the agent so (`src/mcp/browser-mcp.js`).

### 1.2 Pele

Pele renders Mermaid text to SVG: "Pele supports every diagram type built into Mermaid 12.1.0"
(its README) — the same Mermaid version we vendor, so **the same source text works with either
engine**; nothing stored changes. Synchronous, no runtime dependencies, colours and fonts through
CSS variables. Measured 2026-10-30 on `pele@1.12.0` (first evaluated 2026-10-19 on 1.6.0):

| Fact | Value | Why it matters here |
|---|---|---|
| `dist/pele.global.js` | 730,358 bytes, 273,749 gzip | about a quarter of `mermaid.tiny.js` (2,811,019 bytes); +730 KB to the extension while both ship |
| Network / eval / workers | no `fetch`, XHR, `eval`, `new Function`, `Worker`, `importScripts` in the bundle | fits the sandbox CSP (`connect-src 'none'`, `worker-src 'none'`) — static scan only, not yet run under the CSP |
| `foreignObject` | only for math labels (`pele-math`), HTML inside | `SVG_DP` already keeps `foreignObject` with the html profile (canvas §3.3) |
| `scripts/smoke-mermaid.mjs` `KINDS` (14) + flowchart, sequence, class, state, **mindmap, architecture** | 20 / 20 render (Node) | covers all we draw today, plus the two the tiny build lacks |
| Its `HOSTILE` fixture | output has no `on*` attribute and no `javascript:` URL (checked on the parsed DOM) | the frame's DOMPurify pass stays a second check, as with mermaid |
| A broken diagram | throws `PeleError` with `line` / `column` | a better error for the agent than mermaid's |
| Licence | MIT, © 2026 kepano | one notice instead of mermaid's dependency tree |

Pele also draws types Mermaid 12.1 does not have (e.g. `wardley`, `cynefin`, `railroad`,
`agentflow`).

**Prior art.** Archify 3.2 vendors an unmodified Pele 1.3.0 subset (pie, xychart, quadrant,
sankey, radar, venn) for the charts in its explainer pages, and draws flow-type diagrams with its
own renderers.

### 1.3 Why keep Mermaid at all

Pele is the default, but what it looks like in our canvases (dark screen theme, light print theme,
fonts, edge labels, slides) has not been seen in real Chrome yet, and a younger renderer can differ
on edge cases. Mermaid stays as the other engine: the user can switch back (setting), compare one
canvas (header), and a diagram Pele cannot draw still gets drawn (fallback).

## 2. Decision

Three layers, each narrower than the one before; the engine **actually used** for a diagram is:

1. the tab's header choice, if the user (or the agent, §2.3) set one in this tab; else
2. the global setting; else **Pele**;
3. and if that engine fails on this diagram, the other one (§2.4).

None of them changes a canvas's content, versions or `agentVersion`; they change how it is
**displayed**. Chat bubbles are untouched (they show mermaid fences as code).

### 2.1 The global setting

- **Settings → 圖表引擎：Pele / Mermaid**, beside **html 畫布**. Stored in `chrome.storage.local`
  under `canvas:diagramEngine`: `"mermaid"` selects Mermaid, **anything else (absent included) is
  Pele**. `CanvasStore.diagramEngine(raw)` normalizes it, like `htmlEnabled`.
- **Global:** every canvas tab, every diagram (fences in `markdown` / `slides`, `mermaid`
  canvases), the compare view and print.
- **Live:** open canvas tabs listen to `chrome.storage.onChanged` (as for `canvas:htmlEnabled`) and
  re-render their diagrams; a tab with a header override (§2.2) keeps it.
- The setting is the user's; there is no agent tool for it (like html 畫布 on/off).

### 2.2 The header switch (per tab)

- In the canvas header, for a canvas that has at least one diagram: **圖表：Pele** / **圖表：Mermaid**. A
  click switches **this tab** to the other engine and **re-renders the canvas** with it — every
  fence, the ones both engines failed on included *(#210 review)*. Held markers (顯示變更, a compare)
  come back on rendered{} as after any render; a fading glow does not. *(Simpler than redrawing
  figures in place, which the first draft said: one render path, nothing engine-specific to keep in
  sync.)* Disabled while the user edits.
- **Not saved:** it lasts while the tab is open; a reload, or opening the canvas again, goes back to
  the global setting. Other tabs, and other windows' tabs of the same canvas, are not affected.
- While it differs from the setting, the switch reads as an override (e.g. `圖表：Mermaid（此分頁）`)
  so the user is not misled about the setting.
- Hidden on html and image canvases, and on canvases without a diagram.

### 2.3 The agent's equivalent (canvas §3.11)

`canvas_view({id, engine: "pele" | "mermaid" | "default"})` does what the header switch does, in
that canvas's tab (opened if needed, like `compare`), through the same handler; `"default"` drops
the override. Refused on html / image canvases, with the reason. Not gated by act mode (display
only). The result says which engine each diagram was actually drawn with (fallbacks included,
§2.4), so the agent can screenshot and compare. The global setting stays the user's.

### 2.4 Automatic fallback

- A diagram is drawn with the chosen engine. If that **throws** (parse error, unsupported type,
  engine failed to load), the frame tries the **other** engine once.
- **Fallback succeeded:** the diagram shows, with a small note on its figure —
  `以 Mermaid 繪製（Pele：Parse error on line 3, column 3）` — so neither the user nor a screenshot
  hides which engine drew it. The host gets `diagramFallback{engine, msg, seq}` (not
  `diagramError`); the "diagram failed" banner does not appear.
- **Both failed:** as today — the source stays with the error above it, and `diagramError{}` goes
  to the host, carrying **both** messages, each naming its engine:
  `Pele: Parse error on line 3, column 3: …` / `Mermaid: …`.
- Mermaid is loaded only when it is needed (chosen, or for a fallback); with Pele as the default, a
  normal canvas never loads its 2,811,019 bytes.
- **What the agent is told** *(#210 review: no tab → store path; `canvas_read` stays a pure store
  read)*: which engine drew each diagram is in `canvas_view({engine})`'s result (§2.3), from the
  render's `rendered{diagrams}`; a fallback is noted on its figure (screenshots show it), and when a
  diagram also failed, "send error to agent" carries the fallbacks of that render too.
  `katashiro.client_info` reports the global setting. `canvas_open`'s description drops "not
  mindmap or architecture": both draw with Pele.
- **Mermaid-only styling** *(#210 review)*: `%%{init}%%`, `classDef`, `style`, `linkStyle` may be
  ignored by Pele without an error — so no fallback. The smoke test checks every label is still
  drawn; the styling itself is listed as a known difference in the release notes.

### 2.5 In the frame

- The host (`canvas.js`) passes `engine: "pele" | "mermaid"` (the result of §2.1 + §2.2) in each
  `render` message; a change of either layer is a new render. The frame trusts only these two
  values; anything else is Pele. New frame → host messages, added to `acceptFrameMessage`'s
  allow-list *(#210 review)*: `diagramFallback{msg, seq}`, and `rendered{…, diagrams}` —
  `[{engine: "pele" | "mermaid" | "none", fallback}]`, one per diagram, at most 500.
- `loadEngine(engine)` replaces `loadMermaid()`: `vendor/pele/pele.global.js` or
  `vendor/mermaid/mermaid.tiny.js`, each loaded on first use and cached, from `'self'` only. A canvas
  without a diagram loads neither, as today.
- `renderDiagram(engine, source, theme)` dispatches:
  - **Pele:** `pele.render(source, { fontFamily: <the canvas font>, images: false, idPrefix })` —
    synchronous, so no queue; no external images (the frame's `img-src` would block them anyway).
  - **Mermaid:** unchanged (`securityLevel: "strict"`, dagre, `htmlLabels: false`, the queue).
- **The same sink for both:** the SVG string goes through `DOMPurify.sanitize(svg, SVG_DP)` and the
  sanitized nodes are moved in (`setDiagramSvg`); `onLinkClick` → `openLink` + confirm for a drawn
  link; the meta CSP behind it. No engine-specific trust.
- Each figure records the engine that drew it (`data-engine`). `figure.ks-mermaid`,
  `diagramSource`, `CanvasCore.mermaidKey` and `MERMAID_SEL` stay as they are: the block key is the
  source, so §3.10 (show changes), `canvas_highlight` and Ask agent's source lines work the same
  with either engine and across a switch.

### 2.6 Themes and print

- **Pele:** colours come from its CSS variables (`--pele-*`), set on `figure[data-engine="pele"]`.
  `canvas-frame.css` sets a dark set for the screen and a light set under `@media print`, **scoped to
  `.doc`** so a deck still prints dark *(#210 review)*; print does **not** re-render Pele figures.
  `--pele-bg` equals what the diagram sits on (`#0f172a` in a document, the deck's `#191919` on a
  slide): Pele draws edge labels on an opaque `--pele-bg` box *(#210 review)*. Print changes colours
  only, never the font or its size: Pele measured the labels with the screen font, which
  `--pele-font` repeats *(#210 review)*.
- **Mermaid:** unchanged (`dark` on screen; print re-renders with `default` and the white edge-label
  CSS, §3.8). `rethemeDiagrams` re-renders only figures with `data-engine="mermaid"`.
- A deck still prints dark (as today).
- The exact Pele variable values are picked while looking at real Chrome (§5); they must keep edge
  labels readable on paper (the reason for Mermaid's print CSS).

### 2.7 Vendoring

- `vendor/pele/pele.global.js` from `pele@1.12.0`, copied as published (not rebuilt), pinned with
  its sha256 in `vendor/BUILD.md` next to `mermaid/`, through `scripts/vendor-build`.
- `THIRD_PARTY_NOTICES.md` regenerated as `vendor/BUILD.md` says (#174): adds Pele's MIT notice.
- Mermaid stays vendored while it is the other engine and the fallback.

## 3. Consequences

### Positive
- mindmap and architecture diagrams work out of the box, and Pele-only types too.
- A canvas with a diagram loads 730 KB instead of 2,811,019 bytes; printing Pele figures does not re-render.
- Agent errors carry line and column; a Pele gap does not blank a diagram (fallback).
- No data change: either engine, switch any time, nothing to migrate.

### Negative / tradeoffs
- **The default changes for existing users**: canvases they already have will look different after
  the update. Release notes say so and point at the setting; and the first time Pele draws a diagram
  in a browser, the canvas tab says so once — "圖表現在用 Pele 繪製…" with where to switch back —
  remembered in `canvas:peleNoticeShown` *(#210 review)*.
- +730 KB in the extension while both ship; two renderers to keep working, every diagram test runs
  twice (§5).
- The same canvas can look different on two machines (the setting is local) or in two tabs (header
  switch). The figure note and `data-engine` keep it visible; a screenshot shows what this tab uses.
- A Pele-only diagram falls back nowhere if Pele fails to load (Mermaid cannot draw it): it shows
  both errors.

## 4. Alternatives considered

1. **Setting only** (the first draft of this ADR). Simpler, but no quick comparison and a Pele gap
   shows an error. Superseded by Brett's choice of all three.
2. **Per-canvas engine** (a field in canvas meta). Changes the data model and the agent tools for a
   display preference. Rejected.
3. **Silent fallback** (no figure note). Hides which engine drew what; one user's canvas would
   "work" and another's not, with nothing to tell them apart. Rejected: the note stays.
4. **Replace Mermaid with Pele outright.** −2,811,019 bytes, one renderer. Not yet: appearance unverified
   (§1.3), and Mermaid is the fallback; revisit with §6 Q1.

## 5. Verification plan

- **Unit:** `CanvasStore.diagramEngine` normalization (absent → Pele); engine precedence (header >
  setting > Pele); fallback outcome → `diagramFallback` vs `diagramError` and their texts;
  `canvas_view({engine})` refusals.
- **Smoke (`scripts/smoke-mermaid.mjs`):** every existing section runs once per engine in the real
  frame under the manifest's sandbox CSP — 0 CSP violations, 0 Workers, all `KINDS` labels kept,
  `HOSTILE` leaves no handler / script URL, the load-failure path. Plus: mindmap and architecture
  render with Pele; with Mermaid chosen they fall back to Pele and carry the note; a diagram both
  reject shows both errors; with Pele as the engine a canvas never requests `mermaid.tiny.js`.
- **e2e:** the setting re-renders an open tab without reload; the header switch re-renders only its
  tab and is gone after reload; `canvas_view({engine})` matches the switch; print preview of a Pele
  figure uses the light variables.
- **Real Chrome (manual, Brett):** a document, a deck and a mermaid canvas under both engines,
  screen and print.

## 6. Open questions (for Brett)

1. **Dropping Mermaid later** (−2,811,019 bytes): after Pele has been the default for a while, keep Mermaid
   only as the fallback, or remove it (and with it the header switch and the fallback)?
2. **Labels.** Settings `圖表引擎：Pele / Mermaid` and header `圖表：Pele ⇆ Mermaid` — or explain
   the difference inline (e.g. `Pele（預設，較小，支援 mindmap / architecture）`)?
