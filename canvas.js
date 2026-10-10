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
  const store = CanvasStore.createCanvasStore({
    storage: chrome.storage.local,
    lock: (name, fn) => navigator.locks.request(name, fn),
  });

  let frame = null;
  let nonce = "";
  let frameReady = false;
  let current = null;                 // { meta, content } last read from storage
  const gate = CanvasCore.createLoadGate();

  function notice(text) {
    noticeEl.textContent = text;      // textContent: may carry frame-supplied text
    noticeEl.hidden = !text;
  }

  function setHeader(meta) {
    const t = String(meta.title || "Canvas").slice(0, TITLE_MAX);
    titleEl.textContent = t;
    versionEl.textContent = `v${meta.version}`;
    document.title = `${t} — Canvas`;
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

  async function sendRender() {
    if (!frame || !frameReady || !current) return;
    const c = current;
    let content;
    try { content = await renderPayload(c); } catch (e) { notice(CanvasCore.clipError(e.message)); return; }
    if (!frame || !frameReady || current !== c) return;         // superseded while reading the image
    // '*' is the only target for an opaque-origin frame; the load gate is what makes it safe.
    frame.contentWindow.postMessage({ type: "render", nonce, kind: c.meta.kind, version: c.meta.version, content }, "*");
  }

  window.addEventListener("message", (event) => {
    const m = CanvasCore.acceptFrameMessage(event, { frameWindow: frame && frame.contentWindow, nonce });
    if (!m) return;
    switch (m.type) {
      case "ready":
        frameReady = true;
        sendRender();
        break;
      case "rendered":
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
    const c = await load();
    if (!c) {
      // Deleted (here, in another tab, or evicted): stop showing stale content.
      if (frame) dropFrame("這個畫布已被刪除。");
      deleteBtn.hidden = true;
      return;
    }
    current = c;
    setHeader(c.meta);
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
