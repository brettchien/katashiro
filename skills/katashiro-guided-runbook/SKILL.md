---
name: katashiro-guided-runbook
description: Guide a human operator through a multi-step operation (production change, migration, backfill, load or outage test, incident fix) as a live runbook canvas in Katashiro — the human runs every command; you write the runbook, point at the next step, check each pasted output against what was expected, and keep the execution log. You never run a command that changes a system. Use when you are chatting through Katashiro and the user wants to be walked through an operation. Keywords — walk me through, step by step, I'll run the commands you check, guide me through the rollout / migration / test, runbook, 一步一步帶我做, 我來執行你幫我確認, 帶我跑 runbook.
---

# katashiro-guided-runbook

The operator executes; you navigate. You write the runbook as a canvas, keep the next command
marked, read the output they paste, compare it with what the step expects, and log every step in
the canvas. **You never run a command that changes a system** — not even "just this once".

Uses `katashiro-point-at` (§3–4, canvas pointing) and `katashiro-ask-user` (cards). Install both.

## Requirements

- The current chat is a **Katashiro** chat, so `katashiro.canvas_*` and `katashiro.ask_user` are
  available. Not in Discord/Slack threads or cron turns.
- Pointing (`canvas_highlight`, `canvas_inject_css`) works only while your conversation is the one
  on screen. From a background conversation they are refused: keep logging, point again when the
  user is back.

## 1. Draft the runbook canvas

`katashiro.canvas_open` a **markdown** canvas with this shape:

````markdown
# <Goal> — runbook
Ticket: <link> · Owner: <operator> · Order: stg → prd-a → prd-b · Timezone: <operator's, e.g. TPE>
Rollback summary: <one or two lines>

## Prerequisites
### pre · 1 · <tools / access check>
...

## stg
### stg · 1 · <short name>
Command:
```sql
SELECT ...
```
Expected: <counts, %, states the output must show>
Stop if: <the condition that halts the run>

### stg · 2 · ⚠️ DESTRUCTIVE · <short name>
...
Rollback (stg): <commands>

## prd-a
...

## Execution log
| Time (TPE) | Env | Step | Before → after | Verdict | Notes |
|---|---|---|---|---|---|
| — | — | — | — | — | end of log |
````

- **Every step gets its own heading, unique in the whole canvas** (`### <env> · <n> · <name>`).
  The same command often runs in every environment; `canvas_highlight`'s `find` must match exactly
  one block, so always point with `heading`.
- One command per code block, copy-pasteable. Mark destructive steps `⚠️ DESTRUCTIVE` in the heading.
- A read-only helper you may run yourself (a `SELECT` through a tool you have) is labelled
  `(read-only, agent may run)` in its heading. Anything else, the operator runs.
- **The execution log is the last section**, and its last row is the fixed anchor
  `| — | — | — | — | — | end of log |`. New rows go just above it, so the lines of every step above
  never move (§2 relies on that).
- Commands read secrets from the operator's environment or vault (`$CH_PASSWORD`, `vault read …`).
  Never put a key, a password, a real IP list or other sensitive identifier in the canvas or chat.

Show the draft, then ask for the go with `katashiro.ask_user`
(`["Start with stg", "Change the runbook first"]`) and **end your turn**.

## 2. Guide one step at a time

For the next step:

1. `katashiro.canvas_read` (you need the stored text and its `version` anyway).
2. Mark it with **one** `canvas_inject_css` sheet: `{clear: true}` first, then the sheet for this
   step. Blocks of a markdown canvas carry `data-line-start` — the block's **0-based line** in the
   text `canvas_read` returns — so the step's heading and code block are exact selectors:

   ```css
   /* active environment: its h2 (line 14 in canvas_read's text) */
   h2[data-line-start="14"] { border-left: 6px solid #3b82f6 !important; padding-left: 10px !important; }
   /* current step: its h3 and its command */
   h3[data-line-start="31"] { background: rgba(245, 158, 11, 0.18) !important; }
   pre[data-line-start="33"] { outline: 3px solid #f59e0b !important; outline-offset: 2px !important; }
   ```

   Count lines from 0 in the `content` you just read. Check once with `katashiro.screenshot` of
   the canvas tab the first time; if nothing is marked (an older canvas whose stored text differs
   from what it renders), fall back to `h3:nth-of-type(n)` selectors from the heading order.
3. `canvas_highlight` with `heading: "<env> · <n> · <name>"` and a short `label`
   (`"Step 3 · prd-a · run now"`). It glows for at most 10 s and scrolls the block into view; the
   CSS sheet is what stays.
4. In chat: the step in **one line** (what to run, what to paste back), then **end your turn**.
   Write that line after your last tool call, or the user does not see it.

## 3. Verify before advancing

When the operator pastes output:

- Compare it with the step's **Expected** and **Stop if**, item by item.
- **Match** → say so in one line, log the row (§4), go to §2 for the next step.
- **Mismatch, missing or cut-off output, an error, or anything ambiguous** → stop. Say exactly what
  differs (expected vs got), then `katashiro.ask_user`
  (`["Retry the step", "Investigate first", "Roll back this environment"]`, `allowOther: true`) and
  end your turn. **Never assume a step passed.**
- If the pasted output contains what looks like a secret (token, password, connection string with
  credentials), tell the operator, and leave it out of the log.
- Production starts only when the previous environment's section is fully logged and verified.
  Before the first step of each new environment, ask for the go again.

## 4. Log as you go

`katashiro.canvas_patch` with the `baseVersion` from your last `canvas_read`, inserting above the
anchor:

```json
{"find": "| — | — | — | — | — | end of log |",
 "replace": "| 2026-10-18 20:41 | stg | stg · 2 | parts 1 204 → 1 204, ttl unset → 30d | ✅ pass | |\n| — | — | — | — | — | end of log |"}
```

- Markdown is stored normalized (table padding, dashes may change): take the anchor row's `find`
  **exactly as `canvas_read` returns it**, not as you first wrote it.
- **Time** = the operator's local time from the `[time user]` header of the message that carried
  the output, labelled with their timezone in the table header. Not your host's clock.
- Key numbers before → after, a verdict (`✅ pass` / `❌ fail` / `⚠️ anomaly` / `↩ rolled back`),
  short notes.
- An anomaly (spike, warning, slow query) gets its own row with the follow-up check you agreed on.
- If the patch is refused as **stale** (the operator edited the canvas), `canvas_read` again and
  retry on the new version. Never re-send the whole canvas over their edits.
- When live state diverges from the runbook (a host renamed, a count off by a known amount),
  **patch the runbook first**, say in one line what changed, then continue. Edits above the log
  move line numbers: `canvas_read` before the next CSS sheet.

## 5. Resume after a reload or reconnect

Highlights and CSS are gone on a tab reload; your session may be new. **The execution log is the
only source of truth for progress.**

1. `katashiro.chat_history` (what was said), then `katashiro.canvas_read` of the runbook (find it
   with `canvas_list` if needed).
2. The last logged row is the last step done. The next step is the one after it.
3. Re-apply §2 (CSS + highlight) and ask with `ask_user`
   (`["Continue with <env> · <n>", "Re-check the last step first"]`) before anything else.
- **Never re-run a step already logged as done** without the operator saying so explicitly.

## 6. Close out

- A summary per environment (steps, pass/fail, anomalies) in chat.
- Draft a ticket or change-record comment from the log, in the reply or as a second canvas.
  **Posting it anywhere is a separate, explicit go.**
- `canvas_inject_css` with `{id, clear: true}`.

## Rules

- You execute nothing that changes a system. Read-only helpers only, and only if labelled as such
  in the runbook.
- Credentials stay with the operator. No key values in chat, the canvas, or screenshots you take.
- One environment at a time, in the runbook's order.
- Timestamps in the operator's timezone, labelled.
- Not a replacement for the team's change-management process or its approvals.
