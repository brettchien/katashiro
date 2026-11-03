# ADR: MCP elicitation reaches the user — openab forwards ACP `elicitation/create` to Katashiro

- **Status:** Proposed — Q1–Q5 decided 2026-11-03 (§5)
- **Date:** 2026-11-03
- **Author:** Brett Chien (drafted by Orca)
- **Related:** [ask-user](./ask-user.md) (agent-authored question cards); [multi-conversation](./multi-conversation.md)
  §3.8 (cards belong to their conversation); [agent-per-conversation](./agent-per-conversation.md);
  [browser-tunnel-liveness](./browser-tunnel-liveness.md); the turn idle timeout (#82, `RoomCore.TURN_IDLE_TIMEOUT_MS`).
- **Spans two repos:** openab (core + gateway, **`downstream` only** on the `brettchien/openab` fork —
  not sent upstream, see §1.4) and Katashiro (this repo).

---

## 1. Context

### 1.1 Problem

An MCP server can ask the person a question in the middle of a tool call (MCP elicitation: "approve
or reject?", "which account?"). In an openab ACP session nobody sees that question today. It is
answered `decline` automatically and the tool carries on as if the user had refused.

The chain is: MCP server → Claude Code CLI (2.1.312, bundled in the Agent SDK) → `claude-agent-acp`
0.99.1 → **openab core (ACP client)** → openab gateway (ACP server) → Katashiro.

- The CLI already handles elicitation, including the 2026-07-28 `InputRequiredResult` flow (it fills
  `inputRequests` and retries `tools/call` with `input_responses` and the echoed `request_state`).
  The question never enters the model's context, so the agent cannot answer it — and must not.
- `claude-agent-acp` forwards the question only when the ACP client declared support for it
  (`dist/acp-agent.js:8942-8949` reads `clientCapabilities.elicitation.form` / `.url`; only then is
  the SDK's `onElicitation` wired, `:9074-9075`). Its handler sends the client
  `elicitation/create` (`dist/elicitation.js`, `mcpElicitationToCreateRequest`).
- **openab declares `clientCapabilities: {}`** (`crates/openab-core/src/acp/connection.rs:586`), so
  no handler is wired and the SDK declines by itself. Any other agent → client request is answered
  `-32601` (`connection.rs:296`). A visible symptom: the session has no `AskUserQuestion` tool,
  because the adapter disables it when form elicitation is not declared (`:8949`).
- Katashiro also declares `clientCapabilities: {}` to the gateway (`src/sidepanel/conn.js:543`).

Reproduced on the k08 pod with a local 2026-07-28 MCP server returning `InputRequiredResult`
(`~/scratch/mrtr-probe/`): SDK with `onElicitation` → the server receives `accept` with content;
without it → `decline`; interactive CLI TUI → native form; `claude -p` → `cancel`.

### 1.2 What the adapter actually sends (read from the 0.99.1 and SDK 2.1.0 sources)

Three things differ from what one would guess from the MCP side, and they shape this ADR:

1. **Declaring `form` turns on three kinds of question, not one.** All three arrive as the same
   `elicitation/create` with `mode: "form"`:
   - **MCP elicitation** (`handleMcpElicitation`, `:8145`) — the case this ADR is about.
   - **The built-in `AskUserQuestion` tool** (`handleAskUserQuestion`, `:8183`, routed from
     `canUseTool`): the *model* asks. Its form has `toolCallId`, fields `question_<n>` (a titled
     `oneOf` enum, or for multi-select `type: "array"` with `items.anyOf`) and `question_<n>_custom`
     free-text "Other" fields, and option previews under `_meta["_claude/askUserQuestionOption"]`.
   - **The refusal-fallback consent prompt** (`request_user_dialog`, `:8214`): "<model> declined this request. Retry with
     <fallback>?" — one `choice` field whose `oneOf` consts are `retry_fallback` / `cancelled`.

   The adapter ties all three to the one capability; openab cannot enable one without the others
   (the one adapter change this ADR makes is §2.10, and it does not touch this).
2. **The MCP server's name is not in the request.** `mcpElicitationToCreateRequest` copies only
   `message` and `requestedSchema` (plus `sessionId`); there is no server name and no `_meta`. The
   only exception is the OAuth URL flow, whose message is `Authenticate with MCP server <name>`.
   The name is not lost upstream of the adapter: the Agent SDK (0.3.312) hands `onElicitation` an
   `ElicitationRequest` whose `serverName` is **required**, plus optional `displayName` / `title` /
   `description` from the server’s `_meta["anthropic/permissionDisplay"]`. The adapter drops them; §2.10
   puts them back.
3. **Interrupts use `$/cancel_request`.** When the callback's abort signal fires, the SDK sends the
   notification `$/cancel_request { requestId }` for the pending `elicitation/create`, and the
   adapter stops waiting at once (`elicitFromClient`, `:7719`). A reply that arrives afterwards is
   ignored by the adapter but must not be sent anyway. The URL-mode completion notification is
   `elicitation/complete { elicitationId }`.

And one mapping rule worth keeping in mind: the adapter turns **a JSON-RPC error from the client
into `cancel`**, never `decline` (`:8166-8172`) — `decline` reaches the server only when the user
actually pressed Decline.

### 1.3 Time limits already in the path

- openab core: `prompt_hard_timeout` (30 min from prompt start) ends the whole turn.
- openab gateway: the ACP prompt idle timer (180 s, `ACP_PROMPT_IDLE_TIMEOUT_SECS`). The core's 30 s
  `keepalive` resets it while the agent is silent, and a waiting elicitation is silence.
- Katashiro: `TURN_IDLE_TIMEOUT_MS` 10 min and `TURN_MAX_TIMEOUT_MS` 35 min. The gateway swallows
  `keepalive` (it does not reach the client), so the panel sees a silent turn while a card waits.

### 1.4 Prior art upstream: openabdev/openab#1533 (closed, not merged)

`feat(discord): support ACP form elicitation` (gandazgul, closed 2026-09-20 by the stale bot):
+6250/−251 in 19 files — a platform-neutral coordinator (`acp/elicitation.rs`, 1885 lines: form
schema parsing/validation, one-pending lease, generation checks), a Discord presenter in core
(`discord.rs` +2065) and a 1289-line subprocess test. Maintainers endorsed the direction but held it
on ROI: on the wire only `claude-agent-acp` emitted `elicitation/create` (Kiro, the default agent,
cannot; Codex did not in three runs), so they asked for evidence beyond Claude, or for the feature
to be scoped as Claude Code support. Its independent protocol fix — classify agent → client requests
before matching responses — was split out as #1540 and is merged (in `downstream` too,
`connection.rs:278`).

What this ADR takes from it: the capability-per-session idea, `question_<n>_custom` rendered as the
"Other" box of its select (the maintainers' finding 4), releasing a settled request's slot before
replying so a follow-up question is not refused as busy, and its schema rules as a reference for
§2.6. What differs: our form UI lives in Katashiro behind the gateway, so core is only a relay and
carries no presenter. Given the upstream stance and that our only producer is Claude, the openab
part stays **downstream only**.

## 2. Decision

### 2.1 Overview

```
claude-agent-acp ── elicitation/create ──▶ openab core (ACP client)
                                             │ per-session capability (§2.2), timeout owner (§2.5)
                                             ▼ GatewayReply command="elicitation_create" + request_id
                                           openab gateway (ACP server)
                                             │ client declared elicitation.form? else error → cancel
                                             ▼ JSON-RPC request elicitation/create (existing send_request)
                                           Katashiro side panel ── card (§2.6) ── user
answer ◀── core ◀── GatewayResponse{request_id, result} ◀── gateway ◀── { action, content? }
```

One question, one card, one answer. Nothing in this path answers on the user's behalf.

### 2.2 Capability: declared per session, from the front-end actually attached

openab spawns one agent process per thread and runs `initialize` per spawn (`pool.rs:598`), so the
capability can differ per session.

- **Katashiro → gateway.** Katashiro's `initialize` declares
  `clientCapabilities.elicitation = { form: {}, url: {} }` (URL mode ships in the first Katashiro PR, Q3).
- **gateway → core.** The gateway remembers each ACP connection's declared `elicitation` modes and
  passes them on the prompt event to core (new optional field on the `GatewayEvent`, e.g.
  `client_capabilities: { elicitation: { form: true } }`; absent = none).
- **core → agent.** When the pool spawns an agent for a thread, `initialize` declares exactly the
  modes the triggering event carried. Discord and Slack events carry none (until §2.9), so those
  sessions keep today's behaviour: no handler, the SDK auto-declines, nothing hangs.
- **Capability drift.** The agent's capability is fixed at spawn. If the conversation later
  reconnects from a client that no longer declares the mode (an older Katashiro, another ACP
  client), the gateway answers core's request with an error and the adapter settles it as
  `cancel` (§1.2). It never hangs and never claims the user declined.

### 2.3 openab core

- **Accept `elicitation/create` from the agent** (today `-32601`). Handling runs on its own task so
  the reader loop keeps reading — the agent may send `$/cancel_request`, `session/update` or a second
  elicitation (subagents) while the first waits.
- **Forward to the gateway** as a `GatewayReply` with `command: "elicitation_create"`, a fresh
  `request_id`, and the agent's `params` verbatim in a new optional JSON field (e.g. `payload`).
  Core adds only `_meta["openab/deadline"]` (§2.5); the server name comes from the adapter (§2.10).
- **Wait for the answer** on the existing `PendingRequests` map, with its own timeout
  (§2.5) instead of the short delivery-ack timeout.
- **Reply to the agent** with exactly what the user chose: `{ action: "accept", content }`,
  `{ action: "decline" }` or `{ action: "cancel" }`. Core validates the shape only (action is one of
  the three; `content` is an object, only with accept); it does not rewrite content.
- **Cancel paths — all end as `{ action: "cancel" }` to the agent, and as `elicitation_cancel`
  (`request_id`) to the gateway so the card closes:** timeout; the agent's `$/cancel_request` for that
  id; the turn ending (`session/cancel`, hard timeout, agent exit); the gateway connection dropping.
  After a cancel the pending entry is gone, so a late answer from the gateway is dropped.
- **`elicitation/complete`** (agent notification) is forwarded as `command: "elicitation_complete"`
  with the `elicitationId`.
- **Audit.** One `info` line per elicitation: session, mode, outcome action, wait time. **No
  content** — field values can be secrets (a token the server asked for). Nothing is persisted.
- The existing facade elicitation path (`openab-mcp` `HostBridge`, `session/request_input`) is left
  as it is.

### 2.4 openab gateway

- Remember each connection's `clientCapabilities.elicitation` from `initialize` and pass it to core
  (§2.2).
- On `elicitation_create`: if the conversation's live client declared the mode, send it a JSON-RPC
  request `elicitation/create` (params as received) through the existing `send_request` pending
  map; otherwise answer core at once with an error (→ adapter `cancel`, §1.2). Relay the client's
  `result` back to core as a `GatewayResponse` carrying a new optional `result` field; a client
  JSON-RPC error goes back as `success: false`.
- On `elicitation_cancel`: send the client `$/cancel_request { requestId: <the gateway's id> }` and
  drop the pending entry, so a late client answer is discarded.
- On `elicitation_complete`: send the client `elicitation/complete { elicitationId }`.
- **Client disconnect** with requests open: fail each to core (→ core `cancel`). A reconnect does
  not revive them.
- The prompt idle timer keeps running on `keepalive` as today; nothing to change there.

### 2.5 Timeout

- One timeout, owned by core: **`elicitation_timeout_secs`, default 600 (10 min)**, configurable,
  and never longer than what is left of `prompt_hard_timeout` for the turn (the turn would end
  first anyway).
- On expiry core cancels (§2.3) and the card shows **未回答（逾時）**. No default answer, ever.
- Katashiro does not run a second timer of its own; it shows the deadline core sends
  (`_meta["openab/deadline"]`, an ISO time) as a countdown.
- While any elicitation card of a turn is open, Katashiro **pauses that turn's idle timeout**
  (`TURN_IDLE_TIMEOUT_MS`), because the gateway swallows the keepalives (§1.3). The 35-minute max
  still applies.

### 2.6 Katashiro: the card

**A new card kind, not `ask_user`.** It reuses the card plumbing (`cards.js`, conversation binding,
pending-card limits per [multi-conversation](./multi-conversation.md) §3.8) but has its own core
module (`elicit-core.js`: schema validation, field model, answer building, state machine) and its own
look.

**Who is asking — the title is built by the panel, never taken from the request:**

| Source (detected from the request shape, §1.2) | Title |
|---|---|
| Has `toolCallId` and `question_<n>` fields → `AskUserQuestion` | `<agent name> 問你（AskUserQuestion）` |
| Single `choice` field with consts `retry_fallback` / `cancelled` | `<agent name>：模型切換確認` |
| Anything else → MCP elicitation | `MCP server 提問 · <name>`, `<name>` = `_meta["claudecode/serverName"]` (§2.10; `displayName` beside it when sent). Missing → `· 來源未知` (only if the image was built without the patch — §2.10 makes that a build failure) |

The MCP card has a distinct border and an `MCP` badge, different from both the indigo `ask_user`
card and the amber 🔒 confirm card, and a one-line note: 「這是 MCP server 的問題，不是 agent 寫的；agent 看不到你的回答。」

**Fields from `requestedSchema`** (each field shows `title`, falling back to the key, and
`description`; required fields get a `*` and block Accept until filled):

| Schema | Widget |
|---|---|
| `string` + `enum` / `oneOf` (≤ 6 options) | buttons (radio behaviour), option `description` as hint |
| `string` + `enum` / `oneOf` (> 6) | `<select>` |
| `type: "array"` + `items.anyOf` / `items.enum` | checkboxes (AskUserQuestion multi-select) |
| `boolean` | toggle, `default` respected, otherwise off |
| `string` (no enum) | text box; `minLength`/`maxLength`, `format: email/uri/date` checked |
| `number` / `integer` | numeric input; `minimum`/`maximum`, integer step |
| anything else (nested object, `$ref`, unknown type) | — the request is refused (below) |

A schema the card cannot render is **not** shown half-way: the panel answers the gateway with a
JSON-RPC error `-32602`, which the adapter turns into `cancel`, and the chat shows one line
「收到一個無法顯示的 MCP 問題，已取消」.

**Buttons:** **接受（Accept）** sends `accept` with the form's content (only the schema's keys, values of
the schema's types); **拒絕（Decline）** sends `decline`; **取消（Cancel / ✕）** sends `cancel`. For the
AskUserQuestion card the labels are 送出 / 略過 / 取消, since decline there means "skip"
(`applyAskElicitationResponse`).

**Card states** (the card stays in the chat; its controls go once settled):

| State | Card shows | Sent |
|---|---|---|
| pending | message, fields, countdown | — |
| accepted / declined / cancelled | **已接受** with a summary (secret-looking fields masked) / **已拒絕** / **已取消** | that action |
| timeout | **未回答（逾時）** | nothing (core already cancelled) |
| withdrawn | **已撤回（回合已結束）** | nothing (`$/cancel_request` arrived) |
| disconnected | **未回答（連線中斷）** | nothing |
| unrenderable | one line, no card | error → `cancel` |

Unlike `ask_user`, a reconnect does **not** revive a pending card: the gateway already failed the
request (§2.4), and a late answer would go nowhere.

**Security.** `message`, titles, descriptions and option labels are plain text
(`ConfirmCore.plainText`, `textContent`), never markdown or HTML. The card authorises nothing beyond
answering the server; act mode is unchanged. Answers are not written to the chat history or
scrollback — the card shows the outcome, and accepted values are not kept after the card settles.

**No secrets in a form (Brett, 2026-11-03 16:18 TPE).** MCP forbids servers to request sensitive
information through form mode (that is what URL mode is for), but a server may ignore it. Every MCP
form card with at least one text field therefore shows a fixed warning line above its fields:
「請不要在這裡輸入密碼、token 或其他機密資料。」 The panel builds the line; the request cannot remove or
restyle it. Same idea as openabdev/openab#1533's Discord form warning (§1.4).

### 2.7 URL mode (in the first Katashiro PR, Q3)

Declared (`elicitation.url`) from the start. The card shows the message and the URL's origin in
full; **開啟連結** opens it in a new tab only after the click, and only for `https:`; the card then
waits. `elicitation/complete` with its `elicitationId` closes it (**已完成**). Decline / Cancel as in
form mode. This is the path the adapter uses for MCP OAuth (`Authenticate with MCP server <name>`).

### 2.8 `AskUserQuestion` becomes available

Declaring `form` re-enables the built-in `AskUserQuestion` tool for Katashiro sessions (§1.2). It is
**blocking** — the turn waits for the answer, up to the §2.5 timeout — while `katashiro.ask_user` is
non-blocking and survives the turn. Both stay; the `katashiro-ask-user` skill gets one paragraph on
which to use (Q2, decided): **`AskUserQuestion` when the turn cannot continue without the answer;
`katashiro.ask_user` for everything else.**

### 2.9 Discord / Slack (follow-up, not in the first PRs)

- Declare `form` for a Discord/Slack session only if every request it can receive renders there.
  Since `AskUserQuestion` multi-select arrays and free-text fields come with the capability (§1.2),
  that means buttons for single enums and booleans, a modal (Discord) / modal or threaded reply
  (Slack) for text, and select menus for multi-select.
- Otherwise do not declare it, so the adapter keeps auto-declining instead of hanging.
- Only the user who sent the triggering message may answer; other users' clicks get an ephemeral
  rejection.

### 2.10 Downstream patch: the adapter forwards the MCP server name (Q4)

The `downstream` image patches `claude-agent-acp` after `npm install -g` (`Dockerfile.claude`; the same
step in `Dockerfile.package` / `Dockerfile.unified` if we build those): `mcpElicitationToCreateRequest`
adds `_meta: { "claudecode/serverName": request.serverName }`, plus `displayName` / `title` when the
SDK provides them, to both the form and the URL request. Only `_meta` changes — the ACP schema
reserves it for exactly this, and clients that do not read it are unaffected.

- **Enforced at build time.** The patch step checks that the patched line is present afterwards and
  fails the build otherwise, so an adapter upgrade that moves the code cannot ship silently without
  the name. Upgrading `CLAUDE_AGENT_ACP_VERSION` therefore means re-checking the patch.
- **Not sent upstream for now** (Brett, 2026-11-03: "fix in downstream first"). An upstream PR to
  `claude-agent-acp` is a later option; once it lands, the patch goes away.
- This is a deliberate exception to the task brief's "no change to `claude-agent-acp`".

## 3. Alternatives considered

- **Let the agent answer** (put the question into the model's context). Rejected: the question is
  addressed to the human, and the CLI deliberately keeps it out of the model's context.
- **Declare `elicitation.form` for every openab session.** Rejected: Discord/Slack sessions would
  send questions nowhere and wait for the timeout on every MCP elicitation instead of today's
  instant decline.
- **Route through the OAB MCP Facade's `session/request_input` / rmcp elicitation path.** Rejected
  for this path: the question comes from the agent process over ACP, not from an MCP server the
  facade talks to. The facade path stays as it is.
- **A tunnel tool (`katashiro.*`) the core calls.** Rejected: tunnel calls are bounded by the 170 s
  tunnel timeout and tied to the MCP tunnel's session; this is an ACP request with its own lifetime.
- **Guess the server from the open tool call** (`mcp__<server>__<tool>` title of the only open
  tool call). Rejected for Q4: ambiguous with parallel tool calls and subagents, and the SDK already
  has the exact name.
- **Timeout in Katashiro only.** Rejected: a panel that is closed or asleep would never fire it, and
  the turn would hang until the 30-minute hard timeout.

## 4. Consequences

- In a Katashiro session the tool list contains `AskUserQuestion` — the end-to-end proof that the
  capability is declared.
- MCP servers that elicit now work in Katashiro sessions, and their questions are clearly marked as
  coming from an MCP server.
- Discord/Slack sessions are unchanged until §2.9.
- New wire: `GatewayEvent.client_capabilities`, `GatewayReply` commands `elicitation_create` /
  `elicitation_cancel` / `elicitation_complete` with a `payload` field, `GatewayResponse.result`. All
  optional, so an older gateway/core pair keeps working (no capability → today's behaviour).

### 4.1 PRs

1. This ADR.
2. **openab** (fork, PR into `downstream`, carried as a downstream commit — no upstream PR, §1.4):
   core §2.2/§2.3/§2.5, gateway §2.2/§2.4, the adapter patch §2.10, with tests.
3. **Katashiro**: capability, `elicit-core.js` + form and URL cards, idle-timer pause, skill note
   (§2.8), with tests.
4. Later: Discord/Slack (§2.9); an upstream PR for §2.10.

### 4.2 Acceptance

- Katashiro session: `AskUserQuestion` is in the tool list.
- The MCP card names the probe server (`_meta["claudecode/serverName"]`, §2.10).
- With the mrtr-probe server (form: `choice` enum `approve|reject` + optional `note`), the server's
  logged `input_responses` action matches the button exactly: Accept → `accept` with content,
  Decline → `decline`, ✕ / timeout / interrupt → `cancel`.
- Ignoring the card past the timeout → `cancel`, and the card shows 逾時. Stopping the turn (⏹) →
  `cancel`, the card shows 已撤回, and no late answer is sent.
- A Discord session, or a Katashiro build without the capability, keeps auto-`decline` with no wait.
- Tests: capability per front-end (core spawn + gateway pass-through); schema → widget mapping incl.
  unrenderable → `-32602`; the three actions; timeout; `$/cancel_request`; client disconnect; late
  answer dropped.

## 5. Decisions (Brett, 2026-11-03)

- **openab part:** `downstream` only (15:43 TPE; §1.4).
- **Q1 — Timeout:** 10 minutes (15:50; §2.5).
- **Q2 — `AskUserQuestion`:** blocking `AskUserQuestion` when the turn needs the answer to continue,
  `katashiro.ask_user` otherwise (15:50; §2.8).
- **Q3 — URL mode:** in the first Katashiro PR (15:50; §2.7).
- **Q4 — MCP server name:** enforce it; patch the adapter in `downstream` first (15:51; §2.10).
- **Q5 — End-to-end test:** move the mrtr-probe harness into Orca's container and run it there against
  the `downstream` build (15:51).
