# T2 E2E: the real extension against a fake ACP gateway

The unit tests (`npm test`) check the pure logic; the smokes (`npm run smoke`) load the panel and
canvas pages over http with a **stub** of `chrome.*`. Neither sees real tab groups, runtime
messaging between pages, `chrome.storage.session` being cleared, real notifications or the real
side panel. The E2E cases here do:

- **The real extension**: the repo root is loaded unpacked into **full Chrome for Testing** (the
  version pinned in `package.json` `config.chromeVersion`, new headless — not
  `chrome-headless-shell`, which cannot load extensions), a fresh profile per scenario.
- **The real side panel**: opened the way the user does, a click on the toolbar icon (CDP
  `Extensions.triggerAction`; `background.js` sets `openPanelOnActionClick`). Puppeteer attaches to
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
| `canvas-inject-css.mjs` | canvas_inject_css | the sheet reaches the real canvas tab's sandboxed frame, two sheets add up, they survive a re-render, `url()` is refused, `clear` removes them; `read_dom` on a canvas tab names the canvas tools |
| `user-image-open.mjs` | a pasted image | the image reaches the prompt; its chat thumbnail (zoom-in cursor) opens it full size in a new tab, on every click |
| `agent-per-conversation.mjs` | two agents, two fake gateways | ADR agent-per-conversation: the ＋ agent picker (未連線 for an unconnected agent); both stream at once into their own lists; the chip follows the conversation on screen; Y's handshake opens no session for X's conversation (§2.7 `Conn.cur`); archiving an agent's last conversation closes its socket |
| | migration, URL edit, removal | the old `activeAgentUrl` binds the conversation and stays in storage.sync; a URL edit rebinds both copies and drops the old session; removing the agent in use leaves the conversation read-only; adding the URL back revives it |
| | one agent: archive the last conversation | the socket stays up (no new handshake) when the new conversation is on the same agent |
| | fresh install | a conversation opened on the placeholder agent follows the synced agents when they arrive |
| | pickers and settings | the agent picker sits above the input and survives a switch; a second ＋ shows the same one; Settings has no room mode and says 開著 N 段／共 M 段 |
| | a new window, two agents | an empty conversation left by a closed window is not adopted (picker, and it is deleted); one with messages is |
| `agent-per-conversation.mjs` | another window's Settings edits | §7 I9: an added agent shows in window 2 without a reload; a URL edit rebinds window 2's conversation (session/new on the new URL, nobody left on the old one); a removal leaves window 2's roster |
| `reconnect-resend.mjs` | a socket dropped mid-turn | agent-per-conversation §7 I8: the requeued resend carries the resend line (and only it); the partial reply stays; the chat says it was cut |
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
