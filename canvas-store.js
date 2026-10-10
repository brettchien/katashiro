// canvas-store.js — persistence for Katashiro canvases (ADR docs/adr/canvas.md §3.5, §3.6).
//
// A canvas keeps no version history: only its latest content plus a revision counter (`version`)
// and the version the agent last wrote (`agentVersion`). The MVP stores agent writes only, so the
// latest content IS the agent's last write; the separate `agent` body (§3.6) arrives with user
// editing. Keys, all in one chrome.storage area:
//   canvas:<conversationId>:index  [{ id, title, kind, version, bytes, updatedAt }]
//   canvas:<id>:meta               { id, conversationId, title, kind, version, author, at, agentVersion, bytes }
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

  const KINDS = ["markdown"];               // MVP; slides / image / chart / mermaid / html follow
  const TITLE_MAX = 120;
  const CONTENT_MAX_BYTES = 2 * 1024 * 1024; // §3.4: 2 MB text per canvas
  const ID_RE = /^cv_[0-9a-f]{12}$/;

  const indexKey = (conversationId) => `canvas:${conversationId}:index`;
  const metaKey = (id) => `canvas:${id}:meta`;
  const latestKey = (id) => `canvas:${id}:latest`;

  function utf8Bytes(s) {
    return new TextEncoder().encode(s).length;
  }

  // A stale write: the canvas moved on since the caller's baseVersion (§3.5). A structured error,
  // not the whole document; `diffFromBase` arrives with user editing (MVP has one writer kind).
  class StaleError extends Error {
    constructor(meta, baseVersion) {
      super(`canvas "${meta.title}" is at version ${meta.version}, not ${baseVersion} — call canvas_read and write on top of the latest`);
      this.code = "stale";
      this.currentVersion = meta.version;
      this.author = meta.author;
    }
  }

  /**
   * @param {object} deps
   * @param {{ get(keys): Promise<object>, set(items): Promise<void> }} deps.storage  chrome.storage.local
   * @param {(name: string, fn: () => Promise<any>) => Promise<any>} deps.lock
   * @param {() => number} [deps.now]
   * @param {() => string} [deps.randomHex]  12 hex chars for a new id
   */
  function createCanvasStore(deps) {
    const storage = deps.storage;
    const lock = deps.lock;
    const now = deps.now || (() => Date.now());
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
    function validate({ title, kind, content }) {
      const t = title == null ? "" : String(title).trim();
      if (!t) throw new Error("`title` is required");
      if (t.length > TITLE_MAX) throw new Error(`title is ${t.length} chars; keep it to ${TITLE_MAX} or fewer`);
      const k = kind == null ? "markdown" : String(kind);
      if (!KINDS.includes(k)) throw new Error(`kind "${k}" is not supported yet (supported: ${KINDS.join(", ")})`);
      if (typeof content !== "string") throw new Error("`content` must be a string");
      const bytes = utf8Bytes(content);
      if (bytes > CONTENT_MAX_BYTES) throw new Error(`content is ${bytes} bytes; a canvas is capped at ${CONTENT_MAX_BYTES}`);
      return { title: t, kind: k, content, bytes };
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
    async function agentWrite({ conversationId, id, baseVersion, title, kind, content }) {
      if (!conversationId) throw new Error("no conversation to attach the canvas to");
      const v = validate({ title, kind, content });
      const at = now();
      if (id == null || id === "") {
        const newId = `cv_${randomHex()}`;
        const meta = {
          id: newId, conversationId, title: v.title, kind: v.kind,
          version: 1, author: "agent", at, agentVersion: 1, bytes: v.bytes,
        };
        await lock(`canvas:${newId}`, async () => {
          await storage.set({ [latestKey(newId)]: v.content, [metaKey(newId)]: meta });
          await updateIndex(conversationId, indexEntry(meta));
        });
        return { id: newId, version: 1, created: true, title: v.title };
      }
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      if (!Number.isInteger(baseVersion)) throw new Error("updating a canvas needs `baseVersion` (the version you last read or wrote)");
      let meta;
      await lock(`canvas:${id}`, async () => {
        const cur = await getOne(metaKey(id));
        if (!cur) throw new Error(`no canvas "${id}"`);
        if (cur.conversationId !== conversationId) throw new Error(`canvas "${id}" belongs to another conversation`);
        if (cur.kind !== v.kind) throw new Error(`canvas "${id}" is ${cur.kind}; a canvas cannot change kind`);
        if (cur.version !== baseVersion) throw new StaleError(cur, baseVersion);
        meta = { ...cur, title: v.title, version: cur.version + 1, author: "agent", at, agentVersion: cur.version + 1, bytes: v.bytes };
        await storage.set({ [latestKey(id)]: v.content, [metaKey(id)]: meta });
        await updateIndex(conversationId, indexEntry(meta));
      });
      return { id, version: meta.version, created: false, title: meta.title };
    }

    async function read({ conversationId, id }) {
      if (!ID_RE.test(String(id))) throw new Error(`"${id}" is not a canvas id`);
      const got = await storage.get([metaKey(id), latestKey(id)]);
      const meta = got[metaKey(id)];
      if (!meta || (conversationId && meta.conversationId !== conversationId)) throw new Error(`no canvas "${id}" in this conversation`);
      return { ...meta, content: got[latestKey(id)] == null ? "" : got[latestKey(id)] };
    }

    async function list({ conversationId }) {
      return (await getOne(indexKey(conversationId))) || [];
    }

    return { agentWrite, read, list };
  }

  function indexEntry(meta) {
    return { id: meta.id, title: meta.title, kind: meta.kind, version: meta.version, bytes: meta.bytes, updatedAt: meta.at };
  }

  return { createCanvasStore, StaleError, KINDS, TITLE_MAX, CONTENT_MAX_BYTES, ID_RE, metaKey, latestKey, indexKey };
});
