// canvas-html-frame.js — our script in canvas-html-frame.html (canvas-html ADR §2.4, §2.7).
//
// Runs in an opaque origin with no chrome.* APIs, before any agent script. It talks only to its
// parent (canvas.html):
//  in:  render{nonce, kind: "html", content, version}   — once; a second one is ignored
//  in:  highlight{reqId, find|heading, label, durationMs}, css{reqId, sheets}, selectionRequest{reqId}
//       — after the render only (canvas-html §2.7): the agent's own strings, or a bare request
//  out: ready, rendered{version}, error{msg}, openLink{url}, highlighted{reqId, ok, tag?, text?, error?},
//       styled{reqId, sheets}, pageSelection{reqId, text, truncated?} — each with the nonce from #k=<nonce>
// On render it replaces this document with the canvas's HTML (document.open / write / close), which
// runs the page's inline scripts here, under this page's CSP. document.open drops the listeners
// added before it, so after close() the link, CSP and message listeners are added again, then
// rendered{}. The nonce is read once, first: the page can read and rewrite the hash (Archify does),
// so here it is only a second check behind the host's load gate (canvas §3.2).
// canvas-core.js is loaded just before this script for its pure helpers (block matching, caps);
// they are taken here, before any page script runs, and the global is removed again.
// Everything after the render is best effort: the page's script runs in this same document and can
// remove our listeners, styles or notes, or answer in our place. The host treats every answer as
// page-reported (canvas-html §2.7).
(function () {
  "use strict";

  const nonce = new URLSearchParams(location.hash.slice(1)).get("k") || "";
  const parentWin = window.parent;
  const Core = window.CanvasCore || null;
  try { delete window.CanvasCore; } catch (_) { /* stays; harmless */ }
  const matchBlock = Core && Core.matchBlock, htmlBlocks = Core && Core.htmlBlocks, clipError = Core && Core.clipError;
  const POINT_CSS = Core ? Core.POINT_CSS : "";
  const SELECTION_MAX = Core ? Core.SELECTION_MAX : 20 * 1024;
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

  // --- After the render (canvas-html §2.7) ---------------------------------------------------------
  // Our own <style>s, added at the end of the document so they win ties with the page's CSS.
  function ownStyle(id, text) {
    let el = document.getElementById(id);
    if (!text) { if (el) el.remove(); return; }
    if (!el || el.localName !== "style") { el = document.createElement("style"); el.id = id; }
    el.textContent = text;
    (document.head || document.documentElement).appendChild(el);
  }
  const laidOut = (el) => typeof el.getClientRects === "function" && el.getClientRects().length > 0;
  const NOTE_MAX = 80;
  const markTimers = new WeakMap();
  // canvas_highlight: the block by its rendered text (CanvasCore.htmlBlocks + matchBlock, as in the
  // static view), an amber glow (outline and background only) and the agent's label just above it.
  function highlight(m) {
    const reply = (r) => post({ type: "highlighted", reqId: m.reqId, ...r });
    if (!matchBlock || !htmlBlocks || !document.body) { reply({ ok: false, error: "this page shows nothing to point at" }); return; }
    const blocks = htmlBlocks(document.body, { keep: laidOut });
    const r = matchBlock(blocks, typeof m.heading === "string" ? { heading: m.heading } : { find: m.find });
    if (r.error) { reply({ ok: false, error: clipError(r.error) }); return; }
    const b = blocks[r.index];
    const ms = Math.min(Math.max(Number(m.durationMs) || 4000, 500), 10000);
    const label = typeof m.label === "string" ? Array.from(m.label.trim()).slice(0, NOTE_MAX).join("") : "";
    ownStyle("ks-point-css", POINT_CSS);
    const el = b.el;
    clearTimeout(markTimers.get(el));
    el.classList.remove("ks-point");
    void el.getBoundingClientRect();                     // restart the fade
    el.style.setProperty("--ks-ms", `${Math.round(ms)}ms`);
    el.classList.add("ks-point");
    markTimers.set(el, setTimeout(() => el.classList.remove("ks-point"), ms));
    if (label) {
      const note = document.createElement("div");
      note.className = "ks-note";
      note.setAttribute("role", "note");
      const icon = document.createElement("span");
      icon.textContent = "🤖";
      const who = document.createElement("b");
      who.textContent = "Agent:";
      const text = document.createElement("span");
      text.textContent = label;                          // agent text: textContent only
      note.append(icon, who, text);
      // Never over text: before the table for a row, at the top inside a list item, before the whole
      // diagram for an SVG label (a <div> inside <svg> would not show), else right above.
      let svg = el.closest("svg");
      while (svg && svg.parentElement && svg.parentElement.closest("svg")) svg = svg.parentElement.closest("svg");
      if (svg) svg.before(note);
      else if (el.localName === "tr") (el.closest("table") || el).before(note);
      else if (el.localName === "li") el.prepend(note);
      else el.before(note);
      setTimeout(() => note.remove(), ms);
    }
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    try { el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }); } catch (_) { /* placed either way */ }
    reply({ ok: true, tag: b.tag, text: Array.from(b.text).slice(0, 90).join("") });
  }
  // canvas_inject_css: the agent's sheets, all of them, in one <style> of ours; [] removes it.
  function setCss(m) {
    const sheets = m.sheets.filter((s) => typeof s === "string");
    ownStyle("ks-agent-css", sheets.join("\n"));
    post({ type: "styled", reqId: m.reqId, sheets: sheets.length });
  }
  // 📨 頁面選取: what is selected in this page, asked for by the user's click in the host. Cut at the
  // selection cap and said so; the host frames it as page-reported text.
  function reportSelection(m) {
    let text = "";
    try { const sel = window.getSelection(); text = sel ? String(sel.toString()).trim() : ""; } catch (_) { text = ""; }
    const msg = { type: "pageSelection", reqId: m.reqId, text: text.slice(0, SELECTION_MAX) };
    if (text.length > SELECTION_MAX) msg.truncated = true;
    post(msg);
  }
  function onAfterRender(event) {
    if (event.source !== parentWin) return;
    const m = event.data;
    if (!m || m.nonce !== nonce || !Number.isInteger(m.reqId)) return;
    if (m.type === "highlight") highlight(m);
    else if (m.type === "css" && Array.isArray(m.sheets)) setCss(m);
    else if (m.type === "selectionRequest") reportSelection(m);
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
    window.addEventListener("message", onAfterRender);
    post({ type: "rendered", version });
  }
  window.addEventListener("message", onMessage);
  // ready only once this document has finished loading (its load event, and the iframe's in the
  // host, are done): document.open() before that would make Chrome fire the iframe's load a second
  // time, and the host's load gate would drop the frame. Loading canvas-core.js first made that
  // race show (e2e, Chrome 155: render arrived before the load in about half the runs).
  if (document.readyState === "complete") post({ type: "ready" });
  else window.addEventListener("load", () => setTimeout(() => post({ type: "ready" }), 0), { once: true });
})();
