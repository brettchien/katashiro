// canvas-store.test.js — ADR docs/adr/canvas.md §3.5/§3.6: revision counter, stale writes, limits,
// per-conversation index, and that the lock really serializes concurrent writers.
const test = require("node:test");
const assert = require("node:assert/strict");
const CanvasStore = require("../canvas-store.js");

function memStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      const ks = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      await new Promise((r) => setTimeout(r, 1));       // yield, so unlocked writers would interleave
      return out;
    },
    async set(items) {
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

function store(extra = {}) {
  const storage = memStorage();
  let n = 0;
  const s = CanvasStore.createCanvasStore({
    storage, lock: memLock(), now: () => 1_700_000_000_000 + n, randomHex: () => (++n).toString(16).padStart(12, "0"), ...extra,
  });
  return { s, storage };
}

test("create → version 1, agent-authored, readable, listed in its conversation only", async () => {
  const { s } = store();
  const r = await s.agentWrite({ conversationId: "c_a", title: "Plan", content: "# Hi" });
  assert.equal(r.created, true);
  assert.equal(r.version, 1);
  assert.match(r.id, CanvasStore.ID_RE);
  const got = await s.read({ conversationId: "c_a", id: r.id });
  assert.equal(got.content, "# Hi");
  assert.equal(got.author, "agent");
  assert.equal(got.agentVersion, 1);
  assert.equal((await s.list({ conversationId: "c_a" })).length, 1);
  assert.equal((await s.list({ conversationId: "c_b" })).length, 0);
  await assert.rejects(() => s.read({ conversationId: "c_b", id: r.id }), /no canvas/);
});

test("update needs the current baseVersion; the counter goes up and the index follows", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await assert.rejects(() => s.agentWrite({ conversationId: "c", id, title: "T", content: "b" }), /baseVersion/);
  const r2 = await s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T2", content: "b" });
  assert.equal(r2.version, 2);
  const got = await s.read({ conversationId: "c", id });
  assert.equal(got.content, "b");
  assert.equal(got.title, "T2");
  const [entry] = await s.list({ conversationId: "c" });
  assert.equal(entry.version, 2);
  assert.equal(entry.title, "T2");
});

test("a stale baseVersion is refused with a structured error and changes nothing", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "b" });
  await assert.rejects(
    () => s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "c" }),
    (e) => e.code === "stale" && e.currentVersion === 2 && e.author === "agent"
  );
  assert.equal((await s.read({ conversationId: "c", id })).content, "b");
});

test("the lock serializes writers: two writes from the same base → exactly one wins", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  const results = await Promise.allSettled([
    s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "x" }),
    s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "y" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason.code === "stale").length, 1);
  assert.equal((await s.read({ conversationId: "c", id })).version, 2);
});

test("concurrent creates in one conversation all land in the index", async () => {
  const { s } = store();
  await Promise.all([1, 2, 3, 4].map((i) => s.agentWrite({ conversationId: "c", title: `T${i}`, content: "x" })));
  assert.equal((await s.list({ conversationId: "c" })).length, 4);
});

test("limits: title required and ≤ 120, content a string ≤ 2 MB, kind markdown only, no kind change", async () => {
  const { s } = store();
  await assert.rejects(() => s.agentWrite({ conversationId: "c", title: " ", content: "x" }), /title/);
  await assert.rejects(() => s.agentWrite({ conversationId: "c", title: "x".repeat(121), content: "x" }), /121 chars/);
  await assert.rejects(() => s.agentWrite({ conversationId: "c", title: "t", content: 5 }), /string/);
  await assert.rejects(() => s.agentWrite({ conversationId: "c", title: "t", content: "é".repeat(CanvasStore.CONTENT_MAX_BYTES / 2 + 1) }), /capped/);
  await assert.rejects(() => s.agentWrite({ conversationId: "c", title: "t", kind: "html", content: "x" }), /not supported yet/);
  await assert.rejects(() => s.agentWrite({ conversationId: "", title: "t", content: "x" }), /conversation/);
});

test("ids are validated and confined to their conversation", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await assert.rejects(() => s.agentWrite({ conversationId: "c", id: "../x", baseVersion: 1, title: "T", content: "b" }), /not a canvas id/);
  await assert.rejects(() => s.agentWrite({ conversationId: "other", id, baseVersion: 1, title: "T", content: "b" }), /another conversation/);
  await assert.rejects(() => s.agentWrite({ conversationId: "c", id: "cv_ffffffffffff", baseVersion: 1, title: "T", content: "b" }), /no canvas/);
});

test("content and meta land in one set(), so onChanged fires once with a consistent pair", async () => {
  const calls = [];
  const storage = memStorage();
  const set = storage.set;
  storage.set = async (items) => { calls.push(Object.keys(items).sort()); return set(items); };
  const s = CanvasStore.createCanvasStore({ storage, lock: memLock(), randomHex: () => "0123456789ab" });
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "b" });
  const body = calls.filter((ks) => ks.some((k) => k.startsWith(`canvas:${id}:`)));
  assert.deepEqual(body, [[`canvas:${id}:latest`, `canvas:${id}:meta`], [`canvas:${id}:latest`, `canvas:${id}:meta`]]);
});

test("the index is updated while the canvas lock is still held, so its version cannot go backwards", async () => {
  const held = new Set();
  const nested = [];
  const inner = memLock();
  const lock = (name, fn) => inner(name, async () => {
    if (name === "canvas:index") nested.push([...held]);
    held.add(name);
    try { return await fn(); } finally { held.delete(name); }
  });
  const s = CanvasStore.createCanvasStore({ storage: memStorage(), lock, randomHex: () => "0123456789ab" });
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  const w2 = s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "b" });
  const w3 = w2.then(() => s.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "T", content: "c" }));
  await Promise.all([w2, w3]);
  assert.deepEqual(nested, [[`canvas:${id}`], [`canvas:${id}`], [`canvas:${id}`]]);
  assert.equal((await s.list({ conversationId: "c" }))[0].version, 3);
});

// --- #70: delete, last-opened, budget ---------------------------------------------------

test("remove deletes the bodies, the meta and the index entry (empty index key removed)", async () => {
  const { s, storage } = store();
  const a = await s.agentWrite({ conversationId: "c", title: "A", content: "aa" });
  const b = await s.agentWrite({ conversationId: "c", title: "B", content: "bb" });
  await s.remove({ id: a.id });
  assert.deepEqual((await s.list({ conversationId: "c" })).map((e) => e.id), [b.id]);
  await assert.rejects(() => s.read({ conversationId: "c", id: a.id }), /no canvas/);
  await assert.rejects(() => s.remove({ conversationId: "other", id: b.id }), /no canvas/);
  await s.remove({ id: b.id });
  assert.deepEqual(Object.keys(storage.data), []);
  await s.remove({ id: b.id });                                   // already gone: a no-op
});

// #80: canvas_delete asks first; a canvas saved while the question waits is not the one approved.
test("remove with expectVersion removes only that version, checked under the canvas lock", async () => {
  const lock = memLock();
  const { s, storage } = store({ lock });
  const a = await s.agentWrite({ conversationId: "c", title: "A", content: "aa" });
  assert.deepEqual(await s.remove({ id: a.id, expectVersion: 2 }), { removed: false, version: 1 });
  assert.equal((await s.read({ id: a.id })).version, 1);           // kept
  // A writer holds canvas:<id> and moves the canvas to v2 while the removal waits for the lock:
  // the removal must read the meta only once it holds the lock, so it sees v2 and keeps it.
  let release;
  const held = lock(`canvas:${a.id}`, () => new Promise((r) => { release = r; }));
  const pending = s.remove({ conversationId: "c", id: a.id, expectVersion: 1 });
  await new Promise((r) => setTimeout(r, 5));
  storage.data[CanvasStore.metaKey(a.id)].version = 2;
  release();
  await held;
  assert.deepEqual(await pending, { removed: false, version: 2 });
  assert.equal((await s.read({ id: a.id })).content, "aa");
  assert.deepEqual(await s.remove({ id: a.id, expectVersion: 2 }), { removed: true, version: 2 });
  assert.deepEqual((await s.list({ conversationId: "c" })), []);
  assert.deepEqual(await s.remove({ id: a.id, expectVersion: 2 }), { removed: false, version: null }); // gone
  const b = await s.agentWrite({ conversationId: "c", title: "B", content: "bb" });
  assert.deepEqual(await s.remove({ id: b.id }), { removed: true, version: 1 });  // no expectVersion: as before
});

// #109: Katashiro no longer runs in incognito; what incognito panels stored before is removed.
test("incognitoLeftovers selects exactly the noMirror metas with a canvas id", () => {
  const ids = CanvasStore.incognitoLeftovers([
    { id: "cv_000000000001" },
    { id: "cv_000000000002", noMirror: true },
    { id: "cv_000000000003", noMirror: false },
    { id: "not-an-id", noMirror: true },
    { id: "cv_000000000004", noMirror: "yes" },
    null,
    { id: "cv_000000000005", noMirror: true },
  ]);
  assert.deepEqual(ids, ["cv_000000000002", "cv_000000000005"]);
  assert.deepEqual(CanvasStore.incognitoLeftovers(undefined), []);
});

test("removeIncognitoLeftovers removes only noMirror canvases, through remove (index kept consistent)", async () => {
  const { s, storage } = store();
  const keep = await s.agentWrite({ conversationId: "c", title: "Normal", content: "aa" });
  const gone = await s.agentWrite({ conversationId: "c", title: "Incognito", content: "bb" });
  const alone = await s.agentWrite({ conversationId: "c_inc", title: "Incognito 2", content: "cc" });
  for (const id of [gone.id, alone.id]) {
    const k = CanvasStore.metaKey(id);
    storage.data[k] = { ...storage.data[k], noMirror: true };     // as an incognito panel wrote it
  }
  assert.equal(await s.removeIncognitoLeftovers(), 2);
  assert.deepEqual((await s.list({ conversationId: "c" })).map((e) => e.id), [keep.id]);
  assert.equal(CanvasStore.indexKey("c_inc") in storage.data, false);     // its conversation's index went too
  assert.equal(CanvasStore.metaKey(gone.id) in storage.data, false);
  assert.equal(CanvasStore.latestKey(alone.id) in storage.data, false);
  assert.equal(await s.removeIncognitoLeftovers(), 0);                     // once they are gone: nothing
});

test("background.js runs the incognito cleanup on onInstalled (install / update)", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const { s, storage } = store();
  const keep = await s.agentWrite({ conversationId: "c", title: "Normal", content: "aa" });
  const gone = await s.agentWrite({ conversationId: "c", title: "Incognito", content: "bb" });
  const k = CanvasStore.metaKey(gone.id);
  storage.data[k] = { ...storage.data[k], noMirror: true };
  let onInstalled = null;
  const lock = memLock();
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    navigator: { locks: { request: (name, fn) => lock(name, fn) } },
    chrome: {
      storage: { local: storage },
      sidePanel: { setPanelBehavior: async () => {} },
      runtime: { onInstalled: { addListener: (fn) => { onInstalled = fn; } } },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.crypto = globalThis.crypto;
  sandbox.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), sandbox);
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), sandbox);
  assert.equal(typeof onInstalled, "function");
  onInstalled({ reason: "update" });
  const indexed = () => (storage.data[CanvasStore.indexKey("c")] || []).length;
  for (let i = 0; i < 400 && indexed() !== 1; i++) await new Promise((r) => setTimeout(r, 5));   // best effort, not awaited
  assert.equal(k in storage.data, false);
  assert.deepEqual((await s.list({ conversationId: "c" })).map((e) => e.id), [keep.id]);
});

test("a new canvas is never marked noMirror any more (#109), whatever the host passes", async () => {
  const { s, storage } = store({ noMirror: () => true });
  const { id } = await s.agentWrite({ conversationId: "c", title: "A", content: "a" });
  assert.equal("noMirror" in storage.data[CanvasStore.metaKey(id)], false);
});

test("touch records openedAt without changing the version", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "A", content: "a" });
  await s.touch(id);
  const r = await s.read({ conversationId: "c", id });
  assert.equal(r.version, 1);
  assert.ok(r.openedAt > r.at);
});

test("budget: under it nothing is asked; over it the least recently opened, unopened canvases go after one confirmation", async () => {
  const asked = [];
  let answer = true;
  const open = new Set();
  const { s } = store({
    budgetBytes: 10,
    isOpen: async (id) => open.has(id),
    confirmEvict: async (info) => { asked.push(info); return answer; },
  });
  const a = await s.agentWrite({ conversationId: "c", title: "A", content: "aaaa" });   // 4
  const b = await s.agentWrite({ conversationId: "c", title: "B", content: "bbbb" });   // 8
  assert.equal(asked.length, 0);
  await s.touch(a.id);                                // a opened more recently than b
  open.add(b.id);                                     // …but b is open in a tab: never evicted
  const c = await s.agentWrite({ conversationId: "d", title: "C", content: "cccc" });   // 12 > 10
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].evict.map((e) => e.id), [a.id]);
  assert.equal((await s.usage()).total, 8);
  answer = false;
  await assert.rejects(() => s.agentWrite({ conversationId: "d", title: "D", content: "dddd" }), (e) => e.code === "quota");
  assert.equal((await s.usage()).count, 2);           // nothing written, nothing removed
  // rewriting an existing canvas only counts the difference
  await s.agentWrite({ conversationId: "d", id: c.id, baseVersion: 1, title: "C", content: "cc" });
  assert.equal((await s.usage()).total, 6);
});

test("budget: when even evicting everything allowed is not enough, it fails without asking", async () => {
  const asked = [];
  const { s } = store({ budgetBytes: 5, confirmEvict: async (i) => { asked.push(i); return true; } });
  await assert.rejects(() => s.agentWrite({ conversationId: "c", title: "Big", content: "x".repeat(6) }), (e) => e.code === "quota");
  assert.equal(asked.length, 0);
});

test("budget: a storage override (≥ 1 MB) replaces 200 MB, read on every check; junk is ignored", async () => {
  const asked = [];
  const { s, storage } = store({ confirmEvict: async (i) => { asked.push(i); return true; } });
  const K = CanvasStore.BUDGET_OVERRIDE_KEY, MB = 1024 * 1024;
  assert.equal((await s.usage()).budget, CanvasStore.BUDGET_BYTES);
  await storage.set({ [K]: 1000 });                   // under the 1 MB floor → ignored
  assert.equal((await s.usage()).budget, CanvasStore.BUDGET_BYTES);
  await storage.set({ [K]: "2097152" });              // not a number → ignored
  assert.equal((await s.usage()).budget, CanvasStore.BUDGET_BYTES);
  await storage.set({ [K]: 1.5 * MB + 0.5 });         // not an integer → floored
  assert.equal((await s.usage()).budget, 1.5 * MB);
  await storage.set({ [K]: 300 * MB });               // over 200 MB → capped
  assert.equal((await s.usage()).budget, CanvasStore.BUDGET_BYTES);
  await storage.set({ [K]: MB });
  assert.equal((await s.usage()).budget, MB);
  await s.agentWrite({ conversationId: "c", title: "A", content: "a".repeat(600 * 1024) });
  await s.agentWrite({ conversationId: "c", title: "B", content: "b".repeat(600 * 1024) });   // 1.2 MB > 1 MB
  assert.equal(asked.length, 1);
  assert.equal((await s.usage()).count, 1);
  await storage.remove(K);                            // back to 200 MB, no reload
  await s.agentWrite({ conversationId: "c", title: "C", content: "c".repeat(600 * 1024) });
  assert.equal(asked.length, 1);
});

test("budget: an explicit budgetBytes wins over the storage override", async () => {
  const { s, storage } = store({ budgetBytes: 10 });
  await storage.set({ [CanvasStore.BUDGET_OVERRIDE_KEY]: 5 * 1024 * 1024 });
  assert.equal((await s.usage()).budget, 10);
});

test("budget: a canvas opened while the confirmation was up is kept", async () => {
  const open = new Set();
  let a;
  const { s } = store({
    budgetBytes: 10,
    isOpen: async (id) => open.has(id),
    confirmEvict: async () => { open.add(a.id); return true; },   // user opens it before answering
  });
  a = await s.agentWrite({ conversationId: "c", title: "A", content: "aaaa" });
  await s.agentWrite({ conversationId: "c", title: "B", content: "bbbb" });
  await s.agentWrite({ conversationId: "d", title: "C", content: "cccc" });  // over → asks to evict A
  assert.equal((await s.usage()).count, 3);           // A survived; soft cap, slightly over
});

test("getMatching: with getKeys only the matching keys are read; without it one full scan is filtered", async () => {
  const storage = memStorage();
  Object.assign(storage.data, { "history:1": { m: 1 }, "canvas:cv_000000000000:latest": { big: true }, "history:2": { m: 2 } });
  const read = [];
  const get = storage.get.bind(storage);
  storage.get = async (keys) => { read.push(keys); return get(keys); };
  const isHistory = (k) => k.startsWith("history:");
  const want = { "history:1": { m: 1 }, "history:2": { m: 2 } };
  assert.deepEqual(await CanvasStore.getMatching(storage, isHistory), want);
  assert.deepEqual(read, [null]);
  read.length = 0;
  storage.getKeys = async () => Object.keys(storage.data);
  assert.deepEqual(await CanvasStore.getMatching(storage, isHistory), want);
  assert.deepEqual(read, [["history:1", "history:2"]]);
  assert.deepEqual(await CanvasStore.getMatching(storage, () => false), {});
});

// --- PR 2: slides and image canvases --------------------------------------------------------

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const GIF = "R0lGODlhAQABAAAAACw=";

test("slides is a text kind like markdown", async () => {
  const { s } = store();
  const r = await s.agentWrite({ conversationId: "c", title: "Deck", kind: "slides", content: "# A\n---\n# B" });
  assert.equal((await s.read({ conversationId: "c", id: r.id })).kind, "slides");
});

test("image canvas: bytes stored once by sha256, content is a small JSON reference", async () => {
  const { s, storage } = store();
  const a = await s.agentWrite({ conversationId: "c", title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG }, caption: "one px" });
  await s.agentWrite({ conversationId: "c", title: "Shot again", kind: "image", image: { mimeType: "image/png", data: PNG } });
  const imgKeys = Object.keys(storage.data).filter((k) => k.startsWith("canvas:img:"));
  assert.equal(imgKeys.length, 1);                                      // deduplicated
  const hash = await CanvasStore.sha256OfBase64(PNG);
  assert.equal(imgKeys[0], `canvas:img:${hash}`);
  const r = await s.read({ conversationId: "c", id: a.id });
  assert.deepEqual(JSON.parse(r.content), { image: hash, mimeType: "image/png", caption: "one px" });
  assert.equal((await s.readImage(hash)).data, PNG);
  assert.equal(await s.readImage("../x"), null);
});

test("image canvas: validation (type, base64, size, caption, needs an image)", async () => {
  const { s } = store();
  const w = (image, extra = {}) => s.agentWrite({ conversationId: "c", title: "T", kind: "image", image, ...extra });
  await assert.rejects(() => w(undefined), /needs an image/);
  await assert.rejects(() => w({ mimeType: "image/bmp", data: PNG }), /image type/);
  await assert.rejects(() => w({ mimeType: "image/png", data: "not base64!" }), /base64/);
  await assert.rejects(() => w({ mimeType: "image/png", data: "A".repeat(Math.ceil(CanvasStore.IMAGE_MAX_BYTES * 4 / 3) + 8) }), /capped/);
  await assert.rejects(() => w({ mimeType: "image/png", data: PNG }, { caption: "x".repeat(201) }), /caption/);
});

test("image sweep: replacing or deleting frees an image nobody references, after the grace period", async () => {
  let clock = 1_000_000;
  const { s, storage } = store({ now: () => clock });
  const a = await s.agentWrite({ conversationId: "c", title: "T", kind: "image", image: { mimeType: "image/png", data: PNG } });
  const pngKey = `canvas:img:${await CanvasStore.sha256OfBase64(PNG)}`;
  clock += 11 * 60 * 1000;                                              // past the 10-minute grace
  await s.agentWrite({ conversationId: "c", id: a.id, baseVersion: 1, title: "T", kind: "image", image: { mimeType: "image/gif", data: GIF } });
  assert.ok(!(pngKey in storage.data), "the replaced PNG is swept");
  const gifKey = `canvas:img:${await CanvasStore.sha256OfBase64(GIF)}`;
  assert.ok(gifKey in storage.data);
  await s.remove({ id: a.id });
  assert.ok(gifKey in storage.data, "inside the grace period it is kept");
  clock += 11 * 60 * 1000;
  await s.sweepImages();
  assert.ok(!(gifKey in storage.data));
});

test("an image shared by two canvases survives deleting one of them", async () => {
  let clock = 1_000_000;
  const { s, storage } = store({ now: () => clock });
  const a = await s.agentWrite({ conversationId: "c", title: "A", kind: "image", image: { mimeType: "image/png", data: PNG } });
  await s.agentWrite({ conversationId: "c", title: "B", kind: "image", image: { mimeType: "image/png", data: PNG } });
  clock += 11 * 60 * 1000;
  await s.remove({ id: a.id });
  assert.equal(Object.keys(storage.data).filter((k) => k.startsWith("canvas:img:")).length, 1);
});

test("reusing an old unreferenced image refreshes it, so a sweep before the content lands keeps it", async () => {
  let clock = 1_000_000;
  const { s, storage } = store({ now: () => clock });
  const a = await s.agentWrite({ conversationId: "c", title: "A", kind: "image", image: { mimeType: "image/png", data: PNG } });
  await s.remove({ id: a.id });                                         // PNG now unreferenced
  clock += 11 * 60 * 1000;                                              // and past the grace period
  const pngKey = `canvas:img:${await CanvasStore.sha256OfBase64(PNG)}`;
  const set = storage.set.bind(storage);
  storage.set = async (items) => {                                      // a sweep runs between image and content
    if (Object.keys(items).some((k) => k.endsWith(":latest"))) { storage.set = set; await s.sweepImages(); }
    return set(items);
  };
  await s.agentWrite({ conversationId: "c", title: "B", kind: "image", image: { mimeType: "image/png", data: PNG } });
  assert.ok(pngKey in storage.data, "the reused image survives the sweep");
});

test("a failing sweep does not fail the write or delete that triggered it", async () => {
  let clock = 1_000_000;
  const { s, storage } = store({ now: () => clock });
  const a = await s.agentWrite({ conversationId: "c", title: "A", kind: "image", image: { mimeType: "image/png", data: PNG } });
  clock += 11 * 60 * 1000;                                              // so the sweeps below do delete
  const remove = storage.remove.bind(storage);
  storage.remove = async (keys) => {
    if ([].concat(keys).some((k) => k.startsWith("canvas:img:"))) throw new Error("boom");
    return remove(keys);
  };
  const w = await s.agentWrite({ conversationId: "c", id: a.id, baseVersion: 1, title: "A", kind: "image", image: { mimeType: "image/gif", data: GIF } });
  assert.equal(w.version, 2);
  await s.remove({ id: a.id });
  assert.deepEqual(await s.list({ conversationId: "c" }), []);
});

test("image bytes count toward the budget", async () => {
  const { s } = store({ budgetBytes: 50 });
  await assert.rejects(
    () => s.agentWrite({ conversationId: "c", title: "T", kind: "image", image: { mimeType: "image/png", data: PNG } }),
    (e) => e.code === "quota"
  );
});

// --- PR 3: editing, agent copy, normalization (ADR §3.5) ----------------------------------

test("unifiedDiff: hunks with context, empty when equal", () => {
  assert.equal(CanvasStore.unifiedDiff("a\nb", "a\nb"), "");
  const d = CanvasStore.unifiedDiff("1\n2\n3\n4\n5\n6\n7", "1\n2\n3\nX\n5\n6\n7");
  assert.equal(d, "@@ -2,5 +2,5 @@\n 2\n 3\n-4\n+X\n 5\n 6");
  assert.match(CanvasStore.unifiedDiff("a", "a\nb"), /\+b/);
  assert.match(CanvasStore.unifiedDiff("a\nb", "b"), /-a/);
});

test("user save: needs the current version, keeps the agent's text as the agent copy, no-op when unchanged", async () => {
  const { s, storage } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "agent text" });
  assert.deepEqual(await s.userSave({ id, baseVersion: 1, content: "agent text" }), { version: 1, unchanged: true });
  await assert.rejects(() => s.userSave({ id, baseVersion: 0, content: "x" }), (e) => e.code === "stale");
  assert.deepEqual(await s.userSave({ id, baseVersion: 1, content: "user text" }), { version: 2, unchanged: false });
  const r = await s.read({ conversationId: "c", id });
  assert.equal(r.content, "user text");
  assert.equal(r.author, "user");
  assert.equal(r.agentVersion, 1);
  assert.equal(storage.data[CanvasStore.agentKey(id)], "agent text");
  assert.equal(await s.readAgentCopy(id), "agent text");
  await s.userSave({ id, baseVersion: 2, content: "user text 2" });
  assert.equal(storage.data[CanvasStore.agentKey(id)], "agent text");   // still the AGENT's write
});

test("stale agent write after a user edit carries diffFromBase (agent copy → latest)", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a\nb\nc" });
  await s.userSave({ id, baseVersion: 1, content: "a\nB\nc" });
  await assert.rejects(
    () => s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "a\nb\nc\nd" }),
    (e) => e.code === "stale" && e.currentVersion === 2 && e.author === "user" && /-b\n\+B/.test(e.diffFromBase)
  );
});

test("an agent write drops the agent copy (latest is the agent's again); agentSeenVersion tracks reads", async () => {
  const { s, storage } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await s.userSave({ id, baseVersion: 1, content: "b" });
  let m = await s.read({ conversationId: "c", id });
  assert.equal(m.agentSeenVersion, 1);
  await s.read({ conversationId: "c", id, asAgent: true });
  m = await s.read({ conversationId: "c", id });
  assert.equal(m.agentSeenVersion, 2);
  await s.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "T", content: "c" });
  assert.ok(!(CanvasStore.agentKey(id) in storage.data));
  assert.equal(await s.readAgentCopy(id), "c");
});

test("revert to agent's: the agent copy becomes the latest as a user save", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "agent" });
  assert.deepEqual(await s.revertToAgent({ id, baseVersion: 1 }), { version: 1, unchanged: true });
  await s.userSave({ id, baseVersion: 1, content: "mine" });
  await assert.rejects(() => s.revertToAgent({ id, baseVersion: 1 }), (e) => e.code === "stale");
  assert.deepEqual(await s.revertToAgent({ id, baseVersion: 2 }), { version: 3, unchanged: false });
  const r = await s.read({ conversationId: "c", id });
  assert.equal(r.content, "agent");
  assert.equal(r.author, "user");
});

test("applyNormalized: markdown only, that agent version only; latest only while it is still that version", async () => {
  const { s, storage } = store();
  const a = await s.agentWrite({ conversationId: "c", title: "T", content: "* x" });
  assert.equal((await s.read({ conversationId: "c", id: a.id })).normalized, false);
  assert.deepEqual(await s.applyNormalized({ id: a.id, version: 9, normalized: "- x" }), { applied: false });
  assert.deepEqual(await s.applyNormalized({ id: a.id, version: 1, normalized: "- x" }), { applied: true, changed: true });
  let r = await s.read({ conversationId: "c", id: a.id });
  assert.equal(r.content, "- x");
  assert.equal(r.normalized, true);
  assert.deepEqual(await s.applyNormalized({ id: a.id, version: 1, normalized: "zzz" }), { applied: false });   // only once
  // user saved before the normalization arrived: only the agent copy is normalized
  const b = await s.agentWrite({ conversationId: "c", title: "U", content: "* y" });
  await s.userSave({ id: b.id, baseVersion: 1, content: "user" });
  await s.applyNormalized({ id: b.id, version: 1, normalized: "- y" });
  r = await s.read({ conversationId: "c", id: b.id });
  assert.equal(r.content, "user");
  assert.equal(storage.data[CanvasStore.agentKey(b.id)], "- y");
  // slides are stored as sent
  const sl = await s.agentWrite({ conversationId: "c", title: "S", kind: "slides", content: "* z" });
  assert.equal((await s.read({ conversationId: "c", id: sl.id })).normalized, true);
  assert.deepEqual(await s.applyNormalized({ id: sl.id, version: 1, normalized: "- z" }), { applied: false });
});

test("remove also deletes the agent copy", async () => {
  const { s, storage } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await s.userSave({ id, baseVersion: 1, content: "b" });
  await s.remove({ id });
  assert.deepEqual(Object.keys(storage.data), []);
});

test("budget counts the agent copy: first user save adds it, normalize resizes it, an agent write drops it", async () => {
  const asked = [];
  const { s } = store({ budgetBytes: 10, confirmEvict: async (i) => { asked.push(i); return false; } });
  const a = await s.agentWrite({ conversationId: "c", title: "A", content: "aaaa" });   // 4
  await s.userSave({ id: a.id, baseVersion: 1, content: "uuuuu" });                      // 5 + copy 4
  assert.equal((await s.usage()).total, 9);
  await s.applyNormalized({ id: a.id, version: 1, normalized: "aa" });                   // copy → 2
  assert.equal((await s.usage()).total, 7);
  // a save that would only fit if the copy were free is refused
  await assert.rejects(() => s.userSave({ id: a.id, baseVersion: 2, content: "x".repeat(9) }), (e) => e.code === "quota");
  await s.userSave({ id: a.id, baseVersion: 2, content: "x".repeat(8) });               // 8 + 2
  assert.equal((await s.usage()).total, 10);
  await s.agentWrite({ conversationId: "c", id: a.id, baseVersion: 3, title: "A", content: "bbb" });
  assert.equal((await s.usage()).total, 3);
  // the first save of a fresh agent write must make room for the copy too
  await assert.rejects(() => s.userSave({ id: a.id, baseVersion: 4, content: "y".repeat(8) }), (e) => e.code === "quota");
  assert.equal(asked.length, 0);                      // only one canvas: nothing to evict, never asked
});

test("markSeen raises agentSeenVersion, never lowers it or passes the latest", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await s.userSave({ id, baseVersion: 1, content: "b" });
  await s.markSeen({ id, version: 2 });
  assert.equal((await s.read({ conversationId: "c", id })).agentSeenVersion, 2);
  await s.markSeen({ id, version: 1 });
  await s.markSeen({ id, version: 9 });
  assert.equal((await s.read({ conversationId: "c", id })).agentSeenVersion, 2);
});

// --- canvas_patch (§3.5) -------------------------------------------------------------------------

const P = (text, edits) => CanvasStore.planPatch(text, edits);

test("planPatch: all finds against one snapshot, applied together; ranges in the new text", () => {
  const r = P("alpha beta gamma", [{ find: "gamma", replace: "G" }, { find: "alpha", replace: "AAAA" }]);
  assert.equal(r.ok, true);
  assert.equal(r.text, "AAAA beta G");
  assert.deepEqual(r.ranges, [{ start: 0, end: 4 }, { start: 10, end: 11 }]);       // document order
  // One snapshot: edit 0's replace creates a second "beta", which edit 1 never sees.
  const s = P("alpha beta", [{ find: "alpha", replace: "beta beta" }, { find: "beta", replace: "B" }]);
  assert.equal(s.ok, true);
  assert.equal(s.text, "beta beta B");
  // …and a find that only exists in another edit's output does not match.
  const t = P("one two", [{ find: "one", replace: "three" }, { find: "three", replace: "3" }]);
  assert.equal(t.ok, false);
  assert.equal(t.index, 1);
  assert.equal(t.count, 0);
  // Deleting (empty replace) and touching ranges are fine.
  assert.equal(P("abcd", [{ find: "ab", replace: "" }, { find: "cd", replace: "X" }]).text, "X");
});

test("planPatch: each find exactly once (overlapping starts count), no overlapping ranges", () => {
  const none = P("abc", [{ find: "abc", replace: "x" }, { find: "zzz", replace: "y" }]);
  assert.deepEqual([none.ok, none.index, none.count], [false, 1, 0]);
  assert.match(none.message, /^edits\[1\]\.find matches nothing in the latest version/);
  const two = P("a-b a-b", [{ find: "a-b", replace: "x" }]);
  assert.deepEqual([two.ok, two.index, two.count], [false, 0, 2]);
  assert.match(two.message, /matches 2 places; it must match exactly once/);
  assert.equal(P("aaa", [{ find: "aa", replace: "x" }]).count, 2);                   // overlapping occurrences
  const over = P("hello world", [{ find: "hello wo", replace: "x" }, { find: "o world", replace: "y" }]);
  assert.deepEqual([over.ok, over.index, over.overlaps], [false, 1, 0]);
  assert.match(over.message, /edits\[1\]\.find overlaps edits\[0\]\.find/);
  // Same range twice is an overlap too.
  assert.equal(P("abc", [{ find: "b", replace: "1" }, { find: "b", replace: "2" }]).ok, false);
});

test("validatePatchEdits: shape and limits", () => {
  for (const bad of [undefined, [], "x", [null], [{ find: "", replace: "x" }], [{ find: "a" }], [{ find: 1, replace: "" }],
    Array.from({ length: CanvasStore.PATCH_EDITS_MAX + 1 }, () => ({ find: "a", replace: "b" })),
    [{ find: "f".repeat(CanvasStore.PATCH_FIND_MAX + 1), replace: "" }], [{ find: "a", replace: "r".repeat(CanvasStore.PATCH_REPLACE_MAX + 1) }]]) {
    assert.throws(() => CanvasStore.validatePatchEdits(bad));
  }
  assert.deepEqual(CanvasStore.validatePatchEdits([{ find: "a", replace: "", extra: 1 }]), [{ find: "a", replace: "" }]);
});

test("agentPatch: an agent write — version, author, agentVersion, index, agent copy dropped, normalization pending", async () => {
  const { s, storage } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "Doc", content: "# A\n\nintro\n\n## B\n\nbody" });
  await s.applyNormalized({ id, version: 1, normalized: "# A\n\nintro\n\n## B\n\nbody" });
  const r = await s.agentPatch({ conversationId: "c", id, baseVersion: 1, edits: [{ find: "body", replace: "new body" }] });
  assert.equal(r.version, 2);
  assert.equal(r.created, false);
  assert.equal(r.title, "Doc");
  assert.equal(r.kind, "markdown");
  assert.equal(r.rebasedOver, null);
  assert.equal(r.content, "# A\n\nintro\n\n## B\n\nnew body");
  const m = await s.read({ conversationId: "c", id });
  assert.equal(m.content, r.content);
  assert.deepEqual([m.author, m.agentVersion, m.agentSeenVersion, m.normalized, m.bytes], ["agent", 2, 2, false, Buffer.byteLength(r.content)]);
  assert.equal((await s.list({ conversationId: "c" }))[0].version, 2);
  assert.ok(!(CanvasStore.agentKey(id) in storage.data));
});

test("agentPatch: after a user edit elsewhere it rebases and keeps the user's text (rebasedOver)", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "## A\nagent a\n## B\nagent b" });
  await s.userSave({ id, baseVersion: 1, content: "## A\nUSER a\n## B\nagent b" });
  const r = await s.agentPatch({ conversationId: "c", id, baseVersion: 1, edits: [{ find: "agent b", replace: "patched b" }] });
  assert.equal(r.version, 3);
  assert.deepEqual([r.rebasedOver.version, r.rebasedOver.author], [2, "user"]);
  assert.match(r.rebasedOver.diffFromBase, /-agent a\n\+USER a/);               // the user's edit, so agentSeenVersion is true
  assert.doesNotMatch(r.rebasedOver.diffFromBase, /patched/);                   // before the patch
  assert.equal((await s.read({ id })).content, "## A\nUSER a\n## B\npatched b");
  assert.equal(await s.readAgentCopy(id), "## A\nUSER a\n## B\npatched b");     // the latest is the agent's write
});

test("agentPatch: rebased from a base older than the agent's last write has diffFromBase null", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "x\ny" });
  await s.userSave({ id, baseVersion: 1, content: "X\ny" });                    // v2
  await s.agentPatch({ conversationId: "c", id, baseVersion: 2, edits: [{ find: "y", replace: "Y" }] });   // v3, agent
  await s.userSave({ id, baseVersion: 3, content: "X!\nY" });                   // v4
  const r = await s.agentPatch({ conversationId: "c", id, baseVersion: 2, edits: [{ find: "Y", replace: "Z" }] });
  assert.equal(r.version, 5);
  assert.deepEqual(r.rebasedOver, { version: 4, author: "user", diffFromBase: null });
});

test("agentPatch: a patch the store will refuse (other conversation, image) never reaches the budget", async () => {
  const asked = [];
  const { s } = store({ budgetBytes: 10, confirmEvict: async (i) => { asked.push(i); return true; } });
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  const big = "x".repeat(20);                                                   // over budget if it were checked
  await assert.rejects(() => s.agentPatch({ conversationId: "other", id, baseVersion: 1, edits: [{ find: "a", replace: big }] }), /another conversation/);
  assert.deepEqual(asked, []);
  await assert.rejects(() => s.agentPatch({ conversationId: "c", id, baseVersion: 1, edits: [{ find: "a", replace: big }] }), (e) => e.code === "quota");
});

test("agentPatch: a miss after the canvas moved on is stale with diffFromBase; up to date it is a patch error; nothing changes either way", async () => {
  const { s, storage } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a\nb\nc" });
  await s.userSave({ id, baseVersion: 1, content: "a\nB\nc" });
  const before = structuredClone(storage.data);
  await assert.rejects(
    () => s.agentPatch({ conversationId: "c", id, baseVersion: 1, edits: [{ find: "a", replace: "A" }, { find: "b", replace: "x" }] }),
    (e) => e.code === "stale" && e.currentVersion === 2 && e.author === "user" && /-b\n\+B/.test(e.diffFromBase) &&
      e.patch.index === 1 && e.patch.count === 0
  );
  assert.deepEqual(storage.data, before);                                     // all or nothing: "a" was not applied
  await assert.rejects(
    () => s.agentPatch({ conversationId: "c", id, baseVersion: 2, edits: [{ find: "a", replace: "A" }, { find: "nope", replace: "x" }] }),
    (e) => e.code === "patch" && e.index === 1 && e.count === 0 && e instanceof CanvasStore.PatchError
  );
  await assert.rejects(
    () => s.agentPatch({ conversationId: "c", id, baseVersion: 2, edits: [{ find: "\n", replace: " " }] }),
    (e) => e.code === "patch" && e.index === 0 && e.count === 2
  );
  await assert.rejects(
    () => s.agentPatch({ conversationId: "c", id, baseVersion: 2, edits: [{ find: "a\nB", replace: "1" }, { find: "B\nc", replace: "2" }] }),
    (e) => e.code === "patch" && e.index === 1 && e.overlaps === 0
  );
  assert.deepEqual(storage.data, before);
  // A base the canvas never had is stale, not a silent write.
  await assert.rejects(() => s.agentPatch({ conversationId: "c", id, baseVersion: 9, edits: [{ find: "a", replace: "A" }] }), (e) => e.code === "stale");
});

test("agentPatch: text kinds only, own conversation, needs baseVersion; slides are stored as sent", async () => {
  const { s } = store();
  const img = await s.agentWrite({ conversationId: "c", title: "Px", kind: "image", image: { mimeType: "image/png", data: "iVBORw0KGgo=" } });
  await assert.rejects(() => s.agentPatch({ conversationId: "c", id: img.id, baseVersion: 1, edits: [{ find: "image", replace: "x" }] }), /image; only markdown, slides and mermaid/);
  const deck = await s.agentWrite({ conversationId: "c", title: "D", kind: "slides", content: "# 1\n---\n# 2" });
  await assert.rejects(() => s.agentPatch({ conversationId: "other", id: deck.id, baseVersion: 1, edits: [{ find: "# 2", replace: "# Two" }] }), /another conversation/);
  await assert.rejects(() => s.agentPatch({ conversationId: "c", id: deck.id, edits: [{ find: "# 2", replace: "# Two" }] }), /baseVersion/);
  await assert.rejects(() => s.agentPatch({ conversationId: "c", id: "cv_x", baseVersion: 1, edits: [{ find: "a", replace: "b" }] }), /not a canvas id/);
  await assert.rejects(() => s.agentPatch({ conversationId: "c", id: deck.id, baseVersion: 1, edits: [] }), /non-empty array/);
  const r = await s.agentPatch({ conversationId: "c", id: deck.id, baseVersion: 1, edits: [{ find: "# 2", replace: "# Two" }] });
  const m = await s.read({ id: deck.id });
  assert.deepEqual([r.kind, m.content, m.normalized], ["slides", "# 1\n---\n# Two", true]);
});

test("agentPatch: the result is capped at 2 MB; the budget is checked like any write", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "x".repeat(CanvasStore.CONTENT_MAX_BYTES - 10) + "END" });
  await assert.rejects(() => s.agentPatch({ conversationId: "c", id, baseVersion: 1, edits: [{ find: "END", replace: "y".repeat(100) }] }), /capped at/);
  const small = store({ budgetBytes: 20 });
  const w = await small.s.agentWrite({ conversationId: "c", title: "T", content: "0123456789" });
  await assert.rejects(() => small.s.agentPatch({ conversationId: "c", id: w.id, baseVersion: 1, edits: [{ find: "9", replace: "9".repeat(50) }] }), (e) => e.code === "quota");
  assert.equal((await small.s.read({ id: w.id })).version, 1);
});

test("agentPatch runs under the canvas lock: a user save and a patch from the same base never lose either", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "head\nmiddle\ntail" });
  const [u, p] = await Promise.allSettled([
    s.userSave({ id, baseVersion: 1, content: "HEAD\nmiddle\ntail" }),
    s.agentPatch({ conversationId: "c", id, baseVersion: 1, edits: [{ find: "tail", replace: "TAIL" }] }),
  ]);
  const content = (await s.read({ id })).content;
  // Whatever the order, the patch matched the snapshot it saw under the lock: both changes survive
  // when the save ran first (rebase), and the save is stale (not overwriting) when the patch ran first.
  if (u.status === "fulfilled") {
    assert.equal(p.status, "fulfilled");
    assert.equal(content, "HEAD\nmiddle\nTAIL");
  } else {
    assert.equal(u.reason.code, "stale");
    assert.equal(content, "head\nmiddle\nTAIL");
  }
});

test("allMetas: every canvas across conversations (the gallery, §3.7), metas only, deletes gone", async () => {
  const { s, storage } = store();
  const a = await s.agentWrite({ conversationId: "c_a", title: "A", content: "aaa" });
  const b = await s.agentWrite({ conversationId: "c_b", title: "B", content: "bb" });
  storage.data["canvas:budgetBytes"] = 2 * 1024 * 1024;     // not a canvas
  const metas = await s.allMetas();
  assert.deepEqual(metas.map((m) => m.id).sort(), [a.id, b.id].sort());
  assert.ok(metas.every((m) => m.content === undefined));
  assert.deepEqual(metas.map((m) => m.conversationId).sort(), ["c_a", "c_b"]);
  await s.remove({ id: a.id });
  assert.deepEqual((await s.allMetas()).map((m) => m.id), [b.id]);
});

test("kind mermaid (Brett 2026-10-11): stored as sent (no normalization), patchable, never user-edited", async () => {
  const { s } = store();
  const src = "flowchart LR\n  A --> B\n";
  const r = await s.agentWrite({ conversationId: "c", title: "Flow", kind: "mermaid", content: src });
  const m = await s.read({ id: r.id });
  assert.deepEqual([m.kind, m.content, m.normalized], ["mermaid", src, true]);
  assert.ok(CanvasStore.KINDS.includes("mermaid"));
  const p = await s.agentPatch({ conversationId: "c", id: r.id, baseVersion: 1, edits: [{ find: "A --> B", replace: "A --> C" }] });
  assert.equal(p.version, 2);
  assert.equal((await s.read({ id: r.id })).content, "flowchart LR\n  A --> C\n");
  await assert.rejects(() => s.userSave({ id: r.id, baseVersion: 2, content: "graph TD" }), /a mermaid canvas cannot be edited/);
  // A canvas never changes kind.
  await assert.rejects(() => s.agentWrite({ conversationId: "c", id: r.id, baseVersion: 2, title: "Flow", kind: "markdown", content: "x" }), /kind/);
});
