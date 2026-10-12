// conv-core.test.js — multi-conversation's pure half and storage steps (ADR
// docs/adr/multi-conversation.md §3): titles, tab times, the switch guard, the U2 host line, the open
// set (≤ 3 across live windows), adoption after a browser restart, and the one-time migration from
// `history:<windowId>` — including runs cut short at every storage step and a downgrade round trip.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../conv-core.js");

const ID = (n) => `c_${String(n).padStart(12, "0")}`;
const DAY = 864e5;

// An in-memory chrome.storage.local with optional failure injection: `failAfter` = how many write
// operations (set/remove) succeed before the next one throws (a worker stopped mid-run).
function fakeStorage(initial = {}, { failAfter = Infinity } = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  let writes = 0;
  const write = () => { if (writes++ >= failAfter) throw new Error("worker stopped"); };
  return {
    data,
    setFailAfter(n) { writes = 0; failAfter = n; },
    async get(keys) {
      if (keys == null) return JSON.parse(JSON.stringify(data));
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async getKeys() { return Object.keys(data); },
    async set(o) { write(); for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
    async remove(keys) { write(); for (const k of [].concat(keys)) delete data[k]; },
  };
}
// Web Locks stand-in: one holder per name, FIFO.
function fakeLock() {
  const chains = new Map();
  const held = [];
  const lock = (name, fn) => {
    const prev = chains.get(name) || Promise.resolve();
    const run = prev.then(async () => { held.push(name); try { return await fn(); } finally { held.splice(held.indexOf(name), 1); } });
    chains.set(name, run.catch(() => {}));
    return run;
  };
  return { lock, held };
}
function store(storage, { live = [], now = 1000 * DAY } = {}) {
  let n = 0;
  return C.createConvStore({
    storage, lock: fakeLock().lock, now: () => now,
    liveWindowIds: async () => new Set(live.map(String)),
    randomUUID: () => `${String(++n).padStart(8, "a")}-0000-0000-0000-000000000000`,
  });
}
const msg = (kind, text, timestamp) => ({ kind, text, timestamp, senderName: kind === "sent" ? "You" : "Orca" });

// --- titles / times / guards ------------------------------------------------------------------

test("autoTitle: sanitised like a confirm line, whitespace collapsed, 40 code points", () => {
  assert.equal(C.autoTitle("  幫我\n看一下\t這個 PR  "), "幫我 看一下 這個 PR");
  assert.equal(C.autoTitle(`a${String.fromCodePoint(0x202E)}b${String.fromCodePoint(0x200B)}c`), "a b c");        // bidi override / ZWSP cannot reorder a tab
  assert.equal(C.autoTitle("x".repeat(60)).length, 40);
  assert.equal(Array.from(C.autoTitle("😀".repeat(50))).length, 40);   // by code point, no half emoji
  assert.equal(C.autoTitle("   "), "");
  assert.equal(C.autoTitle(null), "");
});

test("displayTitle: the title, else 未命名 + the 7-char short id", () => {
  assert.equal(C.displayTitle({ title: "Plan" }, ID(1)), "Plan");
  assert.equal(C.displayTitle({ title: null }, "c_abcdef012345"), "未命名 abcdef0");
  assert.equal(C.displayTitle(undefined, "c_abcdef012345"), "未命名 abcdef0");
  assert.equal(C.shortId("c_abcdef012345"), "abcdef0");
});

test("titleAfterUserMessage: the first user message names an untitled conversation, never a user name", () => {
  assert.deepEqual(C.titleAfterUserMessage({ title: null, titleSource: null, createdAt: 1 }, " hi  there "), { title: "hi there", titleSource: "auto", createdAt: 1 });
  assert.equal(C.titleAfterUserMessage({ title: "Mine", titleSource: "user" }, "x"), null);
  assert.equal(C.titleAfterUserMessage({ title: "First", titleSource: "auto" }, "second"), null);   // 🧹 keeps it
  assert.equal(C.titleAfterUserMessage({ title: null, titleSource: null }, "   "), null);            // an image-only message
});

test("renamedEntry: a typed name wins; an empty name returns to the auto title, or none", () => {
  const msgs = [msg("received", "hello", 1), msg("sent", "  請看 PR #12 ", 2)];
  assert.deepEqual(C.renamedEntry({ title: "x", titleSource: "auto", createdAt: 5 }, "  My  topic ", msgs), { title: "My topic", titleSource: "user", createdAt: 5 });
  assert.deepEqual(C.renamedEntry({ title: "x", titleSource: "user" }, "  ", msgs), { title: "請看 PR #12", titleSource: "auto" });
  assert.deepEqual(C.renamedEntry({ title: "x", titleSource: "user" }, "", []), { title: null, titleSource: null });
  assert.equal(C.renamedEntry({}, "y".repeat(200), []).title.length, C.USER_TITLE_MAX);
});

test("tabTime: HH:MM today, else M/D; nothing without a message", () => {
  const now = new Date(2026, 9, 12, 18, 0).getTime();
  assert.equal(C.tabTime(new Date(2026, 9, 12, 9, 5).getTime(), now), "09:05");
  assert.equal(C.tabTime(new Date(2026, 9, 11, 23, 59).getTime(), now), "10/11");
  assert.equal(C.tabTime(new Date(2025, 0, 3, 1, 0).getTime(), now), "1/3");
  assert.equal(C.tabTime(null, now), "");
  assert.equal(C.tabTime(0, now), "");
});

test("shouldWriteIndexTime: at most every 5 s", () => {
  assert.equal(C.shouldWriteIndexTime(undefined, 10), true);
  assert.equal(C.shouldWriteIndexTime(1000, 5999), false);
  assert.equal(C.shouldWriteIndexTime(1000, 6000), true);
});

test("switchBlocked: a running turn, or prompts queued on a live connection, hold the conversation", () => {
  assert.equal(C.switchBlocked([]), null);
  assert.equal(C.switchBlocked([{ turnActive: false, queued: 0, online: true }]), null);
  assert.equal(C.switchBlocked([{ turnActive: true, queued: 0, online: true }]), C.SWITCH_BLOCKED_TEXT);
  assert.equal(C.switchBlocked([{ turnActive: false, queued: 2, online: true }]), C.SWITCH_BLOCKED_TEXT);
  // Queued for a reconnect: the user is not trapped; the queue flushes when it is current again.
  assert.equal(C.switchBlocked([{ turnActive: false, queued: 2, online: false }]), null);
  assert.equal(C.SWITCH_BLOCKED_TEXT, "回覆中不能切換——等回完或先按 ⏹ 停止");
});

test("U2: the host line goes first, only when the conversation had messages before this prompt", () => {
  assert.equal(C.needsReconnectHint({ messageCount: 0, queuedCount: 0 }), false);
  assert.equal(C.needsReconnectHint({ messageCount: 1, queuedCount: 1 }), false);   // a new conversation's first message
  assert.equal(C.needsReconnectHint({ messageCount: 5, queuedCount: 1 }), true);
  assert.equal(C.needsReconnectHint({ messageCount: 3, queuedCount: 0 }), true);    // reconnect, nothing queued yet
  const t = "[2026-10-12T10:00:00.000+08:00 user]\nhi";
  assert.equal(C.withReconnectHint(t), `${C.RECONNECT_HINT}\n\n${t}`);
  assert.equal(C.withReconnectHint(""), C.RECONNECT_HINT);                          // an image-only prompt
  assert.match(C.RECONNECT_HINT, /^\[katashiro: this conversation was just reconnected\. If you do not have its earlier messages, read them with katashiro\.chat_history before answering\.\]$/);
});

test("U2 + reply hint: the host line before the batch keeps batchWithReplyHint's endsWith strip working on a retry", () => {
  const R = require("../room-core.js");
  const a = R.framePrompt({ timestamp: 1, senderName: "user" }, "one");
  const b = R.framePrompt({ timestamp: 2, senderName: "user" }, "two");
  const batch = R.batchWithReplyHint([a, b]);                  // what is stored as lastPrompt (no host line)
  const sent = C.withReconnectHint(batch);
  assert.ok(sent.startsWith(C.RECONNECT_HINT) && sent.endsWith(R.REPLY_HINT));
  // A retry of the stored copy batched with a newer message still carries exactly one reply hint.
  const again = R.batchWithReplyHint([batch, R.framePrompt({ timestamp: 3, senderName: "user" }, "three")]);
  assert.equal(again.split(R.REPLY_HINT).length - 1, 1);
  assert.ok(!again.includes(C.RECONNECT_HINT));
});

// --- the open set ----------------------------------------------------------------------------------

test("liveOpenIds / windowHolding: only live windows count; a closed window's record is found as a fallback", () => {
  const windows = { 1: { open: [ID(1), ID(2)] }, 2: { open: [ID(3)] }, 9: { open: [ID(4)] }, x: { open: ["bad"] } };
  const live = new Set(["1", "2"]);
  assert.deepEqual([...C.liveOpenIds(windows, live)].sort(), [ID(1), ID(2), ID(3)]);
  assert.deepEqual([...C.liveOpenIds(windows, live, 1)], [ID(3)]);
  assert.equal(C.windowHolding(windows, live, ID(3)), "2");
  assert.equal(C.windowHolding(windows, live, ID(4)), "9");
  assert.equal(C.windowHolding(windows, live, ID(5)), null);
});

test("withOpened / withClosed: tab order kept, the neighbour to the right becomes current", () => {
  assert.deepEqual(C.withOpened({ open: [ID(1)], current: ID(1) }, ID(2)), { open: [ID(1), ID(2)], current: ID(2) });
  assert.deepEqual(C.withOpened({ open: [ID(1), ID(2)], current: ID(2) }, ID(1)), { open: [ID(1), ID(2)], current: ID(1) });
  assert.deepEqual(C.withOpened(undefined, ID(1)), { open: [ID(1)], current: ID(1) });
  const rec = { open: [ID(1), ID(2), ID(3)], current: ID(2) };
  assert.deepEqual(C.withClosed(rec, ID(2)), { open: [ID(1), ID(3)], current: ID(3) });
  assert.deepEqual(C.withClosed(rec, ID(1)), { open: [ID(2), ID(3)], current: ID(2) });
  assert.deepEqual(C.withClosed({ open: [ID(1), ID(2)], current: ID(2) }, ID(2)), { open: [ID(1)], current: ID(1) });
  assert.deepEqual(C.withClosed({ open: [ID(1)], current: ID(1) }, ID(1)), { open: [], current: null });
});

test("planAdoption: a new window adopts the most recently used orphan, as many as fit, current first", () => {
  const now = 100 * DAY;
  const windows = {
    10: { open: [ID(1), ID(2), ID(3)], current: ID(3), savedAt: now - 5000 },   // orphan, used most recently
    11: { open: [ID(4)], current: ID(4), savedAt: now - 9000 },                  // orphan, older
    20: { open: [ID(5)], current: ID(5), savedAt: now },                         // live
  };
  const index = { [ID(1)]: { lastMessageAt: now - 100 }, [ID(2)]: { lastMessageAt: now - 50 }, [ID(3)]: { lastMessageAt: 1 } };
  const p = C.planAdoption({ ownWindowId: 30, windows, liveIds: new Set(["20", "30"]), index, now });
  assert.equal(p.adopt, "10");
  // 3 − 1 open in window 20 = 2 slots: current ID(3) first, then the newest, ID(2); ID(1) archived.
  assert.deepEqual(p.take, [ID(2), ID(3)]);                                       // record's tab order
  assert.equal(p.current, ID(3));
  assert.deepEqual(p.archive, [ID(1)]);
  assert.deepEqual(p.prune, []);
});

test("planAdoption: a window with its own record adopts nothing; old orphans are pruned and archived", () => {
  const now = 100 * DAY;
  const windows = {
    5: { open: [ID(1)], current: ID(1), savedAt: now },
    6: { open: [ID(2)], current: ID(2), savedAt: now - 8 * DAY },
    7: { open: [], current: null, savedAt: now - 30 * DAY },
    default: { open: [ID(3)], savedAt: 0 },                                      // not a window id: left alone
  };
  const p = C.planAdoption({ ownWindowId: 5, windows, liveIds: new Set(["5"]), index: {}, now });
  assert.equal(p.adopt, null);
  assert.deepEqual(p.take, []);
  assert.deepEqual(p.prune.sort(), ["6", "7"]);
  assert.deepEqual(p.archive, [ID(2)]);
});

test("planAdoption: recent activity in an orphan's conversations beats a later bare savedAt", () => {
  const now = 100 * DAY;
  const windows = { 1: { open: [ID(1)], current: ID(1), savedAt: now - 1000 }, 2: { open: [ID(2)], current: ID(2), savedAt: now - 500 } };
  const index = { [ID(1)]: { lastMessageAt: now - 10 } };
  assert.equal(C.planAdoption({ ownWindowId: 3, windows, liveIds: new Set(["3"]), index, now }).adopt, "1");
});

test("planAdoption: with 3 open in live windows nothing is adopted; the orphan record stays for later", () => {
  const now = 100 * DAY;
  const windows = { 1: { open: [ID(1), ID(2), ID(3)], savedAt: now }, 9: { open: [ID(4), ID(5)], current: ID(5), savedAt: now } };
  const p = C.planAdoption({ ownWindowId: 2, windows, liveIds: new Set(["1", "2"]), index: {}, now });
  assert.deepEqual(p, { adopt: null, take: [], current: null, archive: [], prune: [] });
});

test("planAdoption: one free slot takes the current one; the rest of the record is archived, none lost", () => {
  const now = 100 * DAY;
  const windows = { 1: { open: [ID(1), ID(2)], savedAt: now }, 9: { open: [ID(4), ID(5)], current: ID(4), savedAt: now } };
  const p = C.planAdoption({ ownWindowId: 2, windows, liveIds: new Set(["1", "2"]), index: { [ID(5)]: { lastMessageAt: now } }, now });
  assert.equal(p.adopt, "9");
  assert.deepEqual(p.take, [ID(4)]);
  assert.deepEqual(p.archive, [ID(5)]);
});

// --- migration: the pure plan ------------------------------------------------------------------------

test("planIdFixes: only entries without a valid id get one", () => {
  let n = 0;
  const fixes = C.planIdFixes({
    "history:1": { messages: [] },
    "history:2": { conversationId: ID(2), messages: [] },
    "history:3": { conversationId: "junk" },
    "other": { },
  }, () => ID(100 + ++n));
  assert.deepEqual(Object.keys(fixes).sort(), ["history:1", "history:3"]);
  assert.equal(fixes["history:1"].conversationId, ID(101));
});

test("planMigration: conversations, index (auto title, times), live windows first, at most 3 open", () => {
  const now = 50 * DAY;
  const h = (id, savedAt, msgs) => ({ conversationId: id, sessions: { "ws://a": `sess_${id}` }, messages: msgs, savedAt });
  const histories = {
    "history:1": h(ID(1), 100, [msg("sent", "live one", 10), msg("received", "ok", 20)]),
    "history:2": h(ID(2), 200, [msg("sent", "live two", 30)]),
    "history:7": h(ID(7), 300, [msg("sent", "orphan newest", 900)]),
    "history:8": h(ID(8), 50, [msg("sent", "orphan older", 40)]),
    "history:9": h(ID(9), 60, []),
  };
  const p = C.planMigration({ histories, convs: {}, index: {}, windows: {}, liveIds: new Set(["1", "2"]), now });
  assert.deepEqual(Object.keys(p.convWrites).sort(), [ID(1), ID(2), ID(7), ID(8), ID(9)]);
  assert.deepEqual(p.convWrites[ID(1)], { id: ID(1), sessions: { "ws://a": `sess_${ID(1)}` }, messages: histories["history:1"].messages, savedAt: 100 });
  assert.deepEqual(p.index[ID(1)], { title: "live one", titleSource: "auto", createdAt: 10, lastMessageAt: 20, archivedAt: null });
  assert.deepEqual(p.index[ID(9)], { title: null, titleSource: null, createdAt: 60, lastMessageAt: null, archivedAt: now });
  // Live windows 1 and 2 first, then the newest orphan; the rest archived, each with no window record.
  assert.deepEqual(p.windowWrites, {
    1: { open: [ID(1)], current: ID(1), savedAt: 100 },
    2: { open: [ID(2)], current: ID(2), savedAt: 200 },
    7: { open: [ID(7)], current: ID(7), savedAt: 300 },     // orphan keeps its record for adoption
  });
  assert.equal(p.index[ID(8)].archivedAt, now);
  assert.deepEqual(p.remove.sort(), Object.keys(histories).sort());
});

test("planMigration: two keys with one id (interrupted #56 adoption) → the newer savedAt wins, only its window gets it", () => {
  const histories = {
    "history:1": { conversationId: ID(1), sessions: { a: "old" }, messages: [msg("sent", "old", 1)], savedAt: 10 },
    "history:2": { conversationId: ID(1), sessions: { a: "new" }, messages: [msg("sent", "old", 1), msg("sent", "new", 2)], savedAt: 20 },
  };
  const p = C.planMigration({ histories, convs: {}, index: {}, windows: {}, liveIds: new Set(["1", "2"]), now: 99 });
  assert.equal(p.convWrites[ID(1)].sessions.a, "new");
  assert.equal(p.convWrites[ID(1)].messages.length, 2);
  assert.deepEqual(Object.keys(p.windowWrites), ["2"]);
  assert.deepEqual(p.remove.sort(), ["history:1", "history:2"]);
});

test("planMigration: an existing conv:<id> as new or newer wins whole; a user title survives", () => {
  const histories = { "history:1": { conversationId: ID(1), messages: [msg("sent", "from history", 1)], savedAt: 10 } };
  const convs = { [ID(1)]: { id: ID(1), sessions: {}, messages: [msg("sent", "from conv", 5)], savedAt: 10 } };
  const index = { [ID(1)]: { title: "Named", titleSource: "user", createdAt: 1, lastMessageAt: 5, archivedAt: null } };
  const p = C.planMigration({ histories, convs, index, windows: {}, liveIds: new Set(["1"]), now: 99 });
  assert.deepEqual(p.convWrites, {});
  assert.equal(p.index[ID(1)].title, "Named");
  assert.equal(p.index[ID(1)].titleSource, "user");
  const newer = C.planMigration({ histories: { "history:1": { ...histories["history:1"], savedAt: 11 } }, convs, index: {}, windows: {}, liveIds: new Set(["1"]), now: 99 });
  assert.equal(newer.convWrites[ID(1)].messages[0].text, "from history");
});

test("planMigration: conversations already open (newer version running) keep their slots and records", () => {
  // Downgrade round trip: window 1 had 3 open before; the older version wrote history:1 meanwhile.
  const windows = { 1: { open: [ID(1), ID(2), ID(3)], current: ID(1), savedAt: 5 } };
  const histories = { "history:1": { conversationId: ID(9), messages: [msg("sent", "written by the old version", 7)], savedAt: 8 } };
  const p = C.planMigration({ histories, convs: {}, index: {}, windows, liveIds: new Set(["1"]), now: 99 });
  assert.deepEqual(p.windowWrites, {});                       // no slot: the open set is not disturbed
  assert.equal(p.index[ID(9)].archivedAt, 99);                // reopenable from the gallery
  assert.equal(p.convWrites[ID(9)].messages.length, 1);       // nothing lost
  // With a free slot it joins that window's record and becomes current.
  const q = C.planMigration({ histories, convs: {}, index: {}, windows: { 1: { open: [ID(1)], current: ID(1), savedAt: 5 } }, liveIds: new Set(["1"]), now: 99 });
  assert.deepEqual(q.windowWrites, { 1: { open: [ID(1), ID(9)], current: ID(9), savedAt: 8 } });
});

test("planMigration is idempotent: re-planning on its own output changes nothing", () => {
  const histories = {
    "history:1": { conversationId: ID(1), messages: [msg("sent", "a", 1)], savedAt: 10 },
    "history:2": { conversationId: ID(2), messages: [msg("sent", "b", 2)], savedAt: 20 },
    "history:3": { conversationId: ID(3), messages: [msg("sent", "c", 3)], savedAt: 30 },
    "history:4": { conversationId: ID(4), messages: [msg("sent", "d", 4)], savedAt: 40 },
  };
  const live = new Set(["1", "2", "3", "4"]);
  const first = C.planMigration({ histories, convs: {}, index: {}, windows: {}, liveIds: live, now: 99 });
  const convs = first.convWrites;
  const second = C.planMigration({ histories, convs, index: first.index, windows: first.windowWrites, liveIds: live, now: 500 });
  assert.deepEqual(second.convWrites, {});
  assert.deepEqual(second.windowWrites, {});
  assert.deepEqual(second.index, first.index);                // archivedAt kept from the first run, not re-stamped
});

// --- migration: the storage run, cut short anywhere ----------------------------------------------

const legacy = () => ({
  "history:1": { messages: [msg("sent", "pre-#61 chat", 10)], sessions: { "ws://a": "sess_A" }, savedAt: 100 },   // no id
  "history:2": { conversationId: ID(2), messages: [msg("sent", "second", 20)], savedAt: 200 },
  "history:3": { conversationId: ID(3), messages: [msg("sent", "third", 30)], savedAt: 300 },
  "history:4": { conversationId: ID(4), messages: [msg("sent", "fourth", 40)], savedAt: 400 },
  "canvas:cv_000000000001:meta": { id: "cv_000000000001" },
});

test("migrate: a full run — every chat kept, ≤ 3 open, history keys gone, schema 1", async () => {
  const s = fakeStorage(legacy());
  const r = await store(s, { live: [1, 2, 3, 4] }).migrate();
  assert.equal(r.migrated, 4);
  const convs = Object.keys(s.data).filter((k) => /^conv:c_/.test(k));
  assert.equal(convs.length, 4);
  assert.ok(!Object.keys(s.data).some((k) => k.startsWith("history:")));
  assert.equal(s.data["conv:schema"], 1);
  const idx = s.data["conv:index"];
  const open = Object.keys(idx).filter((id) => idx[id].archivedAt === null);
  assert.equal(open.length, 3);
  assert.equal(Object.keys(s.data).filter((k) => k.startsWith("window:")).length, 3);
  assert.ok(s.data["canvas:cv_000000000001:meta"]);           // canvases untouched
  // The pre-#61 chat got an id and kept its session.
  const pre = Object.values(s.data).find((v) => v && v.messages && v.messages[0] && v.messages[0].text === "pre-#61 chat" && v.id);
  assert.equal(pre.sessions["ws://a"], "sess_A");
  // Nothing to do on a second run.
  assert.deepEqual(await store(s).migrate(), { migrated: 0 });
});

test("migrate: cut short after every possible write, the next run finishes with the same conversations (no duplicate ids)", async () => {
  // Reference: one uninterrupted run.
  const ref = fakeStorage(legacy());
  await store(ref, { live: [1, 2, 3, 4] }).migrate();
  const refConvs = Object.keys(ref.data).filter((k) => /^conv:c_/.test(k)).length;
  // Writes: 1 id fix, 2 conversations + index + windows, 3 remove history keys, 4 schema marker.
  for (let cut = 0; cut < 4; cut++) {
    const s = fakeStorage(legacy(), { failAfter: cut });
    await assert.rejects(store(s, { live: [1, 2, 3, 4] }).migrate(), /worker stopped/, `cut ${cut}`);
    s.setFailAfter(Infinity);
    await store(s, { live: [1, 2, 3, 4] }).migrate();
    const convKeys = Object.keys(s.data).filter((k) => /^conv:c_/.test(k));
    assert.equal(convKeys.length, refConvs, `cut ${cut}: one conversation per chat`);
    assert.ok(!Object.keys(s.data).some((k) => k.startsWith("history:")), `cut ${cut}`);
    const idx = s.data["conv:index"];
    assert.equal(Object.keys(idx).length, 4, `cut ${cut}`);
    assert.equal(Object.values(idx).filter((e) => e.archivedAt === null).length, 3, `cut ${cut}`);
    const texts = convKeys.map((k) => s.data[k].messages[0].text).sort();
    assert.deepEqual(texts, ["fourth", "pre-#61 chat", "second", "third"], `cut ${cut}`);
  }
});

test("migrate: an id minted in step 1 is written back before anything else (a cut run reuses it)", async () => {
  const s = fakeStorage({ "history:1": { messages: [msg("sent", "x", 1)], savedAt: 5 } }, { failAfter: 1 });
  await assert.rejects(store(s, { live: [1] }).migrate());
  const minted = s.data["history:1"].conversationId;
  assert.match(minted, C.ID_RE);
  s.setFailAfter(Infinity);
  await store(s, { live: [1] }).migrate();
  assert.ok(s.data[`conv:${minted}`]);
  assert.deepEqual(s.data["window:1"], { open: [minted], current: minted, savedAt: 5 });
});

test("migrate: downgrade round trip — what the older version wrote becomes its own conversation", async () => {
  const s = fakeStorage(legacy());
  await store(s, { live: [1] }).migrate();
  const before = Object.keys(s.data).filter((k) => /^conv:c_/.test(k)).length;
  // The older version finds no history: key, starts a new conversation (its own id) and writes it.
  s.data["history:1"] = { conversationId: ID(77), messages: [msg("sent", "while downgraded", 999)], savedAt: 999 };
  await store(s, { live: [1] }).migrate();
  assert.equal(Object.keys(s.data).filter((k) => /^conv:c_/.test(k)).length, before + 1);
  assert.equal(s.data[`conv:${ID(77)}`].messages[0].text, "while downgraded");
  assert.ok(ID(77) in s.data["conv:index"]);
  assert.ok(!("history:1" in s.data));
});

test("archiveIds: empty conversations are deleted, the rest archived", async () => {
  const s = fakeStorage({
    [`conv:${ID(1)}`]: { id: ID(1), messages: [msg("sent", "x", 1)] },
    [`conv:${ID(2)}`]: { id: ID(2), messages: [] },                     // session saved, no message
    [`conv:${ID(3)}`]: { id: ID(3), messages: [] },
    [`canvas:${ID(3)}:index`]: [{ id: "cv_000000000001" }],             // …but a canvas: kept
    "conv:index": { [ID(1)]: { title: "a", archivedAt: null }, [ID(2)]: { title: null, archivedAt: null }, [ID(3)]: { archivedAt: null }, [ID(4)]: { archivedAt: null } },
  });
  const r = await store(s, { now: 777 }).archiveIds([ID(1), ID(2), ID(3), ID(4)]);
  assert.deepEqual(r.archived.sort(), [ID(1), ID(3)]);
  assert.deepEqual(r.deleted.sort(), [ID(2), ID(4)]);
  assert.equal(s.data["conv:index"][ID(1)].archivedAt, 777);
  assert.ok(!(ID(2) in s.data["conv:index"]));
  assert.ok(!(`conv:${ID(2)}` in s.data));
  assert.ok(`conv:${ID(3)}` in s.data);
});

// --- gallery rows --------------------------------------------------------------------------------

test("galleryRows: only conversations not open in a live window, newest first, title search", () => {
  const now = new Date(2026, 9, 12, 18, 0).getTime();
  const index = {
    [ID(1)]: { title: "Open here", lastMessageAt: now - 10, archivedAt: null },
    [ID(2)]: { title: "Archived plan", lastMessageAt: now - 5000, archivedAt: 1 },
    [ID(3)]: { title: null, lastMessageAt: now - 100, archivedAt: null },      // left in a closed window's record
    bogus: { title: "x" },
  };
  const rows = C.galleryRows({ index, openLive: new Set([ID(1)]), canvasCounts: { [ID(2)]: 2 }, query: "", now });
  assert.deepEqual(rows.map((r) => r.id), [ID(3), ID(2)]);
  assert.equal(rows[0].title, `未命名 ${C.shortId(ID(3))}`);
  assert.equal(rows[1].canvases, 2);
  assert.equal(rows[1].archived, true);
  assert.deepEqual(C.galleryRows({ index, openLive: new Set(), canvasCounts: {}, query: "ＰＬＡＮ", now }).map((r) => r.id), [ID(2)]);
});

// --- P1b (ADR §4) -------------------------------------------------------------------------------
test("agentTitledEntry (set_title): sanitised, ≤ 80, titleSource agent; a user title always wins", () => {
  const r = C.agentTitledEntry({ title: "auto one", titleSource: "auto", createdAt: 3 }, "  Market‮  research\n2026 ");
  assert.deepEqual(r, { ok: true, entry: { title: "Market research 2026", titleSource: "agent", createdAt: 3 }, title: "Market research 2026" });
  assert.equal(C.agentTitledEntry({ title: "A", titleSource: "agent" }, "B").entry.title, "B");          // its own earlier title
  assert.equal(C.agentTitledEntry({ title: null, titleSource: null }, "New").entry.titleSource, "agent");
  const user = C.agentTitledEntry({ title: "Mine", titleSource: "user" }, "Agent's");
  assert.equal(user.ok, false);
  assert.match(user.error, /the user named this conversation/);
  assert.equal(C.agentTitledEntry({}, "​‮  ").ok, false);
  assert.equal(C.agentTitledEntry({}, 42).ok, false);
  assert.equal(Array.from(C.agentTitledEntry({}, "字".repeat(200)).title).length, C.USER_TITLE_MAX);
});

test("titleAfterUserMessage: an agent title is not replaced by the next user message", () => {
  assert.equal(C.titleAfterUserMessage({ title: "Named by agent", titleSource: "agent" }, "hello"), null);
  // an agent source with no title left (should not happen) still gets the auto title
  assert.deepEqual(C.titleAfterUserMessage({ title: null, titleSource: "agent" }, "hello"), { title: "hello", titleSource: "auto" });
});

test("pushRefusal: open in another live window with its panel closed vs archived / closed window", () => {
  const windows = { 1: { open: [ID(1)] }, 2: { open: [ID(2)] }, 9: { open: [ID(3)] } };
  const live = new Set(["1", "2"]);
  assert.deepEqual(C.pushRefusal({ windows, liveIds: live, id: ID(2), ownWindowId: 1 }), { text: C.PANEL_CLOSED_PUSH_TEXT, windowId: "2" });
  assert.deepEqual(C.pushRefusal({ windows, liveIds: live, id: ID(3), ownWindowId: 1 }), { text: C.ARCHIVED_PUSH_TEXT, windowId: null });   // closed window's record
  assert.deepEqual(C.pushRefusal({ windows, liveIds: live, id: ID(4), ownWindowId: 1 }), { text: C.ARCHIVED_PUSH_TEXT, windowId: null });   // archived
  // in this window's own record but its lock is free: not "another window"
  assert.equal(C.pushRefusal({ windows, liveIds: live, id: ID(1), ownWindowId: 1 }).text, C.ARCHIVED_PUSH_TEXT);
});
