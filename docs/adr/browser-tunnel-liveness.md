# ADR: Browser-tunnel liveness — detection, reconnect, and status model

- **Status:** Accepted (all decisions settled 2026-08-06). **Revised 2026-08-06 (§8):** gap (B)
  confirmed real; status model two-badge → **three segments** (link / tunnel / browser); **heartbeat
  reworked** to passive/idle-only/non-destructive after #17 proved actively destabilising (§8.6).
- **Date:** 2026-08-06
- **Author:** Brett Chien (drafted by Orca; §8 revision 2026-08-06)
- **Related:** [ACP connection ownership ADR](./acp-connection-ownership.md) (sibling — connection lifecycle); openab `docs/mcp-over-acp-tunnel-contract.md` (the tunnel protocol this depends on)

---

## 1. Context

The agent runs server-side over the ACP WebSocket; the browser tunnel (MCP-over-ACP) is what lets it
reach the page. In the side panel, each `Conn` tracks the tunnel with a single boolean,
`browserAttached`, driven purely by **events**:

| Event | Source | Effect |
|---|---|---|
| `mcp/connect` (gateway opens the tunnel) | `browser-mcp.js` `handleServerRequest` → `onStatus(true)` | `browserAttached = true` |
| `mcp/disconnect` (last connection retired) | `handleServerRequest` → `onStatus(false)` | `browserAttached = false` |
| WS `onclose` (socket dies) | `sidepanel.js` `Conn` `onclose` → `setBrowserAttached(false)` | `browserAttached = false` |

The roster already **shows** this state per agent — the monkey glyph is the "is the browser on?"
indicator: 🐵 attached + act mode, 🙊 attached + read-only, 🙈 not attached (`sidepanel.js`
`updateRoster`).

So detection and display already exist. This ADR is about making them **reliable**, deciding whether
to **auto-recover**, and fixing a **status-vocabulary** inconsistency the work exposes.

**Scope note — the tunnel and agent turns share one socket.** The browser tunnel (MCP-over-ACP,
gateway → extension) and the agent turns (`session/prompt`, extension → gateway) both ride the **same
per-`Conn` ACP WebSocket**. A half-open socket therefore kills *both* at once: the tunnel goes stale
(problem 2.1) and the next `session/prompt` hangs until it times out (problem 2.3). So the liveness
detection this ADR adds belongs on that shared socket, and fixing it serves both surfaces — the ADR
is named for the tunnel but the mechanism is Conn-level.

## 2. The problems

**2.1 Detection is passive.** `browserAttached` only changes on the three events above. There is no
active liveness check. Two gaps follow:

- **(A) Latency — half-open socket.** If the socket dies without a clean close (half-open TCP, no
  FIN), the browser fires `onclose` only after the OS TCP timeout (can be minutes). Until then the
  monkey shows a stale 🐵/🙊 "on" for a tunnel that is already dead.
- **(B) Silent logical death.** Socket alive, but the tunnel is retired **without** an
  `mcp/disconnect`. Per the tunnel contract (§7, below) a withdrawal *does* send `mcp/disconnect`, so
  this is a contract violation / gateway bug rather than normal operation — but if it happens, the
  extension cannot currently tell.

**2.2 No auto-recovery for a tunnel-only drop.** When the whole socket drops, `Conn` already
auto-reconnects every 5 s and the following `session/resume` re-declares the browser server, so the
tunnel returns on its own. But when the tunnel drops while the socket stays up, nothing re-establishes
it — the user must go to Settings and toggle a switch (the 🔗 browser-access toggle or the
連線/斷線 toggle, both of which force a re-handshake; the act-mode toggle does **not**, by design).

**2.3 Observed symptom — a dead socket surfaces as a prompt timeout that retry can't fix.** Because
the agent turn rides the same socket (scope note above), the first thing a user sees when the socket
half-opens is not the monkey — it's the *turn* failing. Reported 2026-08-06: an error bubble
`回合失敗：request timed out: session/prompt`, and **pressing 重試 did nothing**. Tracing it:

- `session/prompt` has a 10-minute client timeout (`ACP_PROMPT_TIMEOUT_MS`); a half-open socket makes
  the turn hang the full 10 minutes before the client gives up. The error text `request timed out`
  does not match the `/closed|not open/` transient branch, so `Conn.flushQueue`'s `.catch` shows the
  retry bubble instead of re-queuing.
- **Retry re-sends on the *same* connection and never reconnects.** `retryLast()` → `enqueue` →
  `flushQueue`, whose guard requires `ws.readyState === OPEN`. A half-open socket still reports `OPEN`,
  so retry pushes a fresh `session/prompt` into the dead socket → another 10-minute hang. If the
  socket has meanwhile closed, the guard fails and `retryLast` is a silent no-op — while the retry
  button is already `disabled`. Either way: **"retry has no effect."**
- The 10-minute timeout also never invalidates the socket: nothing tears down the (probably dead)
  connection, so it lingers reporting `OPEN`.

This is problem 2.1(A) made visible on the turn layer, plus a gap 2.2 sibling: **no recovery path on
timeout** — retry should reconnect, and a prompt timeout should invalidate the socket, not trust it.

**2.4 Status vocabulary is inconsistent.** Four orthogonal facts are currently squeezed into two
glyph families, with one glyph overloaded:

- **connection** (agent WS up?) → 🔗 linked / ⛓️‍💥 broken
- **allowed** (per-agent browser access config) → the Settings toggle, also **🔗** (開/關)
- **attached** (runtime tunnel present?) → 🐵 / 🙊 / 🙈 (monkey)
- **alive** (tunnel actually responding?) → *does not exist yet*

`🔗` means both "agent connection" and "browser-access toggle", and the browser-access **control**
(🔗) speaks a different vocabulary from the browser **status** (monkey). Adding an `alive` state on
top of this without cleanup makes it worse.

## 3. Findings from the openab tunnel contract

Grounding constraints (from `openabdev/openab` `docs/mcp-over-acp-tunnel-contract.md` and
`crates/openab-gateway/src/adapters/acp_server.rs`, read 2026-08-06):

- **No application-level keepalive/ping** exists in the tunnel contract. Liveness is governed only by
  request timeouts and explicit close.
- **The extension is the MCP _server_ (callee) on the tunnel.** `mcp/message` requests flow
  gateway → extension; the extension only *responds*. There is **no extension-initiated tunnel
  method** — the extension cannot natively "ping" its own tunnel.
- **Clean retirement is signalled.** §7: a resume re-presents the whole declaration set; any server
  absent from it is retired and its connection receives an `mcp/disconnect`. So well-behaved tunnel
  teardown *is* observable.
- **Timeouts:** tunnel request `[mcp] tunnel_timeout_seconds` default **170 s** (ceiling 180 s = ACP
  prompt idle timeout); `mcp/connect` + `initialize` handshake **30 s**.
- **Browser WebSocket JS API exposes no ping/pong.** WS protocol-level ping/pong is handled by the
  browser and is not reachable from extension JS — so a WS-level heartbeat is **not an option** for
  us. Any probe must be an application-level ACP frame.
- **No ACP `ping` method.** ACP methods are `initialize`, `authenticate`, `session/*`. The cheapest
  idempotent round-trip candidate is **`session/list`** (a read, no session mutation) — but note it
  exercises the ACP session/socket, **not** the logical tunnel, and we must verify every agent
  runtime implements it.

**Consequence:** gap **(A)** (dead/half-open socket) is closable client-side with an application-level
probe. Gap **(B)** (socket-alive logical death) is **not** client-detectable without a contract change
— but the contract says it shouldn't happen, so we treat it as out of client scope unless it proves
real in practice.

## 4. Options

### 4.1 Detection

- **D0 — status quo (passive).** Rejected: leaves gap (A)'s stale-on latency.
- **D1 — client-side ACP heartbeat (chosen; mechanism verified in openab 2026-08-06).** Periodically
  send a request-shaped JSON-RPC frame the **gateway answers itself, immediately** — a benign unknown
  method (e.g. `katashiro/ping`) or `session/list`, both of which hit the gateway's default dispatch
  arm and get an instant `-32601` (`acp_server.rs:1841`). A *response of any kind* (even an error)
  proves the socket + gateway are alive; a short-timeout no-response means the socket is dead → mark
  detached and reconnect (§4.2). Why this shape:
  - **Immediate, no agent, no tokens.** It never reaches the agent runtime and costs no model turn.
  - **Not blocked by an in-flight turn.** `session/prompt` is `tokio::spawn`-ed (`acp_server.rs:1814`)
    so the gateway's read loop keeps servicing frames during a turn — the probe is answered even
    mid-prompt. **This dissolves the "false-positive while the agent is legitimately busy" risk**
    (former open discussion #1): the heartbeat need not be restricted to idle.
  - **Cross-runtime.** The gateway answers, not the agent, so it behaves identically whichever CLI is
    attached.
  - **Scope:** it tests the extension↔gateway socket (catches the half-open death, gap A). It does
    **not** test whether the agent is wedged — that stays the job of the prompt timeout / cancel.
- **D2 — gateway-side keepalive.** openab periodically pings the tunnel (or the extension) and/or
  defines an extension-initiated probe. Closes gap (B) too. **Cross-repo contract change** —
  heavier, needs coordination with the openab team.
- **D3 — failure-as-signal (complement).** Treat any `mcp/message` handling that errors or times out,
  and any tool call that fails with "connection closed", as evidence of detachment → mark detached.
  Cheap, client-only, complements D1.

### 4.2 Auto-reconnect

- **R0 — none (manual only).** Keep today's "toggle a switch" recovery.
- **R1 — auto re-handshake on detected drop**, gated on user intent (`Conn.enabled`), reusing the
  existing reconnect path (`session/resume` re-declares the browser server → tunnel re-attaches).
  Must define backoff and a storm guard so a flapping tunnel doesn't hammer the gateway (align with
  the existing 5 s WS reconnect cadence).
- **R2 — one-click manual affordance.** Make the roster 🙈 monkey (or a dedicated control) clickable
  to reconnect, so recovery doesn't require opening Settings. Cheap; can ship alongside R0/R1.
- **R3 — recover on prompt timeout / retry (fixes problem 2.3).** A `session/prompt` timeout should
  **invalidate and reconnect** the socket rather than leave it reporting `OPEN`; and `retryLast` /
  `flushQueue` should, when the connection isn't live, **reconnect first and queue the prompt to flush
  after the handshake** instead of no-op-ing or sending into a dead socket. This is the concrete
  behaviour change that makes the observed "retry does nothing" go away. It rides on R1 (same
  re-handshake path) but is called out separately because it also touches the turn/timeout code, not
  just the tunnel-status path.

### 4.3 Status model / emoji

**S — two explicit badges per chip (decided 2026-08-06).** Today's chip is `[🔗/⛓️‍💥] name
[🐵/🙊/🙈]`: two cryptic glyph families, the status word hidden in a tooltip, `🔗` meaning both "agent
connection" and (in Settings) "browser-access toggle", and "connecting" rendering with the same
⛓️‍💥 as a hard error. Replace it with a text-led chip carrying **two self-labelled badges** — a
**connection badge** and a **browser badge** — so the two axes read at a glance and no glyph is
overloaded:

```
OpenAB  [● 已連線]  [🌐 可操作]     connected + browser writable
Mira    [● 已連線]  [🌐 唯讀]       connected + browser read-only (act mode off)
k04     [● 已連線]  [🌐 未連]       connected, tunnel not attached
Falcon  [◐ 握手中]                  connecting (connection badge only)
Kirin   [○ 認證失敗]                auth rejected
k06     [○ 連不到]                  server down / wrong URL
k10     [◌ 已停用]                  user disabled this agent
（later） [● 已連線]  [⚠️ 無回應]     attached but heartbeat failing (once D1 lands)
```

- **Connection badge** — colored dot + word, driven by `connState`: ● green 已連線 (`acpReady`) /
  ◐ amber 握手中·連線中 (connecting/reconnecting) / ○ red 認證失敗·連不到 (auth / unreachable) /
  ◌ grey 已停用 (`!enabled`). This retires the `🔗`/`⛓️‍💥` glyphs and makes *connecting ≠ error*
  visible without a hover.
- **Browser badge** — `🌐` + word, shown **only when the agent is allowed browser access**
  (`browserAccess !== false`): 🌐 可操作 (attached + act mode) / 🌐 唯讀 (attached + read-only) /
  🌐 未連 (detached) / ⚠️ 無回應 (**attached but heartbeat-failing** — the `alive` state D1 adds,
  instead of silently flipping to "未連"). This retires the 🐵/🙊/🙈 monkeys.
- **Also re-label the Settings browser-access toggle** off `🔗` onto the same 🌐 vocabulary
  (e.g. `🌐 瀏覽器存取：開/關`), so the *control* and the *status* speak one language — the original
  misalignment (🔗 toggle vs 🐵 status) that prompted this.

The status word still carries the fine-grained reason in a tooltip (e.g. which auth failure), but the
chip no longer *requires* a hover to tell the four facts apart.

## 5. Decision (settled 2026-08-06)

1. **Detection: D1 + D3**, client-only. Heartbeat is a gateway-answered request-shaped frame
   (§4.1 D1), **every 60 s with a 5 s probe timeout, both operator/user-configurable**. No openab
   dependency; closes the real (latency) gap. **D2 deferred** unless silent logical death (gap B) is
   actually observed — and if so, open a companion change against the openab tunnel contract.
2. **Reconnect: R1 + R2 + R3 (all three).**
   - **R1** — auto re-handshake on a detected drop, gated on `Conn.enabled`, with backoff + storm
     guard aligned to the existing 5 s WS cadence.
   - **R2** — a one-click manual reconnect on the chip (the browser badge / a dedicated control), so
     recovery never requires opening Settings.
   - **R3** — a `session/prompt` timeout invalidates + reconnects the socket, and `retryLast` /
     `flushQueue` reconnect-then-queue instead of no-op-ing or sending into a dead socket (fixes the
     reported "retry does nothing", 2.3).
   - **Fail-fast on confirmed death (decision for #3):** once the heartbeat declares the socket dead,
     **the in-flight turn fails immediately** rather than waiting out `ACP_PROMPT_TIMEOUT_MS` — the
     10-minute ceiling only governs a turn on a *live* socket.
3. **Status model: S (two-badge chip).** Do the vocabulary cleanup **in the same change** as
   detection so the newly honest state ships coherent: connection badge + browser badge per §4.3,
   with the `alive`/⚠️無回應 state wired to D1 and the Settings toggle re-labelled to 🌐 to match.

Note: the reported retry/timeout bug (2.3) is folded into this ADR rather than hot-fixed separately
(Brett's call, 2026-08-06), so it's fixed as part of R3 when this lands — not before.

## 6. Open questions (to settle before implementation)

- ~~**Probe method**~~ — **resolved (2026-08-06, verified in openab):** a gateway-answered
  request-shaped frame (unknown method → instant `-32601`), not blocked by an in-flight prompt
  (`session/prompt` is spawned), no agent, no tokens. See §4.1 D1. This also **retires the former
  false-positive-while-busy discussion item** — no need to gate the heartbeat on idle.
- ~~**Heartbeat cadence**~~ — **decided (2026-08-06): 60 s interval / 5 s probe timeout, both
  configurable.**
- ~~**Glyph vocabulary**~~ — **decided (2026-08-06): two-badge chip, §4.3 S.** Connection badge
  (●/◐/○/◌ + word) + browser badge (🌐 + word, incl. ⚠️無回應 for the degraded case); Settings toggle
  moves to 🌐.
- ~~**Scope of R2**~~ — **decided (2026-08-06): yes, ship R2** (manual one-click reconnect) alongside
  the auto path R1.
- ~~**Prompt timeout vs heartbeat**~~ — **decided (2026-08-06): fail the in-flight turn immediately**
  once the heartbeat confirms the socket is dead; the 10-minute `ACP_PROMPT_TIMEOUT_MS` only bounds a
  turn on a live socket.

All open questions are now settled — this ADR is Accepted and ready to implement.

## 7. Consequences

- **If adopted:** the monkey becomes trustworthy (no stale-on), tunnel-only drops self-heal like the
  WS already does, and the status glyphs stop contradicting each other. All client-side — no openab
  release coupling — unless gap (B) forces D2 later.
- **If deferred:** users keep hitting "the agent says it can't see the page" with a monkey that still
  shows 🐵, and keep recovering by toggling a Settings switch whose emoji (🔗) doesn't even match the
  status it fixes (🐵).

---

## 8. Revision (2026-08-06) — gap (B) confirmed; status model → three segments

The two-badge model (§4.3 S) shipped in #17. Live-testing the same day exposed two things the original
decision had explicitly parked, so this section revises the **status-model** decision **and reworks the
D1 heartbeat**, and records the openab follow-up the ADR made conditional on gap (B) proving real.
Reconnect (R1/R2/R3) and the connection-badge vocabulary stand; **detection does NOT stand unchanged —
§8.6 reworks the D1 heartbeat and reverses its "no need to gate on idle" premise** (D3 stands).

### 8.1 Gap (B) — "silent logical death" — is now real

§2.1(B) / §3 treated a socket-alive, tunnel-logically-dead state as a contract violation, out of client
scope "unless it proves real in practice". It proved real (2026-08-06, katashiro thread):

- **Symptom.** The chip showed `OpenAB ● 已連線 🌐 可操作` while the agent replied `目前 OpenAB MCP 連線
  已斷（Session not found），無法確認瀏覽器是否已連線` and could not drive the page. The browser badge
  was **green and lying**.
- **Server trace** (Falcon `openab-orb`, `openab_gateway::adapters::acp_server`): the tunnel opened
  (`ACP: opening MCP-over-ACP tunnel` → `tunnel registered — client MCP server attached`); the
  agent-side MCP session then went stale; **no `mcp/disconnect` was ever emitted** to the extension — a
  fresh tunnel simply re-registered on the next reconnect.
- **Root cause in openab.** `mcp/disconnect` fires only on owner-based teardown (WS close / a resume
  that drops the server, §7). Tunnel **eviction / agent-side session-death is an explicit follow-up
  ("F6", `acp_server.rs:35` "eviction … is a follow-up") that is not implemented.** So the §7
  "withdrawal sends `mcp/disconnect`" guarantee does **not** cover session-death while the socket stays
  up.

Per §5.1 this satisfies the precondition for the deferred **D2** companion change against openab (§8.4).

### 8.2 Two badges conflates three transport layers

§2.4 counted four facts; the shipped chip folds them into two badges, which **merges the three transport
layers a user must tell apart** (Brett, 2026-08-06 — "已連線 分不清是 ws / tunnel / browser"):

- the **connection badge `● 已連線`** is `acpReady` — really the **WS/ACP link** (extension ↔ gateway
  socket);
- the **browser badge `🌐 …`** conflates **tunnel attached** (`browserAttached`, from `mcp/connect`) with
  **browser mode** (act-mode read/write) — two independent facts on one glyph.

The `session/prompt`-timeout (2.3) and the `Session not found` (8.1) incidents each come from a
*different* layer failing while the others look fine, so one "已連線" cannot express the real state.

**Revised decision — three self-labelled segments per chip,** in dependency order **link → tunnel →
browser**, each an independent dot/word; a downstream segment **dims** when an upstream one is down (a
dead link can't leave a green browser lying):

```
OpenAB   🔌 已連線   🚇 活躍   🌐 可操作
```

| segment | glyph | states | source |
|---|---|---|---|
| **link** (WS/ACP) | 🔌 | ● 已連線 / ◐ 連線中 / ⚠️ 無回應 / ○ 連線失敗 / ◌ 已停用 | `connState` + heartbeat `alive` (D1) |
| **tunnel** (MCP-over-ACP) | 🚇 | ● 活躍 / ● 已連結（閒置） / ◌ 未連結 | `browserAttached` + **§8.3 `mcp/message` freshness** |
| **browser** (mode) | 🌐 | 可操作 / 唯讀 / —（dim when tunnel down） | `browserAttached` + `actMode` |

This **supersedes §4.3 S / §5.3** (two-badge). The `alive`/⚠️無回應 state moves from the browser badge
onto the **link** segment where it belongs (it is a socket property, not a tunnel one). The
connection-badge vocabulary (●◐○◌ + word) and the Settings-toggle 🌐 re-label from §4.3 carry over.

**Manual reconnect (R2) placement.** The one-click reconnect shipped in #17 stays, re-homed onto the
**link** segment: clicking 🔌 when it is ⚠️ 無回應 / ○ 連線失敗 forces a re-handshake (the same
`connect()` path). This keeps recovery on the segment whose failure it fixes (the earlier 🔗-toggle-vs-🐵
misalignment, §2.4), and — with §8.6 — a *user*-initiated reconnect is always allowed, whereas an
*automatic* one is gated on (3)+(4).

**Purity / testability.** The per-segment state derivation (link/tunnel/browser → glyph+word, plus the
dim rules) is added to `room-core.js` as pure functions alongside `browserBadge`/`connState`, so each
segment's mapping is unit-tested the way `browserBadge` already is — not buried in `updateRoster`'s DOM
code.

### 8.3 New client signal — `mcp/message` as a tunnel-liveness freshener (D4)

§3 established the extension is the MCP **server** and **cannot initiate** a tunnel probe, so the D1
heartbeat tests only the **ACP socket**, never the **logical tunnel**. But there is an unused *positive*
signal: every inbound **`mcp/message`** (gateway → extension, `browser-mcp.js handleServerRequest`) is
proof the tunnel is alive end-to-end at that instant.

**D4 (new, client-only):** stamp the arrival time of the last inbound `mcp/message`; the tunnel segment
reads **活躍** within a **60 s** window of that stamp, else **已連結（閒置）**. This is a *freshness*
indicator, not a health verdict — **silence ≠ death** (an idle-but-healthy tunnel also goes quiet), so
閒置 is neutral, never an error. D4 complements D1 (socket) and D3 (failure-as-signal); it does **not**
remove the D2 need for an authoritative death signal (§8.4).

### 8.4 openab companion (D2 / gap B) — handover

The authoritative "tunnel logically dead" signal must come from the gateway, because the extension
cannot distinguish idle from dead (§8.3). Requested openab change: **when a session goes stale while its
tunnel registry entry is still attached, emit `mcp/disconnect` (or a tunnel-status frame) to the
extension**, reusing the existing `handle.disconnect()` / eviction path so the §7 disconnect guarantee
also covers session-death, not only WS close.

**Scope note (Falcon review) — this is NOT the F6 caps item.** `acp_server.rs:35`'s F6 is resource-caps /
idle-eviction, and same-name eviction *already* sends `mcp/disconnect`. The gap here is specifically
**session-stale-but-registry-still-attached**; the handover must not be coupled to F6 caps. Filed to the
openab thread alongside the existing reap-on-`Drop` lifecycle item. Until it lands, gap (B) degrades
gracefully (D4 shows 閒置, not a false 活躍) but the tunnel segment cannot flip to 未連結 on its own.

### 8.6 Heartbeat rework — passive liveness, idle-only probe, non-destructive (revises §4.1 D1)

Live-testing #17 exposed that the shipped heartbeat is not merely imperfect but **actively destabilising** —
it tears down healthy turns. This subsection reverses the §4.1 D1 premise "no need to gate the heartbeat
on idle" and redesigns the mechanism. Client-only; no openab dependency.

**Observed (2026-08-06, Falcon `openab-orb`).** During a normal streaming turn: **82 × `ACP dropping
stale reply from a superseded turn`** on one channel from only **5 `session/prompt`s**, `consumer idle
timeout` cycling, and cursor-agent processes climbing 2 → 6 / memory 25% → 65% — a churn spiral, not a
steady state.

**Root cause — two design faults in the shipped code:**

1. **Liveness ignores traffic.** `markAlive(true)` is called *only* from the ping-response path
   (`sidepanel.js` heartbeatTick). An inbound `agent_message_chunk` — undeniable proof the socket is
   alive — does **not** freshen `alive`. So during a verbose turn the *only* liveness evidence is the
   60 s ping.
2. **A probe timeout is destructive, and fires mid-turn.** `isDeadProbeReason` treats `timed out` as
   dead, so a ping whose `-32601` reply is merely *delayed behind the chunk flood on the same socket*
   (>5 s) trips `onHeartbeatDead()`, which `rejectAllPending("connection closed")` — **killing the
   in-flight, healthy `session/prompt`** — then `connect()`s. On reconnect, `session/resume` + `flushQueue`
   re-send the re-queued prompt as a **new turn that supersedes the old**; the old cursor-agent turn keeps
   streaming (openab doesn't cancel it) into the dead sink → the 82 "superseded" drops, plus a fresh
   cursor-agent per cycle → the memory climb.

The §4.1 D1 assumption ("`session/prompt` is spawned gateway-side, so the probe is answered even
mid-turn — no need to gate on idle") is the flaw: even if the gateway *dispatches* the reply promptly,
that reply is serialised behind queued `agent_message_chunk`s on the one ordered socket, so under load it
can miss a 5 s window. **The heartbeat thus false-positives precisely when the socket is busiest — i.e.
most obviously alive — and then destroys the very turn that proved it.** This is strictly worse than
pre-#17 (a merely stale badge).

**Revised design — traffic is liveness; never tear down a turn to check it:**

1. **Passive liveness.** Every inbound frame (`agent_message_chunk`, any request response, `mcp/message`,
   server request) stamps `lastRecvAt` and marks the socket alive. This subsumes §8.3 D4 (the
   `mcp/message` freshener is just the tunnel-scoped case of the general rule).
2. **Probe only on silence, only when idle.** Send `katashiro/ping` **only if** `now - lastRecvAt >
   interval` **and** no turn is active. A streaming turn is self-evidently alive and is never probed —
   which removes the false-positive class entirely.
3. **Non-destructive while a turn is active.** `onHeartbeatDead` must not `rejectAllPending` / `connect`
   when `turnActive`. A genuinely wedged turn is the prompt-timeout / cancel path's responsibility
   (R3), with its own turn-aware timeout — not the heartbeat's.
4. **Debounce before reconnect.** Require a definitive signal — WS `onclose`, **or ≥2 consecutive
   idle-probe timeouts**, or a real operation returning closed — before a destructive reconnect. One 5 s
   blip is not death.
5. **Separate display from action.** Degrading the chip to `⚠️ 無回應` is safe and may be eager;
   reconnecting is destructive and must be lazy, gated on (3)+(4).

**Residual risk (accepted).** With mid-turn probing removed, one case is no longer caught early: a socket
that half-opens **while a turn is streaming-silent** (the agent is thinking, no frames flowing) is
indistinguishable from a healthy think-pause — inbound silence during a turn is ambiguous (dead vs
thinking), so we must not reconnect on it. That case falls back to the `session/prompt` timeout (R3),
which — post-rework — invalidates the socket and reconnect-then-requeues (problem 2.3's fix) when it
fires. We accept this: the alternative (#17's aggressive mid-turn reconnect) traded a rare, bounded
silent-turn hang for a *frequent* destruction of healthy busy turns.

**Be precise about each case's bound (review — Orca / Mira / Falcon):** `onclose` is **not** a prompt
backstop for the silent-turn half-open. A peer that vanishes without FIN/RST leaves this TCP half-open,
and a *silent* turn has no outbound send to hit an RST, so `onclose` waits on OS keepalive (hours). The
three half-open cases therefore have three different bounds, and only the first is slow:

- **silent-turn half-open** — no prompt signal; **only** hard upper bound is the 10-min R3
  `ACP_PROMPT_TIMEOUT_MS` (shortening it is the one future lever). Do **not** model `onclose` as a faster
  backstop here.
- **non-silent half-open** (frames flowing / a live outbound send) — `onclose` fires promptly on the RST.
- **idle half-open** — caught by the idle probe in **~125 s** (a 60 s-interval probe, then one more after
  another interval, to reach the ≥2 debounce). Worth watching for during live testing.

**Net:** #17's real benefit is retained — a genuinely dead **idle** socket is still caught before the
next prompt hangs 10 minutes — while the harm (killing live turns, churn, the cursor-agent leak) is
removed, entirely client-side. This supersedes §4.1 D1's idle premise and the destructive
`onHeartbeatDead` behaviour folded into §5.2 R3; the fail-fast-on-confirmed-death intent stands, but
"confirmed" now means (3)+(4), not a single probe timeout.

### 8.7 Status

Accepted 2026-08-06. Supersedes the status-model decision (§4.3 S / §5.3) and the heartbeat idle-premise
(§4.1 D1) / destructive-recovery detail (§5.2 R3); all other decisions in this ADR stand.
