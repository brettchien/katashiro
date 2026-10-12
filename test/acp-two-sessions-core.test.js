// Unit tests for scripts/acp-two-sessions-core.cjs — the pure half of the live two-session test
// client (scripts/acp-two-sessions.mjs, multi-conversation ADR §5 "Before starting P2").
const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../scripts/acp-two-sessions-core.cjs");

test("parseArgs: url from flag or env, token only from env, numbers bounded", () => {
  const o = C.parseArgs(["--url", "wss://gw/acp", "--sessions=3", "--timeout", "60", "-v"], { ACP_TOKEN: " t \n" });
  assert.equal(o.url, "wss://gw/acp");
  assert.equal(o.token, "t");
  assert.equal(o.sessions, 3);
  assert.equal(o.timeoutSec, 60);
  assert.equal(o.verbose, true);
  assert.equal(C.parseArgs([], { ACP_URL: "ws://x/acp", ACP_TOKEN: "t" }).url, "ws://x/acp");
  assert.equal(C.parseArgs([], { ACP_URL: "ws://x/acp", ACP_TOKEN: "t" }).sessions, 2);
  assert.throws(() => C.parseArgs(["--token", "t", "--url", "ws://x"], {}), /ACP_TOKEN/);
  assert.throws(() => C.parseArgs(["--url", "ws://x"], {}), /ACP_TOKEN/);
  assert.throws(() => C.parseArgs([], { ACP_TOKEN: "t" }), /--url/);
  assert.throws(() => C.parseArgs(["--url", "https://x"], { ACP_TOKEN: "t" }), /ws:\/\//);
  assert.throws(() => C.parseArgs(["--url", "ws://x", "--sessions", "4"], { ACP_TOKEN: "t" }), C.UsageError);
  assert.throws(() => C.parseArgs(["--url", "ws://x", "--bogus"], { ACP_TOKEN: "t" }), /unknown argument/);
  assert.throws(() => C.parseArgs(["--url", "ws://x", "s3cret"], { ACP_TOKEN: "t" }), (e) => /positional/.test(e.message) && !e.message.includes("s3cret"));
  assert.equal(C.parseArgs(["--help"], {}).help, true);
});

test("labels, server names, and the prompt never carries a nonce", () => {
  assert.deepEqual(C.labels(3), ["A", "B", "C"]);
  assert.equal(C.serverName("B"), "probeB");
  const p = C.buildPrompt("A");
  assert.match(p, /search_capabilities/);
  assert.match(p, /execute_capability/);
  assert.match(p, /NONCE:/);
  assert.equal(C.whoamiText("A", "abc123"), "session=A server=probeA nonce=abc123");
});

test("overlapMs, interleavings, maxInFlight", () => {
  assert.equal(C.overlapMs([0, 10], [5, 20]), 5);
  assert.equal(C.overlapMs([0, 10], [10, 20]), 0);
  assert.equal(C.overlapMs([0, 10], [12, 20]), 0);
  assert.equal(C.overlapMs([0, null], [1, 2]), 0);
  assert.equal(C.interleavings([{ t: 1, label: "A" }, { t: 2, label: "A" }, { t: 3, label: "B" }]), 1);
  assert.equal(C.interleavings([{ t: 3, label: "A" }, { t: 1, label: "A" }, { t: 2, label: "B" }]), 2);
  assert.equal(C.interleavings([]), 0);
  assert.equal(C.maxInFlight([{ start: 0, end: 5 }, { start: 3, end: 8 }]), 2);
  assert.equal(C.maxInFlight([{ start: 0, end: 5 }, { start: 5, end: 8 }]), 1);
  assert.equal(C.maxInFlight([{ start: 0, end: null }, { start: 9, end: 10 }]), 2);
});

test("classifyError: -32001 busy, pool exhausted (raw or as relayed reply text)", () => {
  assert.equal(C.classifyError({ code: -32001, message: "Session busy: a prompt is already in progress" }), "busy");
  assert.equal(C.classifyError({ code: -32603, message: "pool exhausted (3 sessions)" }), "pool");
  assert.equal(C.classifyError("**Service Busy**\nAll agent sessions are in use, please try again shortly."), "pool");
  assert.equal(C.classifyError({ code: -32603, message: "Internal error" }), null);
  assert.equal(C.classifyError(""), null);
  assert.equal(C.classifyError(null), null);
});

function sess(label, over = {}) {
  return {
    label, nonce: `n${label}`, created: true, createError: null, tunnelUp: true,
    calls: [{ start: 2, end: 12, name: "whoami" }], sentAt: 0, doneAt: 20, stopReason: "end_turn", error: null,
    replyText: `CAPS: probe${label}.whoami\nNONCE: n${label}\n1. sea`, activity: [2, 15], updates: [15],
    ...over,
  };
}
const cell = (v, name, col = 1) => v.rows.find((r) => r[0] === name)[col];

test("evaluate: two concurrent, well-behaved sessions PASS", () => {
  const v = C.evaluate([sess("A"), sess("B", { calls: [{ start: 3, end: 13, name: "whoami" }], activity: [3, 18], doneAt: 25 })]);
  assert.equal(v.pass, true);
  assert.equal(v.info[0][1], "2");                       // both whoami calls held at the same time
});

test("evaluate: serialised turns FAIL the concurrency row", () => {
  const a = sess("A", { doneAt: 20 });
  const b = sess("B", { calls: [{ start: 21, end: 31, name: "whoami" }], activity: [21, 35], doneAt: 40 });
  const v = C.evaluate([a, b]);
  assert.equal(v.pass, false);
  assert.equal(cell(v, "turns overlap in time"), "PASS");          // B was SENT early…
  assert.equal(cell(v, "later turn active before first ended"), "FAIL"); // …but did nothing until A ended
});

test("evaluate: a crossed-over nonce FAILs both nonce rows", () => {
  const v = C.evaluate([sess("A", { replyText: "NONCE: nB" }), sess("B")]);
  assert.equal(v.pass, false);
  assert.equal(cell(v, "reply has own nonce"), "FAIL");
  assert.equal(cell(v, "no other session's nonce"), "FAIL");
  assert.equal(cell(v, "no other session's nonce", 2), "PASS");
});

test("evaluate: busy / pool exhausted / no tool call / stray calls / timeout", () => {
  const pool = C.evaluate([sess("A"), sess("B", { error: { code: -32603, message: "pool exhausted (3 sessions)" }, stopReason: null, calls: [], replyText: "" })]);
  assert.equal(pool.pass, false);
  assert.equal(cell(pool, "no busy / pool exhausted", 2), "FAIL");
  assert.equal(cell(pool, "whoami called on own server", 2), "FAIL");
  assert.equal(cell(pool, "calls inside own turn", 2), "-");
  const late = C.evaluate([sess("A", { calls: [{ start: 25, end: 30, name: "whoami" }] }), sess("B")]);
  assert.equal(cell(late, "calls inside own turn"), "FAIL");
  assert.equal(C.evaluate([sess("A"), sess("B")], { strayCalls: 1 }).pass, false);
  assert.equal(C.evaluate([sess("A"), sess("B")], { timedOut: true }).pass, false);
});

test("evaluate: isolation (CAPS), wrong tool name, pre-prompt activity", () => {
  const leak = C.evaluate([sess("A", { replyText: "CAPS: probeA.whoami, probeB.whoami\nNONCE: nA" }), sess("B")]);
  assert.equal(leak.pass, false);
  assert.equal(cell(leak, "CAPS lists no other session's server"), "FAIL");
  assert.equal(cell(leak, "CAPS lists no other session's server", 2), "PASS");
  assert.equal(cell(C.evaluate([sess("A", { replyText: "NONCE: nA" }), sess("B")]), "CAPS lists no other session's server"), "FAIL");
  assert.equal(C.capsLine("x\n  caps: a, b \nNONCE: 1"), "a, b");
  for (const r of ["**CAPS:** a", "- CAPS: a", "`CAPS: a", "> CAPS: a", "**CAPS**: a"]) assert.match(C.capsLine(r), /^a/, r);
  assert.equal(C.capsLine("NOCAPS: a"), null);
  const wrong = C.evaluate([sess("A", { calls: [{ start: 2, end: 12, name: "other" }] }), sess("B")]);
  assert.equal(cell(wrong, "whoami called on own server"), "FAIL");
  // B's only "early" activity came before its prompt was sent: that is not the turn running.
  const a = sess("A", { doneAt: 20 });
  const b = sess("B", { sentAt: 5, calls: [{ start: 21, end: 31, name: "whoami" }], activity: [1, 21, 35], doneAt: 40 });
  assert.equal(cell(C.evaluate([a, b]), "later turn active before first ended"), "FAIL");
});

test("renderTable: fixed width, ─ divider, CJK counted as 2", () => {
  const t = C.renderTable(["check", "A"], [["session/new", "PASS"], ["中文", "FAIL"]]);
  assert.equal(t, [
    "check       A",
    "─────────── ────",
    "session/new PASS",
    "中文        FAIL",
  ].join("\n"));
  assert.equal(C.width("中a"), 3);
});
