// canvas-frame.js — renders one canvas inside the sandboxed canvas-frame.html (ADR §3.2–§3.3).
//
// Runs in an opaque origin with no chrome.* APIs. It talks only to its parent (canvas.html):
//  in:  render{nonce, kind, version, content, normalizeText?}
//  in:  copied{reqId, ok}                 (reply to our copy request)
//  in:  edit{content, version}, saved{version, content}, requestSave, leaveEdit      (markdown editing, §3.5)
//  out: ready, rendered{version, normalized?}, error{msg}, openLink{url}, copy{reqId, text},
//       save{content, baseVersion}, dirty{dirty} — each carrying the nonce from our URL fragment,
//       which the host checks.
// Content goes through renderMarkdownInto (markdown-it + DOMPurify, the chat's sanitized sink).
// Links never navigate this frame: a capture-phase listener turns every click on <a>/<area> into
// openLink, and the host decides (http(s) only, user confirms, new tab).
(function () {
  "use strict";

  const nonce = location.hash.slice(1);
  const doc = document.getElementById("doc");
  const deck = document.getElementById("deck");
  const pic = document.getElementById("pic");
  const editorRoot = document.getElementById("editor");

  // --- Milkdown (§3.5), loaded on first use: normalizing an agent write, or the user's Edit. ---
  let milkdownLoad = null;
  function loadMilkdown() {
    if (!milkdownLoad) {
      milkdownLoad = new Promise((resolve, reject) => {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = "vendor/milkdown/crepe.css";
        document.head.appendChild(css);
        const s = document.createElement("script");
        s.src = "vendor/milkdown/crepe.iife.js";        // 'self' only (sandbox CSP + meta CSP)
        s.onload = () => (globalThis.KatashiroMilkdown ? resolve(globalThis.KatashiroMilkdown) : reject(new Error("editor failed to load")));
        s.onerror = () => reject(new Error("editor failed to load"));
        document.head.appendChild(s);
      });
    }
    return milkdownLoad;
  }

  // Features we do not use stay off: image upload / by-URL, LaTeX (fonts), CodeMirror (dynamic
  // language loading), AI and the top bar (§3.5).
  function crepeOptions(M, root, value) {
    const F = M.Crepe.Feature;
    return {
      root, defaultValue: value,
      features: { [F.ImageBlock]: false, [F.Latex]: false, [F.CodeMirror]: false, [F.AI]: false, [F.TopBar]: false },
    };
  }

  // Normalize with the parser + serializer of a hidden editor (never shown, never edited).
  let normalizer = null;
  async function normalize(text) {
    const M = await loadMilkdown();
    if (!normalizer) {
      const host = document.createElement("div");
      host.hidden = true;
      document.body.appendChild(host);
      const crepe = new M.Crepe(crepeOptions(M, host, ""));
      normalizer = crepe.create().then(() => crepe);
    }
    const crepe = await normalizer;
    return crepe.editor.action((ctx) => ctx.get(M.serializerCtx)(ctx.get(M.parserCtx)(text)));
  }

  // The editor. Dirty is measured against the text right after loading (already normalized), so
  // opening the editor never makes the canvas look changed; only Ctrl+S / Save sends save{}.
  let editing = null;                     // { crepe, version, baseline, dirty }
  async function startEdit(content, version) {
    const M = await loadMilkdown();
    doc.hidden = true;
    editorRoot.hidden = false;
    editorRoot.replaceChildren();
    const crepe = new M.Crepe(crepeOptions(M, editorRoot, content));
    await crepe.create();
    const state = { crepe, version, baseline: editorText(crepe), dirty: false };
    editing = state;
    crepe.on((listener) => listener.markdownUpdated((_ctx, md) => {
      if (editing !== state) return;
      const dirty = CanvasCore.cleanEditorMarkdown(md) !== state.baseline;
      if (dirty !== state.dirty) { state.dirty = dirty; post({ type: "dirty", dirty }); }
    }));
  }
  // The editor's markdown as stored: Milkdown's "<br />" empty-paragraph lines become blank lines.
  function editorText(crepe) {
    return CanvasCore.cleanEditorMarkdown(crepe.getMarkdown());
  }
  function requestSave() {
    if (!editing) return;
    post({ type: "save", content: editorText(editing.crepe), baseVersion: editing.version });
  }
  function stopEdit() {
    if (!editing) return;
    const { crepe } = editing;
    editing = null;
    try { crepe.destroy(); } catch (_) { /* already gone */ }
    editorRoot.replaceChildren();
    editorRoot.hidden = true;
    doc.hidden = false;
  }
  document.addEventListener("keydown", (e) => {
    if (editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); requestSave(); }
  });

  // markdown: the document view. A canvas never changes kind, so each frame shows one view.
  function renderMarkdown(content) {
    doc.hidden = false;
    // Older saves may still hold "<br />" lines; never show them as literal text.
    renderMarkdownInto(doc, CanvasCore.cleanEditorMarkdown(content), { copyText: copyViaHost });
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
    if (editing) return;                  // editing: a click places the cursor; nothing opens
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
    if (m.type === "edit") {
      startEdit(typeof m.content === "string" ? m.content : "", m.version)
        .catch((err) => { stopEdit(); post({ type: "error", msg: String((err && err.message) || err) }); });
      return;
    }
    if (m.type === "saved") {
      if (editing && Number.isInteger(m.version)) {
        editing.version = m.version;
        // The baseline is what was saved; text typed while the save was in flight stays dirty.
        if (typeof m.content === "string") editing.baseline = m.content;
        const dirty = editorText(editing.crepe) !== editing.baseline;
        if (dirty !== editing.dirty) { editing.dirty = dirty; post({ type: "dirty", dirty }); }
      }
      return;
    }
    if (m.type === "requestSave") { requestSave(); return; }
    if (m.type === "goto") {
      // canvas_goto: a slide number only (1-based), clamped to the deck.
      if (!revealReady || !Number.isInteger(m.slide)) return;
      revealReady.then(() => {
        const total = Reveal.getTotalSlides();
        const n = Math.min(Math.max(m.slide, 1), total);
        Reveal.slide(n - 1);
        post({ type: "slide", index: n, total });
      });
      return;
    }
    if (m.type === "leaveEdit") { stopEdit(); return; }
    if (m.type !== "render") return;
    if (editing) stopEdit();                // the host only re-renders a clean editor
    Promise.resolve().then(() => {
      if (m.kind === "markdown") return renderMarkdown(typeof m.content === "string" ? m.content : "");
      if (m.kind === "slides") return renderSlides(typeof m.content === "string" ? m.content : "");
      if (m.kind === "image") return renderImage(m.content);
      throw new Error(`unsupported kind: ${m.kind}`);
    }).then(async () => {
      // §3.5: the host asks for the normalized form of an agent markdown write (its agent copy).
      let normalized;
      if (m.kind === "markdown" && typeof m.normalizeText === "string") {
        try { normalized = CanvasCore.cleanEditorMarkdown(await normalize(m.normalizeText)); } catch (_) { /* stays unnormalized */ }
      }
      post(normalized === undefined ? { type: "rendered", version: m.version } : { type: "rendered", version: m.version, normalized });
    }, (err) => post({ type: "error", msg: String((err && err.message) || err) }));
  });

  post({ type: "ready" });
})();
