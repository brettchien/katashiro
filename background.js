// Background Service Worker
// The canvas store is only for the incognito cleanup below. A failure to load it must not kill the
// worker (#113 review): the side panel behavior and the listeners still get set up, and the
// cleanup just reports that it cannot run.
try {
  importScripts("canvas-store.js");
} catch (e) {
  console.warn("Katashiro: canvas-store.js failed to load; the incognito canvas cleanup is off:", e);
}

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Listener for installation or updates
chrome.runtime.onInstalled.addListener(() => {
  console.log("Katashiro - OpenAB Companion has been installed.");
  removeIncognitoCanvases();
});
// Also on every browser start (#113 review): a cleanup cut short by the worker stopping is
// finished without waiting for the next update.
chrome.runtime.onStartup.addListener(() => {
  removeIncognitoCanvases();
});

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
