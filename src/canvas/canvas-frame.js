// canvas-frame.js — renders one canvas inside the sandboxed canvas-frame.html (ADR §3.2–§3.3).
//
// Runs in an opaque origin with no chrome.* APIs. It talks only to its parent (canvas.html):
//  in:  render{nonce, kind, version, seq, content, normalizeText?}
//  in:  copied{reqId, ok}                 (reply to our copy request)
//  in:  edit{content, version}, saved{version, content}, requestSave, leaveEdit      (markdown editing, §3.5)
//  in:  editCmd{cmd: "undo" | "redo"}       (the editor's own history: the edit-mode ↶ / ↷, §3.5)
//  in:  render{…, glowPrev?, glowRanges?, glowAgainst?}, glow{against}, highlight{reqId, find|heading, label,
//       durationMs, check?}                                                (showing what changed, §3.10)
//  in:  css{sheets}                          (canvas_inject_css: the agent's sheets, all of them; [] clears)
//  out: ready, rendered{version, seq, normalized?}, error{msg, seq?}, openLink{url}, copy{reqId, text},
//       save{content, baseVersion}, dirty{dirty}, undoState{canUndo, canRedo}, highlighted{reqId, ok, tag?, text?, slide?, error?},
//       selection{text, seq, truncated?, rect?, where?}, selectionRect{seq, rect?} (Ask agent, §3.7; rect places the host's 💬,
//                                                        where{headings?, lines?, slide?} says where it is)
//       diagramError{msg, seq}                              (a mermaid diagram that failed, §3.3)
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
  let editing = null;                     // { crepe, version, baseline, dirty, undo }
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
    const state = { crepe, version, baseline: editorText(crepe), dirty: false, undo: null };
    editing = state;
    syncAgentCss();
    crepe.on((listener) => listener.markdownUpdated((_ctx, md) => {
      if (editing !== state) return;
      const dirty = CanvasCore.cleanEditorMarkdown(md) !== state.baseline;
      if (dirty !== state.dirty) { state.dirty = dirty; post({ type: "dirty", dirty }); }
      postUndoState(state);
    }));
    postUndoState(state);                 // loading the canvas is not a step: nothing to undo yet
  }

  // --- Undo / redo: the editor's own history (§3.5, Brett 2026-10-11: "just use editor's undo/redo").
  // prosemirror-history's commands and depths, the module crepe's history plugin uses (vendor bundle),
  // so the host's ↶ / ↷ and Ctrl/⌘+Z in the editor walk the same stack. Agent writes are never on it.
  function withView(state, fn) {
    return state.crepe.editor.action((ctx) => fn(ctx.get("editorView")));   // by slice name, as in showSaved
  }
  // undoState{} for the host's buttons, posted only when it changed. Called after every doc change
  // (markdownUpdated), a host command, and a key / pointer release in the editor (an undo that
  // lands back on the text of 200 ms ago fires no markdownUpdated).
  function postUndoState(state) {
    if (!state || editing !== state) return;
    const M = globalThis.KatashiroMilkdown;
    let u;
    try { u = withView(state, (view) => ({ canUndo: M.undoDepth(view.state) > 0, canRedo: M.redoDepth(view.state) > 0 })); }
    catch (_) { return; }                 // the editor is being torn down
    if (state.undo && state.undo.canUndo === u.canUndo && state.undo.canRedo === u.canRedo) return;
    state.undo = u;
    post({ type: "undoState", ...u });
  }
  function runEditCmd(cmd) {
    const state = editing;
    if (!state || !CanvasCore.isEditCmd(cmd)) return;
    const M = globalThis.KatashiroMilkdown;
    try {
      withView(state, (view) => {
        (cmd === "undo" ? M.undo : M.redo)(view.state, view.dispatch);
        view.focus();                         // the host focused this frame; put the caret back in the editor
      });
    } catch (_) { /* nothing to undo, or the editor is gone */ }
    postUndoState(state);
  }
  const undoStateSoon = () => { const state = editing; if (state) setTimeout(() => postUndoState(state), 0); };
  editorRoot.addEventListener("keyup", undoStateSoon);
  editorRoot.addEventListener("pointerup", undoStateSoon);
  // The editor's markdown as stored: Milkdown's "<br />" empty-paragraph lines become blank lines.
  function editorText(crepe) {
    return CanvasCore.cleanEditorMarkdown(crepe.getMarkdown());
  }
  function requestSave() {
    if (!editing) return;
    const raw = editing.crepe.getMarkdown();
    const content = CanvasCore.cleanEditorMarkdown(raw);
    // droppedBlank: cleaning removed empty paragraphs, so an "unchanged" reply can say why.
    post({ type: "save", content, baseVersion: editing.version, droppedBlank: content !== raw });
  }
  // #103: a save drops the empty paragraphs markdown cannot keep (cleanEditorMarkdown), but the
  // editor still showed them, so "沒有內容變更" looked like a failed save. After a save, an editor
  // that holds exactly the saved text plus such paragraphs is reset to the saved text. Not when the
  // user typed while the save was in flight (that text is not saved yet). The cursor stays where it
  // was. Best effort: on any failure the editor just keeps showing the blank lines.
  // Trailing spaces at a block's end are dropped too, but alone they are invisible: no reset then
  // (it would eat a space typed just before the next word); with blank lines, they go as well.
  function showSaved(crepe, saved) {
    try {
      const raw = crepe.getMarkdown();
      if (raw === saved || CanvasCore.cleanEditorMarkdown(raw) !== saved || CanvasCore.onlyTrailingSpace(raw, saved)) return;
      crepe.editor.action((ctx) => {
        const M = globalThis.KatashiroMilkdown;
        const view = ctx.get("editorView");          // by slice name: the bundle does not export editorViewCtx
        const doc = ctx.get(M.parserCtx)(saved);
        if (!doc) return;
        // Only empty paragraphs and block-end spaces go, so the text before the cursor is the same
        // less those spaces: put the cursor back after as many characters (a position would shift
        // by the paragraphs removed before it).
        // A cursor at the start of a paragraph has the same count as one at the end of the text
        // before it; it stays at the start (#115 review).
        const { state } = view;
        const { $from } = state.selection;
        const SEP = "\u0001";                         // between blocks; never in the text
        const offset = CanvasCore.savedTextOffset(state.doc.textBetween(0, state.selection.from, SEP, ""), SEP,
          $from.parentOffset === $from.parent.content.size);
        const atStart = $from.parentOffset === 0;
        const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
        const Sel = state.selection.constructor;   // near() is Selection's, inherited by every kind
        tr.setSelection(Sel.near(tr.doc.resolve(posAtTextOffset(tr.doc, offset, atStart))));
        // Not an edit of the user's: undo must not step into it (it would bring the blank lines back).
        tr.setMeta("addToHistory", false);
        view.dispatch(tr);
      });
    } catch (_) { /* keeps the blank lines on screen; the saved text is right either way */ }
  }
  // The document position after the first `n` characters of text (CanvasCore.posAtTextOffset).
  function posAtTextOffset(doc, n, atStart) {
    const runs = [];
    doc.descendants((node, p) => {
      if (!node.isText) return true;
      runs.push({ pos: p, len: node.text.length });
      return false;
    });
    const pos = CanvasCore.posAtTextOffset(runs, n, atStart);
    return pos === null ? doc.content.size : pos;
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
    syncAgentCss();
  }

  // canvas_inject_css: the agent's sheets in one <style> of our own (style-src 'unsafe-inline';
  // nothing in them can fetch: connect-src / img-src / font-src stay closed). Off while the user
  // edits, so the editor always looks like itself.
  let agentCss = null;
  function setAgentCss(sheets) {
    const text = Array.isArray(sheets) ? sheets.filter((s) => typeof s === "string").join("\n") : "";
    if (!text) { if (agentCss) agentCss.remove(); agentCss = null; return; }
    if (!agentCss) { agentCss = document.createElement("style"); agentCss.id = "ks-agent-css"; }
    agentCss.textContent = text;
    document.head.appendChild(agentCss);          // last, so it wins ties with the canvas's own CSS
    syncAgentCss();
  }
  function syncAgentCss() { if (agentCss) agentCss.disabled = !!editing; }
  // Crepe's popups that close on Esc themselves (vendored crepe): the slash menu and the link editor.
  // The selection toolbar and the link preview have no Esc handler, so they must not hold Esc back.
  const EDITOR_POPUPS = [".milkdown-slash-menu", ".milkdown-link-edit"].map((c) => `${c}[data-show="true"]`).join(", ");
  document.addEventListener("keydown", (e) => {
    if (editing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); requestSave(); }
  });
  // Esc leaves edit mode (the host asks first if there are unsaved changes) — unless one of the
  // editor's own popups is open (EDITOR_POPUPS), which Esc closes first, or an IME composition is
  // in progress. The slash menu handles Esc in a window capture listener (it runs first and calls
  // preventDefault); the link editor on its input, after us, so it is checked as shown.
  // Document capture phase, ahead of the editor (#104): ProseMirror's base keymap binds Esc to
  // selectParentNode, which took every Esc inside a table (cell → row → table) and the first one
  // anywhere else. Only real popups count: hover handles (a block's drag handle, a table's row /
  // column handles) are data-show too while the pointer rests on them.
  // It carries the dirty state as of now: "dirty" is only posted after Milkdown's 200ms debounce,
  // so text typed just before Esc would otherwise be dropped without asking.
  document.addEventListener("keydown", (e) => {
    if (!editing || e.key !== "Escape" || e.defaultPrevented || CanvasCore.imeKey(e) || editorRoot.querySelector(EDITOR_POPUPS)) return;
    e.preventDefault();
    e.stopPropagation();                  // not selectParentNode as well
    editing.dirty = editorText(editing.crepe) !== editing.baseline;
    post({ type: "escape", dirty: editing.dirty });
  }, true);

  // --- Mermaid (§3.3), loaded on first use: a ```mermaid fence in a markdown / slides canvas, or a
  // mermaid canvas — 2.7 MB, so a canvas without a diagram never loads it. @mermaid-js/tiny has no
  // ELK: it lays out with dagre on this thread, so worker-src 'none' costs nothing (smoke test,
  // scripts/smoke-mermaid.mjs). securityLevel 'strict': labels are sanitized and `click` callbacks
  // are off; a `click X "url"` link is still drawn as an SVG <a>, which onLinkClick turns into openLink.
  let mermaidLoad = null;
  function loadMermaid() {
    if (!mermaidLoad) {
      mermaidLoad = new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "vendor/mermaid/mermaid.tiny.js";       // 'self' only (sandbox CSP + meta CSP)
        s.onload = () => (globalThis.mermaid ? resolve(globalThis.mermaid) : reject(new Error("mermaid failed to load")));
        s.onerror = () => reject(new Error("mermaid failed to load"));
        document.head.appendChild(s);
      });
      mermaidLoad.catch(() => { mermaidLoad = null; });   // a later render may try again
    }
    return mermaidLoad;
  }
  // Dark like the canvas; a printed document re-renders its diagrams with the light theme. A deck
  // prints on its own dark slides (reveal's print-pdf layout), so it stays dark.
  const PRINT_THEME = "default", SCREEN_THEME = "dark";
  // Mermaid scopes this under the diagram's id, after its own rules: SVG-text labels (rect) and
  // HTML ones (a directive can turn htmlLabels on) alike.
  const PRINT_EDGE_LABEL_CSS = ".edgeLabel rect, .edgeLabel .label rect { opacity: 1; fill: #ffffff; } " +
    ".edgeLabel, .edgeLabel p, .labelBkg { background-color: #ffffff; }";
  let mermaidTheme = "";
  let mermaidQueue = Promise.resolve();    // one render at a time: mermaid's config is global
  let diagramSeq = 0;
  function renderDiagram(M, source, theme) {
    const run = mermaidQueue.then(async () => {
      if (theme !== mermaidTheme) {
        M.initialize({
          startOnLoad: false, securityLevel: "strict", theme,
          // dagre is the only layout in mermaid-tiny; say so, rather than ask for ELK and get a warning.
          layout: "dagre", state: { layout: "dagre" },
          // SVG text labels by default: they take the canvas font and print the same.
          htmlLabels: false,
          suppressErrorRendering: true,   // throw instead of drawing mermaid's own error graphic
          fontFamily: getComputedStyle(document.body).fontFamily,
          // Paper: edge labels on solid white. Mermaid draws their background at half opacity, so on
          // the light theme the edge line runs visibly through the text (reads as struck through).
          ...(theme === PRINT_THEME ? { themeVariables: { edgeLabelBackground: "#ffffff" }, themeCSS: PRINT_EDGE_LABEL_CSS } : {}),
        });
        mermaidTheme = theme;
      }
      // A fresh id per render: mermaid scopes the diagram's <style> to it, and removes its temp node.
      const { svg } = await M.render(`ks-mmd-${++diagramSeq}`, source);
      return svg;
    });
    mermaidQueue = run.catch(() => {});
    return run;
  }
  // Mermaid's SVG goes through DOMPurify too, as a second check behind its 'strict' sanitizing; the
  // frame's meta CSP blocks script either way. <foreignObject> with HTML in it is kept: some labels
  // are drawn that way whatever htmlLabels says (journey tasks, venn text, and htmlLabels can be
  // turned on by a directive), and dropping them would blank those labels without an error. The
  // HTML inside is held to the html profile, like the markdown sink's; DOMPurify drops HTML under
  // SVG unless the SVG parent is an integration point, so foreignObject is made one (as mermaid does).
  const SVG_DP = {
    USE_PROFILES: { svg: true, svgFilters: true, html: true }, ADD_TAGS: ["foreignObject"],
    HTML_INTEGRATION_POINTS: { foreignobject: true }, SANITIZE_DOM: true, RETURN_DOM_FRAGMENT: true,
  };
  // Links: markdown.js's global afterSanitizeAttributes hook also runs here, so an HTML <a> in a
  // foreignObject gets its scheme check. It matches nodeName "A" only, and an SVG <a> is "a": that
  // one relies on DOMPurify's own URI filter, and on the host's safeLinkUrl + confirm on openLink.
  const diagramSource = new WeakMap();    // <figure class="ks-mermaid"> → its mermaid source
  function setDiagramSvg(fig, svg) {
    let box = fig.querySelector(":scope > .ks-mermaid-svg");
    if (!box) { box = document.createElement("div"); box.className = "ks-mermaid-svg"; fig.prepend(box); }
    // The sanitized nodes themselves, not a string parsed again: svg / html / foreignObject nesting
    // is where a re-parse could differ from what DOMPurify checked (mXSS). Replaces the old SVG and
    // its <style>.
    box.replaceChildren(DOMPurify.sanitize(svg, SVG_DP));
  }
  function diagramFigure(source, svg) {
    const fig = document.createElement("figure");
    fig.className = "ks-mermaid";
    diagramSource.set(fig, source);
    setDiagramSvg(fig, svg);
    // The copy button copies the diagram's source (through the host, like a code block's).
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.type = "button";
    btn.textContent = "copy";
    btn.title = "複製 Mermaid 原始碼";
    btn.addEventListener("click", () => {
      const flash = (label) => { btn.textContent = label; setTimeout(() => (btn.textContent = "copy"), 1200); };
      copyViaHost(source).then(() => flash("copied"), () => flash("failed"));
    });
    fig.appendChild(btn);
    return fig;
  }
  // Render every ```mermaid fence under root in place. A bad diagram keeps its source, shows the
  // error above it (textContent) and is reported as diagramError{}; the rest of the canvas stands.
  // `gen` is the render it belongs to: a newer render makes it stop. `seq` (the host's render number,
  // #96) goes with the report, so the host can tell it from an older render's.
  let renderGen = 0;
  function diagramNote(pre, msg) {
    const note = document.createElement("div");
    note.className = "ks-mermaid-error";
    note.setAttribute("role", "note");
    note.textContent = msg;                         // mermaid's message quotes agent text: textContent only
    pre.before(note);
  }
  async function renderDiagrams(root, kind, gen, seq, theme) {
    if (!CanvasCore.wantsMermaid(kind, root)) return;
    const codes = Array.from(root.querySelectorAll(CanvasCore.MERMAID_SEL));
    if (!codes.length) return;
    let M;
    try { M = await loadMermaid(); } catch (e) {
      if (gen !== renderGen) return;
      // Not one diagram's fault: every fence stays source, each saying so.
      const msg = CanvasCore.diagramErrorText(e);
      for (const code of codes) diagramNote(code.parentElement, msg);
      post({ type: "diagramError", msg, seq });
      return;
    }
    const errors = [];
    for (const [i, code] of codes.entries()) {
      const pre = code.parentElement;
      const source = code.textContent;
      let svg, err;
      try { svg = await renderDiagram(M, source, theme); } catch (e) { err = e; }
      if (gen !== renderGen) return;
      if (svg !== undefined) {
        const fig = diagramFigure(source, svg);
        for (const a of ["data-line-start", "data-line-end"]) if (pre.hasAttribute(a)) fig.setAttribute(a, pre.getAttribute(a));
        pre.replaceWith(fig);
        continue;
      }
      const msg = CanvasCore.diagramErrorText(err, i + 1);
      diagramNote(pre, msg);
      errors.push(msg);
    }
    if (errors.length) post({ type: "diagramError", msg: CanvasCore.clipError(errors.join("\n\n")), seq });
  }
  // Print (§3.8): the rendered diagrams again with another theme, in place (same figures, so glow
  // and highlight state stay). Failures keep the old SVG.
  async function rethemeDiagrams(root, theme) {
    const figs = Array.from(root.querySelectorAll("figure.ks-mermaid"));
    if (!figs.length) return;
    const M = await loadMermaid();
    for (const fig of figs) {
      try { setDiagramSvg(fig, await renderDiagram(M, diagramSource.get(fig) || "", theme)); } catch (_) { /* keeps the old one */ }
    }
  }

  // What the view shows, as stored, for Ask agent's source lines (§3.7): the render's text, the
  // document view's line map (rendered line → stored line) and each slide's first line.
  let shownSource = null;                 // { stored, map?, slideLines? }

  // markdown: the document view. A canvas never changes kind, so each frame shows one view.
  function renderMarkdown(content, gen, seq) {
    doc.hidden = false;
    // Older saves may still hold "<br />" lines; never show them as literal text. The cleaning only
    // drops or trims lines, so its map takes a block's rendered lines back to the stored ones.
    const clean = CanvasCore.cleanEditorMarkdownMap(content);
    shownSource = { stored: content, map: clean.lines };
    renderMarkdownInto(doc, clean.text, { copyText: copyViaHost, sourceLines: true });
    return renderDiagrams(doc, "markdown", gen, seq, SCREEN_THEME);
  }

  // mermaid: the whole canvas is one diagram, shown like a lone ```mermaid fence (so a syntax error
  // shows the source with the error, as in a document).
  function renderMermaidCanvas(content, gen, seq) {
    doc.hidden = false;
    document.body.classList.add("mode-mermaid");
    const pre = document.createElement("pre");
    pre.className = "hljs";
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = content;
    pre.appendChild(code);
    doc.replaceChildren(pre);
    return renderDiagrams(doc, "mermaid", gen, seq, SCREEN_THEME);
  }

  // slides (ADR §3.3): split on "---" ourselves and render each slide through the chat's sanitized
  // markdown sink; reveal.js only receives finished <section>s (no reveal markdown plugin, which
  // would pass raw HTML through). Re-renders keep the current slide.
  let revealReady = null;
  async function renderSlides(content, gen, seq) {
    deck.hidden = false;
    document.body.classList.add("mode-slides");
    const container = deck.querySelector(".slides");
    const slides = CanvasCore.splitSlidesAt(content);
    shownSource = { stored: content, slideLines: slides.map((s) => s.line) };
    const sections = slides.map(({ text }) => {
      const sec = document.createElement("section");
      renderMarkdownInto(sec, text, { copyText: copyViaHost, sourceLines: true });
      return sec;
    });
    container.replaceChildren(...sections);
    // Diagrams before reveal lays the deck out (it sizes slides by their content).
    await renderDiagrams(container, "slides", gen, seq, SCREEN_THEME);
    if (gen !== renderGen) return undefined;
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
  // A mermaid diagram is one block keyed by its source (CanvasCore.mermaidKey): its SVG text is not
  // content, and a failed or not yet rendered fence has the same key as the diagram.
  const BLOCK_SEL = "h1,h2,h3,h4,h5,h6,p,li,tr,pre,hr,img,figure.ks-mermaid";
  function blocksOf(root) {
    const els = Array.from(root.querySelectorAll(BLOCK_SEL))
      .filter((el) => !el.closest(".ks-note, .ks-mermaid-error") && (el.closest(".ks-mermaid") || el) === el);
    const at = new Map(els.map((el, i) => [el, i]));
    const texts = els.map(() => "");
    const nodes = els.map(() => []);
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const p = n.parentElement;
      if (!p || p.closest(".copy-btn, .ks-note, .ks-mermaid, .ks-mermaid-error")) continue;
      const b = p.closest(BLOCK_SEL);
      if (b && at.has(b)) { texts[at.get(b)] += n.data; nodes[at.get(b)].push(n); }
    }
    // raw / nodes: the block's own text as it is and its text nodes in order (exact-range glow, #107).
    const out = [];
    els.forEach((el, i) => {
      const mermaid = diagramSource.has(el) ? diagramSource.get(el) : el.matches("pre") && el.querySelector(":scope > code.language-mermaid") ? texts[i] : null;
      if (mermaid !== null) {
        const text = CanvasCore.normText(mermaid);
        out.push({ el, tag: diagramSource.has(el) ? "mermaid" : "pre", text, key: CanvasCore.mermaidKey(mermaid), heading: false, raw: texts[i], nodes: nodes[i] });
        return;
      }
      const tag = el.tagName.toLowerCase();
      const text = CanvasCore.normText(texts[i]);
      if (!text && tag !== "hr" && tag !== "img") return;
      const key = tag === "img" ? `img:${el.getAttribute("src") || ""}:${el.getAttribute("alt") || ""}` : `${tag}:${text}`;
      out.push({ el, tag, text, key, heading: /^h[1-6]$/.test(tag), raw: texts[i], nodes: nodes[i] });
    });
    return out;
  }
  // What glows: blocks of a document, whole slides of a deck (§3.10 "… table row, slide").
  const slideSections = () => Array.from(deck.querySelectorAll(".slides > section"));
  const sectionUnit = (sec) => ({ el: sec, key: blocksOf(sec).map((b) => b.key).join("\n") });
  function shownUnits() {
    if (shownKind === "slides") return slideSections().map(sectionUnit);
    if (shownKind === "markdown" || shownKind === "mermaid") return blocksOf(doc);
    return [];
  }
  // Another text's units (the other side of a compare), rendered detached through the same sink.
  function unitsOfText(kind, text) {
    if (kind === "mermaid") return [{ key: CanvasCore.mermaidKey(text) }];
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
  // ms = Infinity: held (no fade, no timer) — while a compare is open or 顯示變更 is on (Brett,
  // 2026-10-11), until clearHeld().
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

  // canvas_patch's exact ranges (§3.10, #107): which characters of which shown blocks glow. The
  // text is rendered again, detached, with marks around the ranges (CanvasCore.markRanges); block
  // i of that copy is block i of the view, so its marks say which characters of block i changed.
  // → [{ i, raw, spans, points }] (offsets in the block's own text), or null when the copy's blocks
  // do not line up with the view's (the caller falls back to the block diff).
  function rangeGlowPlan(kind, content, ranges, blocks) {
    if (kind !== "markdown" && kind !== "slides") return null;
    const marked = CanvasCore.markRanges(content, ranges);
    if (marked === null) return null;
    let copy;
    if (kind === "slides") {
      copy = CanvasCore.splitSlides(marked).flatMap((t) => {
        const sec = document.createElement("section");
        renderMarkdownInto(sec, t, { copyText: copyViaHost });
        return blocksOf(sec);
      });
    } else {
      const art = document.createElement("article");
      renderMarkdownInto(art, CanvasCore.cleanEditorMarkdown(marked), { copyText: copyViaHost });
      copy = blocksOf(art);
    }
    if (copy.length !== blocks.length) return null;
    const plan = [];
    for (let i = 0; i < copy.length; i++) {
      const d = copy[i], t = CanvasCore.takeMarks(d.raw);
      const key = d.key.startsWith("mermaid:") ? CanvasCore.mermaidKey(t.text) : d.tag === "img" ? d.key : `${d.tag}:${CanvasCore.normText(t.text)}`;
      if (key !== blocks[i].key) return null;            // a mark changed the block: not the same document
      if (t.spans.length || t.points.length) plan.push({ i, raw: t.text, spans: t.spans, points: t.points });
    }
    return plan.length ? plan : null;
  }
  // Glow the planned characters: each span is wrapped (whitespace-only pieces are left alone: they
  // may sit between table cells). A block whose text is not exactly the planned one (a diagram, or a
  // re-render that changed it) glows whole; a deletion with nothing added marks where it was: the
  // top of the block that now stands there, the bottom of the last block (a deletion at the end),
  // or the whole block when it was inside its text.
  function glowPlan(blocks, plan, ms) {
    for (const p of plan) {
      const b = blocks[p.i];
      if (!b) continue;
      if (!p.spans.length) {
        const edge = p.points.every((x) => x === 0) ? "ks-removed-before" : p.points.every((x) => x === p.raw.length) ? "ks-removed-after" : null;
        if (edge) for (const t of b.el.tagName === "TR" ? Array.from(b.el.cells) : [b.el]) mark(t, edge, ms);
        else mark(b.el, "ks-changed", ms);
        continue;
      }
      if (b.tag === "mermaid" || b.raw !== p.raw) { mark(b.el, "ks-changed", ms); continue; }
      wrapSpans(b.nodes, p.spans, ms);
    }
  }
  function wrapSpans(nodes, spans, ms) {
    let off = 0;
    for (const n of nodes) {
      const from = off, to = off + n.data.length;
      off = to;
      const cuts = spans.map(([s, e]) => [Math.max(s, from) - from, Math.min(e, to) - from]).filter(([s, e]) => s < e && n.data.slice(s, e).trim());
      if (!cuts.length || !n.parentNode) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const [s, e] of cuts) {
        if (s > at) frag.append(n.data.slice(at, s));
        const span = document.createElement("span");
        span.className = "ks-range";
        span.textContent = n.data.slice(s, e);
        frag.append(span);
        at = e;
      }
      if (at < n.data.length) frag.append(n.data.slice(at));
      const spansHere = Array.from(frag.querySelectorAll(".ks-range"));
      n.replaceWith(frag);
      for (const el of spansHere) mark(el, "ks-changed", ms);
    }
  }

  let shownKind = "";
  let lastKeys = null;                    // the previous render's keys: what an agent write is compared with
  // { version, before, until, plan?, keys? }: a same-version re-render keeps its glow (plan: the
  // exact ranges', re-applied while the blocks are the same).
  let glowMemo = null;
  function showChanges(m) {
    const units = shownUnits();
    const keys = units.map((u) => u.key);
    const before = lastKeys;
    lastKeys = keys;
    if (!units.length) return;
    if (typeof m.glowAgainst === "string") { glowDiff(units, unitsOfText(m.kind, m.glowAgainst).map((u) => u.key), m.glowHold === true ? Infinity : GLOW_MS); return; }
    if (m.glowPrev && before) {
      glowMemo = { version: m.version, before, until: Date.now() + GLOW_MS };
      if (Array.isArray(m.glowRanges) && typeof m.content === "string") {
        const blocks = rangeBlocks();
        const plan = rangeGlowPlan(m.kind, m.content, m.glowRanges, blocks);
        if (plan) {
          glowMemo.plan = plan;
          glowMemo.keys = blocks.map((b) => b.key);
          glowPlan(blocks, plan, GLOW_MS);
          return;
        }
      }
      glowDiff(units, before, GLOW_MS);
      return;
    }
    // §3.5 normalization re-renders the same agent version moments later: keep its glow going.
    if (glowMemo && glowMemo.version === m.version && Date.now() < glowMemo.until) {
      const left = glowMemo.until - Date.now();
      if (glowMemo.plan) {
        const blocks = rangeBlocks();
        if (blocks.map((b) => b.key).join("\n") === glowMemo.keys.join("\n")) { glowPlan(blocks, glowMemo.plan, left); return; }
      }
      glowDiff(units, glowMemo.before, left);
    }
  }
  // The shown blocks the exact ranges map onto: a deck's blocks across its slides, not whole slides.
  const rangeBlocks = () => blocksOf(shownKind === "slides" ? deck.querySelector(".slides") : doc);

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
    // An SVG <a> (a mermaid link) may carry xlink:href instead of href.
    const href = a.getAttribute("href") || a.getAttributeNS("http://www.w3.org/1999/xlink", "href") || "";
    if (href.startsWith("#")) {
      // In-document anchor: scroll without navigating (a fragment change is not a load anyway).
      const target = href.length > 1 && document.getElementById(decodeURIComponent(href.slice(1)));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    // An SVG <a>'s `href` property is an SVGAnimatedString (postMessage cannot clone it, so the
    // message would never leave): resolve the attribute ourselves.
    let url = href;
    if (typeof a.href === "string") url = a.href;
    else { try { url = new URL(href, document.baseURI).href; } catch (_) { /* the host refuses it */ } }
    if (href) post({ type: "openLink", url });
  }
  document.addEventListener("click", onLinkClick, true);
  document.addEventListener("auxclick", onLinkClick, true);   // middle click

  // Ask agent (§3.7): tell the host what the user has selected in the view (rendered text), so it
  // can offer the button; "" when the selection is gone. Debounced (selectionchange fires per
  // pixel of a drag), sent only when it changed, cut at the push cap. Not while editing: the
  // editor holds unsaved text the agent could not find in the stored canvas. It carries the seq of
  // the render it was made in (#107, #96), so the host can drop one that arrives after a newer render.
  // rect (Brett 2026-10-12, option a): where the selection is in this viewport, so the HOST can
  // draw its 💬 beside it (never drawn in here, where canvas content could imitate it). Left out
  // while the selection is out of view, so the host hides the 💬 (and docks an open popover).
  // When the view moves under an unchanged selection (scroll, resize, a slide change), only the
  // rect is re-sent, once per animation frame, as selectionRect{rect?, seq} (#125d): the text
  // (up to SELECTION_MAX) and the where (a tree walk) cannot have changed, so they are neither
  // re-read nor re-posted.
  const SELECTION_DEBOUNCE_MS = 250;
  let selectionTimer = 0;
  let lastSelection = "";                 // what was last posted: where + text ("" = no selection)
  let lastRect = "";                      // the rect last posted with it
  let shownSeq = 0;                       // render{seq} of what the view shows
  function selectionRect(sel) {
    if (!sel || !sel.rangeCount) return undefined;
    const range = sel.getRangeAt(sel.rangeCount - 1);
    const b = range.getBoundingClientRect();
    if (!b || (b.width === 0 && b.height === 0)) return undefined;      // in a hidden slide, or nothing laid out
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    if (b.bottom <= 0 || b.top >= vh || b.right <= 0 || b.left >= vw) return undefined;   // scrolled out of view
    // The end of the range: the right edge of its last line box (an empty last box, e.g. a selection
    // ending at a line start, falls back to the one before it).
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    const last = rects.length ? rects[rects.length - 1] : b;
    const r = (n) => Math.round(n);
    return { top: r(b.top), bottom: r(b.bottom), left: r(b.left), right: r(b.right), x: r(Math.min(Math.max(last.right, b.left), b.right)) };
  }
  // where (Brett 2026-10-12 17:43): the heading path of the selection's start, the stored lines of
  // the blocks it starts and ends in (markdown.js tags blocks with data-line-start / -end), and in
  // a deck its slide. Parts that cannot be told are left out; the host checks the rest
  // (CanvasCore.askWhere) and drops the lines if the stored text changed since this render.
  const LINE_SEL = "[data-line-start]";
  const NOT_CONTENT = ".copy-btn, .ks-note, .ks-mermaid-error, style";
  // The first and last text nodes with selected non-blank text.
  function selectedTextEnds(range) {
    const top = range.commonAncestorContainer;
    const own = (n) => {
      const p = n.parentElement;
      if (!p || p.closest(NOT_CONTENT)) return false;
      const from = n === range.startContainer ? range.startOffset : 0;
      const to = n === range.endContainer ? range.endOffset : n.data.length;
      return n.data.slice(from, to).trim() !== "";
    };
    if (top.nodeType === Node.TEXT_NODE) return own(top) ? [top, top] : null;
    let first = null, last = null;
    const walk = document.createTreeWalker(top, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!range.intersectsNode(n) || !own(n)) continue;
      if (!first) first = n;
      last = n;
    }
    return first ? [first, last] : null;
  }
  function selectionWhere(sel) {
    if (!sel || !sel.rangeCount || !shownSource) return undefined;
    const a = selectedTextEnds(sel.getRangeAt(0));
    const b = sel.rangeCount > 1 ? selectedTextEnds(sel.getRangeAt(sel.rangeCount - 1)) : a;
    if (!a || !b) return undefined;
    const first = a[0], last = b[1];
    const where = {};
    const sections = shownKind === "slides" ? slideSections() : null;
    const sectionOf = (n) => (sections ? sections.indexOf(n.parentElement.closest(".slides > section")) : -1);
    let root = doc;
    if (sections) {
      const i = sectionOf(first);
      if (i < 0) return undefined;
      root = sections[i];
      where.slide = i + 1;
    }
    // Headings before the start or holding it, in document order (a deck: its own slide only).
    const heads = Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .filter((h) => h.contains(first) || (first.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_PRECEDING))
      .map((h) => ({ level: Number(h.tagName[1]), text: CanvasCore.askExcerpt(h.textContent, 79) }));
    const path = CanvasCore.askHeadingPath(heads).filter(Boolean);
    if (path.length) where.headings = path;
    const end = (n) => {
      const el = n.parentElement.closest(LINE_SEL);
      const box = sections ? sections[sectionOf(n)] : doc;
      if (!el || !box || !box.contains(el)) return null;
      const offset = sections ? shownSource.slideLines[sectionOf(n)] : 0;
      return { start: Number(el.getAttribute("data-line-start")), end: Number(el.getAttribute("data-line-end")), offset };
    };
    const ends = [end(first), end(last)];
    if (ends.every(Boolean)) {
      const lines = CanvasCore.askSourceLines(ends, { map: shownSource.map, stored: shownSource.stored });
      if (lines) where.lines = lines;
    }
    return Object.keys(where).length ? where : undefined;
  }
  function postSelection() {
    let text = "", rect, where;
    if (!editing && (shownKind === "markdown" || shownKind === "slides")) {
      const sel = document.getSelection();
      text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
      if (text) {
        rect = selectionRect(sel);
        try { where = selectionWhere(sel); } catch (_) { /* where is a nicety; the selection stands */ }
      }
    }
    selectionTimer = 0;
    const key = text ? `${JSON.stringify(where || null)}${text}` : "";
    const rectKey = JSON.stringify(rect || null);
    if (key === lastSelection && (!key || rectKey === lastRect)) return;
    if (key && key === lastSelection) { lastRect = rectKey; postSelectionRect(rect); return; }
    lastSelection = key;
    lastRect = rectKey;
    const truncated = text.length > CanvasCore.SELECTION_MAX;
    const msg = { type: "selection", text: truncated ? text.slice(0, CanvasCore.SELECTION_MAX) : text, seq: shownSeq };
    if (truncated) msg.truncated = true;
    if (rect) msg.rect = rect;
    if (where) msg.where = where;
    post(msg);
  }
  document.addEventListener("selectionchange", () => {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(postSelection, SELECTION_DEBOUNCE_MS);
  });
  function postSelectionRect(rect) {
    const msg = { type: "selectionRect", seq: shownSeq };
    if (rect) msg.rect = rect;
    post(msg);
  }
  // The view moved under an unchanged selection: re-measure its rect only (only while there is one
  // to place). A selection change still pending its debounce sends the full selection{} soon.
  let moveFrame = 0;
  function selectionMoved() {
    if (!lastSelection || moveFrame) return;
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      if (!lastSelection || selectionTimer || editing) return;
      const sel = document.getSelection();
      const rect = sel && !sel.isCollapsed ? selectionRect(sel) : undefined;
      const rectKey = JSON.stringify(rect || null);
      if (rectKey === lastRect) return;
      lastRect = rectKey;
      postSelectionRect(rect);
    });
  }
  document.addEventListener("scroll", selectionMoved, { capture: true, passive: true });   // any scroller
  window.addEventListener("resize", selectionMoved);
  deck.addEventListener("slidechanged", selectionMoved);           // reveal's events, on its .reveal element
  deck.addEventListener("slidetransitionend", selectionMoved);

  // A library that hits a blocked eval / fetch fails visibly, not silently (§3.2).
  document.addEventListener("securitypolicyviolation", (e) => {
    post({ type: "error", msg: `blocked by CSP: ${e.violatedDirective} ${e.blockedURI || ""}`.trim() });
  });

  // To chat input, then Enter (§3.7): after a 📨 the host is armed for a while. Normally the focus
  // is on the host page (the 📨 was clicked there), but should it be in this frame, the next key or
  // mouse press here is reported (armedKey{}); the host decides what it means. Enter / Esc are kept
  // from the page while armed. Capture phase, on window: ahead of everything in the frame.
  let armedKeys = false;
  function reportArmed(e, key) {
    if (!armedKeys || !e.isTrusted) return;     // as the host: only the user's own key or press
    if (key !== "mousedown" && CanvasCore.toInputArmKey(e) === "ignore") return;   // a lone modifier
    if (key !== "mousedown" && CanvasCore.toInputArmKey(e) !== "disarm") e.preventDefault();
    armedKeys = false;                    // one report; the host disarms or re-arms
    post({
      type: "armedKey", key: String(key).slice(0, 32),
      shiftKey: !!e.shiftKey, ctrlKey: !!e.ctrlKey, altKey: !!e.altKey, metaKey: !!e.metaKey,
      isComposing: e.isComposing === true, keyCode: Number.isInteger(e.keyCode) ? e.keyCode : 0,
    });
  }
  window.addEventListener("keydown", (e) => reportArmed(e, e.key), true);
  window.addEventListener("mousedown", (e) => reportArmed(e, "mousedown"), true);

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || m.nonce !== nonce) return;
    if (m.type === "armKeys") { armedKeys = m.on === true && !editing; return; }
    if (m.type === "copied") {
      const done = pendingCopies.get(m.reqId);
      if (done) { pendingCopies.delete(m.reqId); done(m.ok === true); }
      return;
    }
    if (m.type === "edit") {
      lastSelection = "";                   // the host drops its selection on edit and render
      startEdit(typeof m.content === "string" ? m.content : "", m.version)
        .catch((err) => { stopEdit(); post({ type: "editFailed", msg: String((err && err.message) || err) }); });
      return;
    }
    if (m.type === "saved") {
      if (editing && Number.isInteger(m.version)) {
        editing.version = m.version;
        // The baseline is what was saved; text typed while the save was in flight stays dirty.
        if (typeof m.content === "string") { editing.baseline = m.content; showSaved(editing.crepe, m.content); }
        const dirty = editorText(editing.crepe) !== editing.baseline;
        if (dirty !== editing.dirty) { editing.dirty = dirty; post({ type: "dirty", dirty }); }
      }
      return;
    }
    if (m.type === "requestSave") { requestSave(); return; }
    if (m.type === "editCmd") { runEditCmd(m.cmd); return; }
    if (m.type === "print") {
      // PDF export (§3.8): print this frame's document (needs allow-modals). Slides arrive here in
      // reveal's print-pdf layout; give it a moment to lay the pages out. A document's diagrams go
      // light for the paper first, and dark again after the (blocking) print dialog.
      const light = deck.hidden && !!doc.querySelector("figure.ks-mermaid");
      (light ? rethemeDiagrams(doc, PRINT_THEME) : Promise.resolve()).catch(() => {}).then(() => {
        setTimeout(() => {
          try { window.print(); } finally {
            post({ type: "printed" });
            if (light) rethemeDiagrams(doc, SCREEN_THEME).catch(() => {});
          }
        }, deck.hidden ? 50 : 800);
      });
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
    if (m.type === "css") { setAgentCss(m.sheets); return; }
    if (m.type === "highlight") { if (Number.isInteger(m.reqId)) highlight(m); return; }
    if (m.type === "glow") {
      // Compare started, or 顯示變更 (§3.10): glow the blocks that differ from `against`.
      // hold: kept until the next glow{} (the host re-sends it after each render); clear: drop held markers.
      clearHeld();
      if (m.clear === true) return;
      if (!editing && typeof m.against === "string" && CanvasCore.textKind(shownKind)) glowDiff(shownUnits(), unitsOfText(shownKind, m.against).map((u) => u.key), m.hold === true ? Infinity : GLOW_MS);
      return;
    }
    if (m.type !== "render") return;
    if (editing) stopEdit();                // the host only re-renders a clean editor
    shownKind = m.kind;
    shownSource = null;
    lastSelection = "";
    const gen = ++renderGen;
    const seq = Number.isInteger(m.seq) ? m.seq : 0;     // echoed back: which render this answers (#96)
    shownSeq = seq;
    Promise.resolve().then(() => {
      if (m.kind === "markdown") return renderMarkdown(typeof m.content === "string" ? m.content : "", gen, seq);
      if (m.kind === "slides") return renderSlides(typeof m.content === "string" ? m.content : "", gen, seq);
      if (m.kind === "mermaid") return renderMermaidCanvas(typeof m.content === "string" ? m.content : "", gen, seq);
      if (m.kind === "image") return renderImage(m.content);
      throw new Error(`unsupported kind: ${m.kind}`);
    }).then(async () => {
      if (gen !== renderGen) return;          // superseded while its diagrams rendered: the newer one reports
      try { showChanges(m); } catch (_) { /* the glow is a nicety; the render stands */ }
      // §3.5: the host asks for the normalized form of an agent markdown write (its agent copy).
      let normalized;
      if (m.kind === "markdown" && typeof m.normalizeText === "string") {
        try { normalized = CanvasCore.cleanEditorMarkdown(await normalize(m.normalizeText)); } catch (_) { /* stays unnormalized */ }
        // #86: never store a normalization that lost an image; the agent's text stays as written.
        if (normalized !== undefined && CanvasCore.losesImages(m.normalizeText, normalized)) normalized = undefined;
      }
      post(normalized === undefined ? { type: "rendered", version: m.version, seq } : { type: "rendered", version: m.version, seq, normalized });
    }, (err) => {
      if (gen === renderGen) post({ type: "error", msg: String((err && err.message) || err), seq });   // else superseded
    });
  });

  post({ type: "ready" });
})();
