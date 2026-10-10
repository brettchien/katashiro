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

- **Browser Control (MCP-over-ACP)**: the extension is an MCP server over the same `/acp` socket; the agent discovers and calls **DOM-semantic browser tools** — reads such as `snapshot`, `read_dom`, `get_text`, `get_selection`, `screenshot`, `scroll`, `hover`, `highlight`, `tabs`, `tab_groups`, `wait_for`, and act-mode writes such as `click`, `type`, `fill_form`, `select_option`, `upload_file`, `press_key`, `navigate`, `history`, `reload`, `inject_css`, `new_tab`, `switch_tab`, `close_tab`, `reopen_tab`, `tab_update`, `group_tabs`, `ungroup_tabs`, `update_tab_group`, `split_tabs`, `unsplit_tabs` — most execute in the active tab via `chrome.scripting`; the tab-management tools (`tabs`, `new_tab`, `switch_tab`, `close_tab`, `reopen_tab`, `tab_update` and the tab-group tools) act on the browser's tab set. Perception is an accessibility-tree `snapshot` with stable element refs. Full surface in [the tool table](#the-tools-we-serve); roadmap in [ROADMAP](ROADMAP.md).

- **Rich Chat**: agent and user messages render as **markdown → DOMPurify-sanitized HTML** — GFM tables, **syntax-highlighted** code with one-click **copy**, hardened links. `stop`/retry a turn (ACP `session/cancel`), **chat history + ACP session resume** persisted per window (reopen the panel and the conversation — and the session — continue), **reply-to** (hover a message → ↩; the agent receives each message with a `[2026-10-10T16:05:12+08:00 sender]` header (ISO 8601, local time with offset) — and `↩ time sender「excerpt」` for a reply — so a batched backlog keeps its boundaries and says what it answers; click a quote to jump to the original). The agent can answer specific messages too: a line `↩ <time>` in its reply renders that part under a quote of the message it answers — a batch of 2+ messages (or a reply) carries a one-line note telling the agent so), and stick-to-bottom auto-scroll with a "jump to latest" pill. A **clear-screen** button (🧹) wipes the on-screen transcript and this window's persisted scrollback while **keeping each agent's ACP session** — the local view resets, the agents don't forget.

- **Browser-tool activity pills**: each browser tool the agent runs during a turn shows as a compact pill above the reply (`click ⏳` → `click ✓` / `✗`). **Hover** a pill for the command (e.g. `click {ref:"e12", button:"right"}`), the outcome with a one-line summary (the error text on failure — e.g. act mode off, restricted page) and the duration in ms; **click** it to expand the full arguments and the first ~300 chars of the result (selectable), click again to collapse. Arguments are **masked inside `browser-mcp.js`** before the UI sees them — every tool declares a `redact(args)` hook (`fill_form` shows field refs only, never values; `upload_file` shows name / MIME / size, never content; `type` / `type_text` show only the text length, `navigate` / `new_tab` drop the URL query and fragment, other long strings such as `inject_css` are clipped at 80 chars). Values hidden there are also scrubbed from the result summary/preview, longest first; `fill_form` values are scrubbed even as short bare tokens, and its errors never echo a value. Any URL a result mentions (e.g. `tabs`, which lists every open tab) is likewise shown only up to its path. Known limit: a page whose own text echoes a *truncated prefix* of a secret is not caught. Pills live only in the on-screen transcript; they are not saved to chat history.

- **Agent tool-call pills**: when the gateway forwards the agent's own tool calls (ACP `tool_call` / `tool_call_update` — Bash, Edit, …), each shows as an indigo-framed pill in the same strip as the browser-tool pills: a short label + ⏳ / ✓ / ✗. The OpenAB gateway forwards only the tool's identity, never the agent's free-text title or command: the label is the most specific of `_meta.openab.capability` > `name` > `title` > ACP `kind` (e.g. **`Bash`**, **`Edit`**, `execute`), and an MCP tool `mcp__server__tool` shows as **`server · tool`** (≤40 chars). A later update with the same `toolCallId` updates the same pill and may upgrade a kind-only label once the name arrives, never downgrade it; katashiro's own browser tools — called directly or through the OAB MCP Facade (`execute_capability` with a `katashiro.*` capability) — are skipped here since their browser pill already shows them; a pill still ⏳ when the turn ends (cancel / disconnect) settles to a neutral ⏹. Gateways that don't send these updates are unaffected.

- **Roster status at a glance**: each agent chip carries two self-labelled badges — a **connection badge** (● 已連線 / ◐ 連線中 / ○ 連線失敗 / ◌ 已停用) and, when the agent is allowed browser access, a **browser badge** (🌐 可操作 / 🌐 唯讀 / 🌐 未連 / ⚠️ 無回應). A liveness heartbeat keeps them honest — a half-open socket surfaces as ⚠️ 無回應 rather than a stale "connected", and clicking an unhealthy chip reconnects it.

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
- `skills/`: Agent skills that ship with Katashiro — install them into your agent (see [Agent skills](#-agent-skills)).
- `test/`: `node --test` suites. No Chrome required; `chrome.*`, `crypto`, and the socket are mocked.
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

Most tools act on the **active tab** (`tabs.query({ active: true, lastFocusedWindow: true })`);
DOM work runs injected in the page via `chrome.scripting.executeScript`. The exception is the
**tab-management** tools (`tabs`, `new_tab`, `switch_tab`, `close_tab`, `reopen_tab`, `tab_update`,
`tab_groups`, `group_tabs`, `ungroup_tabs`, `update_tab_group`, `split_tabs`, `unsplit_tabs`) — they operate on the browser's tab set,
not a single page, so they don't require (and aren't blocked by) a scriptable active tab; opening
or switching a tab is how the agent *changes* which tab is active. A tool that fails — selector
matched nothing, no active tab — comes back as an MCP result with `isError: true`, not a protocol
error, so the agent can read the reason and adapt.

Most tools take a `ref` (+ its `snapshotId`) from the most recent `snapshot` — the primary,
cheapest way to perceive the page — with a CSS `selector` as a fallback. Action tools return the
**post-action snapshot** so the agent rarely needs a follow-up read.

| Tool | | Params | Returns |
| --- | --- | --- | --- |
| `katashiro.snapshot` | read | — | Accessibility-tree snapshot as compact text, a stable `ref` on each interactive element, and a `snapshotId`. PRIMARY way to see the page. |
| `katashiro.read_dom` | read | `selector?` (CSS) | `outerHTML` of the match, capped at 100k chars. No selector ⇒ `document.body`. |
| `katashiro.get_text` | read | `selector?` (CSS) | `innerText` of the match (capped 100k). No selector ⇒ `document.body`. |
| `katashiro.screenshot` | read | — | `image/jpeg` at quality 70. JPEG, not PNG: a full-page PNG base64 runs several MB and blows past the tunnel's per-frame cap. Also returns an **`imageId`** (random; kept in the extension for this agent only, for 15 min, dropped when the agent is disconnected; how many, and the per-screenshot size cap — larger captures are downscaled / re-encoded — are set in **Settings → 截圖**, default 10 and 500 KB, cap up to 4 MB) for `paste_image` / `upload_file`. The image the *agent* sees is a separate copy downscaled to ≤1568 px on the long edge (what the model can use; it also keeps the frame small on the ACP tunnel) — a view still over 1 MB is not sent, only its `imageId` — so a capture can go into another page without the agent handling its bytes. |
| `katashiro.scroll` | read | `to`\|`direction`+`amount?`\|`ref`\|`selector` | Scrolls to reveal content (perception aid — works in read-only). Returns the updated snapshot. |
| `katashiro.hover` | read | `ref`\|`selector` | Dispatches pointer events to reveal menus/tooltips. Returns the updated snapshot. |
| `katashiro.highlight` | read | `ref`\|`selector`, `label?`, `durationMs?` \| `clear` | Outlines an element (with a short caption, prefixed `🤖 katashiro`) to point it out to the user. Drawn in katashiro's own closed shadow root — page elements are never modified — ignores the pointer, and expires (default 4 s, max 15 s). |
| `katashiro.get_selection` | read | — | The text the user has selected, across frames and inside text fields, with the element it sits in. For "explain / translate this". |
| `katashiro.client_info` | read | — | Which Katashiro this is: version + build (release tag / sha, `dev` for an unstamped unpacked load), install type, extension id, Chrome version, the panel window (id, incognito), act mode, optional permissions granted. Same build identity as the connection-screen badge and the ACP `initialize` `clientInfo`. |
| `katashiro.show_image` | read | `imageId` \| `data`+`mimeType`, `caption?` | Shows an image **to the user** in the panel, inside the agent's current turn (above its reply): a `screenshot` capture by `imageId` (no bytes cross the tunnel), or base64 / data: URL png·jpeg·gif·webp·svg ≤ 5 MB (SVG is rasterized to PNG in the panel; if that fails it stays an `<img>` and enlarges in-panel, never opened as a document) — meant to be sent by a shell helper straight to the facade so the bytes never pass through the model. Decoded before display (a non-image is an error); click opens full size. Memory-only like pasted images (history keeps a marker). Not a page action, so act mode does not gate it. |
| `katashiro.canvas_open` | read | `title`, `content` \| `imageId` \| `data`+`mimeType`, `kind?`, `caption?`, `id?`+`baseVersion?` | Creates or updates a **canvas** ([ADR](docs/adr/canvas.md)): `markdown` (default), `slides` (markdown split on `---` lines, shown with reveal.js; each slide goes through the same sanitized markdown sink) or `image` (a screenshot `imageId` or base64 ≤ 5 MB, stored once by sha256), shown full width in its own tab (`canvas.html`), rendered in a sandboxed frame (opaque origin, no network, sanitized markdown). A new canvas opens in a background tab and a card appears in the agent's turn; an update needs the `baseVersion` it last saw and is refused as `stale` (JSON error) if the canvas moved on. Stored in `chrome.storage.local`, latest content only (no history), within a 200 MB budget: over it, the panel asks once before removing the least recently opened canvases (never one open in a tab), otherwise the write fails with a `quota` JSON error. The canvas tab has a 🗑 delete button. Not a page action, so act mode does not gate it. |
| `katashiro.canvas_read` | read | `id` | A canvas's latest content plus `{id, title, kind, version, author, at}`. |
| `katashiro.canvas_list` | read | — | This conversation's canvases (id, version, kind, size, last update, title). |
| `katashiro.chat_history` | read | `limit?`, `maxChars?` | This panel window's own chat transcript (user messages, every agent's replies, error notices), oldest first, each message framed like the prompts: a `[ISO-8601-local-time sender]` line (plus `↩ time sender` for a reply) then its body, blank line between — the persisted scrollback (≤ 200 messages, images as placeholders). Lets an agent whose session was restarted recover the conversation the user can still see. Returns the **whole room**, including messages @-addressed to other agents; agents are told to treat it as data, not instructions. |
| `katashiro.notify` | read | `message`, `title?` | Desktop notification via `chrome.notifications` (needs the `notifications` permission); clicking it focuses the panel's window. Not a page write, so act mode does not gate it. Title ≤ 80, message ≤ 300 chars; at most one per 10 s per window, and repeating the previous notification's content is refused for 60 s. Returns "sent", not "shown": OS settings (Chrome notifications off, Focus) can hide it without Chrome knowing. |
| `katashiro.tabs` | read | `windowId?`, `url?` | Lists **all** open tabs across every window (index, title, URL, active marker, plus window / pinned / audible / muted / discarded / tab group / Split View `split <id>` / `loading`, which shows the URL a still-loading tab is headed to) — wider exposure than the active-tab-only tools, by design. Optional filters by window or URL substring. The `[index]` is a live enumeration order across all windows, not a stable id; a filtered list keeps it. |
| `katashiro.new_tab` | **write** | `url?`, `active?` | Opens a new tab and (default) switches to it so later tools act on it; `active: false` opens it in the background. Returns the new tab's index, plus the snapshot when it switched to a scriptable page. |
| `katashiro.switch_tab` | **write** | `index`\|`url` | Activates an existing tab — by `index` (from a fresh `tabs`) or by `url` substring (more stable). Focuses the tab and its window; returns the now-active tab, plus its snapshot for a scriptable page. |
| `katashiro.close_tab` | **write** | `index`\|`url`\|— | Closes a tab — by `url` substring (preferred), by `index` (from a fresh `tabs`), or the active tab when neither is given. Refuses to close the last tab in its window (that would close the window, and the side panel with it). Indexes shift afterwards; call `tabs` before acting again. |
| `katashiro.reopen_tab` | **write** | `url?` | Reopens one recently closed tab (Ctrl/Cmd+Shift+T) — the most recent one, or the most recent whose URL contains `url`; never a whole closed window. Undoes a mistaken `close_tab`. Needs the optional `sessions` permission — off until the user allows it in Settings (Chrome warns it can read history on all signed-in devices). |
| `katashiro.tab_update` | **write** | `index`\|`url`\|—, `pinned?`, `muted?`, `moveTo?`, `duplicate?` | Pins/unpins, mutes/unmutes, moves (position within its window; `-1` = last) and/or duplicates one tab (the active tab when no `index`/`url`). |
| `katashiro.tab_groups` | read | — | Lists tab groups: id, title, color, collapsed, window, member tab indexes. Needs the `tabGroups` permission. |
| `katashiro.group_tabs` | **write** | `tabs[]` of `index`\|`url`, `groupId?`, `title?`, `color?` | Puts tabs into an existing group (`groupId`) or a new one, optionally naming / coloring it. One bad tab reference groups nothing; refuses a move that would empty (and so close) another window. |
| `katashiro.ungroup_tabs` | **write** | `tabs[]` of `index`\|`url` | Takes tabs out of their groups (an emptied group disappears). |
| `katashiro.update_tab_group` | **write** | `groupId`, `title?`, `color?`, `collapsed?` | Renames, recolors, collapses or expands a group. |
| `katashiro.split_tabs` | **write** | `tabs[]` (2 tabs, or 1 + `openUrl`) of `index`\|`url`, `openUrl?`, `side?` (`left`\|`right`) | Chrome Split View: puts two tabs side by side (if they aren't adjacent, the second is moved right after the first; adjacent tabs keep their order), or opens `openUrl` in a new tab split with the given one (right by default). Both must share window, pinned and group state. Page tools still act on the **active pane**. Chrome 155+, feature-detected. |
| `katashiro.unsplit_tabs` | **write** | `splitViewId`\|`index`\|`url`\|— | Turns a Split View back into two independent tabs (by split id, either member tab, or the active tab's split). Chrome 155+. Pane width, orientation and swapping are not exposed to extensions. |
| `katashiro.wait_for` | read | `selector`\|`text`, `timeout?` | Polls until the element/text appears (never a fixed sleep), then returns the snapshot. |
| `katashiro.click` | **write** | `ref`+`snapshotId`\|`selector`, `button?` (`left`\|`right`), `doubleClick?` | Clicks the element; `button: "right"` fires `contextmenu` (the page's own menu), `doubleClick` emits two clicks + `dblclick`. Like a real click it focuses the element (or its nearest focusable ancestor, e.g. a contenteditable editor), so `paste_image` with no ref lands there. Returns the updated snapshot. Stale-ref checked. |
| `katashiro.type` | **write** | `ref`+`snapshotId`\|`selector`, `text` | Sets `value` via the native setter (React-safe) or `textContent`, fires `input`+`change`; returns the snapshot. |
| `katashiro.select_option` | **write** | `ref`+`snapshotId`\|`selector`, `value`\|`label` | Selects a `<select>` option by value or visible label; fires `change`; returns the snapshot. |
| `katashiro.fill_form` | **write** | `snapshotId?`, `fields[]` of `ref`\|`selector` + `value`\|`checked` | Fills up to 50 text fields / textareas / contenteditables / selects / checkboxes / radios in one call. Every field is checked first; one bad field fills nothing. Does not submit. Returns the snapshot. |
| `katashiro.upload_file` | **write** | `ref`+`snapshotId`\|`selector`, `files[]` of `name` + `text`\|`base64`\|`imageId`, `mimeType?` | Attaches agent-supplied files to an `<input type=file>` (hidden inputs included) and fires `input`+`change`; 5 MB total for `text`/`base64` the agent sends, while `imageId` screenshots (held in the extension, never on the tunnel) count separately up to 20 MB. Returns the snapshot. |
| `katashiro.paste_image` | **write** | `imageId`, `ref`+`snapshotId`\|`selector`\|— (focused), `mode?` (`paste`\|`drop`), `name?` | Pastes a screenshot into an element as if the user pressed Cmd/Ctrl+V with it on the clipboard (or drops it, `mode: "drop"`) — e.g. screenshot one page, paste into a Jira description (click it into edit mode first), which uploads it. A wrapper ref is fine: the event goes to the editable inside it; drops land on the element’s centre. Synthetic events, so success is never assumed: it always returns the snapshot, says whether a handler cancelled the event (a hint only), and points at `upload_file` with the same `imageId` only if the image is not there. Focused-element mode is top frame only — use a ref for an editor in an iframe. |
| `katashiro.press_key` | **write** | `key`, `ref?`+`snapshotId?`\|`selector?` | Dispatches synthetic key events (fires page handlers — Enter/Escape/arrows — not trusted native input). Returns the snapshot. |
| `katashiro.navigate` | **write** | `url` (absolute) | Navigates the tab, waits for load, returns the snapshot. |
| `katashiro.history` | **write** | `direction` (`back`\|`forward`) | Goes back/forward in the tab's history; returns the snapshot. |
| `katashiro.reload` | **write** | `bypassCache?` | Reloads the tab (hard reload if `bypassCache`); waits for load, returns the snapshot. |
| `katashiro.inject_css` | **write** | `css` \| `clear` | Applies a stylesheet to every frame via `chrome.scripting.insertCSS` (visual only, gone on reload); `clear` removes what katashiro injected. Refuses anything that fetches — `url()`, `image-set()`, `@import`, `@font-face`, … — and CSS escapes, so a sheet cannot exfiltrate page data through attribute selectors. |

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

Act mode is the write consent boundary. Site access is **all sites** (`host_permissions:
["<all_urls>"]`); to keep katashiro off a site, restrict it with Chrome's own extension **Site
access** setting (`chrome://extensions` → katashiro → Details). On a site it cannot access, the tools
that read or act on page content fail; navigation and tab management are **not** limited by site
access — `navigate` / `new_tab` still open such a site, and `tabs` / `switch_tab` / `close_tab` still
see its tabs' URLs and titles and can switch to or close them. There is **no per-write confirmation and no high-risk-origin blocklist**, by
decision: with act mode on, the agent acts with your full logged-in authority on any site it can
reach. See the [ROADMAP](ROADMAP.md) for the gate status.

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
> Or use **Settings → 重新載入 Katashiro** in the panel (asks to confirm): it calls
> `chrome.runtime.reload()`, which re-reads the unpacked folder from disk the same way, and closes
> the side panel in **every window** — reopen it. Each window's chat scrollback and resumable ACP
> sessions live in `chrome.storage.local`, so they survive the reload (and a browser restart's
> stale windows are pruned on the next panel open); settings are kept too. A reply in progress is
> cancelled (`session/cancel`) first. The scrollback is stored on disk in your Chrome profile
> (never synced); 🧹 clears only this window's copy — another window's scrollback is deleted once
> that window is closed, on the next panel open. Incognito windows (if you allow Katashiro in
> incognito) never write the scrollback to disk: it stays in `chrome.storage.session` and is lost on
> reload or when the browser closes.

> **Settings sync:** config lives in `chrome.storage.sync`, so it follows your Google account to
> every Chrome with sync (Extensions) on. `manifest.json` pins the extension ID
> (`hgilgjleemnjgehpgikeonbijpjgapmf`) via `key`, so every install shares that config no matter
> which folder it's loaded from. **Don't remove the extension to upgrade** — Chrome deletes an
> extension's synced settings on removal; use ↻ reload instead.

### Launch & connect

1. Click the **Katashiro** toolbar icon to open the Side Panel (pin it for easy access).
2. Enter your OpenAB WebSocket endpoint (e.g. `ws://localhost:8080/acp`) — add the transport token
   if your endpoint requires one (non-loopback endpoints do).
3. It connects and streams. Manage agents / room mode / browser write-consent (act mode) from
   **Settings (⚙️)**.

### Run the tests

```bash
node --test test/*.test.js   # no Chrome required (chrome.*/crypto/socket are mocked)
```

## 🧩 Agent skills

Skills in [`skills/`](skills/) teach an agent (running under OpenAB, chatting through Katashiro)
how to use Katashiro features that need more than a single tool call.

| Skill | What it does |
|---|---|
| [`katashiro-show-image`](skills/katashiro-show-image/SKILL.md) | Show the user an image in the panel — a screenshot by `imageId`, or an image file via `scripts/show-image.sh`, which posts it to the OpenAB facade so the bytes never pass through the model. |
| [`katashiro-point-at`](skills/katashiro-point-at/SKILL.md) | Point the user at what you are explaining: glow one element with `katashiro.highlight`, emphasise several with temporary `katashiro.inject_css` (and clear it after), or glow a canvas block with `katashiro.canvas_highlight`. |

Install for Claude Code by copying (or symlinking) the folder into the agent's skills directory:

```bash
cp -r skills/katashiro-show-image ~/.claude/skills/
```

## 📚 Documentation

- [ROADMAP](ROADMAP.md) — planned browser-access capabilities (read page → change page → change site) and their safety gates.
- [CONTRIBUTING](CONTRIBUTING.md) — local development setup and the Conventional Commits convention this repo follows.