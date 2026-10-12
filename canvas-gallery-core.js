// canvas-gallery-core.js — the canvas gallery's (canvas-gallery.html, 總覽頁, ADR §3.7) row model,
// search and formatting as pure functions, so canvas-gallery.js only reads storage and builds DOM.
// Dual target like canvas-core.js (globalThis.CanvasGalleryCore / module.exports).
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.CanvasGalleryCore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const KIND_ICONS = { markdown: "📄", slides: "🖼️", image: "🏞️", mermaid: "🔀" };
  const KIND_LABELS = { markdown: "文件", slides: "投影片", image: "圖片", mermaid: "Mermaid 圖表" };
  const AUTHOR_LABELS = { agent: "agent", user: "你", file: "資料夾檔案" };
  // Content search reads canvas text only for these kinds (an image canvas's body is a JSON ref).
  const TEXT_KINDS = new Set(["markdown", "slides", "mermaid"]);
  const TITLE_MAX = 120;

  // Search normalisation: NFKC (full-width ↔ half-width, compatibility forms) and lower case, so
  // "ＡＢＣ" finds "abc". A query is whitespace-separated terms; a row matches when it has all of them.
  function normalize(s) {
    const t = String(s == null ? "" : s);
    return (typeof t.normalize === "function" ? t.normalize("NFKC") : t).toLowerCase();
  }
  function queryTerms(q) {
    return normalize(q).split(/\s+/).filter(Boolean);
  }
  function hasAllTerms(normalizedText, terms) {
    return terms.every((t) => normalizedText.includes(t));
  }

  // Conversations have no names until multi-conversation lands: the short id is the label
  // ("c_" + first 6 hex), the full id goes in the tooltip.
  function conversationLabel(conversationId) {
    const id = String(conversationId || "");
    if (!id) return "（未知對話）";
    return /^c_[0-9a-f]{12}$/.test(id) ? id.slice(0, 8) : id.slice(0, 16);
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  const pad = (n) => String(n).padStart(2, "0");
  // Local time, YYYY-MM-DD HH:mm (the user's own clock, like the chat's message times).
  function absoluteTime(at) {
    if (!Number.isFinite(at)) return "";
    const d = new Date(at);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function relativeTime(at, now) {
    if (!Number.isFinite(at)) return "";
    const s = Math.floor((now - at) / 1000);
    if (s < 60) return "剛剛";                                // also a clock slightly ahead
    if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小時前`;
    if (s < 30 * 86400) return `${Math.floor(s / 86400)} 天前`;
    return absoluteTime(at).slice(0, 10);
  }

  /**
   * One row per canvas meta (CanvasStore allMetas()), most recently updated first (ties: title,
   * then id, so the order is stable). Malformed metas are skipped, and so are canvases an incognito
   * window stored before Katashiro stopped running there (`noMirror`, #109): they are not listed
   * until the onInstalled cleanup (background.js) removes them. `size` is what the canvas
   * takes against the budget: its whole version history (§3.5, §3.6) — `footprint` (CanvasStore.footprint
   * in the page); without it, latest + the agent copy, what a canvas took before history.
   */
  function buildRows(metas, { now, footprint }) {
    const rows = [];
    for (const m of metas || []) {
      if (!m || typeof m !== "object" || typeof m.id !== "string") continue;
      if (m.noMirror) continue;
      const kind = String(m.kind || "markdown");
      const at = Number.isFinite(m.at) ? m.at : 0;
      const bytes = typeof footprint === "function" ? footprint(m) : (m.bytes || 0) + (m.agentBytes || 0);
      const title = String(m.title || "Canvas").slice(0, TITLE_MAX);
      rows.push({
        id: m.id,
        conversationId: String(m.conversationId || ""),
        conversation: conversationLabel(m.conversationId),
        title,
        titleKey: normalize(title),
        kind,
        icon: KIND_ICONS[kind] || "📄",
        kindLabel: KIND_LABELS[kind] || kind,
        version: Number.isInteger(m.version) ? m.version : 0,
        // The content cache key: applyNormalized rewrites latest in place without a version bump,
        // so the version alone can name stale text.
        rev: `${Number.isInteger(m.version) ? m.version : 0}${m.normalized ? "n" : ""}`,
        author: AUTHOR_LABELS[m.author] || String(m.author || ""),
        at,
        timeRel: at ? relativeTime(at, now) : "",
        timeAbs: at ? absoluteTime(at) : "",
        bytes,
        size: formatSize(bytes),
        hasFile: !!m.file,
      });
    }
    return rows.sort((a, b) => b.at - a.at || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * The rows a query shows. Title (and conversation label) always; content too for the rows whose
   * normalized text is in `contents` (Map id → { rev, text }) at the row's current `rev`.
   * A content-only match carries `snippet`. Empty query → every row.
   */
  function filterRows(rows, query, contents) {
    const terms = queryTerms(query);
    if (!terms.length) return rows.slice();
    const out = [];
    for (const r of rows) {
      if (hasAllTerms(`${r.titleKey} ${normalize(r.conversation)}`, terms)) { out.push(r); continue; }
      const c = contents && contents.get(r.id);
      if (c && c.rev === r.rev && hasAllTerms(c.text, terms)) out.push({ ...r, snippet: snippet(c.text, terms) });
    }
    return out;
  }

  // ~`radius` characters on each side of the first term's first hit, whitespace collapsed.
  // `text` is already normalized (lower case): the snippet shows it as such.
  function snippet(text, terms, radius = 40) {
    const t = String(text || "");
    let at = -1, len = 0;
    for (const term of terms) {
      const i = t.indexOf(term);
      if (i >= 0 && (at < 0 || i < at)) { at = i; len = term.length; }
    }
    if (at < 0) return "";
    const from = Math.max(0, at - radius), to = Math.min(t.length, at + len + radius);
    return `${from > 0 ? "…" : ""}${t.slice(from, to).replace(/\s+/g, " ").trim()}${to < t.length ? "…" : ""}`;
  }

  /**
   * Which canvases' text to read for a content search: text kinds only, not cached at their current
   * version, most recent first, within `maxBytes` and `maxCount` per pass (the rest is searched by
   * title only, and the page says so). → { ids: string[], skipped: number }
   */
  const CONTENT_READ_MAX_BYTES = 16 * 1024 * 1024;
  const CONTENT_READ_MAX_COUNT = 300;
  function planContentReads(rows, contents, { maxBytes = CONTENT_READ_MAX_BYTES, maxCount = CONTENT_READ_MAX_COUNT } = {}) {
    const ids = [];
    let bytes = 0, skipped = 0;
    for (const r of rows) {
      if (!TEXT_KINDS.has(r.kind)) continue;
      const c = contents && contents.get(r.id);
      if (c && c.rev === r.rev) continue;
      const b = r.bytes || 0;
      if (ids.length >= maxCount || bytes + b > maxBytes) { skipped++; continue; }
      ids.push(r.id);
      bytes += b;
    }
    return { ids, skipped };
  }

  /**
   * The search query an agent asked for (canvas_gallery({query}), ADR §3.11): the `q` parameter of
   * the URL fragment (`#q=<encoded>`), or null when there is none. It goes into the search box as
   * its value only, but it is still agent text: control and bidi-control characters become spaces,
   * whitespace is collapsed and it is cut to QUERY_MAX characters (code points).
   */
  const QUERY_MAX = 200;
  function queryFromHash(hash) {
    const h = String(hash == null ? "" : hash).replace(/^#/, "");
    if (!h) return null;
    let q;
    try { q = new URLSearchParams(h).get("q"); } catch (_) { return null; }
    if (q == null) return null;
    const clean = q.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
    return Array.from(clean).slice(0, QUERY_MAX).join("").trim();
  }

  return {
    QUERY_MAX, queryFromHash,
    KIND_ICONS, KIND_LABELS, AUTHOR_LABELS, TEXT_KINDS, CONTENT_READ_MAX_BYTES, CONTENT_READ_MAX_COUNT,
    normalize, queryTerms, conversationLabel, formatSize, absoluteTime, relativeTime, buildRows, filterRows, snippet, planContentReads,
  };
});
