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

> **Status (2026-08): read + act are both live and validated.** The agent→extension
> "act" direction (Phase 2 "Route B" below) is realized via **MCP-over-ACP**: openab
> tunnels MCP over the `/acp` socket, and the extension serves DOM-semantic **browser tools**
> as an MCP server that the agent discovers (`tools/list`) and calls (`tools/call`). See the
> tunnel contract in the openab repo (`docs/mcp-over-acp-tunnel-contract.md`). This supersedes
> the brittle Route A (fenced-JSON) idea.
>
> The **served tool surface is fifteen tools** — 8 read (`snapshot`, `read_dom`, `get_text`,
> `screenshot`, `scroll`, `hover`, `tabs`, `wait_for`) and 7 write (`click`, `type`,
> `select_option`, `press_key`, `navigate`, `history`, `reload`); the full table with params is in
> the [README](README.md#the-tools-we-serve). Reads go through an **accessibility-tree snapshot
> with stable element refs** (cross-frame, stale-ref checked) rather than a raw `innerText` dump —
> see `docs/adr/a11y-snapshot-and-element-refs.md`. Action tools return the post-action snapshot so
> the agent rarely needs a follow-up read.
>
> The full loop was **live-validated end-to-end on Falcon (2026-07-31, PR #1447 D-29)**:
> real browser drive over a deployed pod, all tool calls audited.
>
> Of the Phase 3 safety gates, **act mode is in place** (writes off by default) and an
> **audit log exists on the openab facade side** (`mcp.audit` records every tool call). The
> gates still missing before high-blast-radius writes: **origin allowlist, per-write confirm
> (raw request), and a high-risk-origin blocklist.**

---

## Phase 0 — Current state ✅

Shipped today (see `sidepanel.js`):

- WebSocket + ACP (JSON-RPC 2.0) transport: `initialize` → `session/new` / `session/resume`.
- Per-agent persisted sessions (`acpSessionByUrl`), auto-reconnect (5 s), resume-or-fresh fallback.
- Multi-agent management (add / delete / rename / retarget / switch active).
- Turn queue (one turn at a time, survives reconnect), streamed agent replies.
- LINE-style chat UI. **Since shipped:** agent/user messages render as markdown → DOMPurify-sanitized
  HTML (`markdown.js`, syntax highlight + copy-code), plus chat history persistence + ACP session
  resume, stop/cancel, stick-to-bottom auto-scroll, and a roster emoji status (🔗/⛓️‍💥 connection,
  🐵/🙊/🙈 browser tunnel). Streaming stays `textContent`; the finalized message is the only
  sanitized-innerHTML sink (see `docs/adr/chat-markdown-rendering.md`).

The agent cannot yet see or change anything in the browser (that arrives in Phases 1–2 below).

---

## Phase 1 — Read the current page ✅

**Shipped** (via MCP-over-ACP, not inline prompt context). The agent reads the active tab
through `katashiro.read_dom` / `snapshot` / `screenshot`. Rather than the original
"prepend capped `innerText` to the next turn" design, reads are pull-on-demand MCP tool
calls returning an a11y-tree snapshot with element refs (see the ADR). The manifest-permission
and injection-blocked-page notes below still describe the extension's read plumbing.

Original plan (for reference):

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

## Phase 2 — Change the rendered page (client-side DOM) ✅

**Shipped via Route B (MCP-over-ACP), live-validated on Falcon 2026-07-31.** The agent
mutates the live DOM through `katashiro.click` / `type` / `navigate` / `wait_for`, each
gated behind act mode (Phase 3 gate #1). Changes are ephemeral — they vanish on reload; the
server is not touched. Route A (fenced-JSON) was abandoned in favour of the real reverse RPC.

Original plan — two candidate channels for agent → extension commands (Route B won):

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

1. ✅ **Read-only by default**; writes require explicit **act mode**. *(Shipped: `write: true`
   in the tool registry, gated in `callBrowserTool` on `deps.actMode`, toggled in Settings.)*
2. **Origin allowlist** — only whitelisted domains can be written to / called.
3. **Per-write confirmation showing the raw request** (method + URL + body), not
   just the agent's natural-language intent.
4. ✅ **No `eval` / no arbitrary JS / no arbitrary-URL fetch** — the served tools are a fixed
   allowlist with schema-validated params; there is no arbitrary-JS op.
5. ✅ **Audit log** — the openab facade records every tool call (`mcp.audit: facade source
   call … tool=katashiro.* … is_error=…`). *(Server-side; a client-side action log in the
   Side Panel is still worth adding for the user's own visibility.)*
6. **Blocklist high-risk origins** (banking, cloud consoles, GitHub org admin) by default.

**Exit criteria**: agent completes a real persistent task on an allowlisted site,
every write approved by the user, with a full audit trail.

---

## Out of scope

Changing a website's **source code or deployment** is a dev/CI pipeline concern,
not a browser-runtime capability, and is not part of this extension.

---

## Suggested build order

1. ✅ Phase 1 (read) — done via MCP-over-ACP (a11y snapshot + refs).
2. ✅ Phase 2 (DOM write) — done via Route B (MCP-over-ACP), abandoned Route A.
3. ✅ act mode (gate #1), no-eval (gate #4), server-side audit log (gate #5).
4. **Next — remaining Phase 3 write-safety gates**, in order:
   - **Origin allowlist** (gate #2) — only whitelisted domains can be written to.
   - **Per-write confirm showing the raw request** (gate #3).
   - **High-risk-origin blocklist** (gate #6).
   Ship these before opening act mode on real, persistent, authenticated sites.
