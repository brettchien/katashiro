# ADR: Single-active agent + config management

- **Status:** Proposed 2026-08-07
- **Date:** 2026-08-07
- **Author:** Brett Chien
- **Related:** [katashiro multi-agent room](./acp-connection-ownership.md) (the current all-connect model);
  the roster chip / three-segment status ([browser-tunnel liveness §8](./browser-tunnel-liveness.md)).

---

## 1. Context

katashiro is a **multi-agent room**: `buildRoom()` creates a `Conn` for **every** configured agent and
`connectAll()` connects **all** of them at once. Each configured agent is `{ name, url, token,
browserAccess }` in `chrome.storage.local` (key `agents`); a user message is routed per room mode
(@mention → addressed agents, else broadcast) and every connected agent streams its own reply.

Two things prompted this change:

- **The user wants several saved agent configs but only ONE active in chat at a time.** Today there is
  no way to keep an agent configured-but-dormant — every entry in `agents` connects.
- **"The agent name isn't saved."** Investigated and **disproved**: `chrome.storage.local` shows
  `{ browserAccess:true, name:'OpenAB', token:'…' }` — the name **is** persisted (`persist()` writes the
  whole agent object on every add / rename / connect). The real gap is that the **first-run setup screen
  has no name field** and hardcodes `agents = [{ name: "OpenAB", url }]` (`sidepanel.js`), so a
  URL-only setup can never carry a custom name (and saves no token — the user must add it in Settings).

There is already latent plumbing for "not connected on purpose": `Conn.enabled` (user intent) +
`connState` rendering **已停用** when `!enabled`. It just isn't persisted, exposed, or respected by
`connectAll()`.

## 2. Decision

Adopt a **single-active-agent** model. Keep N configs; exactly one is active (connected, in chat) at a
time. The switch lives **both in Settings and on the roster chips**. The multi-agent room code stays but
is gated off (single-active is a special case of it), so multi-agent can be restored later.

### 2.1 State (C1)
Persist `activeAgentUrl` (the id of the one active agent) in `chrome.storage.local` via `persist()`.
Default / migration: the current sole agent (or the first) becomes active — no user action for existing
configs.

### 2.2 Connect only the active agent (C2)
`buildRoom()` still creates a `Conn` per agent (kept index-parallel to `agents` so the Settings list
maps cleanly), but **only the active one is `connect()`-ed**; the rest stay `enabled:false` and render
**已停用** via the existing `connState` path. A single `setActiveAgent(url)` helper does: disconnect the
current active Conn → set `activeAgentUrl` → connect the new one → `persist()`. Routing (mention /
broadcast / relay) already targets connected conns, so with one active it is naturally a single-agent
chat; the relay/mention code is a no-op with one agent and is left intact.

### 2.3 Chips as the agent selector (C3)
Render one chip per configured agent:
- **Active chip** — the full three-segment status (🔌 link · 🚇 tunnel · 🌐 browser); click = R2
  reconnect (unchanged).
- **Inactive chips** — dimmed, a short "點此啟用"; **click = `setActiveAgent(thatUrl)`** (switch).

Selecting one deactivates the others (**radio** behaviour). This is the "switch on the chips" the user
asked for.

### 2.4 Settings: pick-active + a name field (C4)
- Each agent row gets a "設為使用中 ◉" radio → `setActiveAgent`.
- The **first-run setup screen gains a name field** (today: WebSocket URL only); the connect flow saves
  the typed name instead of hardcoding `"OpenAB"`. (A token field on setup is optional — the user can
  still add it in Settings.) The Settings rename already persists; no change needed there.

## 3. Options considered

- **Multi-active subset (per-agent on/off toggle).** More flexible (1..N active), reuses the same
  `enabled` plumbing. **Rejected for now** — the ask is explicitly "only one active"; single-active is
  simpler to reason about and hides the multi-agent surface the user doesn't want yet. Not precluded
  later (the toggle generalises the radio).
- **Switch only in Settings.** Rejected — the user wants it on the chips too (fewer clicks, visible
  where the agent status already is).
- **Rip out the multi-agent room.** Rejected — gate it off instead, so restoring multi-agent is cheap.

## 4. Consequences

- **If adopted:** several agent configs coexist; exactly one connects; switching is one click on a chip
  or a Settings radio; a custom agent name is finally settable at setup (the "name not saved" confusion
  goes away — it was a hardcoded default, not a persistence bug). The multi-agent code is dormant, not
  deleted.
- **Testability:** the selection rule (which agent is active / only-active-connects) is derivable as a
  pure function in `room-core.js` and unit-tested; the chip/Settings wiring is DOM and validated by live
  test.
- **If deferred:** the user keeps every configured agent connecting at once, cannot keep a dormant
  config, and is stuck with the hardcoded "OpenAB" name from the URL-only setup screen.
