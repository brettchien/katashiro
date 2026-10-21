// page/ctx-target.js — content script (every page and frame, document_start, isolated world) for
// 💬 Ask agent in Chrome's own context menu (ADR docs/adr/page-send-to-agent.md §2.2 step 3).
//
// Chrome's contextMenus.onClicked never says which element was right-clicked, so this remembers
// the target of the last TRUSTED contextmenu event, and whether there was a selection before the
// press (on a Mac the right-click itself selects the word under the pointer, before contextmenu).
// It keeps one WeakRef under a fixed globalThis key (a content script's top-level const is not a
// property of globalThis), sends nothing anywhere, and is read only by the service worker's own
// scripting.executeScript (page-ask-core.js collectInPage) when the user picks the menu item.
//
// Capture phase on window, registered at document_start before any page script: a page handler
// cannot stop it first. Untrusted events are ignored: a page could dispatchEvent a synthetic
// contextmenu from its own handler to swap the recorded target (§2.7).
(() => {
  const KEY = "__katashiroCtxTarget";                  // = PageAskCore.TARGET_KEY
  if (globalThis[KEY]) return;                         // injected twice (an update): keep the first
  const rec = { target: null, hadSelection: null, at: 0 };
  globalThis[KEY] = rec;

  const isMac = /Mac/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "");
  let pressed = null;                                  // { hadSelection, at } from the last context-menu press

  // A selection the user made before the press: a non-collapsed window selection, or a focused text
  // field with a selected range (window.getSelection() is blind to those).
  const hadSelection = () => {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    try {
      if (a && typeof a.selectionStart === "number" && a.selectionStart !== a.selectionEnd) return true;
    } catch (_) { /* an input type without a selection API */ }
    const s = window.getSelection();
    return !!s && !s.isCollapsed;
  };

  window.addEventListener("mousedown", (e) => {
    if (!e.isTrusted) return;
    // A context-menu press: the right button, or Ctrl + the main button on a Mac.
    if (e.button === 2 || (e.button === 0 && e.ctrlKey && isMac)) pressed = { hadSelection: hadSelection(), at: Date.now() };
    else pressed = null;
  }, true);

  window.addEventListener("contextmenu", (e) => {
    if (!e.isTrusted) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    let t = path[0] || e.target;                       // the real element inside an open shadow root
    if (t && t.nodeType !== 1) t = t.parentElement || null;
    rec.target = t ? new WeakRef(t) : null;
    // No press just before (the keyboard's menu key, Shift+F10): unknown, the menu's info decides.
    rec.hadSelection = pressed && Date.now() - pressed.at < 5000 ? pressed.hadSelection : null;
    rec.at = Date.now();
    pressed = null;
  }, true);
})();
