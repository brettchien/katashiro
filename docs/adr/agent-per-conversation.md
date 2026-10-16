# ADR: An agent per conversation — several agents at once, one per conversation

- **Status:** Proposed 2026-10-16 (Brett: the goal "A uses X, B uses Y, both running at once" at
  17:08 TPE; Q1–Q4 on `ask_user` cards 17:10–17:11 TPE)
- **Date:** 2026-10-16
- **Author:** Brett Chien (drafted by Orca)
- **Supersedes:** [single-active agent](./single-active-agent.md) §2.1–§2.3 (one active agent per
  panel, chips as the agent switch). Its §2.4 setup name field stays.
- **Related:** [multi-conversation](./multi-conversation.md) §2 ("single-active stays through P3",
  lifted here), §3.5 (sessions per conversation), §5 (P2 background turns, which this builds on),
  §3.8 (cards: `disconnected`); [browser-tunnel liveness](./browser-tunnel-liveness.md) §8 (the
  three-segment chip).

---

## 1. Context

With several agents configured, the panel connects only the one marked active (`activeAgentUrl`,
single-active ADR) and **every open conversation talks to it**. Making another agent active
disconnects the first and moves every conversation over. So two conversations side by side, one with
Orca and one with Falcon, cannot exist, let alone run at once.

Most of the machinery is already there:

- `Conn` is one agent's socket and holds **one `SessionState` per conversation** (multi-conversation
  §3.5); `conv:<id>.sessions` is already keyed by agent URL.
- P2 (§5, #143/#144) lets every open conversation run a turn at the same time; updates are routed by
  `sessionId`, tool calls by tunnel, tabs by the conversation's own group (Q8).
- The room code (`buildRoom` builds a `Conn` per configured agent) was gated off, not removed, so
  several connected `Conn`s is a state the code once had.

What is missing is (a) a conversation knowing **its** agent, and (b) more than one `Conn` connected.

## 2. Decision

**Each conversation is bound to one agent, chosen when it is created, for its whole life. The panel
connects every agent that an open conversation uses, and only those.** There is no "active agent"
any more.

Brett's answers (2026-10-16, `ask_user` cards):

| # | Question | Decision |
|---|---|---|
| Q1 | How is a conversation's agent decided? | Picked at ＋, **never changed** afterwards (17:10) |
| Q2 | Which agents connect? | **Only those an open conversation uses**; the last one closed → disconnect (17:10) |
| Q3 | How is the agent picked at ＋? | **A picker every time** ＋ is pressed (17:11). One agent configured → no picker |
| Q4 | How does the user see a conversation's agent? | **Tabs unmarked; the chip shows the on-screen conversation's agent only** (17:11) |

### 2.1 Model and storage

- `conv:index[id].agentUrl` and `conv:<id>.agentUrl`: the conversation's agent, **written once at
  creation**, never rewritten except by §2.6 (URL edit). The index copy lets the gallery and the
  tab strip know it without loading each conversation.
- `conv:<id>.sessions` stays a map (`{ <agentUrl>: <acpSessionId> }`); in practice it holds one key.
  Not narrowed to a single value, so §2.6 and old records need no second shape.
- `activeAgentUrl` leaves the config (`CONFIG_KEYS`). It is read once more, for the migration.
- **Agent identity stays the URL** (`Conn.id = agent.url`, as today). A separate agent id was
  considered (§3); the URL is what every existing record is keyed by.

### 2.2 Migration (one time, on the first start of this build)

Every conversation in `conv:index` without `agentUrl` gets the old `activeAgentUrl` (resolved with
`RoomCore.resolveActiveUrl`, so a missing or stale value falls to the first agent). Same shape as the
P1a migration: write the new field, then drop `activeAgentUrl`; an interrupted run is finished by the
next start, because "has no `agentUrl`" is the trigger. Nothing else moves: the sessions map already
holds that agent's session.

A record without `agentUrl` met later (cannot happen after the migration; defensive) is treated as
the first configured agent and written back.

### 2.3 Connections (Q2)

- **Wanted set** = the distinct `agentUrl`s of the conversations open in this window's tab strip
  (≤ 3, the open-conversation cap, so ≤ 3 sockets per window). `syncConnections()` connects every
  wanted `Conn` that is not connected and disconnects every connected one that is not wanted. It
  replaces `connectAll()` / `setActiveAgent()` and runs after: start-up, ＋, archive, reopen from the
  gallery, delete, and any Settings change to the agent list.
- A `Conn` is disconnected only when **no** open conversation uses it. Archive is already refused
  while that conversation replies or has prompts queued (§3.4 / P2 §5.1), so the last conversation
  of an agent cannot go while a turn of it runs.
- Each window's panel has its own `Conn`s, as today: two windows with Orca conversations open two
  Orca sockets. Pool use is per session, not per socket, so this is unchanged.
- `Conn.enabled` keeps its meaning (should this conn be up?) and becomes "is it in the wanted set";
  a dormant agent renders 已停用 as before, though no chip shows it any more (§2.5).

### 2.4 ＋ and the agent picker (Q1, Q3)

- ＋ with **two or more** agents configured opens a **system card** (the style of the 3-tab archive
  picker, multi-conversation §3.3, not an agent card) listing the agents by name in Settings order,
  each with its link status (🔌 online / offline). Picking one creates the conversation bound to
  it. Cancel (or closing the card) creates nothing.
- **One agent** configured → no picker, the conversation is bound to it.
- With **3 conversations already open**, the existing archive picker comes **after** the agent
  picker: first what the user came for, then what has to give way. Cancelling either creates nothing.
- **Never changed afterwards (Q1).** There is no "switch agent" on a conversation. Talking to another
  agent about the same topic = a new conversation (the user can paste or 📨 what they need).
- Other ways a conversation is created take the agent from where they come from: the P1a migration
  and a browser restart keep their records' agent; the first-run setup binds the first conversation
  to the agent it configures.

### 2.5 Chip and roster (Q4)

- The roster shows **one chip: the on-screen conversation's agent**, with the three-segment status
  (🔌 link · 🚇 tunnel · 🌐 browser); click = reconnect that agent (R2, unchanged). The dimmed
  "點此啟用" chips of dormant agents go away, and with them switching from the chips.
- **Tabs carry no agent mark.** Who a conversation is with shows when it is on screen (chip, the
  agent name on its replies, as today).
- The roster label `N/M agents 上線` becomes the on-screen agent's state only; a background
  conversation whose agent drops shows it when the user switches to it, and its turn fails like any
  dropped turn (P2: error + 重試, ● on its tab).
- Settings: the "設為使用中 ◉" radio goes. Each agent row shows how many open conversations use it
  (`2 段對話使用中`) and its link status.

### 2.6 Settings edits to an agent in use

- **URL edited**: every conversation bound to the old URL — open or archived, via `conv:index` — is
  rebound to the new one (`agentUrl` rewritten; `sessions[old]` dropped, since the new server knows
  none of its sessions). The open ones get `session/new` on the new socket and the U2 host line
  (multi-conversation §3.5) so the agent can read `chat_history`. This is the only rewrite of
  `agentUrl` (§2.1). Cards of that agent close as `disconnected` (§3.8).
- **Token edited / browser access toggled**: reconnect that agent, as today; conversations keep their
  binding and resume their sessions.
- **Agent removed**: Settings first says how many conversations use it (`3 段對話使用這個 agent，
  移除後無法再傳訊息`) and asks to confirm. After it: its socket closes, its cards close as
  `disconnected`, and its conversations stay — open ones show a system line `agent 已移除` and the
  composer is disabled; they can be archived, deleted, read and their canvases used. Archived ones
  reopen read-only the same way. **Adding an agent with the same URL back revives them** (the binding
  is by URL), with their sessions if the server still has them.
- The last agent cannot be removed (today the list falls back to `DEFAULT_AGENT`; unchanged).

### 2.7 What follows the conversation's agent instead of "the active one"

Every `activeAgentUrl` read becomes "the agent of conversation X", with X stated:

| Today | Becomes |
|---|---|
| `roomMembers()` (mention / broadcast / relay targets) | `[agent of the conversation the text is in]` |
| image paste / drop: `active.canImage` | the on-screen conversation's agent (staging is for it) |
| canvas push (📨, `canvas-push`): `connById(activeAgentUrl)` | the agent of `msg.conversationId` |
| `activateSessions()` on switch | each `Conn` opens the sessions of its own open conversations |
| `retryLast` guard "not the active agent → no-op" | "this `Conn` is not this conversation's agent, or not wanted → no-op" |

- **@mentions**: a conversation has one agent, so `@OtherAgent` routes nowhere new: the text goes
  to the conversation's agent as written. The room modes (mention / ambient) and the loop guard stay
  in the code and in Settings for now, but have one member to route to; removing them is not part of
  this change.
- **Act mode stays global** (it is about the browser, not an agent: single-active ADR / `actMode`
  comment). The browser tools' Q8 rules are per conversation already and do not change.

### 2.8 Cards (multi-conversation §3.8)

`restarted` still closes one conversation's cards; `disconnected` — an agent deliberately
disconnected — now happens when that agent's **last open conversation is archived or deleted** (its
own cards are already closed by the archive) or when its URL / token is edited or it is removed
(§2.6), and closes that agent's cards in every conversation, as today. "Another agent made active"
no longer exists as a cause. The 3-pending-card cap stays per agent per conversation.

## 3. Alternatives considered

- **Switch agent on an existing conversation** (Q1, other options). The sessions map would allow it
  (each agent keeps its session, switching back resumes), but the history then mixes two agents that
  each saw only part of it. Rejected by Brett: a conversation is with one agent.
- **Connect every configured agent all the time** (Q2). Simpler (no wanted set), but keeps sockets,
  heartbeats and tunnels up for agents nobody is talking to. Rejected.
- **Default to the last agent, ▾ to change it** (Q3). Fewer clicks for one main agent, but the
  binding is permanent, so a silent default is easy to get wrong. Rejected: a picker every time.
- **Agent name on each tab** (Q4). Rejected: the strip is narrow (3 tabs, titles already truncated).
- **A stable agent id** instead of the URL. Would make a URL edit a plain field change. Rejected for
  now: every record (`sessions`, cards, `Conn.id`) is keyed by URL, and a URL edit is rare; §2.6
  rewrites the bindings instead.
- **Several agents in one conversation** (multi-conversation §7, P4). A different feature: the
  history and turns would interleave agents. Not done here; this ADR keeps one agent per
  conversation, which that one would extend.

## 4. Consequences

- Two (or three) conversations with different agents run at the same time in one panel, each with
  its own socket, session, tunnel, tab group and cards.
- Up to 3 sockets per window instead of 1. Each has its own heartbeat and reconnect backoff
  (browser-tunnel liveness §9.5); a gateway that drops one does not touch the others.
- The single-active ADR's switch (chips, Settings radio) is gone; switching agents is now "open a
  conversation with that agent". Users with one agent configured see no change at all (no picker,
  one chip).
- A removed agent leaves read-only conversations until they are archived / deleted or the agent is
  added back.
- Multi-conversation §2's "single-active stays through P3" no longer holds; P3 (the connection
  outside the panel) has to move up to 3 sockets, not 1.

## 5. Implementation

One PR after this ADR is accepted:

- `conv-core.js`: `agentUrl` in index / record; the migration (§2.2); `wantedAgentUrls(openIds)`;
  rebind on URL edit (§2.6).
- `sidepanel.js`: `syncConnections()` replacing `connectAll` / `setActiveAgent`; the agent picker;
  the one-chip roster; the §2.7 table; Settings changes (§2.5, §2.6); remove `activeAgentUrl`.
- `room-core.js`: `resolveActiveUrl` kept for the migration only.
- Tests: unit tests for the migration, wanted set, rebind; the multi-conversation smoke gets a
  two-agent case (two `FakeGateway` instances, two URLs; e2e/) — two conversations on two agents
  streaming at once, archive the last conversation of one → its socket closes, URL edit → rebind.
- `TESTING.md`: real-Chrome steps for the picker, two agents at once, removing an agent in use.
