---
name: katashiro-archify
description: Draw an interactive architecture / workflow / sequence / dataflow / lifecycle / ERD / class / tree / timeline / waterfall diagram, or an explainer page, with Archify and show it to the user as a Katashiro html canvas (pan, zoom, route tracing, themes after ▶ Run scripts). Use when you are chatting through Katashiro and the user asks for a diagram of a system, a flow or a data model that they will explore, or asks for Archify. Keywords — archify, architecture diagram, system diagram, workflow diagram, sequence diagram, ERD, interactive diagram, explainer, 架構圖, 流程圖, 互動圖表, 畫架構.
---

# katashiro-archify

[Archify](https://github.com/tt-a1i/archify) turns a typed JSON description into one standalone
interactive HTML file. Katashiro shows that file as an **html canvas** (canvas-html ADR §2.5). This
skill sits on top of Archify's own skill: author and render the way Archify's skill says, then
deliver the file into a canvas the way this one says.

## Requirements

- Archify's skill, installed where you run: `npx skills add tt-a1i/archify` (Katashiro does not
  vendor Archify), and Node ≥ 18.
- The `katashiro-canvas-file` skill (its `scripts/canvas-file.sh`), and a Katashiro chat with html
  canvases on.

## Steps

1. **Author and render** as Archify's skill says, in a scratch folder:
   `/tmp/archify/<slug>-<timestamp>/` (`<slug>.json` → `<slug>.html`). Pick the diagram type from
   what the user asked for; ask only if it is really unclear.
2. **Finalize**: `archify finalize <type> <slug>.json <slug>.html`.
   - On a host with no Chrome, a run whose **only** failure is `browser-check` with
     `viewer/chrome-unavailable` — `validate`, `deliver` and `check` passing — is accepted. Your
     reply then says that Archify's browser check did not run.
   - Any other failure: repair it as Archify's skill says, and finalize again.
3. **Upload**:
   `<canvas-file-skill>/scripts/canvas-file.sh <slug>.html --kind html --title "<what it shows>"`.
   For a new revision of a diagram you already showed, add `--id <canvasId>`. Never read the HTML
   into your context or pass it as tool arguments: it is ~0.5–2.4 MB.
4. **Optional visual check**: `katashiro.screenshot` of the canvas tab (`katashiro.switch_tab` to it
   first, then back). Before Run scripts it shows the diagram's own pre-rendered SVG — enough to
   check the layout. Report it as an automated check, not as the user's review. It stands in for
   Archify's browser check.
5. **Tell the user** what the diagram shows, and that **▶ Run scripts** in the canvas header makes it
   interactive (pan / zoom, trace a route, focus a node, themes). Exports (PNG / SVG / WebM) work
   after that; Archify's Copy button does not (the clipboard stays closed).

## Revisions

Change the JSON, not the HTML: edit `<slug>.json`, finalize again, upload with `--id`. The user's
canvas then shows the new revision without its scripts until they press ▶ Run scripts again.
`canvas_read` on the canvas returns only the first 16 K characters of the HTML — your JSON is the
source of truth.

## Notes

- Deep links into a view (`#focus=…`, `#route=…`) are not supported in the canvas.
- Archify's CLI may check for updates over the network on the agent host; the HTML itself makes no
  requests (and could not: the canvas has no network).
- If html canvases are turned off (`canvas_open` refuses), offer a screenshot instead: the static
  view is not available then either, so render the diagram to PNG with Archify only if this host
  has Chrome; otherwise describe it in text.
