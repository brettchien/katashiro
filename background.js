// Background Service Worker
importScripts("canvas-store.js");

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Listener for installation or updates
chrome.runtime.onInstalled.addListener(() => {
  console.log("Katashiro - OpenAB Companion has been installed.");
  removeIncognitoCanvases();
});

// Katashiro does not run in incognito (manifest "incognito": "not_allowed", #109): what is sent to
// the agent cannot be forgotten, so an incognito promise could not be kept. Before that, an incognito
// panel's canvases went to chrome.storage.local (on disk) marked noMirror: remove them. onInstalled
// fires on every install / extension update / Chrome update (nothing creates such a canvas now), and
// the store's remove path keeps the index, images and budget consistent. Idempotent and best
// effort: once they are gone it finds nothing; one cut short by the worker stopping is finished by
// the next update.
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
