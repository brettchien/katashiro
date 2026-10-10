// canvas-mirror.test.js — ADR docs/adr/canvas.md §3.6 local folder mirror: slugs, path checks,
// write-through without clobbering outside edits, conflict files, file-missing, rename, assets,
// incognito, and catch-up — on a fake FileSystemDirectoryHandle.
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
function fakeDir(name = "root") {
  const entries = new Map();
  const checkName = (n) => { if (!n || n === "." || n === ".." || /[/\\]/.test(n)) throw new TypeError(`bad name ${n}`); };
  return {
    kind: "directory", name, entries,
    async getDirectoryHandle(n, { create = false } = {}) {
      checkName(n);
      let e = entries.get(n);
      if (!e) {
        if (!create) throw domErr("NotFoundError");
        e = { kind: "dir", dir: fakeDir(n) };
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
      return {
        async getFile() { return { async arrayBuffer() { return e.bytes.slice().buffer; } }; },
        async createWritable() {
          if (e.failWrites) throw new Error("disk full");
          let buf = new Uint8Array();
          return { async write(b) { buf = new Uint8Array(b); }, async close() { e.bytes = buf; }, async abort() {} };
        },
      };
    },
    async removeEntry(n) {
      if (!entries.has(n)) throw domErr("NotFoundError");
      entries.delete(n);
    },
  };
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

function setup({ noMirror = false, connected = true } = {}) {
  const storage = memStorage();
  const lock = memLock();
  let n = 0;
  let t = Date.UTC(2026, 9, 10, 12, 0, 0);
  const now = () => t;
  const store = CanvasStore.createCanvasStore({
    storage, lock, now, randomHex: () => (++n).toString(16).padStart(12, "0"), noMirror: () => noMirror,
  });
  const dir = fakeDir();
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

test("a file Katashiro never wrote already at the path is treated as changed", async () => {
  const env = setup();
  await writeText(env.dir, "c/plan.md", "someone else's\n");
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "mine\n" });
  const r = await env.mirror.sync(id);
  assert.equal(r.action, "conflict");
  assert.equal(await readText(env.dir, "c/plan.md"), "someone else's\n");
  // A directory at the path is not a file to overwrite either.
  const env2 = setup();
  await writeText(env2.dir, "c/plan.md/inner", "x");
  const b = await env2.store.agentWrite({ conversationId: "c", title: "Plan", content: "mine\n" });
  assert.equal((await env2.mirror.sync(b.id)).action, "conflict");
});

test("file deleted outside: the canvas is marked file missing, never deleted; the next save writes it again", async () => {
  const env = setup();
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Plan", content: "v1\n" });
  await env.mirror.sync(id);
  (await env.dir.getDirectoryHandle("c")).removeEntry("plan.md");
  const r = await env.mirror.sync(id, { check: true });
  assert.deepEqual(r, { action: "none", state: "missing" });
  assert.equal((await env.meta(id)).file.state, "missing");
  assert.equal(await readText(env.dir, "c/plan.md"), null);              // not recreated on open
  assert.equal((await env.store.read({ id })).content, "v1\n");          // the canvas is intact
  await env.store.userSave({ id, baseVersion: 1, content: "v2\n" });
  const w = await env.mirror.sync(id);
  assert.equal(w.state, "recreated");
  assert.equal(await readText(env.dir, "c/plan.md"), "v2\n");
  // check also notices an outside change while nothing is pending
  await writeText(env.dir, "c/plan.md", "outside\n");
  assert.equal((await env.mirror.sync(id, { check: true })).state, "changed");
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

test("rename moves the file only if it is still what Katashiro wrote", async () => {
  const env = setup();
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
  assert.equal((await env.meta(id)).file.state, "ok");
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

test("incognito canvases (noMirror) are never written", async () => {
  const env = setup({ noMirror: true });
  const { id } = await env.store.agentWrite({ conversationId: "c", title: "Secret", content: "x" });
  assert.equal((await env.meta(id)).noMirror, true);
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
  assert.equal((await env.mirror.sync(id)).action, "conflict");
  assert.equal((await env.meta(id)).file.folder, "f2");
});

test("describeState: header text for each state", () => {
  assert.equal(M.describeState(null), null);
  assert.equal(M.describeState({ state: "ok" }).level, "ok");
  assert.match(M.describeState({ state: "changed", conflictName: "p.katashiro-1.md" }).title, /changed outside Katashiro.*p\.katashiro-1\.md/);
  assert.match(M.describeState({ state: "missing" }).text, /不見/);
  assert.equal(M.describeState({ state: "error", error: "x" }).title, "x");
});
