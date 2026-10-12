# ADR: `katashiro.ask_user` — the agent asks the user a multiple-choice question

- **Status:** Accepted 2026-10-12 (Brett; Q1–Q4 at 10:10 TPE, async "B" at 11:36 TPE)
- **Date:** 2026-10-12
- **Author:** Brett Chien (drafted by Orca)
- **Related:** the 🔒 confirm card (#80, `confirm-core.js`); [canvas](./canvas.md) §3.4 (agent tools that
  are not page actions); reply-to (#61, the `↩` convention); [multi-conversation](./multi-conversation.md) §3.8 (cards
  bound to their conversation).

---

## 1. Context

### 1.1 Problem

When an agent needs the user to pick between a few clear alternatives ("which of these 3 canvases
should go?", "fix it in place or open a PR?"), today it writes the options into its reply and the
user types an answer back. That works, but the user has to retype a label, the agent has to parse
free text, and nothing in the chat shows which question an answer belongs to. A card with buttons
is faster for the user and gives the agent an exact, machine-readable answer.

### 1.2 Why not ACP `session/request_permission`

ACP already has an agent → client question: `session/request_permission`, with options the client
picks from. It never reaches Katashiro. OpenAB core answers it itself: in
`crates/openab-core/src/acp/connection.rs`, `build_permission_response` picks the most permissive
option (`allow_always` when no options are given) and replies to the agent on the spot
(`"auto-respond permission"`), before anything is forwarded to the gateway or a client. So a
question has to travel the way every other Katashiro feature does: as a **Katashiro tool** the agent
calls over the MCP-over-ACP browser tunnel.

### 1.3 The time limit on one tool call

A tunnelled tool call is one `mcp/message` request. OpenAB waits at most
`[mcp] tunnel_timeout_seconds` for it, **170 s** by default, and **180 s** is the hard ceiling: the
agent-side prompt idle timeout (`ACP_PROMPT_IDLE_TIMEOUT_SECS`) fails the whole turn after 180 s of
silence, and a waiting tool call is silence. A user who is reading something else, or who left the
desk, routinely takes longer than that. A tool that *waits* for the answer would therefore fail as
a tunnel timeout (or worse, take the turn down with it) exactly in the cases where the user is not
looking.

## 2. Decision

### 2.1 Asynchronous: ask now, answer as a new message (Brett, "B", 2026-10-12 11:36 TPE)

`katashiro.ask_user({ question, options, multi?, allowOther?, timeoutSec? })` shows a card in the
side panel chat and **returns at once** with `{ "asked": "ask_<id>" }` plus one line telling the
agent to end its turn now: the answer, if any, arrives later as a new message. The tool never waits
for the user, so the 170/180 s limits never apply to how long the user may take.

When the user answers, the panel sends the answer as a **new prompt (a new turn)** to the agent that
asked — the same `Conn`; in a multi-agent room only that agent, never broadcast. It goes through the
same per-connection queue as the user's messages (`Conn.enqueue` → `flushQueue`): if the asking
agent's turn is still running, the answer waits and is batched into its next turn like any other
queued message. The answer is the user's own message, so it resets the agent-to-agent loop guard
like one.

### 2.2 The answer message

One line, framed like every user message (`RoomCore.framePrompt`: `[<ISO time> user]` header):

| Answer | Text |
|---|---|
| one option | `↩ 回答 ask_<id>：<label>` |
| several (`multi`) | `↩ 回答 ask_<id>：「<label>」、「<label>」` (in option order) |
| free text (`allowOther`) | `↩ 回答 ask_<id>：（其他）<text>` |

The id lets the agent match the answer to the question when several are open. Labels are echoed
exactly as the card showed them (after the sanitising below). The `↩` here is not the agent's
reply-to marker (#61): that one needs an ISO time after it, so the panel never splits on this line.

### 2.3 Brett's choices (2026-10-12 10:10 TPE)

- **Q1 = b — the timeout counts only while the user can see the card.** The clock runs while the
  side panel document is visible, the chat view (not Settings) is shown, and the card's conversation
  is the one on screen. Today a panel has exactly one conversation, so that last check compares the
  card's `conversationId` with the panel's (`askConversationShown`), the named hook a
  multi-conversation panel will extend (it compares with the panel's *current* conversation,
  [multi-conversation](./multi-conversation.md) §3.8). Hidden time is not counted: a user who closes the laptop
  lid does not come back to a question that silently expired.
- **Q2 = c — the agent may set `timeoutSec`, clamped to 30–300, default 120.** On timeout the card
  reads **未回答（逾時）** and **nothing is sent** to the agent. The agent learns "no answer" from
  silence, which it already has to handle (§2.6).
- **Q3 = a — 2 to 8 options, short plain-text labels.** `multi: true` lets the user pick any number
  ≥ 1 and press 送出; there are no min/max pick parameters.
- **Q4 = b — another message supersedes the card.** If the user sends any other chat message while
  a card is pending (typed, or posted from a canvas tab), every pending card closes as
  **未回答（你送了別的訊息）**, nothing is sent for them, and the user's message goes out as a normal
  message. The user changing the subject is the answer. With several conversations, only the cards
  of the conversation the message is sent in close ([multi-conversation](./multi-conversation.md) §3.8).

`allowOther: true` adds a small 「其他…」 text box to the card; what the user submits there is the
answer, instead of an option.

### 2.4 Card states

The card stays in the chat after it settles; its buttons go, so a late click cannot answer twice.

| State | Card shows | Sent to the agent |
|---|---|---|
| pending | question, options, hint | — |
| answered | **已回答：** label(s) or （其他）text | the answer message (§2.2) |
| timeout | **未回答（逾時）** | nothing |
| superseded | **未回答（你送了別的訊息）** | nothing (the user's message goes out normally) |
| cancelled | **未回答（聊天已清除）** | nothing |
| disconnected | **未回答（agent 已中斷連線）** | nothing |
| restarted | **未回答（agent 的 session 已重開）** | nothing |

`disconnected` and `restarted` are the two states not in the brief. `disconnected`: the asking agent was deliberately disconnected
(another agent made active, its URL or token edited, removed). An answer then would sit in a queue
nobody flushes, or reach a fresh session that never asked. A transient socket drop does **not**
close the card: the answer is queued and goes out after the reconnect resumes the session.
`restarted`: the reconnect could not resume the session and fell back to `session/new` — that
fresh session never asked, so the asking agent's open cards close then.

Unlike the 🔒 confirm card, an ask card does **not** close when the asking turn ends — the agent is
told to end its turn right away, and the answer is a new turn by design. A user who stops the turn
(⏹) can still answer; answering is itself a deliberate user action.

Cards live in memory only, like confirm cards: they are not replayed from the saved scrollback, and
the answer is not recorded as a chat message (the card already shows it).

### 2.5 Limits and when a call is refused

- `question`: plain text, 1–300 characters after sanitising, not starting with 🔒 (the confirm
  card's mark); `options`: 2–8 labels of 1–60 characters each that look different on screen (ZWNJ/ZWJ
  ignored, NBSP counts as a space); an `other` answer: up to 500 characters. Out-of-range input is an error the
  agent can fix, not silently truncated, so the label the agent later receives is the one it sent.
- **At most 3 pending cards per agent.** A 4th call is an error ("answer or wait for one first"), so
  a looping agent cannot bury the chat in questions.
- **Only inside the asking agent's turn.** Same rule as the confirm card (`ConfirmCore.shouldAsk`):
  the agent's tool calls run one after another, so a call can arrive after the user stopped the turn
  that wanted it. A question for a turn the user cancelled would put words in front of the user that
  no live turn is waiting on. Such a call shows no card and returns an error ("your turn has ended
  — ask in your reply instead"). The rule is about *showing* the card; once shown it outlives the
  turn (§2.4).
- **Not gated by act mode.** Like `show_image` and the canvas tools it is `sessionScope` and
  changes nothing on any web page.

### 2.6 Security

- **Plain text only.** The question and every label pass through `ConfirmCore.plainText`: line
  breaks, C0/C1 controls, bidi and zero-width marks become spaces (`UNSAFE_RE`), so agent text
  cannot fake an extra option row, a system line or a reordered label. Everything is set with
  `textContent`.
- **Visibly not the system.** The ask card has no 🔒, a different border and accent (single solid
  indigo, not the confirm card's amber double border), and its title is always `<agent name> 問你`,
  built by the panel. The agent controls only the question and labels, inside a frame it cannot
  restyle (markdown has `html:false`, and the card sits outside any `.bubble`).
- **It returns data and authorises nothing.** Picking "delete these 3" deletes nothing. The agent
  receives text and must still call the real tool, and destructive tools still ask on their own 🔒
  confirm card; act mode is unchanged. An ask answer is never accepted as consent by any other tool.

## 3. Alternatives considered

- **Synchronous: the tool waits for the answer, with its own timeout ≤ 150 s** (under the 170 s
  tunnel default, leaving margin for the round trip). Simpler for the agent — one call, one result.
  **Rejected:** 150 s is too short for a user who is not watching the panel, and Q1's "count only
  while visible" cannot be honoured at all when the hard ceiling is wall-clock time. A waiting call
  also holds the agent's turn open (the stop button, the room's queue) for the whole wait.
- **ACP `session/request_permission`.** Rejected: OpenAB core auto-answers it (§1.2); and it is a
  permission prompt, which this deliberately is not.
- **Reuse the confirm card as-is** (its API was kept general for "a later ask_user"). Rejected: the
  confirm card is the system's consent surface (🔒, two buttons, resolves a waiting call); an
  agent's question must look different and must not wait.

## 4. Consequences

- Agents get exact answers for choice questions without parsing free text, and the user answers in
  one click. The **`katashiro-ask-user` skill** carries the one rule agents must follow: after
  calling `ask_user`, end the turn; the answer comes as a new message, or not at all.
- "No answer" is silence. An agent that needs a decision must say what it will do if none comes, or
  simply not proceed; it must not poll.
- Pure logic (spec normalisation and clamping, the state machine, visible-time accounting, the answer
  text) lives in `ask-core.js` and is unit-tested; the card DOM and its wiring in `sidepanel.js` need
  a live check in Chrome.
