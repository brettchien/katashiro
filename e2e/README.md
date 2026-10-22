# T2 E2E: the real extension against a fake ACP gateway

The unit tests (`npm test`) check the pure logic; the smokes (`npm run smoke`) load the panel and
canvas pages over http with a **stub** of `chrome.*`. Neither sees real tab groups, runtime
messaging between pages, `chrome.storage.session` being cleared, real notifications or the real
side panel. The E2E cases here do:

- **The real extension**: the repo root is loaded unpacked into **full Chrome for Testing** (the
  version pinned in `package.json` `config.chromeVersion`, new headless — not
  `chrome-headless-shell`, which cannot load extensions), a fresh profile per scenario.
- **The real side panel**: opened the way the user does, a click on the toolbar icon (CDP
  `Extensions.triggerAction`; `src/background.js` sets `openPanelOnActionClick`). Puppeteer attaches to
  the side panel's own page target.
- **A fake gateway** (`fake-gateway.mjs`): a Node WebSocket server speaking the ACP subset
  Katashiro uses, scriptable per test: hold a prompt, stream chunks into any session, end a turn,
  answer with openab's exact pool-busy text, honour `session/cancel` per session, and call
  Katashiro's tools over the reverse-MCP tunnel (`mcp/connect` → inner `initialize` →
  `tools/call`), as an agent would. It listens on a free port on 127.0.0.1 and the scenario puts
  that URL in the agent config (`chrome.storage.sync`, as ⚙️ Settings would), so a real gateway on
  `:8080` is never touched.
- **A control page** (`control.html`, an extension page that is never shipped — `release.yml`
  zips runtime files only): the harness evaluates `chrome.*` in it (tab groups, tabs,
  notifications, storage) and it is "the user's" first tab.

```bash
npm ci && npm run chrome:full    # once: puppeteer-core, ws, and Chrome for Testing into .cache/chrome
npm run e2e                      # every scenario, with a summary
npm run e2e -- tab-groups        # only scenarios whose file or name contains a word given
E2E_HEADFUL=1 npm run e2e        # watch it (needs a display)
```

Overrides: `CHROME_FULL=/path/to/chrome` (full Chrome for Testing), `PUPPETEER_CORE=/path/to/node_modules/puppeteer-core`,
`E2E_TIMEOUT_MS` (per scenario, default 90000). CI runs it as the `e2e` job in
`.github/workflows/ci.yml`.

## The side panel, not sidepanel.html in a tab

Checked first (2026-10-13, Chrome 155). Opening `sidepanel.html` as a tab is what most extension
E2E setups do, and it is wrong for Katashiro in ways that matter to exactly the code under test:

| | real side panel | `sidepanel.html` as a tab | as a tab in a `type: "popup"` window |
|---|---|---|---|
| `chrome.tabs.getCurrent()` | `undefined` | the panel's own tab | the panel's own tab |
| `tabs.query({active: true, currentWindow: true})` | the user's tab | **the panel itself** | the panel itself |
| `windows.getCurrent()` → `panelWindowId` | the user's window | the user's window | the popup window |
| after Q6 activates the working tab | still visible | **hidden** (`visibilityState: "hidden"`, background-tab throttling) | visible |
| `tabs.create({windowId: panelWindowId})` | the user's window | the user's window | lands in a **different (normal) window**, so groups, Q5 and Q6 (`t.windowId !== panelWindowId`) break |
| size | 360 px wide | a full tab | a full window |

So in a tab the panel would count itself as "the tab the user is on" (Q8's `backgroundTabFor`,
`splitCanvasWithActive`, `planGroupSwitch` all read the active tab), would be hidden by the very
switch it makes, and in a popup window it would group nothing. The real side panel opens fine in
new headless (`chrome.sidePanel.open` with a user gesture works too, but `Extensions.triggerAction`
is the toolbar click itself), so the cases use it. `chrome.sidePanel`, `chrome.tabGroups`,
`chrome.notifications` (`getAll` sees what the panel created) and `chrome.storage.session` are the
real ones.

## Cases

| File | Scenario | Covers |
|---|---|---|
| `p2-background-turns.mjs` | two conversations stream at once; ⏹ on a background tab | #143: interleaved updates land in their own lists; `session/cancel` for that session only, the other turn continues; no notification for a stopped turn |
| | archive refused while replying | #143: this window's picker disables it (回覆中); window 2's picker asks window 1's panel over runtime messaging → 回覆中不能封存; archived once the turn is over |
| | background ask card / background turn finishing | #143 / Q12 / Q9: ❓ + a real notification; the answer reaches the agent as the next prompt; ● + a notification; the reply in its own list |
| | pool-busy reply | #143 §5: error with 重試, not recorded as a reply, never retried by itself; 重試 sends it once more |
| `p2-tab-groups.mjs` | switching conversations | #144 / Q5: no group collapses; from the other conversation's group to the new one's working tab; a user's own tab is left alone |
| | background page tool | #144 / Q8: a group collapsed by hand is expanded by a background `get_text`, which reads the working tab without activating anything; background `screenshot` refused |
| `working-tab-canvas.mjs` | canvas tools and the working tab | #141 / Q6: `canvas_highlight` / `canvas_goto` (answered by the real canvas tab) make it the working tab; the next send brings it forward |
| `canvas-move.mjs` | ↪ 移到其他對話 | multi-conversation §7.3: the picker in a real canvas tab lists the other conversations; the move takes the tab to the new conversation's group and its 🗨️ follows; the new agent is told once and can `canvas_read` it, the old one is refused and told it left (the other conversation unnamed) |
| | an agent’s canvas_move | §7.3 agent tools: `conversation_list` names the other conversations and their canvases (no content); a pull waits for the 🔒 card (允許) and takes the tab to the agent’s group; a push the user refuses (拒絕) moves nothing; the mover gets no note, the other agent is told |
| `canvas-open-conversation.mjs` | a canvas tab’s 🗨️ | multi-conversation §7.2: switches the real side panel to the canvas’s open conversation; once archived, reopens it from a canvas tab opened in no group, which ends up in the conversation’s group with no duplicate, and says so |
| `canvas-inject-css.mjs` | canvas_inject_css | the sheet reaches the real canvas tab's sandboxed frame, two sheets add up, they survive a re-render, `url()` is refused, `clear` removes them; `read_dom` on a canvas tab names the canvas tools |
| `chat-ask-selection.mjs` | 💬 on text selected in a chat message | the 💬 shows inside the messages area; the chip quotes the selection and focuses the input; the prompt's ↩ header names it and the selection follows the text as fenced data; the sent quote and `chat_history` keep it; none across two messages or on a timestamp |
| `page-ask-agent.mjs` | 💬 Ask agent on a web page | ADR page-send-to-agent: the service worker's real `onClicked` handler with a synthesized `info` after a real (CDP, trusted) right-click; the chip, the working tab, the exact prompt (host line + fence), the 📄 quote, the history record (no query, no selector), `chat_history`; a page's synthetic `contextmenu` changes nothing; `hadSelection` with and without a selection; a shadow-root element (no selector), an input (no value) |
| | navigated / closed before Enter, unreadable pages | §2.4: the host line says so (no selector); a `chrome://` page: the menu's `linkUrl`, else the reload notice; `file://` per the file-access switch; the panel closed at the click picks the target up from `storage.session` when it opens |
| `command-menu.mjs` | ⚡ / ⏹ in one slot | the two swap at the same position (send does not move); Esc does not stop a reply; Ctrl+/ while replying lists Cancel first, pre-selected; Ctrl+. and ⚡ → c send `session/cancel` and no prompt |
| | typed `/` | `/` opens the menu, `/r` filters to Reset session, Esc keeps the text; `/help`, `/agents`, `/etc/hosts`, `/tmp foo` stay with "No such command" and nothing is sent; ` /tmp is full` goes out as a message with its header |
| | Reset session, Switch model | ⚡ → r: a Katashiro card first, then exactly `/reset` (no header) and a muted 🔄 line, never the gateway's text; Ctrl+/ → m: `/models` → a card of the gateway's list (current ✅) → `/model set 3`; typed `/model set 2` switches with no card; typed `/reset` asks; `chat_history` shows none of it |
| | reset while replying, attachments | the reply is cancelled first and `/reset` waits for it (the fake gateway answers a busy session with -32001); a message queued meanwhile goes out after the reset; Switch model is refused while replying; a staged image refuses a command with a hint |
| `user-image-open.mjs` | a pasted image | the image reaches the prompt; its chat thumbnail (zoom-in cursor) opens it full size in a new tab, on every click |
| `agent-per-conversation.mjs` | two agents, two fake gateways | ADR agent-per-conversation: the ＋ agent picker (未連線 for an unconnected agent); both stream at once into their own lists; the chip follows the conversation on screen; Y's handshake opens no session for X's conversation (§2.7 `Conn.cur`); archiving an agent's last conversation closes its socket |
| | migration, URL edit, removal | the old `activeAgentUrl` binds the conversation and stays in storage.sync; a URL edit rebinds both copies and drops the old session; removing the agent in use leaves the conversation read-only; adding the URL back revives it |
| | one agent: archive the last conversation | the socket stays up (no new handshake) when the new conversation is on the same agent |
| | fresh install | a conversation opened on the placeholder agent follows the synced agents when they arrive |
| | pickers and settings | the agent picker sits above the input and survives a switch; a second ＋ shows the same one; Settings has no room mode and says 開著 N 段／共 M 段 |
| | a new window, two agents | an empty conversation left by a closed window is not adopted (picker, and it is deleted); one with messages is |
| `agent-per-conversation.mjs` | another window's Settings edits | §7 I9: an added agent shows in window 2 without a reload; a URL edit rebinds window 2's conversation (session/new on the new URL, nobody left on the old one); a removal leaves window 2's roster |
| `reconnect-resend.mjs` | a socket dropped mid-turn | agent-per-conversation §7 I8: the requeued resend carries the resend line (and only it); the partial reply stays; the chat says it was cut; the message goes out exactly twice (send + one resend) |
| | a manual reconnect mid-turn | the roster chip's `connect()`: `session/cancel` on the old socket, the turn resent at once on the new one with the resend line, nothing left pending to time out later |
| `open-limit.mjs` | ＋ with 3 open | multi-conversation §3.3: the archive picker (已經開了 3 段對話) lists the three; no 4th tab and no `session/new`; 取消 leaves the three; picking one archives it (kept, it has messages) and only then opens the new conversation — still 3 |
| `read-receipt.mjs` | the gray **read** tag | a message in the running turn is tagged, one queued behind it is not (and is stored `read: false`) until its turn goes out — also in a background conversation; the tag stays after the turn and across a panel reload, a record without the flag (older version) shows it, one stored unread does not; neither the prompt nor `chat_history` carries it |
| | pool-busy, 重試, a dropped socket | a pool-busy turn leaves no tag (stored unread), 重試 adds it; the message resent after a mid-turn socket drop is tagged after the resend |
| | a failed turn | a turn whose only sign was a tool call on the browser tunnel, then a JSON-RPC error: still read (the agent was working on it); the same error with nothing heard: no tag |
| | 重試 on an earlier turn | two pool-busy turns: the first error bubble's 重試 re-sends the first turn (not the later one) and tags only its message |
| `reload-tab-group.mjs` | **xfail (#139)** | after an extension reload, a conversation's next tab must join its existing group: today a second group with the same title is made |

## Adding a case

A file in `e2e/cases/` exports an array of scenarios `{ name, run(ctx, t), xfail?, xfailChecks? }`.
Each scenario gets a fresh browser, profile and gateway from `startSession()` (`helpers.mjs`):

- `ctx.panel` (the side panel's Page), `ctx.control` (the control page), `ctx.gw` (the gateway),
  `ctx.web.origin` (an http server: `GET /page/<name>` is a page whose text is "Body of <name>"),
  `ctx.ext(path)`, `ctx.browser`.
- `t.check(cond, message, got)` / `t.ok` / `t.fail`; a throw fails the scenario.
- Panel: `namedConversation`, `newConversation`, `switchTo`, `send`, `strip` / `markOf` (⏳ ● ❓,
  × / ⏹), `pressClose`, `answerAsk`, `visibleText`, `listContaining`, `idle`.
- Browser: `tabGroups`, `allTabs`, `activeTab`, `notifications`, `clearNotifications`,
  `storedConvs`, `convIdByTitle`, `sessionOf` (a conversation's ACP session id),
  `openSidePanel(ctx, controlPage)` (another window: create one with a `controlUrl(ctx)` tab),
  `reloadExtension`.
- Gateway: `gw.hold = true`, `waitPrompt(pred, { since })`, `chunk`, `endTurn(sid, reason, text)`,
  `openPrompts`, `cancels`, `poolBusy`, `callTool(sid, name, args)` and `FakeGateway.text(r)`.
  A prompt that is exactly `/reset`, `/models` or `/model set <N|name>` is answered at once with
  openab's own text (never held, not in `prompts`; it lands in `gw.commands`), and refused with
  -32001 while that session has a prompt open; `gw.models` / `gw.currentModel` are the list it shows.

The agent only calls tools inside a turn: open one first (`gw.hold = true`, `send`, `waitPrompt`).
A known product bug: mark the scenario `xfail: "#<issue> — why"` with `xfailChecks` matching the
checks it is expected to fail; any other failure (a throw, a timeout, another check) still fails
the run, and a pass is reported as XPASS so the mark gets removed with the fix.

## Limits

- **No real OS focus or input.** New headless has no window manager: window focus, the OS
  notification centre and its clicks (Q12's click-to-switch) are not exercised; `getAll` only
  proves the notification was created. Clicks are CDP input events into the page.
- **The side panel container is real, its chrome is not seen**: no screenshots of the browser UI
  around it; the panel is 360 px wide.
- **Reload** is `Extensions.loadUnpacked` again (what chrome://extensions ↻ does). In this harness
  `chrome.runtime.reload()` (Settings → 🔄 重新載入) leaves the CDP-loaded unpacked extension
  disabled, so that button itself is not covered.
- **The gateway is a fake.** Wire format and turn timing come from Katashiro's own client code and
  `scripts/acp-two-sessions.mjs` (real gateway, no browser); a protocol change on the openab side is
  not caught here.
- **The pages are local.** They answer after 700 ms: a page that finishes loading while `new_tab`
  is still grouping its tab makes `new_tab` wait out its 8 s load bound (the `complete` event fired
  before its listener was added, #149). Real pages are rarely that fast; the delay keeps the run fast and
  deterministic.
