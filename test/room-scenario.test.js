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

// #62 follow-up (real Chrome 2026-10-12): "`" and "2" sent in the same second; the agent's
// "↩ …14:54:11" for the first was quoted as "2". Headers now carry milliseconds, ids are unique
// per ms (nextUniqueMs, as sidepanel's uniqueMsgMs), and a marker copied from a header names
// exactly its message. Mirrors postUserText → batchWithReplyHint → replyParts → findMessageByTime.
test("e2e reply-to: two messages in one second (even one ms) are quoted apart by their ms headers", () => {
  const s0 = new Date(2026, 9, 12, 14, 54, 11).getTime();
  let last = 0;
  const history = [];
  const send = (now, text) => {
    const ts = RoomCore.nextUniqueMs(last, now);
    last = ts;
    history.push({ kind: "sent", senderName: "You", timestamp: ts, text });
    return RoomCore.framePrompt({ timestamp: ts, senderName: "user" }, text);
  };
  const prompt = RoomCore.batchWithReplyHint([send(s0 + 234, "`"), send(s0 + 234, "2"), send(s0 + 610, "3")]);
  const stamps = [...prompt.matchAll(/^\[(\S+) user\]$/gm)].map((m) => m[1]);
  assert.equal(stamps.length, 3);
  assert.equal(new Set(stamps).size, 3);                         // same ms → still three stamps
  assert.ok(prompt.endsWith(RoomCore.REPLY_HINT));
  // The agent answers each, copying the times from the headers.
  const reply = `↩ ${stamps[0]}\nbacktick\n↩ ${stamps[1]}\ntwo\n↩ ${stamps[2]}\nthree`;
  const quoted = RoomCore.replyParts(reply).map((p) => [RoomCore.findByStamp(history, p.replyTo).text, p.text]);
  assert.deepEqual(quoted, [["`", "backtick"], ["2", "two"], ["3", "three"]]);
  // An agent (or replayed history) with a second-only marker keeps the old rule: the user's newest.
  const old = RoomCore.replyParts(`↩ ${stamps[0].replace(/\.\d{3}/, "")}\nold`)[0];
  assert.equal(RoomCore.findByStamp(history, old.replyTo).text, "3");
});
