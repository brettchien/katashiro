// canvas-html-frame.js — the one script of ours in canvas-html-frame.html (canvas-html ADR §2.4).
//
// Runs in an opaque origin with no chrome.* APIs, before any agent script. It talks only to its
// parent (canvas.html):
//  in:  render{nonce, kind: "html", content, version}   — once; a second one is ignored
//  out: ready, rendered{version}, error{msg}, openLink{url} — each with the nonce from #k=<nonce>
// On render it replaces this document with the canvas's HTML (document.open / write / close), which
// runs the page's inline scripts here, under this page's CSP. document.open drops the listeners
// added before it, so after close() the link and CSP listeners are added again, then rendered{}.
// The nonce is read once, first: the page can read and rewrite the hash (Archify does), so here it
// is only a second check behind the host's load gate (canvas §3.2).
(function () {
  "use strict";

  const nonce = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  const parentWin = window.parent;
  const post = (msg) => parentWin.postMessage({ ...msg, nonce }, "*");
  let done = false;

  // Links the page draws open through the host (http(s) only, after the user confirms), never in
  // this frame. A convenience: page script can stop it; the host's load gate is what holds.
  function onLinkClick(e) {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
    const a = path.find((n) => n && n.nodeType === 1 && typeof n.matches === "function" && n.matches("a, area")) || null;
    if (!a) return;
    const href = a.getAttribute("href") || a.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
    if (!href || href.startsWith("#")) return;          // in-page anchors: the page's own business
    e.preventDefault();
    let url = href;
    if (typeof a.href === "string") url = a.href;
    else { try { url = new URL(href, document.baseURI).href; } catch (_) { /* the host refuses it */ } }
    post({ type: "openLink", url: String(url).slice(0, 4096) });
  }

  function onMessage(event) {
    if (done || event.source !== parentWin) return;
    const m = event.data;
    if (!m || m.nonce !== nonce || m.type !== "render" || m.kind !== "html" || typeof m.content !== "string" || !Number.isInteger(m.version)) return;
    done = true;                                         // one render per load
    window.removeEventListener("message", onMessage);
    const version = m.version;
    document.open();
    document.write(m.content);
    document.close();
    window.addEventListener("click", onLinkClick, true);
    window.addEventListener("auxclick", onLinkClick, true);
    window.addEventListener("securitypolicyviolation", (e) => {
      post({ type: "error", msg: `blocked by CSP: ${e.violatedDirective} ${e.blockedURI || ""}`.trim().slice(0, 500) });
    });
    post({ type: "rendered", version });
  }
  window.addEventListener("message", onMessage);
  post({ type: "ready" });
})();
