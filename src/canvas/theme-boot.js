// theme-boot.js — canvas.html / canvas-gallery.html: set data-ks-theme on the root before the first
// paint (ADR canvas-themes §2.2), so a light setting or a light OS never flashes the dark theme while
// chrome.storage (async) is read. Loaded in <head>, before the stylesheets apply. The setting is
// mirrored into localStorage by canvas.js, canvas-gallery.js and Settings; the real value from
// chrome.storage.local (CanvasCore.THEME_KEY) still decides once it arrives.
(() => {
  let s = "system";
  try { s = localStorage.getItem("katashiro.canvasTheme") || "system"; } catch (_) { /* default */ }
  const dark = s === "dark" || (s !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.ksTheme = dark ? "dark" : "light";
})();
