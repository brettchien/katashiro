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
  const deck = document.getElementById("deck");
  const pic = document.getElementById("pic");

  // markdown: the document view. A canvas never changes kind, so each frame shows one view.
  function renderMarkdown(content) {
    doc.hidden = false;
    renderMarkdownInto(doc, content, { copyText: copyViaHost });
  }

  // slides (ADR §3.3): split on "---" ourselves and render each slide through the chat's sanitized
  // markdown sink; reveal.js only receives finished <section>s (no reveal markdown plugin, which
  // would pass raw HTML through). Re-renders keep the current slide.
  let revealReady = null;
  function renderSlides(content) {
    deck.hidden = false;
    document.body.classList.add("mode-slides");
    const container = deck.querySelector(".slides");
    const sections = CanvasCore.splitSlides(content).map((text) => {
      const sec = document.createElement("section");
      renderMarkdownInto(sec, text, { copyText: copyViaHost });
      return sec;
    });
    container.replaceChildren(...sections);
    if (!revealReady) {
      revealReady = Reveal.initialize({
        hash: false, history: false, respondToHashChanges: false,
        postMessage: false, postMessageEvents: false,           // only our own message channel
        // Never the scroll view: in a narrow tab reveal would switch to it, which reads sessionStorage
        // (throws in our opaque origin, leaving the deck hidden) and re-parses the slides via innerHTML.
        view: null, scrollActivationWidth: null,
        controls: true, progress: true, slideNumber: "c/t", center: true,
        transition: "slide", width: 1280, height: 720, margin: 0.06,
      });
      return revealReady;
    }
    return revealReady.then(() => {
      const h = Reveal.getIndices().h || 0;
      Reveal.sync();
      Reveal.slide(Math.min(h, sections.length - 1));
    });
  }

  // image: a data: URL the host read from storage (checked again here), caption as text.
  function renderImage(content) {
    if (!content || !CanvasCore.isImageDataUrl(content.dataUrl)) throw new Error("not an image");
    pic.hidden = false;
    pic.querySelector("img").src = content.dataUrl;
    pic.querySelector("img").alt = content.caption || "image";
    pic.querySelector("figcaption").textContent = content.caption || "";
  }
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
    Promise.resolve().then(() => {
      if (m.kind === "markdown") return renderMarkdown(typeof m.content === "string" ? m.content : "");
      if (m.kind === "slides") return renderSlides(typeof m.content === "string" ? m.content : "");
      if (m.kind === "image") return renderImage(m.content);
      throw new Error(`unsupported kind: ${m.kind}`);
    }).then(
      () => post({ type: "rendered", version: m.version }),
      (err) => post({ type: "error", msg: String((err && err.message) || err) })
    );
  });

  post({ type: "ready" });
})();
