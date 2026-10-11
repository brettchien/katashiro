// confirm-core.test.js — the confirm card's text rules and one-shot decision (#80): agent text
// cannot add lines to the card, 2 minutes without an answer declines, the first decision wins.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../confirm-core.js");

// Built from code points so this file holds no invisible characters.
const ch = (...cps) => String.fromCodePoint(...cps);

function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    timers,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    fire() { for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); } },
  };
}

test("plainText: newlines and control characters become spaces (no spoofed lines)", () => {
  assert.equal(C.plainText("Plan\n(temp file, safe to delete)"), "Plan (temp file, safe to delete)");
  assert.equal(C.plainText("a\r\n\tb"), "a b");
  assert.equal(C.plainText(`a${ch(0)}b${ch(0x1b)}[31mc${ch(0x7f)}d${ch(0x85)}e`), "a b [31mc d e");
  assert.equal(C.plainText(`x${ch(0x2028)}y${ch(0x2029)}z`), "x y z");
  // bidi overrides / isolates / marks would reorder what the user reads
  assert.equal(C.plainText(`a${ch(0x202e)}gpj.exe${ch(0x202c)}b`), "a gpj.exe b");
  assert.equal(C.plainText(`a${ch(0x2066)}b${ch(0x2069)}${ch(0x200f)}c`), "a b c");
  assert.equal(C.plainText(`a${ch(0x061c)}b${ch(0x200b)}c${ch(0xfeff)}d`), "a b c d");   // ALM, ZWSP, BOM
  assert.equal(C.plainText("  many    spaces  "), "many spaces");
  assert.equal(C.plainText(null), "");
  assert.equal(C.plainText(42), "42");
  // emoji (incl. ZWJ sequences) and CJK are kept
  assert.equal(C.plainText(`畫布 🗑 ${ch(0x1f468, 0x200d, 0x1f4bb)}`), `畫布 🗑 ${ch(0x1f468, 0x200d, 0x1f4bb)}`);
});

test("plainText cuts long text with an ellipsis", () => {
  assert.equal(C.plainText("abcdef", 4), "abc…");
  assert.equal(C.plainText("abcd", 4), "abcd");
  assert.equal(C.plainText("x".repeat(500)).length, C.LINE_MAX);
});

test("normalizeSpec: defaults, flattened lines, clamped timeout", () => {
  const d = C.normalizeSpec();
  assert.deepEqual(d, { title: "確認", lines: [], allowLabel: "允許", denyLabel: "拒絕", allowDefault: true, denyDefault: true, timeoutMs: C.TIMEOUT_MS });
  assert.equal(C.TIMEOUT_MS, 120000);
  const s = C.normalizeSpec({ title: "刪除「a\nb」", lines: ["one\ntwo", "", null, "three"], allowLabel: "是", denyLabel: "否", timeoutMs: 5000 });
  assert.equal(s.title, "刪除「a b」");
  assert.deepEqual(s.lines, ["one two", "three"]);          // a line stays one line; empty ones dropped
  assert.equal(s.allowLabel, "是");
  assert.equal(s.timeoutMs, 5000);
  assert.equal(C.normalizeSpec({ timeoutMs: 10 * 60 * 1000 }).timeoutMs, C.TIMEOUT_MS); // never longer than 2 min
  assert.equal(C.normalizeSpec({ timeoutMs: -1 }).timeoutMs, C.TIMEOUT_MS);
  assert.equal(C.normalizeSpec({ lines: Array(50).fill("x") }).lines.length, C.LINES_MAX);
});

test("outcomeText: what a decided card says", () => {
  const s = C.normalizeSpec();
  assert.equal(C.outcomeText("allowed", s), "已允許");
  assert.equal(C.outcomeText("denied", s), "已拒絕");
  assert.equal(C.outcomeText("timeout", s), "已拒絕（逾時）");
  assert.equal(C.outcomeText("cancelled", s), "已拒絕（聊天已清除）");
  assert.equal(C.outcomeText("ended", s), "已拒絕（回合已結束）");
  assert.equal(C.outcomeText("allowed", C.normalizeSpec({ allowLabel: "是" })), "已選擇：是");
  // a flag, not a string compare: a caller that passes the default label explicitly is still a choice
  assert.equal(C.outcomeText("denied", C.normalizeSpec({ denyLabel: "拒絕" })), "已選擇：拒絕");
  assert.equal(C.outcomeText("pending", s), "");
});

test("createDecision: allow resolves true, deny false; the first decision wins", async () => {
  const t = fakeTimers();
  const seen = [];
  const a = C.createDecision({ timeoutMs: 1000, setTimer: t.setTimer, clearTimer: t.clearTimer, onSettle: (st) => seen.push(st) });
  assert.equal(a.state, "pending");
  assert.equal(t.timers.size, 1);
  assert.equal([...t.timers.values()][0].ms, 1000);
  assert.equal(a.allow(), true);
  assert.equal(a.deny(), false);                            // too late: no flip
  a.cancel();
  assert.equal(await a.promise, true);
  assert.equal(a.state, "allowed");
  assert.deepEqual(seen, ["allowed"]);                      // onSettle once
  assert.equal(t.timers.size, 0);                           // timer cleared

  const b = C.createDecision({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  b.deny();
  assert.equal(await b.promise, false);
  assert.equal(b.state, "denied");
});

test("createDecision: no answer before the timeout = declined; a late click changes nothing", async () => {
  const t = fakeTimers();
  const d = C.createDecision({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  assert.equal([...t.timers.values()][0].ms, C.TIMEOUT_MS);
  t.fire();
  assert.equal(d.state, "timeout");
  assert.equal(d.allow(), false);
  assert.equal(await d.promise, false);
});

test("createDecision: cancel (chat cleared) declines; pending decisions are independent", async () => {
  const t = fakeTimers();
  const x = C.createDecision({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  const y = C.createDecision({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  y.allow();
  x.cancel();
  assert.equal(await x.promise, false);
  assert.equal(x.state, "cancelled");
  assert.equal(await y.promise, true);
});

test("createDecision: a throwing onSettle does not stop the decision", async () => {
  const t = fakeTimers();
  const d = C.createDecision({ setTimer: t.setTimer, clearTimer: t.clearTimer, onSettle: () => { throw new Error("redraw"); } });
  d.allow();
  assert.equal(await d.promise, true);
});

test("createDecision with real timers settles on its own", async () => {
  const d = C.createDecision({ timeoutMs: 5 });
  assert.equal(await d.promise, false);
  assert.equal(d.state, "timeout");
});

test("timeoutHint: whole minutes only when the timeout is whole minutes", () => {
  assert.equal(C.timeoutHint(C.normalizeSpec()), "2 分鐘內沒有回答視為拒絕。");
  assert.equal(C.timeoutHint(C.normalizeSpec({ timeoutMs: 90000 })), "90 秒內沒有回答視為拒絕。");
  assert.equal(C.timeoutHint(C.normalizeSpec({ timeoutMs: 1500, denyLabel: "否" })), "2 秒內沒有回答視為否。");
});

test("createDecision: end() (the asking turn ended) declines; outcome tells it from a no", async () => {
  const t = fakeTimers();
  const seen = [];
  const d = C.createDecision({ setTimer: t.setTimer, clearTimer: t.clearTimer, onSettle: (st) => seen.push(st) });
  assert.equal(d.end(), true);
  assert.equal(d.state, "ended");
  assert.equal(t.timers.size, 0);
  assert.equal(d.allow(), false);                           // a late yes after the turn ended does nothing
  assert.deepEqual(seen, ["ended"]);
  assert.equal(await d.promise, false);
  assert.deepEqual(await d.outcome, { ok: false, state: "ended" });
  const n = C.createDecision({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  n.deny();
  assert.deepEqual(await n.outcome, { ok: false, state: "denied" });
  const y = C.createDecision({ setTimer: t.setTimer, clearTimer: t.clearTimer });
  t.fire();
  assert.deepEqual(await y.outcome, { ok: false, state: "timeout" });
});
