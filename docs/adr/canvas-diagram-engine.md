# ADR: Diagram engine setting — Mermaid or Pele, one global choice

- **Status:** Proposed
- **Date:** 2026-10-30
- **Author:** Brett Chien (drafted by Orca)
- **Related:** [canvas](./canvas.md) §3.2 (sandboxed `canvas-frame.html`), §3.3 (mermaid as
  implemented), §3.8 (print re-themes diagrams), §3.10 (diagram blocks keyed by source);
  `vendor/BUILD.md` (`mermaid/`, reproducible rebuild, `THIRD_PARTY_NOTICES.md`);
  Pele (<https://github.com/obsidianmd/pele>, MIT, npm `pele`); Archify (`explainer/charts.mjs`
  vendors a Pele subset; prior art below).

> Brett, 2026-10-30: the user picks the diagram engine **in Settings, for all canvases**. Not a
> per-tab toggle, not a per-canvas field, no automatic fallback (§4 lists them).

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
| `dist/pele.global.js` | 730,358 bytes, 273,749 gzip | about a quarter of `mermaid.tiny.js`; +0.7 MB to the extension while both ship |
| Network / eval / workers | no `fetch`, XHR, `eval`, `new Function`, `Worker`, `importScripts` in the bundle | fits the sandbox CSP (`connect-src 'none'`, `worker-src 'none'`) — static scan only, not yet run under the CSP |
| `foreignObject` | only for math labels (`pele-math`), HTML inside | `SVG_DP` already keeps `foreignObject` with the html profile (canvas §3.3) |
| `scripts/smoke-mermaid.mjs` `KINDS` (14) + flowchart, sequence, class, state, **mindmap, architecture** | 20 / 20 render (Node) | covers all we draw today, plus the two the tiny build lacks |
| Its `HOSTILE` fixture | output has no `on*` attribute and no `javascript:` URL (checked on the parsed DOM) | the frame's DOMPurify pass stays a second check, as with mermaid |
| A broken diagram | throws `PeleError` with `line` / `column` | a better error for the agent than mermaid's |
| Licence | MIT, © 2026 kepano | one notice instead of mermaid's dependency tree |

Pele also draws types Mermaid 12.1 does not have (e.g. `wardley`, `cynefin`, `railroad`,
`agentflow`). A canvas using one only renders with Pele.

**Prior art.** Archify 3.2 vendors an unmodified Pele 1.3.0 subset (pie, xychart, quadrant,
sankey, radar, venn) for the charts in its explainer pages, and draws flow-type diagrams with its
own renderers.

### 1.3 Why a setting, not a swap

What Pele looks like in our canvases (dark screen theme, light print theme, fonts, edge labels,
slides) is unverified in real Chrome. A setting lets the user compare and keep Mermaid until Pele
is seen to be good; replacing Mermaid is a later decision (§6 Q1).

## 2. Decision

### 2.1 The setting

- **Settings → 圖表引擎：Mermaid / Pele**, beside **html 畫布**. Stored in `chrome.storage.local`
  under `canvas:diagramEngine`: `"pele"` selects Pele, **anything else (absent included) is
  Mermaid** — the default stays Mermaid (§6 Q1). `CanvasStore.diagramEngine(raw)` normalizes it,
  like `htmlEnabled`.
- **Global:** every canvas tab, every diagram (fences in `markdown` / `slides`, `mermaid`
  canvases), the compare view and print. It changes how a canvas is **displayed**, never its
  content, versions or `agentVersion`. Chat bubbles are untouched (they show mermaid fences as code).
- **Live:** open canvas tabs listen to `chrome.storage.onChanged` (as for `canvas:htmlEnabled`) and
  re-render their diagrams with the new engine; the canvas's scroll position is kept, an edit in
  progress is not interrupted (its preview re-renders on the next change, as today).

### 2.2 In the frame

- The host (`canvas.js`) passes `engine: "mermaid" | "pele"` in each `render` message. The frame
  trusts only these two values; anything else is Mermaid.
- `loadEngine(engine)` replaces `loadMermaid()`: `vendor/mermaid/mermaid.tiny.js` or
  `vendor/pele/pele.global.js`, each loaded on first use and cached, from `'self'` only. A canvas
  without a diagram loads neither, as today.
- `renderDiagram(engine, source, theme)` dispatches:
  - **Mermaid:** unchanged (`securityLevel: "strict"`, dagre, `htmlLabels: false`, the queue).
  - **Pele:** `pele.render(source, { images: false })` — synchronous, so no queue; no external
    images (the frame's `img-src` would block them anyway).
- **The same sink for both:** the SVG string goes through `DOMPurify.sanitize(svg, SVG_DP)` and the
  sanitized nodes are moved in (`setDiagramSvg`); `onLinkClick` → `openLink` + confirm for a drawn
  link; the meta CSP behind it. No engine-specific trust.
- `figure.ks-mermaid`, `diagramSource`, `CanvasCore.mermaidKey` and `MERMAID_SEL` stay as they are:
  the block key is the source, so §3.10 (show changes), `canvas_highlight` and Ask agent's source
  lines work the same with either engine and across a switch.

### 2.3 Themes and print

- **Mermaid:** unchanged (`dark` on screen; print re-renders with `default` and the white edge-label
  CSS, §3.8).
- **Pele:** colours come from its CSS variables (`--pele-*`). `canvas-frame.css` sets a dark set for
  the screen and a light set under `@media print`; print does **not** re-render Pele diagrams.
  `rethemeDiagrams` skips them. A deck still prints dark (as today).
- The exact variable values are picked while looking at real Chrome (§5); they must keep edge
  labels readable on paper (the reason for Mermaid's print CSS).

### 2.4 Errors and what the agent is told

- A diagram that fails keeps its source with the error above it, and `diagramError{}` reaches the
  host, as today. The message **names the engine**: `Pele: Parse error on line 3, column 3: …` /
  `Mermaid: …`, so the agent knows which grammar complained.
- A diagram type the current engine does not draw (mindmap / architecture with Mermaid; a Pele-only
  type with Mermaid) says so and adds: `try the other diagram engine (Settings → 圖表引擎)`. The
  frame cannot switch the setting; only the user can.
- `katashiro.client_info` reports `diagram engine: mermaid|pele`. `canvas_open`'s description says
  mindmap and architecture **need Pele**, instead of "not mindmap or architecture".

### 2.5 Vendoring

- `vendor/pele/pele.global.js` from `pele@1.12.0`, copied as published (not rebuilt), pinned with
  its sha256 in `vendor/BUILD.md` next to `mermaid/`, through `scripts/vendor-build`.
- `THIRD_PARTY_NOTICES.md` regenerated as `vendor/BUILD.md` says (#174): adds Pele's MIT notice.
- Mermaid stays vendored while it is an option.

## 3. Consequences

### Positive
- mindmap and architecture diagrams become possible (with Pele), and Pele-only types too.
- With Pele on, a canvas with a diagram loads 0.7 MB instead of 2.7 MB, and printing does not
  re-render.
- Agent errors carry line and column.
- No data change: either engine, switch any time, nothing to migrate.

### Negative / tradeoffs
- +0.7 MB in the extension while both ship.
- Two renderers to keep working: every diagram test runs twice (§5).
- The same canvas can look different on two machines (the setting is local). A screenshot the agent
  takes shows whichever engine this browser uses.
- A canvas written for one engine (a Pele-only type) shows an error on the other.

## 4. Alternatives considered

1. **Header toggle per tab** (⇆ Mermaid / Pele, not saved). Good for comparing one diagram;
   rejected by Brett for now — one global choice is simpler. Can be added later on top of §2.2.
2. **Automatic fallback** (draw with the default, try the other on failure). Hides which engine
   drew what, and a Pele-only diagram would silently "work" for one user and fail for another.
   Rejected for now; §2.4's hint covers the case.
3. **Per-canvas engine** (a field in canvas meta). Changes the data model and the agent tools for a
   display preference. Rejected.
4. **Replace Mermaid with Pele outright.** −2.8 MB, one renderer. Rejected for now: appearance in
   our canvases unverified (§1.3); revisit after §6 Q1.

## 5. Verification plan

- **Unit:** `CanvasStore.diagramEngine` normalization; `render` message carries the engine; error
  text names the engine.
- **Smoke (`scripts/smoke-mermaid.mjs`):** every existing section runs once per engine in the real
  frame under the manifest's sandbox CSP — 0 CSP violations, 0 Workers, all `KINDS` labels kept,
  `HOSTILE` leaves no handler / script URL, the load-failure path. Pele additionally: mindmap and
  architecture render; with Mermaid they show the "try the other engine" note.
- **e2e:** switching the setting re-renders an open canvas tab's diagram without reload; print
  preview of a Pele diagram uses the light variables.
- **Real Chrome (manual, Brett):** a document, a deck and a mermaid canvas under both engines,
  screen and print; this is what decides §6 Q1.

## 6. Open questions (for Brett)

1. **Default.** Stay Mermaid (this ADR) until Pele is seen in real Chrome — then switch the default
   to Pele? And later drop Mermaid (−2.8 MB)?
2. **Settings label.** `圖表引擎` with `Mermaid` / `Pele` — or explain the difference inline (e.g.
   `Pele（較小，支援 mindmap / architecture）`)?
