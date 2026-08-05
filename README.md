# Katashiro (紙代 / 形代) - OpenAB Companion ⛩️

**Katashiro (紙代 / 形代)** is a sleek Chrome Extension Side Panel companion designed for **OpenAB (Open Agent Broker)**. It connects via WebSockets using the Agent Client Protocol (ACP) to provide a premium, LINE-style single chatroom interface for real-time two-way communication with multiple AI agents, each connected over its own ACP endpoint.

## 🔮 The Metaphor of Katashiro (形代 / 紙代)

In Japanese Onmyodo (陰陽道) and Shinto rituals, a **Katashiro (形代 / 紙代)** is a physical paper doll or vessel used to temporarily host spirits or represent individuals. 

Under this system:
* **The Chrome Extension UI (Side Panel) = Katashiro (紙代)**
  * The HTML, CSS, and JavaScript form the physical vessel—an empty shell waiting in the browser.
* **The OpenAB AI Agents = Shikigami (式神)**
  * The spiritual intelligence and agent logic that is "summoned" and "injected" into the vessel over the WebSocket connection.
* **Writing the Code = Drawing Talismans**
  * Writing configuration files (`manifest.json`) and styling components acts as the ritual of drawing magical talismans to establish a connection path between the summoner and the spirit.
* **Browser Tools = The Shikigami's Hands (施術)**
  * Through **MCP-over-ACP**, the summoned agent no longer merely *speaks* through the vessel — it *acts*. The extension serves DOM-semantic tools (`katashiro.click`, `katashiro.read_dom`, `katashiro.navigate`, `katashiro.type`, `katashiro.screenshot`) so the shikigami can reach through the katashiro and operate the living page. Perception and action, not just a voice.

---

## 🌟 Key Features

- **Browser Control (MCP-over-ACP)**: the extension is an MCP server over the same `/acp` socket; the agent discovers and calls **15 DOM-semantic browser tools** (8 read + 7 write — `snapshot`, `read_dom`, `get_text`, `screenshot`, `scroll`, `hover`, `tabs`, `wait_for`, `click`, `type`, `select_option`, `press_key`, `navigate`, `history`, `reload`) that execute in the active tab via `chrome.scripting`. Perception is an accessibility-tree `snapshot` with stable element refs. Full surface in [the tool table](#the-tools-we-serve); roadmap in [ROADMAP](ROADMAP.md).

- **Rich Chat**: agent and user messages render as **markdown → DOMPurify-sanitized HTML** — GFM tables, **syntax-highlighted** code with one-click **copy**, hardened links. `stop`/retry a turn (ACP `session/cancel`), **chat history + ACP session resume** persisted per window (reopen the panel and the conversation — and the session — continue), and stick-to-bottom auto-scroll with a "jump to latest" pill. A **clear-screen** button (🧹) wipes the on-screen transcript and this window's persisted scrollback while **keeping each agent's ACP session** — the local view resets, the agents don't forget.

- **Roster status at a glance**: per agent, a connection dot (🔗 linked / ⛓️‍💥 not) and a browser-tunnel monkey — **🐵** live + operational (act mode on), **🙊** live but read-only, **🙈** not attached.

- **Multi-Agent Room**: several agents share one chatroom, each on its own ACP connection. `@mention` mode (the default) routes a message only to the agents named in it and broadcasts when none are; ambient mode gives everyone everything. Agent replies are relayed to the other agents wrapped as `<message from="...">`, so they can answer each other — bounded by a **loop guard** that pauses a runaway agent-to-agent cascade and resets the moment a human speaks. Per-agent connect/disconnect and browser-access toggles, and one openab session per Chrome window.

- **Unified Chat Space**: Optimized specifically for a single multi-party chatroom, bypassing cluttered sidebar lists to fit perfectly in a narrow Side Panel.
- **LINE-style Chat Bubbles**: Self-sent messages align to the right (green), while received agent messages align to the left (dark slate blue) with custom avatars, sender names, and timestamp markers.
- **Connection Persistence**: Leverages the Chrome Side Panel API to host the WebSocket connection, allowing it to persist even as the user navigates across browser tabs.
- **Auto-Reconnection**: Automatically attempts to reconnect to the OpenAB broker every 5 seconds if the connection drops.
- **Premium Glassmorphic UI**: Features a modern dark-mode interface with glassmorphism styling, clean glow backdrops, and custom scrollbars for an enhanced visual experience.

## 🛠️ Project Structure

- `manifest.json`: Configuration manifest using Manifest V3 and the Chrome Side Panel API.
- `background.js`: Background Service Worker that registers the extension trigger to open the Side Panel on click.
- `sidepanel.html`: The HTML layout for the chatroom interface.
- `sidepanel.css`: High-fidelity styling utilizing modern CSS design tokens.
- `sidepanel.js`: Main client-side script managing WebSockets, Chrome local storage, auto-reconnection, and message rendering.
- `browser-mcp.js`: The MCP server we serve back to the agent over the ACP tunnel — tool registry, schemas, and DOM tool bodies. See [Serving an MCP server over reverse MCP-over-ACP](#-serving-an-mcp-server-over-reverse-mcp-over-acp).
- `room-core.js`: Multi-agent room logic — @mention routing, agent-to-agent relay, and the loop guard.
- `markdown.js`: The single sanitized `renderMarkdown` sink (markdown-it → DOMPurify) + copy-code and link/media hardening. See [`docs/adr/chat-markdown-rendering.md`](docs/adr/chat-markdown-rendering.md).
- `page/a11y-walker.js`: Content-script injected into the page — builds the accessibility-tree snapshot and resolves element refs (`__katashiroResolve`).
- `vendor/`: Prebuilt, eval-free IIFE bundles (MV3 `script-src 'self'`): `dom-accessibility-api`, `markdown-it`, `dompurify`, `highlight.js`. Rebuild steps in [`vendor/BUILD.md`](vendor/BUILD.md).
- `test/`: `node --test` suites (4 files, 103 tests). No Chrome required; `chrome.*`, `crypto`, and the socket are mocked.
- `icon*.png`: The extension icon set — `icon16/32/48/128.png` (manifest icons + toolbar) plus `icon.png` (side-panel brand logo). Cyberpunk digital paper-doll with neon circuitry.

## 🔌 Serving an MCP server over reverse MCP-over-ACP

Normally an MCP **client** connects out to MCP servers. Katashiro does the reverse: the agent
reaches *into* the browser. OpenAB opens a tunnel over the existing `/acp` WebSocket and speaks
MCP to us — we are the **server**, the agent is the client. That is the only way to reach a
browser tab, which no outside process can dial into.

`browser-mcp.js` is meant to be read as the reference implementation. If you want to serve your
own tools this way, you need exactly three things:

1. **Declare the server** in your `session/new` params, alongside any normal MCP servers:
   ```json
   { "mcpServers": [ { "type": "acp", "id": "<uuid>", "name": "katashiro" } ] }
   ```
   `id` is minted fresh per connection; `name` is stable and is what the operator allowlists.
   The gateway answers with a server-initiated `mcp/connect`, which you reply to with a
   `connectionId`.
2. **Answer `tools/list`** with your tool set. OpenAB fetches once per declared server and
   caches — discovery is pull-based, so there is no `list_changed` notification to send.
3. **Answer `tools/call`** with an MCP `CallToolResult`. Return *tool* failures as
   `isError: true` results rather than protocol errors, so the agent can read what went wrong
   and adapt.

Inner MCP messages arrive flattened into an `mcp/message` frame (`method` / `params` inline);
the outer ACP `id` is what correlates the reply. The wire format is specified in
[`docs/mcp-over-acp-tunnel-contract.md`](https://github.com/openabdev/openab/blob/main/docs/mcp-over-acp-tunnel-contract.md)
in the OpenAB repo.

You can declare **more than one**. `createServer({ id, name, tools })` builds an instance with
its own name and registry, and the module routes by the `connectionId` handed back at
`mcp/connect` — so a second client-side MCP server sits alongside `katashiro` on the same
socket, each answering only its own `tools/list` and `tools/call`. That is the client end of
OpenAB's multi-server fan-out. A `connectionId` you never minted is refused rather than served
by whichever server seems likeliest — guessing there would hand one server's tools to a caller
that was never granted a tunnel to it.

Two conventions worth copying:

- **One registry, not two lists.** `TOOLS` in `browser-mcp.js` holds each tool's schema *and*
  its implementation in the same entry, and the `tools/list` payload is derived from it. A tool
  cannot be advertised without an implementation, or implemented without being discoverable.
- **Namespace your tool names.** Ours are `katashiro.*`. A bare `browser.*` collided with a
  co-installed Playwright MCP's `browser_*` tools and the model could not tell the two surfaces
  apart. The operator allowlist is keyed on the declared name, and OpenAB admits tools as
  `fetched ∩ allowed`, so the prefix is load-bearing, not cosmetic.

### The tools we serve

Every tool acts on the **active tab** (`tabs.query({ active: true, lastFocusedWindow: true })`);
DOM work runs injected in the page via `chrome.scripting.executeScript`. A tool that fails —
selector matched nothing, no active tab — comes back as an MCP result with `isError: true`, not
a protocol error, so the agent can read the reason and adapt.

Most tools take a `ref` (+ its `snapshotId`) from the most recent `snapshot` — the primary,
cheapest way to perceive the page — with a CSS `selector` as a fallback. Action tools return the
**post-action snapshot** so the agent rarely needs a follow-up read.

| Tool | | Params | Returns |
| --- | --- | --- | --- |
| `katashiro.snapshot` | read | — | Accessibility-tree snapshot as compact text, a stable `ref` on each interactive element, and a `snapshotId`. PRIMARY way to see the page. |
| `katashiro.read_dom` | read | `selector?` (CSS) | `outerHTML` of the match, capped at 100k chars. No selector ⇒ `document.body`. |
| `katashiro.get_text` | read | `selector?` (CSS) | `innerText` of the match (capped 100k). No selector ⇒ `document.body`. |
| `katashiro.screenshot` | read | — | `image/jpeg` at quality 70. JPEG, not PNG: a full-page PNG base64 runs several MB and blows past the tunnel's per-frame cap. |
| `katashiro.scroll` | read | `to`\|`direction`+`amount?`\|`ref`\|`selector` | Scrolls to reveal content (perception aid — works in read-only). Returns the updated snapshot. |
| `katashiro.hover` | read | `ref`\|`selector` | Dispatches pointer events to reveal menus/tooltips. Returns the updated snapshot. |
| `katashiro.tabs` | read | — | Lists **all** open tabs across every window (index, title, URL, active marker) — wider exposure than the active-tab-only tools, by design. |
| `katashiro.wait_for` | read | `selector`\|`text`, `timeout?` | Polls until the element/text appears (never a fixed sleep), then returns the snapshot. |
| `katashiro.click` | **write** | `ref`+`snapshotId`\|`selector` | Clicks the element; returns the updated snapshot. Stale-ref checked. |
| `katashiro.type` | **write** | `ref`+`snapshotId`\|`selector`, `text` | Sets `value` via the native setter (React-safe) or `textContent`, fires `input`+`change`; returns the snapshot. |
| `katashiro.select_option` | **write** | `ref`+`snapshotId`\|`selector`, `value`\|`label` | Selects a `<select>` option by value or visible label; fires `change`; returns the snapshot. |
| `katashiro.press_key` | **write** | `key`, `ref?`+`snapshotId?`\|`selector?` | Dispatches synthetic key events (fires page handlers — Enter/Escape/arrows — not trusted native input). Returns the snapshot. |
| `katashiro.navigate` | **write** | `url` (absolute) | Navigates the tab, waits for load, returns the snapshot. |
| `katashiro.history` | **write** | `direction` (`back`\|`forward`) | Goes back/forward in the tab's history; returns the snapshot. |
| `katashiro.reload` | **write** | `bypassCache?` | Reloads the tab (hard reload if `bypassCache`); waits for load, returns the snapshot. |

### Act mode — writes are off by default

The extension operates the page as **you**, with whatever you are logged into. So the write
tools are refused unless you turn act mode on (Settings → 瀏覽器寫入 → ✋ 可操作); reads work
either way. A refused call comes back as an `isError` result explaining that only the user can
lift the gate, so the agent asks instead of retrying.

The flag is `write: true` in the `TOOLS` registry and the check sits in `callBrowserTool` — one
place, and a new tool has to declare which kind it is. Consent is checked *before* the active
tab is resolved, so a refusal reads as a refusal rather than as a browser problem. The gate is
consulted per call, so toggling it takes effect on the next tool call with no reconnect.

Write tools stay listed in `tools/list` even while act mode is off: OpenAB caches discovery per
connection, so hiding them would freeze whatever the toggle happened to be at connect time and
leave the agent unable to learn the capability exists at all.

Act mode is one of the Phase 3 gates; the **origin allowlist** is another and is now in place —
katashiro can only read or act on origins you've granted under **Settings → 授權網域** (backed by
Chrome's `optional_host_permissions`, checked per call for reads and writes alike), so act mode
only reaches sites you've allowlisted. **Per-write confirmation and a high-risk-origin blocklist
are still missing.** See the [ROADMAP](ROADMAP.md).

## 🚀 Install

Katashiro is a zero-build MV3 extension — there is no compile step; you load the folder as-is.
It runs on Chromium browsers (Chrome, Edge). Arc needs a `chrome.sidePanel` polyfill; Firefox is
not supported.

### Option A — from a release (recommended)

1. Download the latest **`katashiro-<version>.zip`** from the [**Releases**](../../releases) page.
2. Unzip it to a folder you'll keep (the extension loads from this folder — don't delete it).
3. Open `chrome://extensions/` and turn on **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped folder.

### Option B — from source

```bash
git clone https://github.com/brettchien/katashiro.git
```
Then `chrome://extensions/` → **Developer mode** → **Load unpacked** → select the `katashiro` folder.

> **Updating:** after replacing the files (or pulling), click the extension's **↻ reload** on
> `chrome://extensions/`, then **close and reopen the Side Panel** — the reload button alone does
> not refresh an already-open panel.

### Launch & connect

1. Click the **Katashiro** toolbar icon to open the Side Panel (pin it for easy access).
2. Enter your OpenAB WebSocket endpoint (e.g. `ws://localhost:8080/acp`) — add the transport token
   if your endpoint requires one (non-loopback endpoints do).
3. It connects and streams. Manage agents / room mode / browser write-consent (act mode) from
   **Settings (⚙️)**.

### Run the tests

```bash
node --test test/*.test.js   # 103 tests, no Chrome required (chrome.*/crypto/socket are mocked)
```

## 📚 Documentation

- [ROADMAP](ROADMAP.md) — planned browser-access capabilities (read page → change page → change site) and their safety gates.
- [CONTRIBUTING](CONTRIBUTING.md) — local development setup and the Conventional Commits convention this repo follows.