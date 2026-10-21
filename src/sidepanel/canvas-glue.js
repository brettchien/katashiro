// Katashiro side panel — canvas glue: the panel's canvas store and folder mirror, the canvas_* tool
// helpers (normalize wait, goto / highlight / inject_css, show changes, compare, gallery), opening and
// finding canvas tabs, the canvas tab group + Split View, and one tab group per conversation (working
// tab, group tabs, restore / switch / archive). Moved verbatim out of sidepanel.js (plan B, step 2);
// no logic change.
//
// Classic script, loaded by sidepanel.html after conn.js, conversations.js and composer-ui.js and
// BEFORE cards.js and sidepanel.js; all scripts share one global scope. Load-order rule: this file
// holds declarations only. Its top level must not run anything that touches a name declared in
// sidepanel.js or a later-loaded file (DOM refs, room state, …) — that would be a TDZ
// ReferenceError at load. Its initializers use only src/core/ factories (CanvasStore,
// CanvasMirror). Function bodies may use names from any file, later-loaded ones included
// (confirmEvictCard calls confirmCard in cards.js): they only run once every script has loaded. The
// wiring that runs at load (chrome.storage / chrome.tabs / chrome.runtime listeners, the
// moved-canvas notes read, the Settings and 🗂️ buttons and their DOM refs) stays in sidepanel.js,
// at the spot these sections came from, so its order is unchanged.

// --- canvas helpers ----------------------------------------------------------------
// The panel's canvas store: chrome.storage.local, serialized by Web Locks shared with the canvas
// tabs (same extension origin), per canvas-store.js.
const canvasStore = CanvasStore.createCanvasStore({
  storage: chrome.storage.local,
  lock: (name, fn) => navigator.locks.request(name, fn),
  // Over the budget (§3.6): never evict a canvas open in a tab, and ask once, here in the
  // panel (the agent's write arrives here; no canvas tab may be open).
  isOpen: async (id) => !!(await findCanvasTab(id)),
  // A confirm card, not window.confirm (#80); the write waits on it (no lock held, §3.6). An
  // agent's write passes its own (ctx.canvas.confirmEvict, in its turn). This default is only a
  // fallback, with no caller today: the panel makes no user save (canvas.js saves through its own
  // store, which has no confirmEvict, so a user save over budget fails with a quota error, no card).
  confirmEvict: (info) => confirmEvictCard(info, null),
});

function confirmEvictCard({ evict }, conn, st = null) {
  return confirmCard({
    title: "畫布儲存空間已滿",
    lines: [
      `要刪除最久沒打開的 ${evict.length} 個畫布嗎？這個動作無法復原。`,
      ...evict.slice(0, 10).map((e) => `• ${e.title}`),
      ...(evict.length > 10 ? [`…還有 ${evict.length - 10} 個`] : []),
    ],
  }, { conn, st, notAskedNote: conn ? `${conn.name} 的回合已結束，清出畫布儲存空間的要求未執行（沒有詢問你）。` : "" });
}

// --- canvas folder mirror (ADR §3.6; decisions and file writes in canvas-mirror.js) -----------
// The panel writes the agent's saves (and anything else that changes a canvas while it is open);
// canvas tabs write their own saves, so the folder stays current with the panel closed. Both are
// serialized by the canvas:<id> lock, and a sync with nothing new is a no-op. Writes happen only
// while Chrome already grants access: the panel never prompts on its own (that needs a click).
// #98: while a canvas tab is open, an agent markdown write is mirrored once, after that tab's
// normalization (bounded wait, CanvasMirror.createNormalizeHold); with none open, at once as before.
// A new canvas (v1) waits too: canvas_open opens its tab right after the write (onCanvasWrite).
const canvasNormalizeHold = CanvasMirror.createNormalizeHold({
  rendering: async (id, meta) => meta.version === 1 || !!(await findCanvasTab(id)),
  retry: (id) => { canvasMirrorPending.add(id); runCanvasMirror(); },
});
const canvasMirror = CanvasMirror.createCanvasMirror({
  storage: chrome.storage.local,
  lock: (name, fn) => navigator.locks.request(name, fn),
  getRoot: () => CanvasMirror.grantedRoot(),
  holdForNormalization: canvasNormalizeHold.hold,
});
const canvasMirrorPending = new Set();
let canvasMirrorRunning = false;
async function runCanvasMirror() {
  if (canvasMirrorRunning) return;
  canvasMirrorRunning = true;
  try {
    while (canvasMirrorPending.size) {
      const id = canvasMirrorPending.values().next().value;
      canvasMirrorPending.delete(id);
      try { await canvasMirror.sync(id); } catch (_) { /* recorded in meta.file by the mirror */ }
    }
  } finally {
    canvasMirrorRunning = false;
  }
}

// Multi-conversation §7.3: canvases the user moved between conversations. canvasMoveNotes mirrors
// every canvas:<conv>:moved list (read at flush time, synchronously); the canvas tab follows the
// move here: into the new conversation's group when that one is open in this panel, else out of
// the old one's group. Only tabs in this panel's window (another window's panel does its own).
const canvasMoveNotes = new Map();                      // conversationId → [{ id, title, …, dir, at }]
const MOVED_KEY_RE = /^canvas:(c_[0-9a-f]{12}):moved$/;
async function followMovedCanvas(id, from, to) {
  try {
    const tab = await findCanvasTab(id);
    if (!tab || tab.windowId !== panelWindowId || !canGroupTabs()) return;
    if (convs.has(to)) { await canvasTabQueue(() => addToCanvasGroup(tab, to), to); return; }
    if (!convs.has(from)) return;
    const g = await storedCanvasGroupId(from);
    if (g != null && tab.groupId === g) await chrome.tabs.ungroup(tab.id);
  } catch (_) { /* grouping is cosmetic */ }
}

// Multi-conversation §7 / #101: a conversation's mirror folder follows its title. A title change
// moves nothing by itself; once it has settled (CanvasMirror.TITLE_SETTLE_MS without another change)
// the conversation's canvases are synced, which moves their files to the new folder in one go.
const canvasTitleSettle = CanvasMirror.createTitleSettle({
  settled: (convId) => { canvasMirror.syncConversation(convId).catch(() => {}); },
});

async function renderCanvasFolder(extra = "") {
  if (!canvasFolderStatusEl) return;
  const show = (pick, reconnect, stop) => {
    canvasFolderPickBtn.hidden = !pick;
    canvasFolderReconnectBtn.hidden = !reconnect;
    canvasFolderStopBtn.hidden = !stop;
  };
  if (typeof globalThis.showDirectoryPicker !== "function") { canvasFolderStatusEl.textContent = "這個瀏覽器不支援選擇資料夾（File System Access）。"; show(false, false, false); return; }
  const st = await CanvasMirror.folderStatus();
  if (!st.configured) {
    canvasFolderStatusEl.textContent = `未設定：畫布只存在這個 Chrome 設定檔裡。${extra}`;
    canvasFolderPickBtn.textContent = "📁 選擇資料夾";
    show(true, false, false);
  } else if (st.permission === "granted") {
    canvasFolderStatusEl.textContent = `✅ 寫入中：「${st.name}」${extra}`;
    canvasFolderPickBtn.textContent = "📁 換資料夾";
    show(true, false, true);
  } else {
    canvasFolderStatusEl.textContent = `⚠️ 「${st.name}」需要重新授權（瀏覽器重開後常見）。在那之前畫布照常存在 Katashiro 裡，連上後會補寫進資料夾。${extra}`;
    canvasFolderPickBtn.textContent = "📁 換資料夾";
    show(true, true, true);
  }
}
async function afterCanvasFolderConnected() {
  await renderCanvasFolder("（正在補寫…）");
  let counts = {};
  try { counts = await canvasMirror.syncAll(); } catch (_) { /* per-canvas state is in meta */ }
  const wrote = (counts.write || 0) + (counts.conflict || 0) + (counts.adopt || 0);
  const failed = counts.error || 0;
  await renderCanvasFolder(wrote || failed ? `（寫入 ${wrote} 個畫布${failed ? `，${failed} 個失敗` : ""}）` : "");
}

// §3.5: after an agent markdown write, wait (briefly) for an open canvas tab to normalize it, then
// return { diff } — raw → stored text ("" if unchanged) — or null if no tab rendered it in time.
const CANVAS_NORMALIZE_WAIT_MS = 4000;
async function waitCanvasNormalized(id, version, raw) {
  if (!(await findCanvasTab(id))) return null;           // nothing will render it now
  const key = CanvasStore.metaKey(id);
  const done = (m) => m && (m.agentVersion !== version || m.normalized === true);
  const ready = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; chrome.storage.onChanged.removeListener(onChange); clearTimeout(timer); resolve(v); };
    const onChange = (changes, area) => { if (area === "local" && changes[key] && done(changes[key].newValue)) finish(true); };
    const timer = setTimeout(() => finish(false), CANVAS_NORMALIZE_WAIT_MS);
    chrome.storage.onChanged.addListener(onChange);
    chrome.storage.local.get(key).then((got) => { if (done(got[key])) finish(true); }, () => {});
  });
  if (!ready) return null;
  const stored = await canvasStore.readAgentCopy(id);
  if (stored == null || typeof raw !== "string") return null;
  return { diff: CanvasStore.unifiedDiff(raw, stored) || "" };
}

// canvas_goto: bring the canvas's tab to the front (opening it if needed) and ask it — an extension
// page, reached by runtime messaging — to show slide N. A freshly opened tab may not listen yet,
// so retry for a few seconds. Returns { ok, index, total } or { ok:false, error }, plus the tabId it
// put in front (the working tab, multi-conversation §4.3).
async function gotoCanvasSlide(id, slide) {
  const tab = await openCanvasTab(id, { active: true });
  const r = await askCanvasTab({ type: "katashiro-canvas-goto", id, slide });
  return tab ? { ...r, tabId: tab.id } : r;
}

// Ask the canvas tab (runtime messaging; only canvas tabs of that id answer, never compare tabs),
// retrying for a few seconds while a fresh tab starts listening.
const CANVAS_TAB_TIMEOUT = "the canvas tab did not answer in time";
async function askCanvasTab(msg, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Each send is bounded by what is left of the deadline: a listener that returned true but never
    // answers must not hold the tool call (Jellyfish #79).
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res(null), Math.max(0, deadline - Date.now())); });
    let r;
    try { r = await Promise.race([chrome.runtime.sendMessage(msg), timeout]); }
    catch (_) { r = undefined; }
    clearTimeout(timer);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 300));
  }
  return { ok: false, error: CANVAS_TAB_TIMEOUT };
}

// canvas_highlight (§3.10): an open tab is asked first and brought to the front only once it has
// shown the block — while the user edits it answers `deferred` and must not take focus. A canvas
// not open in a tab is opened in front (nobody is editing it). Returns the canvas tab's answer, plus
// the tabId when it put the tab in front (the working tab, multi-conversation §4.3).
async function highlightCanvasBlock(id, req) {
  const existing = await findCanvasTab(id);
  let front = existing ? null : await openCanvasTab(id, { active: true });
  const r = await askCanvasTab({ type: "katashiro-canvas-highlight", id, ...req });
  if (existing && r && r.ok && !r.deferred) {
    try {
      const tab = (await findCanvasTab(id)) || existing;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      front = tab;
    } catch (_) { /* highlighted either way */ }
  }
  return front && r ? { ...r, tabId: front.id } : r;
}

// canvas_inject_css: every open tab of the canvas takes the sheet (each listens; the first answer
// is the result), like canvas_highlight an open tab comes to the front only once it applied it, and
// a canvas not open is opened in front. `clear` never opens or moves a tab: no tab, no sheets.
async function injectCanvasCss(id, req) {
  const existing = await findCanvasTab(id);
  if (req.clear && !existing) return { ok: true, sheets: 0 };
  let front = existing ? null : await openCanvasTab(id, { active: true });
  const r = await askCanvasTab({ type: "katashiro-canvas-css", id, ...req });
  if (existing && !req.clear && r && r.ok) {
    try {
      const tab = (await findCanvasTab(id)) || existing;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      front = tab;
    } catch (_) { /* applied either way */ }
  }
  return front && r ? { ...r, tabId: front.id } : r;
}

// --- canvas_view / canvas_gallery (§3.11): the user's display switches, for the agent ----------
// ◐ 顯示變更 is one switch for every canvas tab: writing it here is what a click in a tab does, and
// every canvas tab follows through storage.onChanged. → { was } (the state before).
async function setCanvasShowChanges(on) {
  const k = CanvasCore.SHOW_CHANGES_KEY;
  const was = (await chrome.storage.local.get(k))[k] === true;
  if (was !== on) await chrome.storage.local.set({ [k]: on });
  return { was };
}

// ⇆ Compare with agent's: pre-checked from storage (a canvas that cannot compare is not opened for
// nothing), then the canvas tab (the open one, or a new one in front) runs the button's own path, which
// asks this panel back (katashiro-canvas-compare) — so this must not run under canvasTabQueue.
// Only the picked tab answers (two tabs of one canvas must not both open a compare). An open tab is
// brought to the front only once the compare started: while the user edits it refuses, and must not
// take focus (Jellyfish #123). Its answer waits on the tab queue, so the deadline is longer than other
// asks; past it, a compare tab that did open meanwhile still counts (Jellyfish #123).
const COMPARE_ASK_MS = 20000;
async function startCanvasCompare(id) {
  let c, agentCopy;
  try {
    c = await canvasStore.read({ conversationId, id });
    agentCopy = await canvasStore.readAgentCopy(id);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  const blocked = CanvasCore.compareBlocker({ kind: c.kind, author: c.author, agentCopy, content: c.content, editing: false, framed: true });
  if (blocked) return { ok: false, error: blocked };
  const base = chrome.runtime.getURL("canvas.html");
  const existing = await findCanvasTab(id);
  const tab = existing || (await openCanvasTab(id, { active: true }));
  // The working tab (multi-conversation §4.3) is the canvas tab even when a plain compare tab is in
  // front: ✕ closes the compare tab, and a closed working tab would leave Q6 with nothing (Jellyfish #141).
  let shown = existing ? null : tab;
  let r = await askCanvasTab({ type: "katashiro-canvas-compare-start", id, tabId: tab.id }, COMPARE_ASK_MS);
  if (!r.ok && r.error === CANVAS_TAB_TIMEOUT) {
    if (!CanvasTabs.compareTabsFor(await chrome.tabs.query({}), base, id).length) {
      return { ok: false, error: `${CANVAS_TAB_TIMEOUT}; the compare may still open — check the tabs before asking again` };
    }
    r = { ok: true };                       // it did open: shown below like any started compare
  }
  if (existing && r.ok) {
    // Started: now show it — the compare tab when it opened as a plain tab, else the canvas tab
    // (Split View brings its pair along).
    try {
      const cmp = CanvasTabs.compareTabsFor(await chrome.tabs.query({}), base, id)[0];
      const canvasTab = (await findCanvasTab(id)) || existing;
      const front = cmp && cmp.active ? cmp : canvasTab;
      await chrome.tabs.update(front.id, { active: true });
      await chrome.windows.update(front.windowId, { focused: true });
      shown = canvasTab;
    } catch (_) { /* compared either way */ }
  }
  return shown ? { ...r, tabId: shown.id } : r;
}

// ✕ 結束比較: close that canvas's compare tab(s), as the button does; the canvas tab sees the close
// and clears its compare markers (§3.10). → { ok, closed }
async function endCanvasCompare(id) {
  const tabs = CanvasTabs.compareTabsFor(await chrome.tabs.query({}), chrome.runtime.getURL("canvas.html"), id);
  if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id));
  return { ok: true, closed: tabs.length };
}

// 🗂️: the panel's gallery button, optionally with the search box filled (#q=, sanitised there).
function openCanvasGallery(query) {
  return CanvasTabs.openGalleryTab(chrome, chrome.runtime.getURL("canvas-gallery.html"), { windowId: typeof panelWindowId === "number" ? panelWindowId : undefined, query });
}

function canvasTabUrl(id) {
  return CanvasTabs.canvasTabUrl(chrome.runtime.getURL("canvas.html"), id);
}

async function findCanvasTab(id) {
  // Match patterns do not cover chrome-extension://, so list tabs and compare URLs (needs "tabs").
  // Several tabs of one canvas: the most recently used (§3.1); never a compare tab.
  return CanvasTabs.pickCanvasTab(await chrome.tabs.query({}), chrome.runtime.getURL("canvas.html"), id);
}

// Focus the canvas's tab, or open it (in the panel's window, after the active tab) and put it in
// its conversation's canvas group (§3.1; `conv`, the current one by default). A tab found by URL
// stays wherever the user left it. `onTab` is called as soon as the tab is created, before the
// (cosmetic) grouping.
async function openCanvasTab(id, { active = true, onTab, conv = conversationId } = {}) {
  const existing = await findCanvasTab(id);
  if (existing) {
    if (active) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing;
  }
  const opts = { url: canvasTabUrl(id), active };
  if (typeof panelWindowId === "number") opts.windowId = panelWindowId;
  const tab = await chrome.tabs.create(opts);
  if (onTab) onTab(tab);
  // Grouping is cosmetic: a failure (old Chrome, no tabGroups, the tab already closed) never fails
  // the open. Re-read so callers see the tab's group.
  try {
    await canvasTabQueue(() => addToCanvasGroup(tab, conv), conv);
    return (await chrome.tabs.get(tab.id)) || tab;
  } catch (_) {
    return tab;
  }
}

// --- canvas tab group + Split View (§3.1; decisions in canvas-tabs.js) -----------------------
// One queue per conversation for its group / split moves (§3.1 "one queue per conversation";
// multi-conversation §3.10), so two quick canvas_open calls create one group, not two. A queued fn
// must not call openCanvasTab or canvasTabQueue for the same conversation: it would wait on itself.
// No timeout — a Chrome call that never settles stalls later group moves (accepted for phase 1).
const canvasTabChains = new Map();                       // conversationId → chain
function canvasTabQueue(fn, conv = conversationId) {
  const run = (canvasTabChains.get(conv) || Promise.resolve()).then(fn, fn);
  canvasTabChains.set(conv, run.catch(() => {}));
  return run;
}

const canGroupTabs = () => !!(chrome.tabGroups && typeof chrome.tabGroups.update === "function" && typeof chrome.tabs.group === "function");
const canSplitTabs = () => typeof chrome.tabs.createSplit === "function";

// A conversation's group id (taken explicitly, §3.10): in memory, mirrored to storage.session
// (survives a panel reload, not a browser restart — group ids do not either). Always verified before reuse.
const canvasGroupIds = new Map();                       // conversationId → groupId
const canvasGroupKey = (conv) => `katashiro.canvasGroup.${conv}`;
async function storedCanvasGroupId(conv) {
  if (canvasGroupIds.has(conv)) return canvasGroupIds.get(conv);
  try {
    const k = canvasGroupKey(conv);
    const got = await chrome.storage.session.get(k);
    if (Number.isInteger(got[k])) canvasGroupIds.set(conv, got[k]);
  } catch (_) { /* no storage.session: memory only */ }
  return canvasGroupIds.has(conv) ? canvasGroupIds.get(conv) : null;
}
async function rememberCanvasGroupId(conv, groupId) {
  canvasGroupIds.set(conv, groupId);
  try { await chrome.storage.session.set({ [canvasGroupKey(conv)]: groupId }); } catch (_) { /* memory only */ }
}
// The group is named after its conversation (§3.3, replacing "Canvas").
const canvasGroupTitle = (conv) => ConvCore.displayTitle(convIndex[conv], conv);
async function updateCanvasGroupTitle(conv) {
  if (!canGroupTabs()) return;
  const gid = await storedCanvasGroupId(conv);
  if (gid == null) return;
  try { await chrome.tabGroups.update(gid, { title: canvasGroupTitle(conv) }); } catch (_) { /* gone, or cosmetic */ }
}

// Put a tab in its conversation's canvas group in the tab's window: reuse the stored group if it
// still exists there, else create one (titled after the conversation, fixed color). Returns the
// group id, or null without tabGroups.
async function addToCanvasGroup(tab, conv = conversationId) {
  if (!canGroupTabs()) return null;
  const stored = await storedCanvasGroupId(conv);
  let groups = [];
  if (stored != null) { try { groups = [await chrome.tabGroups.get(stored)]; } catch (_) { /* gone */ } }
  const plan = CanvasTabs.planCanvasGroup({ storedGroupId: stored, groups, windowId: tab.windowId });
  if (plan.action === "reuse") {
    await chrome.tabs.group({ groupId: plan.groupId, tabIds: [tab.id] });
    return plan.groupId;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await rememberCanvasGroupId(conv, groupId);
  try { await chrome.tabGroups.update(groupId, { title: canvasGroupTitle(conv) || CanvasTabs.GROUP_TITLE, color: CanvasTabs.GROUP_COLOR }); } catch (_) { /* cosmetic */ }
  return groupId;
}

// --- one tab group per conversation (multi-conversation ADR §4; plans in canvas-tabs.js) -----------
// The canvas group above is the conversation's group: it also takes the tabs the agent opens
// (new_tab). The GROUP is the membership: a tab the user drags out is theirs again.
const canvasBase = () => chrome.runtime.getURL("canvas.html");

// A conversation's group id if that group still exists, else null.
async function liveGroupId(conv) {
  if (!canGroupTabs()) return null;
  const gid = await storedCanvasGroupId(conv);
  if (gid == null) return null;
  try { await chrome.tabGroups.get(gid); return gid; } catch (_) { return null; }
}
async function forgetCanvasGroupId(conv) {
  canvasGroupIds.delete(conv);
  try { await chrome.storage.session.remove(canvasGroupKey(conv)); } catch (_) { /* memory only */ }
}

// §4.3: the agent of conversation `convId` acted on `tabId` (opened it, with o.opened). → false when
// the tab could not be recorded (or, opened, could not join the group), else true.
async function noteWorkingTab(convId, tabId, { opened = false } = {}) {
  const conv = convs.get(convId);
  if (!conv || !Number.isInteger(tabId)) return false;
  const tab = await getTab(tabId);
  if (!tab) return false;
  // §4.1: an agent-opened tab joins the conversation's group (a tab the user opened never does).
  // A conversation not on screen works in that group: if the user collapsed it by hand, expand it —
  // Chrome freezes the pages of a collapsed group (Q8, §5.2).
  let grouped = true;
  if (opened) {
    const gid = await canvasTabQueue(() => addToCanvasGroup(tab, convId), convId).catch(() => null);
    grouped = gid != null;
    if (grouped && convId !== conversationId) await expandGroup(gid);
  }
  conv.workingTab = { id: tab.id, url: tab.url || tab.pendingUrl || "", at: Date.now() };
  saveConv(conv);
  return grouped;
}

// Q8 (§5.2) safeguard: Katashiro never collapses a conversation's group (Q5), but the user may do
// so by hand, and Chrome freezes the pages of a collapsed tab group (a freezing vote per tab) — a
// frozen page runs no timers or scripts, so a background conversation's page tools would stall.
// Expanding its group lifts that; it moves no tab and activates nothing.
async function expandGroup(gid) {
  if (gid == null || !canGroupTabs()) return;
  try {
    const g = await chrome.tabGroups.get(gid);
    if (g && g.collapsed) await chrome.tabGroups.update(gid, { collapsed: false });
  } catch (_) { /* gone: the tab check already decided */ }
}

// §4.3: the working tab, re-validated (same id + origin, else the exact URL), or null.
async function resolveWorkingTab(convId) {
  const conv = convs.get(convId);
  if (!conv || !conv.workingTab) return null;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) { return null; }
  return CanvasTabs.pickWorkingTab({ saved: conv.workingTab, tabs });
}

// P2 Q8 (§5): the tab a conversation NOT on screen may act on — the one it names (switch_tab,
// close_tab), else its working tab — checked by ConvCore.backgroundTabRefusal: in its own group,
// not a tab the user is on, no write while the user is on one of its group's tabs. → { tab } | { error }.
// "The user is on" = the active tab of EVERY window: an unfocused window on another screen is seen too.
// The tab the agent may act on gets its group expanded (expandGroup: a collapsed group is frozen).
async function backgroundTabFor(convId, { tabId = null, write = false } = {}) {
  const named = tabId != null;
  const tab = named ? await getTab(tabId) : await resolveWorkingTab(convId);
  const groupId = await liveGroupId(convId);
  const userTabs = [];
  try { userTabs.push(...await chrome.tabs.query({ active: true })); } catch (_) { /* no tab API: nothing known to be in front */ }
  const error = ConvCore.backgroundTabRefusal({ tab, groupId, userTabs, write, named });
  if (error) return { error };
  await expandGroup(groupId);
  return { tab };
}

// Q6 (§4.3): the user pressed send. If the conversation has a working tab in this window and it is
// not the active tab, activate it now — at the send, never during the turn.
async function switchToWorkingTab(convId) {
  if (typeof panelWindowId !== "number") return;
  const t = await resolveWorkingTab(convId);
  if (!t || t.windowId !== panelWindowId || t.active) return;
  try { await chrome.tabs.update(t.id, { active: true }); } catch (_) { /* closed meanwhile, or being dragged */ }
}

// §4.4: conv.groupTabs follows the group (debounced). A conversation with no known group (after a
// browser restart, before its tabs came back) keeps the list it has.
const groupTabsTimers = new Map();
function scheduleGroupTabsRefresh(convId) {
  clearTimeout(groupTabsTimers.get(convId));
  groupTabsTimers.set(convId, setTimeout(() => { groupTabsTimers.delete(convId); refreshGroupTabs(convId).catch(() => {}); }, 400));
}
function scheduleAllGroupTabsRefresh() { for (const id of convs.keys()) scheduleGroupTabsRefresh(id); }
async function refreshGroupTabs(convId) {
  const conv = convs.get(convId);
  if (!conv || !canGroupTabs()) return;
  const gid = await storedCanvasGroupId(convId);
  if (gid == null) return;
  let tabs;
  try { tabs = await chrome.tabs.query({ groupId: gid }); } catch (_) { return; }
  const urls = CanvasTabs.groupTabUrls(tabs, gid, canvasBase());
  if (convs.get(convId) !== conv || JSON.stringify(urls) === JSON.stringify(conv.groupTabs)) return;
  conv.groupTabs = urls;
  saveConv(conv);
}

// §4.4: a conversation comes back (browser-restart adoption, 重新打開): open its group's tabs again
// in the background, adopting the ones already open (by URL) instead of opening them twice. Not
// when its group still exists (a panel reload, a plain switch).
async function restoreGroupTabs(convId) {
  const conv = convs.get(convId);
  if (!conv || !conv.groupTabs.length || typeof panelWindowId !== "number") return;
  if ((await liveGroupId(convId)) != null) return;
  await canvasTabQueue(async () => {
    const all = await chrome.tabs.query({});
    const others = await CanvasTabs.otherGroupIds([...convs.keys()], convId, storedCanvasGroupId);
    const plan = CanvasTabs.planGroupRestore({ urls: conv.groupTabs, tabs: all, windowId: panelWindowId, otherGroupIds: others });
    const ids = [...plan.adopt];
    for (const url of plan.open) {
      try { ids.push((await chrome.tabs.create({ url, active: false, windowId: panelWindowId })).id); } catch (_) { /* a URL Chrome will not open */ }
    }
    if (!ids.length || !canGroupTabs()) return;
    let gid = plan.reuseGroupId;
    if (gid != null) {
      await rememberCanvasGroupId(convId, gid);
      await chrome.tabs.group({ groupId: gid, tabIds: ids });
    } else {
      gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: panelWindowId } });
      await rememberCanvasGroupId(convId, gid);
    }
    try { await chrome.tabGroups.update(gid, { title: canvasGroupTitle(convId), color: CanvasTabs.GROUP_COLOR }); } catch (_) { /* cosmetic */ }
  }, convId);
}

// Q5 (§4.2): after a switch, expand the current conversation's group (the user may have collapsed
// it by hand) and, if the active tab sits in another conversation's group, activate one outside it.
// No group is collapsed — a conversation's group stays until archive (§4.5). Serialized; best effort.
let groupSwitchChain = Promise.resolve();
function applyGroupSwitch() {
  const run = groupSwitchChain.then(async () => {
    const cur = conversationId;
    if (!cur || !canGroupTabs() || typeof panelWindowId !== "number") return;
    const tabs = await chrome.tabs.query({ windowId: panelWindowId });
    const groupId = await storedCanvasGroupId(cur);
    const others = await CanvasTabs.otherGroupIds([...convs.keys()], cur, storedCanvasGroupId);
    const conv = convs.get(cur);
    const working = conv && conv.workingTab ? CanvasTabs.pickWorkingTab({ saved: conv.workingTab, tabs }) : null;
    const plan = CanvasTabs.planGroupSwitch({ tabs, groupId, otherGroupIds: others, workingTabId: working ? working.id : null });
    if (cur !== conversationId) return;                  // switched again meanwhile: the next run decides
    if (plan.activate != null) await chrome.tabs.update(plan.activate, { active: true });
    if (plan.expand != null) { try { await chrome.tabGroups.update(plan.expand, { collapsed: false }); } catch (_) { /* gone */ } }
  });
  groupSwitchChain = run.catch(() => {});
  return groupSwitchChain;
}

// §4.5: may this canvas tab be closed? Asks that tab (only it answers); no answer in time → treated
// as dirty: an edit must never be lost to an archive. A discarded / unloaded tab holds no editor.
async function canvasTabDirty(tab) {
  if (tab.discarded || tab.status === "unloaded") return false;
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(null), 1500); });
  let r;
  try { r = await Promise.race([chrome.runtime.sendMessage({ type: "katashiro-canvas-dirty", tabId: tab.id }), timeout]); } catch (_) { r = null; }
  clearTimeout(timer);
  return !(r && r.dirty === false);
}

// §4.5: archive closes the group's tabs (they come back with it, §4.4), keeping any canvas tab with
// unsaved edits, and never the window's last tab.
async function closeConversationTabs(gid, title) {
  if (gid == null || !canGroupTabs()) return;
  const all = await chrome.tabs.query({});
  const inGroup = all.filter((t) => t.groupId === gid);
  if (!inGroup.length) return;
  const win = inGroup[0].windowId;
  const dirty = [];
  for (const t of inGroup) if (CanvasTabs.classifyTab(t, canvasBase()) === "canvas" && (await canvasTabDirty(t))) dirty.push(t.id);
  const plan = CanvasTabs.planArchiveClose({ tabs: all.filter((t) => t.windowId === win), groupId: gid, dirtyIds: dirty });
  if (plan.needNewTab) await chrome.tabs.create({ windowId: win, active: true });
  if (plan.close.length) await chrome.tabs.remove(plan.close);
  if (plan.keep.length) {
    try { await chrome.tabGroups.update(gid, { collapsed: true }); } catch (_) { /* cosmetic */ }
    appendSystemMessage(`「${title}」有 ${plan.keep.length} 個畫布分頁還有未儲存的修改（或沒有回應），沒有關掉；存好後可以自己關。`);
  }
}
// Canvas tabs moved out of their group for a split: canvasTabId → { movedToGroupId, windowId,
// returnGroupId, canvasGroup, pageTabId, conv }. In memory only: a panel reload forgets them, and those
// tabs simply stay in the page's group (acceptable, §3.1).
const canvasSplitMoves = new Map();

const getTab = (tabId) => chrome.tabs.get(tabId).catch(() => null);

// The split ended or the page closed: put the canvas tab back, if nothing else moved it.
async function restoreCanvasTab(tabId) {
  const record = canvasSplitMoves.get(tabId);
  if (!record) return;
  const tab = await getTab(tabId);
  if (tab && CanvasTabs.inSplit(tab)) return;          // still split: keep the record
  let groups = [];
  if (record.returnGroupId !== CanvasTabs.TAB_GROUP_NONE) {
    try { groups = [await chrome.tabGroups.get(record.returnGroupId)]; } catch (_) { /* gone */ }
  }
  const plan = CanvasTabs.planRestore({ canvasTab: tab, record, groups });
  // The record is dropped only once the move worked: a rejected call (e.g. "Tabs cannot be edited
  // right now" while the user drags a tab) keeps it, so the next sweep tries again. No cooldown or
  // attempt cap (Brett, 2026-10-11, #90): retries come only with a canvas_open or a tab event.
  if (plan.action === "group") await chrome.tabs.group({ groupId: plan.groupId, tabIds: [tabId] });
  else if (plan.action === "ungroup") await chrome.tabs.ungroup([tabId]);
  else if (plan.action === "recreate") await addToCanvasGroup(tab, record.conv || conversationId);
  if (canvasSplitMoves.get(tabId) === record) canvasSplitMoves.delete(tabId);
}

// Lazy fallback (§3.1): if Chrome sent no "split ended" event, the next canvas_open moves back
// whatever is no longer split.
async function sweepCanvasRestores() {
  for (const tabId of [...canvasSplitMoves.keys()]) {
    try { await restoreCanvasTab(tabId); } catch (_) { /* best effort */ }
  }
}

// Under the canvas tab queue. Ends a split the canvas tab is in (and moves it back to its group
// under the §3.1 rules), then opens the compare tab beside it in the canvas tab's group and splits
// them. The earlier split is not restored afterwards. Never leaves a half-made compare tab behind
// if the canvas tab closes mid-way. → { ok, note? } | { ok: false, error }
async function compareCanvasTab(canvasTabId, id) {
  const base = chrome.runtime.getURL("canvas.html");
  let c = await getTab(canvasTabId);
  const existing = (await chrome.tabs.query({})).find((t) => CanvasTabs.isCompareTabFor(t, base, id)) || null;
  const plan = CanvasTabs.planCompare({ canvasTab: c, compareTab: existing, canSplit: canSplitTabs() });
  if (!plan.ok) return { ok: false, error: plan.reason };
  if (plan.action === "focus") {
    await chrome.tabs.update(existing.id, { active: true });
    return { ok: true };
  }
  if (plan.closeOld != null) { try { await chrome.tabs.remove(plan.closeOld); } catch (_) { /* already gone */ } }
  if (plan.unsplit != null) {
    try { await chrome.tabs.unsplit(plan.unsplit); } catch (e) { return { ok: false, error: `could not end the current Split View: ${(e && e.message) || e}` }; }
    try { await restoreCanvasTab(canvasTabId); } catch (_) { /* stays where it is */ }
    c = await getTab(canvasTabId);
    if (!c) return { ok: false, error: "the canvas tab closed" };
  }
  const created = await chrome.tabs.create(CanvasTabs.compareTabProps(c, CanvasTabs.compareTabUrl(base, id), plan.split));
  // Re-read after every await (§3.1); the compare tab follows the canvas tab's group.
  const fresh = async () => [await getTab(canvasTabId), await getTab(created.id)];
  let [cv, cmp] = await fresh();
  if (!cv) { try { await chrome.tabs.remove(created.id); } catch (_) { /* gone */ } return { ok: false, error: "the canvas tab closed" }; }
  if (!cmp) return { ok: false, error: "the compare tab closed" };
  const g = CanvasTabs.groupOf(cv);
  if (canGroupTabs() && CanvasTabs.groupOf(cmp) !== g) {
    try {
      if (g === CanvasTabs.TAB_GROUP_NONE) await chrome.tabs.ungroup([cmp.id]);
      else await chrome.tabs.group({ groupId: g, tabIds: [cmp.id] });
    } catch (_) { /* the split check below decides */ }
    [cv, cmp] = await fresh();
    if (!cv || !cmp) { if (cmp) { try { await chrome.tabs.remove(cmp.id); } catch (_) { /* gone */ } } return { ok: false, error: "a tab closed while opening the compare view" }; }
  }
  const asTab = async (why) => {
    await chrome.tabs.update(cmp.id, { active: true });
    return { ok: true, note: `比較畫面開在一般分頁：${why}` };
  };
  if (!plan.split) return asTab("這個瀏覽器沒有 Split View（需要 Chrome 155+）");
  const blocked = CanvasTabs.splitBlocker(cv, cmp);
  if (blocked) return asTab(blocked);
  try {
    await chrome.tabs.createSplit([cv.id, cmp.id]);
  } catch (e) {
    return asTab(`could not create the split: ${(e && e.message) || e}`);
  }
  return { ok: true };
}

// canvas_open(…, beside: "current"): Split View with the active tab of the panel's window.
// Returns the note for the tool result — never throws (the canvas is saved either way).
async function showCanvasBeside(id, created, conv = conversationId) {
  try {
    if (!canSplitTabs()) {
      await openCanvasTab(id, { active: true, conv });
      return "Split View is unavailable in this browser (needs Chrome 155+); its tab was brought to the front instead";
    }
    const canvasTab = await openCanvasTab(id, { active: false, conv });
    const note = await canvasTabQueue(() => splitCanvasWithActive(canvasTab, conv), conv);
    if (note.ok) return note.text;
    await openCanvasTab(id, { active: true, conv });
    return `${created ? "opened" : "its tab was brought to the front"}, not in Split View: ${note.text}`;
  } catch (e) {
    return `not shown in Split View: ${(e && e.message) || e}`;
  }
}

async function splitCanvasWithActive(canvasTab, conv = conversationId) {
  const query = { active: true };
  if (typeof panelWindowId === "number") query.windowId = panelWindowId;
  const [page] = await chrome.tabs.query(query);
  const canvasBase = chrome.runtime.getURL("canvas.html");
  const plan = CanvasTabs.planBeside({ canvasTab, pageTab: page, canvasBase });
  if (!plan.ok) return { ok: false, text: plan.reason };
  // Re-read after every await (§3.1): the user may close or move either tab mid-sequence.
  const fresh = async () => [await getTab(canvasTab.id), await getTab(page.id)];
  let record = null;
  const rollback = async () => {
    if (!record) return;
    canvasSplitMoves.set(canvasTab.id, record);
    try { await restoreCanvasTab(canvasTab.id); } catch (_) { /* best effort */ }
  };
  // Follows the page's group as it is now (the user may have dragged the page elsewhere), and the
  // record always names the group the canvas tab was put in, so planRestore still recognises it.
  const from = CanvasTabs.groupOf(canvasTab);
  const regroup = async (c, p) => {
    const g = CanvasTabs.groupOf(p);
    if (CanvasTabs.groupOf(c) === g) return;
    if (!record) {
      const stored = await storedCanvasGroupId(conv);
      record = {
        windowId: canvasTab.windowId, pageTabId: page.id, returnGroupId: from,
        canvasGroup: from !== CanvasTabs.TAB_GROUP_NONE && from === stored, conv,
      };
    }
    record.movedToGroupId = CanvasTabs.groupOf(c);      // where Katashiro's moves have left it so far
    if (g === CanvasTabs.TAB_GROUP_NONE) await chrome.tabs.ungroup([c.id]);
    else await chrome.tabs.group({ groupId: g, tabIds: [c.id] });
    record.movedToGroupId = g;                          // only once Chrome has moved it
  };
  try {
    if (plan.regroup) await regroup(canvasTab, page);
    let [c, p] = await fresh();
    if (!c || !p) { await rollback(); return { ok: false, text: "a tab closed while moving it" }; }
    const to = CanvasTabs.adjacentIndex(p, c);
    if (to != null) {
      await chrome.tabs.move(c.id, { index: to });
      [c, p] = await fresh();
      if (!c || !p) { await rollback(); return { ok: false, text: "a tab closed while moving it" }; }
      await regroup(c, p);                              // a move can pull a tab into / out of a group
      [c, p] = await fresh();
      if (!c || !p) { await rollback(); return { ok: false, text: "a tab closed while moving it" }; }
    }
    const blocked = CanvasTabs.splitBlocker(c, p);
    if (blocked) { await rollback(); return { ok: false, text: blocked }; }
    await chrome.tabs.createSplit([p.id, c.id]);
  } catch (e) {
    await rollback();
    return { ok: false, text: `could not create the split: ${(e && e.message) || e}` };
  }
  if (record) canvasSplitMoves.set(canvasTab.id, record);
  // The page title is page content: bounded (by code point, so no half emoji), JSON-quoted, and
  // only ever a label.
  const t = Array.from(String(page.title || page.url || "the page")).slice(0, 80).join("");
  return { ok: true, text: `shown beside ${JSON.stringify(t)} in Split View` };
}

// The chat card for a canvas write: "📄 <title> · v<N> — 開啟". Title is agent text → textContent.
function canvasCard({ id, version, title, conv = conversationId }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "canvas-card";
  const icon = document.createElement("span");
  icon.className = "canvas-card-icon";
  icon.textContent = "📄";
  const name = document.createElement("span");
  name.className = "canvas-card-title";
  name.textContent = String(title || "Canvas").slice(0, 120);
  const meta = document.createElement("span");
  meta.className = "canvas-card-meta";
  meta.textContent = `v${version} — 開啟`;
  card.append(icon, name, meta);
  card.title = "在分頁中開啟這個畫布";
  card.addEventListener("click", () => { openCanvasTab(id, { active: true, conv }).catch(() => {}); });
  return card;
}
