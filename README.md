# Katashiro (紙代 / 形代) - OpenAB Companion ⛩️

![Katashiro banner](images/banner.jpg)

**Katashiro** is a Chrome side-panel chat for your **OpenAB** agents. It connects to an OpenAB
gateway over the Agent Client Protocol (ACP), and lets the agent see and operate the browser you
are using.

- **Chat beside any page** — up to 3 open conversations (across all windows), each bound to one of
  your agents, with history that survives a reload. A conversation keeps working while you look at
  another; archived ones reopen from the 🗂️ gallery. Paste screenshots or drop files into the chat.
- **Let the agent use the browser** — 53 `katashiro.*` tools: read the page, click, type, fill forms,
  navigate, manage tabs, point things out to you, ask you multiple-choice questions. Writes stay
  off until you allow them.
- **Get long answers as canvases** — reports, slide decks, Mermaid diagrams or images in a tab beside
  the chat, which you can edit, send back to the agent, export, and find again in the 🗂️ gallery.

> In Onmyōdō, a *katashiro* is a paper doll a spirit can inhabit. Here the side panel is the doll,
> your OpenAB agent is the *shikigami* summoned into it, and the browser tools are its hands.

## 🚀 Install

Runs on Chromium browsers (Chrome, Edge); not Firefox (Arc needs a `chrome.sidePanel` polyfill).
There is no build step.

1. Download the latest **`katashiro-<version>.zip`** from [**Releases**](../../releases) and unzip it
   to a folder you will keep — or `git clone https://github.com/brettchien/katashiro.git`.
2. Open `chrome://extensions/`, turn on **Developer mode**, click **Load unpacked** and pick the folder.
3. Click the Katashiro toolbar icon to open the side panel (pin it for easy access).

**Updating:** replace the files (or `git pull`), click **↻ reload** on `chrome://extensions/` (or
**Settings → 重新載入 Katashiro**), then reopen the side panel. Chats, sessions and settings are kept.
**Don't remove the extension to upgrade** — Chrome deletes its synced settings on removal.

Settings (agents, tokens, switches) sync through your Google account; chat history and canvases stay
in this browser. Katashiro does not run in incognito windows: whatever you
send reaches the agent's session, so it could not keep an incognito promise.

## 🔌 Connect

1. On first open, the side panel asks for an agent name and your OpenAB endpoint
   (e.g. `ws://localhost:8080/acp`).
2. If the endpoint is not on localhost, open **Settings (⚙️)** and enter its token in that agent's
   row (non-loopback endpoints need one). Add more agents there if you like; each new conversation
   (＋) picks one. Each agent also has its own **🌐 開／關** switch (on by default): off, that agent
   gets no browser tools at all — a second control besides act mode.
3. **Install the agent skills** (below) into each agent, so it uses Katashiro's features properly.

**What the gateway needs.** Chat needs OpenAB's ACP WebSocket (`OPENAB_ACP_ENABLED=true`, bearer
token `OPENAB_ACP_AUTH_KEY` — see the
[ACP server ADR](https://github.com/openabdev/openab/blob/main/docs/adr/acp-server-websocket.md)).
Browser tools also need the OAB MCP Facade (`[mcp]` in OpenAB's `config.toml`, with the agent's MCP
config pointing at it — see
[Browser MCP agent setup](https://github.com/openabdev/openab/blob/main/docs/browser-mcp-agent-setup.md));
without it the chat works but the agent has no browser tools.

## 🧩 Agent skills

Some features need the agent to follow a procedure, not just call a tool. The skills in
[`skills/`](skills/) teach it that — **install them into every agent that chats through Katashiro.**
They are not in the release zip: take them from the repo (`git clone`, or download it from GitHub),
and install them **where the agent runs** (its machine or container), not where the browser runs.

| Skill | Teaches the agent to | Without it |
|---|---|---|
| [`katashiro-show-image`](skills/katashiro-show-image/SKILL.md) | Show you an image: a screenshot by `imageId`, or a file through `scripts/show-image.sh`, which sends it straight to the OpenAB facade | The agent has to emit the image as base64 itself — slow, costly, and large images fail |
| [`katashiro-ask-user`](skills/katashiro-ask-user/SKILL.md) | Ask you a multiple-choice question on a card, then **end its turn** and wait for your answer as a new message | The agent may sit waiting or poll for the answer instead of ending the turn |
| [`katashiro-point-at`](skills/katashiro-point-at/SKILL.md) | Point at what it is explaining: glow an element or a canvas block, or emphasise several with temporary CSS | Works, but the agent rarely shows you where it means |
| [`katashiro-guided-runbook`](skills/katashiro-guided-runbook/SKILL.md) | Walk you through an operation as a runbook canvas: you run every command, it marks the next step, checks your pasted output against Expected / Stop if, and keeps the execution log (resumes from the log after a reload) | The agent rebuilds the structure each time, may advance on output it never checked, and loses its place after a reload |

For Claude Code (including OpenAB's `claude-agent-acp`), copy or symlink them from a checkout of this
repo into the agent's skills directory:

```bash
cp -r skills/katashiro-* ~/.claude/skills/
```

**Copy them again after updating Katashiro** (`git pull` first) — an installed skill does not update itself.
`show-image.sh` needs `bash`, `curl`, `jq` and `base64`, and runs only in a Katashiro chat
(it uses the session's `$OPENAB_SESSION_TOKEN`).

## 🛡️ Act mode and permissions

The agent operates the browser **as you**, with whatever you are logged into. Reading works
always; **writes** (click, type, navigate, close tabs, …) are refused until you turn on act mode
(**Settings → 瀏覽器寫入 → ✋ 可操作**). With act mode on there is no per-action confirmation and no
site blocklist. Chrome's own **Site access** setting keeps the page tools off a site, but not the tab
tools: `navigate` / `new_tab` can still open it, and `tabs` still shows its tabs' URLs and titles.
Details: [docs/tools.md → Act mode](docs/tools.md#act-mode--writes-are-off-by-default).

| Permission | Why |
| --- | --- |
| `sidePanel` | The chat lives in Chrome's side panel. |
| `storage`, `unlimitedStorage` | Settings (synced), chat history, sessions, and canvases with their versions and images (local; canvases have their own 200 MB budget). |
| `scripting`, `<all_urls>` | Page tools read and act on the active tab. Writes still need act mode. |
| `tabs`, `tabGroups` | Tab tools, and one tab group per conversation for its canvases and working tabs. |
| `notifications` | `katashiro.notify`, and alerts from a conversation you are not looking at: a question waits for you, or a reply finished or failed. |
| `sessions` (optional) | Only for `katashiro.reopen_tab`; off until you allow it in Settings. |

Upgrading from 2.x, Chrome may ask you to accept `notifications` and `unlimitedStorage`, added in 3.0.

## 🧰 What the agent can do

| Area | Tools |
| --- | --- |
| See the page | `snapshot` (accessibility tree with element refs — the main one), `get_text`, `read_dom`, `get_selection`, `screenshot`, `scroll`, `hover`, `wait_for` |
| Act on the page *(act mode)* | `click`, `type`, `fill_form`, `select_option`, `press_key`, `upload_file`, `paste_image`, `navigate`, `history`, `reload`, `inject_css` |
| Tabs and windows | `tabs`, `tab_groups`, `new_tab`, `switch_tab`, `close_tab`, `reopen_tab`, `tab_update`, `group_tabs`, `ungroup_tabs`, `update_tab_group`, `split_tabs`, `unsplit_tabs` |
| Talk to you | `highlight`, `show_image`, `ask_user`, `notify`, `set_title`, `chat_history`, `client_info` |
| Canvases | `canvas_open`, `canvas_patch`, `canvas_read`, `canvas_list`, `canvas_delete`, `canvas_highlight`, `canvas_inject_css`, `canvas_goto`, `canvas_view`, `canvas_gallery` |
| Natural-language grounding *(optional, your own OpenRouter key)* | `assert`, `click_text`, `type_text` |

Act mode gates more than the *Act on the page* row: the tab tools that open, switch, close, move or
group tabs, and `click_text` / `type_text`, are writes too. Parameters, results, limits, and which
tools are writes: [docs/tools.md](docs/tools.md).

## 📚 Documentation

- [docs/features.md](docs/features.md) — every part of the side panel in detail: conversations, reply-to, attachments, activity pills, agent status, canvases.
- [docs/tools.md](docs/tools.md) — the full tool reference and the act-mode gate.
- [docs/mcp-over-acp.md](docs/mcp-over-acp.md) — how the browser serves tools back to the agent, for anyone building the same.
- [CONTRIBUTING](CONTRIBUTING.md) — development setup, project structure, tests, commit convention.
- [docs/testing.md](docs/testing.md) — test layers and step-by-step checks in real Chrome.
- [ROADMAP](ROADMAP.md) and [`docs/adr/`](docs/adr/) — what is planned, and why things are the way they are.
- [Releases](../../releases) — builds and release notes. **3.0.0** brought canvases and the 🗂️ gallery, several conversations with one agent each, and new tools (`ask_user`, `show_image`, `chat_history`, `set_title`, `notify`, `client_info`, `canvas_*`); it removed room mode (agent-to-agent relay) and incognito support.
