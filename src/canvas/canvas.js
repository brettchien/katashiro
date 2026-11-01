// canvas.js — the trusted host of one canvas tab (canvas.html?id=<canvasId>), ADR §3.1–§3.2.
//
// It reads the canvas from chrome.storage.local, renders the title/version header with
// textContent, and hands the content to the sandboxed canvas-frame.html by postMessage. It never
// puts canvas content into its own DOM. Security rules (§3.2), all enforced here:
//  - the frame is loaded with a fresh nonce in its fragment, and only messages from that frame's
//    window carrying that nonce and an allow-listed type are accepted (CanvasCore);
//  - the load gate drops the frame on any load we did not cause (the frame navigated itself);
//  - render is sent only after a `ready` with the current nonce;
//  - links come back as openLink{url}: http(s) only, opened in a new tab after the user confirms.
// With `&view=agent` it is a compare tab (§3.10): the agent's last write, read-only — no Edit, Save,
// Send to agent, Ask agent, To chat input, Revert or delete, and its frame's save/dirty/selection/undoState are refused.
// An html canvas (canvas-html §2.3–§2.7): shown without its scripts in canvas-frame.html (selection,
// highlight and css as for markdown), or, after ▶ Run scripts, in canvas-html-frame.html, which gets
// its one render and then only highlight / css / selectionRequest (toFrame, CanvasCore.htmlFramePost).
(function () {
  "use strict";

  const TITLE_MAX = 120;
  const params = new URLSearchParams(location.search);
  const canvasId = params.get("id") || "";
  const compareView = params.get("view") === "agent";
  const CANVAS_BASE = chrome.runtime.getURL("canvas.html");

  const titleEl = document.getElementById("canvas-title");
  const versionEl = document.getElementById("canvas-version");
  const noticeEl = document.getElementById("canvas-notice");
  const noticeBar = document.getElementById("canvas-notice-bar");
  const noticeAction = document.getElementById("canvas-notice-action");
  const sendBtn = document.getElementById("canvas-send");
  const askBtn = document.getElementById("canvas-ask");
  const sendSelBtn = document.getElementById("canvas-send-sel");
  const downloadBtn = document.getElementById("canvas-download");
  const printBtn = document.getElementById("canvas-print");
  const mainEl = document.getElementById("canvas-main");
  const deleteBtn = document.getElementById("canvas-delete");
  const editBtn = document.getElementById("canvas-edit");
  const saveBtn = document.getElementById("canvas-save");
  const cancelBtn = document.getElementById("canvas-cancel");
  const revertBtn = document.getElementById("canvas-revert");
  const undoBtn = document.getElementById("canvas-undo");
  const redoBtn = document.getElementById("canvas-redo");
  const compareBtn = document.getElementById("canvas-compare");
  const endCompareBtn = document.getElementById("canvas-end-compare");
  const showChangesBtn = document.getElementById("canvas-show-changes");
  const runBtn = document.getElementById("canvas-run");
  const pageSelBtn = document.getElementById("canvas-page-sel");
  const engineBtn = document.getElementById("canvas-engine");
  const htmlHint = document.getElementById("canvas-html-hint");       // the chip (canvas-html §2.6)
  const htmlRisk = document.getElementById("canvas-html-risk");       // its tooltip, for aria-describedby
  // The compare tab's own way out (Brett, 2026-10-11): closing it ends the compare (§3.10).
  if (compareView) {
    endCompareBtn.hidden = false;
    endCompareBtn.addEventListener("click", () => closeThisTab());
  }
  const conflictEl = document.getElementById("canvas-conflict");
  const fileEl = document.getElementById("canvas-file");
  const reconnectBtn = document.getElementById("canvas-reconnect");
  const rewriteBtn = document.getElementById("canvas-rewrite");
  const convBtn = document.getElementById("canvas-conv");
  const moveBtn = document.getElementById("canvas-move");
  const store = CanvasStore.createCanvasStore({
    storage: chrome.storage.local,
    lock: (name, fn) => navigator.locks.request(name, fn),
  });
  // Folder mirror (§3.6): this tab writes its own saves to the folder, so it stays current with
  // the side panel closed. Only while Chrome already grants access; Reconnect folder asks.
  // An agent markdown write this tab is about to normalize is written once, normalized (#98): the
  // sync waits for it, bounded (CanvasMirror.createNormalizeHold). A dirty editor renders nothing,
  // so then there is nothing to wait for here.
  const normalizeHold = CanvasMirror.createNormalizeHold({
    rendering: () => !(mode === "edit" && dirty),
    retry: () => { syncFile(); },
  });
  const mirror = CanvasMirror.createCanvasMirror({
    storage: chrome.storage.local,
    lock: (name, fn) => navigator.locks.request(name, fn),
    getRoot: () => CanvasMirror.grantedRoot(),
    holdForNormalization: normalizeHold.hold,
  });

  let frame = null;
  let nonce = "";
  let frameReady = false;
  let current = null;                 // { meta, content } last read from storage
  // Editing (§3.5): "view" | "edit". While editing, a new version from elsewhere never replaces the
  // editor: a clean editor gives way, a dirty one keeps going and the save meets the conflict view.
  let mode = "view";
  let dirty = false;
  let deleted = false;                // the canvas is gone from storage (only kept on screen for unsaved edits)
  let ownSaveVersion = 0;             // the version our own save produced (not "news" to show)
  let pendingSave = null;             // content of a save that came back stale (for the conflict view)
  let conflictBase = 0;               // the version the conflict view showed: "keep mine" saves over it only
  let saving = Promise.resolve();     // saves run one at a time; refresh() waits for the one in flight
  let savesPending = 0;               // queued or running saves: archiving keeps the tab open meanwhile (§4.5)
  // The editor's undo stack as the frame last reported it (undoState{}, §3.5): the edit-mode ↶ / ↷.
  let editUndo = { canUndo: false, canRedo: false };
  const mac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");
  const gate = CanvasCore.createLoadGate();
  // html canvases (canvas-html §2.3–§2.4). frameProfile: which frame is mounted, and so which
  // messages it may send (CanvasCore.acceptFrameMessage): "canvas" (canvas-frame.html), "htmlStatic"
  // (canvas-frame.html showing an html canvas without its scripts) or "html" (canvas-html-frame.html,
  // after ▶ Run scripts). htmlRun: the revision whose scripts run, while the html frame is mounted.
  // ▶ Run scripts authorizes the canvas, not the revision (canvas-html §2.6, Brett 2026-11-01): the
  // grant lives in storage (CanvasStore.runGrantKey), so every tab of the canvas, a reload and the
  // agent's next revisions run without another click, each a fresh html frame with a new nonce.
  let frameProfile = "canvas";
  let htmlRun = null;                 // { version, content } | null: the revision it was started on
  let htmlRenderSent = false;         // the one render{} of this html frame's nonce went out
  let htmlAutoNote = "";              // this html frame's 「vN 已自動執行」 notice (§2.6), kept above its errors
  let htmlArm = null;                 // { token, timer }: the single-use expectation of the write's load
  let htmlOn = true;                  // Settings → html 畫布 (CanvasStore.HTML_ENABLED_KEY)
  // Pinned by e2e/cases/html-canvas.mjs (real Chrome 155): whether document.open/write/close in the
  // html frame fires the iframe's `load` again. The host expects that load always or never — never
  // "if it fires" at runtime (canvas-html §2.4). Always, since canvas-html §2.7: the frame now posts
  // ready only after its own load, and document.open on a loaded document fires a second load (before
  // that, whether the render beat the first load decided it — a race the first pin happened to win).
  // The expectation is armed with the render and dropped by that load or the timer, not by
  // rendered{}: the frame posts rendered{} right after close(), before the load comes. The timer
  // is HTML_RENDER_ARM_MS until rendered{} (the page's synchronous script runs inside write(): a
  // heavy page must not be taken for a navigation and lose its grant), then HTML_ARM_MS from it.
  const HTML_WRITE_FIRES_LOAD = true;
  const HTML_RENDER_ARM_MS = 30000;
  const HTML_ARM_MS = 5000;

  // A notice line, optionally with one action button (e.g. Send error to agent).
  // tag: the render a render-error notice belongs to ({seq, version}); any other notice drops it.
  let noticeActionFn = null;
  let noticeTag = null;
  function notice(text, action, tag) {
    noticeTag = text && tag ? tag : null;
    noticeEl.textContent = text;      // textContent: may carry frame-supplied text
    noticeBar.hidden = !text;
    noticeActionFn = action && text ? action.fn : null;
    noticeAction.hidden = !noticeActionFn;
    if (noticeActionFn) noticeAction.textContent = action.label;
  }
  noticeAction.addEventListener("click", async () => {
    if (!noticeActionFn || noticeAction.disabled) return;
    noticeAction.disabled = true;                 // one push per click, not one per double click
    try { await noticeActionFn(); } finally { noticeAction.disabled = false; }
  });

  function setHeader(meta) {
    const t = String(meta.title || "Canvas").slice(0, TITLE_MAX);
    titleEl.textContent = t;
    if (compareView) {
      versionEl.textContent = `agent 最後寫的 v${meta.agentVersion}（唯讀；目前是 v${meta.version}）`;
      document.title = `⇆ ${t} — agent 的版本`;
    } else {
      versionEl.textContent = `v${meta.version}${meta.author === "user" ? "（你的修改）" : ""}`;
      document.title = `${t} — Canvas`;
    }
    updateButtons();
  }

  // Header buttons follow the mode; only markdown is editable in phase 1 (slides: phase 2).
  async function updateButtons() {
    if (compareView) {
      // The compare tab is not the canvas (§3.10): nothing here can change it.
      for (const b of [editBtn, saveBtn, cancelBtn, revertBtn, undoBtn, redoBtn, sendBtn, askBtn, sendSelBtn, compareBtn, showChangesBtn, downloadBtn, printBtn, deleteBtn]) b.hidden = true;
      return;
    }
    const editable = !!current && current.meta.kind === "markdown" && !!frame;
    editBtn.hidden = !(editable && mode === "view");
    saveBtn.hidden = mode !== "edit" || deleted;
    saveBtn.disabled = !dirty;
    cancelBtn.hidden = mode !== "edit" || deleted;
    let canRevert = false;
    let sameAsAgent = false;            // saved edits that end up as the agent's text: nothing to send
    if (current && mode === "view" && current.meta.author === "user") {
      try {
        const agent = await store.readAgentCopy(canvasId);
        canRevert = agent != null && agent !== current.content;
        sameAsAgent = agent != null && agent === current.content;
      } catch (_) { /* stays hidden */ }
    }
    revertBtn.hidden = !canRevert;
    // ↶ 復原 / ↷ 重做 (§3.5): the editor's own undo / redo, only while editing.
    const hb = CanvasCore.editUndoButtons({ mode, compareView, deleted, mac, ...editUndo });
    undoBtn.hidden = redoBtn.hidden = !hb.show;
    undoBtn.disabled = hb.undo.disabled;
    undoBtn.title = hb.undo.title;
    redoBtn.disabled = hb.redo.disabled;
    redoBtn.title = hb.redo.title;
    // markdown, slides and mermaid (a diagram source: download as .mmd, print, glow; never edited here).
    const textKind = !!current && CanvasCore.textKind(current.meta.kind);
    // Compare with agent's (§3.10): when the latest differs from the agent's last write.
    compareBtn.hidden = !(canRevert && textKind && !!frame);
    showChangesBtn.hidden = !textKind;
    updateShowChangesBtn();             // editing changes its title (#110)
    // Send to agent: only when there are saved edits the agent has not been shown (§3.5/§3.7).
    const seen = current ? (current.meta.agentSeenVersion || current.meta.agentVersion || 0) : 0;
    sendBtn.hidden = !(textKind && mode === "view" && current.meta.version > seen && !sameAsAgent);
    sendBtn.title = current ? `把你的修改送給 agent（agent 最後看過 v${seen}）` : "";
    // Ask agent (§3.7): while text is selected in the view — an html canvas's too, shown without its
    // scripts (canvas-html §2.7: canvas-frame.html; the running frame has 📨 頁面選取 instead).
    const selectable = !!current && CanvasCore.selectableKind(current.meta.kind) && frameProfile !== "html";
    askBtn.hidden = !(selectable && mode === "view" && !!frame && !!ask.sel);
    // To chat input (§3.7, Brett 2026-10-13): the same rule; disabled while the panel is asked.
    sendSelBtn.hidden = askBtn.hidden;
    sendSelBtn.disabled = toInputBusy;
    const isHtml = !!current && current.meta.kind === "html";
    // 📨 頁面選取 (canvas-html §2.7): while the html canvas's scripts run and its page has rendered.
    pageSelBtn.hidden = !(isHtml && frameProfile === "html" && !!htmlRun && rendered && !deleted);
    pageSelBtn.disabled = pageSelBusy;
    downloadBtn.hidden = !(textKind || isHtml);
    const ext = isHtml ? "html" : current && current.meta.kind === "mermaid" ? "mmd" : "md";
    downloadBtn.textContent = `⬇ .${ext}`;
    downloadBtn.title = `下載成 .${ext}`;
    printBtn.hidden = !(textKind && !!frame && mode === "view");
    printBtn.disabled = (mode === "edit" && dirty) || !!printing;
    printBtn.title = printing ? "正在準備列印…" : printBtn.disabled ? "先儲存再匯出" : "列印／存成 PDF";
    editBtn.disabled = !!printing;
    updateEngineBtn();
    updateHtmlBar();
  }

  // ▶ Run scripts / ⏹ Stop scripts and the chip beside it (canvas-html §2.3, §2.6): a few words on
  // screen, the risk in the tooltip and in #canvas-html-risk (aria-describedby). Host text only.
  function updateHtmlBar() {
    const isHtml = !compareView && !!current && current.meta.kind === "html";
    htmlHint.hidden = !isHtml;
    runBtn.hidden = true;
    if (!isHtml) return;
    const v = CanvasCore.htmlRunView({ running: htmlRun ? htmlRun.version : 0, htmlOn, deleted });
    runBtn.hidden = v.runHidden;
    runBtn.textContent = v.runLabel;
    runBtn.title = v.runTitle;
    htmlHint.textContent = v.chip;
    htmlHint.title = v.chipTitle;
    htmlRisk.textContent = v.chipTitle;
    htmlHint.classList.toggle("running", v.chipRunning);
  }

  // --- Pushes into the prompt (§3.7) -----------------------------------------------------------
  // Composed here (host, from storage), posted by the side panel as the user. The panel checks the
  // sender is this page and the conversation is its own.
  async function pushToAgent(text, note) {
    return askPanel({ type: "katashiro-canvas-push", text, note: note || "" }, "送出失敗");
  }
  // A request to the panel of this canvas's conversation (a push, or To chat input), with the
  // conversation id and a request id added. `failed` heads a refusal that comes with a button.
  // `retry`: what to do again once the panel is open (a push: send it again; To chat input: 📨 again).
  async function askPanel(msg, failed, retry = "再送一次") {
    let r;
    try {
      r = await chrome.runtime.sendMessage({ ...msg, conversationId: current.meta.conversationId, reqId: crypto.randomUUID() });
    } catch (_) { r = undefined; }
    if (!r) {
      // No panel answered (multi-conversation P1b §4.8): the panel of this tab's window answers every
      // push it gets, so none answering usually means this window has no side panel open. Say so, and
      // offer to open it — chrome.sidePanel.open needs a user gesture, which the notice button's
      // click is. The note stays in the popover (or the user types it again for Send to agent).
      const win = await panellessWindow();
      if (win != null) {
        notice(`這個視窗的 Katashiro 側邊欄沒開：打開側邊欄後${retry}。`, { label: "打開側邊欄", fn: () => openSidePanel(win, retry) });
        return { ok: false, error: "這個視窗的 Katashiro 側邊欄沒開", shown: true };
      }
      return { ok: false, error: "Katashiro 側邊面板沒有回應（或不在同一個對話）" };
    }
    if (r.ok && r.elsewhere) r.agent = `${r.agent || "agent"}（在另一個視窗）`;
    if (!r.ok && r.windowId != null) {
      // Open in another window whose panel is closed: a button to go there.
      notice(`${failed}：${CanvasCore.clipError(r.error)}`, { label: "前往那個視窗", fn: () => chrome.windows.update(r.windowId, { focused: true }).catch(() => {}) });
      r.shown = true;                           // callers keep this notice (it has the button)
    } else if (!r.ok && r.error === ConvCore.ARCHIVED_PUSH_TEXT) {
      // Archived (multi-conversation §7.2): a button to reopen it here, then the user tries again.
      notice(`${failed}：${r.error}`, { label: "重新打開對話", fn: () => openConversation(retry) });
      r.shown = true;
    }
    return r;
  }
  // This tab's window id if no Katashiro side panel is open in it (chrome.runtime.getContexts,
  // Chrome 116+), else null (a panel is open, or we cannot tell).
  async function panellessWindow() {
    try {
      const me = await chrome.tabs.getCurrent();
      if (!me || typeof chrome.runtime.getContexts !== "function") return null;
      const panels = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"], windowIds: [me.windowId] });
      return panels.length ? null : me.windowId;
    } catch (_) { return null; }
  }
  // Called synchronously from the click (the user gesture sidePanel.open needs).
  function openSidePanel(windowId, retry = "再送一次") {
    try {
      const p = chrome.sidePanel.open({ windowId });
      if (p && typeof p.then === "function") return p.then(() => notice(`側邊欄打開了：${retry}。`), (e) => notice(`打不開側邊欄：${CanvasCore.clipError(String((e && e.message) || e))}`));
    } catch (e) { notice(`打不開側邊欄：${CanvasCore.clipError(String((e && e.message) || e))}`); }
    return undefined;
  }

  sendBtn.addEventListener("click", async () => {
    if (!current) return;
    const note = window.prompt("要附一句話給 agent 嗎？（可留空）", "");
    if (note === null) return;
    sendBtn.disabled = true;
    try {
      const c = current;
      const agentText = await store.readAgentCopy(canvasId);
      const diff = CanvasStore.unifiedDiff(agentText == null ? "" : agentText, c.content);
      if (diff === "") {
        // Saved, but the text is the agent's again (e.g. only blank lines the editor drops): a push
        // would be a header with no diff.
        await store.markSeen({ id: canvasId, version: c.meta.version });
        flash("文字跟 agent 最後寫的版本一樣，沒有變更要送。");
        return;
      }
      const head = `[canvas "${String(c.meta.title).slice(0, TITLE_MAX)}" (${canvasId}) v${c.meta.agentVersion} → v${c.meta.version}, edited by user]`;
      const text = CanvasCore.composeCanvasPush({
        note, header: diff == null ? `${head} — the diff is too large; call canvas_read` : head, data: diff || null, lang: "diff",
      });
      const r = await pushToAgent(text, note);
      if (!r.ok) { if (!r.shown) notice(`送出失敗：${CanvasCore.clipError(r.error)}`); return; }
      await store.markSeen({ id: canvasId, version: c.meta.version });
      flash(`📤 已送給 ${r.agent || "agent"}（v${c.meta.version}）`);
    } finally {
      sendBtn.disabled = false;
    }
  });

  // Ask agent (§3.7 "Edit with agent on a selection"): the frame reports the selected text
  // (selection{}, canvas-frame.html only — a compare tab refuses it, CanvasCore); the user types a
  // request, which goes first, then the selection as data under a fixed host line. Rendered text,
  // not markdown: the agent canvas_reads before a canvas_patch (the header tells it so).
  // Brett 2026-10-12 (option a): the request is typed in a popover by the selection, not a
  // window.prompt. A 💬 shows beside the selection (selection{rect}); it and the header button open
  // the popover. Both are elements of this page over the frame, so canvas content cannot imitate
  // them. The state is CanvasCore.askReduce's; this draws it.
  // To chat input (Brett 2026-10-13 01:12): a 📨 right beside the 💬 (and 📨 To chat input in the
  // header) puts the selection into the side panel's input box; nothing is sent. Shown with the 💬.
  const askPill = document.getElementById("ask-pill");
  const sendPill = document.getElementById("send-pill");
  const askPop = document.getElementById("ask-pop");
  const askExcerptEl = document.getElementById("ask-excerpt");
  const askNote = document.getElementById("ask-note");
  const askStatus = document.getElementById("ask-status");
  const askSendBtn = document.getElementById("ask-send");
  let ask = CanvasCore.ASK_IDLE;      // ask.sel = the selection in the view ({ text, truncated, seq, rect }), if any
  let askPopRect = null;              // where the popover's selection was last seen (frame coordinates)
  let askDraft = null;                // { seq, text, note }: a note closed unsent, back on the same selection
  let askTimer = 0;
  // The text of the latest render ({ seq, content }) and of the one the popover's selection was
  // made in: Ask agent's source lines hold only while that is still what is stored (§3.7).
  let renderedText = { seq: 0, content: null };
  let askShownText = null;
  let toInputBusy = false;            // the panel is being asked to take the selection: its 📨 controls are disabled
  const sameAsCaptured = (sel, cap) => !!sel && !!cap && sel.text === cap.text && sel.seq === cap.seq;

  function askDispatch(ev) {
    const prev = ask;
    ask = CanvasCore.askReduce(ask, ev);
    if (ask === prev) return;
    const was = CanvasCore.askView(prev), now = CanvasCore.askView(ask);
    if (was.popover && !now.popover) {
      clearTimeout(askTimer);
      // Closed unsent: keep the note for this selection (a stray click must not lose it).
      if (prev.phase === "open" && askNote.value.trim()) askDraft = { seq: prev.captured.seq, text: prev.captured.text, note: askNote.value };
      askPop.hidden = true;
      askPopRect = null;
    }
    if (!was.popover && now.popover) showAskPop();
    // An open popover follows its selection; once that scrolls out of view (no rect, #125e) it
    // docks under the header button (placeAskPop's fallback) instead of hanging over unrelated text.
    else if (now.popover && sameAsCaptured(ask.sel, ask.captured)) { askPopRect = ask.sel.rect || null; placeAskPop(); }
    if (now.pill) placeAskPill(); else askPill.hidden = sendPill.hidden = true;
    // The header 💬 Ask agent, 📨 To chat input. Showing or hiding them can wrap the header onto
    // another row (a narrow tab), which moves the frame: the 💬 / 📨 / popover are placed again.
    if (!!prev.sel !== !!ask.sel) updateButtons().then(placeAsk, () => {});
  }
  function placeAsk() {
    if (CanvasCore.askView(ask).pill) placeAskPill();
    if (CanvasCore.askView(ask).popover) placeAskPop();
  }

  // Place `el` by a frame-coordinate rect (CanvasCore.askPlace: below the selection's end, above
  // it when there is no room, clamped to the frame). false when the rect is not usable / in view.
  function placeOverFrame(el, rect) {
    if (!frame || !rect) return false;
    const fb = frame.getBoundingClientRect();
    el.style.visibility = "hidden";                         // measured where it is about to go
    el.hidden = false;
    const p = CanvasCore.askPlace({ rect, box: { left: fb.left, top: fb.top, width: fb.width, height: fb.height }, size: { w: el.offsetWidth, h: el.offsetHeight } });
    el.style.visibility = "";
    if (!p) return false;
    el.style.left = `${p.left}px`;
    el.style.top = `${p.top}px`;
    return true;
  }
  // The 💬, then the 📨 beside it on the same row (CanvasCore.askBeside: right, else left). The 📨
  // never shows without the 💬; with no room on either side it stays hidden (the header has one).
  function placeAskPill() {
    if (!placeOverFrame(askPill, ask.sel && ask.sel.rect)) { askPill.hidden = sendPill.hidden = true; return; }
    const a = askPill.getBoundingClientRect(), fb = frame.getBoundingClientRect();
    sendPill.style.visibility = "hidden";                   // measured where it is about to go
    sendPill.hidden = false;
    const p = CanvasCore.askBeside({
      anchor: { left: a.left, top: a.top, w: a.width, h: a.height },
      box: { left: fb.left, top: fb.top, width: fb.width, height: fb.height },
      size: { w: sendPill.offsetWidth, h: sendPill.offsetHeight },
    });
    sendPill.style.visibility = "";
    if (!p) { sendPill.hidden = true; return; }
    sendPill.style.left = `${p.left}px`;
    sendPill.style.top = `${p.top}px`;
  }
  // The popover by its selection; with none in view (scrolled away, or the header button was used
  // for a selection off screen), under the header button, else at the top of the frame.
  function placeAskPop() {
    if (placeOverFrame(askPop, askPopRect)) return;
    askPop.hidden = false;
    const w = askPop.offsetWidth, h = askPop.offsetHeight;
    const vp = { left: 0, top: 0, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    let p = null;
    if (!askBtn.hidden) {
      const b = askBtn.getBoundingClientRect();
      p = CanvasCore.askPlace({ rect: { top: b.top, bottom: b.bottom, left: b.left, right: b.right, x: (b.left + b.right) / 2 }, box: vp, size: { w, h } });
    }
    if (!p) {
      const fb = frame ? frame.getBoundingClientRect() : { left: 0, top: 0, width: vp.width };
      p = { left: Math.max(4, Math.round(fb.left + (fb.width - w) / 2)), top: Math.round(fb.top + 8) };
    }
    askPop.style.left = `${p.left}px`;
    askPop.style.top = `${p.top}px`;
  }
  function askSay(text, tone) {
    askStatus.textContent = text;                           // textContent: may carry an error string
    askStatus.className = `ask-status${tone ? ` ${tone}` : ""}`;
  }
  function showAskPop() {
    const cap = ask.captured;
    // The excerpt is canvas text (agent-authored): textContent, one line, bidi controls dropped.
    // In its own <bdi dir="auto"> (#125c): RTL text takes its own direction inside the quotes
    // without carrying 「」 to the other side.
    const bdi = document.createElement("bdi");
    bdi.dir = "auto";
    bdi.textContent = CanvasCore.askExcerpt(cap.text);
    askExcerptEl.replaceChildren("「", bdi, "」");
    askExcerptEl.title = CanvasCore.askExcerpt(cap.text, 300);
    const draft = askDraft && askDraft.seq === cap.seq && askDraft.text === cap.text ? askDraft.note : "";
    askDraft = null;
    askNote.value = draft;
    askNote.readOnly = false;
    askSendBtn.disabled = false;
    askSay("");
    askPopRect = ask.sel && ask.sel.rect;
    placeAskPop();
    askNote.focus({ preventScroll: true });
  }

  function onSelection(m) {
    // #107: made in an older render (debounced in the frame, it can arrive after startRender
    // cleared the selection), whose DOM is gone. By seq, not version (#115 review): a re-render of
    // the same version (§3.5 normalization, two refreshes) replaces the DOM too.
    if (CanvasCore.fromOlderRender(m, renderingSeq)) return;
    const textKind = !!current && CanvasCore.selectableKind(current.meta.kind);
    const sel = textKind && mode === "view" && m.text ? { text: m.text, truncated: m.truncated === true, seq: m.seq, rect: m.rect, where: m.where } : null;
    if (armed && !(sel && sel.text === armed.text && sel.seq === armed.seq)) disarm();    // a new selection
    // For the 📨's sidePanel.open (needs it at the click); at most once a second while dragging.
    if (sel && Date.now() - panelHereAt >= 1000) refreshPanelHere();
    askDispatch({ type: "selection", sel });
  }
  // Opened by the 💬 or the header button: captures the selection, version and title now.
  function openAsk(from) {
    if (!current || compareView || mode !== "view") return;
    if (CanvasCore.askView(ask).popover) { askNote.focus(); return; }
    askDispatch({ type: "open", version: current.meta.version, title: current.meta.title, from });
    if (ask.captured) askShownText = renderedText.seq === ask.captured.seq ? renderedText.content : null;
  }
  // Esc / ✕ / after a send. Focus goes back where the user came from: the header button, or the canvas.
  function closeAsk() {
    const from = ask.from;
    const was = CanvasCore.askView(ask);
    askDispatch({ type: "close" });
    if (!was.popover || CanvasCore.askView(ask).popover) return;
    if (from === "header" && !askBtn.hidden) askBtn.focus();
    else if (frame) frame.focus({ preventScroll: true });
  }
  async function sendAsk() {
    if (ask.phase !== "open") return;
    const note = askNote.value;
    if (!note.trim()) { askSay("請寫下要 agent 做什麼（例如：改短一點、翻成英文）。", "warn"); askNote.focus(); return; }
    if (!current) { askSay("這個畫布已經不在了。", "warn"); return; }
    const cap = ask.captured;
    askDispatch({ type: "send" });
    askNote.readOnly = true;
    askSendBtn.disabled = true;                   // one push per send; the panel also dedupes by reqId
    askSay("送出中…");
    const where = CanvasCore.askWhereAtSend(cap.where, { shown: askShownText, stored: current.content, sameVersion: current.meta.version === cap.version });
    const text = CanvasCore.composeAskAgent({ note, title: cap.title, id: canvasId, version: cap.version, text: cap.text, truncated: cap.truncated, where, kind: current.meta.kind });
    const r = await pushToAgent(text, note);
    const ok = r.ok ? `💬 已問 ${r.agent || "agent"}（v${cap.version} 的選取文字）` : `送出失敗：${CanvasCore.clipError(r.error)}`;
    if (ask.phase !== "sending") {                // closed meanwhile (edit mode, frame reloaded): say it here
      if (r.ok) flash(ok); else if (!r.shown) notice(ok);
      return;
    }
    if (!r.ok) {
      askDispatch({ type: "failed" });            // stays open with the note, to retry
      askNote.readOnly = false;
      askSendBtn.disabled = false;
      askSay(ok, "warn");
      askNote.focus();
      return;
    }
    askDraft = null;
    askDispatch({ type: "sent" });
    askSay(ok, "ok");
    askTimer = setTimeout(() => { if (ask.phase === "sent") closeAsk(); }, 1500);
  }

  // To chat input (§3.7, Brett 2026-10-13 01:12): the selection, as plain rendered text (no host
  // line, no fence, nothing else), goes into the side panel's input box of this canvas's
  // conversation (appended on a new line to a draft there) — nothing is sent; the user reads it,
  // edits it and sends it as their own message. Same refusals as Ask agent (view mode, a frame, a
  // text kind, never a compare tab). A selection the frame cut at SELECTION_MAX is refused, never
  // put in cut. The selection stays; after it went in only its 💬 / 📨 go away, as after Ask agent.
  async function selectionToInput() {
    if (toInputBusy || !current || compareView || mode !== "view" || !frame || !CanvasCore.selectableKind(current.meta.kind) || frameProfile === "html") return;
    const sel = ask.sel;
    if (!sel) return;
    if (sel.truncated) { notice(`選取的文字超過 ${CanvasCore.SELECTION_MAX / 1024} KB，沒放進輸入框：選短一點再試。`); return; }
    focusSidePanel();                             // still inside the click: the gesture open() needs
    toInputBusy = true;                           // one request per click; the panel also dedupes by reqId
    sendSelBtn.disabled = sendPill.disabled = true;
    let r;
    try {
      r = await askPanel({ type: "katashiro-canvas-to-input", text: sel.text }, "沒放進輸入框", "再按一次 📨");
    } finally {
      toInputBusy = false;
      sendSelBtn.disabled = sendPill.disabled = false;
    }
    if (!r.ok) { if (!r.shown) notice(`沒放進輸入框：${CanvasCore.clipError(r.error)}`); return; }
    if (ask.phase === "pill" && sameAsCaptured(ask.sel, sel)) askDispatch({ type: "close" });
    // r.draft: the panel did not switch to this conversation, so the text is in its draft. Else,
    // while this tab still has the keyboard focus (the side panel did not take it), Enter here sends.
    const after = CanvasCore.toInputAfter(r, { focused: document.hasFocus() });
    if (after.arm) { arm(sel, after.text); return; }
    flash(after.text);
    // Not armed: a 📨 left with the focus would turn the next Enter into another click.
    sendSelBtn.blur();
    sendPill.blur();
  }

  // 📨 頁面選取 (canvas-html §2.7, Brett 2026-11-01): while an html canvas's scripts run, its frame
  // never sends selection{} (page script could forge it at any time). Instead the user's click here —
  // a trusted event in this page, never the frame's — asks the frame what is selected
  // (selectionRequest{reqId} → pageSelection{reqId, text, truncated?}). The answer is page-reported:
  // it goes into the side panel's input box framed as such (CanvasCore.composePageSelection: a host
  // line, then the text as fenced data, ≤ SELECTION_MAX), and nothing is sent — the user reads it,
  // adds their question and sends it. Not armed for Enter (as 📨 To chat input is): page text should
  // be read before it goes out. A forged answer can only change what the user sees in the box. No
  // answer in time (the page's script removed our listener): the notice says so.
  const PAGE_SEL_TIMEOUT_MS = 3000;
  let htmlReqSeq = 0;                 // request ids of the host's posts to the html frame
  let pageSelBusy = false;
  let pageSelReq = null;              // { reqId, timer, resolve }
  function askPageSelection() {
    return new Promise((resolve) => {
      if (pageSelReq) { clearTimeout(pageSelReq.timer); pageSelReq.resolve(null); }
      const reqId = ++htmlReqSeq;
      pageSelReq = { reqId, resolve, timer: setTimeout(() => finishPageSelection(reqId, null), PAGE_SEL_TIMEOUT_MS) };
      toFrame({ type: "selectionRequest", reqId });
    });
  }
  function finishPageSelection(reqId, answer) {
    if (!pageSelReq || pageSelReq.reqId !== reqId) return;
    const { resolve, timer } = pageSelReq;
    pageSelReq = null;
    clearTimeout(timer);
    resolve(answer);
  }
  pageSelBtn.addEventListener("click", async (e) => {
    if (!e.isTrusted || pageSelBusy || !current || compareView || frameProfile !== "html" || !htmlRun || !rendered) return;
    focusSidePanel();                             // still inside the click: the gesture open() needs
    pageSelBusy = true;
    pageSelBtn.disabled = true;
    try {
      const c = current, version = htmlRun.version;
      const ans = await askPageSelection();
      if (!ans) { notice("畫布頁面沒有回答（它自己的 script 可能攔下了 Katashiro 的訊息）：沒放進輸入框。可以按 ⏹ Stop scripts，在不執行 script 的顯示裡選取。"); return; }
      if (ans.truncated) { notice(`頁面回報的選取超過 ${CanvasCore.SELECTION_MAX / 1024} KB，沒放進輸入框：選短一點再試。`); return; }
      if (!ans.text.trim()) { notice("頁面裡沒有選取的文字：先在畫布裡選取文字，再按 📨 頁面選取。"); return; }
      const text = CanvasCore.composePageSelection({ title: c.meta.title, id: canvasId, version, text: ans.text });
      if (!text) { notice(`頁面回報的選取加上說明後超過 ${CanvasCore.SELECTION_MAX / 1024} KB，沒放進輸入框：選短一點再試。`); return; }
      const r = await askPanel({ type: "katashiro-canvas-to-input", text }, "沒放進輸入框", "再按一次 📨 頁面選取");
      if (!r.ok) { if (!r.shown) notice(`沒放進輸入框：${CanvasCore.clipError(r.error)}`); return; }
      flash(r.draft
        ? "📨 頁面回報的選取已放進那段對話的草稿（頁面自己回報的文字，送出前請先看過）"
        : "📨 頁面回報的選取已放進輸入框（頁面自己回報的文字，送出前請先看過；不會自動送出）");
    } finally {
      pageSelBusy = false;
      pageSelBtn.disabled = false;
    }
  });

  // --- To chat input, then Enter (§3.7, Brett 2026-10-13 16:31) ----------------------------------
  // The side panel is another document: its messageInput.focus() cannot take the window's keyboard
  // focus from this tab. Two things, so that Enter right after 📨 sends:
  //  1. Best effort: chrome.sidePanel.open() for this window, from the click (it needs the user
  //     gesture, so it is called before any await, with the window id cached here). Only when a
  //     panel is already open in this window (a closed one would open and miss the request).
  //  2. This tab is "armed" for TO_INPUT_ARM_MS: Enter here asks the panel to send its input as its
  //     own send button would (katashiro-canvas-submit-input; the panel checks the sender, that the
  //     conversation is on screen and the input not empty, and dedupes by reqId). Esc disarms with
  //     the text kept; any other key, a mouse press, a selection change, edit mode, the focus
  //     leaving the tab, or the timeout disarms silently. Keys are read here, in the trusted host
  //     page; in the frame (canvas-frame.html only, never a compare tab) a key or press is reported
  //     as armedKey{} under the nonce, and acted on only while armed and the frame has the focus.
  let myWindowId = null;
  let panelHere = false;              // a Katashiro side panel is open in this tab's window (last seen)
  let panelHereAt = 0;                // when refreshPanelHere last started
  async function refreshPanelHere() {
    panelHereAt = Date.now();
    try {
      const me = await chrome.tabs.getCurrent();
      if (!me || me.windowId == null) return;
      myWindowId = me.windowId;
      if (typeof chrome.runtime.getContexts !== "function") { panelHere = false; return; }
      const panels = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"], windowIds: [me.windowId] });
      panelHere = panels.length > 0;
    } catch (_) { /* unknown: leave it */ }
  }
  refreshPanelHere();
  window.addEventListener("focus", () => { refreshPanelHere(); });
  // Synchronous on purpose (the click's user gesture); errors ignored — Enter here still works.
  function focusSidePanel() {
    if (!panelHere || myWindowId == null || !chrome.sidePanel || typeof chrome.sidePanel.open !== "function") return;
    try {
      const p = chrome.sidePanel.open({ windowId: myWindowId });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) { /* best effort */ }
  }

  let armed = null;                   // { seq, text, hint, timer }
  let submitting = false;
  function arm(sel, hint) {
    disarm();
    armed = { seq: sel.seq, text: sel.text, hint, timer: setTimeout(() => disarm(), CanvasCore.TO_INPUT_ARM_MS) };
    notice(hint);
    toFrame({ type: "armKeys", on: true });
  }
  // keepNotice: the caller says something in its place.
  function disarm({ keepNotice = false } = {}) {
    if (!armed) return;
    const a = armed;
    armed = null;
    clearTimeout(a.timer);
    toFrame({ type: "armKeys", on: false });
    if (!keepNotice && noticeEl.textContent === a.hint) notice("");
  }
  async function submitArmed() {
    if (!armed || submitting || !current) return;
    disarm({ keepNotice: true });
    submitting = true;
    notice("送出中…");
    let r;
    try {
      r = await askPanel({ type: "katashiro-canvas-submit-input" }, "沒送出", "再按一次 📨");
    } finally { submitting = false; }
    if (r.ok) flash(CanvasCore.toInputSubmitText(r));
    else if (!r.shown) notice(CanvasCore.toInputSubmitText(r));
  }
  // k: the key's fields (a KeyboardEvent here, or the frame's armedKey{}); e: the event to stop, if ours.
  function onArmedKey(k, e) {
    if (!armed) return;
    const d = CanvasCore.toInputArmKey(k);
    if (d === "ignore") return;
    if (d === "send" || d === "cancel") { if (e) { e.preventDefault(); e.stopPropagation(); } }
    if (d === "send") submitArmed();
    else if (d === "cancel") { disarm({ keepNotice: true }); flash("已取消（文字留在輸入框）"); }
    else disarm();
  }
  // Capture on window: ahead of every other key handler here, and before a focused button turns
  // Enter into a click (the header 📨 would put the selection in again).
  window.addEventListener("keydown", (e) => { if (armed && e.isTrusted) onArmedKey(e, e); }, true);
  window.addEventListener("mousedown", () => disarm(), true);
  // The focus left this tab (the side panel took it, another window): Enter no longer lands here.
  // Into the frame it stays armed: the frame reports its keys.
  window.addEventListener("blur", () => {
    setTimeout(() => { if (armed && !(document.hasFocus() && frame && document.activeElement === frame)) disarm(); }, 0);
  });

  askBtn.addEventListener("click", () => { if (ask.sel) openAsk("header"); });
  sendSelBtn.addEventListener("click", () => selectionToInput());
  sendPill.addEventListener("click", () => selectionToInput());
  sendPill.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeAsk(); } });
  askPill.addEventListener("click", () => openAsk("pill"));
  askPill.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeAsk(); } });
  askSendBtn.addEventListener("click", () => sendAsk());
  document.getElementById("ask-close").addEventListener("click", () => closeAsk());
  askPop.addEventListener("keydown", (e) => {
    const k = CanvasCore.askKey(e);
    if (k === "close") { e.preventDefault(); e.stopPropagation(); closeAsk(); }
    else if (k === "send" && e.target === askNote) { e.preventDefault(); sendAsk(); }
  });
  // A click outside closes the popover: on this page (not on it, the 💬 or the header button),
  // or into the canvas, which takes the focus out of this window into the frame.
  document.addEventListener("mousedown", (e) => {
    if (!CanvasCore.askView(ask).popover) return;
    const t = e.target;
    if (askPop.contains(t) || askPill.contains(t) || askBtn.contains(t)) return;
    askDispatch({ type: "blur" });
  }, true);
  window.addEventListener("blur", () => {
    setTimeout(() => { if (frame && document.activeElement === frame) askDispatch({ type: "blur" }); }, 0);
  });
  window.addEventListener("resize", () => placeAsk());

  // Send error to agent (§3.7 "Try fixing"): only canvas-frame errors exist in phase 1.
  // diagram: only a mermaid diagram failed (§3.3) and the rest rendered, so the agent is pointed at
  // that fence rather than told the whole canvas is broken.
  // tag ({seq, version}): the render the error came from. A newer render's rendered{} clears the
  // notice, and the push names that version, not whatever the canvas holds at click time.
  // lead: a line kept above the error (an html revision's auto-run notice, canvas-html §2.6).
  // pageReported (canvas-html §2.7, Brett 2026-11-01): an error{} from a RUNNING html canvas. Its
  // script can write that text, so it is labelled so in the banner and in the push (renderErrorHeader),
  // and goes as fenced data, capped (clipError) — still only on the user's click here. An html
  // canvas's static view is canvas-frame.html (no page script): its errors go as for markdown.
  function offerSendError(msg, diagram = false, tag = null, lead = "", pageReported = false) {
    const c = current;
    const version = tag && Number.isInteger(tag.version) ? tag.version : c && c.meta.version;
    notice(`${lead ? `${lead}\n` : ""}${pageReported ? "畫布頁面回報錯誤" : diagram ? "圖表有錯誤" : "顯示時發生錯誤"}${tag && version ? `（v${version}）` : ""}：${CanvasCore.clipError(msg)}`, {
      label: "送給 agent 修",
      fn: async () => {
        if (!c) return;
        const text = CanvasCore.composeCanvasPush({
          header: CanvasCore.renderErrorHeader({
            title: String(c.meta.title).slice(0, TITLE_MAX), id: canvasId, version, kind: c.meta.kind, diagram,
            nowVersion: current ? current.meta.version : undefined, pageReported,
          }),
          data: CanvasCore.clipError(msg),
        });
        const r = await pushToAgent(text);
        if (r.ok) notice(`📤 已把錯誤送給 ${r.agent || "agent"}`); else if (!r.shown) notice(`送出失敗：${CanvasCore.clipError(r.error)}`);
      },
    }, tag);
  }

  // --- Export (§3.8) --------------------------------------------------------------------------
  downloadBtn.addEventListener("click", () => {
    if (!current) return;
    const mermaid = current.meta.kind === "mermaid";
    const html = current.meta.kind === "html";
    const type = html ? "text/html;charset=utf-8" : mermaid ? "text/plain;charset=utf-8" : "text/markdown;charset=utf-8";
    const url = URL.createObjectURL(new Blob([current.content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = CanvasCore.safeFileName(current.meta.title, html ? "html" : mermaid ? "mmd" : "md");
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  // PDF through the print dialog. Slides reload the frame with reveal's ?print-pdf layout first (a
  // host-caused load, so the gate allows it) and come back to the normal view after printing.
  let printing = null;                      // null | { sent }
  printBtn.addEventListener("click", () => {
    if (!current || !frame || printing) return;
    if (mode === "edit" && dirty) { notice("先儲存再匯出 PDF。"); return; }
    if (current.meta.kind === "slides") {
      printing = { sent: false };
      mountFrame("?print-pdf");
      updateButtons();
    } else {
      toFrame({ type: "print" });
    }
  });

  async function load() {
    if (!CanvasStore.ID_RE.test(canvasId)) {
      notice("這個畫布的網址無效。");
      return null;
    }
    const mk = CanvasStore.metaKey(canvasId);
    const lk = CanvasStore.latestKey(canvasId);
    const got = await chrome.storage.local.get([mk, lk]);
    if (!got[mk]) {
      notice("找不到這個畫布（可能已被刪除）。");
      return null;
    }
    const latest = got[lk] == null ? "" : got[lk];
    // A compare tab shows the agent's last write: its history entry (§3.5), the latest while it is.
    if (compareView) {
      const ak = CanvasStore.contentKey(got[mk], got[mk].agentVersion);
      const agent = ak && ak !== lk ? (await chrome.storage.local.get(ak))[ak] : null;
      return { meta: got[mk], content: agent != null ? agent : latest, latest };
    }
    return { meta: got[mk], content: latest };
  }

  function mountFrame(query) {
    if (!query) printing = null;              // any normal mount ends a print (§3.8)
    if (frame) frame.remove();
    endHtmlRun();
    frameProfile = current && current.meta.kind === "html" ? "htmlStatic" : "canvas";
    frameReady = false;
    renderFailed = "";                        // #96: a goto / highlight before the new frame's ready must not get the old failure
    disarm();                                 // its armKeys went to the old frame
    askDispatch({ type: "reset" });           // the selection and its popover were about the old frame
    nonce = CanvasCore.newNonce();
    frame = document.createElement("iframe");
    // allow-scripts + allow-modals (print, §3.8): no same-origin, popups, forms or top navigation (§3.2).
    frame.setAttribute("sandbox", "allow-scripts allow-modals");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = "canvas content";
    frame.addEventListener("load", () => {
      if (!gate.onLoad()) dropFrame("畫布內容嘗試離開這個頁面，已停止顯示。重新整理這個分頁即可重新載入。");
    });
    gate.reset();
    gate.expect();
    frame.src = `canvas-frame.html${query || ""}#${nonce}`;
    mainEl.appendChild(frame);
  }

  // ▶ Run scripts (canvas-html §2.4): the html canvas's revision in canvas-html-frame.html — a
  // host-caused load with a new nonce. allow-scripts allow-downloads (§6 Q2): no same-origin, popups,
  // forms, modals or top navigation, and no clipboard.
  function mountHtmlFrame() {
    if (!current || current.meta.kind !== "html" || compareView) return;
    printing = null;
    if (frame) frame.remove();
    endHtmlRun();
    frameReady = false;
    renderFailed = "";
    rendered = false;
    disarm();
    askDispatch({ type: "reset" });
    nonce = CanvasCore.newNonce();
    frameProfile = "html";
    htmlRun = { version: current.meta.version, content: current.content };
    frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-downloads");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = "canvas content (scripts running)";
    frame.addEventListener("load", () => {
      if (gate.onLoad()) return;
      // A page that navigates itself loses the canvas's grant (canvas-html §2.6): a reload must not
      // run it again by itself.
      revokeHere();
      dropFrame("畫布內容嘗試離開這個頁面，已停止顯示，script 的授權也已撤回。重新整理這個分頁即可重新載入。");
    });
    gate.reset();
    gate.expect();
    // #k=: Archify (the first user) reads the hash as URLSearchParams and ignores keys it does not know.
    frame.src = `canvas-html-frame.html#k=${nonce}`;
    mainEl.appendChild(frame);
    notice("");
    updateButtons();
  }
  function endHtmlRun() {
    htmlRun = null;
    htmlAutoNote = "";
    htmlRenderSent = false;
    if (htmlArm) { clearTimeout(htmlArm.timer); gate.disarm(htmlArm.token); htmlArm = null; }
    // The running page is gone: what it was asked and has not answered never will be (§2.7).
    if (pageSelReq) finishPageSelection(pageSelReq.reqId, null);
    if (pendingCss) onStyled({ reqId: pendingCss.reqId, timeout: true });
    // A highlight it was sent goes again to the next frame (on its ready / rendered{}), within its timeout.
    if (pendingHighlight) pendingHighlight.sent = false;
  }
  function armHtmlLoad(token, ms) {
    if (htmlArm && htmlArm.token === token) clearTimeout(htmlArm.timer);
    htmlArm = { token, timer: setTimeout(() => { gate.disarm(token); if (htmlArm && htmlArm.token === token) htmlArm = null; }, ms) };
  }
  // The one message this html frame ever gets (canvas-html §2.4 host invariant): render, answering
  // the ready of its nonce. Nothing else is posted to it — toFrame() drops everything for it.
  function sendHtmlRender() {
    if (!frame || !frameReady || htmlRenderSent || !htmlRun) return;
    htmlRenderSent = true;
    if (HTML_WRITE_FIRES_LOAD) armHtmlLoad(gate.arm(), HTML_RENDER_ARM_MS);
    frame.contentWindow.postMessage({ type: "render", nonce, kind: "html", content: htmlRun.content, version: htmlRun.version }, "*");
  }
  // ▶ Run scripts grants this canvas (CanvasStore.grantRun, under its lock: refused if it moved or
  // was deleted meanwhile, or html canvases are off); ⏹ Stop scripts revokes it, in every tab.
  // canvas-html §2.6: no confirm dialog — the button's tooltip and the chip's say what running allows.
  let runClicking = false;
  let revoking = null;                // ⏹'s revoke in flight: reconcileHtml waits for it, never re-runs meanwhile
  function revokeHere() {
    const mine = store.revokeRun({ id: canvasId }).catch(() => {}).then(() => { if (revoking === mine) revoking = null; });
    revoking = mine;
    return mine;
  }
  runBtn.addEventListener("click", async () => {
    if (!current || current.meta.kind !== "html" || compareView || runClicking) return;
    if (htmlRun) { mountFrame(); updateButtons(); revokeHere(); return; }
    if (!htmlOn || deleted) return;
    const c = current;
    runClicking = true;
    runBtn.disabled = true;
    let ok = false;
    try { ok = await store.grantRun({ id: canvasId, conversationId: c.meta.conversationId, version: c.meta.version }); } catch (_) { ok = false; }
    finally { runClicking = false; runBtn.disabled = false; }
    if (!ok) { notice("沒有執行：這個畫布剛剛被移動或刪除，或 html 畫布已在設定裡關閉。"); return; }
    reconcileHtml();                  // runs the latest revision (a newer one may have come meanwhile)
  });

  // Whether this tab should run the html canvas's scripts now (canvas-html §2.6): on load, on every
  // refresh, and when the grant changes in storage (another tab's ▶ / ⏹, a move, the setting). Runs
  // the current revision in a fresh html frame if the grant holds; goes back to the static view if
  // it runs without one. → true when it mounted (or kept) the frame itself; false: the caller
  // renders the static view as usual.
  let htmlSeq = 0;
  async function reconcileHtml() {
    if (compareView || !current || current.meta.kind !== "html" || deleted) return false;
    const seq = ++htmlSeq, c = current;
    if (revoking) await revoking;
    let g = { grant: null, holds: false };
    try { g = await store.readRunGrant(canvasId); } catch (_) { /* no grant */ }
    if (seq !== htmlSeq || c !== current) return true;          // superseded: the newer call decides
    if (deleted) return false;
    const v = c.meta.version;
    const plan = CanvasCore.htmlAutoRun({ kind: c.meta.kind, holds: g.holds, grantVersion: g.grant && g.grant.version, version: v, htmlOn, compareView, deleted });
    if (plan.run) {
      if (htmlRun && htmlRun.version === v) return true;        // already running this revision
      mountHtmlFrame();                                         // a new nonce: the host invariant holds (§2.4)
      if (plan.announce) {
        htmlAutoNote = CanvasCore.htmlAutoRunNotice(v);
        notice(htmlAutoNote);                                   // textContent; the version shows code changed
        store.noteRun({ id: canvasId, version: v }).catch(() => {});
      }
      return true;
    }
    if (!htmlRun) return false;
    const newer = v !== htmlRun.version;
    mountFrame();
    updateButtons();
    notice(newer
      ? `這個畫布更新成 v${v}：已回到靜態檢視，要互動請按 ▶ Run scripts。`
      : "這個畫布的 script 授權已撤回，回到靜態檢視。");
    return true;
  }
  if (!compareView) {
    chrome.storage.onChanged.addListener((changes, area) => {
      // false: the static view stays; render the latest into it (a revision may have raced this).
      if (area === "local" && changes[CanvasStore.runGrantKey(canvasId)] && !runClicking) reconcileHtml().then((mounted) => { if (!mounted) sendRender(); });
    });
  }

  function dropFrame(why) {
    printing = null;
    endHtmlRun();
    frameProfile = "canvas";
    if (frame) frame.remove();
    frame = null;
    frameReady = false;
    rendered = false;
    nonce = "";
    disarm();
    askDispatch({ type: "reset" });
    notice(why);
    finishGoto({ ok: false, error: "the canvas is no longer shown" });
    finishHighlight({ ok: false, error: "the canvas is no longer shown" });
    finishEngine({ ok: false, error: "the canvas is no longer shown" });
  }

  // What the frame renders: the text for markdown / slides; for an image canvas the stored JSON
  // reference is resolved here (the frame has no storage) into { dataUrl, caption }.
  async function renderPayload(c) {
    if (c.meta.kind !== "image") return c.content;
    let ref;
    try { ref = JSON.parse(c.content); } catch (_) { throw new Error("broken image canvas"); }
    const img = await store.readImage(ref && ref.image);
    if (!img) throw new Error("the image of this canvas is missing");
    return { dataUrl: `data:${img.mimeType};base64,${img.data}`, caption: String((ref && ref.caption) || "") };
  }

  function toFrame(msg) {
    // '*' is the only target for an opaque-origin frame; the load gate is what makes it safe.
    // The html frame gets its one render from sendHtmlRender; after that page has rendered, only
    // highlight / css / selectionRequest, each rebuilt from its own fields by CanvasCore.htmlFramePost
    // (canvas-html §2.7: the agent's strings for its own content, or a bare request). Everything
    // else — glow, theme, armKeys, edits, other canvases — is dropped here.
    if (frameProfile === "html") {
      const m = htmlRenderSent && rendered ? CanvasCore.htmlFramePost(msg) : null;
      if (m && frame && frameReady) frame.contentWindow.postMessage({ ...m, nonce }, "*");
      return;
    }
    if (frame && frameReady) frame.contentWindow.postMessage({ ...msg, nonce }, "*");
  }

  // §3.5: an agent markdown write not normalized yet → ask the frame to normalize the AGENT copy
  // (which is the latest unless the user has saved since), and wait for rendered{version, normalized}.
  let awaitingNormalize = 0;
  let lastRenderedVersion = 0;        // §3.10: an agent version newer than this glows what changed
  async function sendRender() {
    if (!frame || !frameReady || !current || frameProfile === "html") return;
    const c = current;
    let content;
    try { content = await renderPayload(c); } catch (e) {
      notice(CanvasCore.clipError(e.message));
      finishEngine({ ok: false, error: `the canvas failed to show: ${CanvasCore.clipError(e.message)}` });
      return;
    }
    if (compareView) {
      if (frame && frameReady && current === c) sendCompareRender(c, content);   // superseded while reading
      return;
    }
    let normalizeText;
    if (c.meta.kind === "markdown" && c.meta.normalized === false) {
      normalizeText = await store.readAgentCopy(canvasId);
      awaitingNormalize = c.meta.agentVersion;
    }
    if (!frame || !frameReady || current !== c) return;         // superseded while reading
    const msg = { type: "render", kind: c.meta.kind, version: c.meta.version, content, engine: tabEngine() };
    if (typeof normalizeText === "string") { msg.normalizeText = normalizeText; msg.version = c.meta.agentVersion; }
    // Glow on every agent write (§3.10): the frame compares with what it showed before. With 顯示變更
    // on, held markers replace the fade (applied on rendered{}), unless a compare's markers show.
    if (CanvasCore.textKind(c.meta.kind) && c.meta.author === "agent" && lastRenderedVersion && c.meta.version > lastRenderedVersion && !(showChanges && !comparing)) {
      msg.glowPrev = true;
      // A canvas_patch (#107): the frame glows exactly the changed text, falling back to the block diff.
      const ranges = CanvasCore.patchGlowRanges(c.meta);
      if (ranges) msg.glowRanges = ranges;
    }
    lastRenderedVersion = c.meta.version;
    startRender(msg, c.meta.version);
  }

  // While this canvas's compare tab is open, the differing blocks stay marked here too (Brett,
  // 2026-10-11): re-marked after every render (rendered{}), cleared when the last compare tab closes.
  let comparing = false;
  let compareGen = 0;                       // bumped when a compare starts: a stale "closed" check yields
  async function holdCompareGlow() {
    const agentText = await store.readAgentCopy(canvasId);
    if (!comparing || mode !== "view") return;
    if (typeof agentText === "string" && current && agentText !== current.content) toFrame({ type: "glow", against: agentText, hold: true });
    else toFrame({ type: "glow", clear: true });
  }
  async function compareStillOpen() {
    try { return (await chrome.tabs.query({})).some((t) => CanvasTabs.isCompareTabFor(t, CANVAS_BASE, canvasId)); } catch (_) { return false; }
  }
  // Ends the compare when no compare tab is left: one closed, or navigated elsewhere. A compare
  // started (Compare clicked again) while the query ran wins over the stale answer.
  async function endCompareIfClosed() {
    if (!comparing) return;
    const gen = compareGen;
    if ((await compareStillOpen()) || gen !== compareGen || !comparing) return;
    comparing = false;
    updateShowChangesBtn();
    applyHeldChanges();                     // clears the compare's markers; 顯示變更's come back if on
  }

  // A reloaded canvas tab picks up a compare tab that is still open; rendered{} then marks.
  async function startCompareIfOpen() {
    if (comparing || !(await compareStillOpen()) || comparing) return;
    compareGen++;
    comparing = true;
    updateShowChangesBtn();
    if (rendered) holdCompareGlow();
  }

  // 顯示變更 (§3.10, Brett 2026-10-11): one switch for every canvas tab (chrome.storage.local). While
  // on, the markers are held and re-applied after every render. The baseline is the previous
  // version in history (§3.5): previous → latest, any author, so a reloaded tab marks the same. A
  // compare's markers win while it is open.
  let showChanges = false;
  let heldFrom = "off";                     // what the held markers compare with (for the title)
  let heldSeq = 0;
  async function applyHeldChanges() {
    if (compareView || comparing || !rendered || printing || !current) return;
    const seq = ++heldSeq, c = current;
    let previous = null;
    if (showChanges && CanvasCore.textKind(c.meta.kind)) {
      try {
        const p = await store.readPrevious(canvasId);
        // Read lock-free: only if it is still the version before the one shown.
        if (p && p.version === CanvasStore.previousVersion(c.meta)) previous = p.content;
      } catch (_) { /* nothing to compare with */ }
    }
    if (seq !== heldSeq || c !== current || comparing || !rendered) return;   // superseded meanwhile
    const h = CanvasCore.heldChanges({
      on: showChanges, comparing, editing: mode !== "view", kind: c.meta.kind, previous, content: c.content,
    });
    heldFrom = h.from;
    updateShowChangesBtn();
    toFrame(h.against === null ? { type: "glow", clear: true } : { type: "glow", against: h.against, hold: true });
  }
  // Also from updateButtons and wherever a compare starts or ends (#110): entering edit or a
  // compare changes what the title should say without a new heldChanges answer.
  function updateShowChangesBtn() {
    showChangesBtn.setAttribute("aria-pressed", String(showChanges));
    showChangesBtn.title = CanvasCore.showChangesTitle({ on: showChanges, from: heldFrom, editing: mode !== "view", comparing });
  }
  function setShowChanges(on) {
    if (on === showChanges) return;
    showChanges = on;
    updateShowChangesBtn();
    applyHeldChanges();                     // on: marks now; off: clears the held markers
  }
  if (!compareView) {
    updateShowChangesBtn();
    chrome.storage.local.get(CanvasCore.SHOW_CHANGES_KEY).then((got) => setShowChanges(got[CanvasCore.SHOW_CHANGES_KEY] === true), () => {});
    showChangesBtn.addEventListener("click", () => {
      setShowChanges(!showChanges);
      chrome.storage.local.set({ [CanvasCore.SHOW_CHANGES_KEY]: showChanges }).catch(() => {});   // other canvas tabs follow
    });
  }

  // Settings → html 畫布 (canvas §6 Q2): off → html canvases show without their scripts only; a
  // running one goes back to that view.
  if (!compareView) {
    const K = CanvasStore.HTML_ENABLED_KEY;
    const apply = (v) => {
      htmlOn = CanvasStore.htmlEnabled(v);
      if (!htmlOn && htmlRun) mountFrame();
      // Off revokes this canvas's grant (the side panel revokes them all, canvas-html §2.6): turning
      // html canvases on again runs nothing by itself. A grant never holds while off anyway.
      if (!htmlOn && current && current.meta.kind === "html") revokeHere();
      updateHtmlBar();
    };
    chrome.storage.local.get(K).then((got) => apply(got[K]), () => {});
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes[K]) apply(changes[K].newValue); });
  }

  // Diagram engine (canvas-diagram-engine §2.1–§2.3): Settings → 圖表引擎 for every tab, this tab's
  // header switch on top of it (not saved: a reload goes back to the setting). Changing either
  // re-renders the canvas with the new engine; rendered{diagrams} says what drew each diagram.
  let engineSetting;                        // raw CanvasStore.DIAGRAM_ENGINE_KEY (read before the first render)
  let engineOverride = null;                // this tab's header choice, or null
  let shownDiagrams = [];                   // rendered{diagrams} of the render on screen
  let fallbackSeq = 0, fallbackMsg = "";    // diagramFallback{} of render fallbackSeq (goes with a diagram error's push)
  let pendingEngine = null;                 // canvas_view({engine}): { seq, reply, timer } until that render's rendered{}
  let peleNoticeShown = true;               // CanvasStore.PELE_NOTICE_KEY (read with the setting)
  const tabEngine = () => CanvasCore.effectiveEngine({ override: engineOverride, setting: engineSetting });
  const hasDiagrams = () => !!current && (current.meta.kind === "mermaid" || shownDiagrams.length > 0);
  function updateEngineBtn() {
    const textKind = !compareView && !!current && CanvasCore.textKind(current.meta.kind);
    engineBtn.hidden = !(textKind && !!frame && hasDiagrams());
    engineBtn.textContent = CanvasCore.engineSwitchLabel({ override: engineOverride, setting: engineSetting });
    engineBtn.disabled = mode === "edit" || !!printing;
    const other = CanvasCore.ENGINE_LABEL[CanvasCore.otherEngine(tabEngine())];
    engineBtn.title = engineBtn.disabled ? "先結束編輯" : `這個分頁改用 ${other} 畫圖（不會存起來；預設在側邊欄的設定 → 圖表引擎）`;
  }
  // Re-render with the engine now in effect, if it changed (the frame draws everything again; held
  // markers come back on rendered{}, as after any render).
  function setTabEngine(override) {
    const before = tabEngine();
    engineOverride = CanvasCore.isEngine(override) ? override : null;
    updateEngineBtn();
    if (tabEngine() === before) return false;
    if (mode !== "edit") sendRender();
    return true;
  }
  engineBtn.addEventListener("click", () => {
    if (mode === "edit" || printing) return;
    setTabEngine(CanvasCore.engineAfterSwitch({ override: engineOverride, setting: engineSetting }));
  });
  async function readEngineSetting() {
    try {
      const got = await chrome.storage.local.get([CanvasStore.DIAGRAM_ENGINE_KEY, CanvasStore.PELE_NOTICE_KEY]);
      engineSetting = got[CanvasStore.DIAGRAM_ENGINE_KEY];
      peleNoticeShown = got[CanvasStore.PELE_NOTICE_KEY] === true;
    } catch (_) { /* Pele, the default */ }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[CanvasStore.DIAGRAM_ENGINE_KEY]) return;
    const before = tabEngine();
    engineSetting = changes[CanvasStore.DIAGRAM_ENGINE_KEY].newValue;
    // An override equal to the new setting is no override any more (the tab follows the setting).
    if (engineOverride && engineOverride === CanvasCore.effectiveEngine({ override: null, setting: engineSetting })) engineOverride = null;
    updateEngineBtn();
    if (tabEngine() !== before && current && frame && frameProfile !== "html" && mode !== "edit") sendRender();
  });
  // The one-time notice (#210 review): Pele drew a diagram in this browser for the first time.
  function maybePeleNotice(diagrams) {
    // Another notice on screen (an error, say) wins; this one waits for a later render.
    if (peleNoticeShown || compareView || !noticeBar.hidden || !diagrams.some((d) => d.engine === "pele")) return;
    peleNoticeShown = true;
    chrome.storage.local.set({ [CanvasStore.PELE_NOTICE_KEY]: true }).catch(() => {});
    notice("圖表現在用 Pele 繪製。要改回 Mermaid：側邊欄的設定 → 圖表引擎，或按上方的「圖表」只切換這個分頁。", { label: "知道了", fn: () => notice("") });
  }
  // canvas_view({engine}) (§2.3): the header switch's path; answers once that render reports.
  function onEngineRequest(msg, sendResponse) {
    if (!current || !frame || frameProfile === "html" || !CanvasCore.textKind(current.meta.kind)) { sendResponse({ ok: false, error: "the canvas is not shown with diagrams in this tab" }); return false; }
    if (mode === "edit") { sendResponse({ ok: false, error: "the user is editing this canvas; try again when they are done" }); return false; }
    const answer = () => ({ ok: true, engine: tabEngine(), override: engineOverride, setting: CanvasCore.effectiveEngine({ override: null, setting: engineSetting }), diagrams: shownDiagrams });
    finishEngine({ ok: false, error: "superseded by a newer canvas_view({engine})" });
    const changed = setTabEngine(msg.engine === "default" ? null : msg.engine);
    if (!changed && rendered) { sendResponse(answer()); return false; }
    if (!changed && renderFailed) { sendResponse({ ok: false, error: `the canvas failed to show: ${renderFailed}` }); return false; }
    pendingEngine = {
      seq: renderSeq + (changed ? 1 : 0), reply: sendResponse, answer,
      timer: setTimeout(() => finishEngine({ ok: true, ...answer(), note: "the new render had not finished; diagrams may be from before" }), 15000),
    };
    return true;
  }
  function finishEngine(result) {
    if (!pendingEngine) return;
    clearTimeout(pendingEngine.timer);
    pendingEngine.reply(result);
    pendingEngine = null;
  }

  if (!compareView) {
    chrome.tabs.onRemoved.addListener(endCompareIfClosed);
    chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url) endCompareIfClosed(); });
    startCompareIfOpen();
  }

  // goto / highlight wait for the frame to report THIS render (an older one's rendered{} would let
  // them reach a deck still being replaced), and fail at once with the reason while it is failed.
  // Told apart by a per-render seq the frame echoes back, not the version (#96): two renders of
  // the same version (meta and latest written separately → two refreshes) share a version.
  let renderSeq = 0;
  let renderingSeq = 0;
  let renderFailed = "";
  let renderingVersion = 0;               // the version render{renderingSeq} shows (its errors name it)
  // shows: the version whose content this render displays (a normalize render names the agent copy
  // in msg.version, but shows the latest when the user saved since).
  function startRender(msg, shows = msg.version) {
    askDispatch({ type: "render" });                        // the DOM the selection was in is replaced
    rendered = false;
    renderFailed = "";
    renderingSeq = ++renderSeq;
    renderingVersion = shows;
    renderedText = { seq: renderingSeq, content: typeof msg.content === "string" ? msg.content : null };
    toFrame({ ...msg, seq: renderingSeq });
  }

  // Compare tab (§3.10): the agent copy, re-sent (no reload) whenever the canvas changes. Its blocks
  // that differ from the latest glow; once they are equal (e.g. the agent wrote), it says so and
  // glows what the agent's write changed.
  function sendCompareRender(c, content) {
    const msg = { type: "render", kind: c.meta.kind, version: c.meta.agentVersion, content, engine: tabEngine() };
    const same = c.content === c.latest;
    if (!same && typeof c.latest === "string") { msg.glowAgainst = c.latest; msg.glowHold = true; }
    else if (lastRenderedVersion && c.meta.agentVersion > lastRenderedVersion) {
      msg.glowPrev = true;
      const ranges = CanvasCore.patchGlowRanges(c.meta);       // same text: the agent copy is the latest
      if (ranges) msg.glowRanges = ranges;
    }
    lastRenderedVersion = c.meta.agentVersion;
    notice(same ? "沒有差異：agent 最後寫的版本就是目前的版本（No differences）。" : "");
    startRender(msg);
  }

  // Saves are serialized (refresh() waits on them). The frame gets back the content that was
  // stored, so its baseline is what is saved, not what it holds when the reply arrives.
  function saveFromEditor(content, baseVersion, droppedBlank = false) {
    savesPending++;
    const run = saving.then(() => doSave(content, baseVersion, droppedBlank)).finally(() => { savesPending--; });
    saving = run.catch(() => {});
    return run;
  }

  // Returns true when the content is stored (saved, or already equal to the latest).
  // droppedBlank: the editor had empty paragraphs or block-end spaces that markdown cannot keep
  // (cleanEditorMarkdown).
  async function doSave(content, baseVersion, droppedBlank) {
    if (deleted) { notice("這個畫布已被刪除，無法儲存。請先把內容複製出來。"); return false; }
    try {
      const r = await store.userSave({ id: canvasId, baseVersion, content });
      if (r.unchanged) { flash(droppedBlank ? "沒有內容變更，不需要儲存（markdown 不保留多餘的空行和段落結尾的空白）。" : "沒有內容變更，不需要儲存。"); toFrame({ type: "saved", version: r.version, content }); return true; }
      ownSaveVersion = r.version;
      flash(`✓ 已儲存 v${r.version}`);
      toFrame({ type: "saved", version: r.version, content });
      return true;
    } catch (e) {
      if (e && e.code === "stale") { await openConflict(content); return false; }
      notice(`儲存失敗：${CanvasCore.clipError((e && e.message) || e)}`);
      return false;
    }
  }

  // A short-lived notice for "saved" feedback (Brett: a silent save looked like nothing happened).
  let flashTimer = 0;
  function flash(text) {
    notice(text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (noticeEl.textContent === text) notice(""); }, 3000);
  }

  async function openConflict(mine) {
    pendingSave = mine;
    const c = await load();
    if (!c) return;
    current = c;
    conflictBase = c.meta.version;
    document.getElementById("conflict-why").textContent =
      `你編輯的期間，這個畫布被${c.meta.author === "agent" ? " agent " : "另一個分頁"}更新成 v${c.meta.version}。選一個版本當作最新版。`;
    document.getElementById("conflict-mine").value = mine;      // .value: text, never HTML
    document.getElementById("conflict-latest").value = c.content;
    document.getElementById("conflict-latest-label").firstChild.textContent = `目前的版本 v${c.meta.version}（${c.meta.author === "agent" ? "agent" : "使用者"}）`;
    conflictEl.hidden = false;
    // Take focus out of the editor frame: keys typed behind the overlay are not in pendingSave
    // and would be lost when "keep mine" ends the edit. Not onto a button: a Space/Enter typed
    // while still writing would pick a version unseen. The read-only textarea ignores typing.
    document.getElementById("conflict-mine").focus();
  }

  document.getElementById("conflict-keep").addEventListener("click", async () => {
    conflictEl.hidden = true;
    // Over the version shown, not current: one written while the view was up makes this stale
    // again and reopens the conflict view on it, instead of being overwritten unseen.
    // Resolving the conflict ends the edit (Brett): once "mine" is stored, go back to the view,
    // where the result — and Revert to agent's — are visible.
    if (pendingSave != null && conflictBase && (await saveFromEditor(pendingSave, conflictBase))) {
      pendingSave = null;
      await leaveEdit();
      flash(`✓ 已儲存你的版本 v${current ? current.meta.version : ""}`);
    }
  });
  document.getElementById("conflict-discard").addEventListener("click", () => {
    if (!window.confirm("放棄你尚未儲存的修改？\n\n這個動作無法復原。")) return;
    conflictEl.hidden = true;
    pendingSave = null;
    leaveEdit();
  });
  document.getElementById("conflict-back").addEventListener("click", () => { conflictEl.hidden = true; });

  function enterEdit() {
    if (!current || current.meta.kind !== "markdown" || printing) return;
    mode = "edit";
    dirty = false;
    editUndo = { canUndo: false, canRedo: false };    // a new editor: nothing to undo yet
    disarm();                                          // edit mode: Enter is the editor's
    askDispatch({ type: "edit" });                     // the popover closes; the editor has no selection{}
    notice("");
    toFrame({ type: "edit", content: current.content, version: current.meta.version });
    updateButtons();
  }

  async function leaveEdit() {
    mode = "view";
    dirty = false;
    editUndo = { canUndo: false, canRedo: false };    // the editor and its undo stack are gone
    toFrame({ type: "leaveEdit" });
    await refresh();
  }

  editBtn.addEventListener("click", enterEdit);
  saveBtn.addEventListener("click", () => toFrame({ type: "requestSave" }));
  function requestLeaveEdit() {
    if (mode !== "edit" || !conflictEl.hidden) return;   // the conflict dialog is answered first
    if (dirty && !window.confirm("放棄尚未儲存的修改？")) return;
    leaveEdit();
  }
  cancelBtn.addEventListener("click", requestLeaveEdit);
  // The buttons show their shortcuts (Brett, 2026-10-11): Ctrl/⌘+S saves, Esc leaves edit mode.
  {
    saveBtn.textContent = `💾 儲存 ${mac ? "⌘S" : "Ctrl+S"}`;
    cancelBtn.textContent = "結束編輯 Esc";
    cancelBtn.title = "結束編輯（Esc）";
  }
  revertBtn.addEventListener("click", async () => {
    if (!current) return;
    // §3.5: "cannot be undone" unless the folder mirror holds the current text (then git can). The
    // replaced text stays in history, but nothing in the tab can bring it back (no version walking).
    const undo = mirrorHoldsLatest()
      ? "Katashiro 裡無法復原；目前的內容已寫進資料夾，若你有把資料夾 commit 進 git，可以從 git 找回（資料夾裡的檔案接著會被這次還原改寫）。"
      : "這個動作無法復原。";
    if (!window.confirm(`還原成 agent 最後寫的版本？\n\n你目前的內容會被取代。${undo}`)) return;
    try { await store.revertToAgent({ id: canvasId, baseVersion: current.meta.version }); }
    catch (e) { notice(`還原失敗：${CanvasCore.clipError((e && e.message) || e)}`); return; }
    closeCompareTabs();                     // Revert to agent's also ends a compare (§3.10)
  });

  // --- ↶ 復原 / ↷ 重做 (§3.5, Brett 2026-10-11: "just use editor's undo/redo") ----------------
  // The editor's own history: the frame runs prosemirror-history's undo / redo, the same stack as
  // Ctrl/⌘+Z in the editor, and reports undoState{} back. After a button (or ⌘Z in the header)
  // typing goes on in the editor: mousedown keeps the button from taking focus, but a click in this
  // page still moves the window focus out of the sandboxed (cross-origin) frame, and the frame
  // cannot take it back by itself — its editor still counts as focused inside the frame, and a
  // focus() there without the user's activation does not move window focus. So we focus the frame
  // element here, in the click, before the command (real Chrome 2026-10-12: typing after ↶ went nowhere).
  function editCmd(cmd) {
    if (compareView || mode !== "edit" || deleted || !conflictEl.hidden || !CanvasCore.isEditCmd(cmd)) return;
    if (frame) frame.focus({ preventScroll: true });
    toFrame({ type: "editCmd", cmd });
  }
  for (const [btn, cmd] of [[undoBtn, "undo"], [redoBtn, "redo"]]) {
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => editCmd(cmd));
  }

  // --- Compare with agent's (§3.10) -------------------------------------------------------------
  // The side panel does the tab moves (it holds the §3.1 split records and the canvas group); it
  // checks that the request comes from this canvas tab. Without a panel, the compare view opens
  // here as a normal tab beside this one.
  // The button and the agent's canvas_view({compare: true}) (§3.11) run this same path.
  // → { ok, note? } | { ok: false, error }
  async function startCompare() {
    let r;
    try { r = await chrome.runtime.sendMessage({ type: "katashiro-canvas-compare", id: canvasId, conversationId: current.meta.conversationId }); }
    catch (_) { r = undefined; }
    if (!r) r = await openCompareHere();
    if (!r.ok) { notice(`無法開啟比較：${CanvasCore.clipError(r.error)}`); return r; }
    if (r.note) flash(r.note);
    // Both panes mark the differing blocks, held while the compare is open.
    compareGen++;
    comparing = true;
    updateShowChangesBtn();
    holdCompareGlow();
    return r;
  }
  compareBtn.addEventListener("click", async () => {
    if (!current || compareView || compareBtn.disabled) return;
    compareBtn.disabled = true;
    try { await startCompare(); } finally { compareBtn.disabled = false; }
  });

  // canvas_view({compare: true}) from the side panel (§3.11): the button's preconditions
  // (CanvasCore.compareBlocker, with what only this tab knows: editing, the frame), then its path.
  // No answer while the canvas is still loading (the panel retries); one compare at a time.
  async function onCompareRequest(sendResponse) {
    let agentCopy = null;
    try { agentCopy = await store.readAgentCopy(canvasId); } catch (_) { /* none */ }
    const c = current;                        // re-read after the await: deleted meanwhile → null
    if (!c) { sendResponse({ ok: false, error: "the canvas was deleted" }); return; }
    const blocked = CanvasCore.compareBlocker({
      kind: c.meta.kind, author: c.meta.author, agentCopy, content: c.content,
      editing: mode !== "view", framed: !!frame, deleted,
    });
    if (blocked) { sendResponse({ ok: false, error: blocked }); return; }
    if (compareBtn.disabled) { sendResponse({ ok: false, error: "a compare is already being opened" }); return; }
    compareBtn.disabled = true;
    try { sendResponse(await startCompare()); }
    catch (e) { sendResponse({ ok: false, error: (e && e.message) || String(e) }); }
    finally { compareBtn.disabled = false; }
  }

  async function openCompareHere() {
    try {
      const tabs = await chrome.tabs.query({});
      const old = tabs.find((t) => CanvasTabs.isCompareTabFor(t, CANVAS_BASE, canvasId));
      if (old) { await chrome.tabs.update(old.id, { active: true }); return { ok: true }; }
      const me = await chrome.tabs.getCurrent();
      if (!me) return { ok: false, error: "找不到這個分頁" };
      await chrome.tabs.create(CanvasTabs.compareTabProps(me, CanvasTabs.compareTabUrl(CANVAS_BASE, canvasId), false));
      return { ok: true, note: "側邊面板沒有開：比較畫面開在一般分頁（沒有 Split View）。" };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  async function closeCompareTabs() {
    try {
      const ids = (await chrome.tabs.query({})).filter((t) => CanvasTabs.isCompareTabFor(t, CANVAS_BASE, canvasId)).map((t) => t.id);
      if (ids.length) await chrome.tabs.remove(ids);
    } catch (_) { /* already closed */ }
  }

  // Closing the canvas tab closes its compare tab too (§3.10): once no tab shows this canvas, the
  // compare tab closes itself. (Closing the compare tab just ends the split; Chrome does that.)
  // Also checked once at start: a compare tab reopened (Ctrl+Shift+T) after its canvas tab closed.
  async function closeIfCanvasGone() {
    const canvasUrl = `${CANVAS_BASE}?id=${encodeURIComponent(canvasId)}`;
    try {
      const tabs = await chrome.tabs.query({});
      if (!tabs.some((t) => t.url === canvasUrl || t.pendingUrl === canvasUrl)) closeThisTab();
    } catch (_) { /* stays open */ }
  }
  if (compareView) {
    chrome.tabs.onRemoved.addListener(closeIfCanvasGone);
    // A canvas tab navigated elsewhere no longer shows the canvas either.
    chrome.tabs.onUpdated.addListener((_id, info) => { if (info.url) closeIfCanvasGone(); });
    closeIfCanvasGone();
  }
  document.addEventListener("keydown", (e) => {
    if (mode === "edit" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); toFrame({ type: "requestSave" }); }
    // Focus in the header (not the editor) while editing: Ctrl/⌘+Z still undoes the editor's edits.
    if (mode === "edit" && conflictEl.hidden && (e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "z" || (k === "y" && !mac)) { e.preventDefault(); editCmd(k === "z" && !e.shiftKey ? "undo" : "redo"); }
    }
    if (mode === "edit" && e.key === "Escape" && !CanvasCore.imeKey(e) && conflictEl.hidden) { e.preventDefault(); requestLeaveEdit(); }
  });
  window.addEventListener("beforeunload", (e) => { if (mode === "edit" && dirty) { e.preventDefault(); e.returnValue = ""; } });

  window.addEventListener("message", (event) => {
    const m = CanvasCore.acceptFrameMessage(event, { frameWindow: frame && frame.contentWindow, nonce, readOnly: compareView, profile: frameProfile });
    if (!m) return;
    if (frameProfile === "html") { onHtmlFrameMessage(m); return; }
    switch (m.type) {
      case "ready":
        frameReady = true;
        if (agentSheets.length) toFrame({ type: "css", sheets: agentSheets });
        sendRender();
        updateButtons();
        break;
      case "slide":
        finishGoto({ ok: true, index: m.index, total: m.total });
        break;
      case "printed":
        if (printing) { printing = null; mountFrame(); }        // back to the normal slides view
        break;
      case "rendered":
        if (printing && !printing.sent) { printing.sent = true; toFrame({ type: "print" }); }
        if (m.seq !== renderingSeq) break;                   // an older render; a newer one is on its way
        rendered = true;
        renderFailed = "";
        shownDiagrams = CanvasCore.diagramsReport(m.diagrams || []) || [];
        updateEngineBtn();
        if (pendingEngine && m.seq >= pendingEngine.seq) finishEngine(pendingEngine.answer());
        if (CanvasCore.renderNoticeStale(noticeTag, m.seq)) notice("");    // an older render's error
        maybePeleNotice(shownDiagrams);
        if (pendingGoto && !pendingGoto.sent) { pendingGoto.sent = true; toFrame({ type: "goto", slide: pendingGoto.slide }); }
        if (pendingHighlight && !pendingHighlight.sent) sendHighlight();
        if (comparing && !compareView) holdCompareGlow();     // re-mark on the new DOM
        else if (showChanges) applyHeldChanges();
        if (typeof m.normalized === "string" && m.version === awaitingNormalize) {
          awaitingNormalize = 0;
          store.applyNormalized({ id: canvasId, version: m.version, normalized: m.normalized }).catch(() => {});
        }
        break;
      case "save":
        if (mode === "edit") saveFromEditor(m.content, m.baseVersion, m.droppedBlank === true);
        break;
      case "escape":
        // The frame's dirty state as of the keypress; its "dirty" message may still be debounced.
        dirty = m.dirty;
        updateButtons();
        requestLeaveEdit();
        break;
      case "dirty":
        dirty = m.dirty;
        updateButtons();
        break;
      case "undoState":
        if (mode !== "edit") break;                 // a late report from an editor already closed
        editUndo = { canUndo: m.canUndo, canRedo: m.canRedo };
        updateButtons();
        break;
      case "highlighted":
        onHighlighted(m);
        break;
      case "selection":
        onSelection(m);
        break;
      case "armedKey":
        // Only while armed and the frame holds the focus (a report from a frame not focused is not a
        // key the user pressed there).
        if (armed && document.hasFocus() && frame && document.activeElement === frame) onArmedKey(m, null);
        else if (armed && m.key === "mousedown") disarm();
        break;
      case "selectionRect":
        if (!CanvasCore.fromOlderRender(m, renderingSeq)) askDispatch({ type: "rect", seq: m.seq, rect: m.rect });
        break;
      case "error":
        // Render N failing after startRender(N+1) says nothing about N+1: it must not fail the goto /
        // highlight waiting for it, nor mark it failed (#115 review). No seq: a CSP report or a goto.
        if (CanvasCore.fromOlderRender(m, renderingSeq)) break;
        if (printing) mountFrame();      // back to the normal view; a later render must never print()
        if (!rendered) renderFailed = CanvasCore.clipError(m.msg);    // the render failed (not a later CSP report)
        if (pendingEngine && CanvasCore.failsEngineWait(m, pendingEngine.seq, rendered)) finishEngine({ ok: false, error: `the canvas failed to show: ${CanvasCore.clipError(m.msg)}` });
        if (compareView) notice(`顯示時發生錯誤：${CanvasCore.clipError(m.msg)}`, null, { seq: renderingSeq, version: renderingVersion });
        else offerSendError(m.msg, false, { seq: renderingSeq, version: renderingVersion });
        finishGoto({ ok: false, error: `the canvas failed to show: ${CanvasCore.clipError(m.msg)}` });
        finishHighlight({ ok: false, error: `the canvas failed to show: ${CanvasCore.clipError(m.msg)}` });
        break;
      case "diagramFallback":
        // Drawn by the other engine (canvas-diagram-engine §2.4): the figure says so; no banner. Kept
        // for this render, so a diagram error's "send to agent" carries it too.
        if (m.seq !== renderingSeq) break;
        fallbackSeq = m.seq;
        fallbackMsg = m.msg;
        break;
      case "diagramError": {
        // A diagram both engines failed to draw (§3.3): it shows its errors in place and the canvas
        // stands, so nothing is marked failed and pending goto / highlight carry on.
        if (m.seq !== renderingSeq) break;                   // an older render's
        const msg = fallbackSeq === m.seq && fallbackMsg ? `${m.msg}\n\n(other diagrams were drawn by the fallback engine:)\n${fallbackMsg}` : m.msg;
        if (compareView) notice(`圖表有錯誤：${CanvasCore.clipError(m.msg)}`, null, { seq: renderingSeq, version: renderingVersion });
        else offerSendError(msg, true, { seq: renderingSeq, version: renderingVersion });
        break;
      }
      case "editFailed":
        mode = CanvasCore.modeAfterFrameMessage(m.type, { mode });
        dirty = false;                   // #93: no editor opened, so nothing unsaved
        editUndo = { canUndo: false, canRedo: false };
        updateButtons();
        offerSendError(m.msg);
        break;
      case "copy": {
        const reply = (ok) => frame && frame.contentWindow.postMessage({ type: "copied", nonce, reqId: m.reqId, ok }, "*");
        navigator.clipboard.writeText(m.text).then(() => reply(true), () => reply(false));
        break;
      }
      case "openLink":
        openLinkConfirm(m.url);
        break;
    }
  });

  // canvas-html-frame.html (canvas-html §2.4): ready → its one render; rendered{version} ends the
  // write's load expectation; error{} is shown as text, and 送給 agent 修 sends it only labelled as
  // page-reported, fenced (§2.7); openLink as everywhere. Agent script runs there: nothing it sends
  // is stored, or forwarded unlabelled.
  // canvas-html §2.7: once rendered, the agent's sheets and a waiting canvas_highlight go to it;
  // highlighted / styled / pageSelection answer the host's own requests (page-reported, see there).
  function onHtmlFrameMessage(m) {
    switch (m.type) {
      case "ready":
        frameReady = true;
        sendHtmlRender();
        break;
      case "rendered":
        if (!htmlRun || m.version !== htmlRun.version) break;
        rendered = true;
        if (htmlArm) armHtmlLoad(htmlArm.token, HTML_ARM_MS);   // the write is done: its load is near
        if (agentSheets.length) postHtmlCss(null);
        if (pendingHighlight && !pendingHighlight.sent) sendHighlight();
        updateButtons();
        break;
      case "error":
        // A CSP report must not wipe out 「vN 已自動執行」: the user would not see the code changed.
        offerSendError(m.msg, false, { seq: 0, version: htmlRun ? htmlRun.version : undefined }, htmlAutoNote, true);
        break;
      case "highlighted":
        onHighlighted(m);
        break;
      case "styled":
        onStyled(m);
        break;
      case "pageSelection":
        finishPageSelection(m.reqId, { text: m.text, truncated: m.truncated === true });
        break;
      case "openLink":
        openLinkConfirm(m.url);
        break;
    }
  }
  function openLinkConfirm(raw) {
    const url = CanvasCore.safeLinkUrl(raw);
    if (!url) { notice("已擋下一個非 http(s) 的連結。"); return; }
    // The full URL is shown before anything opens: canvas content is agent-authored.
    if (window.confirm(`在新分頁開啟這個連結？\n\n${url}`)) chrome.tabs.create({ url, active: true });
  }

  // Live updates: the panel writes a new version → re-read and re-render in place.
  // canvas_goto (from the side panel, same extension only): show slide N of THIS canvas. Answered
  // once the frame reports the slide it now shows; a frame not rendered yet gets it after rendering.
  // Always answered: by the frame, a frame error / drop, a newer goto, or the timer (Jellyfish #79).
  // Two tabs of the same canvas both move; the first to answer wins (ADR, canvas_goto).
  const GOTO_TIMEOUT_MS = 5000;
  let rendered = false;
  let pendingGoto = null;                     // { slide, respond, sent, timer }
  function finishGoto(result) {
    if (!pendingGoto) return;
    const { respond, timer } = pendingGoto;
    pendingGoto = null;
    clearTimeout(timer);
    respond(result);
  }
  const PANEL_URL = chrome.runtime.getURL("sidepanel.html");
  let myTabId = null;                         // canvas_view compare targets one tab (§3.11)
  chrome.tabs.getCurrent().then((t) => { myTabId = t && t.id != null ? t.id : null; }, () => {});
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only the side panel: not a content script (sender.tab), not another extension page.
    if (!sender || sender.id !== chrome.runtime.id || sender.tab || sender.url !== PANEL_URL) return false;
    if (compareView) return false;              // goto / highlight are for the canvas, never its compare tab
    // Multi-conversation P1b §4.5: archiving asks before closing this tab. Only the tab the panel
    // asked answers (two tabs of one canvas each have their own editor).
    if (msg && msg.type === "katashiro-canvas-dirty") {
      if (myTabId == null || msg.tabId !== myTabId) return false;
      // A save still running counts: the editor already reported clean, the content is not stored yet.
      sendResponse({ ok: true, dirty: (mode === "edit" && dirty) || savesPending > 0 });
      return false;
    }
    if (msg && msg.type === "katashiro-canvas-highlight" && msg.id === canvasId) return onHighlightRequest(msg, sendResponse);
    if (msg && msg.type === "katashiro-canvas-css" && msg.id === canvasId) return onCssRequest(msg, sendResponse);
    if (msg && msg.type === "katashiro-canvas-engine" && msg.id === canvasId && !compareView) return onEngineRequest(msg, sendResponse);
    if (msg && msg.type === "katashiro-canvas-compare-start" && msg.id === canvasId) {
      // Only the tab the panel picked: two tabs of one canvas must not both open a compare.
      if (myTabId == null || msg.tabId !== myTabId) return false;
      if (!current) return false;               // still loading: the panel asks again
      onCompareRequest(sendResponse);
      return true;                              // answer asynchronously
    }
    if (!msg || msg.type !== "katashiro-canvas-goto" || msg.id !== canvasId) return false;
    if (!Number.isInteger(msg.slide) || msg.slide < 1) { sendResponse({ ok: false, error: "slide must be a positive integer" }); return false; }
    if (current && current.meta.kind !== "slides") { sendResponse({ ok: false, error: `this canvas is ${current.meta.kind}, not slides` }); return false; }
    if (mode === "edit") { sendResponse({ ok: false, error: "the user is editing this canvas" }); return false; }
    finishGoto({ ok: false, error: "superseded by a newer goto" });
    if (renderFailed) { sendResponse({ ok: false, error: `the canvas failed to show: ${renderFailed}` }); return false; }
    const timer = setTimeout(() => finishGoto({ ok: false, error: "the slides did not respond in time" }), GOTO_TIMEOUT_MS);
    pendingGoto = { slide: msg.slide, respond: sendResponse, sent: false, timer };
    if (frame && frameReady && rendered) { pendingGoto.sent = true; toFrame({ type: "goto", slide: msg.slide }); }
    return true;                              // answer asynchronously
  });

  // canvas_highlight (§3.10), from the side panel like goto. The frame finds the block by its
  // rendered text and answers highlighted{}; always answered (frame, drop, newer request, timer).
  // While the user edits nothing scrolls or takes focus: the frame only checks the anchor, and the
  // header offers "Agent wants to show you a section" to go there.
  const HIGHLIGHT_TIMEOUT_MS = 5000;
  let highlightSeq = 0;
  let pendingHighlight = null;                // { reqId, req, respond, sent, timer }
  function finishHighlight(result) {
    if (!pendingHighlight) return;
    const { respond, timer } = pendingHighlight;
    pendingHighlight = null;
    clearTimeout(timer);
    respond(result);
  }
  function sendHighlight() {
    pendingHighlight.sent = true;
    toFrame({ type: "highlight", reqId: pendingHighlight.reqId, ...pendingHighlight.req });
  }
  function queueHighlight(req, respond) {
    finishHighlight({ ok: false, error: "superseded by a newer highlight" });
    if (renderFailed) { respond({ ok: false, error: `the canvas failed to show: ${renderFailed}` }); return; }
    const timer = setTimeout(() => finishHighlight({ ok: false, error: frameProfile === "html"
      ? "the html canvas's running page did not confirm it (its own script may have replaced Katashiro's listener); nothing is known to be shown"
      : "the canvas did not respond in time" }), HIGHLIGHT_TIMEOUT_MS);
    pendingHighlight = { reqId: ++highlightSeq, req, respond, sent: false, timer };
    if (frame && frameReady && rendered) sendHighlight();
  }
  function onHighlighted(m) {
    if (!pendingHighlight || m.reqId !== pendingHighlight.reqId) return;
    const r = { ok: m.ok, tag: m.tag, text: m.text, slide: m.slide, error: m.error };
    if (frameProfile === "html") r.running = true;   // answered by the running page (best effort, §2.7)
    if (m.ok && pendingHighlight.req.check) {
      offerHighlight(pendingHighlight.req);
      r.deferred = true;
    }
    finishHighlight(r);
  }
  function offerHighlight(req, text) {
    notice(text || "Agent 想指給你看一個段落（Agent wants to show you a section）", {
      label: "前往",
      fn: async () => {
        if (mode === "edit" && dirty) { offerHighlight(req, "先儲存或結束編輯，就能前往 agent 指的段落。"); return; }
        notice("");
        if (mode === "edit") await leaveEdit();
        // The section may be gone by now: say so, since no agent is waiting on this answer.
        queueHighlight({ ...req, check: false }, (r) => { if (!r.ok && !/^superseded/.test(r.error)) notice(`找不到 agent 指的段落：${CanvasCore.clipError(r.error)}`); });
      },
    });
  }
  // canvas_inject_css, from the side panel like highlight (browser-mcp checked the sheet). This tab
  // keeps the sheets and the frame gets all of them on every change and on every (re)mount; a
  // reload of the tab drops them. Refused while the user edits; clear always works.
  const { CSS_SHEETS_MAX, CSS_SHEET_MAX } = CanvasCore;
  let agentSheets = [];
  // An html canvas (canvas-html §2.7): its static view takes the sheets as markdown does (inside its
  // shadow root); a RUNNING page gets them as css{reqId, sheets} and answers styled{} — without that
  // answer in time the result says it was not confirmed (the page's script can drop our listener or
  // the <style>). The sheets stay here either way and go again to the next frame.
  const CSS_CONFIRM_MS = 2000;
  let pendingCss = null;              // { reqId, respond, timer, sheets }
  function postHtmlCss(respond) {
    if (pendingCss) { const p = pendingCss; pendingCss = null; clearTimeout(p.timer); p.respond({ ok: true, sheets: p.sheets, note: "superseded by a newer canvas_inject_css before the running page confirmed it" }); }
    const sheets = agentSheets.length;
    if (!respond) { toFrame({ type: "css", reqId: ++htmlReqSeq, sheets: agentSheets }); return; }
    if (!rendered) { respond({ ok: true, sheets, note: "the html canvas's page has not finished rendering; the sheets go to it once it has" }); return; }
    const reqId = ++htmlReqSeq;
    pendingCss = { reqId, respond, sheets, timer: setTimeout(() => onStyled({ reqId, timeout: true }), CSS_CONFIRM_MS) };
    toFrame({ type: "css", reqId, sheets: agentSheets });
  }
  function onStyled(m) {
    if (!pendingCss || m.reqId !== pendingCss.reqId) return;
    const { respond, timer, sheets } = pendingCss;
    pendingCss = null;
    clearTimeout(timer);
    respond(m.timeout
      ? { ok: true, sheets, note: "the html canvas's running page did not confirm it (its own script may have replaced Katashiro's listener); it may not show — screenshot to check" }
      : { ok: true, sheets });
  }
  function onCssRequest(msg, sendResponse) {
    if (msg.clear === true) {
      agentSheets = [];
      if (frameProfile === "html") { postHtmlCss(sendResponse); return true; }
      toFrame({ type: "css", sheets: [] });
      sendResponse({ ok: true, sheets: 0 });
      return false;
    }
    if (typeof msg.css !== "string" || !msg.css.trim() || msg.css.length > CSS_SHEET_MAX) { sendResponse({ ok: false, error: "css must be 1–20000 chars" }); return false; }
    if (mode === "edit") { sendResponse({ ok: false, error: "the user is editing this canvas; try again when they are done" }); return false; }
    if (current && !frame) { sendResponse({ ok: false, error: "the canvas is not shown in its tab" }); return false; }
    if (agentSheets.length >= CSS_SHEETS_MAX) { sendResponse({ ok: false, error: `${CSS_SHEETS_MAX} stylesheets are already applied; clear them first` }); return false; }
    agentSheets = [...agentSheets, msg.css];
    if (frameProfile === "html") { postHtmlCss(sendResponse); return true; }
    toFrame({ type: "css", sheets: agentSheets });
    sendResponse({ ok: true, sheets: agentSheets.length });
    return false;
  }

  function onHighlightRequest(msg, sendResponse) {
    const hasFind = typeof msg.find === "string", hasHeading = typeof msg.heading === "string";
    if (hasFind === hasHeading) { sendResponse({ ok: false, error: "give exactly one of find / heading" }); return false; }
    if (current && !["markdown", "slides", "html"].includes(current.meta.kind)) { sendResponse({ ok: false, error: `this canvas is ${current.meta.kind}; only markdown, slides and html can be highlighted` }); return false; }
    if (current && !frame) { sendResponse({ ok: false, error: "the canvas is not shown in its tab" }); return false; }
    const req = {
      find: hasFind ? msg.find.slice(0, 2000) : undefined,
      heading: hasHeading ? msg.heading.slice(0, 2000) : undefined,
      label: typeof msg.label === "string" ? Array.from(msg.label).slice(0, 80).join("") : "",
      durationMs: Number.isFinite(msg.durationMs) ? msg.durationMs : undefined,
      check: mode === "edit",
    };
    queueHighlight(req, sendResponse);
    return true;                              // answer asynchronously
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const sc = changes[CanvasCore.SHOW_CHANGES_KEY];
    if (sc && !compareView) setShowChanges(sc.newValue === true);
    const mc = changes[CanvasStore.metaKey(canvasId)];
    if (!mc && !changes[CanvasStore.latestKey(canvasId)]) return;
    // Only the folder mirror's bookkeeping changed: update the file status, no re-render.
    if (mc && !changes[CanvasStore.latestKey(canvasId)] && CanvasMirror.onlyMirrorFieldsChanged(mc.oldValue, mc.newValue)) {
      if (current) current.meta = { ...current.meta, file: mc.newValue.file, fileSyncedVersion: mc.newValue.fileSyncedVersion };
      updateFileStatus();
      return;
    }
    refresh().then(() => syncFile());           // storage first, then the file (§3.6)
  });

  // --- Folder mirror (§3.6) --------------------------------------------------------------------
  let folder = { configured: false };          // CanvasMirror.folderStatus(), refreshed with the header
  let shownFileState = null;
  async function updateFileStatus() {
    const meta = current && current.meta;
    folder = { configured: false };
    // noMirror: a canvas an incognito panel left before #109 — never mirrored, so no folder status;
    // read until the onInstalled cleanup (background.js) has removed it.
    if (meta && !meta.noMirror) { try { folder = await CanvasMirror.folderStatus(); } catch (_) { /* no folder */ } }
    const granted = folder.configured && folder.permission === "granted";
    // Until the user reconnects, writes stay in storage and are flushed on reconnect.
    reconnectBtn.hidden = !(folder.configured && !granted) || deleted;
    reconnectBtn.title = folder.configured ? `資料夾「${folder.name}」需要重新授權；在那之前修改只存在 Katashiro 裡，連上後會補寫` : "";
    const d = granted && meta && meta.file && meta.file.folder === folder.folderId ? CanvasMirror.describeState(meta.file) : null;
    fileEl.hidden = !d;
    if (d) {
      fileEl.textContent = d.text;            // textContent: the conflict file name derives from an agent title
      fileEl.title = d.title;
      fileEl.classList.toggle("warn", d.level === "warn");
    }
    const state = d ? meta.file.state : null;
    rewriteBtn.hidden = (state !== "deleted" && state !== "missing") || deleted || compareView;
    if (d && d.level === "warn" && state !== shownFileState) notice(d.title);
    shownFileState = state;
  }
  // The folder has this canvas's current text (the destructive dialogs can say so, §3.5).
  function mirrorHoldsLatest() {
    const m = current && current.meta;
    return !!(m && m.file && folder.configured && folder.permission === "granted" && m.file.folder === folder.folderId &&
      CanvasMirror.stateOf(m.file) === "ok" && m.fileSyncedVersion === m.version);    // legacy "recreated" reads as ok (#106)
  }
  function syncFile(opts) {
    if (deleted || compareView) return Promise.resolve();    // a compare tab is read-only (§3.10): the canvas tab writes
    return mirror.sync(canvasId, opts).catch(() => {}).then(updateFileStatus);
  }
  // 1B (Brett 2026-10-11): a file deleted outside stops this canvas's mirroring; this writes it again.
  // Every outcome says something: a click that changes nothing on screen reads as a broken button.
  function rewriteResult(r) {
    if (r.action === "write") return { flash: "📁 已重新寫進資料夾，恢復同步" };
    if ((r.action === "none" || r.action === "adopt") && r.state === "ok") return { flash: "📁 資料夾裡的檔案已經是最新的，恢復同步" };
    if (r.action === "conflict") {
      return { notice: `📁 資料夾裡的檔案回來了，但在 Katashiro 外被修改過 — 沒有覆寫它；最新內容另存成 ${r.conflictName || "另一個 .katashiro-<時間>.md"}` };
    }
    if (r.action === "held") return { notice: "畫布正在整理格式，稍後再按一次「重新寫入」。" };
    if (r.action === "skipped") return { notice: "這個畫布不會寫進資料夾。" };
    if (r.action === "disconnected") return { notice: "資料夾需要重新授權，請先按 Reconnect folder。" };
    if (r.action === "error") return { notice: `寫入資料夾失敗：${CanvasCore.clipError(r.error)}` };
    return { notice: `沒有寫入資料夾（${r.action}${r.state ? `，${r.state}` : ""}）。` };
  }
  rewriteBtn.addEventListener("click", async () => {
    rewriteBtn.disabled = true;
    let msg;
    try {
      msg = rewriteResult(await mirror.sync(canvasId, { rewrite: true }));
    } catch (e) {
      msg = { notice: `寫入資料夾失敗：${CanvasCore.clipError((e && e.message) || e)}` };
    } finally {
      rewriteBtn.disabled = false;
      await updateFileStatus();
    }
    // After the status update, whose own notice for a new warn state would replace this one.
    if (msg.flash) flash(msg.flash);
    else notice(msg.notice);
  });
  reconnectBtn.addEventListener("click", async () => {
    reconnectBtn.disabled = true;
    try {
      if (await CanvasMirror.requestAccess()) {
        await mirror.syncAll();               // flush every canvas saved while disconnected
        flash("📁 資料夾已重新連線，補寫完成");
      } else {
        notice("沒有取得資料夾的權限；畫布照常存在 Katashiro 裡。");
      }
    } catch (e) {
      notice(`重新連線失敗：${CanvasCore.clipError((e && e.message) || e)}`);
    } finally {
      reconnectBtn.disabled = false;
      updateFileStatus();
    }
  });

  async function refresh() {
    await saving;                     // our own save's onChanged can beat its reply: know ownSaveVersion first
    const c = await load();
    if (!c) {
      // Deleted (here, in another tab, or by the agent after the user confirmed; eviction never takes
      // an open canvas): close this tab, so nothing can edit or re-save a canvas that no longer exists.
      // Unsaved edits are the exception: they stay on screen, with every action gone, to be copied out.
      deleted = true;
      current = null;
      deleteBtn.hidden = true;
      if (mode === "edit" && dirty) {
        notice("這個畫布已被刪除。你還沒儲存的內容留在編輯器裡，複製出來後關閉分頁即可。");
        updateButtons();
        return;
      }
      if (frame) dropFrame("這個畫布已被刪除。");
      updateButtons();
      closeThisTab();
      return;
    }
    const prev = current;
    current = c;
    setHeader(c.meta);
    // An html canvas (canvas-html §2.6): with the canvas's grant a new revision runs at once in a
    // fresh frame (new nonce) and the header says so; without it, back to the static view. The
    // running frame is never re-rendered (§2.4 host invariant).
    if (c.meta.kind === "html" && !compareView && (await reconcileHtml())) return;
    if (current !== c) return;                                    // superseded while reading the grant
    // A rename (meta-only, Brett 2026-11-01): same version, same text — the header is enough.
    if (prev && mode !== "edit" && c.meta.version === prev.meta.version && c.content === prev.content && c.meta.title !== prev.meta.title) return;
    if (mode === "edit") {
      if (prev && c.meta.version === prev.meta.version) return;      // e.g. normalization of the agent copy
      if (c.meta.version === ownSaveVersion) return;                  // our own save
      if (!dirty) {
        // A clean editor gives way to the new version (§3.5).
        mode = "view";
        toFrame({ type: "leaveEdit" });
        notice(`${c.meta.author === "agent" ? "Agent" : "另一個分頁"} 更新成 v${c.meta.version}，已切回檢視。`);
        sendRender();
        updateButtons();
        return;
      }
      notice(`${c.meta.author === "agent" ? "Agent" : "另一個分頁"} 存了 v${c.meta.version}。你可以繼續編輯；儲存時會讓你選要保留哪個版本。`);
      return;
    }
    await sendRender();
  }

  // Close this canvas tab. Fails quietly (the tab then just shows the "deleted" notice).
  function closeThisTab() {
    try {
      chrome.tabs.getCurrent((tab) => { if (tab && tab.id != null) chrome.tabs.remove(tab.id, () => void chrome.runtime.lastError); });
    } catch (_) { /* stays open */ }
  }

  (async () => {
    const c = await load();
    if (!c) return;
    await readEngineSetting();                  // the first render already uses the right engine
    current = c;
    setHeader(c.meta);
    // An html canvas with a grant runs at once (canvas-html §2.6), never via a static frame first.
    if (c.meta.kind === "html" && !compareView) {
      try { htmlOn = CanvasStore.htmlEnabled((await chrome.storage.local.get(CanvasStore.HTML_ENABLED_KEY))[CanvasStore.HTML_ENABLED_KEY]); } catch (_) { /* apply() reads it too */ }
      await reconcileHtml();
    }
    if (!frame) mountFrame();                   // no grant (or a refresh meanwhile left none mounted)
    if (compareView) return;
    deleteBtn.hidden = false;
    readConvTitle();
    store.touch(canvasId).catch(() => {});      // "last opened", for eviction order (§3.6)
    // Catch up this canvas, and notice a file changed or deleted outside Katashiro (never imported).
    syncFile({ check: true });
  })();

  // The gallery (§3.7): reuse its tab if one is open, else open it in this window.
  document.getElementById("canvas-gallery").addEventListener("click", () => {
    CanvasTabs.openGalleryTab(chrome, chrome.runtime.getURL("canvas-gallery.html")).catch(() => {});
  });

  // --- 🗨️ 對話 (multi-conversation §7.2) --------------------------------------------------------
  // This canvas's conversation in the side panel of this tab's window: switched to if open there,
  // reopened if archived (this tab then joins its group), or the window that has it named. Also the
  // button of an "已封存" refusal (askPanel). The button shows the conversation's title (conv:index).
  // myWindowId (refreshPanelHere, above) is this tab's window, cached: the click must not await.
  // A tab dragged to another window is attached there: read it again.
  try { chrome.tabs.onAttached.addListener(() => { refreshPanelHere(); }); } catch (_) { /* no tabs events */ }
  let convTitle = "";
  async function readConvTitle(cidNow) {
    const cid = cidNow || (current && current.meta.conversationId);
    if (compareView || !cid) { convBtn.hidden = moveBtn.hidden = true; return; }
    let idx = {};
    try { idx = (await chrome.storage.local.get(ConvCore.INDEX_KEY))[ConvCore.INDEX_KEY] || {}; } catch (_) { /* untitled */ }
    convTitle = ConvCore.displayTitle(idx[cid], cid);
    convBtn.textContent = `🗨️ ${convTitle}`;
    convBtn.title = `在側邊欄打開這個畫布的對話「${convTitle}」（已封存的會重新打開）`;
    convBtn.hidden = moveBtn.hidden = false;
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !current) return;
    // Moved (§7.3, here or from the gallery): the meta's new conversation, before refresh() has run.
    const mc = changes[CanvasStore.metaKey(canvasId)];
    const moved = mc && mc.newValue && mc.oldValue && mc.newValue.conversationId !== mc.oldValue.conversationId ? mc.newValue.conversationId : null;
    if (moved || changes[ConvCore.INDEX_KEY]) readConvTitle(moved);
  });
  // No await before chrome.sidePanel.open: it needs this click's user gesture. `retry`: from a
  // refusal, what to do again once the conversation is open.
  function openConversation(retry) {
    const id = current && current.meta.conversationId;
    if (!id) return undefined;
    const wid = myWindowId;
    if (wid == null) { notice("找不到這個分頁所在的視窗，請重新整理再試。"); return undefined; }
    try { chrome.sidePanel.open({ windowId: wid }).catch(() => {}); } catch (_) { /* old Chrome: the panel may already be open */ }
    convBtn.disabled = true;
    return (async () => {
      let answer;
      try { answer = await CanvasTabs.requestConvOpen(chrome, { id, windowId: wid, canvasId, keyPrefix: ConvCore.REOPEN_KEY_PREFIX }); }
      finally { convBtn.disabled = false; }
      const title = convTitle || "對話";
      if (answer && answer.ok) {
        if (retry) notice(`已在側邊欄打開「${title}」：${retry}。`);
        else flash(`已在側邊欄打開「${title}」。`);
      } else if (answer && answer.error) {
        const go = Number.isInteger(answer.windowId)
          ? { label: "前往那個視窗", fn: () => chrome.windows.update(answer.windowId, { focused: true }).catch(() => {}) } : null;
        notice(`沒有打開：${CanvasCore.clipError(answer.error)}`, go);
      } else {
        notice(`已打開側邊欄：對話會在側邊欄載入後打開${retry ? `，之後${retry}` : ""}。`);
      }
    })();
  }
  convBtn.addEventListener("click", () => { openConversation(); });

  // --- Rename (Brett 2026-11-01): click the title, edit it in place --------------------------------
  // Enter or blur saves, Esc cancels. CanvasStore.rename is meta-only (no new version), so it is
  // allowed while the content is being edited too. Every tab, the gallery and the side panel's
  // cards follow through storage.onChanged (meta + index). textContent / input.value only.
  let renaming = null;
  titleEl.title = "點一下改名";
  titleEl.classList.add("renamable");
  titleEl.addEventListener("click", () => {
    if (renaming || !current || deleted || compareView) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "canvas-title-input";
    input.maxLength = TITLE_MAX;
    input.value = String(current.meta.title || "");
    input.setAttribute("aria-label", "畫布名稱");
    renaming = input;
    titleEl.hidden = true;
    titleEl.after(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const t = input.value.trim();
      input.remove();
      titleEl.hidden = false;
      renaming = null;
      if (!save || !current || t === String(current.meta.title || "")) return;
      if (!t) { notice("名稱不能是空的，沒有改名。"); return; }
      try {
        await store.rename({ id: canvasId, title: t, by: "user" });
        titleEl.textContent = t;                 // onChanged → refresh() follows with the stored meta
      } catch (e) {
        notice(`改名失敗：${CanvasCore.clipError((e && e.message) || e)}`);
      }
    };
    input.addEventListener("keydown", (ev) => {
      if (CanvasCore.imeKey(ev)) return;        // IME: Enter confirms the composition, not the name
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  });

  // --- ↪ 移到其他對話 (multi-conversation §7.3) ---------------------------------------------------
  // The picker lists every other conversation (open or archived, never a deleted one); the move is
  // CanvasStore.move: only conversationId changes. The side panels follow it (tab group, folder
  // mirror, a host line for each agent); this tab re-reads its header from the meta change.
  moveBtn.addEventListener("click", async () => {
    if (!current || moveBtn.disabled) return;
    const from = current.meta.conversationId;
    const title = String(current.meta.title || "Canvas").slice(0, 60);
    let index = {};
    try { index = (await chrome.storage.local.get(ConvCore.INDEX_KEY))[ConvCore.INDEX_KEY] || {}; } catch (_) { /* none */ }
    const now = Date.now();
    if (!ConvCore.moveTargets({ index, exclude: from, now }).length) { flash("沒有其他對話可以移過去。"); return; }
    const to = await ConvPicker.open({
      heading: `把「${title}」移到…`,
      hint: "內容、版本紀錄和圖片都會跟著走；原本那段對話的 agent 之後就讀不到也改不了它，兩邊的 agent 都會在下一則訊息收到通知。",
      rows: (q) => ConvCore.moveTargets({ index, exclude: from, query: q, now }),
    });
    if (!to) return;
    moveBtn.disabled = true;
    try {
      // Picked from a list read before the dialog: deleted meanwhile → refused here (§7.1).
      const fresh = (await chrome.storage.local.get(ConvCore.INDEX_KEY))[ConvCore.INDEX_KEY] || {};
      const gone = ConvCore.reopenRefusal(fresh[to]);
      if (gone) { notice(`沒有移過去：${gone}`); return; }
      await store.move({ id: canvasId, from, to });
      flash(`已移到「${ConvCore.displayTitle(fresh[to], to)}」。`);
    } catch (e) {
      notice(`沒有移過去：${CanvasCore.clipError((e && e.message) || e)}`);
    } finally {
      moveBtn.disabled = false;
    }
  });

  // #70: delete. Its history goes with it (§3.5), so it says it cannot be undone.
  deleteBtn.addEventListener("click", async () => {
    const title = current ? current.meta.title : "";
    const kept = current && current.meta.file ? "\n資料夾裡的檔案不會被刪除。" : "";
    if (!window.confirm(`刪除畫布「${String(title).slice(0, 60)}」？\n\n這個動作無法復原。${kept}`)) return;
    try {
      await store.remove({ id: canvasId });
    } catch (e) {
      notice(`刪除失敗：${CanvasCore.clipError((e && e.message) || e)}`);
    }
  });
})();
