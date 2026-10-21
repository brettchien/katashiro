// ⚡ command menu (command-core.js): ⚡ and ⏹ share one slot; Ctrl/⌘+. stops and Esc does not;
// typing "/" opens the menu and letters filter; c / r / m from ⚡; Reset session confirms on a
// Katashiro card and sends the bare /reset (after stopping a running reply, with the queue held);
// Switch model turns the gateway's /models list into a card and sends /model set N; typed
// /model set N switches directly; an unknown /word and a command with attachments are refused with
// a hint and nothing is sent; a leading space sends the text as a message. The fake gateway answers
// the slash commands with openab's own text (test/fixtures/openab-slash-replies.json).
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC";

const state = (panel) => panel.evaluate(() => {
  const vis = (id) => { const e = document.getElementById(id); return !!e && !e.hidden; };
  const menu = document.getElementById("cmd-menu");
  return {
    cmd: vis("cmd-btn"), stop: vis("stop-btn"), menu: !menu.hidden,
    items: [...menu.querySelectorAll(".cmd-item")].map((b) => b.dataset.cmd),
    selected: (menu.querySelector(".cmd-item.selected") || {}).dataset?.cmd || null,
    hint: vis("composer-hint") ? document.getElementById("composer-hint").textContent : null,
    input: document.getElementById("message-input").value,
  };
});
// Where a button sits: [left, top, width, height] in px. The top is taken relative to the input
// bar (the panel above it may shift by a sub-pixel as messages arrive; that is not the slot moving).
const slotRect = (panel, id) => panel.evaluate((i) => {
  const r = document.getElementById(i).getBoundingClientRect();
  const bar = document.querySelector(".chat-input-area").getBoundingClientRect();
  return [r.left, r.top - bar.top, r.width, r.height].map((v) => Math.round(v * 10) / 10);
}, id);
const focusInput = (panel) => panel.focus("#message-input");
const clearInput = (panel) => panel.evaluate(() => { const i = document.getElementById("message-input"); i.value = ""; i.dispatchEvent(new Event("input")); });
async function chord(panel, key) {
  await panel.keyboard.down("Control");
  await panel.keyboard.press(key);
  await panel.keyboard.up("Control");
}
const lastSystem = (panel) => panel.evaluate(() => {
  const l = [...document.querySelectorAll(".conv-messages")].find((e) => !e.hidden);
  const s = [...l.querySelectorAll(".system-text")];
  return s.length ? s[s.length - 1].textContent : "";
});
const echoes = (panel) => panel.evaluate(() => {
  const l = [...document.querySelectorAll(".conv-messages")].find((e) => !e.hidden);
  return [...l.querySelectorAll(".message.command .command-text")].map((e) => e.textContent);
});
const card = (panel) => panel.evaluate(() => {
  const l = [...document.querySelectorAll(".conv-messages")].find((e) => !e.hidden);
  const c = [...l.querySelectorAll(".command-card")].pop();
  return c && { pending: c.classList.contains("pending"), text: c.textContent, options: [...c.querySelectorAll(".ask-card-option")].map((b) => b.textContent), current: [...c.querySelectorAll(".ask-card-option.current")].map((b) => b.textContent) };
});
const pickCard = (panel, label) => panel.evaluate((l) => {
  const c = [...document.querySelectorAll(".conv-messages:not([hidden]) .command-card.pending")].pop();
  const b = c && [...c.querySelectorAll(".ask-card-option")].find((x) => x.textContent === l);
  if (b) b.click();
  return !!b;
}, label);

export default [
  {
    name: "⚡/⏹ share one slot; Ctrl+. stops, Esc does not; the menu lists Cancel first while replying",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Cmd", { fresh: false });
      // One finished turn first, so the composer is in its after-send state for both measurements.
      await h.send(panel, "hello");
      await gw.waitPrompt((p) => p.sessionId === sid);
      await h.idle(panel);
      let s = await state(panel);
      t.check(s.cmd && !s.stop, "idle: ⚡ shows, ⏹ does not", s);
      const idleRect = await slotRect(panel, "cmd-btn");
      const sendRect = await slotRect(panel, "send-btn");

      gw.hold = true;
      let since = gw.prompts.length;
      await h.send(panel, "a long answer please");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      await h.until(panel, () => !document.getElementById("stop-btn").hidden, "⏹ while replying");
      s = await state(panel);
      t.check(!s.cmd && s.stop, "replying: ⏹ shows instead of ⚡", s);
      t.check(JSON.stringify(await slotRect(panel, "stop-btn")) === JSON.stringify(idleRect), "⏹ sits exactly where ⚡ was", [idleRect, await slotRect(panel, "stop-btn")]);
      t.check(JSON.stringify(await slotRect(panel, "send-btn")) === JSON.stringify(sendRect), "the send button does not move");

      await focusInput(panel);
      const cancels = gw.cancels.length;
      await panel.keyboard.press("Escape");
      await h.sleep(400);
      t.check(gw.cancels.length === cancels && gw.openPrompts(sid).length === 1, "Esc does not stop the reply");

      await chord(panel, "/");
      s = await state(panel);
      t.check(s.menu && s.items.join() === "cancel,reset,model" && s.selected === "cancel", "Ctrl+/ while replying: Cancel first and pre-selected", s);
      await panel.keyboard.press("Escape");
      s = await state(panel);
      t.check(!s.menu && gw.openPrompts(sid).length === 1, "Esc closes the menu, the reply goes on", s);

      await chord(panel, ".");
      await h.until(null, () => gw.cancels.includes(sid), "session/cancel from Ctrl+.");
      await h.idle(panel);
      s = await state(panel);
      t.check(s.cmd && !s.stop, "after the stop: ⚡ is back", s);
      t.check(JSON.stringify(await slotRect(panel, "cmd-btn")) === JSON.stringify(idleRect), "⚡ is back in the same place");

      // The menu's Cancel (⚡ → c) stops a reply too; never queued, no prompt sent for it.
      since = gw.prompts.length;
      await h.send(panel, "another long one");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      await h.until(panel, () => !document.getElementById("stop-btn").hidden, "⏹ again");
      const n = gw.cancels.length;
      await focusInput(panel);
      await chord(panel, "/");
      await panel.keyboard.press("c");
      await h.until(null, () => gw.cancels.length > n, "session/cancel from the menu's c");
      await h.idle(panel);
      t.check(gw.prompts.length === since + 1, "Cancel sent no prompt", gw.prompts.length - since);
      gw.hold = false;
    },
  },
  {
    name: "typing / opens the menu and filters; unknown /words are refused; a leading space is a message",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Typed", { fresh: false });
      await focusInput(panel);
      await panel.keyboard.type("/");
      let s = await state(panel);
      t.check(s.menu && s.items.join() === "reset,model,cancel" && s.selected === "reset", "/ opens the menu (idle: Reset, Switch model, Cancel)", s);
      await panel.keyboard.type("r");
      s = await state(panel);
      t.check(s.menu && s.items.join() === "reset" && s.selected === "reset" && s.input === "/r", "/r → only Reset session, pre-selected; letters filter, not run", s);
      await panel.keyboard.press("Escape");
      s = await state(panel);
      t.check(!s.menu && s.input === "/r", "Esc closes the menu and keeps the text", s);
      await clearInput(panel);

      const sinceP = gw.prompts.length;
      const sinceC = gw.commands.length;
      for (const word of ["/help", "/agents", "/etc/hosts", "/tmp foo"]) {
        await clearInput(panel);
        await focusInput(panel);
        await panel.keyboard.type(word);
        await panel.keyboard.press("Enter");
        s = await state(panel);
        t.check(s.hint === "No such command — type / to see the commands" && s.input === word, `${word}: kept, with the hint`, s);
      }
      await h.sleep(300);
      t.check(gw.prompts.length === sinceP && gw.commands.length === sinceC, "none of them was sent");
      await panel.keyboard.type("x");
      t.check((await state(panel)).hint === null, "the hint goes on the next keystroke");

      await clearInput(panel);
      await h.send(panel, " /tmp is full");
      const p = await gw.waitPrompt((x) => x.sessionId === sid, { since: sinceP });
      t.check(/^\[.* user\]$/.test(p.text.split("\n")[0]) && p.userText === "/tmp is full", "a leading space: sent as a message, with the header", p.text);
      await h.idle(panel);
    },
  },
  {
    name: "Reset session: confirm card, bare /reset, a muted result; Switch model: list card and /model set N",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Reset", { fresh: false });
      // ⚡ → r: the confirm card, nothing sent yet.
      await panel.click("#cmd-btn");
      let s = await state(panel);
      t.check(s.menu && s.items.join() === "reset,model,cancel", "⚡ opens the menu", s);
      await panel.keyboard.press("r");
      await h.until(panel, () => !!document.querySelector(".conv-messages:not([hidden]) .command-card.pending"), "the reset card");
      const c = await card(panel);
      t.check(c.text.includes("Clear the agent's memory of this conversation?") && c.options.join() === "Reset session,Keep", "a Katashiro card asks first", c);
      t.check(gw.commands.length === 0, "nothing sent before the confirm");
      await pickCard(panel, "Reset session");
      await h.until(null, () => gw.commands.some((x) => x.text === "/reset"), "the /reset prompt");
      t.check(gw.commands.at(-1).text === "/reset" && gw.commands.at(-1).sessionId === sid, "exactly \"/reset\", no header, this session", gw.commands.at(-1));
      await h.until(panel, () => [...document.querySelectorAll(".system-text")].some((e) => e.textContent.startsWith("🔄 Session reset")), "the reset line");
      t.check((await lastSystem(panel)).startsWith("🔄 Session reset —"), "a muted Katashiro line, not the gateway's text", await lastSystem(panel));
      t.check(!(await h.visibleText(panel)).includes("Start a new conversation"), "the gateway's raw English is not shown");
      t.check((await echoes(panel)).includes("/reset"), "the command shows muted", await echoes(panel));

      // Switch model via Ctrl+/ → m.
      await focusInput(panel);
      await chord(panel, "/");
      await panel.keyboard.press("m");
      await h.until(null, () => gw.commands.some((x) => x.text === "/models"), "the /models prompt");
      await h.until(panel, () => !!document.querySelector(".conv-messages:not([hidden]) .command-card.pending"), "the model card");
      const m = await card(panel);
      t.check(m.options.join("|") === "Default (recommended)|Opus ✅|Sonnet|Haiku|Opus (1M context)", "the card lists the gateway's models, the current one ✅", m.options);
      t.check(m.current.join() === "Opus ✅", "the current one is marked", m.current);
      await pickCard(panel, "Sonnet");
      await h.until(null, () => gw.commands.some((x) => x.text === "/model set 3"), "/model set 3");
      await h.until(panel, () => [...document.querySelectorAll(".system-text")].some((e) => e.textContent === "✅ Switched to Sonnet"), "the switched line");
      t.check(gw.currentModel === 2, "the gateway switched", gw.currentModel);

      // Typed: /model set 2 switches directly, no card.
      const cards = await panel.evaluate(() => document.querySelectorAll(".command-card").length);
      await h.send(panel, "/model set 2");
      await h.until(null, () => gw.commands.some((x) => x.text === "/model set 2"), "/model set 2");
      await h.until(panel, () => [...document.querySelectorAll(".system-text")].some((e) => e.textContent === "✅ Switched to Opus"), "switched to Opus");
      t.check(await panel.evaluate(() => document.querySelectorAll(".command-card").length) === cards, "no card for a typed /model set N");
      t.check((await state(panel)).input === "", "the composer is cleared");
      // Typed /reset still asks.
      await h.send(panel, "/reset");
      await h.until(panel, () => !!document.querySelector(".conv-messages:not([hidden]) .command-card.pending"), "a typed /reset asks too");
      await pickCard(panel, "Keep");
      t.check(gw.commands.filter((x) => x.text === "/reset").length === 1, "Keep sends nothing");

      // Nothing of it reaches the agent's transcript.
      const hist = FakeGateway.text(await gw.callTool(sid, "katashiro.chat_history", {})).text;
      t.check(!/\/reset|\/models|\/model set|Switched to|Session reset/.test(hist), "chat_history has none of the commands or results", hist.slice(-300));
    },
  },
  {
    name: "Reset while replying stops the reply first and holds the queue; attachments block a command",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Busy", { fresh: false });
      gw.hold = true;
      const since = gw.prompts.length;
      await h.send(panel, "first");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      await h.until(panel, () => !document.getElementById("stop-btn").hidden, "replying");
      await h.send(panel, "queued meanwhile");
      // Switch model is refused while replying (the gateway would answer Session busy).
      await h.send(panel, "/models");
      t.check((await state(panel)).hint === "The agent is replying — stop it (⏹) before switching model", "Switch model waits for the reply", await state(panel));
      await clearInput(panel);
      // Menu: Cancel first; ↓ to Reset session, Enter.
      await focusInput(panel);
      await chord(panel, "/");
      await panel.keyboard.press("ArrowDown");
      t.check((await state(panel)).selected === "reset", "↓ selects Reset session");
      await panel.keyboard.press("Enter");
      await h.until(panel, () => !!document.querySelector(".conv-messages:not([hidden]) .command-card.pending"), "the reset card");
      t.check((await card(panel)).text.includes("The reply in progress is stopped first."), "the card says the reply is stopped first");
      await pickCard(panel, "Reset session");
      await h.until(null, () => gw.commands.some((x) => x.text === "/reset" && x.sessionId === sid), "/reset after the stop");
      t.check(gw.cancels.includes(sid), "the reply was cancelled first");
      // The queued message goes out after the reset, to the same session, framed as usual.
      const q = await gw.waitPrompt((p) => p.sessionId === sid && p.userText === "queued meanwhile", { since });
      t.check(q.at >= gw.log.find((l) => l.method === "session/prompt" && l.params.prompt[0].text === "/reset").at, "the queued message waited for the reset");
      gw.endTurn(sid, "end_turn", "ok");
      await h.idle(panel);
      gw.hold = false;

      // A pasted image pending: Reset and Switch model are refused, nothing sent.
      await panel.evaluate((b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "dot.png", { type: "image/png" }));
        const input = document.getElementById("message-input");
        input.focus();
        input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, PNG);
      await h.until(panel, () => document.querySelectorAll(".attach-thumb").length === 1, "an image staged");
      const n = gw.commands.length;
      await h.send(panel, "/model set 1");
      const s = await state(panel);
      t.check(s.hint === "Commands don't take attachments — send or remove them first" && s.input === "/model set 1", "refused with the hint, text kept", s);
      await h.sleep(300);
      t.check(gw.commands.length === n, "nothing sent");
    },
  },
];
