// canvas-mirror.js — the optional local folder mirror of canvases (ADR docs/adr/canvas.md §3.6).
//
// Storage stays the working copy; the folder (picked in Settings, File System Access) gets the
// latest content of every canvas as a plain file, so the user can put it under git / Dropbox /
// Time Machine. Write-through, never clobbering outside edits:
//   <folder>/<conversation-slug>/<canvas-slug>.md            markdown and slides as stored;
//                                                            image canvases as a one-line ![](…)
//   <folder>/<conversation-slug>/<canvas-slug>.assets/<sha256>.<ext>   png / jpg / gif / webp only
//   <folder>/.katashiro/<canvasId>.json                      informational, never read
//
// Paths come only from the slugs kept in the canvas meta (`meta.file`), never from the folder, and
// every read / write / remove is checked against exactly those patterns first. Before writing, the
// file on disk is hashed and compared with the hash Katashiro last wrote there: same (or no file)
// → overwrite; different → leave it and write `<canvas-slug>.katashiro-<UTC time>.md` beside it.
//
// The decisions are pure functions (slugify, planWrite, isAllowedPath, …); the File System Access
// calls are a few thin helpers over a directory handle, so tests run them on a fake handle. Files are
// written under the canvas's own `canvas:<id>` lock (storage first, then the file: callers sync
// after their storage write), and slugs are assigned under `canvas:index` nested inside it (the
// store's lock order). A mirroring failure is recorded in meta.file.state, never thrown at a save.
//
// Dual target like canvas-store.js: classic <script> (globalThis.CanvasMirror) and require() in tests.
(function (root, factory) {
  const isNode = typeof module !== "undefined" && module.exports;
  const mod = factory(isNode ? require("./canvas-store.js") : root.CanvasStore);
  if (isNode) module.exports = mod;
  else root.CanvasMirror = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (CanvasStore) {
  "use strict";

  // --- Slugs (§3.6) ------------------------------------------------------------------------------
  // Lower-case; only [a-z0-9_-] and CJK; anything else becomes "-"; never starting with "."; not a
  // reserved name; ≤ 80 characters (and ≤ 160 UTF-8 bytes, so "<slug>.katashiro-<time>-N.md" stays
  // under the 255-byte file name limit of common file systems); empty → "canvas".
  const SLUG_MAX = 80;
  const SLUG_MAX_BYTES = 160;
  const SLUG_CHARS = "a-z0-9_\\-\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}";
  const NOT_SLUG_RE = new RegExp(`[^${SLUG_CHARS}]+`, "gu");
  const SLUG_RE = new RegExp(`^[${SLUG_CHARS}]+$`, "u");
  const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
  const FORBIDDEN = new Set([".git", ".katashiro", "node_modules"]);
  const ID_RE = /^cv_[0-9a-f]{12}$/;
  const HASH_RE = /^[0-9a-f]{64}$/;
  const ASSET_EXTS = ["png", "jpg", "gif", "webp"];

  const utf8 = (s) => new TextEncoder().encode(s);
  const utf8Len = (s) => utf8(s).length;

  function clip(s, maxChars, maxBytes) {
    const cps = Array.from(s).slice(0, Math.max(0, maxChars));
    while (cps.length && utf8Len(cps.join("")) > maxBytes) cps.pop();
    return cps.join("");
  }

  function isReserved(s) {
    return WINDOWS_RESERVED.test(s) || FORBIDDEN.has(s);
  }

  /** A slug from untrusted text (a canvas title from the agent, a conversation id). */
  function slugify(text, fallback = "canvas") {
    let s = String(text == null ? "" : text).normalize("NFKC").toLowerCase()
      .replace(NOT_SLUG_RE, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
    s = clip(s, SLUG_MAX, SLUG_MAX_BYTES).replace(/-+$/, "");
    if (!s) s = fallback;
    if (isReserved(s)) s = `${s}-canvas`;
    return s;
  }

  function isValidSlug(s) {
    return typeof s === "string" && SLUG_RE.test(s) && !s.startsWith(".") && !isReserved(s) &&
      Array.from(s).length <= SLUG_MAX && utf8Len(s) <= SLUG_MAX_BYTES;
  }

  /** `base`, or base-2, base-3, … — the first not in `taken`, still within the length caps. */
  function uniqueSlug(base, taken) {
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = `-${n}`;
      const s = clip(base, SLUG_MAX - suffix.length, SLUG_MAX_BYTES - suffix.length).replace(/-+$/, "") + suffix;
      if (!taken.has(s)) return s;
    }
  }

  // --- Paths (§3.6: computed from meta, checked before every touch) -----------------------------
  function stamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }

  /** `<slug>.katashiro-<YYYYMMDDTHHMMSSZ>[-N].md` — the file written beside an outside-edited one. */
  function conflictFileName(slug, ms, n = 1) {
    return `${slug}.katashiro-${stamp(ms)}${n > 1 ? `-${n}` : ""}.md`;
  }

  const CONFLICT_TAIL_RE = /^\d{8}T\d{6}Z(-\d{1,3})?\.md$/;

  function mdPath({ convSlug, slug }) { return [convSlug, `${slug}.md`]; }
  function assetPath({ convSlug, slug }, name) { return [convSlug, `${slug}.assets`, name]; }
  function jsonPath({ id }) { return [".katashiro", `${id}.json`]; }

  /**
   * The only paths a canvas may touch: its .md, its conflict files, its assets, its json. `ctx` is
   * { id, convSlug, slug } from storage; anything else (another canvas's file, .git/…, a nested
   * path, a bad slug) is refused.
   */
  function isAllowedPath(segs, ctx) {
    if (!Array.isArray(segs) || !segs.every((s) => typeof s === "string" && s)) return false;
    if (!ctx || !ID_RE.test(String(ctx.id)) || !isValidSlug(ctx.convSlug) || !isValidSlug(ctx.slug)) return false;
    if (segs.length === 2 && segs[0] === ".katashiro") return segs[1] === `${ctx.id}.json`;
    if (segs[0] !== ctx.convSlug) return false;
    if (segs.length === 2) {
      if (segs[1] === `${ctx.slug}.md`) return true;
      const head = `${ctx.slug}.katashiro-`;
      return segs[1].startsWith(head) && CONFLICT_TAIL_RE.test(segs[1].slice(head.length));
    }
    if (segs.length === 3) {
      return segs[1] === `${ctx.slug}.assets` && new RegExp(`^[0-9a-f]{64}\\.(${ASSET_EXTS.join("|")})$`).test(segs[2]);
    }
    return false;
  }

  // --- Decisions ---------------------------------------------------------------------------------
  const NOT_A_FILE = "not-a-file";      // something other than a file sits at the path

  /**
   * Write-through for one file (§3.6). diskHash: sha256 of what is on disk now (null = nothing,
   * NOT_A_FILE = a directory); lastHash: what Katashiro last wrote there (null = never); newHash:
   * what it would write now.
   *   write    — no file, or still exactly what we wrote (missing: we had written it, it is gone)
   *   adopt    — the disk already holds exactly this content: nothing to write
   *   conflict — changed outside Katashiro, or a file we never wrote: leave it, write beside it
   */
  function planWrite({ diskHash, lastHash, newHash }) {
    if (diskHash == null) return { action: "write", missing: lastHash != null };
    if (diskHash === newHash) return { action: "adopt" };
    if (lastHash != null && diskHash === lastHash) return { action: "write" };
    return { action: "conflict" };
  }

  /** What the file on disk is now, against what we last wrote (detection only; nothing is read in). */
  function fileState({ diskHash, lastHash }) {
    if (diskHash == null) return lastHash != null ? "missing" : "absent";
    return diskHash === lastHash ? "ok" : "changed";
  }

  // The meta fields this module owns; a meta change touching only these is not a content change.
  const FILE_FIELDS = ["file", "fileSyncedVersion"];
  function onlyMirrorFieldsChanged(a, b) {
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (FILE_FIELDS.includes(k)) continue;
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
    }
    return true;
  }

  // Image type by magic bytes, never by a declared MIME type. SVG (and anything else) → null: it is
  // never written as a file (opened from file:// it would run script).
  function sniffImageExt(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "gif";
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
    return null;
  }

  // The .md for an image canvas: the image by relative link, the caption as a paragraph.
  function imageMarkdown({ slug, assetName, caption, kept }) {
    const cap = String(caption == null ? "" : caption).replace(/[\r\n]+/g, " ").trim();
    if (assetName) {
      const alt = cap.replace(/[[\]\\]/g, " ").slice(0, 200);
      return `![${alt}](${slug}.assets/${assetName})\n${cap ? `\n${cap}\n` : ""}`;
    }
    return `${cap ? `${cap}\n\n` : ""}_(${kept})_\n`;
  }

  /** Header text for a canvas's mirror state; null when there is nothing to say. */
  function describeState(file) {
    if (!file) return null;
    switch (file.state) {
      case "ok": return { level: "ok", text: "📁 已存到資料夾", title: "最新內容已寫進資料夾" };
      case "recreated": return { level: "warn", text: "📁 檔案被刪過，已重新寫入", title: "資料夾裡的檔案在 Katashiro 外被刪除；畫布不受影響，已用最新內容重新寫入" };
      case "missing": return { level: "warn", text: "📁 資料夾裡的檔案不見了", title: "資料夾裡的檔案在 Katashiro 外被刪除；畫布不受影響，下次儲存會重新寫入" };
      case "changed": return {
        level: "warn", text: "📁 檔案在 Katashiro 外被修改過",
        title: file.conflictName
          ? `The file was changed outside Katashiro — 沒有覆寫它；最新內容另存成 ${file.conflictName}`
          : "The file was changed outside Katashiro — 下次儲存不會覆寫它，會另存一個 .katashiro-<時間>.md",
      };
      case "error": return { level: "warn", text: "📁 寫入資料夾失敗", title: String(file.error || "") };
      default: return null;
    }
  }

  // --- File System Access, thin (a FileSystemDirectoryHandle or a test fake) ---------------------
  const errName = (e) => (e && e.name) || "";

  async function walk(root, dirs, create) {
    let d = root;
    for (const name of dirs) d = await d.getDirectoryHandle(name, { create });
    return d;
  }

  async function readBytes(root, segs) {
    try {
      const dir = await walk(root, segs.slice(0, -1), false);
      const fh = await dir.getFileHandle(segs[segs.length - 1]);
      const f = await fh.getFile();
      return new Uint8Array(await f.arrayBuffer());
    } catch (e) {
      if (errName(e) === "NotFoundError") return null;
      if (errName(e) === "TypeMismatchError") return NOT_A_FILE;
      throw e;
    }
  }

  async function writeBytes(root, segs, bytes) {
    const dir = await walk(root, segs.slice(0, -1), true);
    const fh = await dir.getFileHandle(segs[segs.length - 1], { create: true });
    const w = await fh.createWritable();           // writes a swap file, moved into place on close
    try {
      await w.write(bytes);
      await w.close();
    } catch (e) {
      try { await w.abort(); } catch (_) { /* already closed */ }
      throw e;
    }
  }

  async function removeFile(root, segs) {
    const dir = await walk(root, segs.slice(0, -1), false);
    await dir.removeEntry(segs[segs.length - 1]);
  }

  async function defaultSha256(bytes) {
    const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
  }

  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  const ERROR_MAX = 200;

  /**
   * @param {object} deps
   * @param {{ get, set }} deps.storage       chrome.storage.local (the canvas store's area)
   * @param {(name, fn) => Promise} deps.lock  navigator.locks.request (tests: an in-process lock)
   * @param {() => Promise<{ dir, folderId } | null>} deps.getRoot  the folder, only if write access
   *        is granted now (no prompt); null = no folder or not connected → nothing is written
   * @param {() => number} [deps.now]
   * @param {(bytes: Uint8Array) => Promise<string>} [deps.sha256]
   */
  function createCanvasMirror(deps) {
    const storage = deps.storage;
    const lock = deps.lock;
    const now = deps.now || (() => Date.now());
    const sha256 = deps.sha256 || defaultSha256;
    const metaKey = CanvasStore.metaKey;
    const latestKey = CanvasStore.latestKey;

    async function getOne(key) {
      const got = await storage.get(key);
      return got ? got[key] : undefined;
    }

    function guard(segs, ctx) {
      if (!isAllowedPath(segs, ctx)) throw new Error(`refused: ${segs.join("/")} is not this canvas's mirror path`);
    }

    async function hashAt(dir, segs, ctx) {
      guard(segs, ctx);
      const b = await readBytes(dir, segs);
      if (b === null) return null;
      if (b === NOT_A_FILE) return NOT_A_FILE;
      return sha256(b);
    }

    async function writeAt(dir, segs, bytes, ctx) {
      guard(segs, ctx);
      await writeBytes(dir, segs, bytes);
    }

    async function removeAt(dir, segs, ctx) {
      guard(segs, ctx);
      await removeFile(dir, segs);
    }

    // Slugs for this canvas in this folder, reserved at once under canvas:index (the caller holds
    // canvas:<id>), so two canvases cannot take the same one. A conversation keeps one slug.
    async function assignSlugs(id, folderId, prev) {
      return lock("canvas:index", async () => {
        const cur = await getOne(metaKey(id));
        const all = Object.values(await CanvasStore.getMatching(storage, (k) => /^canvas:cv_[0-9a-f]{12}:meta$/.test(k)));
        const others = all.filter((m) => m && m.id !== id && m.file && m.file.folder === folderId && isValidSlug(m.file.convSlug));
        let convSlug = prev && isValidSlug(prev.convSlug) ? prev.convSlug : null;
        if (!convSlug) {
          const sibling = others.find((m) => m.conversationId === cur.conversationId);
          if (sibling) convSlug = sibling.file.convSlug;
        }
        if (!convSlug) {
          const takenConv = new Set(others.filter((m) => m.conversationId !== cur.conversationId).map((m) => m.file.convSlug));
          convSlug = uniqueSlug(slugify(cur.conversationId, "conversation"), takenConv);
        }
        const slugBase = slugify(cur.title);
        const taken = new Set(others.filter((m) => m.file.convSlug === convSlug).map((m) => m.file.slug));
        const slug = uniqueSlug(slugBase, taken);
        const same = prev && prev.slug === slug && prev.convSlug === convSlug;
        const file = {
          folder: folderId, convSlug, slug, slugBase,
          hash: same ? prev.hash : null,               // a new path: Katashiro never wrote there
          syncedHash: null, jsonHash: prev ? prev.jsonHash || null : null,
          conflictName: null, conflictHash: null, state: prev ? prev.state : undefined,
        };
        await storage.set({ [metaKey(id)]: { ...cur, file } });
        return file;
      });
    }

    // What goes to disk for this canvas: the .md text, and for an image canvas its asset.
    async function renderFile(meta, content, slug) {
      if (meta.kind !== "image") return { text: String(content) };
      let ref = null;
      try { ref = JSON.parse(content); } catch (_) { /* broken ref */ }
      const caption = ref && ref.caption;
      const img = ref && HASH_RE.test(String(ref.image)) ? await getOne(CanvasStore.imageKey(ref.image)) : null;
      if (!img || typeof img.data !== "string") return { text: imageMarkdown({ slug, caption, kept: "the image is missing from Katashiro's storage" }) };
      const bytes = b64ToBytes(img.data);
      const ext = sniffImageExt(bytes);
      if (!ext) return { text: imageMarkdown({ slug, caption, kept: "this image (SVG or an unknown format) is kept in Katashiro only, never written as a file" }) };
      const hash = await sha256(bytes);
      const assetName = `${hash}.${ext}`;
      return { text: imageMarkdown({ slug, assetName, caption }), asset: { name: assetName, bytes, hash } };
    }

    // Record the mirror fields in meta (under the canvas lock the caller holds), only if they changed,
    // so a sync that changes nothing does not fire storage.onChanged again.
    async function saveFile(id, file, syncedVersion) {
      const cur = await getOne(metaKey(id));
      if (!cur) return;
      const clean = {};
      for (const [k, v] of Object.entries(file)) if (v !== undefined) clean[k] = v;
      if (JSON.stringify(cur.file) === JSON.stringify(clean) && cur.fileSyncedVersion === syncedVersion) return;
      const next = { ...cur, file: clean };
      if (syncedVersion !== undefined) next.fileSyncedVersion = syncedVersion;
      await storage.set({ [metaKey(id)]: next });
    }

    /**
     * Mirror one canvas's latest content to the folder, if it changed since the last sync. Never
     * throws for a mirroring problem: the result says what happened ({ action: "skipped" |
     * "disconnected" | "none" | "write" | "adopt" | "conflict" | "error", state }).
     * check: also look at the file when nothing needs writing (canvas tab open), to notice an
     * outside change or deletion. Nothing is ever read back into the canvas.
     */
    async function sync(id, { check = false } = {}) {
      if (!ID_RE.test(String(id))) return { action: "skipped" };
      const root = await deps.getRoot();
      if (!root) return { action: "disconnected" };
      return lock(`canvas:${id}`, async () => {
        const got = await storage.get([metaKey(id), latestKey(id)]);
        const meta = got[metaKey(id)];
        if (!meta || meta.noMirror) return { action: "skipped" };
        const content = got[latestKey(id)] == null ? "" : got[latestKey(id)];
        const prev = meta.file && meta.file.folder === root.folderId ? meta.file : null;
        let file = prev;
        try {
          if (!prev || !isValidSlug(prev.slug) || !isValidSlug(prev.convSlug) || prev.slugBase !== slugify(meta.title)) {
            file = await assignSlugs(id, root.folderId, prev);
          }
          const ctx = { id, convSlug: file.convSlug, slug: file.slug };
          const out = await renderFile(meta, content, file.slug);
          const textBytes = utf8(out.text);
          const newHash = await sha256(textBytes);
          const renamed = !!(prev && (prev.slug !== file.slug || prev.convSlug !== file.convSlug));

          if (file === prev && prev.syncedHash === newHash) {
            if (!check) return { action: "none", state: prev.state };
            const state = fileState({ diskHash: await hashAt(root.dir, mdPath(ctx), ctx), lastHash: prev.hash });
            // Fall through and write only when that clobbers nothing: the file is still what we
            // wrote but older (the latest went to a conflict file meanwhile), or there is none yet.
            // A deleted file is only marked (it never deletes the canvas); the next save writes it.
            const behind = (state === "ok" && prev.hash !== newHash) || state === "absent";
            if (!behind) {
              await saveFile(id, { ...prev, state }, meta.fileSyncedVersion);
              return { action: "none", state };
            }
          }

          const next = { ...file, error: undefined };
          // Assets first, then the .md that links them (§3.6 write order). Content-addressed: an
          // existing file is left alone whatever it holds (never overwritten).
          if (out.asset) {
            const segs = assetPath(ctx, out.asset.name);
            if ((await hashAt(root.dir, segs, ctx)) === null) await writeAt(root.dir, segs, out.asset.bytes, ctx);
          }
          const md = mdPath(ctx);
          const plan = planWrite({ diskHash: await hashAt(root.dir, md, ctx), lastHash: file.hash, newHash });
          if (plan.action === "write") {
            await writeAt(root.dir, md, textBytes, ctx);
            next.hash = newHash;
            next.state = plan.missing ? "recreated" : "ok";
          } else if (plan.action === "adopt") {
            next.hash = newHash;
            next.state = "ok";
          }
          if (plan.action === "conflict") {
            // One conflict file per episode: reuse ours while it is untouched, else a new name.
            let name = null;
            if (file.conflictName && isAllowedPath([file.convSlug, file.conflictName], ctx) &&
              (await hashAt(root.dir, [file.convSlug, file.conflictName], ctx)) === file.conflictHash) name = file.conflictName;
            for (let n = 1; !name && n <= 50; n++) {
              const cand = conflictFileName(file.slug, now(), n);
              if ((await hashAt(root.dir, [file.convSlug, cand], ctx)) === null) name = cand;
            }
            if (!name) throw new Error("no free name for the conflict file");
            await writeAt(root.dir, [file.convSlug, name], textBytes, ctx);
            next.conflictName = name;
            next.conflictHash = newHash;
            next.state = "changed";
          } else {
            next.conflictName = null;
            next.conflictHash = null;
          }
          // A rename moves the file only if the old one is still exactly what we wrote (§3.6);
          // otherwise it stays. Old assets stay too.
          if (renamed && prev.hash && plan.action !== "conflict" && isValidSlug(prev.slug) && isValidSlug(prev.convSlug)) {
            const oldCtx = { id, convSlug: prev.convSlug, slug: prev.slug };
            const old = mdPath(oldCtx);
            if ((await hashAt(root.dir, old, oldCtx)) === prev.hash) await removeAt(root.dir, old, oldCtx);
          }
          // .katashiro/<id>.json: for humans and tools, never read. Same rule: only over our own.
          const json = utf8(`${JSON.stringify({
            id, kind: meta.kind, title: meta.title, conversation: file.convSlug, slug: file.slug,
            version: meta.version, hash: next.hash, note: "informational only — Katashiro never reads this file",
          }, null, 2)}\n`);
          const jsonHash = await sha256(json);
          const jsegs = jsonPath(ctx);
          const onDisk = await hashAt(root.dir, jsegs, ctx);
          if (onDisk === null || onDisk === file.jsonHash) await writeAt(root.dir, jsegs, json, ctx);
          if (onDisk === null || onDisk === file.jsonHash || onDisk === jsonHash) next.jsonHash = jsonHash;

          next.syncedHash = newHash;
          await saveFile(id, next, meta.version);
          return { action: plan.action, state: next.state, conflictName: next.conflictName };
        } catch (e) {
          // Permission withdrawn mid-way: just not connected; the next reconnect catches up.
          if (errName(e) === "NotAllowedError" || errName(e) === "SecurityError") return { action: "disconnected" };
          const msg = String((e && e.message) || e).slice(0, ERROR_MAX);
          if (file) { try { await saveFile(id, { ...file, state: "error", error: msg }, meta.fileSyncedVersion); } catch (_) { /* best effort */ } }
          return { action: "error", state: "error", error: msg };
        }
      });
    }

    /** Catch-up (§3.6, on connect / reconnect): every mirrored canvas behind is written. */
    async function syncAll() {
      const metas = Object.values(await CanvasStore.getMatching(storage, (k) => /^canvas:cv_[0-9a-f]{12}:meta$/.test(k)));
      const counts = {};
      for (const m of metas) {
        if (!m || m.noMirror) continue;
        const r = await sync(m.id);
        counts[r.action] = (counts[r.action] || 0) + 1;
        if (r.action === "disconnected") break;
      }
      return counts;
    }

    return { sync, syncAll };
  }

  // --- The folder handle: IndexedDB on the extension origin (shared by panel and canvas tabs) ----
  const DB_NAME = "katashiro-canvas-mirror";
  const DB_STORE = "kv";
  const FOLDER_KEY = "folder";

  function idb(mode, run) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(DB_STORE, mode);
        const r = run(tx.objectStore(DB_STORE));
        tx.oncomplete = () => { db.close(); resolve(r && r.result); };
        tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
      };
    });
  }
  const readRecord = () => idb("readonly", (s) => s.get(FOLDER_KEY));
  const writeRecord = (v) => idb("readwrite", (s) => s.put(v, FOLDER_KEY));

  /** { configured, name?, permission?: "granted" | "prompt" | "denied", folderId?, handle? } */
  async function folderStatus() {
    let rec;
    try { rec = await readRecord(); } catch (_) { return { configured: false }; }
    if (!rec || !rec.handle || rec.stopped) return { configured: false };
    let permission = "denied";
    try { permission = await rec.handle.queryPermission({ mode: "readwrite" }); } catch (_) { /* treat as denied */ }
    return { configured: true, name: rec.handle.name, folderId: rec.folderId, permission, handle: rec.handle };
  }

  /** The folder, only if writing is allowed right now (no prompt). For createCanvasMirror's getRoot. */
  async function grantedRoot() {
    const s = await folderStatus();
    return s.configured && s.permission === "granted" ? { dir: s.handle, folderId: s.folderId } : null;
  }

  /** Reconnect folder: needs a user gesture (a click handler). True when access is granted. */
  async function requestAccess() {
    const s = await folderStatus();
    if (!s.configured) return false;
    if (s.permission === "granted") return true;
    try { return (await s.handle.requestPermission({ mode: "readwrite" })) === "granted"; } catch (_) { return false; }
  }

  /**
   * Settings → pick a folder (a user gesture). Picking the folder that was used before keeps its
   * folderId, so the hashes Katashiro wrote there still count and nothing turns into a conflict.
   */
  async function pickFolder() {
    const handle = await globalThis.showDirectoryPicker({ mode: "readwrite", id: "katashiro-canvas" });
    let prev = null;
    try { prev = await readRecord(); } catch (_) { /* none */ }
    let folderId = null;
    if (prev && prev.handle && prev.folderId) {
      try { if (await prev.handle.isSameEntry(handle)) folderId = prev.folderId; } catch (_) { /* different */ }
    }
    if (!folderId) {
      const b = new Uint8Array(8);
      globalThis.crypto.getRandomValues(b);
      folderId = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    }
    await writeRecord({ handle, folderId, pickedAt: Date.now() });
    return { name: handle.name, folderId };
  }

  /** Stop mirroring. The files stay; the handle is kept (stopped) so picking it again resumes. */
  async function stopMirror() {
    const rec = await readRecord();
    if (rec) await writeRecord({ ...rec, stopped: true });
  }

  return {
    createCanvasMirror, slugify, isValidSlug, uniqueSlug, conflictFileName, isAllowedPath, planWrite, fileState,
    onlyMirrorFieldsChanged, sniffImageExt, imageMarkdown, describeState, mdPath, assetPath, jsonPath,
    folderStatus, grantedRoot, requestAccess, pickFolder, stopMirror, NOT_A_FILE, SLUG_MAX, SLUG_MAX_BYTES,
  };
});
