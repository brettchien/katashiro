// Background Service Worker
// The canvas store is only for the incognito cleanup below. A failure to load it must not kill the
// worker (#113 review): the side panel behavior and the listeners still get set up, and the
// cleanup just reports that it cannot run.
try {
  importScripts("core/canvas-store.js");
} catch (e) {
  console.warn("Katashiro: canvas-store.js failed to load; the incognito canvas cleanup is off:", e);
}

// Multi-conversation (ADR docs/adr/multi-conversation.md §3.2): the one-time migration of
// history:<windowId> into conv:<id> + window:<windowId>. Same rule as above: a failure to load
// must not kill the worker; a panel runs the migration itself on load anyway.
try {
  importScripts("core/confirm-core.js", "core/conv-core.js");
} catch (e) {
  console.warn("Katashiro: conv-core.js failed to load; conversations migrate when a panel opens:", e);
}

// 💬 Ask agent on a web page (ADR docs/adr/page-send-to-agent.md): the menu's constants, the
// in-page collector (also injected into the right-clicked frame) and the payload. A failure to load
// leaves the menu out; everything else still runs.
try {
  importScripts("core/page-ask-core.js");
} catch (e) {
  console.warn("Katashiro: page-ask-core.js failed to load; the 💬 Ask agent menu is off:", e);
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Listener for installation or updates
chrome.runtime.onInstalled.addListener(() => {
  console.log("Katashiro - OpenAB Companion has been installed.");
  removeIncognitoCanvases();
  migrateConversations().then(finishConversationDeletes);
  registerPageAskMenu();
});
// Also on every browser start (#113 review): a cleanup cut short by the worker stopping is
// finished without waiting for the next update.
chrome.runtime.onStartup.addListener(() => {
  removeIncognitoCanvases();
  migrateConversations().then(finishConversationDeletes);
  registerPageAskMenu();
});

// §3.2: runs whenever a history:* key exists (an update, or what an older version wrote during a
// downgrade), under the conv:migrate lock shared with the panels, which await it before loading.
// Every step is idempotent: a run cut short by the worker stopping is finished by the next one
// (here or in a panel). Best effort here: never throws.
async function migrateConversations() {
  try {
    if (typeof ConvCore === "undefined") return;
    const store = ConvCore.createConvStore({
      storage: chrome.storage.local,
      lock: (name, fn) => navigator.locks.request(name, fn),
      // Every window type: a panel in an app/devtools window must not count as closed (#56).
      liveWindowIds: async () => new Set((await chrome.windows.getAll({ windowTypes: ["normal", "popup", "panel", "app", "devtools"] })).map((w) => String(w.id))),
      randomUUID: () => crypto.randomUUID(),
    });
    const r = await store.migrate();
    if (r.migrated) console.log(`Katashiro: migrated ${r.migrated} conversation(s) to the multi-conversation layout.`);
  } catch (e) {
    console.warn("Katashiro: conversation migration failed (a panel retries on load):", e);
  }
}

// Multi-conversation §7.1: a conversation delete the gallery started and did not finish (its tab
// closed, the browser quit) carries deletingAt in conv:index; finish it. Each one's conv:<id> lock
// is taken with ifAvailable, so a delete still running in a gallery tab is left to that tab. Best
// effort and idempotent, like the two above.
async function finishConversationDeletes() {
  try {
    if (typeof ConvCore === "undefined" || typeof CanvasStore === "undefined") return;
    const lock = (name, fn) => navigator.locks.request(name, fn);
    const store = ConvCore.createConvStore({
      storage: chrome.storage.local,
      lock,
      liveWindowIds: async () => new Set((await chrome.windows.getAll({ windowTypes: ["normal", "popup", "panel", "app", "devtools"] })).map((w) => String(w.id))),
      randomUUID: () => crypto.randomUUID(),
      lockIfAvailable: (name, fn) => navigator.locks.request(name, { ifAvailable: true }, fn),
      canvases: ConvCore.canvasOps(CanvasStore.createCanvasStore({ storage: chrome.storage.local, lock })),
      sessionStorage: chrome.storage.session,
    });
    const done = await store.finishDeletions();
    if (done.length) console.log(`Katashiro: finished deleting ${done.length} conversation(s).`);
  } catch (e) {
    console.warn("Katashiro: finishing a conversation delete failed (a panel or the gallery retries):", e);
  }
}

// Katashiro does not run in incognito (manifest "incognito": "not_allowed", #109): what is sent to
// the agent cannot be forgotten, so an incognito promise could not be kept. Before that, an incognito
// panel's canvases went to chrome.storage.local (on disk) marked noMirror: remove them. Runs on
// onInstalled (every install / extension update / Chrome update) and onStartup (nothing creates
// such a canvas now), and the store's remove path keeps the index, images and budget consistent.
// Idempotent and best effort: once they are gone it finds nothing.
async function removeIncognitoCanvases() {
  try {
    const store = CanvasStore.createCanvasStore({
      storage: chrome.storage.local,
      lock: (name, fn) => navigator.locks.request(name, fn),
    });
    const n = await store.removeIncognitoLeftovers();
    if (n) console.log(`Katashiro: removed ${n} canvas(es) left by incognito windows (#109).`);
  } catch (e) {
    console.warn("Katashiro: incognito canvas cleanup failed:", e);
  }
}

// --- 💬 Ask agent on a web page (ADR page-send-to-agent) -------------------------------------------
// §2.1: one item in Chrome's own context menu (a page cannot imitate, cover or restyle it), on web
// pages only. removeAll first: onInstalled and onStartup both register, and create() of an id that
// exists is an error.
function registerPageAskMenu() {
  if (typeof PageAskCore === "undefined" || !chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: PageAskCore.MENU_ID,
      title: PageAskCore.MENU_TITLE,
      contexts: PageAskCore.MENU_CONTEXTS,
      documentUrlPatterns: PageAskCore.MENU_URL_PATTERNS,
    }, () => { if (chrome.runtime.lastError) console.warn("Katashiro: the 💬 Ask agent menu:", chrome.runtime.lastError.message); });
  });
}

// §2.2: the menu click. First, synchronously, open the side panel of the tab's window: the click is
// a user gesture and any await before the call loses it (opening an open panel is harmless; whether
// it is open cannot be known without an async call). Then collect and hand over (collectPageAsk).
// Returns the collection's promise (the payload, or null).
function onPageAskClicked(info, tab) {
  if (typeof PageAskCore === "undefined" || !info || info.menuItemId !== PageAskCore.MENU_ID) return Promise.resolve(null);
  if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId) || tab.id < 0) return Promise.resolve(null);
  try { chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {}); } catch (_) { /* no gesture, or no side panel */ }
  return collectPageAsk(info, tab).catch((e) => { console.warn("Katashiro: 💬 Ask agent failed:", e); return null; });
}
if (chrome.contextMenus && chrome.contextMenus.onClicked) chrome.contextMenus.onClicked.addListener(onPageAskClicked);

// §2.2 steps 2–4: in the right-clicked frame (info.frameId), the selection (the get_selection reader)
// and the content script's record (page/ctx-target.js; same isolated world as executeScript) —
// page-ask-core.js is injected there, then its collectInPage runs. A page Chrome does not let us
// script, or a file:// page without file access, gives nothing: the menu's info is all there is.
// The page facts come from the tab, not the page. Then the payload goes to the panel of the tab's
// window — by runtime message, and left in storage.session for a panel that is only now opening
// (picked up on load if < 60 s old; reqId dedupes the two). Written first, so a panel that loads in
// between finds one or the other.
async function collectPageAsk(info, tab) {
  const frameId = Number.isInteger(info.frameId) && info.frameId >= 0 ? info.frameId : 0;
  const url = String(info.frameUrl || info.pageUrl || tab.url || "");
  let fileNoAccess = false;
  if (/^file:/i.test(url)) {
    try { fileNoAccess = !(await chrome.extension.isAllowedFileSchemeAccess()); } catch (_) { fileNoAccess = true; }
  }
  let inPage = null;
  if (!fileNoAccess) {
    try {
      const target = { tabId: tab.id, frameIds: [frameId] };
      await chrome.scripting.executeScript({ target, files: ["src/core/page-ask-core.js"] });
      const [r] = await chrome.scripting.executeScript({
        target,
        func: (o) => (globalThis.PageAskCore ? globalThis.PageAskCore.collectInPage(o) : null),
        args: [{ key: PageAskCore.TARGET_KEY, isTop: frameId === 0 }],
      });
      inPage = (r && r.result) || null;
    } catch (_) { inPage = null; }                       // not scriptable: the menu's info only
  }
  const payload = PageAskCore.buildPayload({ info, tab, inPage, fileNoAccess, reqId: crypto.randomUUID() });
  try {
    await chrome.storage.session.set({ [`${PageAskCore.HANDOFF_KEY_PREFIX}${tab.windowId}`]: { ...payload, at: Date.now() } });
  } catch (_) { /* no storage.session: the message alone */ }
  chrome.runtime.sendMessage(payload).catch(() => { /* no panel open yet: it takes the stored copy */ });
  return payload;
}
