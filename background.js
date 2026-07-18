// Background Service Worker
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

// Listener for installation or updates
chrome.runtime.onInstalled.addListener(() => {
  console.log("Katashiro - OpenAB Companion has been installed.");
});
