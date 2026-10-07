// agent-tools.test.js — the gateway-forwarded tool_call / tool_call_update → pill mapping.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const AgentTools = require("../agent-tools.js");

const apply = AgentTools.applyToolCallUpdate;

test("a tool_call opens a running pill with the title as label and tooltip", () => {
  const p = apply(null, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Terminal", status: "pending" });
  assert.deepEqual(p, { id: "t1", title: "Terminal", label: "Terminal", state: "running", icon: "⏳" });
});

test("status maps pending/in_progress → ⏳, completed → ✓, failed → ✗", () => {
  for (const [status, state, icon] of [
    ["pending", "running", "⏳"],
    ["in_progress", "running", "⏳"],
    ["completed", "done", "✓"],
    ["failed", "error", "✗"]
  ]) {
    const p = apply(null, { sessionUpdate: "tool_call", toolCallId: "t", title: "x", status });
    assert.equal(p.state, state, status);
    assert.equal(p.icon, icon, status);
  }
});

test("a tool_call without status starts running", () => {
  assert.equal(apply(null, { sessionUpdate: "tool_call", toolCallId: "t", title: "Edit" }).state, "running");
});

test("an update refines the placeholder title on the SAME id, keeping state when status is absent", () => {
  const first = apply(null, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Terminal", status: "in_progress" });
  const refined = apply(first, { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "cargo test" });
  assert.deepEqual(refined, { id: "t1", title: "cargo test", label: "cargo test", state: "running", icon: "⏳" });
  const done = apply(refined, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
  assert.equal(done.title, "cargo test", "a title-less update keeps the refined title");
  assert.equal(done.state, "done");
});

test("long titles are truncated to 40 chars for the pill label, full in the tooltip", () => {
  const title = "cargo test --workspace --all-features -- --nocapture some::deep::path";
  const p = apply(null, { sessionUpdate: "tool_call", toolCallId: "t", title });
  assert.equal(p.title, title);
  assert.equal(p.label.length, AgentTools.LABEL_MAX);
  assert.ok(p.label.endsWith("…"));
  assert.ok(title.startsWith(p.label.slice(0, -1)));
});

test("whitespace/newlines in titles collapse to one line", () => {
  const p = apply(null, { sessionUpdate: "tool_call", toolCallId: "t", title: "  echo a\n  && echo b  " });
  assert.equal(p.title, "echo a && echo b");
});

test("an update for an unknown id with no title is ignored", () => {
  assert.equal(apply(null, { sessionUpdate: "tool_call_update", toolCallId: "ghost", status: "completed" }), null);
});

test("an update for an unknown id that carries a title still renders", () => {
  const p = apply(null, { sessionUpdate: "tool_call_update", toolCallId: "late", title: "Read file", status: "completed" });
  assert.equal(p.state, "done");
  assert.equal(p.label, "Read file");
});

test("non-tool updates, missing ids and garbage are ignored", () => {
  assert.equal(apply(null, { sessionUpdate: "agent_message_chunk", content: { text: "hi" } }), null);
  assert.equal(apply(null, { sessionUpdate: "tool_call", title: "x" }), null);
  assert.equal(apply(null, { sessionUpdate: "tool_call", toolCallId: 7, title: "x" }), null);
  assert.equal(apply(null, null), null);
  assert.equal(apply(null, undefined), null);
});

test("an unknown status keeps the previous state; a fresh call with no title gets a generic label", () => {
  const p = apply(null, { sessionUpdate: "tool_call", toolCallId: "t", status: "weird" });
  assert.equal(p.state, "running");
  assert.equal(p.label, "tool");
  const q = apply({ ...p, state: "done" }, { sessionUpdate: "tool_call_update", toolCallId: "t", status: "weird" });
  assert.equal(q.state, "done");
});
