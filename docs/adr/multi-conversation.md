# ADR: Multi-conversation — several conversations in one side panel

- **Status:** Accepted 2026-10-12 (Brett; Q1–Q9, Q11, Q12 at 16:30–16:34 TPE, archive + gallery
  reopen and "write the ADR + build the MVP" at 16:39 TPE; P1b additions at 18:28–18:31 TPE, §4).
  **Q10 (P3) open** (§7).
- **Date:** 2026-10-12
- **Author:** Brett Chien (drafted by Orca)
- **Related:** [single-active agent](./single-active-agent.md) (unchanged through P3);
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
| **P1b** | one Chrome tab group per conversation: its canvases **and the tabs the agent opened**; collapse the other groups on switch; working tab, and switching to it when the user sends (Q6); a card waiting in another conversation → tab-strip mark + notification (Q12); a conversation that comes back reopens its group's tabs; archive closes them; agent `set_title`; a composer draft per conversation; the P1a leftovers (§4) | background turns |
| **P2** | background turns: one session state per conversation on the same connection; ⏳ / ● / ❓ on the tab strip; completion notification (Q9); background writes only on the conversation's own tabs (Q8); pool exhausted handled (§5) | panel closed |
| **P3** | the connection leaves the side panel (offscreen document); **Q10 open**, decided after P2 is tried (§6) | — |
| **P4** | mirror folder rename by per-file `move()` (#101); upstream `session/close`; deleting a conversation; several agents per conversation (§7) | — |

Brett's answers (2026-10-12, on `ask_user` cards; the design canvas `cv_beec3be8efac` holds the
discussion):

| # | Phase | Question | Decision |
|---|---|---|---|
| Q1 | MVP | Which "last message" time does a tab show? | Any message, the agent's replies included (16:31) |
| Q2 | MVP | One conversation open in two windows? | Forbidden: Web Lock, and say which window has it (16:31) |
| Q3 | MVP | After a browser restart | Back to the last conversation (16:31) |
| Q4 | MVP | Where is the conversation list? | Only a tab strip at the top of the panel, at most 3 conversations (16:30) |
| Q5 | P1b | Other conversations' tab groups on switch | Collapse them (16:32) |
| Q6 | P1b | Sending while the active tab is not the working tab | Switch to the working tab, only at the moment the user sends, never mid-turn (16:32) |
| Q7 | P2 | Background concurrency | 3, from Q4; the pool is shared, so pool exhausted must be handled |
| Q8 | P2 | A background conversation touches the tab the user is on | Error; the agent uses a tab of its own group (16:33) |
| Q9 | P2 | A background turn finishes | Chrome notification + tab-strip mark (16:33) |
| Q10 | P3 | Keep running with the panel closed? | **Open**, after P2 is tried |
| Q11 | MVP | A 4th conversation: what happens to the one closed? | Archived, reopenable (16:34); reopened from the gallery (16:39) |
| Q12 | P1b | An `ask_user` / 🔒 card in a conversation not on screen | Tab-strip mark + Chrome notification (16:34) |

The single-active-agent model stays: one connection, one agent per panel through P3. What changes is
which session (and later, sessions) that connection serves.

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
  label in the gallery's canvas rows. The mirror folder keeps its `c_<id>` slug until P4.
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
  `katashiro-conv-open { id }` (accepted only from `canvas-gallery.html`, like `katashiro-canvas-open`)
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
  first prompt carries it again. When `session/resume` itself
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
  `這段對話已封存，先從總覽重新打開`. P1b makes the other refusals say what is really the case
  (§4.8).

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

Background turns; agent-opened tabs in the conversation's group; collapsing groups on switch; the
working tab; marks and notifications for other conversations; agent `set_title`; per-conversation
drafts; reopening and closing a group's tabs (all P1b, §4); mirror folder names; deleting a
conversation; search over conversation content.

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

### 4.2 Collapse on switch (Q5)

- On a switch, in the panel's window: if the active tab is in a group of another open conversation,
  first activate a tab outside it — the new conversation's working tab (§4.3) if it is in this
  window, else its group's most recently used tab, else the most recently used tab in no
  conversation's group (canvas §3.1); then collapse the other open conversations' groups and expand
  the new one's. If every tab of the window is in those groups, nothing is collapsed (Chrome would
  have nowhere to put the focus). Best effort: a Chrome refusal ("tabs cannot be edited right now"
  while the user drags) leaves the groups as they are.
- The rule is a pure plan (`CanvasTabs.planGroupSwitch`); the panel only makes the calls.

### 4.3 Working tab (Q6)

- Each conversation records the **last tab its agent acted on**: every page tool (it resolves the
  active tab), `new_tab` (the tab it opened) and `switch_tab` (the tab it switched to).
  `conv:<id>.workingTab = { id, url, at }`, the URL as it is after the call.
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
  switch) is not "coming back" and opens nothing. Then §4.2 collapses the groups that are not
  current.
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
  on both tunnels (the code read in §1.2 is not a live test).

## 6. P3 — the connection outside the panel (Q10 open)

Moving the socket into an offscreen document (or the service worker) so background turns survive a
closed panel is [ACP connection ownership](./acp-connection-ownership.md) option B/C. Decided after P2
has been used; that ADR stays Proposed until then.

## 7. P4 — extras

- Mirror folder `<7-char short id>-<title slug>` (Brett 2026-10-11); a rename moves files one by one
  with `FileSystemFileHandle.move()` (#101; a directory cannot be renamed, and `move()` overwrites an
  existing target, so a same-name target is handled as a conflict).
- Upstream openab `session/close`, so archiving frees a pool slot at once.
- Deleting a conversation: its messages, canvases with their history and images (canvas §3.6).
- Several agents in one conversation (lifts single-active for a conversation).
- Searching conversation content, if the 3-tab model turns out to need it.

---

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
  200 MB budget) until deletion lands in P4.
- The host line after a reconnect costs one line in some prompts, in exchange for not depending on an
  openab signal that does not exist yet.
- Testability: migration, adoption of `window:` records, the open-set rules (≤ 3, which can be
  archived, lock outcomes), auto titles and the switch guard are pure functions in `room-core.js` (or
  a new `conv-core.js`) with unit tests; tab strip, locks across windows and the gallery section need
  a live check in Chrome.
