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

- **Browser Control (MCP-over-ACP)**: the extension is an MCP server over the same `/acp` socket; the agent discovers and calls DOM-semantic browser tools (`katashiro.read_dom` / `click` / `type` / `navigate` / `screenshot`) that execute in the active tab via `chrome.scripting`. Full surface in [the tool table](#the-tools-we-serve); roadmap in [ROADMAP](ROADMAP.md).

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
- `test/`: `node --test` suites. No Chrome required; `chrome.*`, `crypto`, and the socket are mocked.
- `icon.png`: A high-definition custom cyberpunk icon featuring a digital paper doll with neon circuit designs.

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

| Tool | Params | Returns |
| --- | --- | --- |
| `katashiro.read_dom` | `selector?` (CSS) | `outerHTML` of the match, capped at 100k chars. No selector ⇒ `document.body`. |
| `katashiro.click` | `selector` | Text ack; `isError` if the selector matches nothing. |
| `katashiro.type` | `selector`, `text` | Focuses the element, sets `value` (or `textContent`), fires `input` + `change`. |
| `katashiro.navigate` | `url` (absolute) | Text ack — issued via `chrome.tabs.update`, does not wait for load. |
| `katashiro.screenshot` | — | `image/jpeg` at quality 70. JPEG, not PNG: a full-page PNG base64 runs several MB and blows past the tunnel's per-frame cap. |

Writes are **not gated yet** — there is no act-mode switch, origin allowlist, per-action
confirmation, or audit log. Anything you are logged into, an agent with this tunnel can click
and type into. Those gates are Phase 3 in the [ROADMAP](ROADMAP.md).

## 🚀 How to Load and Test

### 1. Load the Extension in Chrome
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle the **Developer mode** switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left corner.
4. Select the project folder: `katashiro`.

### 2. Launch the Side Panel
- Click the **Katashiro** icon in the extensions toolbar (or pin it and click the toolbar icon) to slide open the Side Panel on the right side of the screen.

### 3. Connect to OpenAB
- Click the **Settings (⚙️)** icon in the top header.
- Enter your OpenAB WebSocket endpoint URL (e.g., `ws://localhost:8080/acp`).
- Click **Save and Reconnect** to establish a real-time connection.

## 📚 Documentation

- [ROADMAP](ROADMAP.md) — planned browser-access capabilities (read page → change page → change site) and their safety gates.
- [CONTRIBUTING](CONTRIBUTING.md) — local development setup and the Conventional Commits convention this repo follows.