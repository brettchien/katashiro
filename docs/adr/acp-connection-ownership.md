# ADR: ACP connection ownership — service worker vs side panel

- **Status:** Proposed (design placeholder — not yet decided)
- **Date:** 2026-08-03
- **Author:** Brett Chien
- **Related:** [chat markdown rendering ADR](./chat-markdown-rendering.md) §3.7 (which surfaced this)

---

## 1. Context

Today the ACP WebSocket lives in the **side panel** (`sidepanel.js`: `this.ws = new WebSocket(...)`),
alongside all the `Conn` / room / streaming logic. The side panel is also the extension's **XSS sink**
(it renders remote-controlled agent output; once markdown lands it does so via `innerHTML` + DOMPurify)
and it holds the `chrome.storage` tokens.

Reviewing the markdown ADR's egress CSP (chat-markdown §3.7) surfaced the tension: because the panel is
*both* the XSS surface *and* the network origin, the egress lock must allowlist the ACP origin in
`connect-src`, which weakens it against the very threat the markdown ADR names — a compromised/MITM ACP.

## 2. The problem this would (partly) fix

Moving the ACP socket into the **service worker** lets the panel's `connect-src` narrow to `'self'`.
The SW has no DOM, so it is not an XSS sink; the panel would talk to it only via message passing. Then:

- **Third-party exfil (a page the agent read injects XSS, or a MITM redirects to `attacker.com`):**
  fully closed — an XSS'd panel has no allowlisted origin to `fetch`/`WS` to.
- **Malicious ACP endpoint itself:** **still not closed.** The SW faithfully relays the panel's prompts
  to its ACP peer, so injected XSS can read the token and smuggle it out as prompt content over the
  legitimate `panel → SW → ACP` channel. Against a malicious ACP the real controls remain the trust
  boundary (it is the user's own openab broker), `wss`/TLS + the transport-auth key (vs MITM), and
  DOMPurify — not connection topology.

So this refactor is worth it for the **third-party** case (the realistic one), not as a fix for a
genuinely malicious backend.

## 3. Scope / why it's its own ADR

Not a small change: the panel's `Conn`, room fan-out, turn queue, streaming, reconnect, and
per-agent session state all revolve around the panel-owned `this.ws`. Moving the socket to the SW
means designing the SW↔panel message protocol (connect/prompt/stream-chunk/status/disconnect), where
session/reconnect state lives (SW sleeps ~30s — so `chrome.storage.session` or re-establish), and how
multi-agent/room routing maps onto it. Benefits reach beyond markdown (a cleaner trust separation for
all future rich-render surfaces: whiteboard, tool-call traces, etc.).

## 4. Options (to decide here later)
- **A. Keep the socket in the panel** — accept that panel `connect-src` must allowlist the ACP origin;
  document §3.7 as third-party-only (current markdown-ADR posture).
- **B. Move the socket to the SW** — panel `connect-src 'self'`; closes third-party exfil; requires the
  SW↔panel protocol + session-state design above. Does **not** close the malicious-ACP relay path.
- **C. Hybrid / offscreen document** — a persistent offscreen doc owns the socket (MV3's durable DOM
  context), panel stays a pure view. Similar tradeoffs to B with different lifetime rules.

## 5. Decision
**TBD.** Placeholder opened from the markdown security review so §3.7 doesn't silently over-claim. To
be filled when this is prioritized (it does not block the markdown work — the malicious-ACP *trust
boundary* is pre-existing. Markdown does add the `innerHTML` XSS *foothold*, so keeping DOMPurify
patched is what stops a malicious broker from exploiting it; the connection topology this ADR covers
doesn't gate the markdown work).
