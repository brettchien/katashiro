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

test("image bytes count toward the budget", async () => {
  const { s } = store({ budgetBytes: 50 });
  await assert.rejects(
    () => s.agentWrite({ conversationId: "c", title: "T", kind: "image", image: { mimeType: "image/png", data: PNG } }),
    (e) => e.code === "quota"
  );
});
