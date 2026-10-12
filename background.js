// Background Service Worker
// The canvas store is only for the incognito cleanup below. A failure to load it must not kill the
// worker (#113 review): the side panel behavior and the listeners still get set up, and the
// cleanup just reports that it cannot run.
try {
  importScripts("canvas-store.js");
} catch (e) {
  console.warn("Katashiro: canvas-store.js failed to load; the incognito canvas cleanup is off:", e);
}

// Multi-conversation (ADR docs/adr/multi-conversation.md §3.2): the one-time migration of
// history:<windowId> into conv:<id> + window:<windowId>. Same rule as above: a failure to load
// must not kill the worker; a panel runs the migration itself on load anyway.
try {
  importScripts("confirm-core.js", "conv-core.js");
} catch (e) {
  console.warn("Katashiro: conv-core.js failed to load; conversations migrate when a panel opens:", e);
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Listener for installation or updates
chrome.runtime.onInstalled.addListener(() => {
  console.log("Katashiro - OpenAB Companion has been installed.");
  removeIncognitoCanvases();
  migrateConversations().then(finishConversationDeletes);
});
// Also on every browser start (#113 review): a cleanup cut short by the worker stopping is
// finished without waiting for the next update.
chrome.runtime.onStartup.addListener(() => {
  removeIncognitoCanvases();
  migrateConversations().then(finishConversationDeletes);
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
