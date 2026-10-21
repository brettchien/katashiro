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

test("archiveBlocked: a running turn, or prompts queued on a live connection, hold the conversation (P2: switching never does)", () => {
  assert.equal(C.archiveBlocked([]), null);
  assert.equal(C.archiveBlocked([{ turnActive: false, queued: 0, online: true }]), null);
  assert.equal(C.archiveBlocked([{ turnActive: true, queued: 0, online: true }]), C.ARCHIVE_BLOCKED_TEXT);
  assert.equal(C.archiveBlocked([{ turnActive: false, queued: 2, online: true }]), C.ARCHIVE_BLOCKED_TEXT);
  // Queued for a reconnect: not held; the queue resends once the socket is back.
  assert.equal(C.archiveBlocked([{ turnActive: false, queued: 2, online: false }]), null);
  assert.equal(C.archiveBlocked([null, { turnActive: true, queued: 0, online: true }]), C.ARCHIVE_BLOCKED_TEXT);
  assert.equal(C.ARCHIVE_BLOCKED_TEXT, "回覆中不能封存——等回完或先按 ⏹ 停止");
  assert.equal(C.switchBlocked, undefined);
});

test("promptFailureText: pool exhausted is said plainly (never auto-retried); anything else as before", () => {
  assert.equal(C.promptFailureText("pool exhausted: all sessions busy"), `回合沒有開始：${C.POOL_EXHAUSTED_TEXT}`);
  assert.equal(C.promptFailureText("Pool is exhausted"), `回合沒有開始：${C.POOL_EXHAUSTED_TEXT}`);
  assert.equal(C.promptFailureText("boom"), "回合失敗：boom");
  assert.equal(C.promptFailureText(undefined), "回合失敗：");
});

test("isPoolBusyReply: openab's full-pool chat line (dispatch.rs ⚠️ + error_display.rs), and only that", () => {
  assert.equal(C.isPoolBusyReply("⚠️ **Service Busy**\nAll agent sessions are in use, please try again shortly."), true);
  assert.equal(C.isPoolBusyReply("⚠️ **Service Busy**\nAll agent sessions are in use, please try again shortly.\n"), true);
  assert.equal(C.isPoolBusyReply("**Service Busy**\nAll agent sessions are in use, please try again shortly."), false);
  assert.equal(C.isPoolBusyReply("openab says:\n⚠️ **Service Busy**\nAll agent sessions are in use, please try again shortly."), false);
  assert.equal(C.isPoolBusyReply("⚠️ **Service Busy**\nAll agent sessions are in use.\n\nAnd here is more of my reply"), false);
  assert.equal(C.isPoolBusyReply(""), false);
  assert.equal(C.isPoolBusyReply(undefined), false);
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

// --- A′: when the host line is skipped (tunnel-liveness §9.2) -------------------------------------

test("A′ continuesRun: an unclean drop reopened < 2 min after the previous socket's last inbound frame continues the run", () => {
  const T = 1_000_000_000;
  const u = { prevEnd: "unclean" };
  assert.equal(C.QUICK_RECONNECT_MS, 120000);
  assert.equal(C.continuesRun({ ...u, prevLastRecvAt: T, openedAt: T + 35_000 }), true);     // edge blip: browser gives up after ~35 s
  assert.equal(C.continuesRun({ ...u, prevLastRecvAt: T, openedAt: T + 119_999 }), true);
  assert.equal(C.continuesRun({ ...u, prevLastRecvAt: T, openedAt: T + 120_000 }), false);   // ≥ 2 min: maybe a restart
  assert.equal(C.continuesRun({ ...u, prevLastRecvAt: T, openedAt: T + 125_000 }), false);   // heartbeat teardown (~125 s of silence)
  assert.equal(C.continuesRun({ ...u, prevLastRecvAt: 0, openedAt: T }), false);             // no earlier socket: panel reload / new conn
  assert.equal(C.continuesRun({ ...u, prevLastRecvAt: T + 5, openedAt: T }), false);         // clock went backwards: don't vouch
  assert.equal(C.continuesRun({ ...u, prevLastRecvAt: T, openedAt: NaN }), false);
  assert.equal(C.continuesRun(), false);
  assert.equal(C.continuesRun({ ...u, prevLastRecvAt: T, openedAt: T + 50, quickMs: 10 }), false);
});

test("A′ continuesRun: a clean close starts a new run however fast the next socket opens (rolling deploy, restart)", () => {
  const T = 1_000_000_000;
  // Rolling deploy: the old task closes its socket, the reconnect 5 s later lands on the new task.
  assert.equal(C.continuesRun({ prevEnd: "clean", prevLastRecvAt: T, openedAt: T + 5_000 }), false);
  assert.equal(C.continuesRun({ prevEnd: null, prevLastRecvAt: T, openedAt: T + 5_000 }), false);   // unknown end: don't vouch
  assert.equal(C.continuesRun({ prevLastRecvAt: T, openedAt: T + 5_000 }), false);                  // prevEnd defaults to unknown
  assert.equal(C.continuesRun({ prevEnd: "unclean", prevLastRecvAt: T, openedAt: T + 5_000 }), true);
});

test("A′ lastReplyAt: the newest reply of that agent only (not the user's, another agent's, or an error)", () => {
  const msgs = [
    { kind: "sent", senderId: "user", timestamp: 900 },
    { kind: "received", senderId: "wss://a", timestamp: 100 },
    { kind: "received", senderId: "wss://a", timestamp: 300 },
    { kind: "received", senderId: "wss://b", timestamp: 500 },
    { kind: "error", senderName: "A", timestamp: 700 },
    { kind: "received", senderId: "wss://a", timestamp: 200 },
    null,
  ];
  assert.equal(C.lastReplyAt(msgs, "wss://a"), 300);
  assert.equal(C.lastReplyAt(msgs, "wss://b"), 500);
  assert.equal(C.lastReplyAt(msgs, "wss://c"), 0);
  assert.equal(C.lastReplyAt(undefined, "wss://a"), 0);
});

test("A′ reconnectHintDecision: each case of the rule", () => {
  const H = 3600_000, M = 60_000;
  const now = 10 * H;
  const base = { messageCount: 6, queuedCount: 1, resumed: true, runStartAt: now - 30 * M, lastReplyAt: now - 5 * M, now };
  const d = (o) => C.reconnectHintDecision({ ...base, ...o });
  assert.equal(C.POOL_TTL_MS, H);
  // Skip: a quick reconnect (the run continued) or a switch / gallery reopen on a live socket — the
  // agent replied in this conversation during the current run, 5 min ago.
  assert.deepEqual(d({}), { hint: false, reason: "session intact (same connection run)" });
  assert.equal(d({ lastReplyAt: base.runStartAt }).hint, false);                       // reply at the run's start counts
  // No earlier messages: never (a new conversation's first prompt).
  assert.deepEqual(d({ messageCount: 1, queuedCount: 1, resumed: false }), { hint: false, reason: "no earlier messages" });
  // session/new (no saved session, or the fallback after a failed resume): always.
  assert.deepEqual(d({ resumed: false }), { hint: true, reason: "new session" });
  // A panel reload / slow reconnect (≥ 2 min) starts a new run: the reply predates it.
  assert.deepEqual(d({ runStartAt: now - 1000, lastReplyAt: now - 5 * M }), { hint: true, reason: "last reply before this connection run" });
  // Reopened from the gallery / switched to: used 30 min ago but before this run (e.g. before a reload).
  assert.equal(d({ runStartAt: now - 10 * M, lastReplyAt: now - 30 * M }).hint, true);
  // Within the run but idle ≥ the pool TTL: the pool may have suspended / evicted the session.
  assert.deepEqual(d({ runStartAt: now - 3 * H, lastReplyAt: now - H }), { hint: true, reason: "last reply older than the pool TTL" });
  assert.equal(d({ runStartAt: now - 3 * H, lastReplyAt: now - H + 1 }).hint, false);
  // This agent never replied here (another agent did, or every turn failed): can't vouch.
  assert.deepEqual(d({ lastReplyAt: 0 }), { hint: true, reason: "no reply from this agent" });
  // No run (no socket ever opened) or no clock: keep the line.
  assert.deepEqual(d({ runStartAt: 0 }), { hint: true, reason: "no connection run" });
  assert.equal(d({ now: undefined }).hint, true);
  assert.equal(C.reconnectHintDecision().hint, false);                                  // nothing at all: nothing to hint
});

test("U2 + reply hint: the host line before the batch keeps batchWithReplyHint's endsWith strip working on a retry", () => {
  const R = require("../room-core.js");
  const a = R.framePrompt({ timestamp: 1, senderName: "user" }, "one");
  const b = R.framePrompt({ timestamp: 2, senderName: "user" }, "two");
  const batch = R.batchWithReplyHint([a, b]);                  // what a turn keeps for 重試 (no host line)
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

test("planAdoption skip (agent-per-conversation §7 I3): empty conversations take no slot and are archived", () => {
  const now = 100 * DAY;
  // Review #158 nit 1: window 20 has 1 open → 2 free; the orphan holds [E (empty, current), B, C].
  const windows = {
    10: { open: [ID(9), ID(2), ID(3)], current: ID(9), savedAt: now - 5000 },
    20: { open: [ID(5)], current: ID(5), savedAt: now },
  };
  const index = { [ID(2)]: { lastMessageAt: now - 50 }, [ID(3)]: { lastMessageAt: now - 100 } };
  const p = C.planAdoption({ ownWindowId: 30, windows, liveIds: new Set(["20", "30"]), index, now, skip: new Set([ID(9)]) });
  assert.deepEqual(p.take, [ID(2), ID(3)]);                // both fit: the empty one took no slot
  assert.equal(p.current, ID(2));                           // the empty current falls to the newest
  assert.deepEqual(p.archive, [ID(9)]);
  // A record holding only empty conversations is not adopted.
  const q = C.planAdoption({ ownWindowId: 30, windows: { 10: { open: [ID(9)], current: ID(9), savedAt: now } }, liveIds: new Set(["30"]), index: {}, now, skip: new Set([ID(9)]) });
  assert.equal(q.adopt, null);
  assert.deepEqual(q.take, []);
});

test("isEmptyConversation: no messages and no canvases", () => {
  assert.equal(C.isEmptyConversation(undefined, undefined), true);
  assert.equal(C.isEmptyConversation({ messages: [] }, []), true);
  assert.equal(C.isEmptyConversation({ messages: [{ text: "hi" }] }, []), false);
  assert.equal(C.isEmptyConversation({ messages: [] }, ["cv_1"]), false);
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
    [`canvas:${ID(2)}:moved`]: [{ id: "cv_000000000002", dir: "out", at: 1 }],   // §7.3: a canvas moved in and out again
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
  assert.ok(!(`canvas:${ID(2)}:moved` in s.data));
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

// --- §7.1 deleting a conversation ----------------------------------------------------------------
const CanvasStore = require("../canvas-store.js");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG2 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("planDelete: refused while open in a live window (with it); else closed-window records drop it and the entry is marked", () => {
  const windows = { 1: { open: [ID(1)], current: ID(1) }, 9: { open: [ID(2), ID(3)], current: ID(2), savedAt: 7 } };
  const live = new Set(["1"]);
  const index = { [ID(1)]: { title: "a" }, [ID(2)]: { title: "b", archivedAt: null }, [ID(4)]: { title: "d", archivedAt: 5 } };
  assert.deepEqual(C.planDelete({ id: ID(1), windows, liveIds: live, index, now: 50 }), { refuse: "open", windowId: "1" });
  const p = C.planDelete({ id: ID(2), windows, liveIds: live, index, now: 50 });
  assert.equal(p.refuse, null);
  assert.deepEqual(p.windowWrites, { 9: { open: [ID(3)], current: ID(3), savedAt: 7 } });
  assert.deepEqual(p.entry, { title: "b", archivedAt: null, deletingAt: 50 });
  // an archived one: no record touched; an earlier mark keeps its time
  const q = C.planDelete({ id: ID(4), windows, liveIds: live, index: { [ID(4)]: { title: "d", deletingAt: 9 } }, now: 50 });
  assert.deepEqual([q.windowWrites, q.entry.deletingAt, q.known], [{}, 9, true]);
  // no index entry (lost): still marked, so a cut-short run is finished later
  const r = C.planDelete({ id: ID(5), windows, liveIds: live, index, now: 50 });
  assert.equal(r.known, false);
  assert.equal(r.entry.deletingAt, 50);
});

test("galleryRows (agent-per-conversation §7 I2): each row names its agent; removed → null; search matches the agent", () => {
  const now = new Date(2026, 9, 16, 22, 0).getTime();
  const index = {
    [ID(1)]: { title: "Plan", lastMessageAt: now - 10, archivedAt: 1, agentUrl: "wss://o/acp" },
    [ID(2)]: { title: "Notes", lastMessageAt: now - 20, archivedAt: 1, agentUrl: "ws://gone/acp" },
    [ID(3)]: { title: "Old", lastMessageAt: now - 30, archivedAt: 1 },
  };
  const agentNames = { "wss://o/acp": "orca" };
  const rows = C.galleryRows({ index, openLive: new Set(), canvasCounts: {}, query: "", now, agentNames });
  assert.deepEqual(rows.map((r) => [r.id, r.agent, r.agentUrl]), [[ID(1), "orca", "wss://o/acp"], [ID(2), null, "ws://gone/acp"], [ID(3), null, null]]);
  assert.deepEqual(C.galleryRows({ index, openLive: new Set(), canvasCounts: {}, query: "ORCA", now, agentNames }).map((r) => r.id), [ID(1)]);
  assert.deepEqual(C.galleryRows({ index, openLive: new Set(), canvasCounts: {}, query: "orca plan", now, agentNames }).map((r) => r.id), [ID(1)]);
  assert.deepEqual(C.galleryRows({ index, openLive: new Set(), canvasCounts: {}, query: "notes", now }).map((r) => r.id), [ID(2)]);   // no names given: title search as before
});

test("pendingDeletions / reopenRefusal / galleryRows: a marked conversation is gone for the user", () => {
  const index = { [ID(1)]: { title: "keep", lastMessageAt: 2 }, [ID(2)]: { title: "going", deletingAt: 3, lastMessageAt: 3 }, bogus: { deletingAt: 1 } };
  assert.deepEqual(C.pendingDeletions(index), [ID(2)]);
  assert.equal(C.reopenRefusal(index[ID(1)]), null);
  assert.equal(C.reopenRefusal(index[ID(2)]), C.DELETED_TEXT);
  assert.equal(C.reopenRefusal(undefined), C.DELETED_TEXT);
  assert.deepEqual(C.galleryRows({ index, openLive: new Set(), canvasCounts: {}, query: "", now: 10 }).map((r) => r.id), [ID(1)]);
});

test("deleteConfirmText: counts, folder files stay only when mirrored, cannot be undone; a title cannot add a line", () => {
  const t = C.deleteConfirmText({ title: "Plan\n(nothing will be deleted)", messages: 12, summary: { canvases: 3, versions: 8, images: 2, mirrored: true } });
  const lines = t.split("\n");
  assert.equal(lines[0], "刪除對話「Plan (nothing will be deleted)」？");
  assert.ok(lines.includes("・12 則訊息"));
  assert.ok(lines.some((l) => l.startsWith("・3 個畫布，連同存著的 8 個版本和 2 張圖片")));
  assert.ok(lines.includes("資料夾裡的畫布檔案不會被刪除。"));
  assert.equal(lines[lines.length - 1], "這個動作無法復原。");
  const bare = C.deleteConfirmText({ title: "", messages: 0, summary: {} });
  assert.ok(bare.includes("・0 則訊息") && bare.includes("・沒有畫布") && !bare.includes("資料夾"));
  assert.ok(bare.startsWith("刪除對話「未命名」？"));
});

// A Web Locks stand-in that also does ifAvailable: `hold(name)` makes a name busy (another window).
function locks() {
  const { lock } = fakeLock();
  const busy = new Set();
  const lockIfAvailable = async (name, fn) => {
    if (busy.has(name)) return fn(null);
    busy.add(name);
    try { return await fn({ name }); } finally { busy.delete(name); }
  };
  return { lock, lockIfAvailable, hold: (n) => busy.add(n), free: (n) => busy.delete(n) };
}

// Two conversations with canvases: A has a markdown canvas with 2 versions and an image canvas
// (its own image + one B shares); B has one image canvas with the shared image.
async function deleteFixture({ failAfter = Infinity } = {}) {
  const storage = fakeStorage({}, {});
  const L = locks();
  let clock = 1000 * DAY;
  let hex = 0;
  const canvasStore = CanvasStore.createCanvasStore({ storage, lock: L.lock, now: () => clock, randomHex: () => String(++hex).padStart(12, "0") });
  const a1 = await canvasStore.agentWrite({ conversationId: ID(1), title: "Plan", content: "# v1" });
  await canvasStore.agentWrite({ conversationId: ID(1), id: a1.id, baseVersion: 1, title: "Plan", content: "# v2" });
  const a2 = await canvasStore.agentWrite({ conversationId: ID(1), title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG2 } });
  await canvasStore.agentWrite({ conversationId: ID(1), id: a2.id, baseVersion: 1, title: "Shot", kind: "image", image: { mimeType: "image/png", data: PNG } });
  const b1 = await canvasStore.agentWrite({ conversationId: ID(2), title: "Other", kind: "image", image: { mimeType: "image/png", data: PNG } });
  clock += 11 * 60 * 1000;                        // past the sweep's 10-minute grace
  await storage.set({
    [C.convKey(ID(1))]: { id: ID(1), sessions: { "ws://a": "sess_1" }, messages: [msg("sent", "hi", 1)], savedAt: 1 },
    [C.convKey(ID(2))]: { id: ID(2), sessions: {}, messages: [msg("sent", "yo", 2)], savedAt: 2 },
    [C.INDEX_KEY]: { [ID(1)]: { title: "A", archivedAt: 5, lastMessageAt: 1 }, [ID(2)]: { title: "B", archivedAt: null, lastMessageAt: 2 } },
    "window:1": { open: [ID(2)], current: ID(2), savedAt: 3 },
    "window:9": { open: [ID(1), ID(3)], current: ID(1), savedAt: 4 },     // a closed window still lists A
  });
  const session = fakeStorage({ [`${C.GROUP_KEY_PREFIX}${ID(1)}`]: 77, [`${C.GROUP_KEY_PREFIX}${ID(2)}`]: 78 });
  const conv = C.createConvStore({
    storage, lock: L.lock, lockIfAvailable: L.lockIfAvailable, now: () => clock,
    liveWindowIds: async () => new Set(["1"]),
    canvases: C.canvasOps(canvasStore), sessionStorage: session,
  });
  storage.setFailAfter(failAfter);
  return { storage, session, conv, L, canvasStore, ids: { a1: a1.id, a2: a2.id, b1: b1.id } };
}
const imageKeys = (data) => Object.keys(data).filter((k) => k.startsWith("canvas:img:")).sort();

test("deleteConversation: messages, sessions, every canvas version and its unshared images go; the rest stays", async () => {
  const f = await deleteFixture();
  const before = imageKeys(f.storage.data);
  assert.equal(before.length, 2);
  const r = await f.conv.deleteConversation(ID(1));
  assert.deepEqual(r, { ok: true, canvases: 2, known: true });
  const d = f.storage.data;
  assert.equal(d[C.convKey(ID(1))], undefined);
  assert.equal(d[C.INDEX_KEY][ID(1)], undefined);
  assert.ok(d[C.INDEX_KEY][ID(2)]);
  assert.deepEqual(d["window:9"], { open: [ID(3)], current: ID(3), savedAt: 4 });
  assert.deepEqual(d["window:1"], { open: [ID(2)], current: ID(2), savedAt: 3 });
  for (const id of [f.ids.a1, f.ids.a2]) assert.deepEqual(Object.keys(d).filter((k) => k.startsWith(`canvas:${id}:`)), [], id);
  assert.equal(d[`canvas:${ID(1)}:index`], undefined);
  assert.ok(d[`canvas:${f.ids.b1}:meta`] && d[`canvas:${ID(2)}:index`].length === 1);
  // the image only A used is swept; the one B shows stays
  const after = imageKeys(d);
  assert.equal(after.length, 1);
  const bRef = JSON.parse(d[`canvas:${f.ids.b1}:latest`]).image;
  assert.deepEqual(after, [`canvas:img:${bRef}`]);
  assert.equal(f.session.data[`${C.GROUP_KEY_PREFIX}${ID(1)}`], undefined);
  assert.equal(f.session.data[`${C.GROUP_KEY_PREFIX}${ID(2)}`], 78);
  // again: no entry any more — known: false (the gallery says 找不到這段對話)
  assert.deepEqual(await f.conv.deleteConversation(ID(1)), { ok: true, canvases: 0, known: false });
  assert.equal(f.storage.data[C.INDEX_KEY][ID(1)], undefined);
});

test("deleteConversation: a canvas moved out after it was listed is skipped, the rest still goes (§7.3)", async () => {
  const f = await deleteFixture();
  const real = C.canvasOps(f.canvasStore);
  const conv = C.createConvStore({
    storage: f.storage, lock: f.L.lock, lockIfAvailable: f.L.lockIfAvailable, now: () => 2000 * DAY,
    liveWindowIds: async () => new Set(["1"]),
    canvases: { ...real, idsOf: async (id) => {
      const ids = await real.idsOf(id);
      await f.canvasStore.move({ id: f.ids.a1, from: ID(1), to: ID(2) });   // a pull lands between list and remove
      return ids;
    } },
  });
  assert.deepEqual(await conv.deleteConversation(ID(1)), { ok: true, canvases: 1, known: true });
  assert.equal(f.storage.data[`canvas:${f.ids.a1}:meta`].conversationId, ID(2));
  assert.equal(f.storage.data[`canvas:${f.ids.a2}:meta`], undefined);
  assert.equal(f.storage.data[C.INDEX_KEY][ID(1)], undefined);
});

test("deleteConversation: a canvas remove that really fails stops the delete; the mark stays for the next run", async () => {
  const f = await deleteFixture();
  const real = C.canvasOps(f.canvasStore);
  const conv = C.createConvStore({
    storage: f.storage, lock: f.L.lock, lockIfAvailable: f.L.lockIfAvailable, now: () => 2000 * DAY,
    liveWindowIds: async () => new Set(["1"]),
    canvases: { ...real, remove: async (cid, id) => { if (cid === f.ids.a1) throw new Error("storage write failed"); return real.remove(cid, id); } },
  });
  await assert.rejects(conv.deleteConversation(ID(1)), /storage write failed/);
  assert.equal(f.storage.data[`canvas:${f.ids.a1}:meta`].conversationId, ID(1));
  assert.notEqual(f.storage.data[C.INDEX_KEY][ID(1)].deletingAt, null);
  assert.deepEqual(C.pendingDeletions(f.storage.data[C.INDEX_KEY]), [ID(1)]);
  assert.deepEqual(await f.conv.finishDeletions(), [ID(1)]);                      // the next run finishes it
  assert.equal(f.storage.data[`canvas:${f.ids.a1}:meta`], undefined);
  assert.equal(f.storage.data[C.INDEX_KEY][ID(1)], undefined);
});

test("deleteConversation: refused (nothing touched) while open in a live window, or its lock is held elsewhere", async () => {
  const f = await deleteFixture();
  const snap = JSON.stringify(f.storage.data);
  assert.deepEqual(await f.conv.deleteConversation(ID(2)), { ok: false, reason: "open", windowId: "1" });
  f.L.hold(`conv:${ID(1)}`);                       // a panel holds it (reopened between render and click)
  // only in a closed window's record: no window to name
  assert.deepEqual(await f.conv.deleteConversation(ID(1)), { ok: false, reason: "locked", windowId: null });
  // the panel that took it lists it in its live window's record: that window is named
  await f.storage.set({ "window:1": { open: [ID(2), ID(1)], current: ID(1), savedAt: 3 } });
  const snap2 = JSON.stringify(f.storage.data);
  assert.deepEqual(await f.conv.deleteConversation(ID(1)), { ok: false, reason: "locked", windowId: "1" });
  assert.equal(JSON.stringify(f.storage.data), snap2);
  await f.storage.set({ "window:1": { open: [ID(2)], current: ID(2), savedAt: 3 } });
  assert.equal(JSON.stringify(f.storage.data), snap);
  assert.deepEqual(await f.conv.deleteConversation("nope"), { ok: false, reason: "invalid", windowId: null });
});

test("deleteConversation: cut short at every write, finishDeletions completes it; before the mark nothing changed", async () => {
  const ref = await deleteFixture();
  const original = JSON.stringify(ref.storage.data);
  await ref.conv.deleteConversation(ID(1));
  const want = JSON.stringify(ref.storage.data);
  let cuts = 0;
  for (let cut = 0; ; cut++) {
    const f = await deleteFixture({ failAfter: cut });
    let threw = false;
    try { await f.conv.deleteConversation(ID(1)); } catch (_) { threw = true; }
    if (!threw) break;                              // the run fits in `cut` writes: every cut point tried
    cuts++;
    f.storage.setFailAfter(Infinity);
    if (cut === 0) {
      assert.equal(JSON.stringify(f.storage.data), original, "cut before the mark: untouched");
      assert.deepEqual(await f.conv.finishDeletions(), []);
      continue;
    }
    assert.deepEqual(C.pendingDeletions(f.storage.data[C.INDEX_KEY]), [ID(1)], `cut ${cut}: marked`);
    // the gallery hides it meanwhile
    assert.deepEqual(C.galleryRows({ index: f.storage.data[C.INDEX_KEY], openLive: new Set(), canvasCounts: {}, query: "", now: 1 }).map((r) => r.id), [ID(2)]);
    // a delete running elsewhere (lock held) is not finished from here
    f.L.hold(`conv:${ID(1)}`);
    assert.deepEqual(await f.conv.finishDeletions(), []);
    f.L.free(`conv:${ID(1)}`);
    assert.deepEqual(await f.conv.finishDeletions(), [ID(1)], `cut ${cut}`);
    assert.equal(JSON.stringify(f.storage.data), want, `cut ${cut}: same end state`);
  }
  assert.ok(cuts >= 5, `tried ${cuts} cut points`);
});

test("deleteSnapshot / deleteRecheck: what the dialog showed, compared after 確定", () => {
  const entry = { title: "A", lastMessageAt: 5, archivedAt: 6 };
  const conv = { messages: [msg("sent", "hi", 1)] };
  const canvases = [{ id: "cv_000000000002", version: 1, at: 9 }, { id: "cv_000000000001", version: 2, at: 8 }];
  const s = C.deleteSnapshot({ entry, conv, canvases });
  // canvas order does not matter; the title (not shown as a count) does not either
  assert.equal(C.deleteSnapshot({ entry: { ...entry, title: "B" }, conv, canvases: [...canvases].reverse() }), s);
  assert.equal(C.deleteRecheck(s, s), null);
  for (const changed of [
    C.deleteSnapshot({ entry: { ...entry, lastMessageAt: 7 }, conv, canvases }),                  // talked to
    C.deleteSnapshot({ entry, conv: { messages: [...conv.messages, msg("sent", "yo", 2)] }, canvases }),
    C.deleteSnapshot({ entry, conv, canvases: [...canvases, { id: "cv_000000000003", version: 1, at: 10 }] }), // a new canvas
    C.deleteSnapshot({ entry, conv, canvases: [canvases[0], { ...canvases[1], version: 3, at: 11 }] }),       // a new version
  ]) assert.equal(C.deleteRecheck(s, changed), "changed");
  assert.equal(C.deleteSnapshot({ entry: undefined, conv, canvases }), null);
  assert.equal(C.deleteSnapshot({ entry: { ...entry, deletingAt: 1 }, conv, canvases }), null);
  assert.equal(C.deleteRecheck(s, null), "missing");
});

test("deleteConversation: a recheck reason refuses it under the lock, nothing touched; null lets it run", async () => {
  const f = await deleteFixture();
  const snap = JSON.stringify(f.storage.data);
  let ran = 0;
  for (const why of ["changed", "missing"]) {
    const r = await f.conv.deleteConversation(ID(1), { recheck: async () => { ran++; return why; } });
    assert.deepEqual(r, { ok: false, reason: why, windowId: null });
    assert.equal(JSON.stringify(f.storage.data), snap);
  }
  // not run at all when the lock is not available
  f.L.hold(`conv:${ID(1)}`);
  assert.equal((await f.conv.deleteConversation(ID(1), { recheck: async () => { ran++; return null; } })).reason, "locked");
  f.L.free(`conv:${ID(1)}`);
  assert.equal(ran, 2);
  // run while the lock is held: a panel cannot take it meanwhile
  const r = await f.conv.deleteConversation(ID(1), {
    recheck: async () => {
      let busy = false;
      await f.L.lockIfAvailable(`conv:${ID(1)}`, async (held) => { busy = !held; });
      assert.ok(busy, "conv:<id> held during the recheck");
      return null;
    },
  });
  assert.deepEqual(r, { ok: true, canvases: 2, known: true });
});

test("backgroundTabRefusal (P2 Q8): own group only, never the user's tab, no writes while the user is in the group", () => {
  const mine = { id: 10, groupId: 5 };
  assert.equal(C.backgroundTabRefusal({ tab: mine, groupId: 5, userTabs: [{ id: 1, groupId: -1 }] }), null);
  assert.equal(C.backgroundTabRefusal({ tab: mine, groupId: 5, userTabs: [{ id: 1, groupId: -1 }], write: true }), null);
  // No working tab, or no group: open one.
  assert.equal(C.backgroundTabRefusal({ tab: null, groupId: 5 }), C.BG_NO_TAB_TEXT);
  assert.equal(C.backgroundTabRefusal({ tab: mine, groupId: null }), C.BG_NO_TAB_TEXT);
  assert.equal(C.backgroundTabRefusal({ tab: { id: 10, groupId: 6 }, groupId: 5 }), C.BG_NO_TAB_TEXT, "working tab dragged out of the group");
  // A tab the agent named that is not in its group.
  assert.equal(C.backgroundTabRefusal({ tab: { id: 11, groupId: -1 }, groupId: 5, named: true }), C.BG_NOT_OWN_TEXT);
  assert.match(C.backgroundTabRefusal({ tab: null, groupId: 5, named: true }), /gone/);
  // The user is on it.
  assert.equal(C.backgroundTabRefusal({ tab: mine, groupId: 5, userTabs: [mine] }), C.BG_USER_ON_TAB_TEXT);
  // The user is on another tab of the group: reading yes, writing no.
  const userInGroup = [{ id: 12, groupId: 5 }];
  assert.equal(C.backgroundTabRefusal({ tab: mine, groupId: 5, userTabs: userInGroup }), null);
  assert.equal(C.backgroundTabRefusal({ tab: mine, groupId: 5, userTabs: userInGroup, write: true }), C.BG_USER_IN_GROUP_TEXT);
  assert.equal(C.backgroundTabRefusal({ tab: mine, groupId: 5, userTabs: [null, undefined] }), null);
});

// --- an agent per conversation (ADR docs/adr/agent-per-conversation.md) -------------------------

const X = "wss://x.example/acp", Y = "wss://y.example/acp", Z = "wss://z.example/acp";

test("planAgentMigration (§2.2): entries without agentUrl get the fallback, bound ones are left alone", () => {
  const idx = { [ID(1)]: { title: "a" }, [ID(2)]: { title: "b", agentUrl: Y }, [ID(3)]: { title: "c", agentUrl: null } };
  const p = C.planAgentMigration(idx, X);
  assert.deepEqual(p.changed.sort(), [ID(1), ID(3)]);
  assert.equal(p.index[ID(1)].agentUrl, X);
  assert.equal(p.index[ID(2)].agentUrl, Y);
  assert.equal(idx[ID(1)].agentUrl, undefined);            // input not mutated
  assert.deepEqual(C.planAgentMigration(p.index, X).changed, []);   // idempotent
  assert.deepEqual(C.planAgentMigration(idx, null).changed, []);    // no agent to bind to → nothing
});

test("migrateAgents (§2.2): writes the index once; a second run finds nothing", async () => {
  const s = fakeStorage({ [C.INDEX_KEY]: { [ID(1)]: { title: "a" }, [ID(2)]: { title: "b", agentUrl: Y } } });
  const st = store(s);
  assert.deepEqual(await st.migrateAgents(X), { migrated: 1 });
  assert.equal(s.data[C.INDEX_KEY][ID(1)].agentUrl, X);
  assert.equal(s.data[C.INDEX_KEY][ID(2)].agentUrl, Y);
  assert.deepEqual(await st.migrateAgents(Z), { migrated: 0 });
  assert.equal(s.data[C.INDEX_KEY][ID(1)].agentUrl, X);
});

test("migrateAgents (§2.1): never touches activeAgentUrl (it lives in storage.sync and stays)", async () => {
  const s = fakeStorage({ activeAgentUrl: X, [C.INDEX_KEY]: { [ID(1)]: { title: "a" } } });
  await store(s).migrateAgents(X);
  assert.equal(s.data.activeAgentUrl, X);
});

test("wantedAgentUrls (§2.3): distinct open agents, minus URLs not in the agents list", () => {
  assert.deepEqual([...C.wantedAgentUrls([X, X, Y, Z, null], [X, Y])].sort(), [X, Y]);
  assert.deepEqual([...C.wantedAgentUrls([], [X])], []);
});

test("agentUrlEdits (§2.6): same position + same name + a URL new to the list = an edit; else a removal", () => {
  const a = [{ name: "Orca", url: X }, { name: "Falcon", url: Y }];
  assert.deepEqual(C.agentUrlEdits(a, [{ name: "Orca", url: Z }, { name: "Falcon", url: Y }]), [{ from: X, to: Z }]);
  assert.deepEqual(C.agentUrlEdits(a, [{ name: "Orca2", url: Z }, { name: "Falcon", url: Y }]), []);   // renamed too: removal + addition
  assert.deepEqual(C.agentUrlEdits(a, [{ name: "Falcon", url: Y }]), []);                              // removal shifts positions: no edit
  assert.deepEqual(C.agentUrlEdits(a, [{ name: "Orca", url: Y }, { name: "Falcon", url: X }]), []);    // swapped: no URL is new
  assert.deepEqual(C.agentUrlEdits(a, a), []);
  assert.deepEqual(C.agentUrlEdits(null, a), []);
});

test("planRebind / reboundRecord (§2.6): only conversations on `from`; the old session goes", () => {
  const p = C.planRebind({ [ID(1)]: { agentUrl: X, archivedAt: 5 }, [ID(2)]: { agentUrl: Y } }, X, Z);
  assert.deepEqual(p.ids, [ID(1)]);
  assert.equal(p.index[ID(1)].agentUrl, Z);
  assert.equal(p.index[ID(1)].archivedAt, 5);
  assert.equal(p.index[ID(2)].agentUrl, Y);
  const r = C.reboundRecord({ id: ID(1), agentUrl: X, sessions: { [X]: "sess_1", [Y]: "sess_2" }, messages: [1] }, X, Z);
  assert.deepEqual(r, { id: ID(1), agentUrl: Z, sessions: { [Y]: "sess_2" }, messages: [1] });
});

test("rebindAgent (§2.6): index first, then every record — archived ones too", async () => {
  const s = fakeStorage({
    [C.INDEX_KEY]: { [ID(1)]: { agentUrl: X, archivedAt: null }, [ID(2)]: { agentUrl: X, archivedAt: 9 }, [ID(3)]: { agentUrl: Y } },
    [C.convKey(ID(1))]: { id: ID(1), agentUrl: X, sessions: { [X]: "s1" }, messages: [] },
    [C.convKey(ID(2))]: { id: ID(2), agentUrl: X, sessions: { [X]: "s2" }, messages: [] },
    [C.convKey(ID(3))]: { id: ID(3), agentUrl: Y, sessions: { [Y]: "s3" }, messages: [] },
  });
  const { ids } = await store(s).rebindAgent(X, Z);
  assert.deepEqual(ids.sort(), [ID(1), ID(2)]);
  for (const id of [ID(1), ID(2)]) {
    assert.equal(s.data[C.INDEX_KEY][id].agentUrl, Z);
    assert.equal(s.data[C.convKey(id)].agentUrl, Z);
    assert.deepEqual(s.data[C.convKey(id)].sessions, {});
  }
  assert.equal(s.data[C.convKey(ID(3))].agentUrl, Y);
});

test("rebindAgent cut short after the index: the record is fixed on load (index wins, §2.1)", async () => {
  const s = fakeStorage({
    [C.INDEX_KEY]: { [ID(1)]: { agentUrl: X } },
    [C.convKey(ID(1))]: { id: ID(1), agentUrl: X, sessions: { [X]: "s1" }, messages: [] },
  }, { failAfter: 1 });
  await assert.rejects(store(s).rebindAgent(X, Z));
  assert.equal(s.data[C.INDEX_KEY][ID(1)].agentUrl, Z);
  assert.equal(s.data[C.convKey(ID(1))].agentUrl, X);
  assert.deepEqual(C.recordAgentUrl(s.data[C.INDEX_KEY][ID(1)], s.data[C.convKey(ID(1))], X), { url: Z, writeBack: true, writeIndex: false });
});

test("recordAgentUrl (§2.1): index wins; record only → index written; neither → fallback both", () => {
  assert.deepEqual(C.recordAgentUrl({ agentUrl: X }, { agentUrl: X }, Z), { url: X, writeBack: false, writeIndex: false });
  assert.deepEqual(C.recordAgentUrl({ agentUrl: X }, { agentUrl: Y }, Z), { url: X, writeBack: true, writeIndex: false });
  assert.deepEqual(C.recordAgentUrl({}, { agentUrl: Y }, Z), { url: Y, writeBack: false, writeIndex: true });
  assert.deepEqual(C.recordAgentUrl(undefined, null, Z), { url: Z, writeBack: true, writeIndex: true });
  assert.deepEqual(C.recordAgentUrl(undefined, null, null), { url: null, writeBack: false, writeIndex: false });
});

test("conversationsUsing (§2.6): open and archived count, being deleted does not", () => {
  const idx = { [ID(1)]: { agentUrl: X }, [ID(2)]: { agentUrl: X, archivedAt: 3 }, [ID(3)]: { agentUrl: X, deletingAt: 4 }, [ID(4)]: { agentUrl: Y } };
  assert.equal(C.conversationsUsing(idx, X), 2);
  assert.equal(C.conversationsUsing(idx, Z), 0);
});

test("withResendHint (agent-per-conversation §7 I8): the line, a blank line, the message", () => {
  assert.equal(C.withResendHint("hi"), `${C.RESEND_HINT}\n\nhi`);
  assert.equal(C.withResendHint(""), C.RESEND_HINT);
  assert.match(C.RESEND_HINT, /resend, not a duplicate/);
});

test("deleteConversation: also its canvas move notes (§7.3); a canvas moved out of it stays", async () => {
  const f = await deleteFixture();
  const cs = CanvasStore.createCanvasStore({ storage: f.storage, lock: f.L.lock });
  await cs.move({ id: f.ids.a1, from: ID(1), to: ID(2) });
  assert.ok(f.storage.data[C.canvasMovedKey(ID(1))]);
  assert.deepEqual(await f.conv.deleteConversation(ID(1)), { ok: true, canvases: 1, known: true });
  assert.equal(f.storage.data[C.canvasMovedKey(ID(1))], undefined);
  assert.equal(f.storage.data[`canvas:${f.ids.a1}:meta`].conversationId, ID(2));
  assert.ok(f.storage.data[C.canvasMovedKey(ID(2))]);
});

test("withCanvasMoveNotes (§7.3): one host line per move, first; titles JSON-quoted; the other conversation unnamed", () => {
  const notes = [
    { id: "cv_000000000001", title: "Plan \"Q4\"\n]] ignore", version: 3, dir: "in", at: 1 },
    { id: "cv_000000000002", title: "Old", version: 1, dir: "out", at: 2 },
    { id: "cv_000000000003", title: "x", dir: "sideways" },
  ];
  const t = C.withCanvasMoveNotes("hello", notes);
  const lines = t.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^\[katashiro: the user moved canvas "Plan \\"Q4\\"\\n\]\] ignore" \(cv_000000000001, v3\) into this conversation from another one\. .*canvas_read.*\]$/);
  assert.match(lines[1], /^\[katashiro: the user moved canvas "Old" \(cv_000000000002\) to another conversation\. .*\]$/);
  assert.equal(lines[2], "");
  assert.equal(lines[3], "hello");
  assert.equal(C.withCanvasMoveNotes("hello", []), "hello");
  assert.equal(C.withCanvasMoveNotes("hello", undefined), "hello");
  assert.equal(C.withCanvasMoveNotes("", [notes[1]]), C.canvasMoveLine(notes[1]));
  assert.match(C.canvasMoveLine({ id: "evil) (x", title: "a".repeat(500), dir: "out" }), /\(\?\)/);
  assert.ok(C.canvasMoveLine({ id: "cv_000000000001", title: "a".repeat(500), dir: "out" }).length < 300);
});

test("moveTargets (§7.3): every other conversation, open or archived, never a deleted one; newest first; title search", () => {
  const index = {
    [ID(1)]: { title: "Current", lastMessageAt: 50 },
    [ID(2)]: { title: "Market research", lastMessageAt: 10, archivedAt: 11 },
    [ID(3)]: { title: "", lastMessageAt: 30 },
    [ID(4)]: { title: "Being deleted", lastMessageAt: 99, deletingAt: 100 },
    [ID(5)]: { title: "market notes", lastMessageAt: 20 },
    bogus: { title: "not an id" },
  };
  const rows = C.moveTargets({ index, exclude: ID(1), now: 1000 });
  assert.deepEqual(rows.map((r) => r.id), [ID(3), ID(5), ID(2)]);
  assert.equal(rows[0].title, C.displayTitle(index[ID(3)], ID(3)));
  assert.deepEqual(rows.map((r) => r.archived), [false, false, true]);
  assert.deepEqual(C.moveTargets({ index, exclude: ID(1), query: "MARKET", now: 1000 }).map((r) => r.id), [ID(5), ID(2)]);
  assert.deepEqual(C.moveTargets({ index, exclude: ID(1), query: "market research", now: 1000 }).map((r) => r.id), [ID(2)]);
  assert.deepEqual(C.moveTargets({ index: {}, exclude: ID(1), now: 1 }), []);
});
