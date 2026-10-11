// canvas-gallery.js — the canvas gallery tab (canvas-gallery.html, 總覽頁, ADR §3.7): every canvas
// across conversations, most recently updated first, searchable, so a canvas is findable after its
// conversation scrolls away. Rows and search are canvas-gallery-core.js; this file reads storage,
// builds DOM (textContent only: titles and content are agent text) and makes the chrome.* calls.
//  - Open: the panel of the canvas's conversation opens it (its openCanvasTab: the most recently
//    used tab of that canvas, or a new one in its canvas group, §3.1). With no such panel, the
//    gallery focuses an open tab itself (same CanvasTabs.pickCanvasTab) or opens one ungrouped.
//  - Delete: the same store.remove as the canvas tab's 🗑, so open tabs close themselves (unless
//    they hold unsaved edits) and the folder mirror keeps its file, as there.
//  - Live: chrome.storage.onChanged on any canvas meta re-reads the metas (never the contents).
(function () {
  "use strict";

  const G = CanvasGalleryCore;
  const CANVAS_BASE = chrome.runtime.getURL("canvas.html");
  const OPEN_TIMEOUT_MS = 5000;
  const META_KEY_RE = /^canvas:cv_[0-9a-f]{12}:meta$/;

  const listEl = document.getElementById("gallery-list");
  const emptyEl = document.getElementById("gallery-empty");
  const countEl = document.getElementById("gallery-count");
  const searchEl = document.getElementById("gallery-search");
  const noticeEl = document.getElementById("canvas-notice");
  const noticeBar = document.getElementById("canvas-notice-bar");

  const store = CanvasStore.createCanvasStore({
    storage: chrome.storage.local,
    lock: (name, fn) => navigator.locks.request(name, fn),
  });

  let rows = [];                                   // every canvas, newest first
  const contents = new Map();                      // id → { version, text } (normalized), for content search
  let contentSkipped = 0;                          // text canvases left out of the last content pass

  let noticeTimer = 0;
  function notice(text, ms) {
    noticeEl.textContent = text;
    noticeBar.hidden = !text;
    clearTimeout(noticeTimer);
    if (text && ms) noticeTimer = setTimeout(() => { if (noticeEl.textContent === text) notice(""); }, ms);
  }

  async function reload() {
    let metas;
    try { metas = await store.allMetas(); }
    catch (e) { notice(`讀取畫布失敗：${CanvasCore.clipError((e && e.message) || e)}`); return; }
    rows = G.buildRows(metas, { now: Date.now() });
    const live = new Set(rows.map((r) => r.id));
    for (const id of contents.keys()) if (!live.has(id)) contents.delete(id);
    await search();
  }

  // Content search: only with a query, only text canvases not read at their current version, capped
  // per pass (planContentReads); one storage.get for the batch.
  let searchSeq = 0;
  async function search() {
    const seq = ++searchSeq;
    const q = searchEl.value;
    if (G.queryTerms(q).length) {
      const plan = G.planContentReads(rows, contents);
      contentSkipped = plan.skipped;
      if (plan.ids.length) {
        let got = {};
        try { got = (await chrome.storage.local.get(plan.ids.map(CanvasStore.latestKey))) || {}; } catch (_) { /* title search still works */ }
        const asked = new Set(plan.ids);
        for (const r of rows) {
          const v = got[CanvasStore.latestKey(r.id)];
          if (typeof v === "string" && asked.has(r.id)) contents.set(r.id, { version: r.version, text: G.normalize(v) });
        }
      }
      if (seq !== searchSeq) return;                // a newer keystroke or reload took over
    }
    render(G.filterRows(rows, q, contents), q);
  }

  function cell(text, title) {
    const s = document.createElement("span");
    s.className = "gallery-cell";
    s.textContent = text;
    if (title) s.title = title;
    return s;
  }

  function render(shown, q) {
    // A re-render (live update, the minute tick) keeps keyboard focus on the same row.
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest(".gallery-row");
    const focusId = focused ? focused.dataset.id : null;
    const focusDelete = !!(focused && document.activeElement.classList.contains("gallery-delete"));
    const items = shown.map((r) => {
      const li = document.createElement("li");
      li.className = "gallery-row";
      li.dataset.id = r.id;
      const open = document.createElement("button");
      open.type = "button";
      open.className = "gallery-open";
      open.title = `開啟「${r.title}」`;
      const icon = document.createElement("span");
      icon.className = "gallery-icon";
      icon.textContent = r.icon;
      icon.title = r.kindLabel;
      const name = document.createElement("span");
      name.className = "gallery-name";
      const title = document.createElement("span");
      title.className = "gallery-title";
      title.textContent = r.title;
      name.append(title);
      if (r.snippet) {
        const sn = document.createElement("span");
        sn.className = "gallery-snippet";
        sn.textContent = r.snippet;
        name.append(sn);
      }
      open.append(
        icon, name,
        cell(`v${r.version}`),
        cell(r.author),
        cell(r.timeRel, r.timeAbs),
        cell(r.size, `${r.bytes} bytes${r.hasFile ? " · 也寫在資料夾裡" : ""}`),
        cell(r.conversation, `對話 ${r.conversationId}`),
      );
      open.addEventListener("click", () => openCanvas(r));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "canvas-btn gallery-delete";
      del.textContent = "🗑";
      del.title = "刪除這個畫布";
      del.addEventListener("click", () => deleteCanvas(r, del));
      li.append(open, del);
      return li;
    });
    listEl.replaceChildren(...items);
    if (focusId) {
      const li = items.find((x) => x.dataset.id === focusId);
      if (li) li.querySelector(focusDelete ? ".gallery-delete" : ".gallery-open").focus();
    }
    emptyEl.hidden = shown.length > 0;
    emptyEl.textContent = rows.length ? `沒有符合「${q.trim()}」的畫布。` : "還沒有畫布。agent 用 canvas_open 建立的畫布會出現在這裡。";
    const note = G.queryTerms(q).length && contentSkipped ? `（另有 ${contentSkipped} 個畫布超過這次搜尋的讀取上限，只比對了標題）` : "";
    countEl.textContent = `${G.queryTerms(q).length ? `${shown.length} / ` : ""}${rows.length} 個畫布 · ${G.formatSize(rows.reduce((n, r) => n + r.bytes, 0))}${note}`;
  }

  // --- Open (§3.1 rules, shared with the card) ---------------------------------------------------
  async function openCanvas(r) {
    let answer, timer;
    try {
      const timeout = new Promise((res) => { timer = setTimeout(() => res("timeout"), OPEN_TIMEOUT_MS); });
      answer = await Promise.race([
        chrome.runtime.sendMessage({ type: "katashiro-canvas-open", id: r.id, conversationId: r.conversationId }),
        timeout,
      ]);
    } catch (_) { answer = undefined; }                // no panel listening at all
    finally { clearTimeout(timer); }
    if (answer === "timeout") { notice("側邊面板沒有回應，請再試一次。", 4000); return; }
    if (answer && answer.ok) return;
    if (answer && answer.error) { notice(`無法開啟：${CanvasCore.clipError(answer.error)}`, 6000); return; }
    // No panel of that conversation is open: focus its tab here, or open one beside the gallery.
    try {
      const tab = CanvasTabs.pickCanvasTab(await chrome.tabs.query({}), CANVAS_BASE, r.id);
      if (tab) {
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
      const me = await chrome.tabs.getCurrent();
      const opts = { url: CanvasTabs.canvasTabUrl(CANVAS_BASE, r.id), active: true };
      if (me) { opts.windowId = me.windowId; opts.index = me.index + 1; }
      await chrome.tabs.create(opts);
      notice("這個對話的側邊面板沒有開：畫布開在一般分頁，不在畫布群組裡。", 6000);
    } catch (e) {
      notice(`無法開啟：${CanvasCore.clipError((e && e.message) || e)}`, 6000);
    }
  }

  // --- Delete (#70, as the canvas tab's 🗑) --------------------------------------------------------
  async function deleteCanvas(r, btn) {
    const kept = r.hasFile ? "\n資料夾裡的檔案不會被刪除。" : "";
    if (!window.confirm(`刪除畫布「${r.title.slice(0, 60)}」？\n\n這個動作無法復原。${kept}`)) return;
    btn.disabled = true;
    try {
      await store.remove({ id: r.id });                 // onChanged re-renders the list
    } catch (e) {
      btn.disabled = false;
      notice(`刪除失敗：${CanvasCore.clipError((e && e.message) || e)}`);
    }
  }

  // --- Live updates ---------------------------------------------------------------------------------
  // Metas change on every write, delete and mirror bookkeeping; one re-read per burst.
  let reloadTimer = 0;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(changes).some((k) => META_KEY_RE.test(k))) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(reload, 150);
  });
  let searchTimer = 0;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(search, 200);
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchEl.value) { searchEl.value = ""; search(); }
  });
  // "3 分鐘前" stays true: refresh the relative times every minute (metas only, cheap).
  setInterval(reload, 60 * 1000);

  reload();
})();
