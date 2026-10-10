---
name: katashiro-show-image
description: Show an image to the user in their Katashiro side panel (a chart, diagram, rendered output, or a screenshot you took) without passing the image bytes through the model. Use when you are chatting with the user through Katashiro and a picture would explain better than text. Keywords — show image, send image, display picture, show chart, show diagram, 給我看圖, 傳圖, katashiro image.
---

# katashiro-show-image

OpenAB relays **text only** from the agent to the chat client, so in a Katashiro chat you cannot
attach an image to your reply. Katashiro's `katashiro.show_image` tool fills that gap: it renders
an image in the side panel, inside your current turn, above your reply.

**Never emit image base64 yourself** (as tool arguments or markdown) — every character is an
output token. Use one of the two paths below; neither puts the bytes through the model.

## Requirements

- You are an agent running under **OpenAB** (the `OPENAB_SESSION_TOKEN` env var is set) and the
  current chat is a **Katashiro** chat — its browser tunnel is attached. In a Discord/Slack thread
  or a cron-triggered turn there is no Katashiro to show it in.
- Katashiro with `katashiro.show_image` (check with the facade's `search_capabilities`, or
  `katashiro.client_info` for the build).
- `bash`, `curl`, `jq`, `base64` on the agent host.

## 1. A screenshot of a browser tab → `imageId` (no script needed)

Call `katashiro.screenshot`, take the `imageId` from its result, then call
`katashiro.show_image` with `{ "imageId": "<id>", "caption": "…" }`. The capture never leaves the
browser.

## 2. An image file on your machine → the script

```bash
<skill-dir>/scripts/show-image.sh <file.png|jpg|jpeg|gif|webp> ["optional caption"]
```

The script does the MCP handshake with the local OpenAB facade (`127.0.0.1:8848`, override with
`OAB_FACADE_URL`), base64-encodes the file into a request body, and calls `katashiro.show_image`.
You only see one line back, e.g. `shown to the user: 1200×800 image/png (84 KB) — "build graph"`.

- Limit: **5 MB** per image. Shrink or re-export larger files first.
- Types: png, jpeg, gif, webp. For an SVG (e.g. mermaid `mmdc` output), export PNG instead
  (`mmdc -i x.mmd -o x.png`).
- `caption` ≤ 200 characters, shown under the image.

## Errors

| Message | Meaning / fix |
|---|---|
| `OPENAB_SESSION_TOKEN is not set` | Not running under OpenAB — this skill cannot work here |
| `unknown capability "katashiro.show_image"` | No Katashiro tunnel on this chat, or Katashiro is too old — ask the user to update/reload it |
| `… is capped at 5242880` | Image too large — shrink it |
| `does not decode as image/…` | The file is not really that image type |

## Notes

- Shown images are kept in memory only, like images the user pastes; after the panel reloads the
  history shows a "（N 張圖片未保存）" marker instead.
- The script never prints the session token; do not echo it yourself either.
