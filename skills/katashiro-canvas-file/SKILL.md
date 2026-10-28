---
name: katashiro-canvas-file
description: Put a file from your machine into a Katashiro canvas — an html page (an Archify diagram, a calculator, a sortable table), a long markdown report, a slide deck, a mermaid source or an image — without passing its bytes through the model, with scripts/canvas-file.sh. Use when you are chatting through Katashiro and the canvas content already sits in a file, or is too large to send as tool arguments (anything over a few KB; an html page always). Keywords — canvas from file, upload html to canvas, html canvas, open file in canvas, Archify canvas, 把檔案放進畫布, 上傳 html 畫布.
---

# katashiro-canvas-file

`katashiro.canvas_open` takes the canvas content as a tool argument. For a file that already
exists — or anything large — **do not read it and pass it yourself**: every character is an output
token (a 0.85 MB html page is about 250 K tokens). The script sends the file to the OpenAB facade
directly, and you only see one line back.

## Requirements

- You are an agent running under **OpenAB** (the `OPENAB_SESSION_TOKEN` env var is set) and the
  current chat is a **Katashiro** chat — its browser tunnel is attached. In a Discord/Slack thread
  or a cron-triggered turn there is no Katashiro to put the canvas in.
- Katashiro with `kind: "html"` in `katashiro.canvas_open` (check `search_capabilities`), for html.
- `bash`, `curl`, `jq` on the agent host (`base64` too, for images).

## Usage

```bash
<skill-dir>/scripts/canvas-file.sh <file> --kind html --title "Checkout architecture"
<skill-dir>/scripts/canvas-file.sh <file> --kind html --title "…" --id cv_0123456789ab [--base 3]
```

- `--kind`: `html` (≤ 4 MB), `markdown` / `slides` / `mermaid` (≤ 2 MB), `image` (≤ 5 MB; png,
  jpg, gif, webp, svg; optional `--caption`).
- Without `--id` it creates a canvas and opens its tab in the background. With `--id` it writes a
  new revision of that canvas: on top of `--base` (the version you last wrote or read), or, without
  it, on top of whatever version the canvas has now. Pass `--base` when the user may have edited a
  markdown or slides canvas since your last write — a stale write is refused instead of replacing
  their edit.
- The line it prints is `canvas_open`'s result plus the kind and size, e.g.
  `created canvas "Checkout architecture" — id cv_…, version 1 (opened in a background tab) (html, 846 KB)`.
  Keep the id for the next revision.

## html canvases

- The user first sees the page **without its scripts** (its HTML, CSS and SVG, sanitized). Its
  scripts run only after they click **▶ Run scripts**, once per revision; a new revision goes back
  to the view without scripts. Tell them to press it when the page needs interaction.
- No network (`fetch`, XHR, WebSocket are blocked), no `eval`, no workers, no storage (an opaque
  origin), no clipboard. Fonts and images must be inline (`data:`). Downloads work after Run scripts.
- Links the page draws open in a new tab only after the user confirms.
- `canvas_read` on an html canvas returns its first 16 K characters (plus `bytes` and `sha256`);
  `full: true` for all of it. Your own source (the JSON you rendered it from) is the better thing
  to read and change.
- An html canvas is replaced whole: no `canvas_patch`, no user edits.
- The user can turn html canvases off in Settings; then `canvas_open` refuses kind html — say so
  and use markdown or an image instead.

## Errors

| Message | Meaning / fix |
|---|---|
| `OPENAB_SESSION_TOKEN is not set` | Not running under OpenAB — this skill cannot work here |
| `unknown capability "katashiro.canvas_open"` | No Katashiro tunnel on this chat |
| `kind "html" is not supported yet` | Katashiro is too old for html canvases — ask the user to update it |
| `html canvases are turned off …` | The user turned them off in Settings |
| `… is capped at …` | The file is too large for that kind |
| `stale` (JSON with `currentVersion`) | The canvas moved on since `--base`: read it, then write again |

The script never prints the session token; do not echo it yourself either.
