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
//  - 對話 (ADR multi-conversation §3.4): the conversations not open in a live window (archived, or
//    left in a closed window's record), newest first, title search with the same box. 重新打開 opens
//    the side panel of this tab's window in the click (chrome.sidePanel.open needs the gesture),
//    leaves the request in storage.session for a panel that is still loading, and asks the panel.
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

  const convListEl = document.getElementById("conv-list");
  const convSection = document.getElementById("conv-section");
  const convEmptyEl = document.getElementById("conv-empty");
  const ALL_WINDOW_TYPES = ["normal", "popup", "panel", "app", "devtools"];
  const REOPEN_TIMEOUT_MS = 8000;

  const store = CanvasStore.createCanvasStore({
    storage: chrome.storage.local,
    lock: (name, fn) => navigator.locks.request(name, fn),
  });

  let rows = [];                                   // every canvas, newest first
  let convIndex = {};                              // conv:index
  let openLive = new Set();                        // conversation ids open in a live window
  let myWindowId = null;                           // this tab's window (cached: the click must not await)
  const contents = new Map();                      // id → { rev, text } (normalized), for content search
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
    await readConversations();
    const titles = {};
    for (const [id, e] of Object.entries(convIndex)) if (e && e.title) titles[id] = e.title;
    rows = G.buildRows(metas, { now: Date.now(), footprint: CanvasStore.footprint, titles });
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
          if (typeof v === "string" && asked.has(r.id)) contents.set(r.id, { rev: r.rev, text: G.normalize(v) });
        }
      }
      if (seq !== searchSeq) return;                // a newer keystroke or reload took over
    }
    render(G.filterRows(rows, q, contents), q);
    renderConversations(q);
  }

  // --- 對話 (multi-conversation §3.4) ----------------------------------------------------------------
  async function readConversations() {
    try {
      const got = await CanvasStore.getMatching(chrome.storage.local, (k) => k === ConvCore.INDEX_KEY || k.startsWith(ConvCore.WINDOW_PREFIX));
      const windows = {};
      for (const [k, v] of Object.entries(got)) if (k.startsWith(ConvCore.WINDOW_PREFIX)) windows[k.slice(ConvCore.WINDOW_PREFIX.length)] = v;
      let live = new Set();
      try { live = new Set((await chrome.windows.getAll({ windowTypes: ALL_WINDOW_TYPES })).map((w) => String(w.id))); } catch (_) { /* none known */ }
      convIndex = got[ConvCore.INDEX_KEY] || {};
      openLive = ConvCore.liveOpenIds(windows, live);
    } catch (_) {
      convIndex = {};
      openLive = new Set();
    }
  }

  function renderConversations(q) {
    const counts = {};
    for (const r of rows) counts[r.conversationId] = (counts[r.conversationId] || 0) + 1;
    const all = ConvCore.galleryRows({ index: convIndex, openLive, canvasCounts: counts, query: "", now: Date.now() });
    const shown = G.queryTerms(q).length ? ConvCore.galleryRows({ index: convIndex, openLive, canvasCounts: counts, query: q, now: Date.now() }) : all;
    convSection.hidden = all.length === 0;
    convListEl.replaceChildren(...shown.map((r) => {
      const li = document.createElement("li");
      li.className = "conv-row";
      li.dataset.id = r.id;
      const title = document.createElement("span");
      title.className = "conv-title";
      title.textContent = r.title;
      title.title = `${r.title}\n對話 ${r.id}`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "canvas-btn conv-reopen";
      btn.textContent = "重新打開";
      btn.title = "在這個視窗的側邊欄打開這段對話";
      btn.addEventListener("click", () => reopenConversation(r, btn));
      li.append(
        title,
        cell(r.time, r.at ? G.absoluteTime(r.at) : ""),
        cell(`${r.canvases} 個畫布`),
        cell(r.archived ? "已封存" : "在關掉的視窗", r.archived ? "從分頁列的 × 封存" : "留在關掉的視窗裡（沒有封存）"),
        btn,
      );
      return li;
    }));
    convEmptyEl.hidden = !(all.length && !shown.length);
    convEmptyEl.textContent = `沒有符合「${q.trim()}」的對話。`;
  }

  function refreshWindowId() {
    try { chrome.tabs.getCurrent().then((t) => { if (t) myWindowId = t.windowId; }, () => {}); } catch (_) { /* not in a tab */ }
  }

  // 重新打開: no await before chrome.sidePanel.open — it needs this click's user gesture.
  function reopenConversation(r, btn) {
    const wid = myWindowId;
    if (wid == null) { notice("找不到這個分頁所在的視窗，請重新整理總覽再試。", 6000); return; }
    try { chrome.sidePanel.open({ windowId: wid }).catch(() => {}); } catch (_) { /* old Chrome: the panel may already be open */ }
    btn.disabled = true;
    (async () => {
      const reqId = crypto.randomUUID();
      try { await chrome.storage.session.set({ [`${ConvCore.REOPEN_KEY_PREFIX}${wid}`]: { id: r.id, reqId, at: Date.now() } }); } catch (_) { /* the message below still works */ }
      let answer, timer;
      try {
        const timeout = new Promise((res) => { timer = setTimeout(() => res(undefined), REOPEN_TIMEOUT_MS); });
        answer = await Promise.race([chrome.runtime.sendMessage({ type: "katashiro-conv-open", id: r.id, windowId: wid, reqId }), timeout]);
      } catch (_) { answer = undefined; }
      finally { clearTimeout(timer); }
      if (answer && answer.ok) notice(`已在側邊欄打開「${r.title}」。`, 4000);
      else if (answer && answer.error) notice(`沒有打開：${CanvasCore.clipError(answer.error)}`, 8000);
      else notice("已打開側邊欄：對話會在側邊欄載入後打開。", 6000);
      btn.disabled = false;
    })();
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
    if (!window.confirm(`刪除畫布「${r.title.replace(/\s+/g, " ").trim().slice(0, 60)}」？\n\n這個動作無法復原。${kept}`)) return;
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
    if (area !== "local" || !Object.keys(changes).some((k) => META_KEY_RE.test(k) || k === ConvCore.INDEX_KEY || k.startsWith(ConvCore.WINDOW_PREFIX))) return;
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

  // canvas_gallery({query}) (§3.11): the agent's search arrives as #q=…, on load or as a fragment
  // change of this open tab. Sanitised (queryFromHash), set as the box's value, then the fragment is
  // cleared so the same query asked again is a new navigation (and hashchange) once more.
  function takeHashQuery() {
    const q = G.queryFromHash(location.hash);
    if (location.hash) history.replaceState(null, "", location.pathname + location.search);
    if (q == null) return false;
    searchEl.value = q;
    return true;
  }
  window.addEventListener("hashchange", () => { if (takeHashQuery()) { clearTimeout(searchTimer); search(); } });

  // A window closing makes its conversations reopenable here; the tab may also move to another window.
  if (chrome.windows && chrome.windows.onRemoved) chrome.windows.onRemoved.addListener(() => { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 150); });
  window.addEventListener("focus", refreshWindowId);

  refreshWindowId();
  takeHashQuery();
  reload();
})();
