// canvas-mirror.test.js — ADR docs/adr/canvas.md §3.6 local folder mirror: slugs, path checks,
// write-through without clobbering outside edits, conflict files, file-missing, rename, assets,
// incognito leftovers (noMirror), and catch-up — on a fake FileSystemDirectoryHandle.
const test = require("node:test");
const assert = require("node:assert/strict");
const CanvasStore = require("../canvas-store.js");
const M = require("../canvas-mirror.js");

function memStorage() {
  const data = {};
  let sets = 0;
  return {
    data,
    get sets() { return sets; },
    async get(keys) {
      const ks = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      await new Promise((r) => setTimeout(r, 1));
      return out;
    },
    async set(items) {
      sets++;
      await new Promise((r) => setTimeout(r, 1));
      for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

function memLock() {
  const tails = new Map();
  return (name, fn) => {
    const prev = tails.get(name) || Promise.resolve();
    const run = prev.then(fn, fn);
    tails.set(name, run.catch(() => {}));
    return run;
  };
}

const domErr = (name) => Object.assign(new Error(name), { name });

// A FileSystemDirectoryHandle stand-in: nested Maps; names with / \ or . / .. are refused like Chrome.
// File handles have move(dir, name) like Chrome's FileSystemFileHandle.move() (#101), which REPLACES
// an existing file at the target silently (seen in real Chrome 2026-10-11). shared.noMove drops
// move() (an older Chrome); an entry's failMove = "<DOMException name>" makes its move throw (a file
// an editor holds open). removeEntry refuses a non-empty directory unless { recursive: true }.
function fakeDir(name = "root", shared = { noMove: false, moves: [] }) {
  const entries = new Map();
  const self = {};
  const checkName = (n) => { if (!n || n === "." || n === ".." || /[/\\]/.test(n)) throw new TypeError(`bad name ${n}`); };
  return Object.assign(self, {
    kind: "directory", name, entries, shared,
    async *keys() { for (const k of [...entries.keys()]) yield k; },
    async getDirectoryHandle(n, { create = false } = {}) {
      checkName(n);
      let e = entries.get(n);
      if (!e) {
        if (!create) throw domErr("NotFoundError");
        e = { kind: "dir", dir: fakeDir(n, shared) };
        entries.set(n, e);
      }
      if (e.kind !== "dir") throw domErr("TypeMismatchError");
      return e.dir;
    },
    async getFileHandle(n, { create = false } = {}) {
      checkName(n);
      let e = entries.get(n);
      if (!e) {
        if (!create) throw domErr("NotFoundError");
        e = { kind: "file", bytes: new Uint8Array() };
        entries.set(n, e);
      }
      if (e.kind !== "file") throw domErr("TypeMismatchError");
      let parent = entries;
      let cur = n;
      const fh = {
        async getFile() { return { async arrayBuffer() { return e.bytes.slice().buffer; } }; },
        async createWritable() {
          if (e.failWrites) throw new Error("disk full");
          let buf = new Uint8Array();
          return { async write(b) { buf = new Uint8Array(b); }, async close() { e.bytes = buf; }, async abort() {} };
        },
      };
      if (!shared.noMove) {
        fh.move = async (a, b) => {
          const dest = typeof a === "string" ? self : a;
          const to = typeof a === "string" ? a : (b === undefined ? cur : b);
          checkName(to);
          if (e.failMove) throw domErr(e.failMove);
          const there = dest.entries.get(to);
          if (there && there.kind === "dir") throw domErr("InvalidModificationError");
          shared.moves.push(`${cur} → ${dest.name}/${to}`);
          parent.delete(cur);
          dest.entries.set(to, e);                           // an existing file there is replaced, silently
          parent = dest.entries;
          cur = to;
        };
      }
      return fh;
    },
    async removeEntry(n, { recursive = false } = {}) {
      const e = entries.get(n);
      if (!e) throw domErr("NotFoundError");
      if (e.kind === "dir" && e.dir.entries.size && !recursive) throw domErr("InvalidModificationError");
      entries.delete(n);
    },
  });
}

async function entryAt(root, path) {
  const segs = path.split("/");
  let d = root;
  for (const s of segs.slice(0, -1)) { const e = d.entries.get(s); if (!e || e.kind !== "dir") return null; d = e.dir; }
  return d.entries.get(segs[segs.length - 1]) || null;
}
async function readText(root, path) {
  const e = await entryAt(root, path);
  return e && e.kind === "file" ? new TextDecoder().decode(e.bytes) : null;
}
async function writeText(root, path, text) {
  const segs = path.split("/");
  let d = root;
  for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s, { create: true });
  const fh = await d.getFileHandle(segs[segs.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(new TextEncoder().encode(text));
  await w.close();
}
function listFiles(dir, prefix = "") {
  const out = [];
  for (const [n, e] of dir.entries) {
    if (e.kind === "dir") out.push(...listFiles(e.dir, `${prefix}${n}/`));
    else out.push(`${prefix}${n}`);
  }
  return out.sort();
}

function setup({ connected = true, noMove = false } = {}) {
  const storage = memStorage();
  const lock = memLock();
  let n = 0;
  let t = Date.UTC(2026, 9, 10, 12, 0, 0);
  const now = () => t;
  const store = CanvasStore.createCanvasStore({
    storage, lock, now, randomHex: () => (++n).toString(16).padStart(12, "0"),
  });
  const dir = fakeDir("root", { noMove, moves: [] });
  const env = { storage, store, dir, folderId: "f1", connected, advance: (ms) => { t += ms; } };
  env.mirror = M.createCanvasMirror({
    storage, lock, now, getRoot: async () => (env.connected ? { dir: env.dir, folderId: env.folderId } : null),
  });
  env.meta = async (id) => (await storage.get(CanvasStore.metaKey(id)))[CanvasStore.metaKey(id)];
  return env;
}

// --- pure helpers ----------------------------------------------------------------------------

test("slugify: lower-case, [a-z0-9_-] and CJK only, no leading dot, reserved names, caps, fallback", () => {
  assert.equal(M.slugify("Hello World!"), "hello-world");
  assert.equal(M.slugify("設計 文件／草稿"), "設計-文件-草稿");
  assert.equal(M.slugify("ＡＢＣ_x"), "abc_x");                       // NFKC: full-width letters fold
  assert.equal(M.slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(M.slugify(".git"), "git");                             // never a leading dot
  assert.equal(M.slugify(".katashiro"), "katashiro");
  assert.equal(M.slugify("CON"), "con-canvas");
  assert.equal(M.slugify("lpt9"), "lpt9-canvas");
  assert.equal(M.slugify("com¹"), "com1-canvas");                     // NFKC ¹ → 1, still reserved
  assert.equal(M.slugify("node_modules"), "node_modules-canvas");
  assert.equal(M.slugify(""), "canvas");
  assert.equal(M.slugify("!!!"), "canvas");
  assert.equal(M.slugify(null), "canvas");
  assert.equal(M.slugify("a".repeat(200)).length, 80);
  const cjk = M.slugify("中".repeat(200));
  assert.ok(Buffer.byteLength(cjk) <= M.SLUG_MAX_BYTES && Array.from(cjk).length <= 80);
  assert.equal(M.slugify("x\u0000y‮z"), "x-y-z");                // control and bidi characters
  for (const s of ["hello-world", "設計-文件-草稿", "con-canvas", "canvas"]) assert.ok(M.isValidSlug(s), s);
  for (const s of [".git", "a/b", "a.b", "con", "node_modules", "", "A", "a".repeat(81)]) assert.ok(!M.isValidSlug(s), s);
});

test("uniqueSlug: -2, -3 … and still within the caps", () => {
  assert.equal(M.uniqueSlug("plan", new Set()), "plan");
  assert.equal(M.uniqueSlug("plan", new Set(["plan"])), "plan-2");
  assert.equal(M.uniqueSlug("plan", new Set(["plan", "plan-2"])), "plan-3");
  const long = "a".repeat(80);
  const s = M.uniqueSlug(long, new Set([long]));
  assert.equal(s.length, 80);
  assert.ok(s.endsWith("-2") && M.isValidSlug(s));
});

test("conflictFileName: <slug>.katashiro-<UTC time>[-N].md", () => {
  const t = Date.UTC(2026, 9, 10, 3, 4, 5);
  assert.equal(M.conflictFileName("plan", t), "plan.katashiro-20261010T030405Z.md");
  assert.equal(M.conflictFileName("plan", t, 3), "plan.katashiro-20261010T030405Z-3.md");
});

test("isAllowedPath: only this canvas's .md, conflict files, assets and json", () => {
  const ctx = { id: "cv_000000000001", convSlug: "c_abc", slug: "plan" };
  const H = "a".repeat(64);
  for (const p of [["c_abc", "plan.md"], ["c_abc", "plan.katashiro-20261010T030405Z.md"], ["c_abc", "plan.katashiro-20261010T030405Z-2.md"],
    ["c_abc", "plan.assets", `${H}.png`], [".katashiro", "cv_000000000001.json"]]) {
    assert.ok(M.isAllowedPath(p, ctx), p.join("/"));
  }
  for (const p of [[".git", "hooks", "pre-commit"], ["c_abc", ".envrc"], ["c_abc", "other.md"], ["c_abc", "plan.md", "x"],
    ["..", "plan.md"], ["c_abc", "plan.assets", `${H}.svg`], ["c_abc", "plan.assets", "x.png"], [".katashiro", "cv_000000000002.json"],
    ["c_abc", "plan.katashiro-evil.md"], ["other", "plan.md"], ["plan.md"], []]) {
    assert.ok(!M.isAllowedPath(p, ctx), p.join("/"));
  }
  assert.ok(!M.isAllowedPath([".git", "plan.md"], { ...ctx, convSlug: ".git" }), "a tampered slug is refused too");
  assert.ok(!M.isAllowedPath(["c_abc", "x.md"], { ...ctx, slug: "x/../y" }));
});

test("planWrite / fileState: overwrite only what Katashiro wrote", () => {
  assert.deepEqual(M.planWrite({ diskHash: null, lastHash: null, newHash: "n" }), { action: "write", missing: false });
  assert.deepEqual(M.planWrite({ diskHash: null, lastHash: "l", newHash: "n" }), { action: "write", missing: true });
  assert.deepEqual(M.planWrite({ diskHash: "l", lastHash: "l", newHash: "n" }), { action: "write" });
  assert.deepEqual(M.planWrite({ diskHash: "n", lastHash: "l", newHash: "n" }), { action: "adopt" });
  assert.deepEqual(M.planWrite({ diskHash: "x", lastHash: "l", newHash: "n" }), { action: "conflict" });
  assert.deepEqual(M.planWrite({ diskHash: "x", lastHash: null, newHash: "n" }), { action: "conflict" });   // never wrote it
  assert.deepEqual(M.planWrite({ diskHash: M.NOT_A_FILE, lastHash: "l", newHash: "n" }), { action: "conflict" });
  assert.equal(M.fileState({ diskHash: null, lastHash: "l" }), "missing");
  assert.equal(M.fileState({ diskHash: null, lastHash: null }), "absent");
  assert.equal(M.fileState({ diskHash: "l", lastHash: "l" }), "ok");
  assert.equal(M.fileState({ diskHash: "x", lastHash: "l" }), "changed");
});

test("onlyMirrorFieldsChanged: a meta change that only touches file / fileSyncedVersion", () => {
  const a = { id: "x", version: 2, title: "T" };
  assert.ok(M.onlyMirrorFieldsChanged(a, { ...a, file: { hash: "h" }, fileSyncedVersion: 2 }));
  assert.ok(!M.onlyMirrorFieldsChanged(a, { ...a, version: 3 }));
  assert.ok(!M.onlyMirrorFieldsChanged(a, { ...a, normalized: true }));
  assert.ok(!M.onlyMirrorFieldsChanged(null, a));
});

test("sniffImageExt: magic bytes only; SVG and unknown are never files", () => {
  const b = (arr) => new Uint8Array([...arr, ...new Array(12).fill(0)]);
  assert.equal(M.sniffImageExt(b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "png");
  assert.equal(M.sniffImageExt(b([0xff, 0xd8, 0xff])), "jpg");
  assert.equal(M.sniffImageExt(b([...Buffer.from("GIF89a")])), "gif");
  assert.equal(M.sniffImageExt(new Uint8Array([...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")])), "webp");
  assert.equal(M.sniffImageExt(b([...Buffer.from("<svg xmlns")])), null);
  assert.equal(M.sniffImageExt(new Uint8Array([0x89])), null);
});

// --- sync on a fake folder ---------------------------------------------------------------------

test("not connected: nothing written, meta untouched; connecting catches up", async () => {
  const env = setup({ connected: false });
  const { id } = await env.store.agentWrite({ conversationId: "c_abc", title: "Plan", content: "# v1\n" });
  const sets = env.storage.sets;
  assert.deepEqual(await env.mirror.sync(id), { action: "disconnected" });
  assert.equal(env.storage.sets, sets);
  assert.deepEqual(listFiles(env.dir), []);
  env.connected = true;
  const counts = await env.mirror.syncAll();
  assert.equal(counts.write, 1);
  assert.equal(await readText(env.dir, "c_abc/plan.md"), "# v1\n");
});

test("write-through: .md under the conversation slug, json beside, meta records hash + version", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c_abc", title: "Plan A", content: "# v1\n" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "write");
  assert.equal(await readText(env.dir, "c_abc/plan-a.md"), "# v1\n");
  const json = JSON.parse(await readText(env.dir, `.katashiro/${id}.json`));
  assert.equal(json.id, id);
  assert.equal(json.slug, "plan-a");
  const meta = await env.meta(id);
  assert.equal(meta.fileSyncedVersion, 1);
  assert.equal(meta.file.slug, "plan-a");
  assert.equal(meta.file.convSlug, "c_abc");
  assert.equal(meta.file.state, "ok");
  assert.match(meta.file.hash, /^[0-9a-f]{64}$/);
  // Nothing changed → no disk work and no meta write (so storage.onChanged does not loop).
  const sets = env.storage.sets;
  assert.equal((await env.mirror.sync(id)).action, "none");
  assert.equal(env.storage.sets, sets);
  // A user save → overwritten (the file is still what Katashiro wrote).
  await env.store.userSave({ id, baseVersion: 1, content: "# v2 by user\n" });
  assert.equal((await env.mirror.sync(id)).action, "write");
  assert.equal(await readText(env.dir, "c_abc/plan-a.md"), "# v2 by user\n");
  assert.equal((await env.meta(id)).fileSyncedVersion, 2);
  // Slides keep their --- separators: the stored text as is.
  const s = await env.store.agentWrite({ conversationId: "c_abc", title: "Deck", kind: "slides", content: "# A\n---\n# B" });
  await env.mirror.sync(s.id);
  assert.equal(await readText(env.dir, "c_abc/deck.md"), "# A\n---\n# B");
});

test("normalization without a version change is still mirrored (content hash, not version)", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "N", content: "* a\n" });
  await env.mirror.sync(id);
  await env.store.applyNormalized({ id, version: 1, normalized: "- a\n" });
  assert.equal((await env.mirror.sync(id)).action, "write");
  assert.equal(await readText(env.dir, "c/n.md"), "- a\n");
});

// #98: one agent markdown write = one file write while a canvas tab will normalize it.
function holdEnv({ rendering = true } = {}) {
  const env = setup();
  let t = 0;
  const timers = [];
  const retried = [];
  env.hold = M.createNormalizeHold({
    rendering: async () => rendering, retry: (id) => retried.push(id), waitMs: 5000, now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms, cleared: false }; timers.push(h); return h; },
    clearTimer: (h) => { if (h) h.cleared = true; },
  });
  env.tick = (ms) => { t += ms; for (const h of timers) if (!h.cleared && !h.fired && h.at <= t) { h.fired = true; h.fn(); } };
  env.timers = timers;
  env.retried = retried;
  env.mirror = M.createCanvasMirror({
    storage: env.storage, lock: memLock(), now: () => Date.UTC(2026, 9, 10), getRoot: async () => ({ dir: env.dir, folderId: env.folderId }),
    holdForNormalization: env.hold.hold,
  });
  return env;
}

test("awaitsNormalization: only the agent's own markdown write, not normalized yet", () => {
  const m = { kind: "markdown", normalized: false, author: "agent", version: 2, agentVersion: 2 };
  assert.equal(M.awaitsNormalization(m), true);
  assert.equal(M.awaitsNormalization({ ...m, normalized: true }), false);
  assert.equal(M.awaitsNormalization({ ...m, kind: "slides" }), false);
  assert.equal(M.awaitsNormalization({ ...m, author: "user", version: 3 }), false);     // a user save on top
  assert.equal(M.awaitsNormalization(null), false);
});

test("normalization hold: a canvas tab open → the file is written once, normalized (#98)", async () => {
  const env = holdEnv();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "N", content: "* a\n" });
  assert.equal((await env.mirror.sync(id)).action, "held");
  assert.equal(await readText(env.dir, "c/n.md"), null);
  assert.equal((await env.mirror.sync(id)).action, "held");                   // any other sync meanwhile too
  await env.store.applyNormalized({ id, version: 1, normalized: "- a\n" });
  assert.equal((await env.mirror.sync(id)).action, "write");
  assert.equal(await readText(env.dir, "c/n.md"), "- a\n");
  assert.ok(env.timers.every((h) => h.cleared));                               // the fallback is cancelled
  env.tick(10_000);
  assert.deepEqual(env.retried, []);
});

test("normalization hold: bounded — past the wait the raw text is written; a user save is not held", async () => {
  const env = holdEnv();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "N", content: "* a\n" });
  assert.equal((await env.mirror.sync(id)).action, "held");
  env.tick(4999);
  assert.deepEqual(env.retried, []);
  env.tick(1);
  assert.deepEqual(env.retried, [id]);                                         // the caller syncs again…
  assert.equal((await env.mirror.sync(id)).action, "write");                   // …and it writes
  assert.equal(await readText(env.dir, "c/n.md"), "* a\n");
  // A newer agent version waits again; the user's save on top of it does not.
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "N", content: "* b\n" });
  assert.equal((await env.mirror.sync(id)).action, "held");
  await env.store.userSave({ id, baseVersion: 2, content: "mine\n" });
  assert.equal((await env.mirror.sync(id)).action, "write");
  assert.equal(await readText(env.dir, "c/n.md"), "mine\n");
});

test("normalization hold: no canvas tab → written at once; slides and 重新寫入 never wait; the start check only without a file", async () => {
  const env = holdEnv({ rendering: false });
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "N", content: "* a\n" });
  assert.equal((await env.mirror.sync(id)).action, "write");
  const on = holdEnv();
  const s = await on.store.agentWrite({ conversationId: "c", title: "S", kind: "slides", content: "# a" });
  assert.equal((await on.mirror.sync(s.id)).action, "write");
  // A new canvas: its tab's start check waits too (nothing on disk to check yet)…
  const m = await on.store.agentWrite({ conversationId: "c", title: "M", content: "* a\n" });
  assert.equal((await on.mirror.sync(m.id, { check: true })).action, "held");
  assert.equal((await on.mirror.sync(m.id, { rewrite: true })).action, "write");
  // …but with a file there, the start check runs (it looks for outside changes).
  await on.store.agentWrite({ conversationId: "c", id: m.id, baseVersion: 1, title: "M", content: "* b\n" });
  assert.notEqual((await on.mirror.sync(m.id, { check: true })).action, "held");
  assert.equal(await readText(on.dir, "c/m.md"), "* b\n");
});

test("changed outside Katashiro: never overwritten; the latest goes to one conflict file per episode", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c_abc", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  await writeText(env.dir, "c_abc/plan.md", "edited in VS Code\n");
  await env.store.userSave({ id, baseVersion: 1, content: "v2\n" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "conflict");
  assert.equal(r.conflictName, "plan.katashiro-20261010T120000Z.md");
  assert.equal(await readText(env.dir, "c_abc/plan.md"), "edited in VS Code\n");
  assert.equal(await readText(env.dir, `c_abc/${r.conflictName}`), "v2\n");
  assert.equal((await env.meta(id)).file.state, "changed");
  // Still changed: the next save rewrites the same (untouched) conflict file, no pile-up.
  env.advance(60_000);
  await env.store.userSave({ id, baseVersion: 2, content: "v3\n" });
  assert.equal((await env.mirror.sync(id)).conflictName, r.conflictName);
  assert.equal(await readText(env.dir, `c_abc/${r.conflictName}`), "v3\n");
  // The user edited the conflict file too → it is left alone and a new one is written.
  await writeText(env.dir, `c_abc/${r.conflictName}`, "mine\n");
  await env.store.userSave({ id, baseVersion: 3, content: "v4\n" });
  const r2 = await env.mirror.sync(id);
  assert.equal(r2.conflictName, "plan.katashiro-20261010T120100Z.md");
  assert.equal(await readText(env.dir, `c_abc/${r.conflictName}`), "mine\n");
  // Nothing is ever read back into the canvas.
  assert.equal((await env.store.read({ id })).content, "v4\n");
  // The user puts the latest into the file themselves → adopted, episode over.
  await writeText(env.dir, "c_abc/plan.md", "v4\n");
  await env.store.userSave({ id, baseVersion: 4, content: "v5\n" });
  // plan.md now holds v4, which Katashiro did not write there → still a conflict…
  assert.equal((await env.mirror.sync(id)).action, "conflict");
  // …unless it holds exactly the latest.
  await writeText(env.dir, "c_abc/plan.md", "v5\n");
  env.advance(1000);
  await env.store.userSave({ id, baseVersion: 5, content: "v5\n" });   // unchanged: no version
  const meta = await env.meta(id);
  meta.file.syncedHash = null;                                         // force a re-check
  await env.storage.set({ [CanvasStore.metaKey(id)]: meta });
  assert.equal((await env.mirror.sync(id)).action, "adopt");
  assert.equal((await env.meta(id)).file.state, "ok");
});

test("a new slug never lands on a file Katashiro never wrote: it is left alone, the next slug is taken", async () => {
  const env = setup();
  await writeText(env.dir, "c/plan.md", "someone else's\n");
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "mine\n" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "write");
  assert.equal(await readText(env.dir, "c/plan.md"), "someone else's\n");
  assert.equal(await readText(env.dir, "c/plan-2.md"), "mine\n");
  assert.equal((await env.meta(id)).file.state, "ok");
  // A directory at the path is not a file to overwrite either.
  const env2 = setup();
  await writeText(env2.dir, "c/plan.md/inner", "x");
  const b = await env2.store.agentWrite({ conversationId: "c", title: "Plan", content: "mine\n" });
  assert.equal((await env2.mirror.sync(b.id)).action, "write");
  assert.equal(await readText(env2.dir, "c/plan-2.md"), "mine\n");
});

test("a deleted canvas's file stays; a new canvas with the same title takes the next slug, not a conflict", async () => {
  const env = setup();
  const a = await env.store.agentWrite({ conversationId: "c_abc", title: "Notes", content: "# A\n" });
  await env.mirror.sync(a.id);
  await env.store.remove({ id: a.id });
  const b = await env.store.agentWrite({ conversationId: "c_abc", title: "Notes", content: "# B\n" });
  const r = await env.mirror.sync(b.id);
  assert.equal(r.action, "write");
  assert.equal(await readText(env.dir, "c_abc/notes.md"), "# A\n");
  assert.equal(await readText(env.dir, "c_abc/notes-2.md"), "# B\n");
  await env.store.userSave({ id: b.id, baseVersion: 1, content: "# B2\n" });
  assert.equal((await env.mirror.sync(b.id)).action, "write");
  assert.equal((await env.meta(b.id)).file.state, "ok");
});

test("same content under a newer version: fileSyncedVersion moves on without a write", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Plan", content: "v1\n" });
  const meta = await env.meta(id);
  assert.equal(meta.version, 2);
  assert.equal((await env.mirror.sync(id)).action, "none");
  assert.equal((await env.meta(id)).fileSyncedVersion, 2);
  const sets = env.storage.sets;
  await env.mirror.sync(id);
  assert.equal(env.storage.sets, sets, "settled: no further meta writes");
});

test("#106: a legacy \"recreated\" meta (before #105) reads as ok", async () => {
  assert.equal(M.stateOf({ state: "recreated" }), "ok");
  assert.equal(M.stateOf({ state: "deleted" }), "deleted");
  assert.equal(M.stateOf(null), undefined);
  assert.equal(M.describeState({ state: "recreated" }).level, "ok");     // no amber warning left over
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  const m = await env.meta(id);
  await env.storage.set({ [`canvas:${id}:meta`]: { ...m, file: { ...m.file, state: "recreated" } } });
  // same content under a newer version: the file holds the latest, as for "ok"
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Plan", content: "v1\n" });
  assert.deepEqual(await env.mirror.sync(id), { action: "none", state: "ok" });
  assert.equal((await env.meta(id)).fileSyncedVersion, 2);
});

test("check after an error clears the stale error text", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1" });
  await env.mirror.sync(id);
  const meta = await env.meta(id);
  meta.file = { ...meta.file, state: "error", error: "disk full" };
  await env.storage.set({ [CanvasStore.metaKey(id)]: meta });
  assert.equal((await env.mirror.sync(id, { check: true })).state, "ok");
  const file = (await env.meta(id)).file;
  assert.equal(file.state, "ok");
  assert.equal(file.error, undefined);
});

test("file deleted outside (1B): the canvas is kept, its mirroring stops until rewrite or the file is back", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
  const r = await env.mirror.sync(id, { check: true });
  assert.deepEqual(r, { action: "none", state: "deleted" });
  assert.equal((await env.meta(id)).file.state, "deleted");
  assert.equal(await readText(env.dir, "c/plan.md"), null);              // not recreated on open
  assert.equal((await env.store.read({ id })).content, "v1\n");          // the canvas is intact
  // later saves do not bring it back
  await env.store.userSave({ id, baseVersion: 1, content: "v2\n" });
  assert.deepEqual(await env.mirror.sync(id), { action: "none", state: "deleted" });
  assert.equal(await readText(env.dir, "c/plan.md"), null);
  // the user asks: written again, mirroring resumes
  const w = await env.mirror.sync(id, { rewrite: true });
  assert.equal(w.action, "write");
  assert.equal(w.state, "ok");                                          // the user asked: no warning
  assert.equal(await readText(env.dir, "c/plan.md"), "v2\n");
  await env.store.userSave({ id, baseVersion: 2, content: "v3\n" });
  await env.mirror.sync(id);
  assert.equal(await readText(env.dir, "c/plan.md"), "v3\n");
  // check also notices an outside change while nothing is pending
  await writeText(env.dir, "c/plan.md", "outside\n");
  assert.equal((await env.mirror.sync(id, { check: true })).state, "changed");
});

// Real-Chrome finding (2026-10-11): with the content unchanged since the last sync, 重新寫入 took the
// "nothing new" shortcut and returned "none" without looking at the disk — the file never came back.
for (const check of [false, true]) {
  test(`rewrite with unchanged content (check: ${check}): the deleted file is written back, state ok`, async () => {
    const env = setup();
    const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
    await env.mirror.sync(id);
    (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
    assert.equal((await env.mirror.sync(id, { check: true })).state, "deleted");
    // same text under a newer version while deleted: still nothing to write but the file itself
    await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Plan", content: "v1\n" });
    assert.deepEqual(await env.mirror.sync(id), { action: "none", state: "deleted" });
    const w = await env.mirror.sync(id, { check, rewrite: true });
    assert.equal(w.action, "write");
    assert.equal(w.state, "ok");
    assert.equal(await readText(env.dir, "c/plan.md"), "v1\n");
    const m = await env.meta(id);
    assert.equal(m.file.state, "ok");
    assert.equal(m.fileSyncedVersion, m.version);
    assert.equal(m.version, 2);
  });
}

test("rewrite when the file is back with our content: ok, nothing written", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
  assert.equal((await env.mirror.sync(id, { check: true })).state, "deleted");
  await writeText(env.dir, "c/plan.md", "v1\n");                        // git checkout, say
  const writes = [];
  const c = await env.dir.getDirectoryHandle("c");
  const real = c.getFileHandle.bind(c);
  c.getFileHandle = async (name, opts) => { if (opts && opts.create) writes.push(name); return real(name, opts); };
  assert.deepEqual(await env.mirror.sync(id, { rewrite: true }), { action: "none", state: "ok" });
  assert.deepEqual(writes, []);
  assert.equal(await readText(env.dir, "c/plan.md"), "v1\n");
  const m = await env.meta(id);
  assert.equal(m.file.state, "ok");
  assert.equal(m.fileSyncedVersion, m.version);
});

test("rewrite when the file is back changed outside: not overwritten, the latest goes to a conflict file", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
  assert.equal((await env.mirror.sync(id, { check: true })).state, "deleted");
  await writeText(env.dir, "c/plan.md", "theirs\n");
  const r = await env.mirror.sync(id, { rewrite: true });
  assert.equal(r.action, "conflict");
  assert.equal(r.state, "changed");
  assert.match(r.conflictName, /^plan\.katashiro-.+\.md$/);
  assert.equal(await readText(env.dir, "c/plan.md"), "theirs\n");
  assert.equal(await readText(env.dir, `c/${r.conflictName}`), "v1\n");
  // again: the same untouched conflict file is reused, no pile-up
  const again = await env.mirror.sync(id, { rewrite: true });
  assert.equal(again.conflictName, r.conflictName);
  assert.equal(listFiles(await env.dir.getDirectoryHandle("c")).length, 2);
});

test("deleted on save (no tab check first) also stops; a file put back outside resumes under the usual rules", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
  await env.store.userSave({ id, baseVersion: 1, content: "v2\n" });
  assert.deepEqual(await env.mirror.sync(id), { action: "none", state: "deleted" });
  assert.equal(await readText(env.dir, "c/plan.md"), null);
  // git checkout puts our last file back: it is ours again, so the latest is written over it
  await writeText(env.dir, "c/plan.md", "v1\n");
  await env.store.userSave({ id, baseVersion: 2, content: "v3\n" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "write");
  assert.equal(await readText(env.dir, "c/plan.md"), "v3\n");
});

test("deleted, then renamed: still nothing written under the new title until rewrite", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
  assert.equal((await env.mirror.sync(id, { check: true })).state, "deleted");
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Plan Renamed", content: "v2\n" });
  assert.deepEqual(await env.mirror.sync(id), { action: "none", state: "deleted" });
  assert.deepEqual(await env.mirror.sync(id, { check: true }), { action: "none", state: "deleted" });
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("c")), []);
  // rewrite: under the new title
  assert.equal((await env.mirror.sync(id, { rewrite: true })).action, "write");
  assert.equal(await readText(env.dir, "c/plan-renamed.md"), "v2\n");
  assert.equal((await env.meta(id)).file.state, "ok");
});

test("image canvas deleted on save: no new asset, and a removed conversation folder is not recreated", async () => {
  const env = setup();
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const PNG2 = PNG.slice(0, -8) + "AAAAAA==";
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG } });
  await env.mirror.sync(id);
  const before = listFiles(await env.dir.getDirectoryHandle("c"));
  (await env.dir.getDirectoryHandle("c")).removeEntry("shot.md");
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG2 } });
  assert.deepEqual(await env.mirror.sync(id), { action: "none", state: "deleted" });
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("c")), before.filter((f) => f !== "shot.md"));
  // rm -rf of the whole conversation folder, detected on save
  const b = await env.store.agentWrite({ conversationId: "d", title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG } });
  await env.mirror.sync(b.id);
  await env.dir.removeEntry("d", { recursive: true });
  await env.store.agentWrite({ conversationId: "d", id: b.id, baseVersion: 1, title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG2 } });
  assert.deepEqual(await env.mirror.sync(b.id), { action: "none", state: "deleted" });
  assert.equal(env.dir.entries.has("d"), false);
});

test("#95's \"missing\" meta is taken as deleted: no write on save", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
  const m = await env.meta(id);
  await env.storage.set({ [`canvas:${id}:meta`]: { ...m, file: { ...m.file, state: "missing" } } });
  await env.store.userSave({ id, baseVersion: 1, content: "v2\n" });
  assert.deepEqual(await env.mirror.sync(id), { action: "none", state: "deleted" });
  assert.equal(await readText(env.dir, "c/plan.md"), null);
  assert.equal((await env.meta(id)).file.state, "deleted");
});

test("#100: an error during the deleted check keeps \"deleted\"; a later rename still writes nothing", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
  assert.equal((await env.mirror.sync(id, { check: true })).state, "deleted");
  // A transient I/O error while hashing the old path
  const real = env.dir.getDirectoryHandle;
  env.dir.getDirectoryHandle = async () => { env.dir.getDirectoryHandle = real; throw new Error("I/O error"); };
  await env.store.userSave({ id, baseVersion: 1, content: "v2\n" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "error");
  assert.equal(r.state, "deleted");
  const file = (await env.meta(id)).file;
  assert.equal(file.state, "deleted");                                   // the mark survives
  assert.match(file.error, /I\/O error/);
  // Renamed meanwhile: still nothing under the new title until the user asks
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "Plan Renamed", content: "v3\n" });
  assert.deepEqual(await env.mirror.sync(id), { action: "none", state: "deleted" });
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("c")), []);
  // #95's "missing" is kept the same way
  const m = await env.meta(id);
  await env.storage.set({ [`canvas:${id}:meta`]: { ...m, file: { ...m.file, state: "missing" } } });
  env.dir.getDirectoryHandle = async () => { env.dir.getDirectoryHandle = real; throw new Error("I/O error"); };
  assert.equal((await env.mirror.sync(id)).state, "missing");
  assert.equal((await env.meta(id)).file.state, "missing");
});

test("slug collisions get -2; a conversation keeps one slug; slugs come from storage, not the folder", async () => {
  const env = setup();
  const a = await env.store.agentWrite({ conversationId: "c_one", title: "Plan", content: "a" });
  const b = await env.store.agentWrite({ conversationId: "c_one", title: "plan!", content: "b" });
  const c = await env.store.agentWrite({ conversationId: "c_two", title: "Plan", content: "c" });
  await env.mirror.syncAll();
  assert.equal(await readText(env.dir, "c_one/plan.md"), "a");
  assert.equal(await readText(env.dir, "c_one/plan-2.md"), "b");
  assert.equal(await readText(env.dir, "c_two/plan.md"), "c");
  // A tampered json (git pull, a synced folder) cannot redirect a write: it is never read.
  await writeText(env.dir, `.katashiro/${a.id}.json`, JSON.stringify({ id: a.id, slug: "../.git/hooks/pre-commit", conversation: ".git" }));
  await env.store.userSave({ id: a.id, baseVersion: 1, content: "a2" });
  await env.mirror.sync(a.id);
  assert.equal(await readText(env.dir, "c_one/plan.md"), "a2");
  assert.equal(await entryAt(env.dir, ".git"), null);
  // …and the tampered json itself is left as it is (changed outside, like any file).
  assert.match(await readText(env.dir, `.katashiro/${a.id}.json`), /pre-commit/);
  // A tampered slug in storage is refused by the path check, not followed.
  const meta = await env.meta(c.id);
  meta.file.slug = "../x";
  meta.file.slugBase = "../x";
  await env.storage.set({ [CanvasStore.metaKey(c.id)]: meta });
  await env.store.userSave({ id: c.id, baseVersion: 1, content: "c2" });
  await env.mirror.sync(c.id);
  assert.ok(M.isValidSlug((await env.meta(c.id)).file.slug), "an invalid stored slug is reassigned");
  assert.ok(listFiles(env.dir).every((p) => !p.includes("..")));
});

// --- #101: renames move files with FileSystemFileHandle.move() ----------------------------------

test("rename moves the .md with move(): an outside edit moves with it, then the usual rules apply", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Old name", content: "v1" });
  await env.mirror.sync(id);
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "New name", content: "v2" });
  assert.equal((await env.mirror.sync(id)).action, "write");             // moved, then ours → written over
  assert.deepEqual(env.dir.shared.moves, ["old-name.md → c/new-name.md"]);
  assert.equal(await readText(env.dir, "c/old-name.md"), null);
  assert.equal(await readText(env.dir, "c/new-name.md"), "v2");
  assert.equal((await env.meta(id)).file.move, undefined);               // the pending move is cleared
  // Edited outside, then renamed: the edit moves with the file and is not overwritten; the latest
  // goes to a conflict file beside it at the new path.
  await writeText(env.dir, "c/new-name.md", "kept\n");
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "Third", content: "v3" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "conflict");
  assert.equal(await readText(env.dir, "c/new-name.md"), null);
  assert.equal(await readText(env.dir, "c/third.md"), "kept\n");
  assert.match(r.conflictName, /^third\.katashiro-\d{8}T\d{6}Z\.md$/);
  assert.equal(await readText(env.dir, `c/${r.conflictName}`), "v3");
  assert.equal((await env.meta(id)).file.state, "changed");
  // Renamed again while changed: the conflict file named in meta moves too (renamed to the new
  // slug) and is reused for this episode.
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 3, title: "Fourth", content: "v4" });
  const r2 = await env.mirror.sync(id);
  assert.equal(r2.conflictName, r.conflictName.replace(/^third/, "fourth"));
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("c")), ["fourth.md", r2.conflictName].sort());
  assert.equal(await readText(env.dir, `c/${r2.conflictName}`), "v4");
});

test("rename without move() (older Chrome): written fresh, the old .md removed only if still ours", async () => {
  const env = setup({ noMove: true });
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Old name", content: "v1" });
  await env.mirror.sync(id);
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "New name", content: "v2" });
  await env.mirror.sync(id);
  assert.equal(await readText(env.dir, "c/old-name.md"), null);
  assert.equal(await readText(env.dir, "c/new-name.md"), "v2");
  // Edited outside before the next rename → the old file stays, the new one is written fresh.
  await writeText(env.dir, "c/new-name.md", "kept\n");
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "Third", content: "v3" });
  await env.mirror.sync(id);
  assert.equal(await readText(env.dir, "c/new-name.md"), "kept\n");
  assert.equal(await readText(env.dir, "c/third.md"), "v3");
  const file = (await env.meta(id)).file;
  assert.equal(file.state, "ok");
  assert.equal(file.move, undefined);
});

test("move() throwing (a file an editor holds open) falls back to write-new + delete-if-ours", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1" });
  await env.mirror.sync(id);
  (await entryAt(env.dir, "c/plan.md")).failMove = "NoModificationAllowedError";
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Plan B", content: "v2" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "write");
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("c")), ["plan-b.md"]);
  assert.equal(await readText(env.dir, "c/plan-b.md"), "v2");
  assert.equal((await env.meta(id)).file.state, "ok");
  // A permission error is not a failed move: the sync reads as disconnected and the move stays pending.
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "Plan C", content: "v3" });
  (await entryAt(env.dir, "c/plan-b.md")).failMove = "NotAllowedError";
  assert.deepEqual(await env.mirror.sync(id), { action: "disconnected" });
  assert.equal((await env.meta(id)).file.move.slug, "plan-b");
});

test("moveFile never overwrites: an existing target (file or directory) is left, nothing moves", async () => {
  const env = setup();
  await writeText(env.dir, "c/a.md", "mine");
  await writeText(env.dir, "c/b.md", "theirs");
  await writeText(env.dir, "c/d.md/inner", "x");
  assert.equal(await M.moveFile(env.dir, ["c", "a.md"], ["c", "b.md"]), "exists");
  assert.equal(await M.moveFile(env.dir, ["c", "a.md"], ["c", "d.md"]), "exists");
  assert.equal(await readText(env.dir, "c/a.md"), "mine");
  assert.equal(await readText(env.dir, "c/b.md"), "theirs");
  assert.equal(await M.moveFile(env.dir, ["c", "nope.md"], ["c", "e.md"]), "gone");
  assert.equal(await M.moveFile(env.dir, ["c", "a.md"], ["x", "e.md"]), "moved");  // into a new sibling folder
  assert.equal(await readText(env.dir, "x/e.md"), "mine");
  assert.deepEqual(env.dir.shared.moves, ["a.md → x/e.md"]);
  // The fake really behaves like Chrome's move(): it replaces a target silently.
  const fh = await (await env.dir.getDirectoryHandle("c")).getFileHandle("b.md");
  await fh.move(await env.dir.getDirectoryHandle("x"), "e.md");
  assert.equal(await readText(env.dir, "x/e.md"), "theirs");
});

test("a same-name target found when the move runs is a conflict: not moved, not overwritten", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Old", content: "v1" });
  await env.mirror.sync(id);
  // The slugs were assigned (and the move recorded) when "new.md" did not exist yet; it appears
  // before the move runs (a sync cut short, or another program, in that window).
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "New", content: "v2" });
  const m = await env.meta(id);
  await env.storage.set({ [CanvasStore.metaKey(id)]: { ...m, file: { ...m.file, slug: "new", slugBase: "new", hash: null,
    move: { convSlug: "c", slug: "old", hash: m.file.hash, conflictName: null, conflictHash: null } } } });
  await writeText(env.dir, "c/new.md", "someone else's\n");
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "conflict");
  assert.equal(await readText(env.dir, "c/new.md"), "someone else's\n");
  assert.equal(await readText(env.dir, `c/${r.conflictName}`), "v2");
  assert.equal(await readText(env.dir, "c/old.md"), "v1");               // a conflict: the old one stays
  assert.equal((await env.meta(id)).file.move, undefined);
});

const PNG1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG2 = PNG1.slice(0, -8) + "AAAAAA==";

test("rename moves the content-addressed assets into <new-slug>.assets/; unknown files stay", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  await env.mirror.sync(id);
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG2 } });
  await env.mirror.sync(id);
  const [h1, h2] = [PNG1, PNG2].map((b) => require("node:crypto").createHash("sha256").update(Buffer.from(b, "base64")).digest("hex"));
  await writeText(env.dir, "c/shot.assets/README.txt", "mine");
  await writeText(env.dir, `c/shot.assets/${"0".repeat(64)}.png`, "not what the name says");
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "Shot 2", kind: "image", image: { mimeType: "image/png", data: PNG2 } });
  assert.equal((await env.mirror.sync(id)).action, "write");             // the moved .md now links shot-2.assets
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("c")), [
    "shot-2.assets/" + `${h1}.png`, "shot-2.assets/" + `${h2}.png`, "shot-2.md",
    `shot.assets/${"0".repeat(64)}.png`, "shot.assets/README.txt",
  ].sort());
  assert.match(await readText(env.dir, "c/shot-2.md"), new RegExp(`\\(shot-2\\.assets/${h2}\\.png\\)`));
  // With nothing unknown left in it, the old .assets/ folder goes.
  const env2 = setup();
  const b = await env2.store.agentWrite({ conversationId: "c", title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  await env2.mirror.sync(b.id);
  await env2.store.agentWrite({ conversationId: "c", id: b.id, baseVersion: 1, title: "Other", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  await env2.mirror.sync(b.id);
  assert.deepEqual(listFiles(await env2.dir.getDirectoryHandle("c")), [`other.assets/${h1}.png`, "other.md"]);
});

test("an image .md deleted outside before a rename: marked deleted, its assets and conflict file stay put", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  await env.mirror.sync(id);
  const m = await env.meta(id);
  await writeText(env.dir, "c/shot.katashiro-20261012-2200.md", "kept");
  await env.storage.set({ [CanvasStore.metaKey(id)]: { ...m, file: { ...m.file, conflictName: "shot.katashiro-20261012-2200.md", conflictHash: "x" } } });
  (await env.dir.getDirectoryHandle("c")).removeEntry("shot.md");
  const before = listFiles(await env.dir.getDirectoryHandle("c"));
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Shot 2", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  assert.equal((await env.mirror.sync(id)).state, "deleted");
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("c")), before);   // no shot-2.assets/ made
  assert.equal((await env.meta(id)).file.move, undefined);
});

test("an asset already at the target with the same bytes: the source is a duplicate and goes", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  await env.mirror.sync(id);
  const name = listFiles(await env.dir.getDirectoryHandle("c")).find((f) => f.startsWith("shot.assets/")).slice("shot.assets/".length);
  const bytes = (await entryAt(env.dir, `c/shot.assets/${name}`)).bytes;
  const d = await (await env.dir.getDirectoryHandle("c")).getDirectoryHandle("pic.assets", { create: true });
  const w = await (await d.getFileHandle(name, { create: true })).createWritable();
  await w.write(bytes);
  await w.close();
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Pic", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  await env.mirror.sync(id);
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("c")), [`pic.assets/${name}`, "pic.md"]);
});

test("an interrupted move is recorded before anything moves and finished by the next sync (idempotent)", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  await env.mirror.sync(id);
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG2 } });
  await env.mirror.sync(id);
  await env.store.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "Renamed", kind: "image", image: { mimeType: "image/png", data: PNG2 } });
  // Cut short after the .md moved: the second move hits a permission error (as if Chrome closed).
  const seen = [];
  const realPush = env.dir.shared.moves.push.bind(env.dir.shared.moves);
  env.dir.shared.moves.push = (s) => {
    seen.push(structuredClone(env.storage.data[CanvasStore.metaKey(id)].file));
    if (seen.length === 2) throw domErr("NotAllowedError");
    return realPush(s);
  };
  assert.deepEqual(await env.mirror.sync(id), { action: "disconnected" });
  assert.equal(seen[0].slug, "renamed");                                  // recorded before the first move
  assert.deepEqual(seen[0].move && [seen[0].move.convSlug, seen[0].move.slug], ["c", "shot"]);
  assert.equal(await readText(env.dir, "c/shot.md"), null);
  assert.ok(await readText(env.dir, "c/renamed.md"));
  assert.ok(listFiles(await env.dir.getDirectoryHandle("c")).some((f) => f.startsWith("shot.assets/")));
  env.dir.shared.moves.push = realPush;
  // Next sync: finishes (the .md already moved is recognised as ours), then writes as usual.
  assert.equal((await env.mirror.sync(id)).action, "write");
  const files = listFiles(await env.dir.getDirectoryHandle("c"));
  assert.ok(files.every((f) => f.startsWith("renamed.")), files.join(", "));
  assert.equal(files.length, 3);
  const file = (await env.meta(id)).file;
  assert.equal(file.move, undefined);
  assert.equal(file.state, "ok");
  // And again: nothing to do.
  const sets = env.storage.sets;
  assert.equal((await env.mirror.sync(id)).action, "none");
  assert.equal(env.storage.sets, sets);
});

// --- Conversation folders: <7-char short id>-<title slug> (multi-conversation §7) -----------------

test("convFolderSlug / convTitlesChanged / isAllowedDir", () => {
  assert.equal(M.convFolderSlug("c_9f2a41d0abcd", "市場調查"), "9f2a41d-市場調查");
  assert.equal(M.convFolderSlug("c_9f2a41d0abcd", "Q3 Plan: draft!"), "9f2a41d-q3-plan-draft");
  assert.equal(M.convFolderSlug("c_9f2a41d0abcd", null), "9f2a41d");
  assert.equal(M.convFolderSlug("c_9f2a41d0abcd", "!!!"), "9f2a41d");
  assert.equal(M.convFolderSlug("c_9f2a41d0abcd", ".git"), "9f2a41d-git");
  const long = M.convFolderSlug("c_9f2a41d0abcd", "中".repeat(200));
  assert.ok(M.isValidSlug(long) && long.startsWith("9f2a41d-"));
  assert.equal(M.convFolderSlug("c_abc", "Title"), "c_abc");             // not a minted id: the slugged id, as before
  assert.deepEqual(M.convTitlesChanged(
    { c_000000000001: { title: "a" }, c_000000000002: { title: "b" }, c_000000000003: { title: null } },
    { c_000000000001: { title: "a", lastMessageAt: 5 }, c_000000000002: { title: "B" }, c_000000000003: { title: "c" }, c_000000000004: { title: null } }),
  ["c_000000000002", "c_000000000003"]);
  assert.deepEqual(M.convTitlesChanged(undefined, { c_000000000001: { title: "x" } }), ["c_000000000001"]);
  const ctx = { id: "cv_000000000001", convSlug: "abc", slug: "plan" };
  assert.ok(M.isAllowedDir(["abc"], ctx));
  assert.ok(M.isAllowedDir(["abc", "plan.assets"], ctx));
  for (const p of [["other"], [".katashiro"], ["abc", "other.assets"], ["abc", "plan.assets", "x"], []]) assert.ok(!M.isAllowedDir(p, ctx), p.join("/"));
});

test("createTitleSettle: one call per conversation once its title has stopped changing", () => {
  const timers = [];
  const settled = [];
  const s = M.createTitleSettle({
    settled: (id) => settled.push(id), quietMs: 10,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
    clearTimer: (t) => { t.live = false; },
  });
  s.changed(["c_000000000001"]);
  s.changed(["c_000000000001", "c_000000000002"]);                       // auto title, then set_title
  assert.deepEqual(s.pending().sort(), ["c_000000000001", "c_000000000002"]);
  for (const t of timers) if (t.live) t.fn();
  assert.deepEqual(settled.sort(), ["c_000000000001", "c_000000000002"]);
  assert.deepEqual(s.pending(), []);
  assert.equal(timers.filter((t) => t.ms === 10).length, 3);
});

const CID = "c_0123456789ab";
const CID2 = "c_fedcba987654";
async function setTitle(env, id, title) {
  const idx = (await env.storage.get("conv:index"))["conv:index"] || {};
  await env.storage.set({ "conv:index": { ...idx, [id]: { ...(idx[id] || {}), title, titleSource: title ? "user" : null } } });
}

test("the conversation folder is <short id>-<title slug>; untitled → the short id", async () => {
  const env = setup();
  await setTitle(env, CID, "市場調查");
  await setTitle(env, CID2, null);
  const a = await env.store.agentWrite({ conversationId: CID, title: "Plan", content: "a" });
  const b = await env.store.agentWrite({ conversationId: CID2, title: "Plan", content: "b" });
  await env.mirror.syncAll();
  assert.equal(await readText(env.dir, "0123456-市場調查/plan.md"), "a");
  assert.equal(await readText(env.dir, "fedcba9/plan.md"), "b");
  assert.equal((await env.meta(a.id)).file.convBase, "0123456-市場調查");
  assert.equal(JSON.parse(await readText(env.dir, `.katashiro/${b.id}.json`)).conversation, "fedcba9");
});

test("renaming a conversation moves its canvases' files into the new folder; the old one goes when empty", async () => {
  const env = setup();
  await setTitle(env, CID, "Draft");
  const a = await env.store.agentWrite({ conversationId: CID, title: "Plan", content: "a" });
  const b = await env.store.agentWrite({ conversationId: CID, title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG1 } });
  const other = await env.store.agentWrite({ conversationId: CID2, title: "Plan", content: "z" });
  await setTitle(env, CID2, "Else");
  await env.mirror.syncAll();
  await setTitle(env, CID, "Final report");
  const counts = await env.mirror.syncConversation(CID);
  assert.deepEqual(counts, { adopt: 2 });                                // moved as they are: nothing to write (the link is relative)
  assert.equal(env.dir.entries.has("0123456-draft"), false);
  const files = listFiles(await env.dir.getDirectoryHandle("0123456-final-report"));
  assert.equal(files.length, 3);
  assert.ok(files.includes("plan.md") && files.includes("shot.md") && files.some((f) => f.startsWith("shot.assets/")));
  assert.equal(await readText(env.dir, "fedcba9-else/plan.md"), "z");     // another conversation is untouched
  for (const id of [a.id, b.id]) assert.equal((await env.meta(id)).file.convSlug, "0123456-final-report");
  assert.equal((await env.meta(other.id)).file.convSlug, "fedcba9-else");
  // A file the user put in the conversation folder is never moved, and keeps the old folder.
  await writeText(env.dir, "0123456-final-report/notes.txt", "mine");
  await setTitle(env, CID, "Final");
  await env.mirror.syncConversation(CID);
  assert.deepEqual(listFiles(await env.dir.getDirectoryHandle("0123456-final-report")), ["notes.txt"]);
  assert.equal(listFiles(await env.dir.getDirectoryHandle("0123456-final")).length, 3);
});

test("legacy c_<id> folders are migrated to the new name on the next sync; a deleted file stays put", async () => {
  const env = setup();
  await setTitle(env, CID, "Research");
  const a = await env.store.agentWrite({ conversationId: CID, title: "Plan", content: "a" });
  const b = await env.store.agentWrite({ conversationId: CID, title: "Gone", content: "b" });
  const c = await env.store.agentWrite({ conversationId: CID, title: "Unseen", content: "c" });
  await env.mirror.syncAll();
  // Make it look like a mirror written before multi-conversation: c_<id> folder, no convBase.
  env.dir.entries.set(CID, env.dir.entries.get("0123456-research"));
  env.dir.entries.delete("0123456-research");
  for (const id of [a.id, b.id, c.id]) {
    const m = await env.meta(id);
    const file = { ...m.file, convSlug: CID };
    delete file.convBase;
    await env.storage.set({ [CanvasStore.metaKey(id)]: { ...m, file } });
  }
  // Deleted outside and seen as deleted (state "deleted"): it stays where it is, nothing moves.
  (await env.dir.getDirectoryHandle(CID)).removeEntry("gone.md");
  const mb = await env.meta(b.id);
  await env.storage.set({ [CanvasStore.metaKey(b.id)]: { ...mb, file: { ...mb.file, state: "deleted" } } });
  // Deleted outside, not noticed yet: the move finds it gone, which marks it deleted — the
  // migration does not bring it back under the new folder.
  (await env.dir.getDirectoryHandle(CID)).removeEntry("unseen.md");
  await env.mirror.syncAll();
  assert.equal((await env.meta(c.id)).file.state, "deleted");
  assert.equal((await env.meta(c.id)).file.move, undefined);               // the move is over: nothing left to move
  assert.equal(await readText(env.dir, "0123456-research/plan.md"), "a");
  assert.equal((await env.meta(a.id)).file.convSlug, "0123456-research");
  // The deleted one writes nothing (not under the new folder either) and keeps its old record.
  assert.equal((await env.meta(b.id)).file.convSlug, CID);
  assert.deepEqual(listFiles(env.dir).filter((f) => !f.startsWith(".katashiro/")), ["0123456-research/plan.md"]);
  assert.equal(env.dir.entries.has(CID), false);                         // emptied, so removed
  // 重新寫入 brings it back, under the new folder.
  assert.equal((await env.mirror.sync(c.id, { rewrite: true })).action, "write");
  assert.equal(await readText(env.dir, "0123456-research/unseen.md"), "c");
});

test("a conversation with no index entry keeps its folder; same-titled conversations stay apart", async () => {
  const env = setup();
  await setTitle(env, CID, "Plan");
  const a = await env.store.agentWrite({ conversationId: CID, title: "Doc", content: "a" });
  await env.mirror.sync(a.id);
  await env.storage.set({ "conv:index": {} });                           // entry gone (deleted conversation)
  await env.store.userSave({ id: a.id, baseVersion: 1, content: "a2" });
  await env.mirror.sync(a.id);
  assert.equal(await readText(env.dir, "0123456-plan/doc.md"), "a2");
  await setTitle(env, CID2, "Plan");
  const b = await env.store.agentWrite({ conversationId: CID2, title: "Doc", content: "b" });
  await env.mirror.sync(b.id);
  assert.equal(await readText(env.dir, "fedcba9-plan/doc.md"), "b");
});

test("image canvas: the asset by magic bytes under <slug>.assets/<sha256>.<ext>, linked relatively; SVG never written", async () => {
  const env = setup();
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  // Declared as jpeg: the extension still comes from the bytes.
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Shot", kind: "image", image: { mimeType: "image/jpeg", data: PNG }, caption: "one [px]" });
  await env.mirror.sync(id);
  const hash = JSON.parse((await env.store.read({ id })).content).image;
  const md = await readText(env.dir, "c/shot.md");
  assert.equal(md, `![one  px ](shot.assets/${hash}.png)\n\none [px]\n`);
  const asset = await entryAt(env.dir, `c/shot.assets/${hash}.png`);
  assert.deepEqual(Buffer.from(asset.bytes), Buffer.from(PNG, "base64"));
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString("base64");
  const s = await env.store.agentWrite({ conversationId: "c", title: "Vector", kind: "image", image: { mimeType: "image/svg+xml", data: SVG } });
  await env.mirror.sync(s.id);
  assert.match(await readText(env.dir, "c/vector.md"), /kept in Katashiro only/);
  assert.equal(await entryAt(env.dir, "c/vector.assets"), null);
});

test("canvases left by incognito windows (noMirror, before #109) are never written", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Secret", content: "x" });
  await env.storage.set({ [CanvasStore.metaKey(id)]: { ...(await env.meta(id)), noMirror: true } });
  assert.deepEqual(await env.mirror.sync(id), { action: "skipped" });
  assert.deepEqual(await env.mirror.syncAll(), {});
  assert.deepEqual(listFiles(env.dir), []);
});

test("a failing write never fails the canvas: recorded as state error, retried on the next sync", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1" });
  await env.mirror.sync(id);
  (await entryAt(env.dir, "c/plan.md")).failWrites = true;
  const r2 = await env.store.userSave({ id, baseVersion: 1, content: "v2" });
  assert.equal(r2.version, 2);                                             // the save itself succeeded
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "error");
  assert.match(r.error, /disk full/);
  assert.equal((await env.meta(id)).file.state, "error");
  // The same failure again does not rewrite meta (no onChanged loop between panel and tab).
  const sets = env.storage.sets;
  await env.mirror.sync(id);
  assert.equal(env.storage.sets, sets);
  (await entryAt(env.dir, "c/plan.md")).failWrites = false;
  assert.equal((await env.mirror.sync(id)).action, "write");
  assert.equal(await readText(env.dir, "c/plan.md"), "v2");
});

test("permission withdrawn mid-sync reads as disconnected, not an error", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1" });
  env.dir.getDirectoryHandle = async () => { throw domErr("NotAllowedError"); };
  assert.deepEqual(await env.mirror.sync(id), { action: "disconnected" });
});

test("another folder: slugs and hashes start over (files there were never written by Katashiro)", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1" });
  await env.mirror.sync(id);
  env.dir = fakeDir("other");
  env.folderId = "f2";
  await writeText(env.dir, "c/plan.md", "unrelated\n");
  assert.equal((await env.mirror.sync(id)).action, "write");
  assert.equal(await readText(env.dir, "c/plan.md"), "unrelated\n");
  assert.equal(await readText(env.dir, "c/plan-2.md"), "v1");
  assert.equal((await env.meta(id)).file.folder, "f2");
});

test("folder A → B → A: A's hashes are remembered, so A's files are still Katashiro's", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c_abc", title: "Notes", content: "# v1\n" });
  await env.mirror.sync(id);
  const dirA = env.dir;
  env.dir = fakeDir("b");
  env.folderId = "f2";
  await env.mirror.sync(id);
  assert.equal((await env.meta(id)).file.folder, "f2");
  assert.equal((await env.meta(id)).filesByFolder.f1.slug, "notes");
  env.dir = dirA;
  env.folderId = "f1";
  // Back on A with nothing new: the remembered state is restored (no shortcut on syncedHash).
  assert.equal((await env.mirror.sync(id)).action, "adopt");
  let meta = await env.meta(id);
  assert.equal(meta.file.folder, "f1");
  assert.equal(meta.filesByFolder.f2.slug, "notes");
  await env.store.agentWrite({ conversationId: "c_abc", id, baseVersion: meta.version, title: "Notes", content: "# v2\n" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "write");
  assert.equal(await readText(dirA, "c_abc/notes.md"), "# v2\n");
  assert.deepEqual(listFiles(dirA).filter((p) => p.startsWith("c_abc/")), ["c_abc/notes.md"]);
  // Another canvas cannot take A's slug while it is only remembered.
  env.dir = fakeDir("c");
  env.folderId = "f3";
  await env.mirror.sync(id);
  env.dir = dirA;
  env.folderId = "f1";
  const other = await env.store.agentWrite({ conversationId: "c_abc", title: "Notes", content: "other\n" });
  await env.mirror.sync(other.id);
  assert.equal((await env.meta(other.id)).file.slug, "notes-2");
});

test("withFile: the replaced folder's state is remembered, at most 3, newest kept", () => {
  let m = { id: "x", file: { folder: "a", slug: "s" } };
  for (const f of ["b", "c", "d", "e"]) m = M.withFile(m, { folder: f, slug: "s" });
  assert.equal(m.file.folder, "e");
  assert.deepEqual(Object.keys(m.filesByFolder), ["b", "c", "d"]);
  m = M.withFile(m, { folder: "c", slug: "s2" });             // back to c: it leaves the memory
  assert.equal(m.file.slug, "s2");
  assert.deepEqual(Object.keys(m.filesByFolder), ["b", "d", "e"]);
  assert.deepEqual(M.withFile({ id: "y" }, { folder: "a" }), { id: "y", file: { folder: "a" } });
  assert.ok(M.onlyMirrorFieldsChanged({ id: "x" }, { id: "x", filesByFolder: { a: {} } }));
});

test("describeState: header text for each state", () => {
  assert.equal(M.describeState(null), null);
  assert.equal(M.describeState({ state: "ok" }).level, "ok");
  assert.match(M.describeState({ state: "changed", conflictName: "p.katashiro-1.md" }).title, /changed outside Katashiro.*p\.katashiro-1\.md/);
  assert.match(M.describeState({ state: "missing" }).text, /不再同步/);
  assert.match(M.describeState({ state: "deleted" }).text, /不再同步/);
  assert.equal(M.describeState({ state: "error", error: "x" }).title, "x");
});

test("a mermaid canvas is mirrored as one ```mermaid fence, longer than any backtick run inside", async () => {
  assert.equal(M.mermaidMarkdown("graph TD\n  A-->B\n\n"), "```mermaid\ngraph TD\n  A-->B\n```\n");
  assert.equal(M.mermaidMarkdown("graph TD\n  A[\"````\"]"), "`````mermaid\ngraph TD\n  A[\"````\"]\n`````\n");
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c_abc", title: "Flow", kind: "mermaid", content: "graph TD\n  A-->B\n" });
  assert.equal((await env.mirror.sync(id)).action, "write");
  assert.equal(await readText(env.dir, "c_abc/flow.md"), "```mermaid\ngraph TD\n  A-->B\n```\n");
});

test("§7.3 a canvas moved to another conversation: its files move to that conversation's folder", async () => {
  const env = setup();
  await setTitle(env, CID, "Draft");
  await setTitle(env, CID2, "Topic");
  const a = await env.store.agentWrite({ conversationId: CID, title: "Plan", content: "a" });
  const stay = await env.store.agentWrite({ conversationId: CID, title: "Stays", content: "s" });
  const there = await env.store.agentWrite({ conversationId: CID2, title: "Plan", content: "p" });   // same title there
  await env.mirror.syncAll();
  await env.store.move({ id: a.id, from: CID, to: CID2 });
  const r = await env.mirror.sync(a.id);
  assert.notEqual(r.action, "error", JSON.stringify(r));
  assert.equal(await readText(env.dir, "0123456-draft/plan.md"), null);
  assert.equal(await readText(env.dir, "0123456-draft/stays.md"), "s");     // its old neighbour stays
  assert.equal((await env.meta(a.id)).file.convSlug, "fedcba9-topic");
  assert.equal((await env.meta(a.id)).file.move, undefined);
  const slug = (await env.meta(a.id)).file.slug;
  assert.notEqual(slug, (await env.meta(there.id)).file.slug);              // no clash with the canvas already there
  assert.equal(await readText(env.dir, `fedcba9-topic/${slug}.md`), "a");
  assert.equal(await readText(env.dir, "fedcba9-topic/plan.md"), "p");
  assert.equal(JSON.parse(await readText(env.dir, `.katashiro/${a.id}.json`)).conversation, "fedcba9-topic");
  assert.equal((await env.meta(stay.id)).file.convSlug, "0123456-draft");
});
