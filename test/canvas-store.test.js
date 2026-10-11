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

test("content, meta and the version moved into history land in one set(), so onChanged fires once with a consistent pair", async () => {
  const calls = [];
  const storage = memStorage();
  const set = storage.set;
  storage.set = async (items) => { calls.push(Object.keys(items).sort()); return set(items); };
  const s = CanvasStore.createCanvasStore({ storage, lock: memLock(), randomHex: () => "0123456789ab" });
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "b" });
  const body = calls.filter((ks) => ks.some((k) => k.startsWith(`canvas:${id}:`)));
  assert.deepEqual(body, [[`canvas:${id}:latest`, `canvas:${id}:meta`], [`canvas:${id}:latest`, `canvas:${id}:meta`, `canvas:${id}:v:1`]]);
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

test("removeIncognitoLeftovers sweeps images once after all removals, not once per canvas (#113 review)", async () => {
  const names = [];
  const inner = memLock();
  const { s, storage } = store({ lock: (name, fn) => { names.push(name); return inner(name, fn); } });
  const ids = [];
  for (const t of ["A", "B", "C"]) ids.push((await s.agentWrite({ conversationId: "c", title: t, content: t })).id);
  for (const id of ids) storage.data[CanvasStore.metaKey(id)] = { ...storage.data[CanvasStore.metaKey(id)], noMirror: true };
  names.length = 0;
  assert.equal(await s.removeIncognitoLeftovers(), 3);
  // canvas:index: one index update per removal, plus the one sweep
  assert.equal(names.filter((n) => n === "canvas:index").length, 3 + 1);
  names.length = 0;
  assert.equal(await s.removeIncognitoLeftovers(), 0);
  assert.equal(names.filter((n) => n === "canvas:index").length, 0);        // nothing removed: no sweep
  // a plain remove still sweeps
  const { id } = await s.agentWrite({ conversationId: "c", title: "D", content: "d" });
  names.length = 0;
  await s.remove({ id });
  assert.equal(names.filter((n) => n === "canvas:index").length, 2);
});

// background.js in a vm sandbox, with importScripts reading the real files (or failing on demand).
function loadBackground(storage, { failImport = false } = {}) {
  const fs = require("node:fs");
  const path = require("node:path");
  const vm = require("node:vm");
  const lock = memLock();
  const bg = { onInstalled: null, onStartup: null, panel: 0, warned: [] };
  const sandbox = {
    console: { log() {}, warn(...a) { bg.warned.push(a.join(" ")); }, error() {} },
    navigator: { locks: { request: (name, fn) => lock(name, fn) } },
    chrome: {
      storage: { local: storage },
      sidePanel: { setPanelBehavior: async () => { bg.panel++; } },
      runtime: {
        onInstalled: { addListener: (fn) => { bg.onInstalled = fn; } },
        onStartup: { addListener: (fn) => { bg.onStartup = fn; } },
      },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.crypto = globalThis.crypto;
  sandbox.importScripts = (f) => {
    if (failImport) throw new Error(`NetworkError: Failed to load ${f}`);
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", f), "utf8"), sandbox);
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), sandbox);
  return bg;
}

for (const event of ["onInstalled", "onStartup"]) {
  test(`background.js runs the incognito cleanup on ${event}`, async () => {
    const { s, storage } = store();
    const keep = await s.agentWrite({ conversationId: "c", title: "Normal", content: "aa" });
    const gone = await s.agentWrite({ conversationId: "c", title: "Incognito", content: "bb" });
    const k = CanvasStore.metaKey(gone.id);
    storage.data[k] = { ...storage.data[k], noMirror: true };
    const bg = loadBackground(storage);
    assert.equal(typeof bg[event], "function");
    bg[event]({ reason: "update" });
    const indexed = () => (storage.data[CanvasStore.indexKey("c")] || []).length;
    for (let i = 0; i < 400 && indexed() !== 1; i++) await new Promise((r) => setTimeout(r, 5));   // best effort, not awaited
    assert.equal(k in storage.data, false);
    assert.deepEqual((await s.list({ conversationId: "c" })).map((e) => e.id), [keep.id]);
  });
}

test("background.js survives canvas-store.js failing to load (#113 review): panel and listeners still set up", async () => {
  const { storage } = store();
  const bg = loadBackground(storage, { failImport: true });
  assert.equal(bg.panel, 1);
  assert.equal(typeof bg.onInstalled, "function");
  assert.equal(typeof bg.onStartup, "function");
  bg.onInstalled({ reason: "update" });                                    // reports, never throws
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(bg.warned.some((w) => /canvas-store\.js failed to load/.test(w)));
  assert.ok(bg.warned.some((w) => /cleanup failed/.test(w)));
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
  // rewriting an existing canvas counts what it takes afterwards: its history (§3.5), C = 4 + 2
  await s.agentWrite({ conversationId: "d", id: c.id, baseVersion: 1, title: "C", content: "cc" });
  assert.equal((await s.usage()).total, 10);
});

test("budget: a canvas changed while the eviction confirm waits is kept (#80)", async () => {
  let s;
  let a;
  ({ s } = store({
    budgetBytes: 11,                                  // A's rewrite (4 + 3 with its history) fits without asking
    // the user is still deciding when A gets rewritten (no lock is held while asking)
    confirmEvict: async () => { await s.agentWrite({ conversationId: "c", id: a.id, baseVersion: 1, title: "A", content: "aaa" }); return true; },
  }));
  a = await s.agentWrite({ conversationId: "c", title: "A", content: "aaaa" });
  await s.agentWrite({ conversationId: "c", title: "B", content: "bbbb" });
  await s.touch(a.id);
  await s.touch((await s.list({ conversationId: "c" })).find((e) => e.id !== a.id).id);
  await s.agentWrite({ conversationId: "d", title: "C", content: "cccc" });   // asks to evict A (opened first)
  const r = await s.read({ conversationId: "c", id: a.id });
  assert.equal(r.version, 2);                         // A was not what the user agreed to drop: kept
});

test("budget: an agent write may ask its own confirmEvict (the asking agent's turn, #80); a user save asks the store's", async () => {
  const storeAsked = [], agentAsked = [];
  const { s } = store({ budgetBytes: 10, confirmEvict: async (i) => { storeAsked.push(i); return false; } });
  await s.agentWrite({ conversationId: "c", title: "A", content: "aaaa" });
  await s.agentWrite({ conversationId: "c", title: "B", content: "bbbb" });
  const ask = async (i) => { agentAsked.push(i); return true; };
  await s.agentWrite({ conversationId: "d", title: "C", content: "cccc", confirmEvict: ask });
  assert.equal(agentAsked.length, 1);
  assert.equal(storeAsked.length, 0);
  assert.equal((await s.usage()).count, 2);           // the agent's yes evicted A
  const c = (await s.list({ conversationId: "d" }))[0];
  await s.agentPatch({ conversationId: "d", id: c.id, baseVersion: 1, edits: [{ find: "cccc", replace: "c".repeat(5) }], confirmEvict: ask });   // C: 4 + 5 with history
  assert.equal(agentAsked.length, 2);                 // canvas_patch asks the agent's too
  assert.equal(storeAsked.length, 0);
});

test("budget: eviction sweeps images once after all removals, not once per canvas (#115 review)", async () => {
  const names = [];
  const inner = memLock();
  const { s } = store({ budgetBytes: 12, confirmEvict: async () => true, lock: (name, fn) => { names.push(name); return inner(name, fn); } });
  for (const t of ["A", "B", "C"]) await s.agentWrite({ conversationId: "c", title: t, content: "xxxx" });   // 12
  names.length = 0;
  await s.agentWrite({ conversationId: "d", title: "D", content: "y".repeat(12) });   // evicts all three
  assert.equal((await s.usage()).count, 1);
  // canvas:index: one per removal, one sweep, one index update for D
  assert.equal(names.filter((n) => n === "canvas:index").length, 3 + 1 + 1);
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
  const { s, storage } = store({ now: () => clock, historyMax: 1 });   // N = 1: the replaced version leaves history
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
  assert.equal(storage.data[CanvasStore.versionKey(id, 1)], "agent text");   // v1 moved into history
  assert.equal(await s.readAgentCopy(id), "agent text");
  await s.userSave({ id, baseVersion: 2, content: "user text 2" });
  assert.equal(await s.readAgentCopy(id), "agent text");               // still the AGENT's write
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
  assert.equal(storage.data[CanvasStore.versionKey(id, 2)], "b");     // the user's save stays in history
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
  assert.equal(storage.data[CanvasStore.versionKey(b.id, 1)], "- y");
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

test("budget counts the whole history (§3.6): every version, normalization resizes its entry, the setting trims on the next write", async () => {
  const asked = [];
  const { s, storage } = store({ budgetBytes: 10, confirmEvict: async (i) => { asked.push(i); return false; } });
  const a = await s.agentWrite({ conversationId: "c", title: "A", content: "aaaa" });   // 4
  await s.userSave({ id: a.id, baseVersion: 1, content: "uuuuu" });                      // 4 + 5
  assert.equal((await s.usage()).total, 9);
  await s.applyNormalized({ id: a.id, version: 1, normalized: "aa" });                   // v1 → 2
  assert.equal((await s.usage()).total, 7);
  // History is never trimmed to make room: a save that only fits without v2 is refused
  await assert.rejects(() => s.userSave({ id: a.id, baseVersion: 2, content: "x".repeat(4) }), (e) => e.code === "quota");
  await s.userSave({ id: a.id, baseVersion: 2, content: "x" });                          // 2 + 5 + 1
  assert.equal((await s.usage()).total, 8);
  await assert.rejects(() => s.agentWrite({ conversationId: "c", id: a.id, baseVersion: 3, title: "A", content: "bbb" }), (e) => e.code === "quota");
  // N = 2 (the setting, read on every write): the same write trims to v3 + v4 and fits
  await storage.set({ [CanvasStore.HISTORY_MAX_KEY]: 2 });
  await s.agentWrite({ conversationId: "c", id: a.id, baseVersion: 3, title: "A", content: "bbb" });
  assert.equal((await s.usage()).total, 4);
  assert.deepEqual((await s.read({ id: a.id })).history.map((h) => h.v), [3, 4]);
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

test("agentPatch: meta.patchRanges keeps the exact ranges for the canvas tab's glow; normalization and other writes drop them (#107)", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "Doc", kind: "slides", content: "# A\n\nintro\n\n---\n\nbody" });
  const r = await s.agentPatch({ conversationId: "c", id, baseVersion: 1, edits: [{ find: "body", replace: "new body" }, { find: "intro", replace: "" }] });
  assert.deepEqual(r.ranges, [{ start: 5, end: 5 }, { start: 12, end: 20 }]);
  assert.deepEqual((await s.read({ conversationId: "c", id })).patchRanges, r.ranges);
  // A full write is not a patch: no ranges, the block diff glows.
  await s.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "Doc", kind: "slides", content: "x" });
  assert.equal("patchRanges" in (await s.read({ conversationId: "c", id })), false);
  // markdown: the editor's normalization rewrites the text, so the offsets no longer hold.
  const md = await s.agentWrite({ conversationId: "c", title: "Md", content: "* a\n* b" });
  await s.agentPatch({ conversationId: "c", id: md.id, baseVersion: 1, edits: [{ find: "b", replace: "B" }] });
  assert.deepEqual((await s.read({ conversationId: "c", id: md.id })).patchRanges, [{ start: 6, end: 7 }]);
  await s.applyNormalized({ id: md.id, version: 2, normalized: "- a\n- B\n" });
  assert.equal("patchRanges" in (await s.read({ conversationId: "c", id: md.id })), false);
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

test("agentPatch: rebased from a base older than the agent's last write diffs from it while it is in history, null once trimmed", async () => {
  for (const [historyMax, diff] of [[10, true], [2, false]]) {
    const { s } = store({ historyMax });
    const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "x\ny" });
    await s.userSave({ id, baseVersion: 1, content: "X\ny" });                    // v2
    await s.agentPatch({ conversationId: "c", id, baseVersion: 2, edits: [{ find: "y", replace: "Y" }] });   // v3, agent
    await s.userSave({ id, baseVersion: 3, content: "X!\nY" });                   // v4 (N = 2: v2 trimmed)
    const r = await s.agentPatch({ conversationId: "c", id, baseVersion: 2, edits: [{ find: "Y", replace: "Z" }] });
    assert.equal(r.version, 5);
    assert.deepEqual([r.rebasedOver.version, r.rebasedOver.author], [4, "user"]);
    if (diff) assert.equal(r.rebasedOver.diffFromBase, "@@ -1,2 +1,2 @@\n-X\n-y\n+X!\n+Y");   // v2 → v4
    else assert.equal(r.rebasedOver.diffFromBase, null);
  }
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

// --- Version history (§3.5, Brett 2026-10-11) -----------------------------------------------------

test("historyLimit: the setting → 1–50 whole versions; anything that is not a number → 10", () => {
  const L = CanvasStore.historyLimit;
  assert.equal(CanvasStore.HISTORY_DEFAULT, 10);
  for (const junk of [undefined, null, "", "abc", NaN, Infinity, true, {}, []]) assert.equal(L(junk), 10, String(junk));
  assert.deepEqual([L(1), L(10), L(50), L(0), L(-3), L(51), L(1000), L(2.4), L(2.6), L("7")], [1, 10, 50, 1, 1, 50, 50, 2, 3, 7]);
});

test("appendHistory: keeps the last N, never the pinned agent write; reports what it dropped", () => {
  const h = (...vs) => vs.map((v) => ({ v, bytes: v }));
  const A = CanvasStore.appendHistory;
  assert.deepEqual(A(h(1, 2), { v: 3 }, { max: 10, pin: 1 }), { history: [{ v: 1, bytes: 1 }, { v: 2, bytes: 2 }, { v: 3 }], dropped: [] });
  let r = A(h(1, 2, 3), { v: 4 }, { max: 2, pin: 4 });
  assert.deepEqual([r.history.map((x) => x.v), r.dropped], [[3, 4], [1, 2]]);
  r = A(h(1, 2, 3), { v: 4 }, { max: 2, pin: 1 });                     // the agent's write, older than the last N: kept
  assert.deepEqual([r.history.map((x) => x.v), r.dropped], [[1, 3, 4], [2]]);
  r = A(h(5), { v: 6 }, { max: 1, pin: 6 });                           // N = 1: the latest only
  assert.deepEqual([r.history.map((x) => x.v), r.dropped], [[6], [5]]);
  r = A(h(1, 2), { v: 3 }, { max: "junk", pin: 3 });                    // N through historyLimit
  assert.deepEqual(r.history.map((x) => x.v), [1, 2, 3]);
});

test("historyOf / contentKey / previousVersion: history metas, and canvases stored before history (lazy migration)", () => {
  const id = "cv_00000000000a";
  const withHist = { id, version: 5, agentVersion: 3, history: [{ v: 3 }, { v: 4 }, { v: 5 }] };
  assert.equal(CanvasStore.contentKey(withHist, 5), CanvasStore.latestKey(id));
  assert.equal(CanvasStore.contentKey(withHist, 3), CanvasStore.versionKey(id, 3));
  assert.equal(CanvasStore.contentKey(withHist, 2), null);              // not in history
  assert.deepEqual(CanvasStore.contentKeys(withHist), [`canvas:${id}:v:3`, `canvas:${id}:v:4`, `canvas:${id}:latest`]);
  assert.equal(CanvasStore.previousVersion(withHist), 4);
  // Before history: a user save on top of the agent's write kept the agent key.
  const legacy = { id, version: 4, author: "user", at: 9, bytes: 5, agentVersion: 2, agentBytes: 3 };
  assert.deepEqual(CanvasStore.historyOf(legacy), [{ v: 2, author: "agent", at: 0, bytes: 3 }, { v: 4, author: "user", at: 9, bytes: 5 }]);
  assert.equal(CanvasStore.contentKey(legacy, 2), CanvasStore.agentKey(id));
  assert.equal(CanvasStore.previousVersion(legacy), 2);
  assert.equal(CanvasStore.footprint(legacy), 8);                       // latest + agent copy, as before
  const legacyAgent = { id, version: 2, author: "agent", bytes: 5, agentVersion: 2, agentBytes: 0 };
  assert.deepEqual(CanvasStore.historyOf(legacyAgent).map((h) => h.v), [2]);
  assert.equal(CanvasStore.previousVersion(legacyAgent), null);
  assert.deepEqual(CanvasStore.historyOf(null), []);
});

test("historyFootprint: every version a full copy; an image counted once per distinct image", () => {
  const F = CanvasStore.historyFootprint;
  assert.equal(F([{ v: 1, bytes: 10 }, { v: 2, bytes: 20 }]), 30);
  assert.equal(F([
    { v: 1, bytes: 60 + 1000, image: "aa", imageBytes: 1000 },
    { v: 2, bytes: 62 + 1000, image: "aa", imageBytes: 1000 },          // caption changed, same image
    { v: 3, bytes: 60 + 500, image: "bb", imageBytes: 500 },
  ]), 60 + 62 + 60 + 1000 + 500);
  assert.equal(F([]), 0);
});

test("walkCandidates: ↶ starts a walk at the latest and goes older; ↷ only inside a walk; trimmed versions skipped", () => {
  const W = CanvasStore.walkCandidates;
  const meta = { version: 8, history: [5, 6, 7, 8].map((v) => ({ v })) };
  assert.deepEqual(W(meta, "undo"), { path: [8, 7, 6, 5], candidates: [{ v: 7, pos: 1 }, { v: 6, pos: 2 }, { v: 5, pos: 3 }] });
  assert.deepEqual(W(meta, "redo").candidates, []);
  assert.equal(CanvasStore.canUndo(meta), true);
  assert.equal(CanvasStore.canRedo(meta), false);
  // After two ↶ (v9 = 7, v10 = 6), with v5 trimmed meanwhile.
  const walked = { version: 10, history: [6, 7, 8, 9, 10].map((v) => ({ v })), walk: { path: [8, 7, 6, 5], pos: 2, head: 10 } };
  assert.deepEqual(W(walked, "undo").candidates, []);                    // v5 is gone
  assert.deepEqual(W(walked, "redo").candidates, [{ v: 7, pos: 1 }, { v: 8, pos: 0 }]);
  assert.equal(CanvasStore.canUndo(walked), false);
  assert.equal(CanvasStore.canRedo(walked), true);
  // A walk whose head is no longer the latest (any other save) is over: ↶ starts afresh.
  const ended = { ...walked, version: 11, history: [...walked.history, { v: 11 }] };
  assert.deepEqual(W(ended, "undo").path, [11, 10, 9, 8, 7, 6]);
  assert.equal(CanvasStore.canRedo(ended), false);
  // A gap (trimmed) is skipped, so the pinned agent write stays reachable.
  const pinned = { version: 9, history: [{ v: 2 }, { v: 8 }, { v: 9 }] };
  assert.deepEqual(W(pinned, "undo").candidates.map((c) => c.v), [8, 2]);
  assert.equal(CanvasStore.canUndo({ version: 1, history: [{ v: 1 }] }), false);
  assert.deepEqual(W(null, "undo"), { path: [], candidates: [] });
});

test("history through every write path: versions, authors, contents in v:<n> keys, the agent's write pinned beyond N", async () => {
  const { s, storage } = store({ historyMax: 2 });
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a1" });           // v1 agent
  await s.userSave({ id, baseVersion: 1, content: "u2" });                                         // v2 user
  await s.userSave({ id, baseVersion: 2, content: "u3" });                                         // v3 user
  await s.userSave({ id, baseVersion: 3, content: "u4" });                                         // v4 user
  let m = await s.read({ id });
  // N = 2 plus the pinned agent write v1, older than the last two
  assert.deepEqual(m.history.map((h) => [h.v, h.author, h.bytes]), [[1, "agent", 2], [3, "user", 2], [4, "user", 2]]);
  assert.equal(storage.data[CanvasStore.versionKey(id, 1)], "a1");
  assert.ok(!(CanvasStore.versionKey(id, 2) in storage.data), "v2 trimmed, its key removed");
  assert.equal(storage.data[CanvasStore.versionKey(id, 3)], "u3");
  assert.ok(!(CanvasStore.versionKey(id, 4) in storage.data), "the latest is only under :latest");
  assert.equal(await s.readAgentCopy(id), "a1");
  await s.revertToAgent({ id, baseVersion: 4 });                                                   // v5 = a1, user
  m = await s.read({ id });
  assert.deepEqual(m.history.map((h) => [h.v, h.author]), [[1, "agent"], [4, "user"], [5, "user"]]);
  assert.equal(m.content, "a1");
  await s.agentPatch({ conversationId: "c", id, baseVersion: 5, edits: [{ find: "a1", replace: "p6" }] });   // v6 agent: the new pin
  m = await s.read({ id });
  assert.deepEqual(m.history.map((h) => [h.v, h.author]), [[5, "user"], [6, "agent"]]);
  assert.equal(m.agentVersion, 6);
  assert.ok(!(CanvasStore.versionKey(id, 1) in storage.data), "the old agent write is no longer pinned");
  await s.agentWrite({ conversationId: "c", id, baseVersion: 6, title: "T", content: "a7" });       // v7 agent
  m = await s.read({ id });
  assert.deepEqual(m.history.map((h) => h.v), [6, 7]);
  assert.equal(m.agentBytes, undefined);                                // sizes live in the history
  const vKeys = Object.keys(storage.data).filter((k) => k.startsWith(`canvas:${id}:v:`));
  assert.deepEqual(vKeys, [CanvasStore.versionKey(id, 6)]);
});

test("stale diffFromBase from any version still in history, not only the agent's own write", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a\nb\nc" });
  await s.userSave({ id, baseVersion: 1, content: "a\nB\nc" });          // v2, user
  await s.userSave({ id, baseVersion: 2, content: "a\nB\nC" });          // v3, user
  // The agent read v2 (a user version) and writes on it: the diff is v2 → v3.
  await assert.rejects(
    () => s.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "T", content: "x" }),
    (e) => e.code === "stale" && e.currentVersion === 3 && e.diffFromBase === "@@ -1,3 +1,3 @@\n a\n B\n-c\n+C"
  );
  // A base never stored, or trimmed out, gives no diff.
  await assert.rejects(() => s.agentWrite({ conversationId: "c", id, baseVersion: 9, title: "T", content: "x" }), (e) => e.code === "stale" && e.diffFromBase === null);
  const small = store({ historyMax: 1 });
  const w = await small.s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await small.s.userSave({ id: w.id, baseVersion: 1, content: "b" });
  await small.s.userSave({ id: w.id, baseVersion: 2, content: "c" });    // N = 1: v2 gone, v1 pinned
  await assert.rejects(() => small.s.agentWrite({ conversationId: "c", id: w.id, baseVersion: 2, title: "T", content: "x" }), (e) => e.code === "stale" && e.diffFromBase === null);
  await assert.rejects(() => small.s.agentWrite({ conversationId: "c", id: w.id, baseVersion: 1, title: "T", content: "x" }), (e) => e.code === "stale" && /-a\n\+c/.test(e.diffFromBase));
});

test("readPrevious: the version before the latest, any author; null on v1", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "one" });
  assert.equal(await s.readPrevious(id), null);
  await s.userSave({ id, baseVersion: 1, content: "two" });
  assert.deepEqual(await s.readPrevious(id), { version: 1, content: "one" });
  await s.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "T", content: "three" });
  assert.deepEqual(await s.readPrevious(id), { version: 2, content: "two" });      // a user version
  assert.equal(await s.readPrevious("nope"), null);
});

test("↶ / ↷ save new versions along one walk; any other save ends it", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "c1" });
  for (let v = 1; v < 4; v++) await s.userSave({ id, baseVersion: v, content: `c${v + 1}` });   // v4 = c4
  const content = async () => (await s.read({ id })).content;
  assert.deepEqual(await s.undo({ id, baseVersion: 4 }), { version: 5, from: 3, unchanged: false });
  assert.equal(await content(), "c3");
  assert.deepEqual(await s.undo({ id, baseVersion: 5 }), { version: 6, from: 2, unchanged: false });
  assert.equal(await content(), "c2");
  let m = await s.read({ id });
  assert.deepEqual([m.author, m.agentVersion, m.walk], ["user", 1, { path: [4, 3, 2, 1], pos: 2, head: 6 }]);
  assert.equal(CanvasStore.canRedo(m), true);
  assert.deepEqual(await s.redo({ id, baseVersion: 6 }), { version: 7, from: 3, unchanged: false });
  assert.deepEqual(await s.redo({ id, baseVersion: 7 }), { version: 8, from: 4, unchanged: false });
  assert.equal(await content(), "c4");
  m = await s.read({ id });
  assert.equal(CanvasStore.canRedo(m), false);                          // back where the walk started
  assert.deepEqual(await s.redo({ id, baseVersion: 8 }), { version: 8, unchanged: true });
  await assert.rejects(() => s.undo({ id, baseVersion: 7 }), (e) => e.code === "stale" && e.currentVersion === 8);
  // Back down, then a user save: the walk is over, ↷ has nothing, ↶ starts from the new latest.
  await s.undo({ id, baseVersion: 8 });                                 // v9 = c3
  await s.userSave({ id, baseVersion: 9, content: "mine" });            // v10
  m = await s.read({ id });
  assert.equal(m.walk, undefined);
  assert.equal(CanvasStore.canRedo(m), false);
  assert.deepEqual(await s.undo({ id, baseVersion: 10 }), { version: 11, from: 9, unchanged: false });
  assert.equal(await content(), "c3");
  // An agent write ends a walk too.
  await s.agentWrite({ conversationId: "c", id, baseVersion: 11, title: "T", content: "agent" });
  assert.equal((await s.read({ id })).walk, undefined);
});

test("↶ skips versions with the latest's content, is unchanged with nothing older, and is for markdown / slides only", async () => {
  const { s } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  assert.deepEqual(await s.undo({ id, baseVersion: 1 }), { version: 1, unchanged: true });      // v1: nothing older
  await s.agentWrite({ conversationId: "c", id, baseVersion: 1, title: "T", content: "b" });     // v2
  await s.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "T", content: "b" });     // v3, same text
  assert.deepEqual(await s.undo({ id, baseVersion: 3 }), { version: 4, from: 1, unchanged: false });   // v2 = "b" skipped
  assert.equal((await s.read({ id })).content, "a");
  const mm = await s.agentWrite({ conversationId: "c", title: "M", kind: "mermaid", content: "graph TD" });
  await s.agentWrite({ conversationId: "c", id: mm.id, baseVersion: 1, title: "M", kind: "mermaid", content: "graph LR" });
  await assert.rejects(() => s.undo({ id: mm.id, baseVersion: 2 }), /a mermaid canvas cannot be edited/);
  await assert.rejects(() => s.undo({ id: "x", baseVersion: 1 }), /not a canvas id/);
});

test("↶ under trimming: each step is a version, so the walk reaches back about N/2; the pinned agent write stays reachable", async () => {
  const { s } = store({ historyMax: 4 });
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "c1" });      // pinned
  for (let v = 1; v < 6; v++) await s.userSave({ id, baseVersion: v, content: `c${v + 1}` });   // v6 = c6
  const froms = [];
  for (let v = 6; ; v++) {
    const r = await s.undo({ id, baseVersion: v });
    if (r.unchanged) break;
    froms.push(r.from);
  }
  // history v1 (pin) + v3..v6: v5, then v4 — by then v3 is trimmed — then the pinned v1
  assert.deepEqual(froms, [5, 4, 1]);
  const m = await s.read({ id });
  assert.equal(m.content, "c1");
  assert.equal(CanvasStore.canUndo(m), false);
});

test("↶ / ↷ and Revert check the budget like a user save (a new full version)", async () => {
  const asked = [];
  const { s } = store({ budgetBytes: 12, confirmEvict: async (i) => { asked.push(i); return true; } });
  const other = await s.agentWrite({ conversationId: "c", title: "O", content: "oooo" });      // 4
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "aa" });       // 2
  await s.userSave({ id, baseVersion: 1, content: "bbb" });                                     // 2 + 3
  await s.userSave({ id, baseVersion: 2, content: "c" });                                       // 2 + 3 + 1 (+ O 4 = 10)
  assert.equal(asked.length, 0);
  await s.undo({ id, baseVersion: 3 });                                                         // + 3 = 13 > 12: evicts O
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].evict.map((e) => e.id), [other.id]);
  assert.equal((await s.usage()).total, 9);
});

test("lazy migration: a canvas stored before history reads as agent copy + latest, and its next write moves the agent key into history", async () => {
  const { s, storage } = store();
  const id = "cv_00000000beef";
  Object.assign(storage.data, {
    [CanvasStore.metaKey(id)]: { id, conversationId: "c", title: "Old", kind: "markdown", version: 3, author: "user", at: 5, agentVersion: 2, agentSeenVersion: 2, bytes: 4, agentBytes: 5, normalized: true },
    [CanvasStore.latestKey(id)]: "mine",
    [CanvasStore.agentKey(id)]: "agent",
    [CanvasStore.indexKey("c")]: [{ id, title: "Old", kind: "markdown", version: 3, bytes: 4, updatedAt: 5 }],
  });
  assert.equal(await s.readAgentCopy(id), "agent");
  assert.deepEqual(await s.readPrevious(id), { version: 2, content: "agent" });
  assert.equal((await s.usage()).total, 9);
  assert.equal(CanvasStore.canUndo(storage.data[CanvasStore.metaKey(id)]), true);
  await assert.rejects(() => s.agentWrite({ conversationId: "c", id, baseVersion: 2, title: "Old", content: "x" }), (e) => /-agent\n\+mine/.test(e.diffFromBase));
  await s.userSave({ id, baseVersion: 3, content: "mine 2" });
  const m = await s.read({ id });
  assert.deepEqual(m.history.map((h) => [h.v, h.author, h.bytes]), [[2, "agent", 5], [3, "user", 4], [4, "user", 6]]);
  assert.equal(m.agentBytes, undefined);
  assert.ok(!(CanvasStore.agentKey(id) in storage.data), "the agent key is migrated");
  assert.equal(storage.data[CanvasStore.versionKey(id, 2)], "agent");
  assert.equal(storage.data[CanvasStore.versionKey(id, 3)], "mine");
  assert.equal(await s.readAgentCopy(id), "agent");
  assert.equal((await s.usage()).total, 15);
  // ↶ walks into the migrated versions
  assert.deepEqual(await s.undo({ id, baseVersion: 4 }), { version: 5, from: 3, unchanged: false });
});

test("lazy migration: a pre-history canvas whose latest is the agent's write, and the normalization of a migrated agent copy", async () => {
  const { s, storage } = store();
  const id = "cv_00000000cafe";
  Object.assign(storage.data, {
    [CanvasStore.metaKey(id)]: { id, conversationId: "c", title: "Old", kind: "markdown", version: 1, author: "agent", at: 5, agentVersion: 1, agentSeenVersion: 1, bytes: 3, agentBytes: 0, normalized: false },
    [CanvasStore.latestKey(id)]: "* a",
  });
  assert.equal(await s.readPrevious(id), null);
  await s.userSave({ id, baseVersion: 1, content: "mine" });
  assert.deepEqual((await s.read({ id })).history.map((h) => h.v), [1, 2]);
  // normalization arrives late: the agent's version, now in v:1, and its history size
  assert.deepEqual(await s.applyNormalized({ id, version: 1, normalized: "- a\n" }), { applied: true, changed: true });
  const m = await s.read({ id });
  assert.equal(storage.data[CanvasStore.versionKey(id, 1)], "- a\n");
  assert.equal(m.content, "mine");
  assert.deepEqual(m.history.map((h) => h.bytes), [4, 4]);
});

test("image sweep scans every version in history: an image an older version shows is kept until that version is trimmed", async () => {
  let clock = 1_000_000;
  const { s, storage } = store({ now: () => clock, historyMax: 2 });
  const a = await s.agentWrite({ conversationId: "c", title: "T", kind: "image", image: { mimeType: "image/png", data: PNG } });
  const pngKey = `canvas:img:${await CanvasStore.sha256OfBase64(PNG)}`;
  clock += 11 * 60 * 1000;
  await s.agentWrite({ conversationId: "c", id: a.id, baseVersion: 1, title: "T", kind: "image", image: { mimeType: "image/gif", data: GIF } });
  assert.ok(pngKey in storage.data, "v1 (in history) still shows the PNG");
  await s.agentWrite({ conversationId: "c", id: a.id, baseVersion: 2, title: "T", kind: "image", image: { mimeType: "image/gif", data: GIF }, caption: "again" });
  assert.ok(!(pngKey in storage.data), "v1 trimmed (N = 2): the PNG goes");
  // The footprint counts the GIF once although two versions show it.
  const m = await s.read({ id: a.id });
  const gifBytes = Buffer.from(GIF, "base64").length;
  assert.equal(CanvasStore.footprint(m), m.history.reduce((n, h) => n + h.bytes - h.imageBytes, 0) + gifBytes);
});

test("remove deletes the whole history, and with getKeys a version key a broken write left behind", async () => {
  const { s, storage } = store();
  storage.getKeys = async () => Object.keys(storage.data);
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "a" });
  await s.userSave({ id, baseVersion: 1, content: "b" });
  await s.userSave({ id, baseVersion: 2, content: "c" });
  storage.data[CanvasStore.versionKey(id, 99)] = "orphan";
  await s.remove({ id });
  assert.deepEqual(Object.keys(storage.data), []);
});

test("↶ and a user save from the same base under the lock: exactly one wins, history stays consistent", async () => {
  const { s, storage } = store();
  const { id } = await s.agentWrite({ conversationId: "c", title: "T", content: "one" });
  await s.userSave({ id, baseVersion: 1, content: "two" });
  const results = await Promise.allSettled([s.undo({ id, baseVersion: 2 }), s.userSave({ id, baseVersion: 2, content: "three" })]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason.code === "stale").length, 1);
  const m = await s.read({ id });
  assert.equal(m.version, 3);
  assert.deepEqual(m.history.map((h) => h.v), [1, 2, 3]);
  for (const h of m.history) assert.ok(typeof storage.data[CanvasStore.contentKey(m, h.v)] === "string", `v${h.v} has content`);
});
