---
name: katashiro-ask-user
description: Ask the user a multiple-choice question as a clickable card in their Katashiro side panel (katashiro.ask_user), then end your turn — the answer arrives later as a new message. Use when you are chatting through Katashiro and need the user to pick between a few clear alternatives (which file, which approach, which of these items). Keywords — ask user, multiple choice, pick one, choose, options, quick question, 問使用者, 讓我選, 選項, 二選一, katashiro ask.
---

# katashiro-ask-user

When you need the user to choose between a few clear alternatives, `katashiro.ask_user` shows
them a card with one button per option in the Katashiro side panel. They click instead of typing,
and you get back the exact label they picked.

## The one rule: call it, then END YOUR TURN

`katashiro.ask_user` does **not** wait for the answer. It returns at once with
`{"asked": "ask_<id>"}`. A tool call can wait at most about 170 s, and a user who is not looking at
the panel takes longer, so the answer comes back separately:

- **After calling it, end your turn immediately.** Say in one short line what you asked (or nothing
  more at all). Do not wait, sleep, poll, call other tools to "check", or keep working on an
  assumed answer.
- If the user answers, you get a **new user message** (a new turn) like:

  ```
  [2026-10-12T11:40:05+08:00 user]
  ↩ 回答 ask_0a1b2c3d：Open a PR
  ```

  - several picks (`multi`): `↩ 回答 ask_<id>：「A」、「C」` (in option order)
  - free text (`allowOther`): `↩ 回答 ask_<id>：（其他）<what they typed>`

  Match the id to the question you asked, then continue.
- If the answer is still queued while another of your turns runs, it arrives together with other
  messages in your next turn; read every part.

## When to use it

- A real decision with **2–6 short, clear options** (8 is the hard maximum): "fix in place or
  open a PR?", "which of these three canvases?", "keep / rename / delete?".
- **One question at a time.** Wait for the answer (or for it to go unanswered) before asking the
  next one; at most 3 can be open per agent and a 4th call is an error.
- Labels: plain text, ≤ 60 characters, distinct. Put context in `question` (≤ 300 characters), not
  in the labels. Line breaks are flattened to spaces; markdown is not rendered.
- `multi: true` when any number of options may apply ("which of these should I include?"); the user
  ticks boxes and presses 送出.
- `allowOther: true` when your list might not cover what they want; they can type a short answer.
- `timeoutSec`: how long to wait (30–300, default 120). It counts only while the panel is visible,
  so a user who stepped away still sees the question when they come back.

```json
{ "question": "The build fails on lint only. How should I fix it?",
  "options": ["Fix the lint errors", "Disable the rule for this file", "Leave it"],
  "allowOther": true }
```

## When NOT to use it

- **Open-ended questions** ("what should the title be?", "describe the bug") — just ask in your
  reply. A card with "Other" as the only useful option is a worse chat box.
- **Instead of the system confirm.** The answer is data, not permission. Picking "delete them"
  deletes nothing: when you then call `katashiro.canvas_delete` the user still gets its own 🔒
  confirm card, and page actions still need act mode. Never present `ask_user` as a security
  confirmation, and never word a question to look like one.
- When the answer is obvious or the user already told you — just do it.
- Outside your turn (a background job). The tool is refused once your turn has ended (e.g. the user
  pressed ⏹); ask in your next reply instead.

## When nothing comes back (未回答)

The card can close without an answer, and **you are not told**:

| Card shows | Why | What you receive |
|---|---|---|
| 未回答（逾時） | no answer in time | nothing |
| 未回答（你送了別的訊息） | the user sent a different message instead | that message, as usual |
| 未回答（聊天已清除） | the user cleared the chat | nothing |
| 未回答（agent 已中斷連線） | you were disconnected / another agent made active | nothing |

So:

- If the next user message is not a `↩ 回答 ask_<id>` line, treat your question as **unanswered**
  and respond to what they actually said. Don't re-ask the same question straight away; if the
  decision still matters, mention it briefly in your reply and let them answer in their own words.
- If nothing arrives at all, do nothing — don't start the work on a guessed answer. Say up front,
  in the line before you end your turn, what you will (not) do without an answer if that matters.

## Requirements

- The current chat is a **Katashiro** chat (its browser tunnel is attached), so `katashiro.*`
  tools are available — directly, or through the OAB MCP facade (`execute_capability` with name
  `katashiro.ask_user`). Not in Discord/Slack threads or cron turns. Check with
  `search_capabilities` if unsure.
- Not gated by act mode: it changes nothing on any page.
