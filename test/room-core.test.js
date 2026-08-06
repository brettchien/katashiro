// Unit tests for the katashiro room-core module (room-core.js) — the pure routing/relay brain.
// Runs under `node --test` with no DOM/WebSocket. This first cut covers the attribution and
// @mention primitives; relay target-resolution and the loop guard get their own tests as they land.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const RoomCore = require("../room-core.js");

test("escapeAttr collapses newlines and neutralizes quotes", () => {
  assert.equal(RoomCore.escapeAttr("Falcon"), "Falcon");
  assert.equal(RoomCore.escapeAttr('  Kirin\n'), "Kirin");
  assert.equal(RoomCore.escapeAttr('a"b'), "a'b");
  assert.equal(RoomCore.escapeAttr("line1\nline2"), "line1 line2");
  assert.equal(RoomCore.escapeAttr(null), "");
  assert.equal(RoomCore.escapeAttr(undefined), "");
});

test("wrapRelay produces a well-formed <message from> block", () => {
  assert.equal(
    RoomCore.wrapRelay("Falcon", "hello there"),
    '<message from="Falcon">\nhello there\n</message>'
  );
});

test("wrapRelay keeps the body verbatim and sanitizes only the name", () => {
  const out = RoomCore.wrapRelay('Ki"rin', "text with @mention and \"quotes\"");
  assert.match(out, /^<message from="Ki'rin">\n/);
  assert.match(out, /text with @mention and "quotes"/); // body untouched
  assert.match(out, /\n<\/message>$/);
});

test("wrapRelay tolerates empty/null text", () => {
  assert.equal(RoomCore.wrapRelay("A", ""), '<message from="A">\n\n</message>');
  assert.equal(RoomCore.wrapRelay("A", null), '<message from="A">\n\n</message>');
});

test("batchPrompts joins a backlog into one blank-line-separated prompt, order preserved", () => {
  assert.equal(RoomCore.batchPrompts(["first", "second", "third"]), "first\n\nsecond\n\nthird");
});

test("batchPrompts is a no-op shape for a single message", () => {
  assert.equal(RoomCore.batchPrompts(["only one"]), "only one");
});

test("batchPrompts drops empty/whitespace-only entries but keeps the rest in order", () => {
  assert.equal(RoomCore.batchPrompts(["a", "", "  ", "b"]), "a\n\nb");
  assert.equal(RoomCore.batchPrompts([null, "kept", undefined]), "kept");
});

test("batchPrompts yields '' for an empty, all-blank, or non-array backlog", () => {
  assert.equal(RoomCore.batchPrompts([]), "");
  assert.equal(RoomCore.batchPrompts(["", "   ", null]), "");
  assert.equal(RoomCore.batchPrompts(null), "");
  assert.equal(RoomCore.batchPrompts(undefined), "");
});

test("batchPrompts preserves multi-line message bodies (only trims for the empty check)", () => {
  assert.equal(RoomCore.batchPrompts(["line1\nline2", "next"]), "line1\nline2\n\nnext");
});

test("isDeadProbeReason: timeouts and closed sockets are dead", () => {
  assert.equal(RoomCore.isDeadProbeReason("request timed out: katashiro/ping"), true);
  assert.equal(RoomCore.isDeadProbeReason("request timed out: session/prompt"), true);
  assert.equal(RoomCore.isDeadProbeReason("connection closed"), true);
  assert.equal(RoomCore.isDeadProbeReason("socket not open"), true);
});

test("isDeadProbeReason: ANY error response means the socket is ALIVE (not dead)", () => {
  // The probe is an unknown method; -32601 proves the gateway answered → socket alive.
  assert.equal(RoomCore.isDeadProbeReason("Method not found: katashiro/ping"), false);
  assert.equal(RoomCore.isDeadProbeReason("Not initialized"), false);
  assert.equal(RoomCore.isDeadProbeReason("Session busy: a prompt is already in progress"), false);
  assert.equal(RoomCore.isDeadProbeReason(""), false);
  assert.equal(RoomCore.isDeadProbeReason(null), false);
});

test("browserBadge: hidden when the agent isn't allowed browser access", () => {
  assert.equal(RoomCore.browserBadge({ allowed: false, attached: true, alive: true, actMode: true }), null);
});

test("browserBadge: allowed but not attached → 未連", () => {
  assert.deepEqual(RoomCore.browserBadge({ allowed: true, attached: false }),
    { state: "detached", glyph: "🌐", label: "未連" });
});

test("browserBadge: attached but heartbeat failing → ⚠️ 無回應 (not a silent 未連)", () => {
  assert.deepEqual(RoomCore.browserBadge({ allowed: true, attached: true, alive: false, actMode: true }),
    { state: "degraded", glyph: "⚠️", label: "無回應" });
});

test("browserBadge: attached + alive reflects act mode (可操作 / 唯讀)", () => {
  assert.deepEqual(RoomCore.browserBadge({ allowed: true, attached: true, alive: true, actMode: true }),
    { state: "attached", glyph: "🌐", label: "可操作" });
  assert.deepEqual(RoomCore.browserBadge({ allowed: true, attached: true, alive: true, actMode: false }),
    { state: "attached", glyph: "🌐", label: "唯讀" });
});

test("normalizeRoomConfig fills heartbeat defaults and clamps junk to the floor", () => {
  const d = RoomCore.defaultRoomConfig();
  assert.equal(d.heartbeatIntervalMs, 60000);
  assert.equal(d.heartbeatTimeoutMs, 5000);
  // Missing / non-numeric → defaults.
  const filled = RoomCore.normalizeRoomConfig({ mode: "mention" });
  assert.equal(filled.heartbeatIntervalMs, 60000);
  assert.equal(filled.heartbeatTimeoutMs, 5000);
  assert.equal(RoomCore.normalizeRoomConfig({ heartbeatIntervalMs: "x" }).heartbeatIntervalMs, 60000);
  // Below the floor → default (never let a misconfig hammer the gateway).
  assert.equal(RoomCore.normalizeRoomConfig({ heartbeatIntervalMs: 100 }).heartbeatIntervalMs, 60000);
  assert.equal(RoomCore.normalizeRoomConfig({ heartbeatTimeoutMs: 10 }).heartbeatTimeoutMs, 5000);
  // A valid custom value is kept (floored to an int).
  assert.equal(RoomCore.normalizeRoomConfig({ heartbeatIntervalMs: 30000.7 }).heartbeatIntervalMs, 30000);
});

test("parseMentions extracts a single mention", () => {
  assert.deepEqual(RoomCore.parseMentions("hi @Falcon"), ["Falcon"]);
});

test("parseMentions extracts multiple mentions in order, deduped case-insensitively", () => {
  assert.deepEqual(
    RoomCore.parseMentions("@Falcon please ask @Kirin and @falcon again"),
    ["Falcon", "Kirin"]
  );
});

test("parseMentions matches mid-text and at start, over word chars/underscore/hyphen", () => {
  assert.deepEqual(RoomCore.parseMentions("@k04 and @kaiju_heiki-10 hi"), ["k04", "kaiju_heiki-10"]);
});

test("parseMentions ignores email-like @ (no preceding whitespace/start)", () => {
  assert.deepEqual(RoomCore.parseMentions("mail me at brett@host.com"), []);
});

test("parseMentions returns [] for no mentions / empty / null", () => {
  assert.deepEqual(RoomCore.parseMentions("just a plain message"), []);
  assert.deepEqual(RoomCore.parseMentions(""), []);
  assert.deepEqual(RoomCore.parseMentions(null), []);
});

// --- resolveTargets (fan-out relay, broadcast baseline) ---------------------
const MEMBERS = [
  { id: "a", name: "Falcon" },
  { id: "b", name: "Kirin" },
  { id: "c", name: "k04" },
];

test("resolveTargets: a user message reaches every agent", () => {
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "user"), ["a", "b", "c"]);
});

test("resolveTargets: an agent relay reaches every agent except the origin", () => {
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "a"), ["b", "c"]);
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "b"), ["a", "c"]);
});

test("resolveTargets: single-agent room, agent origin gets no targets", () => {
  assert.deepEqual(RoomCore.resolveTargets([{ id: "a", name: "Solo" }], "a"), []);
});

test("resolveTargets: empty / non-array members yields []", () => {
  assert.deepEqual(RoomCore.resolveTargets([], "user"), []);
  assert.deepEqual(RoomCore.resolveTargets(null, "user"), []);
});

// --- resolveNames (name->conn registry) -------------------------------------
test("resolveNames maps mention names to ids, case-insensitively", () => {
  assert.deepEqual(RoomCore.resolveNames(MEMBERS, ["Falcon"]), ["a"]);
  assert.deepEqual(RoomCore.resolveNames(MEMBERS, ["kirin", "K04"]), ["b", "c"]);
  assert.deepEqual(RoomCore.resolveNames(MEMBERS, ["Nobody"]), []);
  assert.deepEqual(RoomCore.resolveNames(null, ["x"]), []);
});

// --- resolveTargets: @mention mode ------------------------------------------
test("mention mode: @Falcon routes only to Falcon", () => {
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "user", { text: "hihi @Falcon" }), ["a"]);
});

test("mention mode: multiple @ route to just those, case-insensitive", () => {
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "user", { text: "@Kirin and @k04 pls" }), ["b", "c"]);
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "user", { text: "@falcon" }), ["a"]);
});

test("mention mode: no @ broadcasts (bare message not lost)", () => {
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "user", { text: "just talking" }), ["a", "b", "c"]);
});

test("mention mode: @name not in room falls through to broadcast", () => {
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "user", { text: "@Ghost hi" }), ["a", "b", "c"]);
});

test("mention mode: origin is never a target even if @-addressed", () => {
  // agent 'a' (Falcon) relays a message that @Falcon — origin excluded, no other Falcon → broadcast
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "a", { text: "@Falcon note" }), ["b", "c"]);
  // agent 'a' @Kirin → only Kirin
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "a", { text: "@Kirin thoughts?" }), ["b"]);
});

test("mention mode: pre-parsed opts.mentions is honored", () => {
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "user", { mentions: ["Kirin"] }), ["b"]);
});

test("ambient mode: mentions ignored, always broadcast (minus origin)", () => {
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "user", { mode: "ambient", text: "@Falcon" }), ["a", "b", "c"]);
  assert.deepEqual(RoomCore.resolveTargets(MEMBERS, "a", { mode: "ambient", text: "@Falcon" }), ["b", "c"]);
});

// --- room config (mode) -----------------------------------------------------
test("MODES lists the two routing modes", () => {
  assert.deepEqual(RoomCore.MODES, ["mention", "ambient"]);
});

test("normalizeMode defaults unknown/empty to mention, passes valid through", () => {
  assert.equal(RoomCore.normalizeMode("mention"), "mention");
  assert.equal(RoomCore.normalizeMode("ambient"), "ambient");
  assert.equal(RoomCore.normalizeMode("bogus"), "mention");
  assert.equal(RoomCore.normalizeMode(undefined), "mention");
  assert.equal(RoomCore.normalizeMode(null), "mention");
});

const HB = { heartbeatIntervalMs: 60000, heartbeatTimeoutMs: 5000 }; // heartbeat defaults, appended below

test("defaultRoomConfig is mention mode with the default loop-guard cap", () => {
  assert.deepEqual(RoomCore.defaultRoomConfig(), { mode: "mention", loopGuardCap: 6, ...HB });
});

test("normalizeRoomConfig repairs junk and honors valid mode + cap", () => {
  assert.deepEqual(RoomCore.normalizeRoomConfig(null), { mode: "mention", loopGuardCap: 6, ...HB });
  assert.deepEqual(RoomCore.normalizeRoomConfig({}), { mode: "mention", loopGuardCap: 6, ...HB });
  assert.deepEqual(RoomCore.normalizeRoomConfig({ mode: "ambient", loopGuardCap: 3 }), { mode: "ambient", loopGuardCap: 3, ...HB });
  assert.deepEqual(RoomCore.normalizeRoomConfig({ mode: "nope", loopGuardCap: 0 }), { mode: "mention", loopGuardCap: 6, ...HB });
});

// --- loop guard -------------------------------------------------------------
test("normalizeCap coerces to a positive int, defaulting junk to 6", () => {
  assert.equal(RoomCore.normalizeCap(3), 3);
  assert.equal(RoomCore.normalizeCap("4"), 4);
  assert.equal(RoomCore.normalizeCap(2.9), 2);
  assert.equal(RoomCore.normalizeCap(0), 6);
  assert.equal(RoomCore.normalizeCap(-1), 6);
  assert.equal(RoomCore.normalizeCap("x"), 6);
  assert.equal(RoomCore.normalizeCap(undefined), 6);
});

test("loop guard allows up to cap consecutive agent relays, then blocks", () => {
  const g = RoomCore.createLoopGuard(3);
  assert.deepEqual(g.onAgentRelay(), { allowed: true, tripped: false, count: 1, cap: 3 });
  assert.equal(g.onAgentRelay().allowed, true); // 2
  assert.equal(g.onAgentRelay().allowed, true); // 3
  const trip = g.onAgentRelay();               // 4th blocked
  assert.equal(trip.allowed, false);
  assert.equal(trip.tripped, true);            // first block reports tripped
});

test("loop guard reports tripped only once until reset", () => {
  const g = RoomCore.createLoopGuard(1);
  assert.equal(g.onAgentRelay().allowed, true);   // 1
  assert.deepEqual(g.onAgentRelay(), { allowed: false, tripped: true, count: 1, cap: 1 });
  assert.equal(g.onAgentRelay().tripped, false);  // still blocked, no re-trip
});

test("a human message resets the cascade", () => {
  const g = RoomCore.createLoopGuard(2);
  g.onAgentRelay(); g.onAgentRelay();
  assert.equal(g.onAgentRelay().allowed, false);  // blocked
  g.onHuman();
  assert.deepEqual(g.state(), { count: 0, cap: 2, tripped: false });
  assert.equal(g.onAgentRelay().allowed, true);   // flows again
});

test("loop guard cap defaults on junk and can be re-capped live", () => {
  const g = RoomCore.createLoopGuard("bad");
  assert.equal(g.state().cap, 6);
  g.setCap(2);
  assert.equal(g.state().cap, 2);
});
