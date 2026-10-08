// agent-tools.test.js — the gateway-forwarded tool_call / tool_call_update → pill mapping.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const AgentTools = require("../agent-tools.js");

const apply = AgentTools.applyToolCallUpdate;

test("a tool_call opens a running pill with the title as label and tooltip", () => {
  // The OpenAB gateway's shape since openab#6: title is the tool identity, never the command.
  const p = apply(null, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Bash", kind: "execute", name: "Bash", status: "pending" });
  assert.deepEqual(p, { id: "t1", title: "Bash", label: "Bash", labelRank: 3, state: "running", icon: "⏳" });
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

test("an update on the SAME id upgrades a kind-only label, keeping state when status is absent", () => {
  // First event often has only the kind (core's title falls back to it); the name arrives later.
  const first = apply(null, { sessionUpdate: "tool_call", toolCallId: "t1", title: "execute", kind: "execute", status: "in_progress" });
  assert.equal(first.label, "execute");
  const refined = apply(first, { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Bash", name: "Bash" });
  assert.deepEqual(refined, { id: "t1", title: "Bash", label: "Bash", labelRank: 3, state: "running", icon: "⏳" });
  const done = apply(refined, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
  assert.equal(done.title, "Bash", "a title-less update keeps the title");
  assert.equal(done.label, "Bash");
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

// --- review fixes (#41: Mira / Jellyfish) -------------------------------------------

test("katashiro's own browser tools are skipped — the browser pill already shows them", () => {
  for (const title of ["mcp__katashiro__katashiro_click", "mcp__openab-katashiro__snapshot", "katashiro.fill_form"]) {
    assert.equal(apply(null, { sessionUpdate: "tool_call", toolCallId: "k", title }), null, title);
  }
  const viaMeta = { sessionUpdate: "tool_call", toolCallId: "k", title: "Tool", _meta: { claudeCode: { toolName: "mcp__katashiro__click" } } };
  assert.equal(apply(null, viaMeta), null);
  assert.equal(AgentTools.isBrowserToolCall({ title: "katashiro.click" }), true);
});

test("a Bash command that merely mentions katashiro still gets its pill", () => {
  for (const title of ["cd katashiro && node --test", "grep -rn katashiro.click .", "mcp__github__get_pr"]) {
    assert.ok(apply(null, { sessionUpdate: "tool_call", toolCallId: "b", title }), title);
  }
});

test("the tooltip title is capped (a heredoc command can be kilobytes)", () => {
  const p = apply(null, { sessionUpdate: "tool_call", toolCallId: "t", title: "x".repeat(5000) });
  assert.equal(Array.from(p.title).length, AgentTools.TITLE_MAX);
  assert.ok(p.title.endsWith("…"));
});

test("labels are cut by code point, never splitting an emoji into a lone surrogate", () => {
  const title = "a".repeat(AgentTools.LABEL_MAX - 2) + "😀😀😀";
  const p = apply(null, { sessionUpdate: "tool_call", toolCallId: "e", title });
  assert.equal(p.label, "a".repeat(AgentTools.LABEL_MAX - 2) + "😀…");
  assert.doesNotMatch(p.label, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test("a stopped state has its own icon for pills a turn left unresolved", () => {
  assert.equal(AgentTools.ICON_OF.stopped, "⏹");
});

test("via the OAB MCP Facade: execute_capability with a katashiro.* rawInput.name is skipped", () => {
  const facade = { sessionUpdate: "tool_call", toolCallId: "f", title: "mcp__oab__execute_capability",
    rawInput: { name: "katashiro.click", arguments: { ref: "e1", snapshotId: 2 } } };
  assert.equal(AgentTools.isBrowserToolCall(facade), true);
  assert.equal(apply(null, facade), null);
  // another capability through the same facade still gets its pill
  const other = { ...facade, toolCallId: "g", rawInput: { name: "github.get_pr", arguments: {} } };
  assert.ok(apply(null, other));
});

test("a skipped call stays skipped when later updates carry only a title / status", () => {
  const skipped = new Set();
  const first = { sessionUpdate: "tool_call", toolCallId: "f", title: "mcp__oab__execute_capability",
    rawInput: { name: "katashiro.snapshot", arguments: {} } };
  assert.equal(apply(null, first, skipped), null);
  assert.ok(skipped.has("f"));
  assert.equal(apply(null, { sessionUpdate: "tool_call_update", toolCallId: "f", title: "mcp__oab__execute_capability", status: "completed" }, skipped), null);
  // an unrelated call in the same turn is unaffected
  assert.ok(apply(null, { sessionUpdate: "tool_call", toolCallId: "b", title: "cargo test" }, skipped));
});

test("pill labels: capability > name > title > kind > \"tool\"", () => {
  const p = (u) => apply(null, { sessionUpdate: "tool_call", toolCallId: "x", ...u });
  assert.equal(p({ title: "mcp__oab__execute_capability", name: "mcp__oab__execute_capability", _meta: { openab: { capability: "github.list_prs" } } }).label, "github.list_prs");
  assert.equal(p({ title: "Edit", name: "Edit", kind: "edit" }).label, "Edit");
  assert.equal(p({ title: "Read", kind: "read" }).label, "Read");
  assert.equal(p({ kind: "fetch", title: "tool" }).label, "fetch");
  const generic = p({ title: "tool" });
  assert.deepEqual([generic.label, generic.labelRank], ["tool", 0]);
});

test("pill labels: an MCP name mcp__server__tool shows as \"server · tool\"", () => {
  const a = apply(null, { sessionUpdate: "tool_call", toolCallId: "m1", title: "mcp__oab__search_capabilities", name: "mcp__oab__search_capabilities" });
  assert.equal(a.label, "oab · search_capabilities");
  assert.equal(a.title, "mcp__oab__search_capabilities");                // full name stays in the tooltip
  const b = apply(null, { sessionUpdate: "tool_call", toolCallId: "m2", title: "mcp__context7__get-library-docs" });
  assert.equal(b.label, "context7 · get-library-docs");
  assert.equal(AgentTools.mcpLabel("mcp__a__b__c"), "a · b__c");          // first __ splits server from tool
  assert.equal(AgentTools.mcpLabel("Read"), "");
});

test("pill labels: a less specific later update never downgrades the label", () => {
  const a = apply(null, { sessionUpdate: "tool_call", toolCallId: "d1", title: "Bash", name: "Bash", kind: "execute" });
  const b = apply(a, { sessionUpdate: "tool_call_update", toolCallId: "d1", kind: "execute", status: "completed" });
  assert.deepEqual([b.label, b.state], ["Bash", "done"]);
  const c = apply(a, { sessionUpdate: "tool_call_update", toolCallId: "d1", title: "tool" });
  assert.equal(c.label, "Bash");
});

test("a katashiro tool reaching us via the Facade capability (openab#6 shape) is skipped", () => {
  const skipped = new Set();
  const u = { sessionUpdate: "tool_call", toolCallId: "f1", title: "katashiro.click", name: "mcp__oab__execute_capability", _meta: { openab: { capability: "katashiro.click" } } };
  assert.equal(AgentTools.isBrowserToolCall(u), true);
  assert.equal(apply(null, u, skipped), null);
  assert.ok(skipped.has("f1"));
  // capability alone (title already generic) is enough
  assert.equal(AgentTools.isBrowserToolCall({ title: "tool", _meta: { openab: { capability: "katashiro.snapshot" } } }), true);
  // a capability that only mentions katashiro is not one
  assert.equal(AgentTools.isBrowserToolCall({ title: "tool", _meta: { openab: { capability: "github.katashiro_issues" } } }), false);
});
