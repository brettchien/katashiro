// canvas-store.js — persistence for Katashiro canvases (ADR docs/adr/canvas.md §3.5, §3.6).
//
// A canvas keeps its last N versions, full content each (§3.5 history, Brett 2026-10-11; N = 10 by
// default, the canvas:historyMax setting). `version` counts every save; the latest is the newest
// history entry, and the agent's last write (`agentVersion`) is pinned: never trimmed while it is
// the agent copy. Keys, all in one chrome.storage area:
//   canvas:<conversationId>:index  [{ id, title, kind, version, bytes, updatedAt }]
//   canvas:<id>:meta               { id, conversationId, title, kind, version, author, at, agentVersion, bytes,
//                                    history: [{ v, author, at, bytes, image?, imageBytes? }] (oldest first,
//                                    the last is the latest) }
//   canvas:<id>:latest             the latest content (string)
//   canvas:<id>:v:<n>              every other version in history
//   canvas:<id>:agent              only before history: the agent's last write while it differed from
//                                  the latest (meta.agentBytes its size). The next write migrates it.
//   canvas:<conversationId>:moved  [{ id, title, kind, version, dir: "in" | "out", at }] canvases the
//                                  user moved into or out of that conversation (multi-conversation
//                                  §7.3), until its agent has been told (takeMoveNotes).
// meta may also carry the folder mirror state (canvas-mirror.js, §3.6): file, fileSyncedVersion,
// filesByFolder. patchRanges: what the latest canvas_patch changed (§3.10, #107). noMirror marks
// a canvas an incognito window stored before Katashiro stopped running in incognito (#109); none is
// created any more, and the update removes them (incognitoLeftovers).
//
// chrome.storage has no transactions, so every read → check → write runs under a lock: the
// canvas's own (`canvas:<id>`) and, nested inside it for the index, `canvas:index` — always in
// that order, never the reverse, so two writers cannot deadlock. Holding the id lock across the
// index update keeps index versions from going backwards. Content and meta go in one set(), so
// onChanged fires once and a lock-free reader never sees new content with old meta. In the extension `lock` is navigator.locks
// (shared by every page of the extension origin); tests pass a simple in-process lock.
//
// Dual target like browser-mcp.js: classic <script> (globalThis.CanvasStore) and require() in tests.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.CanvasStore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const KINDS = ["markdown", "slides", "image", "mermaid", "html"];   // chart follows (mermaid moved up, Brett 2026-10-11; html: canvas-html ADR)
  // Text the agent can canvas_patch: a mermaid canvas is its diagram source (never edited by the user).
  const PATCH_KINDS = ["markdown", "slides", "mermaid"];
  const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
  const IMAGE_MAX_BYTES = 5 * 1024 * 1024;  // like show_image
  const IMAGE_GRACE_MS = 10 * 60 * 1000;    // §3.6 sweep: never delete an image written this recently
  const imageKey = (hash) => `canvas:img:${hash}`;

  function b64Bytes(b64) {
    return Math.max(0, Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0));
  }

  // sha256 of the DECODED bytes, hex — the content address of an image (§3.6).
  async function sha256OfBase64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
  }
  const TITLE_MAX = 120;
  const CONTENT_MAX_BYTES = 2 * 1024 * 1024; // §3.4: 2 MB text per canvas
  // canvas-html §6 Q1 (Brett 2026-10-28): an html canvas may hold 4 MB (Archify's Delta view is 2.35 MB).
  const HTML_MAX_BYTES = 4 * 1024 * 1024;
  const contentCap = (kind) => (kind === "html" ? HTML_MAX_BYTES : CONTENT_MAX_BYTES);
  // canvas §6 Q2: html canvases are on by default and the user can turn them off (Settings). false =
  // off: canvas_open refuses kind html, and canvas tabs show html canvases without their scripts only.
  const HTML_ENABLED_KEY = "canvas:htmlEnabled";
  const htmlEnabled = (v) => v !== false;
  // canvas-diagram-engine §2.1 (Brett 2026-10-30): Settings → 圖表引擎. "mermaid" picks Mermaid;
  // anything else (absent included) is Pele, the default.
  const DIAGRAM_ENGINE_KEY = "canvas:diagramEngine";
  const diagramEngine = (v) => (v === "mermaid" ? "mermaid" : "pele");
  // §3 (#210 review): the one-time "圖表改用 Pele 繪製" notice; true once a canvas tab showed it.
  const PELE_NOTICE_KEY = "canvas:peleNoticeShown";
  const ID_RE = /^cv_[0-9a-f]{12}$/;

  const indexKey = (conversationId) => `canvas:${conversationId}:index`;
  const movedKey = (conversationId) => `canvas:${conversationId}:moved`;
  const MOVE_NOTES_MAX = 20;                // per conversation: older notes give way
  const metaKey = (id) => `canvas:${id}:meta`;
  const latestKey = (id) => `canvas:${id}:latest`;
  // Before history (§3.5): the agent's last write, kept only once the latest differed from it.
  // Read on canvases not written since; their next write moves it into the history.
  const agentKey = (id) => `canvas:${id}:agent`;
  // A version in history other than the latest.
  const versionKey = (id, v) => `canvas:${id}:v:${v}`;

  function utf8Bytes(s) {
    return new TextEncoder().encode(s).length;
  }

  // --- Version history (§3.5, Brett 2026-10-11) ------------------------------------------------
  // Pure: the store, the canvas tab (◐, the agent copy), the gallery and Settings share them; the tests drive them alone.
  const HISTORY_MAX_KEY = "canvas:historyMax";   // the setting (sidepanel Settings), in chrome.storage.local
  const HISTORY_DEFAULT = 10;
  const HISTORY_MIN = 1;
  const HISTORY_MAX = 50;

  // The setting's stored value → N: a whole number in 1–50; anything that is not a number → 10.
  function historyLimit(raw) {
    if (raw == null || raw === "" || typeof raw === "boolean" || typeof raw === "object") return HISTORY_DEFAULT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return HISTORY_DEFAULT;
    return Math.min(HISTORY_MAX, Math.max(HISTORY_MIN, Math.round(n)));
  }

  const hasHistory = (meta) => !!meta && Array.isArray(meta.history) && meta.history.length > 0;

  // A canvas's history, oldest first. A canvas stored before history (lazy migration) reads as the
  // versions it does have: its agent copy (kept while a user save was on top) and its latest.
  function historyOf(meta) {
    if (!meta) return [];
    if (hasHistory(meta)) return meta.history;
    const out = [];
    if (Number.isInteger(meta.agentVersion) && meta.agentVersion >= 1 && meta.agentVersion < meta.version) {
      out.push({ v: meta.agentVersion, author: "agent", at: 0, bytes: meta.agentBytes || 0 });
    }
    out.push({ v: meta.version, author: meta.author, at: meta.at || 0, bytes: meta.bytes || 0 });
    return out;
  }

  // Where version `v` of this canvas is stored, or null when it is not in history.
  function contentKey(meta, v) {
    if (!meta || !historyOf(meta).some((h) => h.v === v)) return null;
    if (v === meta.version) return latestKey(meta.id);
    return hasHistory(meta) ? versionKey(meta.id, v) : agentKey(meta.id);
  }

  // Every key holding a version of this canvas (the image sweep reads them all).
  const contentKeys = (meta) => historyOf(meta).map((h) => contentKey(meta, h.v));

  // The version before the latest (◐ 顯示變更's baseline, §3.10), or null (v1, or trimmed). Only
  // latest − 1 counts: with N = 1 the entry before the latest can be the pinned agent write, which
  // is older than the previous version.
  function previousVersion(meta) {
    const h = historyOf(meta);
    const v = h.length >= 2 ? h[h.length - 2].v : null;
    return v != null && v === meta.version - 1 ? v : null;
  }

  /**
   * Append `entry` (the new latest) and trim to the last `max` versions, never dropping `pin` (the
   * agent's last write) → { history, dropped: [v] }. Only writes trim (§3.5): never the budget.
   */
  function appendHistory(history, entry, { max, pin } = {}) {
    const all = [...(history || []).filter((h) => h && h.v < entry.v), entry];
    const from = Math.max(0, all.length - historyLimit(max));
    const keep = (h, i) => i >= from || h.v === pin;
    return { history: all.filter(keep), dropped: all.filter((h, i) => !keep(h, i)).map((h) => h.v) };
  }

  // What a history takes (§3.6 budget): every version a full copy; an image canvas's image counted
  // once per distinct image (its versions share it by hash).
  function historyFootprint(history) {
    let n = 0;
    const images = new Map();
    for (const h of history || []) {
      const img = h.image ? (h.imageBytes || 0) : 0;
      n += Math.max(0, (h.bytes || 0) - img);
      if (h.image) images.set(h.image, img);
    }
    for (const b of images.values()) n += b;
    return n;
  }
  const footprint = (meta) => historyFootprint(historyOf(meta));

  // A stale write: the canvas moved on since the caller's baseVersion (§3.5). A structured error,
  // not the whole document; `diffFromBase` (baseVersion → latest) when that version is in history.
  // Over the byte budget and the user declined (or could not be asked) to drop old canvases (§3.6).
  class QuotaError extends Error {
    constructor(needed, budget) {
      super(`canvas storage is full (${needed} bytes needed over the ${budget}-byte budget) and nothing was removed`);
      this.code = "quota";
    }
  }

  class StaleError extends Error {
    constructor(meta, baseVersion, diffFromBase) {
      super(`canvas "${meta.title}" is at version ${meta.version}, not ${baseVersion} — ` +
        (diffFromBase != null ? "rebase on diffFromBase, or canvas_read, and write on top of the latest" : "call canvas_read and write on top of the latest"));
      this.code = "stale";
      this.currentVersion = meta.version;
      this.author = meta.author;
      this.diffFromBase = diffFromBase == null ? null : diffFromBase;
    }
  }

  // canvas_patch could not apply (§3.5) on an up-to-date canvas: which edit, and why. (Against a
  // canvas that moved on since baseVersion, a miss is a StaleError with the diff instead.)
  class PatchError extends Error {
    constructor(failure) {
      super(failure.message);
      this.code = "patch";
      this.index = failure.index;
      this.count = failure.count;
      if (failure.overlaps != null) this.overlaps = failure.overlaps;
    }
  }

  // canvas_patch limits: edits per call and the size of each find / replace (the result is still
  // capped at CONTENT_MAX_BYTES like any write).
  const PATCH_EDITS_MAX = 50;
  const PATCH_FIND_MAX = 32 * 1024;
  const PATCH_REPLACE_MAX = 512 * 1024;

  // How many places `find` starts in `text` (overlapping starts count: "aa" is twice in "aaa"),
  // and where the first one is. Stops counting at `cap`.
  function countMatches(text, find, cap = 1000) {
    let count = 0, first = -1;
    for (let i = text.indexOf(find); i !== -1 && count < cap; i = text.indexOf(find, i + 1)) {
      if (first < 0) first = i;
      count++;
    }
    return { count, first };
  }

  /**
   * canvas_patch's matching (§3.5), pure: every `find` against ONE snapshot (`text`), never against
   * another edit's output; each must occur exactly once and no two matched ranges may overlap
   * (touching is fine). Then all replacements apply together.
   * → { ok: true, text, ranges: [{ start, end }] (in the NEW text, document order) }
   *   | { ok: false, index, count, overlaps?, message }   (index = the failing edit, 0-based)
   * Edits are assumed validated (validatePatchEdits).
   */
  function planPatch(text, edits) {
    const src = String(text);
    const spans = [];
    for (let i = 0; i < edits.length; i++) {
      const { count, first } = countMatches(src, edits[i].find);
      if (count !== 1) {
        return {
          ok: false, index: i, count,
          message: count === 0
            ? `edits[${i}].find matches nothing in the latest version — canvas_read and copy the stored (normalized) text exactly`
            : `edits[${i}].find matches ${count >= 1000 ? "1000+" : count} places; it must match exactly once — include more surrounding text`,
        };
      }
      spans.push({ index: i, start: first, end: first + edits[i].find.length, replace: edits[i].replace });
    }
    spans.sort((a, b) => a.start - b.start);
    for (let k = 1; k < spans.length; k++) {
      if (spans[k].start < spans[k - 1].end) {
        const [a, b] = [spans[k - 1].index, spans[k].index].sort((x, y) => x - y);
        return { ok: false, index: b, count: 1, overlaps: a, message: `edits[${b}].find overlaps edits[${a}].find; merge them into one edit` };
      }
    }
    let out = "", at = 0, shift = 0;
    const ranges = [];
    for (const s of spans) {
      out += src.slice(at, s.start) + s.replace;
      ranges.push({ start: s.start + shift, end: s.start + shift + s.replace.length });
      shift += s.replace.length - (s.end - s.start);
      at = s.end;
    }
    out += src.slice(at);
    return { ok: true, text: out, ranges };
  }

  // Shape of canvas_patch's `edits`; returns the edits ({find, replace} strings) or throws.
  function validatePatchEdits(edits) {
    if (!Array.isArray(edits) || !edits.length) throw new Error("`edits` must be a non-empty array of { find, replace }");
    if (edits.length > PATCH_EDITS_MAX) throw new Error(`${edits.length} edits; at most ${PATCH_EDITS_MAX} per call (for a rewrite, use canvas_open with the full content)`);
    return edits.map((e, i) => {
      if (!e || typeof e !== "object") throw new Error(`edits[${i}] must be { find, replace }`);
      if (typeof e.find !== "string" || e.find === "") throw new Error(`edits[${i}].find must be a non-empty string`);
      if (typeof e.replace !== "string") throw new Error(`edits[${i}].replace must be a string (may be empty)`);
      if (e.find.length > PATCH_FIND_MAX) throw new Error(`edits[${i}].find is ${e.find.length} chars; at most ${PATCH_FIND_MAX}`);
      if (e.replace.length > PATCH_REPLACE_MAX) throw new Error(`edits[${i}].replace is ${e.replace.length} chars; at most ${PATCH_REPLACE_MAX}`);
      return { find: e.find, replace: e.replace };
    });
  }

  // Line-based unified diff (a → b), 2 lines of context. Common prefix/suffix are trimmed first; the
  // middle is an LCS, bounded (returns null if too large to diff here). Pure, used for the stale
  // diff, normalizedDiff and Send to agent.
  const DIFF_MAX_LINES = 3000;
  function unifiedDiff(a, b, { context = 2 } = {}) {
    if (a === b) return "";
    const A = String(a).split("\n"), B = String(b).split("\n");
    let pre = 0;
    while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
    let suf = 0;
    while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
    const a1 = A.slice(pre, A.length - suf), b1 = B.slice(pre, B.length - suf);
    if (a1.length > DIFF_MAX_LINES || b1.length > DIFF_MAX_LINES) return null;
    const n = a1.length, m = b1.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a1[i] === b1[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
    const ops = [];                                    // [' ', line] / ['-', line] / ['+', line] over the whole text
    for (let k = 0; k < pre; k++) ops.push([" ", A[k]]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a1[i] === b1[j]) { ops.push([" ", a1[i]]); i++; j++; }
      else if (j < m && (i >= n || L[i][j + 1] > L[i + 1][j])) { ops.push(["+", b1[j]]); j++; }
      else { ops.push(["-", a1[i]]); i++; }
    }
    for (let k = A.length - suf; k < A.length; k++) ops.push([" ", A[k]]);
    // Group changes into hunks with context.
    const out = [];
    let idx = 0;
    while (idx < ops.length) {
      if (ops[idx][0] === " ") { idx++; continue; }
      let start = Math.max(0, idx - context), end = idx;
      while (end < ops.length) {
        if (ops[end][0] !== " ") { end++; continue; }
        let run = 0;
        while (end + run < ops.length && ops[end + run][0] === " ") run++;
        if (end + run >= ops.length || run > context * 2) { end = Math.min(ops.length, end + context); break; }
        end += run;
      }
      let aLine = 1, bLine = 1;
      for (let k = 0; k < start; k++) { if (ops[k][0] !== "+") aLine++; if (ops[k][0] !== "-") bLine++; }
      const hunk = ops.slice(start, end);
      const aCount = hunk.filter((o) => o[0] !== "+").length, bCount = hunk.filter((o) => o[0] !== "-").length;
      out.push(`@@ -${aLine},${aCount} +${bLine},${bCount} @@`);
      for (const [t, l] of hunk) out.push(t + l);
      idx = end;
    }
    return out.join("\n");
  }

  /**
   * @param {object} deps
   * @param {{ get(keys): Promise<object>, set(items): Promise<void> }} deps.storage  chrome.storage.local
   * @param {(name: string, fn: () => Promise<any>) => Promise<any>} deps.lock
   * @param {() => number} [deps.now]
   * @param {() => string} [deps.randomHex]  12 hex chars for a new id
   * @param {number} [deps.budgetBytes]  total canvas bytes allowed (default: the BUDGET_OVERRIDE_KEY
   *   value in storage if set, else 200 MB, §3.6)
   * @param {(id: string) => Promise<boolean>} [deps.isOpen]  is this canvas open in a tab (never evicted)
   * @param {(info: { needed: number, evict: object[] }) => Promise<boolean>} [deps.confirmEvict]
   *        asked once when a write would go over budget; true = remove `evict` and write. An agent
   *        write may pass its own (agentWrite/agentPatch `confirmEvict`), so the question is tied to
   *        the asking agent (#80); a user save asks this one.
   */
  // The entries whose key passes `test`, without pulling every value into memory: getKeys()
  // (Chrome 130+) lists keys only, so canvas contents (up to the budget) are not read just to be
  // filtered out. Older Chrome (or a storage without getKeys) falls back to one get(null) scan.
  async function getMatching(storage, test) {
    if (typeof storage.getKeys === "function") {
      const keys = (await storage.getKeys()).filter(test);
      return keys.length ? (await storage.get(keys)) || {} : {};
    }
    const all = (await storage.get(null)) || {};
    const out = {};
    for (const [k, v] of Object.entries(all)) if (test(k)) out[k] = v;
    return out;
  }

  function createCanvasStore(deps) {
    const storage = deps.storage;
    const lock = deps.lock;
    const now = deps.now || (() => Date.now());
    // The budget: fixed by the caller (tests), else a test override in storage (read on every check,
    // so setting or removing it needs no reload), else 200 MB.
    async function budget() {
      if (deps.budgetBytes) return deps.budgetBytes;
      const v = ((await storage.get(BUDGET_OVERRIDE_KEY)) || {})[BUDGET_OVERRIDE_KEY];
      return Number.isFinite(v) && v >= BUDGET_OVERRIDE_MIN ? Math.min(Math.floor(v), BUDGET_BYTES) : BUDGET_BYTES;
    }
    const isOpen = deps.isOpen || (async () => false);
    const confirmEvict = deps.confirmEvict || (async () => false);
    const randomHex = deps.randomHex || (() => {
      const b = new Uint8Array(6);
      globalThis.crypto.getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    });

    async function getOne(key) {
      const got = await storage.get(key);
      return got ? got[key] : undefined;
    }

    // Validate what any write needs; returns the normalized fields or throws a plain Error.
    // markdown / slides / mermaid: `content` is the text (mermaid: the diagram source). image: `image` = { mimeType, data (base64) } plus an
    // optional `caption`; the stored content is a small JSON reference to the image by hash (§3.6).
    async function validate({ title, kind, content, image, caption }) {
      const t = title == null ? "" : String(title).trim();
      if (!t) throw new Error("`title` is required");
      if (t.length > TITLE_MAX) throw new Error(`title is ${t.length} chars; keep it to ${TITLE_MAX} or fewer`);
      const k = kind == null ? "markdown" : String(kind);
      if (!KINDS.includes(k)) throw new Error(`kind "${k}" is not supported yet (supported: ${KINDS.join(", ")})`);
      if (k === "image") {
        if (!image || typeof image.data !== "string") throw new Error("an image canvas needs an image (`imageId` or `data`)");
        if (!IMAGE_MIME_TYPES.includes(image.mimeType)) throw new Error(`image type must be one of ${IMAGE_MIME_TYPES.join(", ")}`);
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("image data is not valid base64");
        const imgBytes = b64Bytes(image.data);
        if (imgBytes > IMAGE_MAX_BYTES) throw new Error(`image is ${imgBytes} bytes; a canvas image is capped at ${IMAGE_MAX_BYTES}`);
        const cap = caption == null ? "" : String(caption).trim();
        if (cap.length > 200) throw new Error(`caption is ${cap.length} chars; keep it to 200 or fewer`);
        const hash = await sha256OfBase64(image.data);
        const json = JSON.stringify({ image: hash, mimeType: image.mimeType, caption: cap });
        return { title: t, kind: k, content: json, bytes: utf8Bytes(json) + imgBytes, image: { hash, mimeType: image.mimeType, data: image.data } };
      }
      if (typeof content !== "string") throw new Error("`content` must be a string");
      const bytes = utf8Bytes(content);
      const cap = contentCap(k);
      if (bytes > cap) throw new Error(`content is ${bytes} bytes; a${k === "html" ? "n html" : ""} canvas is capped at ${cap}`);
      return { title: t, kind: k, content, bytes };
    }

    // Images first, then the content that references them (§3.6 write order). One key per hash, and
    // always (re)written: an image already stored gets a fresh savedAt, so a sweep cannot take it
    // before our content lands. Under canvas:index (taken alone, outside any canvas:<id>), so a sweep
    // runs wholly before (image gone, we write it back) or after (sees the fresh savedAt).
    async function putImage(img) {
      if (!img) return;
      const k = imageKey(img.hash);
      await lock("canvas:index", () => storage.set({ [k]: { mimeType: img.mimeType, data: img.data, savedAt: now() } }));
    }

    // Mark-and-sweep (§3.6): delete images no version of any image canvas references (every version
    // in its history, §3.5), except ones written in the last 10 minutes (a write referencing them
    // may still be on its way). Under canvas:index.
    async function sweepImages() {
      await lock("canvas:index", async () => {
        const metas = await getMatching(storage, (k) => /^canvas:cv_[0-9a-f]{12}:meta$/.test(k));
        const keys = Object.values(metas).filter((m) => m && m.kind === "image").flatMap(contentKeys);
        const bodies = keys.length ? (await storage.get(keys)) || {} : {};
        const live = new Set();
        for (const v of Object.values(bodies)) {
          try { const r = JSON.parse(v); if (r && r.image) live.add(r.image); } catch (_) { /* not an image ref */ }
        }
        const imgs = await getMatching(storage, (k) => k.startsWith("canvas:img:"));
        const dead = Object.entries(imgs)
          .filter(([k, v]) => !live.has(k.slice("canvas:img:".length)) && now() - ((v && v.savedAt) || 0) > IMAGE_GRACE_MS)
          .map(([k]) => k);
        if (dead.length) await storage.remove(dead);
      });
    }

    // After a write or delete has succeeded: a failed sweep must not turn it into an error (the agent
    // would retry and hit stale). The next sweep picks up what this one missed.
    async function sweepAfter() {
      try { await sweepImages(); } catch (_) { /* best effort */ }
    }

    // The image bytes of an image canvas, for the host page (never returned to the agent).
    async function readImage(hash) {
      if (!/^[0-9a-f]{64}$/.test(String(hash))) return null;
      return (await getOne(imageKey(hash))) || null;
    }

    // Every canvas's meta, across conversations (for the budget and the gallery, §3.7). Reads only
    // the meta keys.
    async function allMetas() {
      const all = await getMatching(storage, (k) => /^canvas:cv_[0-9a-f]{12}:meta$/.test(k));
      return Object.values(all).filter((v) => v && typeof v === "object");
    }

    // N for the next trim (§3.5): fixed by the caller (tests), else the setting, read on every write
    // so a change needs no reload.
    async function historyMaxNow() {
      if (deps.historyMax != null) return historyLimit(deps.historyMax);
      return historyLimit(((await storage.get(HISTORY_MAX_KEY)) || {})[HISTORY_MAX_KEY]);
    }

    // What canvas `before` will take once a version of `entry` (bytes, image?, imageBytes?) is
    // written on top, trimmed (`pin` = the agentVersion it will have); a new canvas: the entry.
    function projected(before, entry, max, pin) {
      if (!before) return entry.bytes;
      return historyFootprint(appendHistory(historyOf(before), { ...entry, v: before.version + 1 }, { max, pin }).history);
    }

    async function usage() {
      const metas = await allMetas();
      return { total: metas.reduce((n, m) => n + footprint(m), 0), count: metas.length, budget: await budget() };
    }

    // Make room for `addBytes` (what the canvas being written takes afterwards, history included:
    // `projected`; what it uses now is not counted). Over
    // budget: least recently opened first, never one open in a tab nor the one being written, and
    // only after one confirmation. Throws QuotaError if declined or if that cannot free enough.
    async function ensureBudget(addBytes, keepId, ask = confirmEvict) {
      const metas = await allMetas();
      const total = metas.reduce((n, m) => n + footprint(m), 0);
      const mine = metas.find((m) => m.id === keepId);
      const own = mine ? footprint(mine) : 0;
      const budgetBytes = await budget();
      const over = total - own + addBytes - budgetBytes;
      if (over <= 0) return;
      const candidates = metas
        .filter((m) => m.id !== keepId)
        .sort((a, b) => (a.openedAt || a.at || 0) - (b.openedAt || b.at || 0));
      const evict = [];
      let freed = 0;
      for (const m of candidates) {
        if (freed >= over) break;
        if (await isOpen(m.id)) continue;
        evict.push({ id: m.id, title: m.title, bytes: footprint(m), conversationId: m.conversationId, version: m.version });
        freed += footprint(m);
      }
      if (freed < over || !(await ask({ needed: over, evict }))) throw new QuotaError(over, budgetBytes);
      // The confirmation waits on the user (up to 2 minutes, #80); a canvas opened or changed
      // meanwhile is kept — the user agreed to drop what they were shown (the write may then run
      // slightly over budget — it is a soft cap). One image sweep after all of them, not one per
      // canvas (#115 review, as removeIncognitoLeftovers).
      let removed = 0;
      for (const e of evict) if (!(await isOpen(e.id)) && (await remove({ id: e.id, expectVersion: e.version, sweep: false })).removed) removed++;
      if (removed) await sweepAfter();
    }

    async function updateIndex(conversationId, entry) {
      await lock("canvas:index", async () => {
        const list = (await getOne(indexKey(conversationId))) || [];
        const i = list.findIndex((e) => e.id === entry.id);
        if (i >= 0) list[i] = entry; else list.push(entry);
        await storage.set({ [indexKey(conversationId)]: list });
      });
    }

    /**
     * Create (no `id`) or update (with `id` + `baseVersion`) a canvas as the agent.
     * @returns {Promise<{ id, version, created, title }>}
     */
    async function agentWrite({ conversationId, id, baseVersion, title, kind, content, image, caption, confirmEvict: ask }) {
      if (!conversationId) throw new Error("no conversation to attach the canvas to");
      const v = await validate({ title, kind, content, image, caption });
      if (v.kind === "html" && !htmlEnabled(await getOne(HTML_ENABLED_KEY))) {
        throw new Error("html canvases are turned off in Katashiro's Settings (畫布 → html 畫布); use another kind, or ask the user to turn them on");
      }
      const at = now();
      // A history entry's image fields (§3.6: the footprint counts one image once per canvas).
      const img = v.image ? { image: v.image.hash, imageBytes: b64Bytes(v.image.data) } : null;
      if (id == null || id === "") {
        await ensureBudget(v.bytes, null, ask || confirmEvict);
        const newId = `cv_${randomHex()}`;
        const meta = {
          id: newId, conversationId, title: v.title, kind: v.kind,
          version: 1, author: "agent", at, agentVersion: 1, agentSeenVersion: 1, bytes: v.bytes,
          normalized: v.kind !== "markdown",               // markdown waits for the editor's normalization
          history: [{ v: 1, author: "agent", at, bytes: v.bytes, ...img }],
        };
        await putImage(v.image);
        await lock(`canvas:${newId}`, async () => {
          await storage.set({ [latestKey(newId)]: v.content, [metaKey(newId)]: meta });
          await updateIndex(conversationId, indexEntry(meta));
        });
        return { id: newId, version: 1, created: true, title: v.title };
      }
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      if (!Number.isInteger(baseVersion)) throw new Error("updating a canvas needs `baseVersion` (the version you last read or wrote)");
      const max = await historyMaxNow();
      const before = await getOne(metaKey(id));
      await ensureBudget(projected(before, { bytes: v.bytes, ...img }, max, before ? before.version + 1 : 0), id, ask || confirmEvict);
      let meta;
      await putImage(v.image);
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (cur.conversationId !== conversationId) throw new Error(`canvas "${id}" belongs to another conversation`);
        if (cur.kind !== v.kind) throw new Error(`canvas "${id}" is ${cur.kind}; a canvas cannot change kind`);
        if (cur.version !== baseVersion) throw await staleFor(cur, baseVersion);
        meta = await storeAgentVersion(cur, { title: v.title, content: v.content, bytes: v.bytes, at, img, max });
      });
      if (v.kind === "image") await sweepAfter();       // an image no version references any more may go
      return { id, version: meta.version, created: false, title: meta.title };
    }

    // The stale error for a write based on `baseVersion` (under the canvas lock), with
    // diffFromBase when that version is still in history (§3.5).
    async function staleFor(cur, baseVersion) {
      return new StaleError(cur, baseVersion, await diffFromBase(cur, baseVersion));
    }

    // Unified diff from version `baseVersion` to the latest (`latest` if already read), or null when
    // that version is not in history (trimmed, or never was). Under the canvas lock.
    async function diffFromBase(cur, baseVersion, latest) {
      const key = contentKey(cur, baseVersion);
      if (!key) return null;
      const got = await storage.get([key, latestKey(cur.id)]);
      if (got[key] == null) return null;
      return unifiedDiff(got[key], latest != null ? latest : (got[latestKey(cur.id)] || ""));
    }

    /**
     * A new version on top of `cur`, under the canvas lock: every save goes through here (§3.5
     * history). `content` becomes the latest and the old latest moves to `canvas:<id>:v:<n>`, both
     * in one set() with the meta (onChanged fires once; a lock-free reader never sees them apart).
     * The history is then trimmed to the last `max` versions, the agent's last write (the new
     * meta's agentVersion) pinned, and the trimmed versions' keys removed. A canvas stored before
     * history migrates here: its agent copy moves from `canvas:<id>:agent` into the history.
     * `fields`: the meta fields this save sets (author, at, bytes, …; patchRanges only from a patch);
     * `img`: the new version's image fields; `latest`: the current latest, if the caller has read
     * it already.
     * @returns the new meta
     */
    async function commit(cur, { content, fields, img, max, latest }) {
      const id = cur.id;
      const version = cur.version + 1;
      const meta = { ...cur, ...fields, version };
      if (!fields.patchRanges) delete meta.patchRanges;
      delete meta.agentBytes;                            // the history has every version's size
      delete meta.walk;                                  // #117's ↶ / ↷ walk state, no longer used
      const legacy = !hasHistory(cur);
      const entry = { v: version, author: meta.author, at: meta.at, bytes: meta.bytes, ...img };
      const { history, dropped } = appendHistory(historyOf(cur), entry, { max, pin: meta.agentVersion });
      const kept = new Set(history.map((h) => h.v));
      const legacyAgent = legacy && cur.agentVersion < cur.version ? cur.agentVersion : null;
      const want = [];
      if (latest === undefined && kept.has(cur.version)) want.push(latestKey(id));
      if (legacyAgent != null && kept.has(legacyAgent)) want.push(agentKey(id));
      const got = want.length ? (await storage.get(want)) || {} : {};
      const items = { [latestKey(id)]: content, [metaKey(id)]: meta };
      if (kept.has(cur.version)) {
        const old = latest !== undefined ? latest : got[latestKey(id)];
        items[versionKey(id, cur.version)] = old == null ? "" : old;
      }
      let hist = history;
      if (legacyAgent != null && kept.has(legacyAgent)) {
        if (got[agentKey(id)] != null) items[versionKey(id, legacyAgent)] = got[agentKey(id)];
        else hist = hist.filter((h) => h.v !== legacyAgent);   // the copy is gone: no entry without content
      }
      meta.history = hist;
      const gone = dropped.filter((v) => v !== cur.version && v !== legacyAgent).map((v) => versionKey(id, v));
      if (legacy) gone.push(agentKey(id));
      await storage.set(items);
      // The version is written: a failed remove must not turn it into an error (the agent would
      // retry and hit stale). It only leaves orphan v:<n> keys, which remove() clears.
      if (gone.length) { try { await storage.remove(gone); } catch (_) { /* best effort */ } }
      await updateIndex(cur.conversationId, indexEntry(meta));
      return meta;
    }

    // An agent version on top of `cur` (under the canvas lock): the next revision, authored by the
    // agent, which the agent has seen; markdown waits for normalization again (§3.5). It is the new
    // agent copy, so it is pinned and the previous agent write trims like any version.
    // ranges: what a canvas_patch changed, in this text (planPatch), kept as meta.patchRanges so the
    // canvas tab glows exactly that (§3.10, #107); any other write drops the previous patch's.
    async function storeAgentVersion(cur, { title, content, bytes, at, ranges, img, max, latest }) {
      const fields = {
        title, author: "agent", at, agentVersion: cur.version + 1, agentSeenVersion: cur.version + 1, bytes,
        normalized: cur.kind !== "markdown",
      };
      if (ranges) fields.patchRanges = ranges;
      return commit(cur, { content, fields, img, max, latest });
    }

    /**
     * canvas_patch (§3.5): find/replace edits on the latest text of a markdown, slides or mermaid canvas, as
     * the agent. All finds are matched against one snapshot of the latest version — not baseVersion
     * — inside the canvas lock, so nothing can change between matching and writing. All apply or
     * none: a miss on a canvas that moved on since baseVersion is `stale` (with diffFromBase), on an
     * up-to-date one a PatchError naming the edit. A user's edit is never overwritten: only the
     * matched ranges change.
     * @returns {Promise<{ id, version, created: false, title, kind, content, ranges, rebasedOver }>}
     *   rebasedOver = { version, author, diffFromBase } of the latest when it was past baseVersion,
     *   else null; diffFromBase as in a stale error (null once baseVersion is out of history).
     */
    async function agentPatch({ conversationId, id, baseVersion, edits, confirmEvict: ask }) {
      if (!conversationId) throw new Error("no conversation to attach the canvas to");
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      if (!Number.isInteger(baseVersion)) throw new Error("canvas_patch needs `baseVersion` (the version you last read or wrote)");
      const list = validatePatchEdits(edits);
      // The budget is checked before the lock (eviction takes other canvases' locks, §3.6 lock
      // order), on a lock-free dry run; a dry run that fails, or a patch the locked run will refuse
      // (another conversation's canvas, an image or html one), needs no room. The locked run can
      // still succeed where the dry run missed (a normalization landing in between): that write
      // skips the budget and may go over by one canvas — a soft cap, as with agentWrite (§3.6).
      const max = await historyMaxNow();
      {
        const got = await storage.get([metaKey(id), latestKey(id)]);
        const m = got[metaKey(id)];
        const patchable = m && m.conversationId === conversationId && PATCH_KINDS.includes(m.kind);
        const dry = patchable ? planPatch(got[latestKey(id)] == null ? "" : got[latestKey(id)], list) : null;
        if (dry && dry.ok) await ensureBudget(projected(m, { bytes: utf8Bytes(dry.text) }, max, m.version + 1), id, ask || confirmEvict);
      }
      let result;
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (cur.conversationId !== conversationId) throw new Error(`canvas "${id}" belongs to another conversation`);
        if (!PATCH_KINDS.includes(cur.kind)) throw new Error(`canvas "${id}" is ${cur.kind}; only markdown, slides and mermaid canvases can be patched`);
        if (baseVersion > cur.version || baseVersion < 1) throw new StaleError(cur, baseVersion, null);
        const latest = (await getOne(latestKey(id))) || "";
        const plan = planPatch(latest, list);
        if (!plan.ok) {
          // A miss after the canvas moved on: rebase on the diff (§3.5), not a bare "no match".
          if (cur.version !== baseVersion) {
            const e = await staleFor(cur, baseVersion);
            e.patch = { index: plan.index, count: plan.count, message: plan.message };
            throw e;
          }
          throw new PatchError(plan);
        }
        const bytes = utf8Bytes(plan.text);
        if (bytes > CONTENT_MAX_BYTES) throw new Error(`the patched content is ${bytes} bytes; a canvas is capped at ${CONTENT_MAX_BYTES}`);
        // Rebased: the result carries what the agent did not write (baseVersion → latest, before this
        // patch), so the agentSeenVersion stored below is true. diffFromBase is null when the base is
        // no longer in history (that text is gone) or the diff is too large; the result then tells
        // the agent to canvas_read.
        const rebasedOver = cur.version === baseVersion ? null
          : { version: cur.version, author: cur.author, diffFromBase: await diffFromBase(cur, baseVersion, latest) };
        const meta = await storeAgentVersion(cur, { title: cur.title, content: plan.text, bytes, at: now(), ranges: plan.ranges, max, latest });
        result = {
          id, version: meta.version, created: false, title: meta.title, kind: meta.kind, content: plan.text, ranges: plan.ranges, rebasedOver,
        };
      });
      return result;
    }

    // asAgent: the agent's canvas_read — records agentSeenVersion (§3.5), so Send to agent does not
    // push edits the agent has already read. Host reads pass nothing.
    async function read({ conversationId, id, asAgent }) {
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      const got = await storage.get([metaKey(id), latestKey(id)]);
      const meta = got[metaKey(id)];
      if (!meta || (conversationId && meta.conversationId !== conversationId)) throw new Error(`no canvas "${id}" in this conversation`);
      if (asAgent && meta.agentSeenVersion !== meta.version) {
        await lock(`canvas:${id}`, async () => {
          const cur = await getOne(metaKey(id));
          if (cur && cur.version === meta.version) await storage.set({ [metaKey(id)]: { ...cur, agentSeenVersion: cur.version } });
        });
      }
      return { ...meta, content: got[latestKey(id)] == null ? "" : got[latestKey(id)] };
    }

    // Send to agent (§3.7): the agent has now been shown up to `version`.
    async function markSeen({ id, version }) {
      if (!ID_RE.test(String(id)) || !Number.isInteger(version)) return;
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (cur && (cur.agentSeenVersion || 0) < version && version <= cur.version) {
          await storage.set({ [metaKey(id)]: { ...cur, agentSeenVersion: version } });
        }
      });
    }

    // The agent's last write (for Revert to agent's and the conflict view): its history entry, the
    // latest while it is the latest. Null if there is no such canvas.
    async function readAgentCopy(id) {
      if (!ID_RE.test(String(id))) return null;
      const meta = await getOne(metaKey(id));
      if (!meta) return null;
      const key = contentKey(meta, meta.agentVersion) || latestKey(id);
      const got = await storage.get([key, latestKey(id)]);
      return got[key] != null ? got[key] : (got[latestKey(id)] == null ? "" : got[latestKey(id)]);
    }

    // The version before the latest (◐ 顯示變更, §3.10) → { version, content }, or null when there
    // is none in history (v1, or trimmed with N = 1). Lock-free like read(): content and meta are
    // written in one set(), so this may only see a version that has just been replaced.
    async function readPrevious(id) {
      if (!ID_RE.test(String(id))) return null;
      const meta = await getOne(metaKey(id));
      const v = previousVersion(meta);
      if (v == null) return null;
      const content = await getOne(contentKey(meta, v));
      return content == null ? null : { version: v, content };
    }

    // A user's explicit save (§3.5). Stale if the canvas moved on since baseVersion; a save equal to
    // the latest creates no version. The version it replaces stays in history; the agent's last
    // write stays pinned.
    async function userSave({ id, baseVersion, content }) {
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      if (typeof content !== "string") throw new Error("`content` must be a string");
      const bytes = utf8Bytes(content);
      if (bytes > CONTENT_MAX_BYTES) throw new Error(`content is ${bytes} bytes; a canvas is capped at ${CONTENT_MAX_BYTES}`);
      const max = await historyMaxNow();
      const before = await getOne(metaKey(id));
      await ensureBudget(projected(before, { bytes }, max, before && before.agentVersion), id);
      let result;
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (cur.kind !== "markdown" && cur.kind !== "slides") throw new Error(`a ${cur.kind} canvas cannot be edited`);
        if (cur.version !== baseVersion) throw new StaleError(cur, baseVersion);
        const stored = await getOne(latestKey(id));
        const latest = stored == null ? "" : stored;
        if (content === latest) { result = { version: cur.version, unchanged: true }; return; }
        const meta = await commit(cur, { content, fields: { author: "user", at: now(), bytes }, max, latest });
        result = { version: meta.version, unchanged: false };
      });
      return result;
    }

    // Revert to agent's (§3.5): the agent's last write becomes the latest again, as a user save (a
    // new version: what it replaces stays in history).
    async function revertToAgent({ id, baseVersion }) {
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      const max = await historyMaxNow();
      const before = await getOne(metaKey(id));
      const agentEntry = before && historyOf(before).find((h) => h.v === before.agentVersion);
      if (agentEntry && before.agentVersion !== before.version) {
        await ensureBudget(projected(before, { bytes: agentEntry.bytes }, max, before.agentVersion), id);
      }
      let result;
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (cur.version !== baseVersion) throw new StaleError(cur, baseVersion);
        const key = contentKey(cur, cur.agentVersion);
        const got = await storage.get(key ? [key, latestKey(id)] : [latestKey(id)]);
        const agent = key ? got[key] : null;
        const latest = got[latestKey(id)] == null ? "" : got[latestKey(id)];
        if (agent == null || agent === latest) { result = { version: cur.version, unchanged: true }; return; }
        const meta = await commit(cur, { content: agent, fields: { author: "user", at: now(), bytes: utf8Bytes(agent) }, max, latest });
        result = { version: meta.version, unchanged: false };
      });
      return result;
    }

    // The editor's normalization of an agent markdown write (§3.5). Applies only to that agent
    // version: its history entry (the agent copy) always — the latest while it still IS that
    // version, else canvas:<id>:v:<n> (or the agent key, before history) — and that entry's size.
    async function applyNormalized({ id, version, normalized }) {
      if (typeof normalized !== "string" || utf8Bytes(normalized) > CONTENT_MAX_BYTES) return { applied: false };
      let result = { applied: false };
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur || cur.kind !== "markdown" || cur.agentVersion !== version || cur.normalized) return;
        const meta = { ...cur, normalized: true };
        delete meta.patchRanges;                        // offsets into the text before normalization
        const items = { [metaKey(id)]: meta };
        const key = contentKey(cur, version);
        const old = key ? await getOne(key) : undefined;
        if (old != null) {
          const bytes = utf8Bytes(normalized);
          items[key] = normalized;
          if (key === latestKey(id)) meta.bytes = bytes;
          if (key === agentKey(id)) meta.agentBytes = bytes;
          if (hasHistory(cur)) meta.history = cur.history.map((h) => (h.v === version ? { ...h, bytes } : h));
        }
        await storage.set(items);
        result = { applied: true, changed: old != null && old !== normalized };
      });
      return result;
    }

    // Remove what incognito panels left in this storage before incognito was dropped (#109).
    // Through remove(), so the index stays consistent; one image sweep after all of them, not one
    // per canvas (#113 review). Returns how many.
    async function removeIncognitoLeftovers() {
      const ids = incognitoLeftovers(await allMetas());
      for (const id of ids) await remove({ id, sweep: false });
      if (ids.length) await sweepAfter();
      return ids.length;
    }

    async function list({ conversationId }) {
      return (await getOne(indexKey(conversationId))) || [];
    }

    // Delete a canvas (#70): its bodies and meta, then its index entry. Same lock order as writes.
    // With conversationId, only a canvas of that conversation. With expectVersion, only if it is
    // still that version (#80): canvas_delete asks the user first, and the canvas may be saved or
    // rewritten while the question waits; the check runs under the same lock as the removal, so
    // nothing can land between them. Returns { removed, version } (version: what is stored now,
    // null when there is no such canvas). sweep: false skips the image sweep, for a caller that
    // removes several and sweeps once after them.
    async function remove({ conversationId, id, expectVersion, sweep = true }) {
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      let result = { removed: false, version: null };
      await lock(`canvas:${id}`, async () => {
        const meta = await getOne(metaKey(id));
        if (!meta) return;
        if (conversationId && meta.conversationId !== conversationId) throw new Error(`no canvas "${id}" in this conversation`);
        result = { removed: false, version: meta.version };
        if (expectVersion != null && meta.version !== expectVersion) return;
        result = { removed: true, version: meta.version };
        // Its whole history (§3.5). With getKeys, also any version key a write left behind when it
        // stopped between storing the new version and removing the trimmed ones.
        const keys = new Set([metaKey(id), latestKey(id), agentKey(id), ...contentKeys(meta)]);
        if (typeof storage.getKeys === "function") {
          const prefix = `canvas:${id}:v:`;
          for (const k of await storage.getKeys()) if (k.startsWith(prefix)) keys.add(k);
        }
        await storage.remove([...keys]);
        await lock("canvas:index", async () => {
          const key = indexKey(meta.conversationId);
          const list = ((await getOne(key)) || []).filter((e) => e.id !== id);
          if (list.length) await storage.set({ [key]: list });
          else await storage.remove(key);
        });
      });
      if (sweep) await sweepAfter();
      return result;
    }

    /**
     * Move a canvas to another conversation (multi-conversation §7.3, the user's choice; no agent
     * tool). Only its conversationId changes — content, history, images and versions stay. Under the
     * canvas's lock (nested canvas:index, as everywhere): `from` must still be its conversation
     * (refused otherwise: someone moved it meanwhile). Both index entries move, and each conversation
     * gets a note for its agent (`out` for `from`, `in` for `to`; one per canvas, the latest) —
     * except `quiet`: the conversation whose agent made the move (katashiro.canvas_move) knows already.
     * → { moved: true, version } | { moved: false } (already there).
     */
    async function move({ id, from, to, quiet = null }) {
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      if (!to || typeof to !== "string") throw new Error("no conversation to move the canvas to");
      let result = { moved: false };
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (from && cur.conversationId !== from) throw new Error(`canvas "${id}" is no longer in that conversation`);
        if (cur.conversationId === to) return;
        const old = cur.conversationId;
        const meta = { ...cur, conversationId: to };
        const at = now();
        await lock("canvas:index", async () => {
          const got = (await storage.get([indexKey(old), indexKey(to), movedKey(old), movedKey(to)])) || {};
          const oldList = (got[indexKey(old)] || []).filter((e) => e.id !== id);
          const newList = (got[indexKey(to)] || []).filter((e) => e.id !== id).concat([indexEntry(meta)]);
          const note = (dir) => ({ id, title: meta.title, kind: meta.kind, version: meta.version, dir, at });
          const notes = (list, dir) => (Array.isArray(list) ? list : []).filter((n) => n && n.id !== id).concat([note(dir)]).slice(-MOVE_NOTES_MAX);
          const set = { [metaKey(id)]: meta, [indexKey(to)]: newList };
          if (quiet !== old) set[movedKey(old)] = notes(got[movedKey(old)], "out");
          if (quiet !== to) set[movedKey(to)] = notes(got[movedKey(to)], "in");
          set[indexKey(old)] = oldList;                  // [] when emptied: cut short before the remove → still right
          await storage.set(set);
          if (!oldList.length) await storage.remove(indexKey(old));
        });
        result = { moved: true, version: meta.version };
      });
      return result;
    }

    /**
     * The agent of `conversationId` has been told about these moves (its prompt was accepted): drop
     * the notes it saw (same id and at), keep any written since.
     */
    async function takeMoveNotes({ conversationId, seen }) {
      const done = new Set((seen || []).map((n) => `${n.id}@${n.at}`));
      await lock("canvas:index", async () => {
        const list = ((await getOne(movedKey(conversationId))) || []).filter((n) => n && !done.has(`${n.id}@${n.at}`));
        if (list.length) await storage.set({ [movedKey(conversationId)]: list });
        else await storage.remove(movedKey(conversationId));
      });
    }

    // The canvas tab was opened (LRU order for eviction). Not a content change: version untouched.
    async function touch(id) {
      if (!ID_RE.test(String(id))) return;
      await lock(`canvas:${id}`, async () => {
        const meta = await getOne(metaKey(id));
        if (meta) await storage.set({ [metaKey(id)]: { ...meta, openedAt: now() } });
      });
    }

    return { markSeen, agentWrite, agentPatch, read, readImage, readAgentCopy, readPrevious, userSave, revertToAgent, applyNormalized, list, remove, removeIncognitoLeftovers, touch, usage, sweepImages, allMetas, move, takeMoveNotes };
  }

  // The canvases an incognito panel stored (#109): only those carry meta.noMirror. They never had
  // mirror files, so nothing in the folder needs touching.
  function incognitoLeftovers(metas) {
    return (metas || []).filter((m) => m && m.noMirror === true && ID_RE.test(String(m.id))).map((m) => m.id);
  }

  function indexEntry(meta) {
    return { id: meta.id, title: meta.title, kind: meta.kind, version: meta.version, bytes: meta.bytes, updatedAt: meta.at };
  }

  const BUDGET_BYTES = 200 * 1024 * 1024;   // §3.6, Brett: start with 200 MB
  // Testing the eviction without filling 200 MB: from the side panel's DevTools console,
  //   chrome.storage.local.set({ "canvas:budgetBytes": 2 * 1024 * 1024 })
  // and chrome.storage.local.remove("canvas:budgetBytes") to go back. Values under 1 MB are ignored;
  // values over 200 MB are capped at 200 MB (the override only lowers the budget). Every scan of
  // canvas:* keys matches exact shapes (cv_ ids, the img: prefix), so none of them sees this key (nor
  // HISTORY_MAX_KEY); a
  // future "delete every canvas:* key" would drop it too, which just restores 200 MB.
  const BUDGET_OVERRIDE_KEY = "canvas:budgetBytes";
  const BUDGET_OVERRIDE_MIN = 1024 * 1024;

  return { createCanvasStore, incognitoLeftovers,
    historyLimit, historyOf, contentKey, contentKeys, previousVersion, appendHistory, historyFootprint, footprint,
    HISTORY_MAX_KEY, HISTORY_DEFAULT, HISTORY_MIN, HISTORY_MAX, HTML_MAX_BYTES, HTML_ENABLED_KEY, htmlEnabled, DIAGRAM_ENGINE_KEY, diagramEngine, PELE_NOTICE_KEY, contentCap, versionKey, unifiedDiff, planPatch, validatePatchEdits, PatchError, PATCH_EDITS_MAX, PATCH_FIND_MAX, PATCH_REPLACE_MAX, agentKey, getMatching, IMAGE_MIME_TYPES, IMAGE_MAX_BYTES, imageKey, sha256OfBase64, StaleError, QuotaError, BUDGET_BYTES, BUDGET_OVERRIDE_KEY, BUDGET_OVERRIDE_MIN, KINDS, TITLE_MAX, CONTENT_MAX_BYTES, ID_RE, metaKey, latestKey, indexKey, movedKey, MOVE_NOTES_MAX };
});
