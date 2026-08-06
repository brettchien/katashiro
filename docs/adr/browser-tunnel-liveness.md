# ADR: Browser-tunnel liveness — detection, reconnect, and status model

- **Status:** Proposed (not yet decided)
- **Date:** 2026-08-06
- **Author:** Brett Chien (drafted by Orca)
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

**2.3 Status vocabulary is inconsistent.** Four orthogonal facts are currently squeezed into two
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
- **D1 — client-side ACP heartbeat.** Periodically send a cheap idempotent ACP request (candidate:
  `session/list`) with a short timeout; on timeout/error, treat the socket as dead → mark detached
  (and trigger reconnect per §4.2). Closes gap (A). Client-only, no openab change. Tests the
  socket/session, not the logical tunnel.
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

### 4.3 Status model / emoji

- **S — separate the four facts explicitly** (connection / allowed / attached / alive) and give each
  an unambiguous glyph, so the browser-access **control** and the runtime **status** share one
  vocabulary and `🔗` stops meaning two things. Concrete glyph scheme is **to be decided** — e.g.
  keep the monkey family for the runtime browser states and move the per-agent access **toggle** off
  `🔗` onto the same monkey vocabulary (allowed vs not), reserving 🔗/⛓️‍💥 solely for the agent WS
  connection. An `alive`-but-degraded state (attached yet failing heartbeat) needs its own signal
  (e.g. a dimmed/⚠️-badged monkey) rather than silently flipping to 🙈.

## 5. Recommendation (proposed — for Brett to confirm)

1. **Detection: D1 + D3**, client-only. No openab dependency; closes the real (latency) gap. Defer
   **D2** unless silent logical death (gap B) is actually observed — and if so, open a companion
   change against the openab tunnel contract.
2. **Reconnect: R1**, gated on `Conn.enabled`, with backoff + storm guard; **plus R2** (clickable
   monkey) so manual recovery no longer needs Settings.
3. **Status model: S** — do the vocabulary cleanup **in the same change** as detection, so the newly
   honest state has a coherent set of glyphs rather than bolting `alive` onto the current overload.

## 6. Open questions (to settle before implementation)

- **Probe method:** is `session/list` implemented by every agent runtime we target, and is it cheap
  enough to call on an interval? If not, what is the fallback idempotent round-trip? (Verify against
  openab + the agent CLIs.)
- **Heartbeat cadence:** interval and timeout defaults (straw man: 15 s interval / 5 s timeout).
  Operator/user-configurable, or fixed?
- **Glyph vocabulary:** the final concrete emoji scheme for connection / allowed / attached / alive,
  including the degraded (attached-but-not-responding) case.
- **Scope of R2:** ship the clickable-monkey manual reconnect regardless of R1, as a always-available
  fallback?

## 7. Consequences

- **If adopted:** the monkey becomes trustworthy (no stale-on), tunnel-only drops self-heal like the
  WS already does, and the status glyphs stop contradicting each other. All client-side — no openab
  release coupling — unless gap (B) forces D2 later.
- **If deferred:** users keep hitting "the agent says it can't see the page" with a monkey that still
  shows 🐵, and keep recovering by toggling a Settings switch whose emoji (🔗) doesn't even match the
  status it fixes (🐵).
