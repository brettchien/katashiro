# Testing Katashiro Browser Tools (MCP-over-ACP)

Katashiro is the **extension (client) side** of MCP-over-ACP browser control. The OpenAB
server side is deployed (Falcon) and the full loop is e2e-proven with a mock browser — loading
katashiro in Chrome replaces the mock with a real browser so the agent operates your live tab.

## Prerequisites

- An OpenAB agent with the browser-control build + `cursor-agent --approve-mcps`.
  Falcon: `ws://192.168.139.2:8080/acp` (transport token in the `falcon-acp-auth` k8s secret).

## Load the extension

1. `chrome://extensions` → **Developer mode** ON → **Load unpacked** → select the `katashiro/` folder.
2. Pin it and click the **Katashiro** icon to open the Side Panel.

## Connect

3. **Settings (⚙️)** → set the endpoint to the OpenAB `/acp` URL and paste the transport token
   → **Save and Reconnect**. The status dot should go green.
   - The token is entered here at runtime — never embedded in code.
   - The browser passes it via the WebSocket subprotocol (`openab.bearer.<token>`), so it stays out of the URL.

## Try a browser tool

4. Open any web page in the active tab, and **keep the Katashiro side panel open** — it hosts
   the MCP server and executes the tools in the active tab.
5. In the chat, ask the agent to use a browser tool, e.g.:
   - "Read this page with `katashiro.read_dom` and summarize it."
   - "Click the first link on this page." / "Navigate to example.com."
6. The agent discovers the tools (`tools/list`), calls one (`tools/call`) → it executes in your
   active tab → the result flows back to the agent.

## Tools served

The surface — params, returns, and which tools count as writes — is tabulated in
[README → The tools we serve](README.md#the-tools-we-serve). Kept in one place so the two
documents cannot drift.

Two things to expect while testing: a failure (no active tab, restricted page like `chrome://`,
missing element, missing host permission) returns an MCP `isError` result the agent can see and
adapt to; and **`click` / `type` / `navigate` are refused until you turn act mode on**
(Settings → 瀏覽器寫入 → ✋ 可操作), so enable it before testing the write tools.

## Notes

- The side panel must stay open (the tunnel and tool execution live in `sidepanel.js`).
- No separate demo page is needed — the extension **is** the client. For a headless protocol
  check of the tunnel without a browser, see `scripts/acp-ws-smoke.py` (tunnel section) in the
  openab repo, which drives the gateway with a mock extension.
- Contract: `docs/mcp-over-acp-tunnel-contract.md` in the openab repo.
- **Canvas folder mirror (ADR §3.6):** Settings → 畫布存到資料夾 → 📁 選擇資料夾, pick an empty
  folder, then let the agent write a canvas: `<folder>/c_…/<title>.md` appears, plus
  `.katashiro/<id>.json`. Edit the `.md` in an editor and save in the canvas: the file is left
  alone, a `<title>.katashiro-<UTC time>.md` appears beside it, and the canvas header shows
  "📁 檔案在 Katashiro 外被修改過". Delete the `.md` and reopen the canvas tab: "📁 檔案已刪除，不再同步", and
  later saves leave the folder alone; **📁 重新寫入** writes it again and mirroring resumes. Restart Chrome: the canvas header shows **📁 Reconnect folder**
  (unless Chrome kept the grant); saves made before reconnecting are written after it.
- **canvas_patch and Ask agent (ADR §3.5, §3.7):** with a markdown canvas open, select a sentence:
  **💬 Ask agent** appears in the header (not in a compare tab, not while editing, gone when the
  selection is cleared). Click it, type a request: the chat shows your request, then
  `[canvas "…" (cv_…) vN, text selected by the user …]` and the selection in a fence. Ask the
  agent to change it with `canvas_patch`: exactly the changed words glow (inline, not their
  paragraph; a deleted paragraph leaves a red line on the next one), the card shows the new
  version. Edit another section yourself and save first: the patch still applies and says
  `rebasedOver`.
- **Reply-to (#61, the last open item of #62):** hover a message: **↩** shows beside its time (not
  over a code block's copy button). Click it: a chip above the composer quotes it (✕ cancels, a
  click on the text jumps to it). Send: your message shows the quote, and a click on the quote
  scrolls to the original and flashes it. Send two messages before the agent answers and ask it to
  answer each one separately: its reply arrives as one message per part, each quoting the message it
  answers, and each with its own **↩**. Reload the panel: the split parts and quotes come back the
  same. With two agents in a room, ↩ on each agent's reply jumps to that reply, not the other one.
- **Confirm card (#80):** ask an agent to `canvas_delete` a canvas. A 🔒 card with an amber double
  border appears in its turn, with 允許 / 拒絕; while it waits, other agents keep replying (nothing
  freezes). Open the canvas in a tab first and the card says so. Click 拒絕 → 已拒絕 and the agent
  gets `declined`; leave it 2 minutes → 已拒絕（逾時）; edit and save the canvas in its tab before
  clicking 允許 → nothing is deleted and the agent gets `changed while asking, not deleted`. 🧹 清除聊天
  while a card waits → the agent gets `declined`.
- **Canvas eviction without filling 200 MB:** in the side panel's DevTools console, run
  `chrome.storage.local.set({ "canvas:budgetBytes": 2 * 1024 * 1024 })`. The budget is now 2 MB, so a
  few image canvases trigger the eviction prompt (a 🔒 confirm card in the chat). Run `chrome.storage.local.remove("canvas:budgetBytes")`
  to go back to 200 MB. Both take effect without a reload. Values under 1 MB are ignored, and
  values over 200 MB are capped at 200 MB.
- **Canvas gallery (ADR §3.7):** 🗂️ in the panel header (or **🗂️ 總覽** in a canvas tab) opens
  `canvas-gallery.html`; a second click focuses that tab instead of opening another. Every canvas
  is listed, newest first; typing filters by title, then by content (markdown / slides). A row opens
  the canvas like its chat card (its open tab, else a new tab in the Canvas group); with the panel
  closed it opens ungrouped beside the gallery and says so. 🗑 asks first, then the canvas's open
  tab closes and the row disappears; an agent write elsewhere updates the list live.
- **Not in incognito (#109):** chrome://extensions → Details has no *Allow in Incognito* switch,
  and an incognito window has no Katashiro action or side panel. Leftovers:
  on the previous version, with Katashiro allowed in incognito, write a canvas from an incognito
  panel; after loading this version (an update fires `onInstalled`) it is gone from storage, the
  service worker's console logs "removed 1 canvas(es) left by incognito windows", and the normal
  window's canvases are all still there.
- **◐ 顯示變更 (ADR §3.10):** open a markdown canvas in two tabs (or two canvases) and click
  **◐ 顯示變更** in one: it turns green (`aria-pressed="true"`) in both. Ask the agent to change a
  paragraph: the changed block stays outlined (a removed one keeps its red line) instead of fading
  after ~4 s. The markers always show **previous version → latest, whoever wrote it**: save an
  edit of your own and they move to your edit only; a second agent write moves them to that
  write's changes. Turn it off: the markers go, and the next agent write fades as before; turn it
  on again: they come back at once. Reload the tab: the same blocks are marked (the previous
  version is stored). On a fresh v1 canvas nothing is marked and the switch's title says there is
  no previous version. While ✏️ editing nothing is marked; with ⇆ Compare open its
  markers show instead, and these come back when the compare tab closes. The compare tab has no
  switch; image canvases neither. Reload Chrome: the switch keeps its state.
- **Mermaid diagrams (ADR canvas §3.3):** ask the agent for a markdown canvas with a ```` ```mermaid ````
  flowchart, a sequence diagram and one deliberately broken diagram. The two good ones are drawn
  (dark theme). The broken one shows a red `mermaid diagram N: Parse error …` box above its source,
  the rest of the canvas is fine, and the header offers **送給 agent 修**, which posts the error to
  the chat. In the chat bubble the same fences stay code. Hover a diagram: **copy** copies its
  source. Then check:
  - 🖨 PDF: the diagrams print on white in mermaid's light theme, and are dark again afterwards.
  - Ask the agent to change one diagram: only that diagram glows. With ◐ 顯示變更 on, it stays
    marked.
  - ✏️ Edit: the diagram is a plain code block in Milkdown. Save, leave edit, and it is drawn again.
  - `canvas_open kind:"mermaid"`: one diagram fills the tab. The header shows ⬇ .mmd (the raw
    source) and 🖨 PDF, but no ✏️. The gallery lists it as 🔀 Mermaid 圖表.
  - A slide with a fence draws the diagram across the slide width.
  - A canvas without a diagram never loads `vendor/mermaid/mermaid.tiny.js` (DevTools → Network,
    in the canvas frame).
  - `click A "https://example.com"`: clicking node A asks before opening the link in a new tab,
    and the canvas frame does not navigate. `click A callback` does nothing (`securityLevel: 'strict'`).
  - The canvas frame's console shows no CSP errors.
- **Version history, ↶ / ↷ (ADR §3.5):** Settings → **畫布版本紀錄** shows 10; type 0 or 99
  and leave the field: it shows 1 or 50 (type 10 again afterwards). Let the agent write a markdown
  canvas, then save three edits (v1 agent, v2–v4 yours). In the canvas header **↶** is enabled and
  **↷** disabled (hover: "只在按過 ↶ 之後可用"). Click ↶: the canvas shows v3's text, the header
  says v5（你的修改） and the notice flashes "↶ 回到 v3 的內容（存成 v5）". ↶ again → v2's text as v6;
  ↷ → v3's text as v7; ↷ → v4's text as v8, and ↷ is disabled again. ↶ down to v1 (the agent's)
  disables ↶. Save an edit: ↷ is disabled (the walk ended) and ↶ starts again from your save. The
  ↶ / ↷ buttons are hidden while ✏️ editing, in a ⇆ compare tab, and on mermaid / image canvases.
  With the folder mirror on, each step rewrites the `.md` file. **Revert to agent's** now says
  "之後可以按 ↶ 回到你目前的內容。" and ↶ after it brings your text back. Set N to 2, save a few
  more edits: in DevTools (canvas tab) `chrome.storage.local.get(null)` shows only
  `canvas:<id>:v:<n>` keys for the versions in `meta.history` (the previous one plus the agent's
  last write, which is never trimmed), and the gallery's size column shrinks accordingly. An
  agent write with a stale `baseVersion` that is one of your saves still in history returns a
  `diffFromBase`. A canvas created before this version (no `meta.history`) keeps working: ↶
  reaches its agent copy, and its next save moves `canvas:<id>:agent` to `canvas:<id>:v:<n>`.
  With an image canvas rewritten twice, the first image survives the 10-minute image sweep while
  its version is in history.
- **Editing a canvas (ADR §3.5):** ✏️ Edit a markdown canvas, press Enter a few times between two
  paragraphs and Save: the notice says nothing changed (markdown keeps no extra blank lines) and the
  empty lines disappear from the editor too, with the cursor where it was (#103) — also when it was
  at the start of the next paragraph, which it keeps; Ctrl+Z then undoes your typing, never brings
  the blank lines back.
  Esc leaves edit mode with one press, also with the cursor in a table cell and the pointer resting
  on the table (#104); with the slash menu (`/`) or the link editor open, Esc only closes it.
