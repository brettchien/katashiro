// Integration / e2e-style tests for the multi-agent room: exercise the room-core primitives
// TOGETHER exactly as sidepanel.js drives them (user routing + agent-reply relay + loop guard),
// without DOM/WebSocket. This is the automatable end-to-end for the room's routing behavior;
// the full extension-in-Chrome pass is Brett's manual step.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const RoomCore = require("../room-core.js");

const MEMBERS = [
  { id: "a", name: "Falcon" },
  { id: "b", name: "Kirin" },
];

// Mirror sidepanel's send/relay decisions with no DOM: a user message resets the cascade and
// routes per mode; an agent reply relays (attribution-wrapped) to resolveTargets, gated by the
// loop guard — the same calls relayAgentReply()/sendMessage() make.
function makeRoom(mode, cap) {
  const guard = RoomCore.createLoopGuard(cap);
  return {
    guard,
    userSay(text) {
      guard.onHuman();
      return RoomCore.resolveTargets(MEMBERS, "user", { mode, text });
    },
    agentReply(originId, name, text) {
      const g = guard.onAgentRelay();
      if (!g.allowed) return { allowed: false, tripped: g.tripped, targets: [], wrapped: null };
      const targets = RoomCore.resolveTargets(MEMBERS, originId, { mode, text });
      return { allowed: true, tripped: false, targets, wrapped: RoomCore.wrapRelay(name, text) };
    },
  };
}

test("e2e mention: @Falcon reaches only Falcon; Falcon's reply relays to Kirin (wrapped)", () => {
  const room = makeRoom("mention", 6);
  assert.deepEqual(room.userSay("@Falcon hi"), ["a"]); // only Falcon prompted
  const r = room.agentReply("a", "Falcon", "hello everyone");
  assert.equal(r.allowed, true);
  assert.deepEqual(r.targets, ["b"]); // relayed to Kirin
  assert.match(r.wrapped, /^<message from="Falcon">\nhello everyone\n<\/message>$/);
});

test("e2e mention: @Kirin from the user does not prompt Falcon", () => {
  const room = makeRoom("mention", 6);
  assert.deepEqual(room.userSay("@Kirin ping"), ["b"]);
});

test("e2e mention: a bare user message broadcasts to all agents", () => {
  const room = makeRoom("mention", 6);
  assert.deepEqual(room.userSay("hey all"), ["a", "b"]);
});

test("e2e ambient: cascade is capped by the loop guard, a human resets it", () => {
  const room = makeRoom("ambient", 3);
  room.userSay("go"); // broadcast + reset
  assert.equal(room.agentReply("a", "Falcon", "1").allowed, true);
  assert.equal(room.agentReply("b", "Kirin", "2").allowed, true);
  assert.equal(room.agentReply("a", "Falcon", "3").allowed, true);
  const blocked = room.agentReply("b", "Kirin", "4");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.tripped, true); // paused, surfaced once
  assert.equal(room.agentReply("a", "Falcon", "5").tripped, false); // still paused, no re-trip
  room.userSay("carry on"); // human breaks the pause
  assert.equal(room.agentReply("a", "Falcon", "6").allowed, true);
});

test("e2e: an agent never receives its own relayed reply", () => {
  const room = makeRoom("ambient", 10);
  const r = room.agentReply("a", "Falcon", "self?");
  assert.ok(!r.targets.includes("a"));
  assert.deepEqual(r.targets, ["b"]);
});
