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
// Send to agent, Revert or delete, and its frame's save/dirty/selection are refused.
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
  const downloadBtn = document.getElementById("canvas-download");
  const printBtn = document.getElementById("canvas-print");
  const mainEl = document.getElementById("canvas-main");
  const deleteBtn = document.getElementById("canvas-delete");
  const editBtn = document.getElementById("canvas-edit");
  const saveBtn = document.getElementById("canvas-save");
  const cancelBtn = document.getElementById("canvas-cancel");
  const revertBtn = document.getElementById("canvas-revert");
  const compareBtn = document.getElementById("canvas-compare");
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
  const mirror = CanvasMirror.createCanvasMirror({
    storage: chrome.storage.local,
    lock: (name, fn) => navigator.locks.request(name, fn),
    getRoot: () => CanvasMirror.grantedRoot(),
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
  const gate = CanvasCore.createLoadGate();

  // A notice line, optionally with one action button (e.g. Send error to agent).
  let noticeActionFn = null;
  function notice(text, action) {
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
      for (const b of [editBtn, saveBtn, cancelBtn, revertBtn, sendBtn, compareBtn, downloadBtn, printBtn, deleteBtn]) b.hidden = true;
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
    const textKind = !!current && (current.meta.kind === "markdown" || current.meta.kind === "slides");
    // Compare with agent's (§3.10): when the latest differs from the agent's last write.
    compareBtn.hidden = !(canRevert && textKind && !!frame);
    // Send to agent: only when there are saved edits the agent has not been shown (§3.5/§3.7).
    const seen = current ? (current.meta.agentSeenVersion || current.meta.agentVersion || 0) : 0;
    sendBtn.hidden = !(textKind && mode === "view" && current.meta.version > seen && !sameAsAgent);
    sendBtn.title = current ? `把你的修改送給 agent（agent 最後看過 v${seen}）` : "";
    downloadBtn.hidden = !textKind;
    printBtn.hidden = !(textKind && !!frame && mode === "view");
    printBtn.disabled = (mode === "edit" && dirty) || !!printing;
    printBtn.title = printing ? "正在準備列印…" : printBtn.disabled ? "先儲存再匯出" : "列印／存成 PDF";
    editBtn.disabled = !!printing;
  }

  // --- Pushes into the prompt (§3.7) -----------------------------------------------------------
  // Composed here (host, from storage), posted by the side panel as the user. The panel checks the
  // sender is this page and the conversation is its own.
  async function pushToAgent(text, note) {
    let r;
    try {
      r = await chrome.runtime.sendMessage({
        type: "katashiro-canvas-push", conversationId: current.meta.conversationId, text, note: note || "", reqId: crypto.randomUUID(),
      });
    } catch (_) { r = undefined; }
    if (!r) return { ok: false, error: "Katashiro 側邊面板沒有開（或不在同一個對話）" };
    return r;
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
      if (!r.ok) { notice(`送出失敗：${CanvasCore.clipError(r.error)}`); return; }
      await store.markSeen({ id: canvasId, version: c.meta.version });
      flash(`📤 已送給 ${r.agent || "agent"}（v${c.meta.version}）`);
    } finally {
      sendBtn.disabled = false;
    }
  });

  // Send error to agent (§3.7 "Try fixing"): only canvas-frame errors exist in phase 1.
  function offerSendError(msg) {
    const c = current;
    notice(`顯示時發生錯誤：${CanvasCore.clipError(msg)}`, {
      label: "送給 agent 修",
      fn: async () => {
        if (!c) return;
        const text = CanvasCore.composeCanvasPush({
          header: `[canvas "${String(c.meta.title).slice(0, TITLE_MAX)}" (${canvasId}) v${c.meta.version} (${c.meta.kind}) failed to render]`,
          data: CanvasCore.clipError(msg),
        });
        const r = await pushToAgent(text);
        notice(r.ok ? `📤 已把錯誤送給 ${r.agent || "agent"}` : `送出失敗：${CanvasCore.clipError(r.error)}`);
      },
    });
  }

  // --- Export (§3.8) --------------------------------------------------------------------------
  downloadBtn.addEventListener("click", () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([current.content], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = CanvasCore.safeFileName(current.meta.title, "md");
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
    const ak = CanvasStore.agentKey(canvasId);
    const got = await chrome.storage.local.get([mk, lk, ak]);
    if (!got[mk]) {
      notice("找不到這個畫布（可能已被刪除）。");
      return null;
    }
    const latest = got[lk] == null ? "" : got[lk];
    // A compare tab shows the agent's last write (the agent copy exists only while it differs).
    if (compareView) return { meta: got[mk], content: got[ak] != null ? got[ak] : latest, latest };
    return { meta: got[mk], content: latest };
  }

  function mountFrame(query) {
    if (!query) printing = null;              // any normal mount ends a print (§3.8)
    if (frame) frame.remove();
    frameReady = false;
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
    // Glow on every agent write (§3.10): the frame compares with what it showed before.
    if (c.meta.author === "agent" && lastRenderedVersion && c.meta.version > lastRenderedVersion) msg.glowPrev = true;
    lastRenderedVersion = c.meta.version;
    startRender(msg);
  }

  // While this canvas's compare tab is open, the differing blocks stay marked here too (Brett,
  // 2026-10-11): re-marked after every render (rendered{}), cleared when the last compare tab closes.
  let comparing = false;
  async function holdCompareGlow() {
    const agentText = await store.readAgentCopy(canvasId);
    if (!comparing || mode !== "view") return;
    if (typeof agentText === "string" && current && agentText !== current.content) toFrame({ type: "glow", against: agentText, hold: true });
    else toFrame({ type: "glow", clear: true });
  }
  async function compareStillOpen() {
    try { return (await chrome.tabs.query({})).some((t) => CanvasTabs.isCompareTabFor(t, CANVAS_BASE, canvasId)); } catch (_) { return false; }
  }
  if (!compareView) {
    chrome.tabs.onRemoved.addListener(async () => {
      if (!comparing || (await compareStillOpen())) return;
      comparing = false;
      toFrame({ type: "glow", clear: true });
    });
  }

  // goto / highlight wait for the frame to report THIS render (an older one's rendered{} would let
  // them reach a deck still being replaced), and fail at once with the reason while it is failed.
  let renderingVersion = 0;
  let renderFailed = "";
  function startRender(msg) {
    rendered = false;
    renderFailed = "";
    renderingVersion = msg.version;
    toFrame(msg);
  }

  // Compare tab (§3.10): the agent copy, re-sent (no reload) whenever the canvas changes. Its blocks
  // that differ from the latest glow; once they are equal (e.g. the agent wrote), it says so and
  // glows what the agent's write changed.
  function sendCompareRender(c, content) {
    const msg = { type: "render", kind: c.meta.kind, version: c.meta.agentVersion, content };
    const same = c.content === c.latest;
    if (!same && typeof c.latest === "string") { msg.glowAgainst = c.latest; msg.glowHold = true; }
    else if (lastRenderedVersion && c.meta.agentVersion > lastRenderedVersion) msg.glowPrev = true;
    lastRenderedVersion = c.meta.agentVersion;
    notice(same ? "沒有差異：agent 最後寫的版本就是目前的版本（No differences）。" : "");
    startRender(msg);
  }

  // Saves are serialized (refresh() waits on them). The frame gets back the content that was
  // stored, so its baseline is what is saved, not what it holds when the reply arrives.
  function saveFromEditor(content, baseVersion) {
    const run = saving.then(() => doSave(content, baseVersion));
    saving = run.catch(() => {});
    return run;
  }

  // Returns true when the content is stored (saved, or already equal to the latest).
  async function doSave(content, baseVersion) {
    if (deleted) { notice("這個畫布已被刪除，無法儲存。請先把內容複製出來。"); return false; }
    try {
      const r = await store.userSave({ id: canvasId, baseVersion, content });
      if (r.unchanged) { flash("沒有變更，不需要儲存。"); toFrame({ type: "saved", version: r.version, content }); return true; }
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
    notice("");
    toFrame({ type: "edit", content: current.content, version: current.meta.version });
    updateButtons();
  }

  async function leaveEdit() {
    mode = "view";
    dirty = false;
    toFrame({ type: "leaveEdit" });
    await refresh();
  }

  editBtn.addEventListener("click", enterEdit);
  saveBtn.addEventListener("click", () => toFrame({ type: "requestSave" }));
  cancelBtn.addEventListener("click", () => {
    if (dirty && !window.confirm("放棄尚未儲存的修改？")) return;
    leaveEdit();
  });
  revertBtn.addEventListener("click", async () => {
    if (!current) return;
    // §3.5: "cannot be undone" unless the folder mirror holds the current text (then git can).
    const undo = mirrorHoldsLatest()
      ? "Katashiro 裡無法復原；目前的內容已寫進資料夾，若你有把資料夾 commit 進 git，可以從 git 找回（資料夾裡的檔案接著會被這次還原改寫）。"
      : "這個動作無法復原。";
    if (!window.confirm(`還原成 agent 最後寫的版本？\n\n你目前的內容會被取代。${undo}`)) return;
    try { await store.revertToAgent({ id: canvasId, baseVersion: current.meta.version }); }
    catch (e) { notice(`還原失敗：${CanvasCore.clipError((e && e.message) || e)}`); return; }
    closeCompareTabs();                     // Revert to agent's also ends a compare (§3.10)
  });

  // --- Compare with agent's (§3.10) -------------------------------------------------------------
  // The side panel does the tab moves (it holds the §3.1 split records and the canvas group); it
  // checks that the request comes from this canvas tab. Without a panel, the compare view opens
  // here as a normal tab beside this one.
  compareBtn.addEventListener("click", async () => {
    if (!current || compareView || compareBtn.disabled) return;
    compareBtn.disabled = true;
    try {
      let r;
      try { r = await chrome.runtime.sendMessage({ type: "katashiro-canvas-compare", id: canvasId, conversationId: current.meta.conversationId }); }
      catch (_) { r = undefined; }
      if (!r) r = await openCompareHere();
      if (!r.ok) { notice(`無法開啟比較：${CanvasCore.clipError(r.error)}`); return; }
      if (r.note) flash(r.note);
      // Both panes mark the differing blocks, held while the compare is open.
      comparing = true;
      holdCompareGlow();
    } finally {
      compareBtn.disabled = false;
    }
  });

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
        if (m.version !== renderingVersion) break;           // an older render; a newer one is on its way
        rendered = true;
        renderFailed = "";
        if (pendingGoto && !pendingGoto.sent) { pendingGoto.sent = true; toFrame({ type: "goto", slide: pendingGoto.slide }); }
        if (pendingHighlight && !pendingHighlight.sent) sendHighlight();
        if (comparing && !compareView) holdCompareGlow();     // re-mark on the new DOM
        if (typeof m.normalized === "string" && m.version === awaitingNormalize) {
          awaitingNormalize = 0;
          store.applyNormalized({ id: canvasId, version: m.version, normalized: m.normalized }).catch(() => {});
        }
        break;
      case "save":
        if (mode === "edit") saveFromEditor(m.content, m.baseVersion);
        break;
      case "dirty":
        dirty = m.dirty;
        updateButtons();
        break;
      case "highlighted":
        onHighlighted(m);
        break;
      case "error":
        if (printing) mountFrame();      // back to the normal view; a later render must never print()
        if (!rendered) renderFailed = CanvasCore.clipError(m.msg);    // the render failed (not a later CSP report)
        if (compareView) notice(`顯示時發生錯誤：${CanvasCore.clipError(m.msg)}`);
        else offerSendError(m.msg);
        finishGoto({ ok: false, error: `the canvas failed to show: ${CanvasCore.clipError(m.msg)}` });
        finishHighlight({ ok: false, error: `the canvas failed to show: ${CanvasCore.clipError(m.msg)}` });
        break;
      case "editFailed":
        mode = CanvasCore.modeAfterFrameMessage(m.type, { mode, dirty });
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
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only the side panel: not a content script (sender.tab), not another extension page.
    if (!sender || sender.id !== chrome.runtime.id || sender.tab || sender.url !== PANEL_URL) return false;
    if (compareView) return false;              // goto / highlight are for the canvas, never its compare tab
    if (msg && msg.type === "katashiro-canvas-highlight" && msg.id === canvasId) return onHighlightRequest(msg, sendResponse);
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
      (m.file.state === "ok" || m.file.state === "recreated") && m.fileSyncedVersion === m.version);
  }
  function syncFile(opts) {
    if (deleted || compareView) return Promise.resolve();    // a compare tab is read-only (§3.10): the canvas tab writes
    return mirror.sync(canvasId, opts).catch(() => {}).then(updateFileStatus);
  }
  // 1B (Brett 2026-10-11): a file deleted outside stops this canvas's mirroring; this writes it again.
  rewriteBtn.addEventListener("click", async () => {
    rewriteBtn.disabled = true;
    try {
      const r = await mirror.sync(canvasId, { rewrite: true });
      if (r.action === "write") flash("📁 已重新寫進資料夾，恢復同步");
      else if (r.action === "disconnected") notice("資料夾需要重新授權，請先按 Reconnect folder。");
      else if (r.action === "error") notice(`寫入資料夾失敗：${CanvasCore.clipError(r.error)}`);
    } finally {
      rewriteBtn.disabled = false;
      updateFileStatus();
    }
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

  // #70: delete. No history to fall back on, so it says it cannot be undone.
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
