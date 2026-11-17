# ADR: Canvas themes (light / dark / system) and briefing blocks

- **Status:** Proposed 2026-11-16 — §6 decided (D1–D5, Brett), §7 open (Q5–Q7); preview §4a approved
- **Date:** 2026-11-16
- **Author:** Brett Chien (drafted by Claude)
- **Related:** [canvas](./canvas.md) §3.1 (reading width toggle), §3.3 ("Palette", "Cards and
  callouts", "Tables"), §3.8 (print); [canvas-diagram-engine](./canvas-diagram-engine.md) §2.6 (Pele
  CSS variables); [canvas-html](./canvas-html.md); skill `katashiro-canvas-writing`.
- **Reference:** a private 5-page A4 conference briefing (Chrome-printed HTML, light) that Brett
  supplied; not in the repo. Target look for the light theme and for the blocks in §2.4.

---

## 1. Context

### 1.1 The canvas is dark only

`canvas-frame.css` sets `color-scheme: dark` and carries ~134 literal colours (GitHub Dark, picked
2026-11-01, canvas §3.3 "Palette"). `canvas.css` (header, 36), `canvas-slides.css` (18) and
`canvas-gallery.css` (6) add more. Light exists only as the `@media print` overrides, a second
hand-kept copy of every colour. A user who reads in a light browser, or wants to hand someone a
light document on screen, has no option.

Pieces that already switch without a re-render:

- Pele diagrams: every colour is a `--pele-*` variable on the SVG (diagram-engine §2.6).
- Mermaid: `rethemeDiagrams(doc, theme)` (canvas-frame.js) re-renders with another mermaid theme; today
  only print calls it.
- The editor (Milkdown crepe): `--crepe-color-*` variables.
- The reading-width toggle (§3.1) is the pattern to copy: a header button, persisted in
  `chrome.storage.local` (`CanvasCore.NARROW_KEY`), the frame receives a constant message and toggles
  a constant class on its root.

### 1.2 The reference document cannot be written as a markdown canvas

| In the reference | Markdown canvas today |
|---|---|
| Side-by-side panels (三大趨勢, 三天主題演進, 矩陣分析) | ✅ `::: cards` |
| Legend / source line in small muted text | ✅ footnote or plain paragraph |
| `●` `○` `★` glyphs | ✅ as text — but no colour |
| KPI tiles beside the title (3 天 · 18 場 · 9 關鍵字) | ❌ |
| Numbered section badges (①②③…) | ❌ |
| Each card in its own hue, tinted panel or accent edge | ❌ cards are all `#161b22` |
| A bar inside a table cell (`提及場次 12 / 18`) | ❌ |
| Matrix table: coloured ●/○, vertical column heads, totals row | ❌ |
| Inline tag pills (補充, D1) | ❌ |

An `html` canvas (canvas-html) can reproduce the page 1:1 today, but it is not editable in the
canvas. The point of this ADR is the editable path.

### 1.3 Constraints that do not change

- The editor (Milkdown) rewrites stored markdown on every save (skill `katashiro-canvas-writing` §4).
  Any new syntax must survive write → save → read unchanged in meaning.
- HTML stays off in markdown; the sanitizer keeps no `style` / `class` from the source. Classes are
  CONSTANT strings set by our plugins (as `cards` is today, markdown.js).
- Sandbox CSP: no `url()` / `@import` in the frame.
- No new runtime dependency.

## 2. Decision

### 2.1 Colour tokens

Every colour in `canvas-frame.css`, `canvas.css`, `canvas-slides.css`, `canvas-gallery.css` becomes
a `--ks-*` custom property, defined once per theme on `:root[data-ks-theme=…]`. The attribute is
`data-ks-theme`, not `data-theme`: an `html` canvas's static view moves the page's own `data-theme`
into a shadow root (canvas-html §7), and the two must never be confused when reading the CSS.

| Token | Role | Dark (today, unchanged) | Light (§2.3, from the reference PDF) |
|---|---|---|---|
| `--ks-bg` | page | `#0d1117` | `#ffffff` |
| `--ks-surface` | cards, table head | `#161b22` | `#f3f6fa` |
| `--ks-code` | code blocks | `#161b22` | `#f6f8fa` (today's print value; hljs light set on it) |
| `--ks-surface-alt` | selected, raised | `#30363d` | `#eef1f4` |
| `--ks-border` | card / table rules | `rgba(255,255,255,.12)` | `#d5dde7` |
| `--ks-border-strong` | table header rule | `#c9d1d9` | `#bac5d1` |
| `--ks-fg` | text | `#e6edf3` | `#2b3440` |
| `--ks-heading` | h1–h3 | `#e6edf3` | `#24415e` |
| `--ks-muted` | secondary text | `#8b949e` | `#56657a` |
| `--ks-faint` | non-text marks (rules, ○) | `#6e7681` | `#9aa7b6` |
| `--ks-accent` | links, focus | `#4493f8` | `#2f5d8a` |
| `--ks-<hue>` | hue as **text** (titles, tags) | §2.3 dark table | §2.3 light table "text" |
| `--ks-<hue>-mid` | hue as **mark** (dots, bars, card edge) | §2.3 dark table | §2.3 light table "mark" |
| `--ks-<hue>-line` | hue as **border** | §2.3 dark table | §2.3 light table "border" |
| `--ks-<hue>-tint` | hue as **panel fill** | §2.3 dark table | §2.3 light table "tint" |

`<hue>` = `blue`, `green`, `orange`, `purple`, `teal`, `yellow`, `pink`, `sand`, `slate`, plus
`red` for caution (not in the reference).

- Callouts map onto the hues (note → blue, tip → green, important → purple, warning → yellow,
  caution → red), so `--ks-alert` / `--ks-alert-bg` derive from the tokens.
- highlight.js token colours get a light set (GitHub Light), selected by the same attribute.
- `--pele-*` and `--crepe-color-*` are set from `--ks-*`.
- `==highlight==` (`<mark>`): light = `--ks-yellow-tint` fill with a 2 px `--ks-yellow-mid` underline
  (the preview's look); dark keeps today's `rgba(250, 204, 21, 0.28)`.
- Semantic colours that are not theme (canvas §3.3: the change glow green, the point amber, the
  `.ks-note` badge) keep their values but get tokens, so a light theme can adjust contrast.

**Step 1 (the first commits of PR B) is a pure refactor: pixel-identical on screen in dark, and print unchanged** (print
keeps today's Primer Light values, now as `@media print` token overrides). Only colours in use today
become tokens in step 1; the hue ramps (§2.3) and `--ks-heading` / `--ks-faint` arrive in step 2. The
existing callout fills (`rgba(…, 0.1)` over the page) stay as they are in dark.

Verification: `e2e/` has no screenshot checks today, so step 1 adds one — `e2e/cases/canvas-theme-shots.mjs`
opens fixed fixture canvases (a document with every block kind, a mermaid and a Pele diagram, slides,
an image canvas, the gallery) in the pinned Chrome for Testing, takes Puppeteer screenshots at a
fixed viewport, and compares them byte for byte with shots taken the same way on `main` before the
change (same Chrome build, so no fuzzy diff and no new dependency; on a mismatch both PNGs are kept
for review). The same fixtures are reused for the light theme in step 2.

> **As implemented (PR B):** the check is `scripts/theme-shots.mjs` and its own CI job `theme-shots`, not an
> `e2e/` case: it renders the fixtures in the canvas frame (and the header and gallery pages, with
> `chrome.*` stubbed) in the pinned headless shell, once for a worktree of `main` and once for the
> PR, and compares byte for byte. Shots a PR changes on purpose are listed in
> `scripts/theme-shots-changed.txt` (reported, not failed). The compare runs without a CJK font —
> with Noto CJK installed the page shots were not byte-stable between Chrome launches (±1 at button
> corners) — and a `review/` set of the PR is shot afterwards with the font, for review.

### 2.2 Choosing the theme

- **Setting:** a new Settings row **畫布主題** next to 圖表引擎 (Settings has one row per option, no
  section), stored in `chrome.storage.local` like `DIAGRAM_ENGINE_KEY`: `深色` / `淺色` / `跟隨系統` (default: **`跟隨系統`** —
  Brett, 2026-11-16. Existing users on a light OS see the canvas turn light on upgrade; the
  release note says where the switch is).
- **Header button** beside the reading-width ↔: cycles the three; persisted in
  `chrome.storage.local` under `CanvasCore.THEME_KEY`; other canvas tabs follow (as narrow does).
- **Three surfaces apply it**, each resolving the stored value itself (`跟隨系統` through
  `matchMedia("(prefers-color-scheme: dark)")`, re-applied on its `change` event) and listening to
  `chrome.storage.onChanged` for `THEME_KEY`:
  1. the canvas tab's **host page** (`canvas.html` + `canvas.css`: header, banners) — sets
     `data-ks-theme` on its own root;
  2. the sandboxed **canvas frame** (`canvas-frame.html`) — cannot read storage, so the host sends
     `{type: "theme", value: "dark" | "light"}` (a constant, like `narrow`) and the frame sets
     `data-ks-theme` on its root;
  3. the **canvas gallery** page (`canvas-gallery.html` + `canvas-gallery.css`) — sets it on its own
     root.
- Mermaid diagrams: on a change, `rethemeDiagrams(doc, light ? "default" : "dark")` — the print path,
  reused. Pele follows the variables with no re-render.
- **Print** (from step 2) is a document under `data-ks-theme=light`: the hand-kept `@media print`
  colours go away and print keeps only layout rules (no scrollers, `break-inside`, no chrome). When
  the screen is already light, print needs no Mermaid re-render.
- **Slides stay dark in v1.** A deck is reveal.js over its dracula theme (`canvas-slides.css`, `--r-*`
  variables); a light deck needs its own design (heading weights, code, fragments) and is not part
  of this ADR. The frame keeps `data-ks-theme=dark` in slides mode whatever the setting, and a deck
  still prints dark (§3.8).
- Applies to `markdown`, `mermaid` and `image` canvases, the host header and the gallery. An `html`
  canvas is the page's own: the host theme is not sent into its content (canvas-html §2.4 bound — no
  theme crosses); only the frame's box around it (`.htmlview`) follows.
- Out of scope: the side panel (`sidepanel.css`, 185 colours) — separate decision (Q5).

### 2.3 Light palette from the reference

Brett supplied the original PDF (2026-11-16, 5 pages, Chrome-printed HTML). Colours were
read **exactly** from its content streams (every `rg`/`RG` operator, counted), not sampled from an
image. The document uses one 4-step ramp per hue — tint (panel fill), border, mark (dots, bars, card
edges, number badges) and text (titles, tags):

| Hue | Tint | Border | Mark | Text | Text on tint (AA ≥ 4.5) | Used for in the reference |
|---|---|---|---|---|---:|---|
| blue | `#e6f0fb` | `#b5cdeb` | `#86addb` | `#2f5d8a` | 5.97 | Trust, ② trend, Day 2 AM |
| green | `#e8f5ee` | `#b3dcc6` | `#7dc0a0` | `#2f7a55`¹ | 4.64 | Factories, ③ trend, Day 1, 0–30 天 |
| orange | `#fdeee4` | `#f0c7ae` | `#e8a983` | `#9a5630`² | 4.94 | Decision models, ① trend, Day 2 PM |
| purple | `#efeafb` | `#cfc4ee` | `#a898d8` | `#6a55b0` | 5.04 | Harness, Day 3, 61–90 天 |
| teal | `#e4f6f7` | `#a9dadd` | `#6fbfc4` | `#26777c`¹ | 4.69 | Memory, a dashed group frame |
| yellow | `#fdf8dc` | `#e5d48a` | `#d9c25e` | `#7a6a1e` | 5.02 | Frontier / Training, 補充 tag |
| pink | `#fbe9ee` | `#edc0cd` | `#e09aae` | `#9e4862`² | 5.06 | FDE, Frontier 直連 |
| sand | `#f3eee6` | `#c2a57d`³ | `#c2a57d` | `#7d6440`¹ | 4.82 | Dreaming / Reflections |
| slate | `#eef1f4` | `#cbd3dc` | `#97a6b6` | `#4a5668` | 6.56 | Coding agents, neutral cards |
| red⁴ | `#fbe4e4` | `#f0b8b8` | `#e07a7a` | `#b4302a` | 5.10 | caution callout only |

¹ The PDF has this hue but no text colour for it — derived: same hue, darkened to pass AA.
² In the PDF as `#b5663a` (3.76 on its tint) and `#a8506a` (4.48): darkened slightly to pass AA.
³ The PDF draws the Reflections card's border and its matrix dot in the same `#c2a57d`.
⁴ Not in the PDF at all (the reference has no error state) — the whole ramp is ours, same lightness
  steps as the other hues.

Neutrals (exact): text `#2b3440` (12.59 on white), headings `#24415e`, muted `#56657a` (5.94),
secondary `#6a7789` (4.55 — passes AA for text of any size, by a small margin), faint `#9aa7b6` (non-text
only), star `#e0a100` (dark `#e3b341`).

**Mark colours never carry information alone.** Light marks are 2–3 : 1 on white, below WCAG
1.4.11's 3 : 1 for graphics needed to understand content. So: a matrix dot is drawn with a 1.5 px
edge in the hue's **text** colour (≥ 4.5 : 1) — ● = mark fill + that edge, ○ = that edge only (2 px),
◐ = half fill + that edge; the fill/no-fill shape tells ● from ○, not the colour. A bar may use the
mark colour because its value is always printed next to it (§2.4 e). Card top edges and column
bands are decorative.

Other measured pairs: heading `#24415e` on surface `#f3f6fa` 9.72, accent `#2f5d8a` on white 6.88.

**Accent order** for `::: cards accent` (§2.4 a) and matrix columns (§2.4 d) follows the reference's
keyword order (Decision models → Coding agents): orange, blue, purple, green, yellow, pink, teal,
sand, slate. (The reference's own small card rows are not systematic — ① ② ③ are orange, blue,
green — so the keyword order, its only consistent sequence, is the rule.)

**Dark ramps** (new; Primer has no teal / yellow / pink / sand / slate ramp and no 4 steps). Mark and
text are one bright colour per hue (Primer dark where it exists, matched lightness where not); tint =
that colour at 12 % over the page `#0d1117`, border = 40 %, both flattened to solid hex. Contrast
measured 2026-11-16:

| Hue | Tint | Border | Mark = Text | Text on tint | Text on `#161b22` |
|---|---|---|---|---:|---:|
| blue | `#162333` | `#2b4d74` | `#58a6ff` | 6.29 | 6.85 |
| orange | `#281f1c` | `#684127` | `#f0883e` | 6.37 | 6.83 |
| purple | `#222033` | `#534274` | `#bc8cff` | 6.30 | 6.86 |
| green | `#13251e` | `#21542e` | `#3fb950` | 6.31 | 6.81 |
| yellow | `#252118` | `#5c471b` | `#d29922` | 6.35 | 6.85 |
| pink | `#291d2b` | `#6b3a58` | `#f778ba` | 6.40 | 6.88 |
| teal | `#12272d` | `#1f5961` | `#39c5cf` | 7.43 | 8.29 |
| sand | `#242221` | `#584b39` | `#c9a26d` | 6.69 | 7.31 |
| slate | `#1c2127` | `#3f454d` | `#8b949e` | 5.27 | 5.62 |
| red | `#29191d` | `#6b2b2b` | `#f85149` | 5.01 | 5.16 |

The callouts keep today's dark fills (`rgba(…, 0.1)`, §2.1); the ramps are for the new blocks.

Method: inflate each FlateDecode content stream and count the `r g b rg|RG` operators (a 30-line
Node script, kept out of the repo).

> **As implemented (PR B):** values the reference does not give were derived in the same family:
> light `--ks-border-soft` `#e3e8ef` (row rules), inline-code fill `#eef1f4` (slate tint),
> `--ks-diagram-line` `#56657a` (Pele edges; dark keeps `#c9d1d9`), and the host header's light
> states (hover fills `rgba(36,65,94,.04–.08)`, the notice in the orange ramp, pressed in the green
> ramp). Print is the light theme: the frame sets `data-ks-theme="light"` on `beforeprint` and for
> the 🖨 PDF button, and `@media print` keeps layout rules only. Mermaid diagrams keep their SVG for both
> of its themes (the other one drawn in the background after a render), so a theme switch — and a
> print from the browser menu, whose `beforeprint` cannot wait for a redraw — shows the right one at
> once; Ctrl/⌘+P goes through 🖨 PDF.

### 2.4 Briefing blocks

All are opt-in, carry no inline styling, and are classes set by our plugins. Each needs a
round-trip test (write → Milkdown save → read → same render) before it goes into the skill.

**a. `::: cards accent`** — cards take hues in the accent order of §2.3 (orange, blue, purple, green, …, then repeat):
panel fill = hue tint, border = hue border, a 3 px top edge in the hue's mark colour, and the card's
`###` in the hue's text colour. The info word
`accent` maps to a constant class; anything else after `cards` is still ignored. **No per-card
syntax** — order-based hues only (Brett, 2026-11-16). The order restarts in each `::: cards accent`
block; a writer who wants a different hue for a card reorders the cards.

**b. `::: stats`** — a row of KPI tiles. Each list item `- **3** 天` becomes a tile: the bold run is
the number (large, accent), the rest the label (muted). Placed right after `# Title` it floats right
of the title on a wide tab and drops below it on a narrow one.

**c. Numbered sections** — **always on in the light theme, off in dark** (Brett, 2026-11-16, D4).
No flag, no tool argument, no header button, no markdown syntax: a pure CSS rule on
`:root[data-ks-theme=light] .doc` — counters draw a circle with the number before each `##` (blue
ramp: tint fill, border line, text-colour digit — as in the preview).

- Applies to `markdown` canvases only (slides are pinned dark; mermaid / image have no `##`).
- Print is light (§2.2), so a printed document is numbered too.
- A document that numbers its own headings (`## 1. …`) shows both; the skill tells writers not to
  number `##` by hand.
- Nothing changes in `canvas_open` / `canvas_patch`, `meta` or canvas §3.4.

> **As implemented (PR C):** a document that numbers its own `##` is detected (at least two, and at
> least half, of its top-level `##` start with a section number — `1.` `2)` `一、` `（一）` `第一章` `IV.`
> `①` `Step 1` … followed by a separator, so `2024 review` or `3 大趨勢` is not one): its `##` get the
> constant class `ks-own-number` and no theme number, instead of showing both.

**d. `::: matrix`** wrapping a table:

- a cell whose whole text is `●` / `○` / `◐` renders as a coloured dot (primary = mark fill with a 1.5 px
  text-colour edge / secondary = 2 px ring in the text colour / partial = half fill + edge — §2.3
  "Mark colours never carry information alone"; hue = the column's hue, cycling like accent cards);
- each mark column carries its hue as a faint band: the header cell in the tint, body cells in the
  tint at ~45 %;
- a column is a **mark column** when every body cell in it is empty, a dot (`●` / `○` / `◐`) or,
  in the totals row, a number. Mark columns get vertical headers (`writing-mode: vertical-rl`) and
  take hues in the accent order, counted over mark columns only. Text columns keep normal headers —
  the reference has three of them (Day, 場次 · 講者 · 公司, 重點摘要) before nine mark columns;
- a last row whose first non-empty cell is bold (`**合計**`, `**Total**`) is styled as a totals row
  (strong top rule, bold, heading colour). The writer computes the totals; a cell may be `5 (4●)` —
  the part in parentheses shows smaller and muted.

> **As implemented (PR C):** the totals row is the bold-led last row only when no row above it is
> bold-led and it holds no dot or bar value (bold labels on every row, or an emphasised data row,
> are not a total); its cells may be anything else (`**5**`, `5（4●）`, `—`). A header cell is never
> a dot. In forced-colours mode the dot characters show instead of the drawn dots.

**e. Bars in tables** — inside `::: matrix` or a new `::: bars` wrapper, a cell whose whole text is
`n/N` (integers, 0 ≤ n ≤ N ≤ 1000, N > 0) renders a thin bar (n/N of the bar track) followed by
**n only**; N is the writer's job to state once in the column header (the reference: `提及場次 / 18`).
The bar's hue is the row's accent hue. The stored markdown keeps `5/18`, so the canvas reads right
even where the plugin does not run (export, other viewers). Outside these wrappers `12/18` stays
text, so dates and fractions elsewhere are untouched.

> **As implemented (PR C):** a bar column is one whose header ends in `/ N` and whose filled cells
> are all `n/N` of that N (spaces and `**bold**` allowed) — a Day column of `11/12` dates stays text.
> The bar is a `<meter>` (a measurement, with an `aria-label` `n / N`), not a `<progress>`. The blocks
> render on slides too (slide-scale CSS) and only in canvases: the chat parsers recognise the
> containers but leave their content plain (no side-panel styles, Q5).

**f. Tag pills** — deferred. Every inline syntax tried so far (subscript, abbreviations) was
mangled by the editor; `[補充]` would collide with links. Revisit with a measured round-trip (Q6).

**g. Seen in the full reference (pp. 2–5), not covered above** — candidates, not decided ("ref."
= page of the private reference, not a section of this ADR):

| Pattern | Where | Possible mapping |
|---|---|---|
| Step chips joined by ➜, wrapping to a second row, a `↻` loop line under them | ref. pp. 3–5: session cards, request-path diagram | `flowchart LR` with `ks-*` classes; or a `::: flow` list block (each item = chip, bold = title, rest = sub-label) |
| Key-figure tiles: big coloured number + 2-line caption, 4 per row | ref. p. 2: key figures | `::: stats` with a caption line under each item (b. extended) |
| A card's tinted footer band (a bold "takeaway：" line) | ref. pp. 3–4: every session card | inside `::: cards accent`, a last paragraph starting with `**…：**` gets the tint band |
| Number badge + tag pills in the card header | ref. pp. 3–4: session cards | badge = card index (CSS counter, like c.); pills wait for f. |
| Table whose first column is tinted per row, hue by row order | ref. pp. 1, 5: keyword tables | `::: matrix` variant without dots: `::: rows accent` |
| Dashed group frame around a set of cards | ref. p. 5: two side-by-side groups | nested cards with an outer `:::: group` |

### 2.5 Diagrams in two themes

The skill today tells agents to use dark `classDef` fills; those print dark and will look broken on a
light canvas. Add predefined theme-aware classes, one per hue of §2.3 — `ks-blue`, `ks-orange`, …,
`ks-red` (fill = tint, stroke = mark, text = text) and `ks-<hue>-strong` for the main node (stroke
3 px):

- **Mermaid:** before rendering, the frame appends `classDef ks-…` lines (values from the resolved
  theme) to the source of diagram types that support classes — `flowchart`/`graph`, `stateDiagram`,
  `classDiagram`. Other types (`sequenceDiagram`, `gantt`, `pie`, …) have no `class` statement
  and get nothing; they follow Mermaid's own light/dark theme only. The stored source is not
  changed.
- **Pele:** unverified. Pele applies `classDef` today (skill §3) but "does not guarantee it"; the
  PR must first test whether a `class X ks-blue` with the injected `classDef` survives Pele, and if
  not, Pele falls back to Mermaid for that diagram (diagram-engine §2.4) — documented, not silent.
- A source with `class X ks-blue` but no injection (export, GitHub) renders uncoloured, not broken.

An agent writes `class O ks-orange-strong`; the colours follow the theme. A literal `classDef` still
works and stays as written (the skill says: prefer `ks-*`).

> **As implemented (PR B):** Pele was tested first (`scripts/smoke-diagram-classes.mjs`) and applies
> the injected classes — fill, stroke and the 3 px `-strong` outline — in both themes, so no diagram
> falls back to Mermaid for them. **Flowcharts only:** in state and class diagrams both engines'
> grammars reject a `-` in a class name, so those types get no classDefs and draw uncoloured (never
> broken). Neither engine parses `var()` in a `classDef`, so the lines carry sentinel colours
> (`#0c01<hue><role>`) that the frame turns into `var(--ks-*)` in the drawn SVG: the CSS ramps stay
> the only source, and a theme switch or print restyles Pele's ks-* diagrams with no redraw. The
> lines are appended only when the source uses a `ks-*` class, so every other diagram draws exactly as before.

### 2.6 Skills

- `katashiro-canvas-writing`: §3 diagrams switch to `ks-*` classes; §1 table gains rows for
  `::: stats`, `::: cards accent`, `::: matrix`, bars; §2 "Shape" says `##` are numbered by the light theme — never number them by hand; a note
  that colours are the theme's, never the document's.
- New `katashiro-briefing-doc`: write a multi-section executive / conference summary in the
  reference's shape (5 A4 pages printed) —
  1. eyebrow (`San Francisco · 2026/11/10–12 · …`) + `# Title` + `::: stats`;
  2. `##` sections unnumbered in the source (the light theme numbers them);
  3. "trends" as `::: cards accent` (3 cards, each: claim, 2–3 lines of evidence, a `→ source` line);
  4. timeline as `::: cards` (one card per day);
  5. keyword table — 是什麼 / 為何重要 / 提及場次 with `n/N` bars;
  6. analysis as `::: cards accent`;
  7. full session × keyword `::: matrix` with a totals row; legend as a footnote;
  
  plus when to choose an `html` canvas instead (fixed layout, print-perfect, no editing).

## 3. Consequences

### Positive

- One source of truth for colour; print stops being a parallel palette.
- Light theme on screen; the reference look becomes writable by an agent as editable markdown.
- Diagrams stop depending on the agent guessing dark-friendly fills.

### Negative / tradeoffs

- Large mechanical diff in four CSS files; regressions show only on screen → screenshot-based
  checks, dark first.
- Mermaid re-render on theme switch: a document with many diagrams flashes once.
- Default 跟隨系統: users on a light OS see the canvas change on upgrade.
- Slides stay dark in a light theme (v1), so a light document and its deck do not match.
- More block syntax for the editor to preserve; each needs its round-trip test and a skill §4 entry
  if it does not survive.
- Existing canvases with dark literal `classDef` fills look heavy on light (not migrated; Q7).

## 4. Alternatives considered

- **Only print-style light via `@media (prefers-color-scheme: light)`** — no user choice, and still two
  hand-kept palettes. Rejected.
- **Use `html` canvas for every designed document** — works today, but not editable, and agents must
  hand-write CSS per document. Kept as the fixed-layout option (skill), not the default.
- **markdown-it-attrs (`{.blue}` on any block)** — fully flexible, but opens arbitrary classes from
  the source and Milkdown escapes the braces on save. Rejected.

## 4a. Preview (2026-11-16)

Two static `html` canvases render the expected result of §2.1–§2.4 with the §2.3 palettes, each
block followed by its markdown source (Brett: "looks OK"):

- Light: canvas `cv_4e392ba449e4` · Dark: canvas `cv_d4c0664ded1c`
- Generator (local, not in the repo): `gen.js` → `light.html` / `dark.html` (one data set, two
  token sets; the CSS there is the starting point for the PRs' token values).
- Differences from the real thing: the flow chips are hand-drawn HTML (a mermaid diagram is drawn by
  the engine), and an `html` canvas is not editable.

## 5. Plan (PRs)

Three PRs, as the repo usually lands work (an ADR PR, then one `feat` PR per feature — cf. #220
palette, #215 cards); skill changes ride with the feature they describe (Brett, 2026-11-16):

| PR | Branch | Scope |
|---|---|---|
| A | `docs/adr-canvas-themes` | this ADR as `docs/adr/canvas-themes.md` |
| B | `feat/canvas-themes` | §2.1–§2.3 + §2.5: tokens with the screenshot check (dark pixel-identical against `main`), setting + header button + host / frame / gallery wiring, both palettes and ramps, print → light, slides pinned dark, `ks-*` diagram classes; skill `katashiro-canvas-writing` §3 |
| C | `feat/canvas-briefing-blocks` | §2.4 a–e: `cards accent`, `stats`, `matrix`, bars, numbered sections (CSS only, light theme), each with its smoke round-trip; skills `katashiro-canvas-writing` §1–2 + new `katashiro-briefing-doc` |

B and C stay separate: B is a mechanical diff reviewed by screenshots, C adds syntax reviewed by
round-trip tests.

## 6. Decisions (Brett, 2026-11-16)

- **D1 Default theme** — `跟隨系統` (§2.2).
- **D2 Light hues** — exact, read from the original PDF Brett supplied; three text colours darkened for AA (§2.3).
- **D3 Per-card colour** — order-based only (§2.4 a).
- **D4 Numbered sections** (was Q4) — always on in the light theme, off in dark; CSS only (§2.4 c). A
  document that numbers its own `##` is left unnumbered (as-implemented note there).
- **D5 PRs** — three (A ADR, B themes, C blocks); PRs may be opened by the implementing agent, Brett
  merges (§5).

## 7. Open questions (for Brett)

- **Q5 Side panel** — follow the canvas theme later, or stay dark?
- **Q6 Tag pills** — needed in v1?
- **Q7 Old canvases** — leave literal dark `classDef` fills as they are, or offer a one-time rewrite
   to `ks-*`?
