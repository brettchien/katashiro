// canvas-frame.js — renders one canvas inside the sandboxed canvas-frame.html (ADR §3.2–§3.3).
//
// Runs in an opaque origin with no chrome.* APIs. It talks only to its parent (canvas.html):
//  in:  render{nonce, kind, version, content}
//  in:  copied{reqId, ok}                 (reply to our copy request)
//  out: ready, rendered{version}, error{msg}, openLink{url}, copy{reqId, text} — each carrying the nonce from our
//       URL fragment, which the host checks.
// Content goes through renderMarkdownInto (markdown-it + DOMPurify, the chat's sanitized sink).
// Links never navigate this frame: a capture-phase listener turns every click on <a>/<area> into
// openLink, and the host decides (http(s) only, user confirms, new tab).
(function () {
  "use strict";

  const nonce = location.hash.slice(1);
  const doc = document.getElementById("doc");
  const post = (msg) => window.parent.postMessage({ ...msg, nonce }, "*");

  // Copy goes through the host (#69): this opaque-origin frame has no clipboard access.
  let nextReq = 1;
  const pendingCopies = new Map();
  function copyViaHost(text) {
    return new Promise((resolve, reject) => {
      const reqId = nextReq++;
      pendingCopies.set(reqId, (ok) => (ok ? resolve() : reject(new Error("copy failed"))));
      setTimeout(() => { if (pendingCopies.delete(reqId)) reject(new Error("copy timed out")); }, 5000);
      post({ type: "copy", reqId, text });
    });
  }

  function onLinkClick(e) {
    const a = e.target && e.target.closest ? e.target.closest("a, area") : null;
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) {
      // In-document anchor: scroll without navigating (a fragment change is not a load anyway).
      const target = href.length > 1 && document.getElementById(decodeURIComponent(href.slice(1)));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (href) post({ type: "openLink", url: a.href || href });
  }
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("auxclick", onLinkClick, true);   // middle click

  // A library that hits a blocked eval / fetch fails visibly, not silently (§3.2).
  document.addEventListener("securitypolicyviolation", (e) => {
    post({ type: "error", msg: `blocked by CSP: ${e.violatedDirective} ${e.blockedURI || ""}`.trim() });
  });

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.nonce !== nonce) return;
    if (m.type === "copied") {
      const done = pendingCopies.get(m.reqId);
      if (done) { pendingCopies.delete(m.reqId); done(m.ok === true); }
      return;
    }
    if (m.type !== "render") return;
    try {
      if (m.kind !== "markdown") throw new Error(`unsupported kind: ${m.kind}`);
      renderMarkdownInto(doc, typeof m.content === "string" ? m.content : "", { copyText: copyViaHost });
      post({ type: "rendered", version: m.version });
    } catch (err) {
      post({ type: "error", msg: String((err && err.message) || err) });
    }
  });

  post({ type: "ready" });
})();
