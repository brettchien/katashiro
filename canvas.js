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
(function () {
  "use strict";

  const TITLE_MAX = 120;
  const params = new URLSearchParams(location.search);
  const canvasId = params.get("id") || "";

  const titleEl = document.getElementById("canvas-title");
  const versionEl = document.getElementById("canvas-version");
  const noticeEl = document.getElementById("canvas-notice");
  const mainEl = document.getElementById("canvas-main");
  const deleteBtn = document.getElementById("canvas-delete");
  const editBtn = document.getElementById("canvas-edit");
  const saveBtn = document.getElementById("canvas-save");
  const cancelBtn = document.getElementById("canvas-cancel");
  const revertBtn = document.getElementById("canvas-revert");
  const conflictEl = document.getElementById("canvas-conflict");
  const store = CanvasStore.createCanvasStore({
    storage: chrome.storage.local,
    lock: (name, fn) => navigator.locks.request(name, fn),
  });

  let frame = null;
  let nonce = "";
  let frameReady = false;
  let current = null;                 // { meta, content } last read from storage
  // Editing (§3.5): "view" | "edit". While editing, a new version from elsewhere never replaces the
  // editor: a clean editor gives way, a dirty one keeps going and the save meets the conflict view.
  let mode = "view";
  let dirty = false;
  let ownSaveVersion = 0;             // the version our own save produced (not "news" to show)
  let pendingSave = null;             // content of a save that came back stale (for the conflict view)
  let conflictBase = 0;               // the version the conflict view showed: "keep mine" saves over it only
  let saving = Promise.resolve();     // saves run one at a time; refresh() waits for the one in flight
  const gate = CanvasCore.createLoadGate();

  function notice(text) {
    noticeEl.textContent = text;      // textContent: may carry frame-supplied text
    noticeEl.hidden = !text;
  }

  function setHeader(meta) {
    const t = String(meta.title || "Canvas").slice(0, TITLE_MAX);
    titleEl.textContent = t;
    versionEl.textContent = `v${meta.version}${meta.author === "user" ? "（你的修改）" : ""}`;
    document.title = `${t} — Canvas`;
    updateButtons();
  }

  // Header buttons follow the mode; only markdown is editable in phase 1 (slides: phase 2).
  async function updateButtons() {
    const editable = !!current && current.meta.kind === "markdown" && !!frame;
    editBtn.hidden = !(editable && mode === "view");
    saveBtn.hidden = mode !== "edit";
    saveBtn.disabled = !dirty;
    cancelBtn.hidden = mode !== "edit";
    let canRevert = false;
    if (current && mode === "view" && current.meta.author === "user") {
      try { const agent = await store.readAgentCopy(canvasId); canRevert = agent != null && agent !== current.content; } catch (_) { /* stays hidden */ }
    }
    revertBtn.hidden = !canRevert;
  }

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
    return { meta: got[mk], content: got[lk] == null ? "" : got[lk] };
  }

  function mountFrame() {
    if (frame) frame.remove();
    frameReady = false;
    nonce = CanvasCore.newNonce();
    frame = document.createElement("iframe");
    // allow-scripts only: no same-origin, popups, forms, modals or top navigation (§3.2).
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = "canvas content";
    frame.addEventListener("load", () => {
      if (!gate.onLoad()) dropFrame("畫布內容嘗試離開這個頁面，已停止顯示。重新整理這個分頁即可重新載入。");
    });
    gate.expect();
    frame.src = `canvas-frame.html#${nonce}`;
    mainEl.appendChild(frame);
  }

  function dropFrame(why) {
    if (frame) frame.remove();
    frame = null;
    frameReady = false;
    nonce = "";
    notice(why);
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
  async function sendRender() {
    if (!frame || !frameReady || !current) return;
    const c = current;
    let content;
    try { content = await renderPayload(c); } catch (e) { notice(CanvasCore.clipError(e.message)); return; }
    let normalizeText;
    if (c.meta.kind === "markdown" && c.meta.normalized === false) {
      normalizeText = await store.readAgentCopy(canvasId);
      awaitingNormalize = c.meta.agentVersion;
    }
    if (!frame || !frameReady || current !== c) return;         // superseded while reading
    const msg = { type: "render", kind: c.meta.kind, version: c.meta.version, content };
    if (typeof normalizeText === "string") { msg.normalizeText = normalizeText; msg.version = c.meta.agentVersion; }
    toFrame(msg);
  }

  // Saves are serialized (refresh() waits on them). The frame gets back the content that was
  // stored, so its baseline is what is saved, not what it holds when the reply arrives.
  function saveFromEditor(content, baseVersion) {
    const run = saving.then(() => doSave(content, baseVersion));
    saving = run.catch(() => {});
    return run;
  }

  async function doSave(content, baseVersion) {
    try {
      const r = await store.userSave({ id: canvasId, baseVersion, content });
      if (r.unchanged) { notice("沒有變更，不需要儲存。"); toFrame({ type: "saved", version: r.version, content }); return; }
      ownSaveVersion = r.version;
      notice("");
      toFrame({ type: "saved", version: r.version, content });
    } catch (e) {
      if (e && e.code === "stale") return openConflict(content);
      notice(`儲存失敗：${CanvasCore.clipError((e && e.message) || e)}`);
    }
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
  }

  document.getElementById("conflict-keep").addEventListener("click", async () => {
    conflictEl.hidden = true;
    // Over the version shown, not current: one written while the view was up makes this stale
    // again and reopens the conflict view on it, instead of being overwritten unseen.
    if (pendingSave != null && conflictBase) await saveFromEditor(pendingSave, conflictBase);
  });
  document.getElementById("conflict-discard").addEventListener("click", () => {
    if (!window.confirm("放棄你尚未儲存的修改？\n\n這個動作無法復原。")) return;
    conflictEl.hidden = true;
    pendingSave = null;
    leaveEdit();
  });
  document.getElementById("conflict-back").addEventListener("click", () => { conflictEl.hidden = true; });

  function enterEdit() {
    if (!current || current.meta.kind !== "markdown") return;
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
    if (!window.confirm("還原成 agent 最後寫的版本？\n\n你目前的內容會被取代，這個動作無法復原。")) return;
    try { await store.revertToAgent({ id: canvasId, baseVersion: current.meta.version }); }
    catch (e) { notice(`還原失敗：${CanvasCore.clipError((e && e.message) || e)}`); }
  });
  document.addEventListener("keydown", (e) => {
    if (mode === "edit" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); toFrame({ type: "requestSave" }); }
  });
  window.addEventListener("beforeunload", (e) => { if (mode === "edit" && dirty) { e.preventDefault(); e.returnValue = ""; } });

  window.addEventListener("message", (event) => {
    const m = CanvasCore.acceptFrameMessage(event, { frameWindow: frame && frame.contentWindow, nonce });
    if (!m) return;
    switch (m.type) {
      case "ready":
        frameReady = true;
        sendRender();
        updateButtons();
        break;
      case "rendered":
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
      case "error":
        notice(`顯示時發生錯誤：${CanvasCore.clipError(m.msg)}`);
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
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!changes[CanvasStore.metaKey(canvasId)] && !changes[CanvasStore.latestKey(canvasId)]) return;
    refresh();
  });

  async function refresh() {
    await saving;                     // our own save's onChanged can beat its reply: know ownSaveVersion first
    const c = await load();
    if (!c) {
      // Deleted (here, in another tab, or evicted): stop showing stale content.
      if (frame) dropFrame("這個畫布已被刪除。");
      deleteBtn.hidden = true;
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
    sendRender();
  }

  (async () => {
    const c = await load();
    if (!c) return;
    current = c;
    setHeader(c.meta);
    mountFrame();
    deleteBtn.hidden = false;
    store.touch(canvasId).catch(() => {});      // "last opened", for eviction order (§3.6)
  })();

  // #70: delete. No history to fall back on, so it says it cannot be undone.
  deleteBtn.addEventListener("click", async () => {
    const title = current ? current.meta.title : "";
    if (!window.confirm(`刪除畫布「${String(title).slice(0, 60)}」？\n\n這個動作無法復原。`)) return;
    try {
      await store.remove({ id: canvasId });
    } catch (e) {
      notice(`刪除失敗：${CanvasCore.clipError((e && e.message) || e)}`);
    }
  });
})();
