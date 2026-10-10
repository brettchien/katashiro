// canvas-store.js — persistence for Katashiro canvases (ADR docs/adr/canvas.md §3.5, §3.6).
//
// A canvas keeps no version history: only its latest content plus a revision counter (`version`)
// and the version the agent last wrote (`agentVersion`). The MVP stores agent writes only, so the
// latest content IS the agent's last write; the separate `agent` body (§3.6) arrives with user
// editing. Keys, all in one chrome.storage area:
//   canvas:<conversationId>:index  [{ id, title, kind, version, bytes, updatedAt }]
//   canvas:<id>:meta               { id, conversationId, title, kind, version, author, at, agentVersion, bytes, agentBytes }
//   canvas:<id>:latest             the latest content (string)
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

  const KINDS = ["markdown", "slides", "image"];   // phase 1; chart / mermaid / html follow
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
  const ID_RE = /^cv_[0-9a-f]{12}$/;

  const indexKey = (conversationId) => `canvas:${conversationId}:index`;
  const metaKey = (id) => `canvas:${id}:meta`;
  const latestKey = (id) => `canvas:${id}:latest`;
  // The agent's last write, kept only once the latest differs from it (a user save, §3.5/§3.6).
  // Invariant: no agent key ⇒ the latest IS the agent's last write.
  const agentKey = (id) => `canvas:${id}:agent`;

  function utf8Bytes(s) {
    return new TextEncoder().encode(s).length;
  }

  // A stale write: the canvas moved on since the caller's baseVersion (§3.5). A structured error,
  // not the whole document; `diffFromBase` arrives with user editing (MVP has one writer kind).
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
   * @param {number} [deps.budgetBytes]  total canvas bytes allowed (default 200 MB, §3.6)
   * @param {(id: string) => Promise<boolean>} [deps.isOpen]  is this canvas open in a tab (never evicted)
   * @param {(info: { needed: number, evict: object[] }) => Promise<boolean>} [deps.confirmEvict]
   *        asked once when a write would go over budget; true = remove `evict` and write
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
    const budgetBytes = deps.budgetBytes || BUDGET_BYTES;
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
    // markdown / slides: `content` is the text. image: `image` = { mimeType, data (base64) } plus an
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
      if (bytes > CONTENT_MAX_BYTES) throw new Error(`content is ${bytes} bytes; a canvas is capped at ${CONTENT_MAX_BYTES}`);
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

    // Mark-and-sweep (§3.6): delete images no image canvas references, except ones written in the
    // last 10 minutes (a write referencing them may still be on its way). Under canvas:index.
    async function sweepImages() {
      await lock("canvas:index", async () => {
        const metas = await getMatching(storage, (k) => /^canvas:cv_[0-9a-f]{12}:meta$/.test(k));
        const imageIds = Object.values(metas).filter((m) => m && m.kind === "image").map((m) => m.id);
        const bodies = imageIds.length ? (await storage.get(imageIds.map(latestKey))) || {} : {};
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

    // Every canvas's meta, across conversations (for the budget). Reads only the meta keys.
    async function allMetas() {
      const all = await getMatching(storage, (k) => /^canvas:cv_[0-9a-f]{12}:meta$/.test(k));
      return Object.values(all).filter((v) => v && typeof v === "object");
    }

    // What a canvas takes: the latest plus the agent copy kept beside it after a user save.
    const footprint = (m) => (m.bytes || 0) + (m.agentBytes || 0);

    async function usage() {
      const metas = await allMetas();
      return { total: metas.reduce((n, m) => n + footprint(m), 0), count: metas.length };
    }

    // Make room for `addBytes` more (minus what the canvas being rewritten already uses). Over
    // budget: least recently opened first, never one open in a tab nor the one being written, and
    // only after one confirmation. Throws QuotaError if declined or if that cannot free enough.
    async function ensureBudget(addBytes, keepId) {
      const metas = await allMetas();
      const total = metas.reduce((n, m) => n + footprint(m), 0);
      const mine = metas.find((m) => m.id === keepId);
      const own = mine ? footprint(mine) : 0;
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
        evict.push({ id: m.id, title: m.title, bytes: footprint(m), conversationId: m.conversationId });
        freed += footprint(m);
      }
      if (freed < over || !(await confirmEvict({ needed: over, evict }))) throw new QuotaError(over, budgetBytes);
      // The confirmation waits on the user; a canvas opened meanwhile is kept (the write may then
      // run slightly over budget — it is a soft cap).
      for (const e of evict) if (!(await isOpen(e.id))) await remove({ id: e.id });
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
    async function agentWrite({ conversationId, id, baseVersion, title, kind, content, image, caption }) {
      if (!conversationId) throw new Error("no conversation to attach the canvas to");
      const v = await validate({ title, kind, content, image, caption });
      const at = now();
      await ensureBudget(v.bytes, id || null);
      if (id == null || id === "") {
        const newId = `cv_${randomHex()}`;
        const meta = {
          id: newId, conversationId, title: v.title, kind: v.kind,
          version: 1, author: "agent", at, agentVersion: 1, agentSeenVersion: 1, bytes: v.bytes, agentBytes: 0,
          normalized: v.kind !== "markdown",               // markdown waits for the editor's normalization
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
      let meta;
      await putImage(v.image);
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (cur.conversationId !== conversationId) throw new Error(`canvas "${id}" belongs to another conversation`);
        if (cur.kind !== v.kind) throw new Error(`canvas "${id}" is ${cur.kind}; a canvas cannot change kind`);
        if (cur.version !== baseVersion) {
          // diffFromBase exists only when the base is the agent's own last write (§3.5).
          let diff = null;
          if (baseVersion === cur.agentVersion) {
            const got = await storage.get([agentKey(id), latestKey(id)]);
            if (got[agentKey(id)] != null) diff = unifiedDiff(got[agentKey(id)], got[latestKey(id)] || "");
          }
          throw new StaleError(cur, baseVersion, diff);
        }
        meta = {
          ...cur, title: v.title, version: cur.version + 1, author: "agent", at, agentVersion: cur.version + 1,
          agentSeenVersion: cur.version + 1, bytes: v.bytes, agentBytes: 0, normalized: v.kind !== "markdown",
        };
        await storage.set({ [latestKey(id)]: v.content, [metaKey(id)]: meta });
        await storage.remove(agentKey(id));                // the latest is the agent's write again
        await updateIndex(conversationId, indexEntry(meta));
      });
      if (v.kind === "image") await sweepAfter();       // the previous image may be unreferenced now
      return { id, version: meta.version, created: false, title: meta.title };
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

    // The agent's last write (for Revert to agent's and the conflict view). Null if gone.
    async function readAgentCopy(id) {
      if (!ID_RE.test(String(id))) return null;
      const got = await storage.get([metaKey(id), latestKey(id), agentKey(id)]);
      if (!got[metaKey(id)]) return null;
      return got[agentKey(id)] != null ? got[agentKey(id)] : (got[latestKey(id)] == null ? "" : got[latestKey(id)]);
    }

    // A user's explicit save (§3.5). Stale if the canvas moved on since baseVersion; a save equal to
    // the latest creates no version. The first user save keeps the agent's text as the agent copy.
    async function userSave({ id, baseVersion, content }) {
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      if (typeof content !== "string") throw new Error("`content` must be a string");
      const bytes = utf8Bytes(content);
      if (bytes > CONTENT_MAX_BYTES) throw new Error(`content is ${bytes} bytes; a canvas is capped at ${CONTENT_MAX_BYTES}`);
      // Afterwards the canvas holds this save plus an agent copy: the one it has, or (first save)
      // the current latest, which becomes the copy.
      const before = ID_RE.test(String(id)) ? await getOne(metaKey(id)) : null;
      await ensureBudget(bytes + (before ? (before.agentBytes || before.bytes || 0) : 0), id);
      let result;
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (cur.kind !== "markdown" && cur.kind !== "slides") throw new Error(`a ${cur.kind} canvas cannot be edited`);
        if (cur.version !== baseVersion) throw new StaleError(cur, baseVersion);
        const got = await storage.get([latestKey(id), agentKey(id)]);
        const latest = got[latestKey(id)] == null ? "" : got[latestKey(id)];
        if (content === latest) { result = { version: cur.version, unchanged: true }; return; }
        const meta = { ...cur, version: cur.version + 1, author: "user", at: now(), bytes };
        const items = { [latestKey(id)]: content, [metaKey(id)]: meta };
        if (got[agentKey(id)] == null) {                                 // keep the agent's write
          items[agentKey(id)] = latest;
          meta.agentBytes = utf8Bytes(latest);
        }
        await storage.set(items);
        await updateIndex(cur.conversationId, indexEntry(meta));
        result = { version: meta.version, unchanged: false };
      });
      return result;
    }

    // Revert to agent's (§3.5): the agent's last write becomes the latest again, as a user save.
    async function revertToAgent({ id, baseVersion }) {
      let result;
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (cur.version !== baseVersion) throw new StaleError(cur, baseVersion);
        const got = await storage.get([latestKey(id), agentKey(id)]);
        const agent = got[agentKey(id)];
        if (agent == null || agent === got[latestKey(id)]) { result = { version: cur.version, unchanged: true }; return; }
        const meta = { ...cur, version: cur.version + 1, author: "user", at: now(), bytes: utf8Bytes(agent) };
        await storage.set({ [latestKey(id)]: agent, [metaKey(id)]: meta });
        await updateIndex(cur.conversationId, indexEntry(meta));
        result = { version: meta.version, unchanged: false };
      });
      return result;
    }

    // The editor's normalization of an agent markdown write (§3.5). Applies only to that agent
    // version: the agent copy always; the latest only while it still IS that version.
    async function applyNormalized({ id, version, normalized }) {
      if (typeof normalized !== "string" || utf8Bytes(normalized) > CONTENT_MAX_BYTES) return { applied: false };
      let result = { applied: false };
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur || cur.kind !== "markdown" || cur.agentVersion !== version || cur.normalized) return;
        const got = await storage.get([latestKey(id), agentKey(id)]);
        const items = { [metaKey(id)]: { ...cur, normalized: true } };
        if (got[agentKey(id)] != null) {
          items[agentKey(id)] = normalized;
          items[metaKey(id)].agentBytes = utf8Bytes(normalized);
        } else if (cur.version === version) {
          items[latestKey(id)] = normalized;
          items[metaKey(id)].bytes = utf8Bytes(normalized);
        }
        await storage.set(items);
        result = { applied: true, changed: (got[agentKey(id)] != null ? got[agentKey(id)] : got[latestKey(id)]) !== normalized };
      });
      return result;
    }

    async function list({ conversationId }) {
      return (await getOne(indexKey(conversationId))) || [];
    }

    // Delete a canvas (#70): its bodies and meta, then its index entry. Same lock order as writes.
    // With conversationId, only a canvas of that conversation.
    async function remove({ conversationId, id }) {
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      await lock(`canvas:${id}`, async () => {
        const meta = await getOne(metaKey(id));
        if (!meta) return;
        if (conversationId && meta.conversationId !== conversationId) throw new Error(`no canvas "${id}" in this conversation`);
        await storage.remove([metaKey(id), latestKey(id), agentKey(id)]);
        await lock("canvas:index", async () => {
          const key = indexKey(meta.conversationId);
          const list = ((await getOne(key)) || []).filter((e) => e.id !== id);
          if (list.length) await storage.set({ [key]: list });
          else await storage.remove(key);
        });
      });
      await sweepAfter();
    }

    // The canvas tab was opened (LRU order for eviction). Not a content change: version untouched.
    async function touch(id) {
      if (!ID_RE.test(String(id))) return;
      await lock(`canvas:${id}`, async () => {
        const meta = await getOne(metaKey(id));
        if (meta) await storage.set({ [metaKey(id)]: { ...meta, openedAt: now() } });
      });
    }

    return { markSeen, agentWrite, read, readImage, readAgentCopy, userSave, revertToAgent, applyNormalized, list, remove, touch, usage, sweepImages };
  }

  function indexEntry(meta) {
    return { id: meta.id, title: meta.title, kind: meta.kind, version: meta.version, bytes: meta.bytes, updatedAt: meta.at };
  }

  const BUDGET_BYTES = 200 * 1024 * 1024;   // §3.6, Brett: start with 200 MB

  return { createCanvasStore, unifiedDiff, agentKey, getMatching, IMAGE_MIME_TYPES, IMAGE_MAX_BYTES, imageKey, sha256OfBase64, StaleError, QuotaError, BUDGET_BYTES, KINDS, TITLE_MAX, CONTENT_MAX_BYTES, ID_RE, metaKey, latestKey, indexKey };
});
