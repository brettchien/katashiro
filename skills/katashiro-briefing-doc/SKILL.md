---
name: katashiro-briefing-doc
description: Write an executive or conference summary as a Katashiro markdown canvas in a fixed briefing shape — eyebrow + title + headline numbers, colour-coded trend cards, a day-by-day timeline, a keyword table with bars, analysis cards, and a full session × topic matrix with totals — that reads well on screen and prints as a clean light document (about five A4 pages). Use when you are chatting through Katashiro and the user asks for a summary of a conference, an event, a trip, a set of talks or interviews, a quarterly review, or "an executive briefing / 高層摘要". Keywords — briefing, executive summary, conference summary, event recap, 高層摘要, 會議摘要, 研討會重點, 活動總結, summit, keynote, sessions, matrix, trends.
---

# katashiro-briefing-doc

A briefing is a **markdown canvas** with a fixed shape: the reader gets the numbers, the three
trends and the evidence in the first page, and the full detail after. It uses the canvas blocks of
[`katashiro-canvas-writing`](../katashiro-canvas-writing/SKILL.md) — read its §1 (blocks) and §4
(syntax that breaks) first. Install both.

## When an html canvas is the better choice

Choose an `html` canvas (with [`katashiro-canvas-file`](../katashiro-canvas-file/SKILL.md)) instead
only when the user needs a **fixed, print-perfect layout** (exact page breaks, a cover page, a logo)
or interaction (filters, sorting). An html canvas is not editable in the canvas and does not follow
the reader's theme. Otherwise use markdown: it is editable, themable and diffable.

## The shape

Write the sections in this order, all as `##` — **unnumbered**: the light theme and print number them.

1. **Eyebrow, title, numbers.** One bold eyebrow line (place · dates · organiser), `# Title`, then
   `::: stats` with 2–5 headline numbers right after it (`- **3** 天`), then a two-sentence lede with
   one `==highlight==`.
2. **Trends** — `::: cards accent`, three cards. Each: the claim as the `###`, 2–3 lines of evidence,
   and a last line `→ source` (session, speaker).
3. **Timeline** — `::: cards`, one card per day (`### Day 1 · 11/10`), 3–5 bullets each.
4. **Keywords** — a table `| 關鍵字 | 是什麼 | 為何重要 | 提及場次 / N |` inside `::: bars`, the last
   column `n/N` (N once, in the header). Sorted by n, highest first.
5. **Analysis** — `::: cards accent`, 2–4 cards: what it means for the reader's organisation.
6. **Full matrix** — `::: matrix` around a table of every session × keyword: text columns first
   (Day, Session · Speaker · Company, Summary), then one mark column per keyword with `●` (central),
   `◐` (discussed), `○` (mentioned) or empty, and a `**合計**` last row (`5 (4●)`: 5 sessions, 4 of
   them central). Explain the marks in a footnote.
7. **Sources** — footnotes.

```markdown
**San Francisco · 2026/11/10–12 · AI Engineer**

# AIE Code Summit 2026 — 高層摘要

::: stats
- **3** 天
- **42** 場
- **18** 個關鍵字
:::

三天的重點是 ==agent 從工具變成同事==，以及支撐它的 harness 與記憶。

## 三個趨勢

::: cards accent
### Decision models 進入產品
……
→ Keynote, Day 1
### Coding agents 成為預設
……
→ Panel, Day 2
### Harness 比模型重要
……
→ Workshop, Day 3
:::

## 關鍵字

::: bars
| 關鍵字 | 是什麼 | 為何重要 | 提及場次 / 18 |
|---|---|---|---|
| Memory | 跨對話的長期記憶 | …… | 12/18 |
| Harness | 模型外的執行框架 | …… | 9/18 |
:::

## 全場次矩陣

::: matrix
| Day | 場次 · 講者 · 公司 | Memory | Harness |
|---|---|:-:|:-:|
| D1 | Keynote · A · X | ● | ◐ |
| D2 | Panel · B · Y | ○ | ● |
| **合計** | | 2 (1●) | 2 (1●) |
:::
```

## Rules

- **Numbers are yours to get right.** Count the totals and the `n/N` from the matrix before writing
  them; the canvas draws what you write.
- **One hue per role.** Accent cards take hues by order; keep the same trend in the same position
  everywhere (trend 1 is always the first card).
- **No hand colours, no hand numbers.** No `## 1.`, no colour names in text, no inline HTML.
- **Long session lists go in the matrix, not in prose.** The first page must fit on one screen.
- After writing, take a `canvas_view` screenshot in the light theme (or ask the user to switch) and
  check the stats row, the cards and the matrix headers read right; fix with `canvas_patch`.
