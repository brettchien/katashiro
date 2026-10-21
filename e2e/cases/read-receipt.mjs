// Read receipt (Brett 2026-10-22): a small gray "read" beside the time of a user message once a
// turn carrying it has gone out to the agent; none while it waits in the queue behind a running
// turn, none (or removed) when the turn never started (pool busy), back on 重試 / a resend. It
// stays after the turn and across a panel reload (the `read` flag on the stored record), and the
// agent never sees it (prompt text, chat_history).
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

// { text, read } of the user's rows in the list holding `marker` (hidden or not).
const sentRows = (panel, marker) => panel.evaluate((m) => {
  const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => e.textContent.includes(m));
  return l ? Array.from(l.querySelectorAll(".message.sent")).map((r) => ({
    text: (r.querySelector(".bubble") || {}).textContent || "",
    read: (r.querySelector(":scope > .message-content > .timestamp > .read-tag") || {}).textContent || "",
  })) : [];
}, marker);
const readOf = async (panel, text) => {
  const row = (await sentRows(panel, text)).find((r) => r.text.includes(text));
  return row ? row.read : null;
};
const storedSent = async (ctx, title) => {
  const id = await h.convIdByTitle(ctx, title);
  return ((await h.storedConvs(ctx))[id] || { messages: [] }).messages.filter((m) => m.kind === "sent");
};

export default [
  {
    name: "queued messages have no read tag; sent ones do, also in a background conversation, and after a reload",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.hold = true;
      await h.send(panel, "first message");
      const p1 = await gw.waitPrompt((p) => p.sessionId === sid && /first message/.test(p.userText));
      await h.until(panel, () => !!document.querySelector(".message.sent .read-tag"), "the read tag on the first message");
      t.check((await readOf(panel, "first message")) === "read", "the message in the running turn says read");
      t.check(!/\bread\b/.test(p1.text.replace(/first message/, "")), "the prompt carries no read tag", p1.text);

      await h.send(panel, "second message");
      await h.until(panel, () => document.querySelectorAll(".message.sent").length >= 2, "the second message on screen");
      await h.sleep(500);
      t.check((await readOf(panel, "second message")) === "", "a message waiting behind the turn has no tag", await sentRows(panel, "second message"));
      t.check((await storedSent(ctx, "Alpha")).find((m) => /second/.test(m.text))?.read === false, "…and is stored unread");

      // Background: Alpha's queued message goes out while Beta is on screen.
      await h.namedConversation(ctx, panel, "Beta");
      const n = gw.prompts.length;
      gw.endTurn(sid, "end_turn", "reply one");
      await gw.waitPrompt((p) => p.sessionId === sid && /second message/.test(p.userText), { since: n });
      await h.until(panel, () => {
        const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => e.textContent.includes("second message"));
        return l && l.hidden && l.querySelectorAll(".message.sent .read-tag").length === 2;
      }, "the background conversation's queued message tagged when its turn goes out");
      t.ok("a queued message in a background conversation gets its tag when its turn goes out");
      gw.endTurn(sid, "end_turn", "reply two");
      await h.until(null, async () => (await storedSent(ctx, "Alpha")).every((m) => m.read === true), "both stored read");
      t.check((await readOf(panel, "first message")) === "read", "the tag stays after the turn ended");

      // chat_history is unchanged: no receipt in it.
      await h.switchTo(panel, "Alpha");
      await h.send(panel, "history please");
      await gw.waitPrompt((p) => p.sessionId === sid && /history please/.test(p.userText));
      const hist = FakeGateway.text(await gw.callTool(sid, "katashiro.chat_history", {})).text;
      t.check(/\]\nfirst message\n/.test(hist) && !/\bread\b/.test(hist), "chat_history has no read tag", hist);
      gw.endTurn(sid, "end_turn", "done");
      await h.idle(panel);

      // A legacy record (no flag) and an unread one, then a reload.
      const idA = await h.convIdByTitle(ctx, "Alpha");
      await ctx.control.evaluate(async (id) => {
        const k = `conv:${id}`;
        const c = (await chrome.storage.local.get(k))[k];
        for (const m of c.messages) {
          if (m.kind !== "sent") continue;
          if (/first message/.test(m.text)) delete m.read;           // stored before the receipt
          if (/history please/.test(m.text)) m.read = false;         // never sent (queued at a reload)
        }
        await chrome.storage.local.set({ [k]: c });
      }, idA);
      gw.hold = false;
      await panel.reload();
      await h.until(panel, () => document.readyState === "complete" && !!document.querySelector(".conv-tab.current"), "the panel back after the reload");
      await h.switchTo(panel, "Alpha");
      await h.until(panel, () => Array.from(document.querySelectorAll(".conv-messages")).some((e) => !e.hidden && e.textContent.includes("second message")), "Alpha's restored list");
      t.check((await readOf(panel, "second message")) === "read", "the tag survives a reload");
      t.check((await readOf(panel, "first message")) === "read", "a record from before the receipt counts as read");
      t.check((await readOf(panel, "history please")) === "", "a record stored unread shows no tag");
    },
  },
  {
    name: "a pool-busy turn leaves no read tag; 重試 adds it",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.poolBusy = true;
      await h.send(panel, "while the pool is full");
      await h.until(panel, () => !!Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden)?.querySelector(".error-bubble .retry-btn"), "the error bubble with 重試");
      t.check((await readOf(panel, "while the pool is full")) === "", "no tag: the turn never started", await sentRows(panel, "while the pool is full"));
      t.check((await storedSent(ctx, "Alpha"))[0]?.read === false, "stored unread");
      gw.poolBusy = false;
      await panel.evaluate(() => Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden).querySelector(".error-bubble .retry-btn").click());
      await h.until(panel, () => { const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden); return l && l.textContent.includes("echo: while the pool is full"); }, "the retried reply");
      t.check((await readOf(panel, "while the pool is full")) === "read", "the tag once 重試 went out");
      await h.until(null, async () => (await storedSent(ctx, "Alpha"))[0]?.read === true, "stored read");
    },
  },
  {
    name: "a turn that only drove the browser tunnel, then failed, was received: the tag stays; one that sent nothing loses it",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.hold = true;
      // No session/update at all: the agent's only sign is a tool call on the tunnel (#180 review nit 1).
      await h.send(panel, "check the history");
      await gw.waitPrompt((p) => p.sessionId === sid && /check the history/.test(p.userText));
      const r = await gw.callTool(sid, "katashiro.chat_history", { limit: 1 });
      t.check(!r.error, "the tool call went through", r);
      gw.failTurn(sid, "Internal error");
      await h.until(panel, () => !!Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden)?.querySelector(".error-bubble"), "the error bubble");
      t.check((await readOf(panel, "check the history")) === "read", "still read: the agent was working on it", await sentRows(panel, "check the history"));
      await h.until(null, async () => (await storedSent(ctx, "Alpha")).find((m) => /check the history/.test(m.text || ""))?.read !== false, "stored read");

      // The same failure with nothing heard: never reached the agent, as far as we know.
      await h.send(panel, "silent then failed");
      await gw.waitPrompt((p) => p.sessionId === sid && /silent then failed/.test(p.userText));
      gw.failTurn(sid, "Internal error");
      await h.until(panel, () => Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden)?.querySelectorAll(".error-bubble").length >= 2, "the second error bubble");
      t.check((await readOf(panel, "silent then failed")) === "", "no tag: nothing of the turn came back", await sentRows(panel, "silent then failed"));
    },
  },
  {
    name: "重試 on an earlier pool-busy turn re-sends that turn, not a later one, and tags its message",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      const errorsOnScreen = () => panel.evaluate(() => Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden).querySelectorAll(".error-bubble").length);
      gw.poolBusy = true;
      await h.send(panel, "busy one");
      await h.until(null, async () => (await errorsOnScreen()) >= 1, "the first error bubble");
      await h.send(panel, "busy two");
      await h.until(null, async () => (await errorsOnScreen()) >= 2, "the second error bubble");
      gw.poolBusy = false;
      const since = gw.prompts.length;
      await panel.evaluate(() => Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden).querySelectorAll(".error-bubble .retry-btn")[0].click());
      const p = await gw.waitPrompt((x) => x.sessionId === sid, { since });
      t.check(/busy one/.test(p.userText) && !/busy two/.test(p.userText), "the first bubble's 重試 sends the first turn", p.userText);
      await h.idle(panel);
      t.check((await readOf(panel, "busy one")) === "read", "its message is read now");
      t.check((await readOf(panel, "busy two")) === "", "the later one is still unread", await sentRows(panel, "busy two"));
    },
  },
  {
    name: "a socket dropped mid-turn: the resent message keeps its read tag",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.hold = true;
      await h.send(panel, "tell me a story");
      await gw.waitPrompt((p) => p.sessionId === sid);
      const n = gw.prompts.length;
      for (const ws of gw.sockets) ws.terminate();
      await gw.waitPrompt((p) => p.sessionId === sid, { since: n, ms: 15000 });
      await h.until(panel, () => !!document.querySelector(".conv-messages:not([hidden]) .message.sent .read-tag"), "the tag after the resend");
      t.ok("re-tagged when the requeued message went out again");
      gw.endTurn(sid, "end_turn", "the story");
      await h.idle(panel);
      t.check((await readOf(panel, "tell me a story")) === "read", "still read after the turn");
    },
  },
];
