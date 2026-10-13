// P2 part 1 (#143, ADR multi-conversation §5): background turns, in the real extension against
// the fake gateway — two conversations streaming at once, ⏹ on a background tab, archive refused
// while replying (across two windows' side panels), ❓ / ● marks with real notifications, and the
// pool-busy reply.
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const NOTE_PREFIX = "katashiro-notify:";
const notesFor = async (ctx, convId) => Object.keys(await h.notifications(ctx)).filter((id) => id.startsWith(NOTE_PREFIX) && id.includes(`:conv:${convId}:`));

export default [
  {
    name: "two conversations stream at once; ⏹ on a background tab stops only that session",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sidA = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      const sidB = await h.namedConversation(ctx, panel, "Beta");
      t.check(sidA !== sidB, "each conversation has its own ACP session", [sidA, sidB]);
      gw.hold = true;
      // B asks first (on screen), then A, so both turns are open at once.
      await h.send(panel, "question for beta");
      await gw.waitPrompt((p) => p.sessionId === sidB);
      await h.switchTo(panel, "Alpha");
      await h.send(panel, "question for alpha");
      await gw.waitPrompt((p) => p.sessionId === sidA);
      t.check(gw.openPrompts().length === 2, "the gateway holds two open turns at once", gw.openPrompts().map((p) => p.sessionId));
      // Interleaved updates: each lands in its own list.
      gw.chunk(sidA, "ALPHA-ONE ");
      gw.chunk(sidB, "BETA-ONE ");
      gw.chunk(sidA, "ALPHA-TWO");
      gw.chunk(sidB, "BETA-TWO");
      await h.until(panel, () => { const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden); return l && l.textContent.includes("ALPHA-TWO"); }, "Alpha's stream on screen");
      await h.until(panel, () => Array.from(document.querySelectorAll(".conv-messages")).some((e) => e.hidden && e.textContent.includes("BETA-TWO")), "Beta's stream in its hidden list");
      const onScreen = await h.visibleText(panel);
      t.check(onScreen.includes("ALPHA-ONE ALPHA-TWO") && !onScreen.includes("BETA"), "Alpha's list shows only Alpha's chunks, in order", onScreen.slice(-200));
      const beta = await h.listContaining(panel, "question for beta");
      t.check(beta && beta.hidden && beta.text.includes("BETA-ONE BETA-TWO") && !beta.text.includes("ALPHA"), "Beta's (hidden) list has only Beta's chunks, in order", beta && beta.text.slice(-200));
      let s = await h.strip(panel);
      const tabB = s.find((x) => x.title === "Beta");
      t.check(tabB && tabB.mark === "⏳" && tabB.close === "⏹", "the background tab shows ⏳ and ⏹", tabB);
      t.check(await h.stopButtonVisible(panel), "the stop button shows for the replying conversation on screen");

      // ⏹ on the background tab: session/cancel for Beta only; Alpha keeps streaming.
      await h.clearNotifications(ctx);
      await h.pressClose(panel, "Beta");
      await h.until(null, () => gw.cancels.includes(sidB), "session/cancel for Beta");
      await h.until(panel, () => { const x = Array.from(document.querySelectorAll(".conv-tab")).find((e) => e.textContent.includes("Beta")); return x && x.querySelector(".conv-tab-close").textContent === "×"; }, "Beta's ⏹ back to ×");
      t.check(!gw.cancels.includes(sidA), "no session/cancel for Alpha", gw.cancels);
      t.check(gw.openPrompts(sidA).length === 1 && gw.openPrompts(sidB).length === 0, "Alpha's turn is still open, Beta's ended (cancelled)", gw.prompts.map((p) => [p.sessionId, p.done, p.stopReason]));
      t.check((await h.strip(panel)).length === 2, "⏹ did not archive Beta");
      gw.chunk(sidA, " ALPHA-THREE");
      await h.until(panel, () => { const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden); return l && l.textContent.includes("ALPHA-THREE"); }, "Alpha continues after Beta's stop");
      gw.endTurn(sidA);
      await h.idle(panel);
      await h.sleep(800);
      const idB = await h.convIdByTitle(ctx, "Beta");
      t.check((await notesFor(ctx, idB)).length === 0, "no notification for the turn the user stopped", await h.notifications(ctx));
      const stored = await h.storedConvs(ctx);
      const idA = await h.convIdByTitle(ctx, "Alpha");
      t.check(stored[idA].messages.some((m) => m.kind === "received" && /ALPHA-ONE ALPHA-TWO ALPHA-THREE/.test(m.text)), "Alpha's reply is recorded in Alpha", stored[idA].messages.map((m) => m.text));
      t.check(!stored[idA].messages.some((m) => /BETA/.test(m.text)) && !stored[idB].messages.some((m) => /ALPHA/.test(m.text)), "no reply recorded in the other conversation");
    },
  },
  {
    name: "archive is refused while a conversation replies (this window's picker and another window's)",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sidA = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      await h.namedConversation(ctx, panel, "Beta");
      await h.namedConversation(ctx, panel, "Gamma");
      await h.switchTo(panel, "Alpha");
      gw.hold = true;
      await h.send(panel, "a long answer please");
      await gw.waitPrompt((p) => p.sessionId === sidA);
      await h.switchTo(panel, "Gamma");
      // Window 1: ＋ with 3 open → the picker; Alpha, replying, cannot be picked.
      await panel.evaluate(() => document.querySelector(".conv-tab-new")?.click());
      await h.until(panel, () => !!document.querySelector(".conv-picker"), "the picker with 3 open");
      const opts = await panel.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-option")).map((b) => ({ text: b.textContent, disabled: b.disabled })));
      const a = opts.find((o) => o.text.startsWith("Alpha"));
      t.check(a && a.disabled && a.text.includes("（回覆中）"), "this window's picker: the replying conversation is disabled (回覆中)", opts);
      await panel.evaluate(() => document.querySelector(".conv-picker-cancel").click());

      // Window 2: its panel opens full (3 open in window 1) → its picker → pick Alpha: the request
      // goes to window 1's panel over runtime messaging, which refuses.
      const url2 = h.controlUrl(ctx);
      await ctx.control.evaluate((u) => chrome.windows.create({ url: u, type: "normal" }), url2);
      const ctl2 = await (await ctx.browser.waitForTarget((x) => x.url() === url2)).asPage();
      await h.until(ctl2, () => document.readyState === "complete", "window 2's control page");
      const panel2 = await h.openSidePanel(ctx, ctl2);
      await h.until(panel2, () => !!document.querySelector(".conv-picker"), "window 2 shows the picker (3 open in window 1)");
      await panel2.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-option")).find((b) => b.textContent.startsWith("Alpha")).click());
      const status = await h.until(panel2, () => { const s = document.querySelector(".conv-picker-status"); return s && !s.hidden && s.textContent; }, "window 2's picker status");
      t.check(/回覆中不能封存/.test(status), "window 1's panel refuses: 回覆中不能封存", status);
      t.check((await h.strip(panel)).some((x) => x.title === "Alpha"), "Alpha is still open in window 1");
      const idA = await h.convIdByTitle(ctx, "Alpha");
      const idx = await ctx.control.evaluate(async () => (await chrome.storage.local.get("conv:index"))["conv:index"]);
      t.check(idx[idA] && !idx[idA].archivedAt, "…and not archived", idx[idA]);
      gw.endTurn(sidA, "end_turn", "done");
      // Once the turn is over the same request archives it.
      await h.until(panel, () => document.querySelector(".conv-tabs .busy") === null, "Alpha no longer busy");
      await panel2.evaluate(() => { const b = Array.from(document.querySelectorAll(".conv-picker-option")).find((x) => x.textContent.startsWith("Alpha")); if (b) { b.disabled = false; b.click(); } });
      await h.until(panel, () => !Array.from(document.querySelectorAll(".conv-tab-title")).some((e) => e.textContent === "Alpha"), "after the turn, window 2 archives Alpha", undefined, 15000);
      t.ok("after the turn, the same pick archives it");
    },
  },
  {
    name: "a background ask card shows ❓ and notifies; a background turn finishing shows ● and notifies",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sidA = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.hold = true;
      await h.send(panel, "ask me later");
      await gw.waitPrompt((p) => p.sessionId === sidA);
      await gw.connectTunnel(sidA);
      await h.namedConversation(ctx, panel, "Beta");
      const idA = await h.convIdByTitle(ctx, "Alpha");
      await h.clearNotifications(ctx);
      // The agent asks in Alpha while Beta is on screen.
      const asked = gw.callTool(sidA, "katashiro.ask_user", { question: "Which colour?", options: ["Red", "Blue"] }, 60000);
      await h.until(panel, () => { const x = Array.from(document.querySelectorAll(".conv-tab")).find((e) => e.textContent.includes("Alpha")); return x && x.querySelector(".conv-tab-mark").textContent === "❓"; }, "❓ on Alpha");
      t.ok("a card asked in a background conversation marks its tab ❓");
      const waitNotes = await h.until(null, () => notesFor(ctx, idA).then((n) => n.length && n), "a notification for Alpha's card");
      t.check(waitNotes.length === 1, "chrome.notifications has one notification naming Alpha", await h.notifications(ctx));
      // Back to Alpha, answer it: ask_user returned at once ("end your turn"); the answer comes
      // back as the next prompt, once the turn that asked is over.
      const shown = FakeGateway.text(await asked);
      t.check(!shown.isError && /"asked":"ask_/.test(shown.text), "ask_user tells the agent the card is shown", shown);
      await h.switchTo(panel, "Alpha");
      await h.answerAsk(panel, "Blue");
      const since = gw.prompts.length;
      gw.endTurn(sidA);
      const reply = await gw.waitPrompt((p) => p.sessionId === sidA && /回答 ask_/.test(p.text), { since });
      t.check(/Blue/.test(reply.text), "the answer reaches the agent as the next prompt in Alpha", reply.text);
      // Beta on screen; Alpha's turn finishes behind it: ● and a notification.
      await h.switchTo(panel, "Beta");
      await h.clearNotifications(ctx);
      gw.endTurn(sidA, "end_turn", "ALPHA FINISHED IN THE BACKGROUND");
      await h.until(panel, () => { const x = Array.from(document.querySelectorAll(".conv-tab")).find((e) => e.textContent.includes("Alpha")); return x && x.querySelector(".conv-tab-mark").textContent === "●"; }, "● on Alpha");
      t.ok("a background turn finishing marks its tab ●");
      const doneNotes = await h.until(null, () => notesFor(ctx, idA).then((n) => n.length && n), "a notification for Alpha's finished turn");
      const all = await h.notifications(ctx);
      t.check(doneNotes.length === 1, "chrome.notifications has the finished-turn notification", all);
      t.check(!(await h.visibleText(panel)).includes("ALPHA FINISHED"), "the background reply is not on screen");
      await h.switchTo(panel, "Alpha");
      t.check((await h.visibleText(panel)).includes("ALPHA FINISHED IN THE BACKGROUND"), "it is in Alpha's list when switched to");
      t.check((await h.markOf(panel, "Alpha")) === "", "● goes once Alpha is shown", await h.strip(panel));
    },
  },
  {
    name: "a pool-busy reply is an error with 重試, not recorded, not retried by itself",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sidA = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.poolBusy = true;
      await h.send(panel, "while the pool is full");
      await h.until(panel, () => !!Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden)?.querySelector(".error-bubble .retry-btn"), "the error bubble with 重試");
      const text = await h.visibleText(panel);
      t.check(text.includes("同時進行的對話已滿") && !text.includes("Service Busy"), "it says the pool is full, not the gateway's chat line", text.slice(-200));
      await h.sleep(3000);
      const sent = gw.prompts.filter((p) => p.sessionId === sidA && p.userText.includes("while the pool is full"));
      t.check(sent.length === 1, "not retried by itself (one session/prompt in 3 s)", sent.length);
      const idA = await h.convIdByTitle(ctx, "Alpha");
      const conv = (await h.storedConvs(ctx))[idA];
      t.check(!conv.messages.some((m) => m.kind === "received"), "nothing recorded as the agent's reply", conv.messages.map((m) => [m.kind, m.text]));
      gw.poolBusy = false;
      await panel.evaluate(() => Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden).querySelector(".error-bubble .retry-btn").click());
      await h.until(panel, () => { const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden); return l && l.textContent.includes("echo: while the pool is full"); }, "重試 sends it again and the reply arrives");
      t.check(gw.prompts.filter((p) => p.userText.includes("while the pool is full")).length === 2, "重試 sent the same prompt once more");
    },
  },
];
