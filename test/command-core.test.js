// command-core.test.js — the ⚡ command menu and typed commands: which entries the menu lists and
// in what order, its keys, the composer shortcuts, what counts as a command, when one is refused,
// and the OpenAB gateway's reply formats (pinned by test/fixtures/openab-slash-replies.json: a
// format change on the openab side must fail here, not silently fall back to raw text).
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/core/command-core.js");
const F = require("./fixtures/openab-slash-replies.json");

const ids = (items) => items.map((c) => c.id);

test("the menu has exactly Cancel / Reset session / Switch model, with c / r / m", () => {
  assert.deepEqual(C.COMMANDS.map((c) => [c.label, c.key]), [["Cancel", "c"], ["Reset session", "r"], ["Switch model", "m"]]);
  for (const c of C.COMMANDS) assert.ok(c.desc && !c.desc.includes("\n"), `${c.id} has a one-line description`);
  assert.ok(!C.COMMANDS.some((c) => /help/i.test(c.label)), "no Help entry");
});

test("menuItems: Cancel first while replying, last when idle; a typed prefix filters", () => {
  assert.deepEqual(ids(C.menuItems({ replying: true })), ["cancel", "reset", "model"]);
  assert.deepEqual(ids(C.menuItems({ replying: false })), ["reset", "model", "cancel"]);
  assert.deepEqual(ids(C.menuItems({ query: "r" })), ["reset"]);
  assert.deepEqual(ids(C.menuItems({ query: "R" })), ["reset"]);
  assert.deepEqual(ids(C.menuItems({ query: "m" })), ["model"]);
  assert.deepEqual(ids(C.menuItems({ query: "models" })), ["model"]);
  assert.deepEqual(ids(C.menuItems({ query: "c", replying: true })), ["cancel"]);
  assert.deepEqual(ids(C.menuItems({ query: "help" })), []);
  assert.deepEqual(ids(C.menuItems({ query: "" })), ["reset", "model", "cancel"]);
});

test("menuQuery: only '/' plus letters keeps the typed menu open", () => {
  assert.equal(C.menuQuery("/"), "");
  assert.equal(C.menuQuery("/re"), "re");
  assert.equal(C.menuQuery("/models"), "models");
  assert.equal(C.menuQuery(" /re"), null);
  assert.equal(C.menuQuery("/model set 2"), null);
  assert.equal(C.menuQuery("/etc/hosts"), null);
  assert.equal(C.menuQuery("hello"), null);
  assert.equal(C.menuQuery(""), null);
});

test("menuKey: arrows move, Enter/Tab run, Esc closes; c/r/m run only when opened by ⚡ or shortcut", () => {
  assert.deepEqual(C.menuKey({ key: "ArrowDown" }), { type: "move", delta: 1 });
  assert.deepEqual(C.menuKey({ key: "ArrowUp" }), { type: "move", delta: -1 });
  assert.deepEqual(C.menuKey({ key: "Enter" }), { type: "run" });
  assert.deepEqual(C.menuKey({ key: "Tab" }), { type: "run" });
  assert.deepEqual(C.menuKey({ key: "Escape" }), { type: "close" });
  // opened by typing "/": letters filter (the composer gets them)
  assert.deepEqual(C.menuKey({ key: "r", via: "typed" }), { type: "pass" });
  // opened by ⚡ / Ctrl+/: the letter runs it
  assert.deepEqual(C.menuKey({ key: "c", via: "button" }), { type: "run", id: "cancel" });
  assert.deepEqual(C.menuKey({ key: "R", via: "button" }), { type: "run", id: "reset" });
  assert.deepEqual(C.menuKey({ key: "m", via: "button" }), { type: "run", id: "model" });
  assert.deepEqual(C.menuKey({ key: "x", via: "button" }), { type: "pass" });
  assert.deepEqual(C.menuKey({ key: "r", via: "button", ctrlKey: true }), { type: "pass" });
  // a letter whose entry is filtered out does nothing
  assert.deepEqual(C.menuKey({ key: "r", via: "button", items: C.menuItems({ query: "m" }) }), { type: "pass" });
});

test("moveSelection wraps", () => {
  assert.equal(C.moveSelection(0, 1, 3), 1);
  assert.equal(C.moveSelection(2, 1, 3), 0);
  assert.equal(C.moveSelection(0, -1, 3), 2);
  assert.equal(C.moveSelection(0, 1, 0), 0);
});

test("composerShortcut: Ctrl/⌘+/ opens the menu, Ctrl/⌘+. stops; Esc and plain keys do nothing", () => {
  assert.equal(C.composerShortcut({ key: "/", ctrlKey: true }), "menu");
  assert.equal(C.composerShortcut({ key: "/", metaKey: true }), "menu");
  assert.equal(C.composerShortcut({ key: "?", code: "Slash", ctrlKey: true }), "menu");   // a layout where Slash gives "?"
  assert.equal(C.composerShortcut({ key: ".", ctrlKey: true }), "stop");
  assert.equal(C.composerShortcut({ key: ".", metaKey: true }), "stop");
  assert.equal(C.composerShortcut({ key: "Escape" }), null);
  assert.equal(C.composerShortcut({ key: "Escape", ctrlKey: true }), null);
  assert.equal(C.composerShortcut({ key: "/" }), null);
  assert.equal(C.composerShortcut({ key: ".", ctrlKey: true, altKey: true }), null);
  assert.equal(C.composerShortcut({ key: "r", ctrlKey: true }), null, "no direct shortcut for Reset");
  assert.equal(C.composerShortcut({ key: "m", metaKey: true }), null, "no direct shortcut for Switch model");
});

test("parseCommand: our commands, typed", () => {
  assert.deepEqual(C.parseCommand("/cancel"), { id: "cancel" });
  assert.deepEqual(C.parseCommand("/reset"), { id: "reset" });
  assert.deepEqual(C.parseCommand("/reset  \n"), { id: "reset" });
  assert.deepEqual(C.parseCommand("/RESET"), { id: "reset" });
  assert.deepEqual(C.parseCommand("/models"), { id: "model" });
  assert.deepEqual(C.parseCommand("/model"), { id: "model" });
  assert.deepEqual(C.parseCommand("/model list"), { id: "model" });
  assert.deepEqual(C.parseCommand("/model set"), { id: "model" });
  assert.deepEqual(C.parseCommand("/model set 2"), { id: "model-set", arg: "2" });
  assert.deepEqual(C.parseCommand("/model   set   Opus (1M context)"), { id: "model-set", arg: "Opus (1M context)" });
});

test("parseCommand: a leading space or no letter after / is a message", () => {
  assert.equal(C.parseCommand(" /tmp is full"), null);
  assert.equal(C.parseCommand(" /reset"), null);
  assert.equal(C.parseCommand("hello /reset"), null);
  assert.equal(C.parseCommand("/"), null);
  assert.equal(C.parseCommand("/ 2"), null);
  assert.equal(C.parseCommand("//comment"), null);
  assert.equal(C.parseCommand("/1"), null);
  assert.equal(C.parseCommand(""), null);
});

test("parseCommand: any other /word is unknown (never sent) — /help, /agents, paths", () => {
  for (const s of ["/help", "/agents", "/compact", "/tmp foo", "/etc/hosts", "/reset now", "/cancel all", "/model foo", "/models 2"]) {
    assert.equal(C.parseCommand(s).id, "unknown", s);
  }
  assert.equal(C.parseCommand("/etc/hosts").name, "/etc/hosts");
});

test("blocker: when a command is refused, and why", () => {
  assert.equal(C.blocker("unknown"), C.TEXT.noSuchCommand);
  assert.match(C.TEXT.noSuchCommand, /start with a space to send it as text/, "the hint says how to send /xxx as a message (#179 review)");
  assert.equal(C.blocker("cancel", { replying: false }), C.TEXT.nothingToStop);
  assert.equal(C.blocker("cancel", { replying: true, staged: 2, quoted: true }), null, "Cancel sends no prompt: chips do not block it");
  assert.equal(C.blocker("reset", { staged: 1 }), C.TEXT.pendingAttachments);
  assert.equal(C.blocker("model", { quoted: true }), C.TEXT.pendingQuote);
  assert.equal(C.blocker("model-set", { connected: false }), C.TEXT.notConnected);
  assert.equal(C.blocker("reset", { running: true }), C.TEXT.commandRunning);
  assert.equal(C.blocker("model", { replying: true }), C.TEXT.stopBeforeModel);
  assert.equal(C.blocker("model-set", { replying: true }), C.TEXT.stopBeforeModel);
  assert.equal(C.blocker("reset", { replying: true }), null, "reset while replying: the reply is stopped first");
  assert.equal(C.blocker("reset"), null);
  assert.equal(C.blocker("model"), null);
});

test("wire text: the bare command, no header", () => {
  assert.equal(C.RESET_TEXT, "/reset");
  assert.equal(C.MODELS_TEXT, "/models");
  assert.equal(C.modelSetText(2), "/model set 2");
  assert.equal(C.modelSetText(" Opus "), "/model set Opus");
});

// --- the gateway's formats (pinned) ------------------------------------------------------------

test("parseModelList: the gateway's numbered list, current one marked ✅", () => {
  const r = C.parseModelList(F.modelsList);
  assert.deepEqual(r.options.map((o) => [o.n, o.name, o.current]), [
    [1, "Default (recommended)", false],
    [2, "Opus", true],
    [3, "Sonnet", false],
    [4, "Haiku", false],
    [5, "Opus (1M context)", false],
  ]);
  assert.equal(r.current, 1);
  assert.equal(C.parseModelList(F.modelsList.replace(/\n/g, "\r\n")).options.length, 5);
  assert.equal(C.parseModelList(F.modelsList.replace(" ✅", "")).current, -1);
});

test("parseModelList: anything else is null (the panel shows the raw text)", () => {
  assert.equal(C.parseModelList(F.modelsNoOptions), null);
  assert.equal(C.parseModelList(""), null);
  assert.equal(C.parseModelList(null), null);
  // A change of the gateway's format must fail parsing, not half-parse.
  assert.equal(C.parseModelList(F.modelsList.replace("🔧 Available models:", "Available models:")), null);
  assert.equal(C.parseModelList(F.modelsList.replace("Usage: /model set <number or name>", "Usage: /model set <n>")), null);
  assert.equal(C.parseModelList(F.modelsList.replace("\n\nUsage: /model set <number or name>", "")), null);
  assert.equal(C.parseModelList(F.modelsList.replace("  2. Opus", "  3. Opus")), null, "numbering must run 1..N");
  assert.equal(C.parseModelList(F.modelsList.replace("  1. ", "1) ")), null);
  assert.equal(C.parseModelList("🔧 Available models:\n\nUsage: /model set <number or name>"), null, "no options");
  assert.equal(C.parseModelList(F.modelsList.replace("🔧 Available models:", "🔧 Available agents:").replace("/model set", "/agent set")), null);
});

test("parseSwitchReply / switchMessage", () => {
  assert.deepEqual(C.parseSwitchReply(F.modelSetOk), { ok: true, name: "Sonnet" });
  assert.equal(C.switchMessage(F.modelSetOk), "✅ Switched to Sonnet");
  assert.equal(C.parseSwitchReply(F.modelSetFailed), null);
  assert.equal(C.switchMessage(F.modelSetFailed), F.modelSetFailed, "a failure shows the gateway's text");
  assert.equal(C.switchMessage(F.modelSetInvalidNumber), F.modelSetInvalidNumber);
  assert.equal(C.switchMessage(""), C.TEXT.noReply);
  assert.equal(C.parseSwitchReply("✅ Switched to Sonnet"), null, "the ** around the name are part of the format");
});

test("parseResetReply / resetMessage", () => {
  assert.deepEqual(C.parseResetReply(F.resetOk), { ok: true, none: false, dropped: 0 });
  assert.deepEqual(C.parseResetReply(F.resetDropped), { ok: true, none: false, dropped: 2 });
  assert.deepEqual(C.parseResetReply(F.resetNoSession), { ok: true, none: true, dropped: 0 });
  assert.deepEqual(C.parseResetReply(F.resetNoSessionDropped), { ok: true, none: true, dropped: 2 }, "(Err, n): no session, buffer dropped");
  assert.deepEqual(C.parseResetReply(F.resetNoSessionDropped.replace("2", "1")), { ok: true, none: true, dropped: 1 });
  assert.equal(C.resetMessage(F.resetOk), C.TEXT.resetDone);
  assert.equal(C.resetMessage(F.resetNoSession), C.TEXT.resetNothing);
  assert.equal(C.resetMessage(F.resetDropped), C.TEXT.resetDone + C.TEXT.resetDropped(2));
  assert.equal(C.resetMessage(F.resetNoSessionDropped), C.TEXT.resetNothing + C.TEXT.resetDropped(2));
  assert.match(C.resetMessage(F.resetNoSessionDropped), /^🔄 Session reset — there was no active session to clear \(the gateway dropped 2 messages it was still holding\)$/);
  assert.match(C.TEXT.resetDropped(1), /1 message it/);
  assert.ok(!C.resetMessage(F.resetNoSessionDropped).includes("buffered message(s)"), "not the gateway's raw English");
  assert.equal(C.parseResetReply("🔄 Dropped 2 buffered message(s)."), null);
  assert.equal(C.parseResetReply("🔄 Dropped two buffered message(s). No active session to reset."), null);
  assert.ok(!C.resetMessage(F.resetOk).includes("Start a new conversation"), "not the gateway's raw English");
  assert.equal(C.parseResetReply("🔄 Session reset"), null);
  assert.equal(C.resetMessage("something else"), "something else");
  assert.equal(C.resetMessage(""), C.TEXT.noReply);
});

test("resetDetail: the Reset card's line, from the state now", () => {
  const base = "Orca starts a new session and forgets what was said here; the messages stay on screen.";
  assert.equal(C.resetDetail("Orca"), base);
  assert.equal(C.resetDetail("Orca", { replying: true }), base + " The reply in progress is stopped first.");
  assert.equal(C.resetDetail("Orca", { queued: 1 }), base + " 1 queued message will be sent to the new session.");
  assert.equal(C.resetDetail("Orca", { replying: true, queued: 3 }), base + " The reply in progress is stopped first. 3 queued messages will be sent to the new session.");
  assert.equal(C.resetDetail("Orca", { replying: false, queued: 0 }), base, "a reply that ended meanwhile drops its sentence");
  assert.equal(C.resetDetail("Orca", { answers: 1 }), base + " 1 queued answer to its questions will be dropped (the new session never asked it).");
  assert.equal(C.resetDetail("Orca", { queued: 2, answers: 2 }), base + " 2 queued messages will be sent to the new session. 2 queued answers to its questions will be dropped (the new session never asked them).");
});

test("queuedCounts: messages with text and ask answers apart; an image carrier \"\" is no message (#191 review c)", () => {
  const ans = new Set(["[t user]\n↩ 回答 ask_1：Blue"]);
  assert.deepEqual(C.queuedCounts([], ans), { messages: 0, answers: 0 });
  assert.deepEqual(C.queuedCounts([""], ans), { messages: 0, answers: 0 }, "images left over from a sent turn");
  assert.deepEqual(C.queuedCounts(["[t user]\nhi", "", "[t user]\n↩ 回答 ask_1：Blue"], ans), { messages: 1, answers: 1 });
  assert.deepEqual(C.queuedCounts(["a", "b"]), { messages: 2, answers: 0 }, "no answer set");
});

test("withoutAskAnswers: drops the queued ask answers, keeps the rest in order (#191 review d)", () => {
  const ans = new Set(["A1", "A2"]);
  assert.deepEqual(C.withoutAskAnswers(["m1", "A1", "", "m2", "A2"], ans), { kept: ["m1", "", "m2"], dropped: 2 });
  assert.deepEqual(C.withoutAskAnswers(["m1"], ans), { kept: ["m1"], dropped: 0 });
  assert.deepEqual(C.withoutAskAnswers(["m1"]), { kept: ["m1"], dropped: 0 });
  assert.equal(C.TEXT.askAnswersDropped(1), "1 queued answer to the agent's questions was not sent — the new session never asked it");
  assert.equal(C.TEXT.askAnswersDropped(2), "2 queued answers to the agent's questions were not sent — the new session never asked them");
});

test("replyText: the whole reply, or its last chunk when a stopped reply's stray chunk came first", () => {
  assert.equal(C.replyText([F.resetOk], C.parseResetReply), F.resetOk);
  assert.equal(C.replyText(["…and so the", F.resetOk], C.parseResetReply), F.resetOk);
  assert.equal(C.replyText(["a", "b"], C.parseResetReply), "ab", "neither parses: the whole text, shown raw");
  assert.equal(C.replyText([], C.parseModelList), "");
  assert.equal(C.replyText(null, C.parseModelList), "");
  assert.equal(C.replyText(["🔧 Available models:\n  1. A ✅\n", "\nUsage: /model set <number or name>"], C.parseModelList),
    "🔧 Available models:\n  1. A ✅\n\nUsage: /model set <number or name>", "a list split over chunks parses whole");
});
