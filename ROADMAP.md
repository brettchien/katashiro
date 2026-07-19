# Katashiro Roadmap — Browser Access for OpenAB Agents

This roadmap tracks the progression from a passive chat companion toward an
agent that can perceive and act on the live web, always gated by explicit user
consent. Each phase is additive and independently shippable.

## Architecture premise

The agent runs **server-side over the ACP WebSocket** and has **zero direct
browser access**. The extension (Side Panel) is the only component that can see
or touch the page. Therefore:

- **Reading** a page = the extension pulls content and injects it into the ACP prompt.
- **Acting** on a page = the agent pushes a command back, the extension executes it.

Every capability below is a variation on those two directions.

> **Status (2026-07): the reverse-RPC mechanism is delivered.** The agent→extension
> "act" direction (Phase 2 "Route B" below) is now realized via **MCP-over-ACP**: openab
> tunnels MCP over the `/acp` socket, and the extension serves DOM-semantic **browser tools**
> (`click` / `read_dom` / `navigate` / `type` / `screenshot`) as an MCP server that the agent
> discovers (`tools/list`) and calls (`tools/call`). See the tunnel contract in the openab
> repo (`docs/mcp-over-acp-tunnel-contract.md`). This supersedes the brittle Route A
> (fenced-JSON) idea. Safety gates (act-mode, origin allowlist, per-write confirm, audit log)
> from Phase 3 still apply before high-blast-radius writes ship.

---

## Phase 0 — Current state ✅

Shipped today (see `sidepanel.js`):

- WebSocket + ACP (JSON-RPC 2.0) transport: `initialize` → `session/new` / `session/resume`.
- Per-agent persisted sessions (`acpSessionByUrl`), auto-reconnect (5 s), resume-or-fresh fallback.
- Multi-agent management (add / delete / rename / retarget / switch active).
- Turn queue (one turn at a time, survives reconnect), streamed agent replies.
- LINE-style chat UI, agent output rendered via `textContent` (no HTML injection).

The agent cannot yet see or change anything in the browser.

---

## Phase 1 — Read the current page 📖

Give the agent read access to the active tab as prompt context.

- **manifest**: add `activeTab`, `scripting`, `tabs` permissions + `host_permissions: ["<all_urls>"]`.
- **`readActivePage()`**: `chrome.scripting.executeScript` extracts `{ url, title, selection, innerText }` (capped, e.g. 20k chars for token control).
- **Attach-toggle** (📄): when on, prepend page context to the next turn. Off by default to control token cost.
- Graceful null on injection-blocked pages (`chrome://`, Web Store, PDF viewer).

Optional upgrade: send page as an ACP `resource` content block instead of inline
text — cleaner separation, but **requires verifying openab passes non-text
prompt blocks through to the model**.

**Exit criteria**: agent can answer questions about the page the user is viewing.

---

## Phase 2 — Change the rendered page (client-side DOM) ✍️

Let the agent mutate the live DOM. Ephemeral — changes vanish on reload; the
server is not touched.

Two channels for agent → extension commands:

- **Route A (ships today, no broker change)**: agent emits a fenced
  `openab-action` JSON block; the extension parses it on turn completion,
  confirms, and executes. Brittle, prompt-dependent.
- **Route B (clean, needs openab support)**: a real ACP reverse RPC. Extension
  declares a `page/execute` client capability in `initialize`, handles inbound
  JSON-RPC **requests** in `handleAcpMessage` (currently dropped), and replies
  with a result. Requires openab to expose a browser tool that round-trips over
  ACP — **unverified; must audit the openab repo**.

- **`applyPageAction()` executor** — allowlisted ops only: `click`, `setValue`
  (with `input`/`change` events), `setText`, `scrollTo`, `injectCss`.
  No `eval` / arbitrary JS.
- **Safety gate**: per-action confirm UI showing op + selector + value.

**Exit criteria**: agent can fill a form field / click a control, user confirms each action.

---

## Phase 3 — Change the website (persistent, server-side) 🌐

The high-blast-radius phase. Changes **persist to the server** because the
extension inherits the user's full authenticated session — anything the user can
do while logged in, the agent can do.

Two mechanisms:

- **Drive the real UI**: chain Phase-2 actions against the site's own controls
  (type into editor → click Save). The site's backend persists via its normal
  flow. No new capability — just real consequences.
- **Authenticated requests** (`apiCall` op): `fetch(url, { credentials: "include" })`
  run inside the page's same-origin context via `executeScript` — carries the
  site's cookies, no CORS. Turns the extension into an authenticated
  computer-use agent.

### Hard gates — none of this ships without all of them

1. **Read-only by default**; writes require explicit **act mode**.
2. **Origin allowlist** — only whitelisted domains can be written to / called.
3. **Per-write confirmation showing the raw request** (method + URL + body), not
   just the agent's natural-language intent.
4. **No `eval` / no arbitrary JS / no arbitrary-URL fetch** — ops allowlisted, params schema-validated.
5. **Audit log** of every executed action.
6. **Blocklist high-risk origins** (banking, cloud consoles, GitHub org admin) by default.

**Exit criteria**: agent completes a real persistent task on an allowlisted site,
every write approved by the user, with a full audit trail.

---

## Out of scope

Changing a website's **source code or deployment** is a dev/CI pipeline concern,
not a browser-runtime capability, and is not part of this extension.

---

## Suggested build order

1. Phase 1 (read) — low risk, immediate value.
2. Phase 2 Route A (DOM write + confirm) — no broker dependency.
3. Audit openab for ACP client-tool support → decide whether Phase 2 Route B is viable.
4. Phase 3 only after act-mode + origin allowlist + audit-log gates exist.
