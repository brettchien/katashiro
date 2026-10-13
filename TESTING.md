# Testing Katashiro Browser Tools (MCP-over-ACP)

Katashiro is the **extension (client) side** of MCP-over-ACP browser control. The OpenAB
server side is deployed (Falcon) and the full loop is e2e-proven with a mock browser — loading
katashiro in Chrome replaces the mock with a real browser so the agent operates your live tab.

## Automated tests

Before the manual checks below, the automated ones (CI runs both on every PR and push to `main`):

```bash
npm test                                   # unit tests (node --test), no Chrome needed
npm ci && npm run chrome && npm run smoke  # the puppeteer smokes in a pinned headless Chrome
npm run chrome:full && npm run e2e         # T2 E2E: the real extension + side panel against a fake gateway
```

Details, and the `CHROME` / `PUPPETEER_CORE` overrides: [README → Run the tests](README.md#run-the-tests).
The E2E cases, how they work and their limits: [e2e/README.md](e2e/README.md). Manual items below
marked **(E2E: …)** are covered there in real Chrome against a fake gateway; with a real agent they
are still worth a look after a gateway change.

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
  folder, then let the agent write a canvas: `<folder>/<7-char id>-<conversation title>/<title>.md` appears, plus
  `.katashiro/<id>.json`. Edit the `.md` in an editor and save in the canvas: the file is left
  alone, a `<title>.katashiro-<UTC time>.md` appears beside it, and the canvas header shows
  "📁 檔案在 Katashiro 外被修改過". Delete the `.md` and reopen the canvas tab: "📁 檔案已刪除，不再同步", and
  later saves leave the folder alone; **📁 重新寫入** writes it again and mirroring resumes. Do it once without editing the canvas after the
  delete (unchanged content): the file must still come back, with "📁 已重新寫進資料夾，恢復同步". Delete it
  again, put the same text back outside (or `git checkout`), click 重新寫入: "資料夾裡的檔案已經是最新的，恢復同步"
  and the header leaves the deleted state. Delete, put different text back, click: the file is left
  alone and the notice names the `.katashiro-<time>.md` conflict copy. Restart Chrome: the canvas header shows **📁 Reconnect folder**
  (unless Chrome kept the grant); saves made before reconnecting are written after it.
- **Mirror renames by `move()` (#101, multi-conversation §7):** with the folder mirror on and a
  conversation holding a markdown canvas and an image canvas:
  - **Canvas rename:** ask the agent to rename the markdown canvas (`canvas_open` with `id` and a
    new title). In the folder the `.md` is renamed (same file: an editor or `git status` shows a
    rename, not delete + add) and holds the latest; no old file is left. Rename the image canvas:
    `<old>.assets/` is gone, `<new>.assets/` holds the image, the `.md` links it.
  - **Outside edit moves with it:** edit the `.md` in an editor and save, then rename the canvas: the
    edited text is in the renamed file, not overwritten; the latest is in a
    `<new-slug>.katashiro-<time>.md` beside it and the header says "📁 檔案在 Katashiro 外被修改過".
  - **Conversation rename:** double-click the conversation's tab and rename it (or let the agent call
    `set_title`). About 10 s later (not at once) the folder `<id>-<old title>` is replaced by
    `<id>-<new title>` holding the same files. Rename twice within a few seconds: one move, straight
    to the last name. Put a `notes.txt` of your own in the conversation folder first: it is never
    moved, and the old folder stays with only that file in it.
  - **Existing `c_…` folders** (written before this change): open the panel; its catch-up moves them
    to `<id>-<title>` (a canvas whose file you had deleted is not brought back).
  - **Existing target name:** create `<conversation folder>/x.md` yourself, then have the agent rename
    a canvas to "x": your `x.md` is untouched (the canvas becomes `x-2.md`). To hit the check in
    `move()` itself, create the target right before a rename lands (e.g. rename the conversation and,
    within the 10 s, create `<id>-<new title>/<canvas>.md`): that file is untouched, the canvas's
    latest goes to a `.katashiro-<time>.md` beside it and the old file stays in the old folder.
  - **VS Code holding the file open:** with the `.md` open (unsaved changes, and once with none) in
    VS Code, rename the canvas. Note whether `move()` succeeds (VS Code then shows the file as
    deleted or follows it) or fails: on failure the new name must still get the latest (written fresh)
    and the old file is removed only if unchanged. On Windows also try a program that locks the file.
  - **Interrupted move:** rename a conversation with many canvases and close Chrome (or revoke the
    folder permission in the site settings) right after the 10 s; reopen and reconnect: the next sync
    finishes the move (no file left in the old folder except your own, nothing duplicated), and
    `meta.file.move` is gone from each canvas's meta (`chrome.storage.local`, DevTools).
- **canvas_patch and Ask agent (ADR §3.5, §3.7):** with a markdown canvas open, select a sentence:
  **💬 Ask agent** appears in the header (not in a compare tab, not while editing, gone when the
  selection is cleared). Click it, type a request in the popover, Enter: the chat shows your request, then
  `[canvas "…" (cv_…) vN, text selected by the user …]` and the selection in a fence. Ask the
  agent to change it with `canvas_patch`: exactly the changed words glow (inline, not their
  paragraph; a deleted paragraph leaves a red line on the next one), the card shows the new
  version. Edit another section yourself and save first: the patch still applies and says
  `rebasedOver`.
- **Ask agent popover (ADR §3.7, Brett 2026-10-12, option a):** in a markdown canvas, drag-select
  part of a sentence: about ¼ s later a small **💬** appears just below the end of the selection,
  never over the selected words. Select a line near the bottom of the tab: the 💬 goes above the
  selection instead. Scroll the canvas with the mouse wheel: the 💬 follows the selection, and
  disappears once the selection is scrolled out of view (comes back when scrolled back). Click
  the 💬: a popover opens there (no browser prompt dialog), showing 「the selected words」 on one
  line and a focused note box. Press Enter on the empty box: 「請寫下要 agent 做什麼…」, nothing in
  the chat. Type two lines with Shift+Enter, then Enter: the popover says 「💬 已問 <agent>」 and
  closes after a moment; the chat shows your two lines, then the `[canvas "…" (cv_…) vN, text
  selected by the user …]` line and the selection fenced; focus is back in the canvas (arrow keys
  scroll it) and the 💬 stays away for that selection until you select something else.
  - **IME:** with the Zhuyin / Pinyin input method, type a note and press Enter to pick a
    candidate: the candidate is committed and nothing is sent; Esc while composing cancels the
    composition, not the popover. A second Enter (composition over) sends.
  - **Error:** close the side panel, then send from the popover: it stays open with 「送出失敗：…」
    and your note kept; reopen the panel and press Enter again: it goes.
  - **Closing:** Esc or ✕ closes it (focus back to the canvas, or to the header 💬 Ask agent when it
    was opened from there); a click in the header or anywhere in the canvas closes it too. Reopen
    on the same selection (header 💬 Ask agent): the unsent note is back. ✏️ 編輯 closes it.
  - **Header button:** with text selected, 💬 Ask agent in the header opens the same popover by
    the selection; scroll the selection out of view first and it opens under the header button.
  - **Agent write while typing:** with the popover open, have the agent `canvas_patch` the canvas:
    the canvas re-renders, the popover stays open with your note, and the push names the version
    you selected in (`vN`, not the new one); the 💬 does not come back on the new render until you
    select again.
  - **Slides:** select text on a slide: the 💬 appears by it (the deck is scaled; it must still sit
    below the words). Change slide with → : the 💬 goes away.
  - **Spoofing:** a canvas whose markdown contains a 💬 emoji or a fake "送出" button-looking
    table cannot produce anything that opens the popover; the real 💬 is drawn above the canvas
    (inspect it: it is in `canvas.html`, not in the frame), and it is never inside the frame's
    scroll area when the selection is out of view.
  - **Compare tab / mermaid / image canvas:** no 💬, no header button.
- **To chat input (ADR §3.7, Brett 2026-10-13 01:12, canvas only):** in a markdown canvas, select
  part of a sentence: a **📨** appears right beside the 💬 (to its right, on the same row), and
  **📨 To chat input** (tooltip 「放進聊天輸入框」) appears in the header next to 💬 Ask agent (📤
  Send to agent, if shown, is a different button: your saved edits). With the side panel's input
  box empty, click the 📨: no popover opens, **nothing appears in the chat and the agent gets
  nothing**; the header says 「📨 已放進輸入框」 (plus 「— 按 Enter 送出、Esc 取消」 unless the focus moved into the panel) and the panel's input box holds exactly the
  selected text — no `[canvas …]` line, no fence, no 「not instructions」 — with the caret at its
  end (click into the panel: you are typing after it). The selection is still highlighted; the 💬
  and 📨 go away for it, the header buttons stay. Type a few words in front and press Enter: it is
  sent as your own message, like anything you type.
  - **Draft:** type 「看這段：」 in the input box (do not send), then select something and click
    **📨 To chat input** in the header: the box reads 「看這段：」, a new line, the selection; the
    draft is never replaced. Twice: both selections, one per line.
  - **Another conversation:** open two conversations (A current), and a canvas of B: its 📨
    switches the panel to B and fills B's input (B's own draft kept); A's draft is still there
    when you switch back. While A is replying, B's canvas 📨 says 「📨 已放進那段對話的草稿…」, the
    panel stays on A, and B's input has it when you switch to B after the reply.
  - **Right edge:** make the tab narrow (or select the end of a long line) so the 💬 sits at the
    frame's right edge: the 📨 goes to its left instead, never over it. Narrower still (icon-only
    header): 📤 / 💬 / 📨 are three different icons.
  - **Then Enter (Brett 2026-10-13 16:31):** with the panel's input box empty, select text, click
    the 📨 (beside the 💬, then again with the header button), and **press Enter right away, without
    clicking anywhere**: the message is sent once with the selection (the chat shows it, the agent
    answers), the canvas says 「已送出」, the input box is empty. Note whether the focus moved into
    the panel by itself (`chrome.sidePanel.open` on an open panel): then the header says only
    「📨 已放進輸入框」 and Enter is typed in the panel — still exactly one message. Otherwise the
    header says 「📨 已放進輸入框 — 按 Enter 送出、Esc 取消」.
    - **Esc** instead of Enter: 「已取消」; the text stays in the input box; a later Enter in the
      canvas sends nothing.
    - **Shift+Enter**, another key (an arrow, a letter), a click anywhere, a new selection, ✏️ 編輯,
      switching to another tab and back, or waiting 30 s: the hint goes, Enter sends nothing.
    - **IME:** with a Chinese/Japanese input method on, an Enter that picks a candidate sends nothing.
    - **Draft case** (A replying, B's canvas): 「…草稿（側邊欄沒切到那段對話，Enter 不會送出）」;
      Enter sends nothing. After 📨, click a conversation tab in the panel: the canvas loses the
      focus and the hint goes; back in the canvas, Enter sends nothing.
    - **Focus in the canvas content:** after 📨, click the canvas (that disarms), select again, 📨,
      then Tab until the focus is in the canvas and press Enter: nothing (Tab disarmed it).
  - **Double click:** double-click the 📨 quickly: the selection goes in once, not twice.
  - **Too long:** select over 20 KB (select all in a very long canvas): 「選取的文字超過 20 KB，沒
    放進輸入框…」; the input box is untouched.
  - **Error:** close the side panel and click 📨 To chat input: 「這個視窗的 Katashiro 側邊欄沒開…」
    with 打開側邊欄; nothing goes anywhere, and the button works again after reopening the panel.
    An archived conversation's canvas: 「沒放進輸入框：這段對話已封存…」.
  - **Hidden:** clear the selection, enter ✏️ 編輯, or open a compare tab / mermaid / image canvas:
    no 📨 anywhere. With the Ask popover open, the 📨 beside the selection is hidden too.
- **Ask agent: where the selection is (ADR §3.7, Brett 2026-10-12 17:43):** have the agent write a
  markdown canvas with `# 計畫`, `## 決定紀錄`, `### 2026-10-12` and a two-line paragraph under it,
  wait for it to settle (the editor's normalization re-renders it once), then select one common
  word in that paragraph and ask with any note. The pushed chat message's host line reads
  `… text selected by the user in 「計畫」 › 「決定紀錄」 › 「2026-10-12」, lines N–M of the canvas content — as rendered …`;
  ask the agent to `canvas_read` and quote lines N–M: they are exactly that paragraph. Then:
  - select a word above every heading: no `in …` part, lines still there;
  - select from one paragraph into the next: the range covers both;
  - a slides canvas: `on slide K in <that slide's heading>`, and lines N–M are that text in the
    whole deck as `canvas_read` returns it;
  - open the popover, then (before sending) let the agent write a new version: the line names the
    captured `vN` with the heading path but **no** `source lines` (they would point into another
    text); same right after an agent write while its normalization lands.
- **Reply-to (#61, the last open item of #62):** hover a message: **↩** shows beside its time (not
  over a code block's copy button). Click it: a chip above the composer quotes it (✕ cancels, a
  click on the text jumps to it). Send: your message shows the quote, and a click on the quote
  scrolls to the original and flashes it. Send two messages before the agent answers and ask it to
  answer each one separately: its reply arrives as one message per part, each quoting the message it
  answers, and each with its own **↩**. Reload the panel: the split parts and quotes come back the
  same. With two agents in a room, ↩ on each agent's reply jumps to that reply, not the other one.
  Send two short messages within one second (e.g. `` ` `` then `2`) and ask the agent to answer the
  first: its quote shows the first, not the second (headers carry milliseconds,
  `[2026-10-12T14:54:11.234+08:00 user]`, and a `↩` with milliseconds matches only that message; a miscopied one falls back to its second only when that second holds a single message).
- **Confirm card (#80):** ask an agent to `canvas_delete` a canvas. A 🔒 card with an amber double
  border appears in its turn, with 允許 / 拒絕; while it waits, other agents keep replying (nothing
  freezes). Open the canvas in a tab first and the card says so. Click 拒絕 → 已拒絕 and the agent
  gets `declined`; leave it 2 minutes → 已拒絕（逾時）; edit and save the canvas in its tab before
  clicking 允許 → nothing is deleted and the agent gets `changed while asking, not deleted`. 🧹 清除聊天
  while a card waits → the agent gets `declined`.
  Ask it to `canvas_delete` two canvases in one turn and press ⏹ while the first card waits: that
  card turns 已拒絕（回合已結束）, and no second card opens — a one-line notice says the agent's turn
  had ended and the delete was not carried out, and both canvases are still there. A card shown on
  its own row (the eviction prompt between turns, if you can trigger it) sits left-aligned and full
  width, not on the right like your messages.
- **Ask card (`katashiro.ask_user`, ADR ask-user):** ask an agent to "ask me with ask_user which
  of A / B / C". A card titled **<agent> 問你** with a 💬 and an indigo border (no 🔒, not the amber
  double border) shows in its turn, and the agent ends its turn without waiting. Click B → the card
  reads 已回答：B and the agent gets a new turn starting `↩ 回答 ask_…：B`. With `multi: true`, 送出
  stays disabled until a box is ticked; with `allowOther: true`, the 其他… box answers with
  （其他）<text>. Ask with `timeoutSec: 30`, close or hide the side panel for a minute, then show it
  again: the card is still open, and closes as 未回答（逾時）about 30 s of *visible* time later, with
  nothing sent to the agent; opening Settings also pauses it. Send a normal message while a card is
  open → 未回答（你送了別的訊息）, and only your message reaches the agent. 🧹 清除聊天 → 未回答（聊天已清除）.
  Switch the active agent → 未回答（agent 已中斷連線）. A question or label with a line break shows as one
  line. Ask for a 4th open question → the agent gets an error. Answer while the agent's turn is
  still running → the answer is queued and sent when the turn ends. Choosing "delete it" deletes
  nothing by itself; a real `canvas_delete` still shows its own 🔒 card.
- **Drop files on the chat (#85, ADR chat-attachments):** drag a `.md` file over the side panel:
  the whole chat area shows a dashed **放開以附加檔案** overlay (not over Settings; nothing happens when
  you drop on the header or on a canvas tab). Drop it → a 📎 chip with name and size above the input;
  × removes it. Send with some text → your bubble shows the text and the chip, and the agent (ask it
  to echo what it got) receives the text, then `📎 name（size）` and the file in a fenced block with
  `markdown` as the language; a file that itself contains ```` ``` ```` fences gets a longer
  fence. Reload the panel → the message shows `[file: name, size]`, not the content. Drop a PNG renamed
  to `.txt` → it is staged as an image thumbnail (bytes decide, not the name); drop a `.zip` or
  `.pdf` → 不支援的檔案類型（看起來是二進位檔）. Drop 12 files at once → 10 are staged, the
  rest named in a notice. Settings → 附加檔案: set 檔案大小上限 to 1 MB and drop a 2 MB file →
  refused at drop. Set the text cap to 1 KB, drop a 3 KB text file, send → nothing is sent, a
  notice explains, and text, chip and reply-to stay; remove the chip → it sends. Two 600 B files
  with a 1 KB cap → refused as a total. With an ask card open, send a message with a chip → the card
  closes 未回答（你送了別的訊息） as with any message. Reply (↩) to a message and attach a file →
  the quote and the file go together. A UTF-8 file with a BOM, a Big5 file (refused as not UTF-8,
  or as binary) and a coloured log with a few ESC codes (accepted) cover the text heuristic.
- **Canvas eviction without filling 200 MB:** in the side panel's DevTools console, run
  `chrome.storage.local.set({ "canvas:budgetBytes": 2 * 1024 * 1024 })`. The budget is now 2 MB, so a
  few image canvases trigger the eviction prompt (a 🔒 confirm card in the chat). Run `chrome.storage.local.remove("canvas:budgetBytes")`
  to go back to 200 MB. Both take effect without a reload. Values under 1 MB are ignored, and
  values over 200 MB are capped at 200 MB.
- **Canvas gallery (ADR §3.7):** 🗂️ in the panel header (or **🗂️ 總覽** in a canvas tab) opens
  `canvas-gallery.html`; a second click focuses that tab instead of opening another. Every canvas
  is listed, newest first; typing filters by title, then by content (markdown / slides). A row opens
  the canvas like its chat card (its open tab, else a new tab in its conversation's group); with no
  panel showing that conversation it opens ungrouped beside the gallery and says so. The 對話 column
  shows the conversation's title. 🗑 asks first, then the canvas's open
  tab closes and the row disappears; an agent write elsewhere updates the list live.
- **Multi-conversation (ADR multi-conversation, MVP §3).** Headless first:
  `node scripts/smoke-multi-conversation.mjs` (setup: see [Automated tests](#automated-tests)) drives the real side panel and gallery with
  stubbed `chrome.*` and a fake agent (migration, tab strip, sessions, U2 line, picker, Web Lock,
  archive, gallery reopen). In Chrome, with a real agent:
  - **Upgrade:** load this build over an older one that has chats in two windows (and one closed
    window's chat): each window opens on its own chat (title = its first message, time on the tab),
    the closed window's chat is in 🗂️ → 對話 (or open, if it fit under 3); the first reply after
    the upgrade says it was reconnected or simply continues (the U2 line is in the prompt, never in
    the chat). DevTools: no `history:` keys left; `conv:schema` is 1.
  - **Tab strip:** ＋ opens 未命名 <7 hex>; send a message: the tab takes its first 40 characters.
    Double-click a tab, type a name, Enter: kept after more messages; an empty name goes back to
    the auto title. Switch tabs: each keeps its scroll position, cards and ↩ buttons; the roster
    chip says 握手中 → 已連線 and the chat says 已續接 the first time per connection. Long titles end
    in … with the full title on hover.
  - **Turn guard:** while the agent replies, clicking another tab, ＋ or × on the current tab
    shows 「回覆中不能切換——等回完或先按 ⏹ 停止」; after ⏹ it works. Stop a turn in A, switch to
    B at once: nothing from A's late output appears in B (DevTools console: "dropped a session/update").
  - **3 open across windows:** (E2E: the replying one disabled, and window 2's pick of it refused
    with 回覆中不能封存 — `p2-background-turns.mjs`) with 3 tabs in window 1, ＋ shows the picker (a neutral card, not an
    agent's) listing the 3; a replying one is disabled; 取消 opens nothing. In window 2, open the
    panel: the picker lists window 1's conversations as （另一個視窗）; 取消 leaves 前往「…」 buttons
    that focus window 1; picking one archives it in window 1 (its tab goes away there) and window 2
    gets a new conversation.
  - **One window per conversation:** close window 2's panel, give window 2's record a
    conversation window 1 has open (or race two panels): window 2 says 這段對話開在另一個視窗 with
    a 前往那個視窗 button.
  - **Archive and reopen:** × on a conversation with messages: it appears in 🗂️ → 對話 (已封存,
    canvas count, time); × on an empty one: it is gone (not listed). 重新打開 with the panel open:
    the panel switches to it and resumes its ACP session (same id in the chip tooltip); with the
    panel closed: the panel opens and then switches to it. With 3 open, 重新打開 shows the picker
    in the panel first. Search filters conversation titles too.
  - **Cards:** an ask card in A, switch to B: its clock stops (the hint's seconds do not run
    down), it is still pending when you come back; sending a message in B leaves it pending; × on A:
    the card is gone with A (internally `archived`). Make another agent active: A's and B's cards
    close as agent 已中斷連線.
  - **Canvas:** the canvas group is named after the conversation and follows a rename. From the
    gallery, a canvas of an open but not current conversation opens in that conversation's group
    without switching; Send to agent from it switches to its conversation first (refused while the
    current one replies); from an archived conversation's canvas tab: 「這段對話已封存，先從總覽重新打開」.
- **Reconnect hint (A′) and disconnect diagnostics (E) (ADR browser-tunnel-liveness §9).** The
  headless smoke above covers a quick unclean drop and a quick reconnect after a clean close. In Chrome, with a real agent, keep the side panel's
  DevTools console open (it logs `socket open — same run / new run`, `disconnect — …` and
  `reconnect hint added / skipped (reason)`); "the line" below is the U2 host line
  `[katashiro: this conversation was just reconnected…]`, which the agent sees but the chat does not
  — ask the agent whether its last prompt started with it, or read the console.
  - **Quick blip:** chat a turn; turn Wi-Fi off, wait ~40 s (the chip goes to reconnecting), turn
    it on: within a few seconds it reconnects (`same run`); the next prompt has **no** line
    (`skipped (session intact …)`).
  - **Slow drop:** turn Wi-Fi off for **more than 2 min**, on again: `new run`; the next prompt
    **has** the line (`last reply before this connection run`).
  - **Panel reload:** reload the side panel (close and reopen it, or DevTools → reload): the next
    prompt **has** the line (a new run — Katashiro cannot know what happened meanwhile).
  - **Switch / reopen:** with two conversations both used in this run, switch between them and
    send: **no** line in either. Archive one and 重新打開 it from 🗂️: **no** line. A conversation last
    used before the panel was reloaded, or last answered more than 1 h ago: the line.
  - **Pending survives a drop:** after a panel reload (line pending), do not send; blip Wi-Fi for
    ~40 s; then send: the line is **still** there (`still pending from before`).
  - **Diagnostics:** after the drops above, ask the agent to call `katashiro.client_info`: it ends
    with `recent disconnects (newest first):`, one line per drop (close code, e.g. 1006 unclean,
    the frame gaps, `→ auto-reconnect in 0ms; reopened after …, same run / new run`, failed retries
    during the slow drop). Reload the panel and ask again: the same lines are still there
    (storage.session). DevTools: `chrome.storage.session.get("katashiro.diag.disconnects")` holds
    ≤ 20 records.
  - **Restart / deploy:** restart openab (or redeploy its ECS service) while the panel is connected:
    the drop is a clean close (e.g. 1001 / 1012, `clean` in the record) → `new run (previous end:
    clean)` even though it reconnects within seconds; the next prompt **has** the line. If the record
    says `unclean` and `same run` instead, that is the known gap below — note the code in the PR.
  - **Backoff (C, §9.5):** in the quick blip, the console's `disconnect — …` line says
    `→ auto-reconnect in 0ms` and the reconnect follows the moment Wi-Fi is back. During the slow
    drop, the failed attempts space out (DevTools Network → WS: about 1, 2, 4, 8, 16 s apart, then
    every ~30 s), not every 5 s. After the restart / deploy above (a clean close) the record says
    `in 1s` (±20 %).
  - **Turn off:** turn the agent's conn off (or make another agent active): `client_info` (from
    another agent) lists `closed by Katashiro (conn turned off) … → none`.
  - **Known gap:** an openab restart in under 2 min whose socket drops **without** a close frame
    looks like a quick blip, so the line is skipped even though the agent lost its session (fix: an
    openab boot id, proposal A).
- **Multi-conversation P1b (ADR multi-conversation §4).** The headless smoke above covers the
  rules on a model of tabs and groups; in Chrome (155+ for Split View), with act mode on:
  - **Group per conversation:** (E2E: `p2-tab-groups.mjs`, `working-tab-canvas.mjs`) ask the agent to open a page with `new_tab` (background): it joins
    the conversation's group, named after the conversation, next to its canvases. Open a tab
    yourself and have the agent read it: it is not pulled into the group. Drag a group tab out:
    archive later does not close it. A canvas shown beside a page (`beside: "current"`) still
    follows the canvas Split View rules (both sides' group state stays consistent).
  - **Q5:** (E2E: `p2-tab-groups.mjs` — moved to the new conversation's working tab, no group
    collapses; a group collapsed by hand is expanded by a background tool, not yet by a switch) with A's group tab active, ＋ or switch to B: a tab outside A's group becomes active
    (B's working tab, else B's last-used group tab, else your last-used ungrouped tab). A's group
    stays expanded; B's group is expanded (collapse it by hand first to see it reopen). No group
    collapses on any switch; only × (archive) closes a group's tabs.
  - **Q6:** (E2E: `working-tab-canvas.mjs` — canvas_highlight / canvas_goto, then send) after the agent worked on a tab, click another tab, type and send: the working tab comes
    to the front at that moment, never while the agent is replying. `switch_tab({tab: "working"})`
    activates it too. Answering an ask card or pushing from a canvas does not switch tabs.
  - **Q12:** (E2E: ❓ and the notification created — `p2-background-turns.mjs`; its click is not
    covered) while an ask card waits in A, switch to B: A's tab shows ❓ and an OS notification
    「Katashiro：有問題等你回答」 appears; clicking it focuses the window and switches to A; once the
    card is answered or closes, the ❓ goes.
  - **Drafts:** type half a message and paste an image in A, switch to B (empty composer), back to
    A: the text and the image are there. Paste a large image and switch while it encodes: it lands
    in A's draft, not in B.
  - **set_title:** after the first exchange the agent renames the tab and the group (titleSource
    agent); double-click rename it yourself, ask the agent to rename again: refused, your name stays.
  - **Archive closes, reopen restores:** in A, have an agent tab and a canvas tab in the group; edit
    the canvas without saving; × on A: the agent tab closes, the dirty canvas tab stays (collapsed)
    and the chat says so. Save and close it. 🗂️ → 對話 → 重新打開 A: the agent tab and the canvas
    tab come back in the background, in one group. With the window's only tabs in the group, × opens
    a New Tab page first (the window must not close).
  - **Browser restart:** with A open and its group holding two tabs, quit Chrome (Cmd/Ctrl+Q) and
    start it again (with "continue where you left off" and without): open the panel; A's tabs are
    in A's group, the ones Chrome restored adopted rather than duplicated.
  - **Canvas push refusals:** open A in window 1, close window 1's panel; from A's canvas tab in
    window 2 (panel open), Send to agent: 「這段對話開在另一個視窗，那個視窗的側邊欄沒開…」 with a
    「前往那個視窗」 button. Close window 2's panel too and push again: the canvas header says
    「這個視窗的 Katashiro 側邊欄沒開」 with 打開側邊欄, which opens it; send again. With the
    conversation open in another window's panel, the push goes there and the canvas says
    （在另一個視窗）.
  - **Q4 b order:** while the agent's turn runs, send a message, then let the agent ask a card in
    the same turn: the card stays answerable (it came after your message); a card that was already
    pending when you sent closes as 未回答（你送了別的訊息）.
  - **Browser restart:** quit Chrome with chats open in two windows, restart: each restored window
    opens on its conversations (as many as fit under 3), the rest are in 對話.
  - **Downgrade:** load the previous release over this one: it starts empty; chat a bit; load this
    build again: that chat is one more conversation (open if it fits, else in 對話); nothing lost.
- **Deleting a conversation (ADR multi-conversation §7.1).** The headless smoke covers the gallery
  flow (confirm text, lock refusal, what goes and what stays, stale reopen, finishing a cut-short
  delete); the unit tests cut the delete short at every storage write. In Chrome:
  - **What it says:** in conversation A have the agent write two canvases (one updated twice, one
    image canvas) and, with Settings → 畫布存到資料夾 on, let them reach the folder. × on A. 🗂️ →
    對話 → 🗑 刪除 on A: the dialog names A and lists the message count, 2 canvases with their
    stored versions and the image, the agent session line, 「資料夾裡的畫布檔案不會被刪除。」 and
    「這個動作無法復原。」. 取消: nothing changes.
  - **What it does:** 確定: A leaves the 對話 list and its canvases leave the canvas list
    (「已刪除對話「A」和 2 個畫布。」); the folder still has A's files. In the side panel's DevTools,
    `chrome.storage.local.get(null)` has no `conv:<A>`, no `conv:index` entry for A and no
    `canvas:<id>:*` key of A's canvases; the image key is gone too if nothing else uses it and it was
    written more than 10 minutes ago (else it goes on a later save or delete). Another
    conversation's canvas that shows the same image keeps it.
  - **Tabs:** before 🗑, keep one of A's canvas tabs open with unsaved edits (× leaves it): after
    the delete it stays open with its text to copy out; a clean canvas tab of A closes itself.
  - **Open elsewhere:** open the gallery, then reopen A in window 2's panel without reloading the
    gallery; 🗑 on A's stale row: 「沒有刪除：這段對話開在另一個視窗：先在那裡封存再刪除」 with
    「前往那個視窗」, which focuses window 2. A stale 重新打開 of a deleted conversation says
    「這段對話已經刪除了」 in the panel and opens nothing.
  - **Changed while the dialog is open:** 🗑 on A, leave the dialog open; in another window reopen
    A, send one message, × it again; 確定: 「沒有刪除：這段對話在確認期間有變動：…」 and A is still
    there; 🗑 again shows the new count. Two gallery tabs: open both dialogs for A, 確定 in one, then
    確定 in the other: 「沒有刪除：找不到這段對話（可能已經在別的分頁刪除了）」.
  - **Interrupted:** in the gallery's DevTools, set a breakpoint in `finishDeletion` after the
    canvases are removed, click 🗑 → 確定, close the tab at the breakpoint. A is not in 對話
    (`conv:index` entry has `deletingAt`); open the gallery again (or the panel, or restart Chrome):
    the rest is removed.
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
- **Agent view switches (ADR canvas §3.11):** with two canvas tabs open, ask the agent to
  `canvas_view({showChanges: true})`: ◐ turns on in both, exactly as after a click; `false` turns it
  off. Edit and save a markdown canvas, then ask for `canvas_view({id, compare: true})`: its tab
  comes to the front and ⇆ Compare opens in Split View beside it with both panes marked, as from the
  button; asked again, it just focuses. Ask for it while ✏️ editing, on an image canvas, and on a
  canvas whose latest is the agent's own write: each is refused with the reason and nothing opens.
  With the canvas duplicated into two tabs, only the most recently used one opens a compare.
  `canvas_view({id, compare: false})` closes the compare tab and the canvas tab's markers clear.
  `canvas_gallery({query: "plan"})` opens (or focuses) 🗂️ with *plan* in the search box; asked again
  with another query the open tab's box changes without a reload. With the gallery tab active,
  `katashiro.screenshot` captures it; `snapshot` there is still refused.
- **Mermaid diagrams (ADR canvas §3.3):** ask the agent for a markdown canvas with a ```` ```mermaid ````
  flowchart, a sequence diagram and one deliberately broken diagram. The two good ones are drawn
  (dark theme). The broken one shows a red `mermaid diagram N: Parse error …` box above its source,
  the rest of the canvas is fine, and the header offers **送給 agent 修**, which posts the error to
  the chat. In the chat bubble the same fences stay code. Hover a diagram: **copy** copies its
  source. Then check:
  - 🖨 PDF: the diagrams print on white in mermaid's light theme, and are dark again afterwards.
    Edge labels (`|yes|`) sit on a solid white box: the edge line does not run through the text.
    A markdown table in the same canvas prints with thin grey borders and a light header row.
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
- **Canvas header in a narrow tab:** open a canvas you edited (v2（你的修改）) in a Split View half
  (or drag the window to ~600px). No button label breaks over lines: whole buttons move to a
  second row, and below ~720px 🗂️ ↺ ⇆ ◐ ✕ 📤 💬 show only their icon (hover gives the title; a
  screen reader still reads the full label). The version label stays on one line; a long title ends
  in …. At full width the labels are back.
- **Version history (ADR §3.5):** Settings → **畫布版本紀錄** shows 10; type 0 or 99
  and leave the field: it shows 1 or 50 (type 10 again afterwards). Let the agent write a markdown
  canvas, then save three edits (v1 agent, v2–v4 yours). In view mode the header has **no ↶ / ↷**
  (no version walking, Brett 2026-10-11); ◐ 顯示變更 marks v3 → v4. **Revert to agent's** says
  "這個動作無法復原。" (with the folder mirror on: the git wording). Set N to 2, save a few
  more edits: in DevTools (canvas tab) `chrome.storage.local.get(null)` shows only
  `canvas:<id>:v:<n>` keys for the versions in `meta.history` (the previous one plus the agent's
  last write, which is never trimmed), and the gallery's size column shrinks accordingly. An
  agent write with a stale `baseVersion` that is one of your saves still in history returns a
  `diffFromBase`. A canvas created before this version (no `meta.history`) keeps working: ◐ marks agent copy →
  latest, and its next save moves `canvas:<id>:agent` to `canvas:<id>:v:<n>`. A canvas whose meta
  still has a `walk` (from #117) opens normally, and its next save drops `walk`.
  With an image canvas rewritten twice, the first image survives the 10-minute image sweep while
  its version is in history.
- **Undo / redo while editing (ADR §3.5, the editor's own):** ✏️ Edit a markdown canvas: next to
  💾 儲存 and 結束編輯 the header shows **↶ 復原** and **↷ 重做**, both disabled (hover shows the
  shortcut: ⌘Z / ⇧⌘Z on a Mac, Ctrl+Z / Ctrl+Shift+Z elsewhere). Type a word: ↶ enables (within
  ~0.2 s). Click ↶: the word goes, ↷ enables, ↶ disables, and the cursor is still blinking in the
  editor — keep typing without clicking back in. Click ↷: the word is back. Ctrl/⌘+Z inside the
  editor and the buttons walk the same stack (the buttons follow after the key is released). Click
  the header's title (focus leaves the editor) and press Ctrl/⌘+Z: the editor still undoes. Save,
  then ↶: the text before the save comes back and 💾 enables again (nothing stored changes until
  you save). Leave edit mode and ✏️ Edit again: both buttons start disabled (a new editor, a new
  stack). In view mode, in a ⇆ compare tab, and on slides / mermaid / image canvases the buttons
  never show. With a clean editor open, let the agent write: the editor gives way to its version,
  and ↶ cannot take the agent's write back (Revert to agent's / ask the agent / git).
- **Editing a canvas (ADR §3.5):** ✏️ Edit a markdown canvas, press Enter a few times between two
  paragraphs and Save: the notice says nothing changed (markdown keeps no extra blank lines) and the
  empty lines disappear from the editor too, with the cursor where it was (#103) — also when it was
  at the start of the next paragraph, which it keeps; Ctrl+Z then undoes your typing, never brings
  the blank lines back.
  Click at the end of a paragraph, press Space a few times (or many, to scroll) and Save: the notice
  says nothing changed (no extra blank lines or spaces at a paragraph's end), and the 編輯中 / dirty
  state never lit up for the spaces. A hard break (Shift+Enter inside a paragraph) survives a save,
  and trailing spaces inside a code block are kept (`canvas_read` shows the stored text).
  Esc leaves edit mode with one press, also with the cursor in a table cell and the pointer resting
  on the table (#104); with the slash menu (`/`) or the link editor open, Esc only closes it.

## P2 prerequisite: two-session test

Multi-conversation P2 (ADR `docs/adr/multi-conversation.md` §5) assumes one `/acp` WebSocket can run
two ACP sessions at once, each with its own MCP-over-ACP tunnel. `scripts/acp-two-sessions.mjs`
checks that on a real gateway, with no browser and no npm dependencies (Node 22+):

```sh
ACP_TOKEN='<transport token>' node scripts/acp-two-sessions.mjs --url wss://<gateway>/acp
```

It opens one socket, creates sessions A and B (each declaring its own server, `probeA` / `probeB`,
serving one tool `whoami` that answers with a random nonce), sends both prompts back to back and
asks each agent to find `whoami` through `search_capabilities` / `execute_capability` and reply with
the nonce. **PASS** = both turns end with `end_turn`, each agent's `tools/call` arrived on its own
server's tunnel inside its own turn, each reply's `CAPS:` line names no other session's server,
each reply carries its own nonce and not the other's, the turns overlap and the later one was
already active before the first ended, and nothing failed with `-32001 Session busy` or
"pool exhausted". The exit code is 0 on PASS, 1 on FAIL.

Which rows actually decide it: isolation is the nonce rows and the `CAPS:` row; concurrency is
"later turn active before first ended" (the gateway relays only text chunks, sent once at the end,
so that row is in effect "the later turn's `tools/call` arrived before the first turn ended").
"turns overlap in time" and "calls inside own turn" nearly always pass when the prompts go out back to
back and the turns overlap — they catch gross breakage (e.g. a call after its own turn ended), not
serialisation or cross-talk.

- It starts real agent sessions: each running turn takes a broker pool slot (3, shared with
  Discord and usercron). Run it when the pool has room; "pool exhausted" is reported as such.
- The token is read from `ACP_TOKEN` only and never printed. `--sessions 3`, `--timeout SEC`
  (default 300; running turns get `session/cancel`), `--hold SEC` (how long `whoami` holds before
  answering, default 10, to widen the overlap), `--verbose` (every frame).
- It does not touch Katashiro's storage. The pure helpers are unit-tested in
  `test/acp-two-sessions-core.test.js`.
