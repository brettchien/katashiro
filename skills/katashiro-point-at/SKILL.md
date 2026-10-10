---
name: katashiro-point-at
description: Point the user at something in the browser while you explain it — glow an element on the page they are looking at (katashiro.highlight), emphasise several parts at once with temporary CSS (katashiro.inject_css), or glow a block in a Katashiro canvas (katashiro.canvas_highlight). Use when you are chatting through Katashiro and say "this button", "this paragraph", "here", or walk the user through a page or document. Keywords — highlight, point at, show me where, glow, emphasise, 指給我看, 標出來, 哪裡, katashiro highlight.
---

# katashiro-point-at

When you explain something the user can see in their browser, **show them where it is** instead of
describing it ("the third button in the toolbar"). Katashiro gives you three ways, from lightest to
heaviest. Pick the lightest that works.

## Requirements

- The current chat is a **Katashiro** chat (its browser tunnel is attached), so `katashiro.*` tools
  are available. Not in Discord/Slack threads or cron turns.
- The thing to point at is in the **active tab** (the one the user is looking at). If it is in
  another tab, `katashiro.switch_tab` first, and say so.

## 1. One element on a page → `katashiro.highlight` (default)

1. `katashiro.snapshot` (or the snapshot an action just returned) to get the element's `ref`.
2. If it may be off-screen, `katashiro.scroll` with that `ref`.
3. `katashiro.highlight` with `{ref, snapshotId, label, durationMs}`.

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
/* glow the elements you mean; selectors from katashiro.read_dom, not snapshot refs */
.pricing-table tr:nth-child(3), #limits h2 {
  outline: 3px solid #f59e0b !important;
  box-shadow: 0 0 0 6px rgba(245, 158, 11, 0.35) !important;
  border-radius: 4px !important;
}
```

- Needs **CSS selectors**. Snapshot `ref`s are not selectors; get a stable selector from
  `katashiro.read_dom` on the region.
- Use `!important` to win over the site's styles.
- It is a **write** tool, gated by act mode. If act mode is off, fall back to `highlight`.
- Refused: anything that fetches (`url()`, `@import`, `image-set()`, `@font-face`) and CSS escapes
  (`\`). Use colors, outlines, shadows and opacity only.
- **Always clean up**: call `katashiro.inject_css` with `{clear: true}` when you are done or the
  user moves on, and tell the user it is temporary (it also disappears on reload).
- Never hide content the user needs, and never restyle a page to look like something it is not
  (fake banners, fake buttons). Emphasise; don't alter.

## 3. A part of a Katashiro canvas → `katashiro.canvas_highlight`

For canvases (documents and slides the agent rendered; see the Katashiro canvas ADR), use
`katashiro.canvas_highlight` with `{id, find | heading, label, durationMs}`. It scrolls the canvas
to the block and glows it. You cannot inject CSS into a canvas: the effects are fixed, and you only
give a text anchor. Available once canvas phase 1 ships; check with `search_capabilities`.

After you write a new canvas version the changed blocks glow on their own, so you don't need to
highlight your own edits. Use `canvas_highlight` to point at something specific while you explain.

## Etiquette

- Point, then explain in one or two sentences. The highlight replaces a long description; don't
  repeat it in words.
- At most a few highlights per turn.
- Highlighting is for the user's attention, never to click or change anything. Acting on the page
  is a separate decision (and act mode).
