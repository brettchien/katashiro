// canvas-frame.js — renders one canvas inside the sandboxed canvas-frame.html (ADR §3.2–§3.3).
//
// Runs in an opaque origin with no chrome.* APIs. It talks only to its parent (canvas.html):
//  in:  render{nonce, kind, version, content, normalizeText?}
//  in:  copied{reqId, ok}                 (reply to our copy request)
//  in:  edit{content, version}, saved{version, content}, requestSave, leaveEdit      (markdown editing, §3.5)
//  in:  render{…, glowPrev?, glowAgainst?}, glow{against}, highlight{reqId, find|heading, label,
//       durationMs, check?}                                                (showing what changed, §3.10)
//  out: ready, rendered{version, normalized?}, error{msg}, openLink{url}, copy{reqId, text},
//       save{content, baseVersion}, dirty{dirty}, highlighted{reqId, ok, tag?, text?, slide?, error?}
//       — each carrying the nonce from our URL fragment, which the host checks.
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
    // #89: the editor must not open on a text it would lose images from — saving would store that.
    if (CanvasCore.losesImages(content, editorText(crepe))) {
      try { crepe.destroy(); } catch (_) { /* already gone */ }
      throw new Error("the editor would drop images from this canvas, so editing is off for it");
    }
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
  // Also after a failed startEdit (no `editing` yet): the document view comes back either way.
  function stopEdit() {
    if (editing) {
      const { crepe } = editing;
      editing = null;
      try { crepe.destroy(); } catch (_) { /* already gone */ }
    }
    editorRoot.replaceChildren();
    editorRoot.hidden = true;
    doc.hidden = false;
  }
  document.addEventListener("keydown", (e) => {
    if (editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); requestSave(); }
    // Esc leaves edit mode (the host asks first if there are unsaved changes) — unless one of the
    // editor's own popups is open (slash menu, link or selection toolbar), which Esc closes first.
    // This also matches a table's row/column handle while the pointer rests on the table, so Esc
    // does nothing there; move the pointer off the table and it works.
    // It carries the dirty state as of now: "dirty" is only posted after Milkdown's 200ms debounce,
    // so text typed just before Esc would otherwise be dropped without asking.
    if (editing && e.key === "Escape" && !e.defaultPrevented && !e.isComposing &&
      !editorRoot.querySelector('[data-show="true"]')) {
      e.preventDefault();
      editing.dirty = editorText(editing.crepe) !== editing.baseline;
      post({ type: "escape", dirty: editing.dirty });
    }
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

  // --- Showing what changed (§3.10) ---------------------------------------------------------
  // Blocks: paragraph, heading, list item, table row, code block, rule, image. A block's text is its
  // own text (words inside a nested block belong to that block), so a loose list item is its
  // paragraph and a tight one keeps its words without its sub-list. Keys carry the tag, so h2 → h3
  // counts as a change. Our own notes and copy buttons are not content.
  const BLOCK_SEL = "h1,h2,h3,h4,h5,h6,p,li,tr,pre,hr,img";
  function blocksOf(root) {
    const els = Array.from(root.querySelectorAll(BLOCK_SEL)).filter((el) => !el.closest(".ks-note"));
    const at = new Map(els.map((el, i) => [el, i]));
    const texts = els.map(() => "");
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest(".copy-btn, .ks-note")) continue;
      const b = p.closest(BLOCK_SEL);
      if (b && at.has(b)) texts[at.get(b)] += n.data;
    }
    const out = [];
    els.forEach((el, i) => {
      const tag = el.tagName.toLowerCase();
      const text = CanvasCore.normText(texts[i]);
      if (!text && tag !== "hr" && tag !== "img") return;
      const key = tag === "img" ? `img:${el.getAttribute("src") || ""}:${el.getAttribute("alt") || ""}` : `${tag}:${text}`;
      out.push({ el, tag, text, key, heading: /^h[1-6]$/.test(tag) });
    });
    return out;
  }
  // What glows: blocks of a document, whole slides of a deck (§3.10 "… table row, slide").
  const slideSections = () => Array.from(deck.querySelectorAll(".slides > section"));
  const sectionUnit = (sec) => ({ el: sec, key: blocksOf(sec).map((b) => b.key).join("\n") });
  function shownUnits() {
    if (shownKind === "slides") return slideSections().map(sectionUnit);
    if (shownKind === "markdown") return blocksOf(doc);
    return [];
  }
  // Another text's units (the other side of a compare), rendered detached through the same sink.
  function unitsOfText(kind, text) {
    if (kind === "slides") {
      return CanvasCore.splitSlides(text).map((t) => {
        const sec = document.createElement("section");
        renderMarkdownInto(sec, t, { copyText: copyViaHost });
        return sectionUnit(sec);
      });
    }
    const art = document.createElement("article");
    renderMarkdownInto(art, CanvasCore.cleanEditorMarkdown(text), { copyText: copyViaHost });
    return blocksOf(art);
  }

  const GLOW_MS = 4000;
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  // One timer per element and effect: a newer glow restarts it instead of being cut short by an old one.
  const markTimers = new WeakMap();
  // ms = Infinity: held (no fade, no timer) — while a compare is open (Brett, 2026-10-11), until
  // clearHeld().
  function mark(el, cls, ms) {
    let timers = markTimers.get(el);
    if (!timers) markTimers.set(el, (timers = new Map()));
    clearTimeout(timers.get(cls));
    el.classList.remove(cls);
    if (ms === Infinity) { el.classList.add("ks-hold", cls); timers.delete(cls); return; }
    void el.offsetWidth;                          // restart the fade
    el.style.setProperty("--ks-ms", `${Math.round(ms)}ms`);
    el.classList.add(cls);
    timers.set(cls, setTimeout(() => { el.classList.remove(cls); timers.delete(cls); }, ms));
  }
  const MARK_CLASSES = ["ks-changed", "ks-removed-before", "ks-removed-after"];
  function clearHeld() {
    for (const el of document.querySelectorAll(".ks-hold")) el.classList.remove("ks-hold", ...MARK_CLASSES);
  }
  // New or changed blocks glow; a removed block leaves a thin marker on its neighbour (on a row's
  // cells: a table row draws no shadow of its own).
  function glowDiff(units, against, ms) {
    if (!units.length || ms <= 0) return;
    const d = CanvasCore.diffBlocks(against, units.map((u) => u.key));
    for (const i of d.changed) if (units[i]) mark(units[i].el, "ks-changed", ms);
    for (const i of d.removedAt) {
      const el = i < units.length ? units[i].el : units[units.length - 1].el;
      const cls = i < units.length ? "ks-removed-before" : "ks-removed-after";
      for (const t of el.tagName === "TR" ? Array.from(el.cells) : [el]) mark(t, cls, ms);
    }
  }

  let shownKind = "";
  let lastKeys = null;                    // the previous render's keys: what an agent write is compared with
  let glowMemo = null;                    // { version, before, until }: a same-version re-render keeps its glow
  function showChanges(m) {
    const units = shownUnits();
    const keys = units.map((u) => u.key);
    const before = lastKeys;
    lastKeys = keys;
    if (!units.length) return;
    if (typeof m.glowAgainst === "string") { glowDiff(units, unitsOfText(m.kind, m.glowAgainst).map((u) => u.key), m.glowHold === true ? Infinity : GLOW_MS); return; }
    if (m.glowPrev && before) {
      glowMemo = { version: m.version, before, until: Date.now() + GLOW_MS };
      glowDiff(units, before, GLOW_MS);
      return;
    }
    // §3.5 normalization re-renders the same agent version moments later: keep its glow going.
    if (glowMemo && glowMemo.version === m.version && Date.now() < glowMemo.until) glowDiff(units, glowMemo.before, glowMemo.until - Date.now());
  }

  // canvas_highlight (§3.10): find the block by its rendered text, glow it (outline and background
  // only), put the agent's label in the flow just above it, and bring it into view. `check` (the
  // user is editing) only answers whether the anchor matches; nothing moves.
  const NOTE_MAX = 80;
  function placeNote(el, label, ms) {
    const note = document.createElement("div");
    note.className = "ks-note";
    note.setAttribute("role", "note");
    const icon = document.createElement("span");
    icon.textContent = "🤖";
    const who = document.createElement("b");
    who.textContent = "Agent:";
    const text = document.createElement("span");
    text.textContent = label;                      // agent text: textContent only
    note.append(icon, who, text);
    // Never over text: before the table for a row, at the top inside a list item, else right above.
    if (el.tagName === "TR") (el.closest("table") || el).before(note);
    else if (el.tagName === "LI") el.prepend(note);
    else el.before(note);
    setTimeout(() => note.remove(), ms);
  }
  function highlight(m) {
    const reply = (r) => post({ type: "highlighted", reqId: m.reqId, ...r });
    if (shownKind !== "markdown" && shownKind !== "slides") { reply({ ok: false, error: "this canvas shows nothing to point at" }); return; }
    if (editing && !m.check) { reply({ ok: false, error: "the user is editing this canvas" }); return; }
    const blocks = blocksOf(shownKind === "slides" ? deck : doc);
    const r = CanvasCore.matchBlock(blocks, typeof m.heading === "string" ? { heading: m.heading } : { find: m.find });
    if (r.error) { reply({ ok: false, error: CanvasCore.clipError(r.error) }); return; }
    const b = blocks[r.index];
    const info = { ok: true, tag: b.tag, text: Array.from(b.text).slice(0, 90).join("") };
    if (shownKind === "slides") {
      const s = slideSections().indexOf(b.el.closest(".slides > section"));
      if (s >= 0) info.slide = s + 1;
    }
    if (m.check) { reply(info); return; }
    const ms = Math.min(Math.max(Number(m.durationMs) || 4000, 500), 10000);
    const label = typeof m.label === "string" ? Array.from(m.label.trim()).slice(0, NOTE_MAX).join("") : "";
    const show = () => {
      if (!b.el.isConnected) { reply({ ok: false, error: "the canvas re-rendered meanwhile; try again" }); return; }
      mark(b.el, "ks-point", ms);
      if (label) placeNote(b.el, label, ms);
      // A deck is moved by reveal, not by scrolling (scrolling its clipped viewport breaks the layout).
      if (shownKind !== "slides") b.el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      reply(info);
    };
    if (shownKind === "slides" && info.slide && revealReady) {
      revealReady.then(() => { Reveal.slide(info.slide - 1); show(); }, (e) => reply({ ok: false, error: CanvasCore.clipError(`the slides failed: ${(e && e.message) || e}`) }));
    } else {
      show();
    }
  }

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
        .catch((err) => { stopEdit(); post({ type: "editFailed", msg: String((err && err.message) || err) }); });
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
    if (m.type === "print") {
      // PDF export (§3.8): print this frame's document (needs allow-modals). Slides arrive here in
      // reveal's print-pdf layout; give it a moment to lay the pages out.
      setTimeout(() => { try { window.print(); } finally { post({ type: "printed" }); } }, deck.hidden ? 50 : 800);
      return;
    }
    if (m.type === "goto") {
      // canvas_goto: a slide number only (1-based), clamped to the deck.
      // Always answers (slide or error) so the host's pending goto never waits on us.
      if (!revealReady || !Number.isInteger(m.slide)) { post({ type: "error", msg: "goto: the slides are not shown" }); return; }
      revealReady.then(() => {
        const total = Reveal.getTotalSlides();
        const n = Math.min(Math.max(m.slide, 1), total);
        Reveal.slide(n - 1);
        post({ type: "slide", index: n, total });
      }).catch((e) => post({ type: "error", msg: `goto: ${(e && e.message) || e}` }));
      return;
    }
    if (m.type === "leaveEdit") { stopEdit(); return; }
    if (m.type === "highlight") { if (Number.isInteger(m.reqId)) highlight(m); return; }
    if (m.type === "glow") {
      // Compare started (§3.10): glow the blocks that differ from the other side.
      // hold: kept until the compare ends (glow{clear}); clear: drop held markers.
      clearHeld();
      if (m.clear === true) return;
      if (!editing && typeof m.against === "string" && (shownKind === "markdown" || shownKind === "slides")) glowDiff(shownUnits(), unitsOfText(shownKind, m.against).map((u) => u.key), m.hold === true ? Infinity : GLOW_MS);
      return;
    }
    if (m.type !== "render") return;
    if (editing) stopEdit();                // the host only re-renders a clean editor
    shownKind = m.kind;
    Promise.resolve().then(() => {
      if (m.kind === "markdown") return renderMarkdown(typeof m.content === "string" ? m.content : "");
      if (m.kind === "slides") return renderSlides(typeof m.content === "string" ? m.content : "");
      if (m.kind === "image") return renderImage(m.content);
      throw new Error(`unsupported kind: ${m.kind}`);
    }).then(async () => {
      try { showChanges(m); } catch (_) { /* the glow is a nicety; the render stands */ }
      // §3.5: the host asks for the normalized form of an agent markdown write (its agent copy).
      let normalized;
      if (m.kind === "markdown" && typeof m.normalizeText === "string") {
        try { normalized = CanvasCore.cleanEditorMarkdown(await normalize(m.normalizeText)); } catch (_) { /* stays unnormalized */ }
        // #86: never store a normalization that lost an image; the agent's text stays as written.
        if (normalized !== undefined && CanvasCore.losesImages(m.normalizeText, normalized)) normalized = undefined;
      }
      post(normalized === undefined ? { type: "rendered", version: m.version } : { type: "rendered", version: m.version, normalized });
    }, (err) => post({ type: "error", msg: String((err && err.message) || err) }));
  });

  post({ type: "ready" });
})();
