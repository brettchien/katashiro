# ADR: Multi-conversation — several conversations in one side panel

- **Status:** Accepted 2026-10-12 (Brett; Q1–Q9, Q11, Q12 at 16:30–16:34 TPE, archive + gallery
  reopen and "write the ADR + build the MVP" at 16:39 TPE; P1b additions at 18:28–18:31 TPE, §4;
  deleting a conversation brought forward from P4 at 21:39 TPE, §7.1). **Q10 (P3) open** (§6).
- **Date:** 2026-10-12
- **Author:** Brett Chien (drafted by Orca)
- **Related:** [single-active agent](./single-active-agent.md) (lifted by
  [agent per conversation](./agent-per-conversation.md), 2026-10-16);
  [ACP connection ownership](./acp-connection-ownership.md) (becomes P3); [canvas](./canvas.md)
  §3.1 (tab group per conversation), §3.6 (storage keyed by `conversationId`), §3.11 (the gallery
  shows every conversation); [ask_user](./ask-user.md) §2.3 (Q1 visible-time hook, Q4 supersede);
  chat history per window (#54) and its browser-restart adoption (#56); message ids (#61, #62).

---

## 1. Context

### 1.1 Today: one window, one conversation

A side panel holds exactly one conversation, the window's:

- `chrome.storage.local` `history:<windowId>` = `{ conversationId, sessions: { <agentUrl>: <acpSessionId> },
  messages (≤ 200), savedAt }` (`sidepanel.js` `saveHistory` / `loadHistory`).
- `conversationId` (`c_` + 12 hex) is minted once and never changes; message ids are
  `<conversationId>:<ms>` (`RoomCore.messageId`, unique per ms in the panel, #62).
- Canvases are already keyed by it (`canvas:<conversationId>:index`, `meta.conversationId`), and the
  canvas tab group is per conversation (`katashiro.canvasGroup.<conversationId>` in `storage.session`),
  titled "Canvas" until this ADR.
- The `Conn` (one per configured agent; only the active one connects, single-active ADR) owns one
  `acpSessionId`, one `turnActive`, one prompt queue, one stream and one browser MCP server instance.
- After a browser restart every window id changes; a window with no `history:` key adopts the most
  recently saved orphan (`RoomCore.planHistoryAdoption`, under the `history:adopt` lock), orphans older
  than 7 days are pruned (#56).

To start a new topic the user can only clear the screen (🧹, which keeps the agent's session) or use
another window. There is no way to keep two topics apart and go back to either.

### 1.2 What openab allows (code read 2026-10-12, openab main 6431a1b; live test 2026-10-10)

- **Several sessions per WebSocket.** The gateway runs each `session/prompt` as its own task, up to 32
  in flight per connection (`MAX_INFLIGHT_PROMPTS`). A second prompt to a session whose turn is still
  running fails with `-32001 Session busy`. Each session is its own broker channel `acp_<uuid>`.
- **The real limit is the broker pool:** `[pool] max_sessions = 3`, **shared with Discord threads and
  usercron**. When full, the oldest *idle* session is suspended (it comes back with `session/load` on
  its next prompt); when all 3 are busy, a new turn fails with "pool exhausted". Idle TTL is 1 h.
- **`session/resume` always succeeds at the gateway**: it derives the channel from the id without
  checking the agent side. If the broker's `session/load` later fails (the task was replaced and the
  Claude session file is gone, `-32002`), the broker **silently creates a new session** under the same
  ACP id. The client is not told; the agent just has no memory of the conversation.
- **No `session/close`.** The gateway implements `session/new`, `session/resume`, `session/prompt`
  and `session/cancel` only. A session is released by the pool's TTL or eviction, nothing else.
- **Browser tunnels are per session.** A tunnel is opened for each MCP server a session declares in
  `session/new` / `session/resume` (registry key `(channel_id, server_id)`, channel = session). Tool
  calls carry no `sessionId`, but the tunnel they arrive on identifies the session.
- **The facade is session-aware.** `execute_capability` maps the agent's `OPENAB_SESSION_TOKEN` to its
  channel and resolves that session's own `browser` tunnel (`acp_tunnel_source.rs`), so a skill
  calling `katashiro.*` through the facade reaches the right conversation too.
- **⏹ Stop does not guarantee the agent stops** (2026-10-12): Katashiro finishes the turn, the agent
  process may keep working.

Nothing in openab has to change for any phase below. Two upstream improvements would help and block
nothing: telling the client when `session/load` failed ("proposal A") and `session/close` (P4).

---

## 2. Decision

Katashiro becomes a **multi-conversation** client in phases. Each phase ships on its own.

| Phase | Scope | Not yet |
|---|---|---|
| **MVP (P1a)** | storage migration (`history:<windowId>` → `conv:<id>` + `window:<windowId>`); a **tab strip** at the top of the panel, **at most 3 open conversations**; ＋ new, × **archive** (never delete), rename (auto + manual); archived conversations listed in a new **對話** section of the 🗂️ gallery to reopen; switching resumes the session, U2 (`chat_history`) as fallback; **no switching while a turn is running**; one window per conversation (Web Lock); browser restart → last conversation; `ask_user` / 🔒 cards bound to their conversation (§3) | background turns, agent tabs in the group, working tab |
| **P1b** | one Chrome tab group per conversation: its canvases **and the tabs the agent opened**; groups stay expanded on switch (Q5, revised 2026-10-13); working tab, and switching to it when the user sends (Q6); a card waiting in another conversation → tab-strip mark + notification (Q12); a conversation that comes back reopens its group's tabs; archive closes them; agent `set_title`; a composer draft per conversation; the P1a leftovers (§4) | background turns |
| **P2** | background turns: one session state per conversation on the same connection; ⏳ / ● / ❓ on the tab strip; completion notification (Q9); background writes only on the conversation's own tabs (Q8); pool exhausted handled (§5) | panel closed |
| **P3** | the connection leaves the side panel (offscreen document); **Q10 open**, decided after P2 is tried (§6) | — |
| **P4** | mirror folder rename by per-file `move()` (#101); upstream `session/close`; ~~deleting a conversation~~ (built ahead, §7.1); several agents per conversation (§7) | — |

Brett's answers (2026-10-12, on `ask_user` cards; the design canvas `cv_beec3be8efac` holds the
discussion):

| # | Phase | Question | Decision |
|---|---|---|---|
| Q1 | MVP | Which "last message" time does a tab show? | Any message, the agent's replies included (16:31) |
| Q2 | MVP | One conversation open in two windows? | Forbidden: Web Lock, and say which window has it (16:31) |
| Q3 | MVP | After a browser restart | Back to the last conversation (16:31) |
| Q4 | MVP | Where is the conversation list? | Only a tab strip at the top of the panel, at most 3 conversations (16:30) |
| Q5 | P1b | Other conversations' tab groups on switch | **Not collapsed:** a conversation's group stays as long as the conversation is in the panel's tab strip; archive closes it (§4.5). Brett 2026-10-13 16:01 TPE (replaces "collapse on switch", 16:32 of 10-12) |
| Q6 | P1b | Sending while the active tab is not the working tab | Switch to the working tab, only at the moment the user sends, never mid-turn (16:32) |
| Q7 | P2 | Background concurrency | 3, from Q4; the pool is shared, so pool exhausted must be handled |
| Q8 | P2 | A background conversation touches the tab the user is on | Error; the agent uses a tab of its own group (16:33) |
| Q9 | P2 | A background turn finishes | Chrome notification + tab-strip mark (16:33) |
| Q10 | P3 | Keep running with the panel closed? | **Open**, after P2 is tried |
| Q11 | MVP | A 4th conversation: what happens to the one closed? | Archived, reopenable (16:34); reopened from the gallery (16:39) |
| Q12 | P1b | An `ask_user` / 🔒 card in a conversation not on screen | Tab-strip mark + Chrome notification (16:34) |

The single-active-agent model stays: one connection, one agent per panel through P3. What changes is
which session (and later, sessions) that connection serves. **Lifted 2026-10-16** by
[agent per conversation](./agent-per-conversation.md): each conversation is bound to its own agent
and the panel connects every agent an open conversation uses.

---

## 3. MVP (P1a)

### 3.1 Model

Three ids, each owned by the one above it:

1. **Conversation id** (`c_…`, Katashiro's, never changes). Owns the messages, the canvases, the tab
   group, and a map **`sessions[agentUrl] = acpSessionId`** ("M", Brett 2026-10-10): the current ACP
   session for each agent, replaceable.
2. **ACP session id** (`sess_…`). Resumable while the broker can load it.
3. **The agent's own session** behind the broker. Survives idle eviction within one task; gone when
   the task is replaced (§1.2), and Katashiro cannot see it.

Message ids stay `<conversationId>:<ms>` (#61, #62), so nothing that refers to a message changes.

### 3.2 Storage and the one-time migration

`chrome.storage.local`, never synced:

| Key | Value |
|---|---|
| `conv:index` | `{ [id]: { title, titleSource: "auto" \| "agent" \| "user" \| null, createdAt, lastMessageAt, archivedAt \| null } }` (`"agent"` from P1b `set_title`, §4.6) |
| `conv:<id>` | `{ id, sessions: { <agentUrl>: <acpSessionId> }, messages (≤ 200, as today), savedAt }`; P1b adds `workingTab` and `groupTabs` (§4.3, §4.4) |
| `window:<windowId>` | `{ open: [<id>, …] (tab order), current: <id>, savedAt }`, replaces `history:<windowId>`; the `open` lists of all **live** windows together hold at most 3 ids (§3.3) |
| `conv:schema` | `1` once migrated (informational; the migration trigger is the presence of `history:*` keys) |
| `canvas:*` | unchanged (already keyed by `conversationId`) |

- A message write updates `conv:<id>` as `saveHistory` does now. `conv:index` is read-modify-written
  under the Web Lock **`conv:index`** (several panels write it); `lastMessageAt` is written at most
  every 5 s per conversation and always on switch, archive and panel hide.
- **Migration** runs **whenever any `history:*` key exists** (not only while `conv:schema` is absent),
  under the lock **`conv:migrate`**, by whichever comes first: the service worker's `onInstalled` /
  `onStartup`, or a panel's load. A panel **awaits** the lock (not `ifAvailable`), then re-reads the
  `history:*` keys before building anything, so a panel never loads a half-migrated state. Run:
  1. **Fix every id first.** A pre-#61 entry with no `conversationId` gets one minted and **written
     back into its `history:<windowId>`** before anything else, so a run cut short after this step
     reuses that id instead of minting a second conversation for the same chat.
  2. **Deduplicate.** `adoptOrPruneOrphanHistory` (#56) sets the new key before removing the old, so
     an interrupted adoption can leave two `history:` keys with one `conversationId`. The one with the
     newer `savedAt` wins: its messages and sessions are used, and only its window gets the id
     (step 4); the other key is just removed in step 5.
  3. Write `conv:<id>` (sessions, messages) and its index entry: auto title from the first user
     message (§3.3), `createdAt` = the first message's time (else `savedAt`), `lastMessageAt` = the last
     message's time. If `conv:<id>` already exists (an earlier, cut-short run, or a downgrade and
     upgrade, below), the newer `savedAt` wins as a whole; the older copy is not merged.
  4. **Open at most 3.** Rank the conversations: those of live windows (`chrome.windows.getAll`)
     first, then newest `lastMessageAt`. The first 3 get `archivedAt: null` and their
     `window:<windowId>` = `{ open: [id], current: id }`; every other one gets `archivedAt` set and no
     window record, and is reopened from the gallery (§3.4). Orphaned window ids among the first 3 keep
     their record, so the #56 adoption (§3.7) still finds them.
  5. Remove each `history:<windowId>` once its conversation is written; finally set `conv:schema = 1`.
  Every step is idempotent, so a run cut short by the worker stopping is completed by the next one.
  **Downgrade:** an older Katashiro finds no `history:` key and starts empty in a new conversation;
  what it writes to `history:` is migrated when the newer version comes back (it is a separate
  conversation, since the older version minted its own id). Nothing is lost silently.
- **Empty conversations are not kept.** Archiving a conversation with no messages and no canvases
  deletes its keys instead; ＋ does not litter the gallery.

### 3.3 The tab strip

- One row at the top of the chat view: one tab per open conversation, then **＋**. At most **3 conversations are open across all windows** (Q4: the limit mirrors the broker pool of 3, which is global), not 3 per window.
  "Open" counts the ids in the `window:` records of **live** windows (`chrome.windows.getAll`). The
  count and the change it guards (＋, reopen, adoption, a panel's first load) happen in **one
  `conv:windows` lock** (§3.6), so two windows pressing ＋ at once cannot make 4.
- **A closed window** (not a browser restart) leaves its record behind as an orphan. Its
  conversations do not count toward the 3 and are not lost: the gallery's 對話 section (§3.4) lists
  them with the archived ones, and reopening one moves it out of the orphan record. A new window that
  adopts the record (§3.7) takes back only as many as fit under the 3.
- A window whose panel loads with nothing to open while 3 are open elsewhere shows the archive
  picker (§3.4) instead of a new conversation; 取消 leaves the panel on a notice listing the 3 with
  buttons that focus their windows.
  The current tab is highlighted. Each tab shows the title (truncated, full title on hover) and the
  time of the conversation's last message of any kind (Q1): `HH:MM` today, else `M/D`.
- **＋** opens a new, empty conversation and switches to it (§3.5). With 3 open (in any window), ＋ first asks which
  one to archive (§3.4).
- **×** on a tab archives that conversation (§3.4). Closing the last open tab leaves a new empty one.
- **Names.** A new conversation shows `未命名 <7-char short id>` until its first user message, whose
  text becomes the title (`titleSource: "auto"`): sanitised like confirm-card text
  (`ConfirmCore.plainText`), whitespace collapsed, first 40 characters. Double-click a tab to rename
  it (`titleSource: "user"`); an empty name returns to the auto title. A user name is never replaced
  automatically. Agent text never names a conversation in the MVP; P1b adds `set_title` (§4.6,
  moved up from P4 by Brett 2026-10-12 18:30).
- The title also names the conversation's canvas tab group (replacing "Canvas", canvas §3.1) and its
  label in the gallery's canvas rows. The mirror folder keeps its `c_<id>` slug until P4, which
  names it after the title too (§7, done 2026-10-12).
- 🧹 clears the current conversation's messages only (sessions kept, as now).

### 3.4 Archive and reopen

- **Archive (×)** is Katashiro-side only (there is no `session/close`, §1.2): set `archivedAt`, remove
  the id from the window's `open`, release its Web Lock, drop its in-memory state and remove its
  MCP server instance and that instance's `connections` entries (§3.9); its pending ask cards close
  as `archived` (**未回答（對話已封存）**, ask-user §2.4; not `cancelled`, whose text says the chat was
  cleared — Jellyfish, #127 review). Messages, sessions,
  canvases and their tabs stay as they are (P1b closes the group's tabs, §4.5). The broker
  session ages out by TTL or pool eviction. The agent has no archive tool: it is the user's decision.
- A conversation whose turn is running cannot be archived (same rule as switching, §3.5).
- **Reopen.** The 🗂️ gallery (`canvas-gallery.html`) gets a **對話** section above the canvases:
  every conversation not open in a live window (archived, or left in a closed window's record, §3.3),
  newest `lastMessageAt` first, with title, last message time and
  canvas count, filtered by the same search box (title only). **重新打開** sends
  `katashiro-conv-open { id }` (accepted only from `canvas-gallery.html`, like `katashiro-canvas-open`; also from
  `canvas.html` for its own conversation since §7.2)
  to the panel of the gallery's window. That panel takes the conversation's lock (§3.6), clears
  `archivedAt`, adds it to `open` and switches to it. With no panel there, the gallery opens the side
  panel for its window (`chrome.sidePanel.open` in the click's user gesture) and leaves the request in
  `storage.session` for the panel to pick up on load.
- **With 3 already open**, the panel asks which to archive first: a system card (not agent-styled)
  listing the 3 titles plus 取消; a conversation that is replying cannot be picked. Cancelling
  reopens nothing.
- The canvas rows keep working for archived conversations: with no panel showing that conversation,
  the gallery opens the canvas tab ungrouped, as it already does (canvas §3.7).

### 3.5 Switching

- **Not while a turn is running.** Switching, ＋ and × on the current tab are refused while the
  current conversation's turn is running or has queued prompts: one line, `回覆中不能切換——等回完或先按
  ⏹ 停止`. (In P2 the turn continues in the background instead.)
- **Per-conversation session state in the `Conn`.** Everything that belongs to a session moves from the
  `Conn` into a state object per open conversation: `acpSessionId`, prompt queue and pending images,
  last prompt (retry), `turnActive`, the stream, the browser MCP server instance and its `mcpState`.
  The `Conn` keeps the socket, heartbeat and liveness, and a `current` pointer. In the MVP only the
  current state may run a turn; P2 lifts that.
- **`session/update` is routed by `sessionId` already in the MVP.** Today the handler
  (`sidepanel.js` `onMessage`, the `session/update` branch) ignores `sessionId`. With several
  sessions on one socket, a turn the user stopped in A whose agent keeps going (§1.2) would append
  its late chunks and tool calls to B after a switch. The MVP drops (and logs) every update whose
  `sessionId` is not the current state's; P2 routes it to its own state instead (§5).
- **One DOM list per open conversation.** Each open conversation has its own message list element,
  built from `conv:<id>` the first time it is shown and then kept, hidden while not current. Cards
  (memory-only, §3.8), reply buttons and scroll position therefore survive a switch, and P2 can stream
  into a hidden list. Archive removes the element.
- **Steps:** save the current conversation and hide its list → set `current`, write `window:<id>` →
  show the new list → if its session has not been resumed on this socket since the socket opened:
  `session/resume` with its `acpSessionId` and its own MCP server declaration, or `session/new` if it
  has none for this agent → refresh ask-card visibility, the roster and the tab strip. Messages typed
  before the handshake finishes wait in that conversation's queue, as on a reconnect today.
- **U2 fallback.** Katashiro cannot tell a resumed session from one the broker silently recreated
  (§1.2), so it does not try to guess (the session id does not change either). Instead, the **first
  prompt after any `session/resume` or `session/new` of a conversation that has messages** carries one
  host line **before** the batch: `[katashiro: this conversation was just reconnected. If you do
  not have its earlier messages, read them with katashiro.chat_history before answering.]`. An agent
  that remembers ignores it; one that lost its memory recovers from Katashiro's record (≤ 200
  messages). This also covers today's reconnect after a task restart.
  Like `REPLY_HINT`, the line is added **at flush time only**: it is not stored in `conv:<id>`, not
  in the retry copy of the prompt, and `chat_history` never returns it. It goes first because
  `batchWithReplyHint` strips the reply hint by `endsWith`; a line after it would break that on a
  retry. The "needs the line" flag clears only when `session/prompt` is accepted, so a retried
  first prompt carries it again.
  **Revised 2026-10-12 ([tunnel-liveness §9.2](./browser-tunnel-liveness.md)):** the line is skipped
  when the session is almost certainly intact — it was resumed (not created), this agent replied in
  the conversation during the current **run** of quick reconnects (each socket opened < 2 min after
  the previous one's last inbound frame, which dropped without a close frame — a clean close always
  starts a new run), and that reply is < 1 h old (the pool TTL). That removes the
  line from network-blip reconnects and from switching to a conversation already used on this socket;
  a panel reload, a slow reconnect, an idle conversation or a `session/new` still get it. The flag is
  sticky: a later open never clears it. Known gap: an openab restart under 2 min whose socket drops
  without a close frame is missed until
  openab reports a boot id (proposal A). When `session/resume` itself
  fails, the fallback to `session/new` stays as now and closes that conversation's ask cards as
  `restarted` (ask-user §2.4).
- **What cannot be detected:** a session the broker recreated keeps its ACP id, so the chips still read
  已續接 and the agent's own context (tool results, files it read, its plan) beyond the chat text is
  lost. If openab ships proposal A, an explicit "load failed" replaces the host line with a visible
  notice.
- **Pool use.** Resuming does not load the agent side; only a prompt does. In the MVP a window has at
  most one busy session, so 3 open conversations do not take 3 pool slots.

### 3.6 One window per conversation (Web Lock)

- A panel holds the Web Lock **`conv:<id>`** (`navigator.locks.request` with a promise that settles
  only on archive) for every conversation in its `open` list. Closing the panel or the window releases
  them; no heartbeat.
- Opening a conversation (load, reopen, adoption) uses `ifAvailable: true`. If another window holds
  it, the panel says `這段對話開在另一個視窗` with a button that focuses that window (found by scanning
  `window:*` for the id) and does not open it.
- Moving a conversation between window records (reopen in another window, adoption) and every change
  to the open count (§3.3) happen under the lock **`conv:windows`**, which replaces `history:adopt`. On load a panel drops from its own `open`
  every id whose lock it cannot get (another window took it while this panel was closed).

### 3.7 Browser restart (Q3)

The #56 adoption carries over to `window:` keys: a window with no `window:<id>` adopts the most
recently saved orphan record (its `open` and `current`) and takes their locks, as many as fit under
the 3 of §3.3 (`current` first, then newest `lastMessageAt`; the rest stay reopenable from the
gallery); orphan records older
than 7 days are pruned and their conversations archived (`archivedAt` set). The panel opens on
`current`. A window with nothing to adopt starts with one new conversation.

### 3.8 Cards belong to their conversation

- **Ask cards** (`pendingAsks` entries already carry `conversationId`):
  - visible time (ask-user Q1): `askConversationShown(entry)` compares with the panel's **current**
    conversation; a switch calls `refreshAskVisibility()`, so a card in a hidden conversation does not
    count down;
  - supersede (ask-user Q4): sending a message closes only the pending cards **of the same
    conversation**; cards elsewhere stay. It closes the cards pending **when the user sends**: a
    card the agent asks later in the same turn, before that message (queued behind the turn)
    reaches it, stays open — the user has not seen it yet, so the message cannot be "instead of
    answering" it. (This was the suspected P1a bug of 2026-10-12 18:31: the message was sent at
    18:31:06.675 while the agent's turn ran, the two cards were asked at 18:31:07, and the queued
    message reached the agent at 18:31:12. The conversation ids matched; P1b adds a regression
    test for both orders, §4.8.);
  - the answer goes to the **asking conversation's session**. In the MVP the card can only be clicked
    while its conversation is on screen, so that is the current state's queue; the entry keeps a
    reference to the session state, not the `Conn`, so this stays true in P2;
  - the two close reasons differ in scope: **`restarted`** (one conversation's `session/resume` fell
    back to `session/new`) closes only that conversation's cards for that agent;
    **`disconnected`** (the agent deliberately disconnected: another agent made active, URL or token
    edited, removed) closes that agent's cards **in every conversation**, since none of its sessions
    will be flushed. A transient socket drop closes nothing, as now;
  - archive closes the conversation's cards as `archived` (§3.4);
  - the 3-pending-card cap is **per agent per conversation** (ask-user §2.5).
- **🔒 Confirm cards** are bound to the turn they were asked in. Turns run only in the current
  conversation in the MVP, and a switch is refused while one runs, so a confirm card is always on
  screen. 🧹 cancels only the current conversation's cards.
- A card waiting in a hidden conversation has no mark in the MVP; its clock is paused. The mark and
  notification are P1b (Q12).

### 3.9 Tool calls and what the agent sees

- **One browser MCP server instance per (conversation, agent)**, declared in that session's
  `session/new` / `session/resume`. The tunnel a call arrives on (§1.2) therefore names its
  conversation, and every per-conversation dependency (`canvas.conversationId`, `chatHistory`, where
  a card or `show_image` goes) is bound to that conversation, not to "the panel's".
- **No fallback between servers.** `BrowserMcp.serverForAcpId` today falls back to `declared[0]`
  for an `acpId` it does not know (`browser-mcp.js`). With one server per conversation that fallback
  is exactly the cross-conversation misuse this section prevents: a late `mcp/connect` for an archived
  conversation's server would be routed to another conversation's. Rule: **when more than one server
  is declared, an unknown `acpId` is refused**; the fallback stays only for a single declared server.
  Archive removes the conversation's server and its `connections` entries (§3.4), so later frames
  on those connections are refused as unknown (already the rule for `connectionId`).
- **Tool calls from a non-current conversation are refused** in the MVP with an error (`this
  conversation is not on screen in Katashiro`). They happen only late: a turn the user stopped whose
  agent kept going (§1.2), or a facade call outside a turn. P2 replaces this rule with Q8's.
- **`canvas_list`, `canvas_read`, `canvas_delete`** stay scoped to the calling conversation (unchanged).
  **`chat_history`** returns the calling conversation's messages.
- **The gallery shows every conversation** (canvas §3.11 (a), Brett 2026-10-12 16:01): an agent that
  opens it with `canvas_gallery` and screenshots it sees other conversations' canvases and, with the
  new 對話 section, archived conversations' titles. Accepted on the same grounds: it is the user's own
  view; scoping (§3.11 (b)) remains the way to tighten it.

### 3.10 Canvas tabs and pushes

- Group bookkeeping takes the conversation id explicitly (`storedCanvasGroupId(conv)`); the panel's
  group queue becomes one queue per conversation, as canvas §3.1 specified.
- `katashiro-canvas-open` (gallery row) is answered by the panel that has the canvas's conversation
  **open** (current or not); the canvas opens in that conversation's group without switching.
- `katashiro-canvas-push` (Send to agent / 💬 Ask agent / Send error) for an open but not current
  conversation **switches to it first**, under §3.5's rule (refused while the current one is replying,
  and the canvas tab is told why), then posts. For an archived conversation it is refused:
  `這段對話已封存：先重新打開它` (with a **重新打開對話** button since §7.2; it read
  `…先從總覽重新打開` before). P1b makes the other refusals say what is really the case (§4.8).

### 3.11 Implementation notes (MVP, 2026-10-12)

Where the MVP had to read this section one way, it took the safer reading:

- **Adoption with no free slot adopts nothing** (§3.7): the orphan record stays for a later window,
  so a second window opened while 3 are open elsewhere does not archive a closed window's
  conversations. That window still writes its own record, empty (`{open:[]}`), so it never adopts
  later either: an orphan is only adopted by a window that has no record yet. Accepted
  (Jellyfish, #128 review; recorded for P1b, 2026-10-12) — the orphan's conversations stay
  reopenable from the gallery. With some room, what does not fit is
  archived (never left in no record). The new record is written before the adopted one is
  removed, so closing the panel in between leaves the conversations in two records, never in
  none. "Most recently saved" orphan = the newer of the record's `savedAt` and its conversations'
  `lastMessageAt`.
- **Migration never disturbs an open set** (§3.2 step 4): conversations already in a window record
  (an earlier run, or the newer version running before a downgrade) keep their slots; a
  downgrade-period conversation with no slot left is archived, reopenable from the gallery.
- **Queued prompts block a switch only on a live connection** (§3.5): a queue waiting for a
  reconnect does not trap the user; it is flushed when that conversation is current again.
- **"A conversation that has messages"** (U2, §3.5) = messages recorded before the queued prompt: a
  new conversation's first message is recorded before its `session/new` finishes and gets no line.
  Since 2026-10-12 the line is also skipped for a resume within the current run of quick reconnects
  (tunnel-liveness §9.2).
- **The picker can archive a conversation open in another window** (§3.3): that window's panel
  archives it on request (refusing while it replies); with no panel showing it (its lock is free),
  the records are changed directly.
- **A push for a conversation open nowhere** (§3.10) is refused by the panel of the canvas tab's
  window, and only when no panel holds the conversation's lock (else that panel answers).
- **A typed name** is capped at 80 characters (the ADR sets no cap); `session/update` frames with no
  `sessionId` are still shown (only a different id is dropped).
- **One tunnel router per socket**: each conversation's state owns its MCP server instance, while the
  `Conn` keeps the router (`servers` = every open conversation's instance, `connections`), since
  tunnel frames carry no session id.

### 3.12 Not in the MVP

Background turns; agent-opened tabs in the conversation's group; group handling on switch; the
working tab; marks and notifications for other conversations; agent `set_title`; per-conversation
drafts; reopening and closing a group's tabs (all P1b, §4); mirror folder names; deleting a
conversation (§7.1); search over conversation content.

---

## 4. P1b — a tab group per conversation, working tab

Scope as accepted on 2026-10-12 (16:30–16:34 TPE), plus Brett's additions of 18:28–18:31 TPE after
the MVP's live test (the design canvas `cv_beec3be8efac`, "P1a（MVP）留下、併入 P1b 的項目"). Turns
still run only in the current conversation (§3.5); P2 lifts that.

### 4.1 One tab group per conversation

- **One Chrome tab group per conversation** (Brett 2026-10-12 16:30, "a"): title = conversation title,
  holding its canvases **and the tabs the agent opens with `new_tab`**. It is the canvas group of
  §3.10 (`katashiro.canvasGroup.<id>` in `storage.session`), now also taking agent tabs. Tabs the
  user opened are never pulled in; an agent acting on one only records it as the working tab
  (§4.3). A tab Chrome itself puts in the group (a link opened from a grouped tab) is in the group
  and is treated like the rest.
- **The group is the membership.** What is in the group belongs to the conversation; dragging a tab
  out of the group gives it back to the user: it is no longer tracked (§4.4) or closed on archive
  (§4.5). A tab is in at most one group, and Split View keeps both sides' group state consistent
  (the canvas §3.1 rules, which #90 learned the hard way): a tab in a split is never grouped or
  ungrouped on its own.

### 4.2 Groups on switch (Q5)

- **No group is collapsed on a switch** (Brett 2026-10-13 16:01 TPE, replacing "collapse the
  others", 16:32 of 10-12): a conversation's group stays, expanded, as long as the conversation is
  in the panel's tab strip; only archive closes it (§4.5). The user may still collapse a group by
  hand; Katashiro leaves that as it is, except for the safeguard of §5.2.
- On a switch, in the panel's window, the new conversation's group is expanded (the user may have
  collapsed it by hand).
- **Activate step:** if the active tab is in a group of another open conversation, a tab outside it
  is activated — the new conversation's working tab (§4.3) if it is in this window, else its group's
  most recently used tab, else the most recently used tab in no conversation's group (canvas §3.1),
  else nothing. (Under review by Brett; kept as a separate step, `switchActivate`, so it can be
  dropped on its own.)
- Best effort: a Chrome refusal ("tabs cannot be edited right now" while the user drags) leaves the
  tabs and groups as they are. The rule is a pure plan (`CanvasTabs.planGroupSwitch`); the panel
  only makes the calls.

### 4.3 Working tab (Q6)

- Each conversation records the **last tab its agent acted on** (or, for a canvas push below, the
  canvas tab the user pushed from): every page tool (it resolves the
  active tab), `new_tab` (the tab it opened) and `switch_tab` (the tab it switched to).
  `conv:<id>.workingTab = { id, url, at }`, the URL as it is after the call.
- **Canvas tabs count when a canvas tool puts one in front of the user** (fix 2026-10-13: the
  working tab stayed on a canvas the agent had screenshotted, so every send jumped back to it from
  the canvas the agent was showing): `canvas_goto`, `canvas_highlight` (not when it is deferred
  because the user is editing), `canvas_view` `compare: true` (the canvas tab, even when the
  compare tab opened in front as a plain tab: ✕ closes that one, and a closed working tab leaves Q6
  nothing), and `canvas_open` with
  `beside: "current"` (the canvas tab, in Split View or in front). A plain `canvas_open` (a new
  canvas opens in a background tab; an update re-renders an open tab where it is) and
  `canvas_gallery` (not a conversation's tab) do not. The host reports the tab id with the tool's
  answer and it goes through the same `onTabUsed` path, never `{ opened }`: a canvas tab already
  joined the group through `openCanvasTab`. A **canvas push** (Send to agent / 💬 Ask agent / Send
  error) makes the pushing canvas tab the working tab too: the user is working there.
- **Re-validated before use** (`CanvasTabs.pickWorkingTab`): the tab with that id, if it still
  exists and shows the same origin (the user or agent may have navigated it); else, after a browser
  restart (tab ids are reused), an open tab with exactly that URL; else none.
- **Q6:** when the user presses send (the composer; not an ask-card answer or a canvas push, where
  the user is looking at the card or the canvas on purpose) and the active tab of the panel's window
  is not that conversation's working tab, Katashiro activates the working tab at that moment, never
  during the turn. A working tab in another window is not pulled forward (that would move the
  user to another window on every send); the agent can still `switch_tab` to it.
- `switch_tab` gains `tab: "working"` (an error when there is none).

### 4.4 A conversation's tabs come back with it (Brett 2026-10-12 18:28)

- **Tracked:** `conv:<id>.groupTabs` = the URLs of the group's tabs, in tab order: canvas tabs
  (`canvas.html?id=…`, not compare tabs) and http(s)/file pages; a blank or `chrome://` tab is not
  kept. Rewritten (debounced) when a tab is created, updated (URL, group), moved between windows or
  removed, and when it leaves the group. A tab removed because its window is closing
  (`isWindowClosing`, also the browser quitting) does not change the list, so the list survives
  the shutdown it is for.
- **Coming back** = a browser-restart adoption (§3.7) or 重新打開 from the gallery (§3.4). Then every
  URL of `groupTabs` is opened in the panel's window, in the conversation's group, **in the
  background** — except that a tab already showing that exact URL (Chrome restored it, or the user
  has it open) is adopted into the group instead of opened twice: not pinned, not in a split, not in
  another open conversation's group. If all adopted tabs sit in one group (Chrome's restored copy of
  this group), that group is reused. A conversation whose group still exists (a panel reload, a plain
  switch) is not "coming back" and opens nothing. Then §4.2 runs for the current conversation (its
  group expanded; no group collapsed).
- A group whose tabs the user closed one by one ends with an empty list, so nothing comes back.

### 4.5 Archive closes the group's tabs (Brett 2026-10-12 18:31)

- **×** (§3.4) closes the tabs in the conversation's group after saving `groupTabs`; they come back
  by §4.4 when it is reopened. Canvas content is not touched (closing a tab is not deleting).
- **Never a tab with unsaved canvas edits.** Each canvas tab of the group is asked whether its editor
  is dirty (`katashiro-canvas-dirty`, answered only by that tab); a tab that says dirty, or does not
  answer in time, stays open (in its group, collapsed) and the chat says how many were kept and why. A
  save still in flight counts as dirty (the editor has already reported clean).
- **Web pages are closed without asking — deliberate.** A page in the group (a form or document the
  agent opened with `new_tab`) is closed by `tabs.remove`, which skips its `beforeunload` prompt, so
  text typed into it and not submitted is lost. Its URL comes back by §4.4, its unsent input does not.
  Accepted for P1b: asking every page would need a content script in each, and the user archives a
  conversation they are done with. Revisit if it bites.
- The window never loses its last tab: if every tab of the window would close, a New Tab page is
  opened first (closing a window's last tab closes the window and its panel).
- Only a panel that has the conversation open closes its tabs. The picker archiving a conversation
  that no panel holds (its window's panel is closed, §3.11) changes the records only; its group's
  tabs stay until the user closes them (accepted for P1b: no panel is there to ask the canvas tabs).

### 4.6 `set_title` (moved up from P4, Brett 2026-10-12 18:30)

- `katashiro.set_title({ title })` names **the calling conversation** (the tunnel names it, §3.9).
  Sanitised like a typed name (`ConfirmCore.plainText`, whitespace collapsed, ≤ 80 code points);
  empty after that is an error. Sets `titleSource: "agent"`.
- **A user title always wins:** with `titleSource: "user"` the call changes nothing and tells the
  agent so. An auto title (and an earlier agent title) may be replaced. An agent title is not
  replaced by the auto title of a later user message; renaming to an empty name returns to the auto
  title, as before.
- The tool description (and README) say when: after the first exchange, once the topic is clear;
  not on every turn. Not a page action, so act mode does
  not gate it.

### 4.7 Q12 — a card waiting where the user is not

- An `ask_user` card (or a 🔒 confirm card) pending in a conversation that is not on screen marks
  its tab-strip tab **❓**, and leaving a conversation that has one raises a Chrome notification
  (the `notify` path; id prefix of the panel's window, so only this panel claims the click).
  Clicking the notification focuses the window and switches to that conversation. In P1b this
  happens only when the user switches away while a card waits (turns run only on screen), and a 🔒
  card cannot (no switch while a turn runs); P2 makes it common.

### 4.8 The P1a leftovers (2026-10-12 18:3x: #128 review + live test)

1. **A composer draft per conversation** (Brett 18:31): the typed text and the staged images and
   files are kept per open conversation, saved on a switch and restored when it is current again
   (memory only, like the staged attachments themselves). A paste still encoding during a switch
   lands in the conversation it was pasted in.
2. **Canvas push, accurate refusals.** A push whose conversation no panel holds is answered by the
   panel of the canvas tab's window from the records, not always "已封存": open in another live
   window whose panel is closed → `這段對話開在另一個視窗，那個視窗的側邊欄沒開：到那個視窗打開側邊欄再送`
   (with the window); archived or only in a closed window's record → the §3.10 text.
3. **Canvas push with no panel in the canvas tab's window** used to get no visible answer. Now the
   canvas tab says `這個視窗的 Katashiro 側邊欄沒開` with **打開側邊欄** (`chrome.sidePanel.open` in
   that click, a fresh user gesture), keeping the note so the user sends again. A push answered by a
   panel in another window says so (`（在另一個視窗）`).
4. **No free slot → empty record** (§3.11 implementation note): a window that loaded with no slot
   writes `{open: []}` and never adopts an orphan later. Accepted (Jellyfish, #128 review).
5. **Q4 b supersede** was reported broken (two cards stayed answerable after a typed message). It was
   not: the message was sent before the cards existed (§3.8). The rule stays; regression tests pin
   both orders.

## 5. P2 — background turns

- The `Conn` keeps the per-conversation states of §3.5 and lets any of them run a turn; a switch no
  longer waits. `session/update` and responses are routed by `sessionId`, tool calls by tunnel.
- **Concurrency** is the open count, 3 (Q7). The pool is shared with Discord and usercron, so a turn
  that fails with "pool exhausted" shows an error with 重試 on that conversation and is never retried
  automatically. `-32001 Session busy` cannot happen while Katashiro keeps one turn per conversation.
- **Tab strip marks**: ⏳ replying (with ⏹), ● new reply, ❓ a card waiting. **Q9:** a background turn
  that finishes raises a Chrome notification.
- **Tools (Q8)**: a background conversation may act only on tabs of its own group; a call that targets
  the tab the user is on, or another conversation's tab, returns an error telling the agent to use a
  tab of its own group. While the user is on one of that conversation's tabs, its writes are refused
  the same way.
- **Cards**: confirm cards in a background conversation keep their 2-minute wall-clock timeout; the
  Q12 mark and notification are what give the user the chance to answer. The 2 minutes cannot simply
  be raised: a 🔒 card holds the agent's tool call open, and one tool call is capped at 170 s by the
  tunnel. Revisit after live use.
- **Stop** in the tab strip sends `session/cancel`; a conversation counts as running until its
  `session/prompt` settles, not from the click (§1.2).
- Limits that still apply: one tool call ≤ 170 s (tunnel), 180 s agent idle ceiling, turn idle 10 min,
  turn cap 35 min. The panel must stay open: closing it ends every background turn (P3).
- Before starting: a two-session test client that streams on both sessions at once and calls tools
  on both tunnels (the code read in §1.2 is not a live test). Done: #135 / #137, run against the live
  gateway 2026-10-13 00:08 TPE, all pass.

### 5.1 Implementation, part 1 (2026-10-13)

P2 ships in two PRs. The first makes turns run in the background; the second opens a background
conversation's own tabs to it (Q8).

- **Rendering follows the session.** `session/update` goes to the state its `sessionId` names; the
  bubble, tool pills, cards, images and the final record go to that conversation's list and
  `conv:<id>.messages`, shown or not (`inConv` / `outList` / `targetConv` in `sidepanel.js`; a list
  never shown is built hidden from its records on first write). An update for a conversation with no
  turn running is dropped and logged (a stopped turn's agent may keep going, §1.2): no bubble that no
  turn would finalize.
- **Switching and ＋ are never refused.** Archiving still is while that conversation replies or has
  prompts queued on a live connection (`ConvCore.archiveBlocked`, `回覆中不能封存——…`). A canvas push
  and 📨 To chat input always switch.
- **Tab strip:** one mark per tab, `ConvCore.tabMark`: ❓ a card waiting (not on screen) > ⏳ replying
  > ● something arrived while it was not on screen (cleared when shown). While a conversation replies
  its × is ⏹ and stops only its turn (`session/cancel` for that session). The stop button under the
  input follows the conversation on screen.
- **Q9:** a background turn that finishes (or fails) raises a notification, same id scheme as Q12, so
  the click focuses the window and switches to it. A turn the user stopped raises none.
- **Cards** asked in a background turn go into that turn in its list: ❓ and a notification at once
  (not only on leaving, §4.7). An ask card's clock counts visible time (Q1); a 🔒 card keeps its
  wall-clock 2 minutes.
- **Pool exhausted** is said as such (`ConvCore.promptFailureText`) with 重試, never retried by itself.
  openab does not fail `session/prompt` on a full pool: `dispatch.rs` sends `⚠️ ` +
  `format_user_error(e)` (`error_display.rs`: "**Service Busy**\nAll agent sessions are in use…") as
  chat text and the turn ends `end_turn`. A reply that is exactly that line
  (`ConvCore.isPoolBusyReply`) is taken as the refusal: not recorded, not relayed, the host line stays
  pending, error notification if in the background (review: Jellyfish, #143).
- **Reconnect:** the handshake resumes the conversation on screen and every other one with prompts
  queued, so a background turn a dropped socket re-queued is re-sent there too.
- **Tools, until part 2:** a conversation not on screen may call the tools that touch no tab the user
  sees and bring nothing to the front (part 1's `BACKGROUND_TOOLS`: `client_info`, `chat_history`,
  `set_title`, `notify`, `ask_user`, `show_image`, `tabs`, `tab_groups`, `canvas_open` without
  `beside`, `canvas_read`, `canvas_patch`, `canvas_delete`, `canvas_list`). Every other tool is refused
  with a text that lists those. This replaces §3.9's "every call refused when not on screen".
  Superseded by part 2 (§5.2).
- **Agent relays** (ambient mode) stay within the conversation the reply was in.

### 5.2 Implementation, part 2: Q8 (2026-10-13)

Brett 2026-10-13 12:02 TPE: **a background conversation's screenshot is always refused**; its other
page tools act on its own working tab without bringing it forward.

- **Page tools** of a conversation not on screen run on its **working tab** (§4.3), not on the active
  tab, through injected scripts that need no focus. The host checks the tab first
  (`backgroundTabFor` → `ConvCore.backgroundTabRefusal`):
  - it must be in the conversation's own tab group (a tab dragged out is the user's again, §4.1);
  - it must not be a tab the user is on: the active tab of **every** window (an unfocused window on
    another screen is still seen; review #144);
  - a **write** is refused while the user is on any tab of that group (they are looking at this
    conversation's work); reading still works.
  No working tab in the group → an error that says to open one with `new_tab` or pick one with
  `switch_tab`. The check runs before the tool; the user may step onto the tab in between (TOCTOU).
  Accepted: the window is one tool call, and the next call is checked again.
- **Safeguard for a group the user collapsed by hand.** Katashiro never collapses a conversation's
  group (Q5, §4.2), but the user can. Chrome freezes the pages of a collapsed group
  (`CreateFreezingVote(kCollapsedGroup)` per tab, then performance manager's freezing policy), and a
  frozen page runs no timers, SPA updates or injected scripts, so `wait_for`, `click` or even
  `read_dom` could stall (review #144, Jellyfish). So a background conversation's tab and page tools
  expand its group before acting: the tab check expands the group of the tab it allows
  (`expandGroup`: no tab moves, nothing is activated), and `new_tab` expands the group it joined.
  The user sees such a group open by itself. Real-Chrome check: collapse a group, let it freeze, then run
  `snapshot` / `click` / `navigate` / `wait_for` on one of its tabs from the background.
- **`screenshot` is refused**: `captureVisibleTab` captures only the tab in front, so it would have to
  take the user's screen. `callBrowserTool` also refuses it (and any `ownCanvas` tool) whenever the
  host passes `backgroundTab`, a second line behind `refuse`.
- **Tab tools in the background:**
  - `new_tab` always opens in the background (even with `active: true`), joins the group (expanded,
    above) and becomes the working tab; the host bookkeeping is awaited, so the next page tool finds
    it. If the tab could not join the group, the result says page tools cannot act on it (and no
    snapshot is taken).
  - `switch_tab` **selects** one of the group's tabs as the working tab: nothing is activated or
    focused.
  - `close_tab` closes one of the group's tabs, named by `index` or `url` (never "the active tab"),
    never the user's.
  - `tabs` and `tab_groups` list. `reopen_tab`, `tab_update`, groups and splits are refused.
- Still refused: canvas tools that show a canvas (`canvas_goto`, `canvas_highlight`, `canvas_view`,
  `canvas_gallery`, `canvas_open` with `beside`). `BrowserMcp.backgroundRefusal` holds the
  per-tool rule; the per-tab rule is the host's.

## 6. P3 — the connection outside the panel (Q10 open)

Moving the socket into an offscreen document (or the service worker) so background turns survive a
closed panel is [ACP connection ownership](./acp-connection-ownership.md) option B/C. Decided after P2
has been used; that ADR stays Proposed until then.

## 7. P4 — extras

- **Mirror folder `<7-char short id>-<title slug>`** (Brett 2026-10-11; moved up by Brett
  2026-10-12 21:39, implemented with #101). Details in [canvas](./canvas.md) §3.6:
  - The folder follows the conversation's title, whoever set it (auto, user, `set_title`); untitled
    → the short id alone. The mirror reads the title from `conv:index` and never writes it.
  - A rename moves each canvas's files one by one with `FileSystemFileHandle.move()` into the new
    folder (a directory cannot be renamed), and the old folder is removed once empty; files
    Katashiro does not know stay, and so does the old folder then. `move()` overwrites an existing
    target, so a same-name target is a conflict: that file is not moved. No `move()`, or it fails →
    the pre-#101 write-new + delete-if-ours. A move cut short is recorded in `meta.file.move` and
    finished by the next sync.
  - Existing `c_<id>` folders are migrated the same way, canvas by canvas, at the next sync (the
    panel's catch-up on start).
  - **Titles settle first:** a title change moves nothing by itself; the panel syncs a
    conversation's canvases once its title has not changed for 10 s, so auto title → `set_title` →
    a user rename in quick succession is one move. A canvas saved meanwhile moves at once with its
    save (its siblings follow when the title settles).
- Upstream openab `session/close`, so archiving frees a pool slot at once.
- From a canvas to its conversation: **built (Brett 2026-10-19 18:13 TPE): §7.2.**
- Deleting a conversation: its messages, canvases with their history and images (canvas §3.6).
  **Brought forward and built (Brett 2026-10-12 21:39 TPE): §7.1.**
- Several agents in one conversation. (One agent **per** conversation, several at once in a panel:
  [agent per conversation](./agent-per-conversation.md), 2026-10-16.)
- Searching conversation content, if the 3-tab model turns out to need it.

### 7.1 Deleting a conversation (Brett 2026-10-12 21:39 TPE)

Archive (§3.4) never deletes; this is the only way a conversation with content leaves storage.

- **Where: 🗑 刪除 on a row of the gallery's 對話 section**, i.e. a conversation **not open in any
  live window** (archived, or left in a closed window's record, §3.3). **An open conversation is
  archived first** (× on its tab), then deleted from the gallery. Why not delete an open one
  directly: × already does every panel-side teardown — refused while it replies, its ask cards
  close as `archived`, its MCP server and tunnels go, its Web Lock is released, its group's tabs
  close but never a canvas tab with unsaved edits (§3.4, §4.5) — so delete never tears down live
  state and keeps no second copy of those rules to drift; the two steps also make a delete hard to
  do by accident. No tab-strip entry, for the same reason.
- **The user's decision only.** No agent tool, as for archive. The gallery is an extension page the
  page tools cannot click (canvas §3.11: screenshot only), so an agent that opened it cannot press 🗑.
- **Confirm: a system dialog in the gallery tab** (`window.confirm`, as the gallery's canvas 🗑). It
  blocks only that tab, not the side panel, so #80's reason for the confirm card does not apply. The
  text (`ConvCore.deleteConfirmText`; every agent-written string flattened to one line) names the
  conversation and says what goes: **N 則訊息**; **M 個畫布 with their V stored versions and their
  images** (an image another canvas still uses is kept); its agent sessions — Katashiro's record
  only: there is no `session/close` (§1.2), so nothing is sent and the broker session ages out;
  that **files in the canvas folder stay** (when any of its canvases was mirrored; canvas §3.6
  "deleting or evicting a canvas leaves its files"); and **無法復原**. The counts come from a fresh
  read when 🗑 is clicked (`CanvasGalleryCore.conversationDeleteSummary` over the canvas metas).
- **Lock.** After 確定 the gallery takes the conversation's Web Lock `conv:<id>` with `ifAvailable`
  and holds it for the whole delete, so no panel can open it meanwhile (panels open with
  `ifAvailable` too, §3.6). Lock not available, or the id in a live window's record by then
  (reopened between the render and the click) → **refused**, nothing deleted:
  `這段對話開在另一個視窗：先在那裡封存再刪除`, with **前往那個視窗**, which focuses the window
  `ConvCore.windowHolding` names when it is live (the panel holding the lock lists the id in its
  window's record; a closed window's record names no window to focus, so then there is no button).
  A panel that fails to take `conv:<id>` while no other live window lists it (a delete holds it,
  before its mark is down) says `這段對話正在別處處理中（可能正在刪除）：稍後再試`, with no button.
- **Re-check after 確定.** The dialog can stay open indefinitely, so what it showed is captured at
  the click (`ConvCore.deleteSnapshot`: the index entry's `lastMessageAt`, the message count, each
  canvas's id, version and time) and read again once the lock is held, before anything is written.
  Different → **refused**, nothing deleted: `這段對話在確認期間有變動：再按一次 🗑，看過新的內容再確認`;
  no index entry (or already marked: another gallery tab deleted it) → `找不到這段對話`.
- **Steps** (`ConvStore.deleteConversation`), under `conv:<id>`:
  1. Under `conv:windows` → `conv:index`, in **one `set()`**: remove the id from every window record
     that still lists it (closed windows', `withClosed`) and mark its index entry **`deletingAt`**.
     From here the gallery no longer lists it, and a reopen (`katashiro-conv-open` from a stale
     gallery tab) is refused with `這段對話已經刪除了` — as is a reopen of an id with no index entry,
     which used to be recreated as an empty conversation.
  2. **Canvases**: every canvas whose meta names the conversation (an entry left in
     `canvas:<id>:index` with no meta has nothing to remove; the index key goes in step 3), through
     `CanvasStore.remove` (meta, latest, every `v:<n>`, the legacy
     `agent` copy, the index entry — the canvas 🗑's path), then **one** image sweep (canvas §3.6:
     images no remaining version references go; one written in the last 10 minutes waits for a later
     sweep). Their open canvas tabs close themselves, except one holding unsaved edits, which stays
     to be copied out (the canvas delete rule).
  3. `conv:<id>` (messages, sessions, working tab, group tab list) and `canvas:<id>:index`; the group
     record `katashiro.canvasGroup.<id>` in `storage.session` (best effort).
  4. **Last**, the index entry, only if it still carries `deletingAt`.
- **Interruption-safe and idempotent.** `deletingAt` is the "being deleted" record and goes last.
  Every start — the service worker's `onInstalled` / `onStartup`, a panel's load (after the
  migration) and the gallery's load — runs `finishDeletions()`: each entry with `deletingAt` whose
  `conv:<id>` lock is free (held = a delete is running elsewhere) goes through steps 1–4 again. A
  step that is already done finds nothing to do. A failure in step 2 or 3 leaves the mark, so the
  next start retries; the gallery says the delete did not finish.
- **Tabs left behind.** × closed the group's tabs already, except canvas tabs with unsaved edits
  (above) and, after a picker archive with no panel (§4.5), the group's web pages: those stay open
  (Katashiro cannot ask them about unsaved input), and Chrome's group stays until the user closes
  it; Katashiro forgets it.
- **Mirror folder.** Nothing is deleted on disk: the conversation's folder and files stay (the
  user's copy, maybe under git).

---

### 7.2 From a canvas to its conversation (Brett 2026-10-19 18:13 TPE)

A canvas belongs to one conversation (`meta.conversationId`), and the gallery opens any canvas —
also one whose conversation is archived, as an ungrouped tab (§3.4). Until now nothing led from
there back to the conversation: the gallery's 對話 column was a label, and the canvas tab's pushes
were refused with "已封存" and no way forward. Brett chose all three entry points:

- **Canvas tab header: 🗨️ `<conversation title>`** (title from `conv:index`, followed live; cut
  short with an ellipsis; icon only in a narrow tab). Not in a compare tab.
- **Gallery canvas row: 🗨️** beside 🗑, for that row's conversation.
- **The "已封存" refusal** of 📤 Send to agent / 💬 Ask agent / 📨 To chat input / its Enter
  (§3.10) gets a **重新打開對話** button; once the conversation is open the canvas tab says to try
  again (the note or selection is kept, as for 打開側邊欄, §4.8 3).

All three go the way of the gallery's 重新打開 (§3.4): `chrome.sidePanel.open` for the sender's
window in the click, the request left in `storage.session` for a panel still loading, and
`katashiro-conv-open { id, windowId, reqId, canvasId? }` (one helper, `CanvasTabs.requestConvOpen`).
The panel's `reopenConversation` already covers every case: open in this panel → switched to;
archived → reopened (its group's tabs come back, §4.4); 3 open → the archive picker; open in another
live window → refused with that window's id, and the canvas tab or gallery offers **前往那個視窗**;
deleted → refused (§7.1).

`katashiro-conv-open` is now accepted from `canvas.html` too (never a compare tab), with two rules
for it:

- **Its own conversation only.** A canvas tab sends `canvasId`; the panel reads that canvas's meta
  and refuses (`這個畫布不屬於那段對話`) unless its `conversationId` is the one asked for — the same
  for a request picked up from `storage.session`. A canvas tab cannot open other conversations.
- **The window is the tab's own** (`sender.tab.windowId`), not the message's `windowId`.

Once the conversation is open in this panel and its group's tabs are back, the canvas tab that asked
joins the conversation's group if it is in no group (the ungrouped tab the gallery opened while the
conversation was archived). Not before: `restoreGroupTabs` would otherwise make a second group.

## 8. Alternatives considered

- **A separate conversation list view** (like Settings, with search). Rejected by Q4: a tab strip of at
  most 3 matches the pool and needs no list; archived ones are found in the gallery.
- **U1: one ACP session shared by all conversations.** No resume problem, but topics mix in the
  agent's context. Rejected (Brett 2026-10-10).
- **Pure U2: a fresh session on every switch, replayed from `chat_history`.** Shallow context and a
  new pool slot each time. Rejected; kept only as the fallback (§3.5).
- **Guessing a lost session from a changed session id.** Does not work: the gateway resumes any id
  and the broker recreates the agent session under the same id (§1.2).
- **Deleting on ×.** Rejected for archive (Q11): closing a tab must not lose a conversation.
- **Deleting an open conversation from the tab strip** (or the panel's chat). Would need its own
  copy of archive's teardown (turn guard, cards, MCP server, lock, tabs with unsaved edits) in a
  destructive path. Rejected for "archive, then 🗑 in the gallery" (§7.1).
- **One MCP server instance per agent, as today.** A late tool call from a conversation the user
  left would act on the current one's canvases and cards. Rejected for one per conversation (§3.9).
- **Re-render the chat from storage on every switch.** Loses memory-only cards and the stream that P2
  needs. Rejected for one list element per open conversation.

## 9. Consequences

- Topics stay apart, each with its own agent session, canvases and later tab group; returning to one
  restores the agent's memory when the broker still has it and gives it a recovery path when not.
- The storage layout changes once, with no way back for older versions; canvases and message ids are
  untouched.
- Archived conversations accumulate in storage (≤ 200 messages each, plus canvases under the existing
  200 MB budget) until the user deletes them from the gallery (§7.1).
- The host line after a reconnect costs one line in some prompts, in exchange for not depending on an
  openab signal that does not exist yet.
- Testability: migration, adoption of `window:` records, the open-set rules (≤ 3, which can be
  archived, lock outcomes), auto titles and the switch guard are pure functions in `room-core.js` (or
  a new `conv-core.js`) with unit tests; tab strip, locks across windows and the gallery section need
  a live check in Chrome.
