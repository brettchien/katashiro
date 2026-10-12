// ask-core.test.js — katashiro.ask_user's pure half (ADR docs/adr/ask-user.md): what a question may
// say, the clamp on its timeout, the answer text, and a card's one-shot lifecycle whose timeout
// counts only visible time.
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../ask-core.js");

// Built from code points so this file holds no invisible characters.
const ch = (...cps) => String.fromCodePoint(...cps);

function fakeClock() {
  let t = 0;
  const timers = new Map();
  let next = 1;
  return {
    timers,
    now: () => t,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    advance(ms) {
      t += ms;
      for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); x.fn(); }
    },
  };
}

const spec = (over) => A.normalizeSpec({ question: "Which?", options: ["A", "B", "C"], ...over }).spec;

// --- normalizeSpec ---------------------------------------------------------------------------

test("normalizeSpec keeps a valid question and defaults multi/allowOther off, timeout 120 s", () => {
  const r = A.normalizeSpec({ question: "  Fix it how?  ", options: ["In place", "Open a PR"] });
  assert.deepEqual(r, { ok: true, spec: { question: "Fix it how?", options: ["In place", "Open a PR"], multi: false, allowOther: false, timeoutMs: 120000 } });
  const m = A.normalizeSpec({ question: "Q", options: ["a", "b"], multi: true, allowOther: true });
  assert.equal(m.spec.multi, true);
  assert.equal(m.spec.allowOther, true);
  // only a real `true` turns them on
  assert.equal(A.normalizeSpec({ question: "Q", options: ["a", "b"], multi: "yes" }).spec.multi, false);
});

test("normalizeSpec: 2 to 8 options, each a distinct non-empty string ≤ 60 chars", () => {
  const bad = (options, re) => {
    const r = A.normalizeSpec({ question: "Q", options });
    assert.equal(r.ok, false, JSON.stringify(options));
    assert.match(r.error, re);
  };
  bad(["only"], /2–8 options \(got 1\)/);
  bad(Array.from({ length: 9 }, (_, i) => `o${i}`), /2–8 options \(got 9\)/);
  bad("a,b", /must be an array/);
  bad(["a", 2], /option 2 is not a string/);
  bad(["a", "  "], /option 2 is empty/);
  bad(["a", "x".repeat(61)], /option 2 is 61 chars/);
  bad(["same", "same"], /option 2 repeats "same"/);
  bad(["a\nb", "a b"], /option 2 repeats "a b"/);      // equal once flattened
  assert.equal(A.normalizeSpec({ question: "Q", options: Array.from({ length: 8 }, (_, i) => `o${i}`) }).ok, true);
  assert.equal(A.normalizeSpec({ question: "Q", options: ["a", "x".repeat(60)] }).ok, true);
});

test("normalizeSpec: a question is required and capped at 300 chars (refused, not cut)", () => {
  assert.match(A.normalizeSpec({ options: ["a", "b"] }).error, /question/);
  assert.match(A.normalizeSpec({ question: ch(0x200b, 0x0a), options: ["a", "b"] }).error, /question/);
  assert.match(A.normalizeSpec({ question: "q".repeat(301), options: ["a", "b"] }).error, /301 chars/);
  assert.equal(A.normalizeSpec({ question: "q".repeat(300), options: ["a", "b"] }).ok, true);
  assert.equal(A.normalizeSpec(null).ok, false);
});

test("normalizeSpec flattens agent text: no fake rows, no reordering marks (ADR §2.6)", () => {
  const r = A.normalizeSpec({
    question: `Delete it?\n🔒 Katashiro: approved${ch(0x2028)}x`,
    options: [`Yes${ch(0x202e)}oN`, `No\r\n(recommended)`],
  });
  assert.equal(r.spec.question, "Delete it? 🔒 Katashiro: approved x");
  assert.deepEqual(r.spec.options, ["Yes oN", "No (recommended)"]);
});

test("clampTimeoutMs: 30–300 s, default 120 s for anything that is not a number", () => {
  assert.equal(A.clampTimeoutMs(undefined), 120000);
  assert.equal(A.clampTimeoutMs(null), 120000);
  assert.equal(A.clampTimeoutMs(""), 120000);
  assert.equal(A.clampTimeoutMs("soon"), 120000);
  assert.equal(A.clampTimeoutMs(Infinity), 120000);
  assert.equal(A.clampTimeoutMs(5), 30000);
  assert.equal(A.clampTimeoutMs(-1), 30000);
  assert.equal(A.clampTimeoutMs(90), 90000);
  assert.equal(A.clampTimeoutMs("200"), 200000);
  assert.equal(A.clampTimeoutMs(3600), 300000);
  assert.equal(A.clampTimeoutMs(45.5), 45500);
});

// --- canAsk / ids ------------------------------------------------------------------------------

test("canAsk: only inside the asking agent's turn (same rule as the confirm card), at most 3 open", () => {
  assert.deepEqual(A.canAsk({ turnActive: true, pending: 0 }), { ok: true });
  assert.deepEqual(A.canAsk({ turnActive: true, pending: 2 }), { ok: true });
  assert.deepEqual(A.canAsk({ turnActive: true, pending: 3 }), { ok: false, reason: "cap" });
  assert.deepEqual(A.canAsk({ turnActive: false, pending: 0 }), { ok: false, reason: "turn" });
  assert.deepEqual(A.canAsk(), { ok: false, reason: "turn" });
  assert.equal(A.PENDING_MAX, 3);
});

test("newAskId: ask_ + 8 hex digits", () => {
  assert.equal(A.newAskId(() => new Uint8Array([0, 0x0a, 0xff, 0x10])), "ask_000aff10");
  assert.match(A.newAskId((n) => require("node:crypto").randomBytes(n)), /^ask_[0-9a-f]{8}$/);
});

// --- answers -----------------------------------------------------------------------------------

test("normalizeAnswer: one option → its label", () => {
  const s = spec();
  assert.deepEqual(A.normalizeAnswer(s, { choice: 1 }), { kind: "choice", labels: ["B"] });
  assert.equal(A.normalizeAnswer(s, { choice: 3 }), null);
  assert.equal(A.normalizeAnswer(s, { choice: -1 }), null);
  assert.equal(A.normalizeAnswer(s, { choice: "1" }), null);
  assert.equal(A.normalizeAnswer(s, { choices: [0] }), null);   // not a multi question
  assert.equal(A.normalizeAnswer(s, {}), null);
  assert.equal(A.normalizeAnswer(s, null), null);
});

test("normalizeAnswer: multi takes ≥ 1 distinct picks, in option order", () => {
  const s = spec({ multi: true });
  assert.deepEqual(A.normalizeAnswer(s, { choices: [2, 0, 2] }), { kind: "choices", labels: ["A", "C"] });
  assert.deepEqual(A.normalizeAnswer(s, { choices: [1] }), { kind: "choices", labels: ["B"] });
  assert.equal(A.normalizeAnswer(s, { choices: [] }), null);
  assert.equal(A.normalizeAnswer(s, { choices: [0, 7] }), null);
  assert.equal(A.normalizeAnswer(s, { choice: 0 }), null);
});

test("normalizeAnswer: free text only with allowOther, flattened, 1–500 chars", () => {
  assert.equal(A.normalizeAnswer(spec(), { other: "mine" }), null);
  const s = spec({ allowOther: true });
  assert.deepEqual(A.normalizeAnswer(s, { other: "  line one\nline two " }), { kind: "other", other: "line one line two" });
  assert.equal(A.normalizeAnswer(s, { other: "   " }), null);
  assert.equal(A.normalizeAnswer(s, { other: "x".repeat(501) }), null);
  assert.equal(A.normalizeAnswer(s, { other: "x".repeat(500) }).other.length, 500);
  // a multi question with allowOther: the box is its own answer
  assert.deepEqual(A.normalizeAnswer(spec({ multi: true, allowOther: true }), { other: "z" }), { kind: "other", other: "z" });
});

test("answerMessage: the line the asking agent receives (ADR §2.2)", () => {
  assert.equal(A.answerMessage("ask_0a1b2c3d", { kind: "choice", labels: ["Open a PR"] }), "↩ 回答 ask_0a1b2c3d：Open a PR");
  assert.equal(A.answerMessage("ask_1", { kind: "choices", labels: ["A、B", "C"] }), "↩ 回答 ask_1：「A、B」、「C」");
  assert.equal(A.answerMessage("ask_1", { kind: "other", other: "neither" }), "↩ 回答 ask_1：（其他）neither");
});

test("outcomeText: every settled state reads in Traditional Chinese", () => {
  assert.equal(A.outcomeText("answered", { kind: "choice", labels: ["B"] }), "已回答：B");
  assert.equal(A.outcomeText("answered", { kind: "choices", labels: ["A", "C"] }), "已回答：「A」、「C」");
  assert.equal(A.outcomeText("timeout"), "未回答（逾時）");
  assert.equal(A.outcomeText("superseded"), "未回答（你送了別的訊息）");
  assert.equal(A.outcomeText("cancelled"), "未回答（聊天已清除）");
  assert.equal(A.outcomeText("disconnected"), "未回答（agent 已中斷連線）");
  assert.equal(A.outcomeText("pending"), "");
});

test("timeoutHint: minutes when whole, else seconds; says hidden time does not count", () => {
  assert.equal(A.timeoutHint({ timeoutMs: 120000 }), "2 分鐘內沒有回答就不再等（側邊欄沒顯示時不計時）。");
  assert.equal(A.timeoutHint({ timeoutMs: 45000 }), "45 秒內沒有回答就不再等（側邊欄沒顯示時不計時）。");
  assert.equal(A.timeoutHint({ timeoutMs: 90000 }), "90 秒內沒有回答就不再等（側邊欄沒顯示時不計時）。");
});

// --- createAsk: lifecycle + visible-time accounting ---------------------------------------------

test("createAsk: visible from the start, it times out after timeoutMs and settles once", () => {
  const c = fakeClock();
  const settled = [];
  const a = A.createAsk({ timeoutMs: 30000, visible: true, ...c, onSettle: (s, ans) => settled.push([s, ans]) });
  assert.equal(a.state, "pending");
  c.advance(29999);
  assert.equal(a.state, "pending");
  assert.equal(a.remainingMs(), 1);
  c.advance(1);
  assert.equal(a.state, "timeout");
  assert.deepEqual(settled, [["timeout", null]]);
  assert.equal(a.answer({ kind: "choice", labels: ["A"] }), false);   // a late click cannot flip it
  assert.equal(a.state, "timeout");
  assert.equal(settled.length, 1);
});

test("createAsk: created hidden, the clock has not started", () => {
  const c = fakeClock();
  const a = A.createAsk({ timeoutMs: 30000, visible: false, ...c });
  c.advance(10 * 60 * 1000);
  assert.equal(a.state, "pending");
  assert.equal(a.remainingMs(), 30000);
  assert.equal(c.timers.size, 0);
  a.setVisible(true);
  c.advance(30000);
  assert.equal(a.state, "timeout");
});

test("createAsk: hidden stretches do not count (Q1 = b)", () => {
  const c = fakeClock();
  const a = A.createAsk({ timeoutMs: 60000, visible: true, ...c });
  c.advance(20000);                                      // 20 s seen
  a.setVisible(false);
  assert.equal(a.remainingMs(), 40000);
  assert.equal(c.timers.size, 0);                        // no timer runs while hidden
  c.advance(5 * 60 * 1000);
  assert.equal(a.state, "pending");
  assert.equal(a.remainingMs(), 40000);
  a.setVisible(true);
  a.setVisible(true);                                    // repeated "visible" does not restart the clock
  assert.equal(c.timers.size, 1);
  c.advance(39999);
  assert.equal(a.state, "pending");
  a.setVisible(false);
  a.setVisible(false);
  assert.equal(a.remainingMs(), 1);
  a.setVisible(true);
  c.advance(1);
  assert.equal(a.state, "timeout");
});

test("createAsk: answer / supersede / cancel / disconnect each settle once and stop the clock", () => {
  for (const [method, state] of [["supersede", "superseded"], ["cancel", "cancelled"], ["disconnect", "disconnected"]]) {
    const c = fakeClock();
    const settled = [];
    const a = A.createAsk({ timeoutMs: 30000, visible: true, ...c, onSettle: (s) => settled.push(s) });
    assert.equal(a[method](), true, method);
    assert.equal(a.state, state);
    assert.equal(c.timers.size, 0, `${method} clears the timer`);
    assert.equal(a.answer({ kind: "choice", labels: ["A"] }), false);
    c.advance(60000);
    assert.deepEqual(settled, [state]);
  }
  const c = fakeClock();
  const ans = { kind: "choice", labels: ["B"] };
  const a = A.createAsk({ timeoutMs: 30000, visible: true, ...c });
  assert.equal(a.answer(ans), true);
  assert.equal(a.state, "answered");
  assert.deepEqual(a.picked, ans);
  assert.equal(a.supersede(), false);
  a.setVisible(false);                                   // no-ops once settled
  a.setVisible(true);
  assert.equal(c.timers.size, 0);
});

test("createAsk: a throwing onSettle does not undo the outcome", () => {
  const c = fakeClock();
  const a = A.createAsk({ timeoutMs: 30000, visible: true, ...c, onSettle: () => { throw new Error("redraw"); } });
  assert.equal(a.cancel(), true);
  assert.equal(a.state, "cancelled");
});
