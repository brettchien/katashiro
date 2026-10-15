---
name: katashiro-point-at
description: Point the user at something in the browser while you explain it — glow an element on the page they are looking at (katashiro.highlight), emphasise several parts at once with temporary CSS (katashiro.inject_css), glow a block in a Katashiro canvas (katashiro.canvas_highlight), or emphasise several parts of a canvas with temporary CSS (katashiro.canvas_inject_css). Use when you are chatting through Katashiro and say "this button", "this paragraph", "here", or walk the user through a page, document or canvas. Keywords — highlight, point at, show me where, glow, emphasise, mark up the canvas, colour these rows, 指給我看, 標出來, 畫布標記, 哪裡, katashiro highlight.
---

# katashiro-point-at

When you explain something the user can see in their browser, **show them where it is** instead of
describing it ("the third button in the toolbar"). Katashiro gives you three ways, from lightest to
heaviest. Pick the lightest that works.

## Requirements

- The current chat is a **Katashiro** chat (its browser tunnel is attached), so `katashiro.*` tools
  are available. Not in Discord/Slack threads or cron turns.
- The thing to point at is in the **active tab** (the one the user is looking at). If it is in
  another tab: with act mode on, `katashiro.switch_tab` first and say so; `switch_tab` is a write
  tool, so with act mode off ask the user to switch to that tab themselves.

## 1. One element on a page → `katashiro.highlight` (default)

1. Target the element: its `ref` from `katashiro.snapshot` (or the snapshot an action just
   returned), or a CSS `selector` for a non-interactive element (see below).
2. `katashiro.highlight` with `{ref, snapshotId}` or `{selector}`, plus `label` and `durationMs`.
   It checks the element is visible and scrolls it to the center itself; no separate `scroll`
   needed.

- Snapshots give `ref`s only to interactive elements. For a heading or paragraph, pass a CSS
  `selector` instead. `read_dom` returns raw HTML, not selectors: read the markup and write a
  selector from it (prefer an id or a stable class), e.g. on GitHub markdown
  `.markdown-heading:has(a[id^="user-content-310-"])`.
- A `selector` is looked up in the top-level page only. For an element inside an iframe, use its
  snapshot `ref` (`f<N>:eN`).
- `label`: a few words, max 80 characters ("Save button", "the 200 MB limit").
- `durationMs`: default 4000, max 15000. Use longer while you explain in the same turn.
- Read-only and harmless: the outline lives in Katashiro's own overlay, never changes the page,
  ignores the pointer and disappears by itself. Works with act mode off.
- Several elements in sequence: highlight one, say what it is, then the next. Don't fire many at
  once; the user can't follow.

## 2. Several parts at once, or a lasting emphasis → `katashiro.inject_css`

Use it when an overlay is not enough: compare several rows, dim everything except one section, or
keep emphasis while the user scrolls.

```css
/* glow the elements you mean; selectors written from read_dom markup, not snapshot refs */
.pricing-table tr:nth-child(3), #limits h2 {
  outline: 3px solid #f59e0b !important;
  box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.35) !important;
  border-radius: 4px !important;
}
```

- Needs **CSS selectors**. Snapshot `ref`s are not selectors. Read the region's markup with
  `katashiro.read_dom` (raw HTML) and write a selector from it (prefer an id or a stable class).
- To dim the rest of a page, keep `opacity` at 0.3 or above so the content stays readable.
- Use `!important` to win over the site's styles.
- It is a **write** tool, gated by act mode. If act mode is off, fall back to `highlight`.
- Refused: anything that fetches (`url()`, `src()`, `image()`, `image-set()`, `cross-fade()`,
  `element()`, `@import`, `@font-face`), `@namespace`, and CSS escapes (`\`). Use colors, outlines,
  shadows and opacity only.
- **Always clean up**: call `katashiro.inject_css` with `{clear: true}` when you are done or the
  user moves on, and tell the user it is temporary (it also disappears on reload).
  - `clear` works on the **active tab** only. Clear **before** `switch_tab`, or the old tab keeps
    the CSS.
  - `clear` removes every sheet Katashiro injected into that tab, including styles the user asked
    for earlier (e.g. a reading theme). If there are any, re-apply them after clearing, or tell
    the user.
- Never hide content the user needs, and never restyle a page to look like something it is not
  (fake banners, fake buttons). Emphasise; don't alter.
- **Not for canvases.** `inject_css` never reaches a canvas tab (a `chrome-extension://` page):
  in the conversation on screen it is refused there; in a background conversation it acts on your
  **working tab** — some web page, not the canvas the user is looking at. For canvases use
  `katashiro.canvas_inject_css` (§4).

## 3. A part of a Katashiro canvas → `katashiro.canvas_highlight`

For canvases (documents and slides the agent rendered; see the canvas ADR,
`docs/adr/canvas.md`), use `katashiro.canvas_highlight` with
`{id, find | heading, label, durationMs}`. It scrolls the canvas to the block and glows it.
`find` matches the block's **rendered text** (what the user sees, not the markdown source), at
most 500 characters, and must match exactly one block; `heading` matches a heading's rendered
text exactly. No match or several matches is an error. The effects are fixed (outline and
background only), and you only give a text anchor. `durationMs` is
capped at 10 s and calls are rate-limited; it is refused on `html` canvases; while the user is
editing, it does not scroll but asks the user ("Agent wants to show you a section").
For several blocks at once, or an emphasis that stays while you talk, use §4.

After you write a new canvas version the changed blocks glow on their own, so you don't need to
highlight your own edits. Use `canvas_highlight` to point at something specific while you explain.

## 4. Several parts of a canvas, or a lasting emphasis → `katashiro.canvas_inject_css`

`inject_css` for canvases. `{id, css}` applies a stylesheet to every open tab of that canvas
(a canvas not open is opened in front). Visual only: the canvas content never changes, and the
sheets are gone when the tab reloads. Up to 10 sheets add up; `{id, clear: true}` removes them
all. Refused while the user is editing (`clear` always works). Same refusals as `inject_css`
(nothing that fetches, no CSS escapes). Not available from a background conversation.

Rendered markdown is flat HTML — `h1`–`h6`, `p`, `ul`/`ol`/`li`, `pre`, `table`/`tr`/`td`,
`blockquote` as siblings under one parent — so a "section" is a heading plus the siblings after it,
up to the next heading of that level:

```css
/* frame the 2nd h2 section (heading + its blocks) in blue */
h2:nth-of-type(2),
h2:nth-of-type(2) ~ *:not(h2:nth-of-type(3)):not(h2:nth-of-type(3) ~ *) {
  background: rgba(59, 130, 246, 0.12) !important;
  border-left: 6px solid #3b82f6 !important;
  padding-left: 12px !important;
}
/* tint the 3rd column of every table */
td:nth-child(3), th:nth-child(3) { background: rgba(245, 158, 11, 0.18) !important; }
```

- You cannot `read_dom` a canvas. Write selectors from the markdown you wrote (heading order,
  table columns; `katashiro.canvas_read` if unsure), then check the result with
  `katashiro.screenshot` of the canvas tab.
- Siblings render as separate tinted blocks with small gaps, not one continuous box. That is fine.
- Slides: target reveal.js `section`s (`.slides > section:nth-child(2)`); diagrams:
  `figure.ks-mermaid > svg`.
- Colors, outlines, backgrounds and opacity only. **No `::before` / `::after` `content`**: text
  that is not in the canvas is faking content, even as a label — say it in your reply, or use
  `canvas_highlight`'s `label`.
- Tell the user it is temporary; `clear` when you are done or they move on.

## Etiquette

- Point, then explain in one or two sentences. The highlight replaces a long description; don't
  repeat it in words.
- At most a few highlights per turn.
- Highlighting is for the user's attention, never to click or change anything. Acting on the page
  is a separate decision (and act mode).
