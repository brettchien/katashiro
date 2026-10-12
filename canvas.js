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
  // The compare tab's own way out (Brett, 2026-10-11): closing it ends the compare (§3.10).
  if (compareView) {
    endCompareBtn.hidden = false;
    endCompareBtn.addEventListener("click", () => closeThisTab());
  }
  const conflictEl = document.getElementById("canvas-conflict");
  const fileEl = document.getElementById("canvas-file");
  const reconnectBtn = document.getElementById("canvas-reconnect");
  const rewriteBtn = document.getElementById("canvas-rewrite");
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
    // Ask agent (§3.7): while text is selected in the view.
    askBtn.hidden = !(textKind && mode === "view" && !!frame && !!ask.sel);
    // To chat input (§3.7, Brett 2026-10-13): the same rule; disabled while the panel is asked.
    sendSelBtn.hidden = askBtn.hidden;
    sendSelBtn.disabled = toInputBusy;
    downloadBtn.hidden = !textKind;
    const ext = current && current.meta.kind === "mermaid" ? "mmd" : "md";
    downloadBtn.textContent = `⬇ .${ext}`;
    downloadBtn.title = `下載成 .${ext}`;
    printBtn.hidden = !(textKind && !!frame && mode === "view");
    printBtn.disabled = (mode === "edit" && dirty) || !!printing;
    printBtn.title = printing ? "正在準備列印…" : printBtn.disabled ? "先儲存再匯出" : "列印／存成 PDF";
    editBtn.disabled = !!printing;
  }

  // --- Pushes into the prompt (§3.7) -----------------------------------------------------------
  // Composed here (host, from storage), posted by the side panel as the user. The panel checks the
  // sender is this page and the conversation is its own.
  async function pushToAgent(text, note) {
    return askPanel({ type: "katashiro-canvas-push", text, note: note || "" }, "送出失敗");
  }
  // A request to the panel of this canvas's conversation (a push, or To chat input), with the
  // conversation id and a request id added. `failed` heads a refusal that comes with a button.
  async function askPanel(msg, failed) {
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
        notice("這個視窗的 Katashiro 側邊欄沒開：打開側邊欄後再送一次。", { label: "打開側邊欄", fn: () => openSidePanel(win) });
        return { ok: false, error: "這個視窗的 Katashiro 側邊欄沒開", shown: true };
      }
      return { ok: false, error: "Katashiro 側邊面板沒有回應（或不在同一個對話）" };
    }
    if (r.ok && r.elsewhere) r.agent = `${r.agent || "agent"}（在另一個視窗）`;
    if (!r.ok && r.windowId != null) {
      // Open in another window whose panel is closed: a button to go there.
      notice(`${failed}：${CanvasCore.clipError(r.error)}`, { label: "前往那個視窗", fn: () => chrome.windows.update(r.windowId, { focused: true }).catch(() => {}) });
      r.shown = true;                           // callers keep this notice (it has the button)
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
  function openSidePanel(windowId) {
    try {
      const p = chrome.sidePanel.open({ windowId });
      if (p && typeof p.then === "function") return p.then(() => notice("側邊欄打開了：再按一次送出。"), (e) => notice(`打不開側邊欄：${CanvasCore.clipError(String((e && e.message) || e))}`));
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
    const textKind = !!current && CanvasCore.textKind(current.meta.kind);
    const sel = textKind && mode === "view" && m.text ? { text: m.text, truncated: m.truncated === true, seq: m.seq, rect: m.rect, where: m.where } : null;
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
    const text = CanvasCore.composeAskAgent({ note, title: cap.title, id: canvasId, version: cap.version, text: cap.text, truncated: cap.truncated, where });
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
    if (toInputBusy || !current || compareView || mode !== "view" || !frame || !CanvasCore.textKind(current.meta.kind)) return;
    const sel = ask.sel;
    if (!sel) return;
    if (sel.truncated) { notice(`選取的文字超過 ${CanvasCore.SELECTION_MAX / 1024} KB，沒放進輸入框：選短一點再試。`); return; }
    toInputBusy = true;                           // one request per click; the panel also dedupes by reqId
    sendSelBtn.disabled = sendPill.disabled = true;
    let r;
    try {
      r = await askPanel({ type: "katashiro-canvas-to-input", text: sel.text }, "沒放進輸入框");
    } finally {
      toInputBusy = false;
      sendSelBtn.disabled = sendPill.disabled = false;
    }
    if (!r.ok) { if (!r.shown) notice(`沒放進輸入框：${CanvasCore.clipError(r.error)}`); return; }
    // r.draft: the panel could not switch to this conversation (the current one is replying).
    flash(r.draft ? "📨 已放進那段對話的草稿（目前的對話回覆中，沒切過去）"
      : `📨 已放進輸入框${r.elsewhere ? "（在另一個視窗）" : ""}`);
    if (ask.phase === "pill" && sameAsCaptured(ask.sel, sel)) askDispatch({ type: "close" });
  }

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
  function offerSendError(msg, diagram = false, tag = null) {
    const c = current;
    const version = tag && Number.isInteger(tag.version) ? tag.version : c && c.meta.version;
    notice(`${diagram ? "圖表有錯誤" : "顯示時發生錯誤"}${tag && version ? `（v${version}）` : ""}：${CanvasCore.clipError(msg)}`, {
      label: "送給 agent 修",
      fn: async () => {
        if (!c) return;
        const text = CanvasCore.composeCanvasPush({
          header: CanvasCore.renderErrorHeader({
            title: String(c.meta.title).slice(0, TITLE_MAX), id: canvasId, version, kind: c.meta.kind, diagram,
            nowVersion: current ? current.meta.version : undefined,
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
    const url = URL.createObjectURL(new Blob([current.content], { type: mermaid ? "text/plain;charset=utf-8" : "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = CanvasCore.safeFileName(current.meta.title, mermaid ? "mmd" : "md");
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
    frameReady = false;
    renderFailed = "";                        // #96: a goto / highlight before the new frame's ready must not get the old failure
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

  function dropFrame(why) {
    printing = null;
    if (frame) frame.remove();
    frame = null;
    frameReady = false;
    rendered = false;
    nonce = "";
    askDispatch({ type: "reset" });
    notice(why);
    finishGoto({ ok: false, error: "the canvas is no longer shown" });
    finishHighlight({ ok: false, error: "the canvas is no longer shown" });
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
    if (frame && frameReady) frame.contentWindow.postMessage({ ...msg, nonce }, "*");
  }

  // §3.5: an agent markdown write not normalized yet → ask the frame to normalize the AGENT copy
  // (which is the latest unless the user has saved since), and wait for rendered{version, normalized}.
  let awaitingNormalize = 0;
  let lastRenderedVersion = 0;        // §3.10: an agent version newer than this glows what changed
  async function sendRender() {
    if (!frame || !frameReady || !current) return;
    const c = current;
    let content;
    try { content = await renderPayload(c); } catch (e) { notice(CanvasCore.clipError(e.message)); return; }
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
    const msg = { type: "render", kind: c.meta.kind, version: c.meta.version, content };
    if (typeof normalizeText === "string") { msg.normalizeText = normalizeText; msg.version = c.meta.agentVersion; }
    // Glow on every agent write (§3.10): the frame compares with what it showed before. With 顯示變更
    // on, held markers replace the fade (applied on rendered{}), unless a compare's markers show.
    if (c.meta.author === "agent" && lastRenderedVersion && c.meta.version > lastRenderedVersion && !(showChanges && !comparing)) {
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
    const msg = { type: "render", kind: c.meta.kind, version: c.meta.agentVersion, content };
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
    const m = CanvasCore.acceptFrameMessage(event, { frameWindow: frame && frame.contentWindow, nonce, readOnly: compareView });
    if (!m) return;
    switch (m.type) {
      case "ready":
        frameReady = true;
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
        if (CanvasCore.renderNoticeStale(noticeTag, m.seq)) notice("");    // an older render's error
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
      case "selectionRect":
        if (!CanvasCore.fromOlderRender(m, renderingSeq)) askDispatch({ type: "rect", seq: m.seq, rect: m.rect });
        break;
      case "error":
        // Render N failing after startRender(N+1) says nothing about N+1: it must not fail the goto /
        // highlight waiting for it, nor mark it failed (#115 review). No seq: a CSP report or a goto.
        if (CanvasCore.fromOlderRender(m, renderingSeq)) break;
        if (printing) mountFrame();      // back to the normal view; a later render must never print()
        if (!rendered) renderFailed = CanvasCore.clipError(m.msg);    // the render failed (not a later CSP report)
        if (compareView) notice(`顯示時發生錯誤：${CanvasCore.clipError(m.msg)}`, null, { seq: renderingSeq, version: renderingVersion });
        else offerSendError(m.msg, false, { seq: renderingSeq, version: renderingVersion });
        finishGoto({ ok: false, error: `the canvas failed to show: ${CanvasCore.clipError(m.msg)}` });
        finishHighlight({ ok: false, error: `the canvas failed to show: ${CanvasCore.clipError(m.msg)}` });
        break;
      case "diagramError":
        // One mermaid diagram failed (§3.3): it shows its error in place and the canvas stands, so
        // nothing is marked failed and pending goto / highlight carry on.
        if (m.seq !== renderingSeq) break;                   // an older render's
        if (compareView) notice(`圖表有錯誤：${CanvasCore.clipError(m.msg)}`, null, { seq: renderingSeq, version: renderingVersion });
        else offerSendError(m.msg, true, { seq: renderingSeq, version: renderingVersion });
        break;
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
      case "openLink": {
        const url = CanvasCore.safeLinkUrl(m.url);
        if (!url) { notice("已擋下一個非 http(s) 的連結。"); break; }
        // The full URL is shown before anything opens: canvas content is agent-authored.
        if (window.confirm(`在新分頁開啟這個連結？\n\n${url}`)) chrome.tabs.create({ url, active: true });
        break;
      }
    }
  });

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
    const timer = setTimeout(() => finishHighlight({ ok: false, error: "the canvas did not respond in time" }), HIGHLIGHT_TIMEOUT_MS);
    pendingHighlight = { reqId: ++highlightSeq, req, respond, sent: false, timer };
    if (frame && frameReady && rendered) sendHighlight();
  }
  function onHighlighted(m) {
    if (!pendingHighlight || m.reqId !== pendingHighlight.reqId) return;
    const r = { ok: m.ok, tag: m.tag, text: m.text, slide: m.slide, error: m.error };
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
  function onHighlightRequest(msg, sendResponse) {
    const hasFind = typeof msg.find === "string", hasHeading = typeof msg.heading === "string";
    if (hasFind === hasHeading) { sendResponse({ ok: false, error: "give exactly one of find / heading" }); return false; }
    if (current && current.meta.kind !== "markdown" && current.meta.kind !== "slides") { sendResponse({ ok: false, error: `this canvas is ${current.meta.kind}; only markdown and slides can be highlighted` }); return false; }
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
    current = c;
    setHeader(c.meta);
    mountFrame();
    if (compareView) return;
    deleteBtn.hidden = false;
    store.touch(canvasId).catch(() => {});      // "last opened", for eviction order (§3.6)
    // Catch up this canvas, and notice a file changed or deleted outside Katashiro (never imported).
    syncFile({ check: true });
  })();

  // The gallery (§3.7): reuse its tab if one is open, else open it in this window.
  document.getElementById("canvas-gallery").addEventListener("click", () => {
    CanvasTabs.openGalleryTab(chrome, chrome.runtime.getURL("canvas-gallery.html")).catch(() => {});
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
