// A socket that drops mid-turn (agent-per-conversation §7 I8, seen live 2026-10-16 22:20:57 TPE):
// the requeued prompt is resent with RESEND_HINT so the agent answers again rather than treating it
// as a duplicate, and the chat says the reply was cut, under whatever part of it had arrived.
import * as h from "../helpers.mjs";

export default [
  {
    name: "a socket dropped mid-turn: the resend says it is a resend; the chat says the reply was cut",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      const sid = await h.sessionOf(ctx, "Alpha");
      gw.hold = true;
      await h.send(panel, "tell me a long story");
      const p1 = await gw.waitPrompt((p) => p.sessionId === sid);
      t.check(!/it is a resend/.test(p1.text), "the first send carries no resend line");
      gw.chunk(sid, "Once upon a ");
      await h.until(panel, () => document.body.innerText.includes("Once upon a"), "the partial reply on screen");
      const n = gw.prompts.length;
      for (const ws of gw.sockets) ws.terminate();        // a 1006: no close frame, as on 22:20:57
      const p2 = await gw.waitPrompt((p) => p.sessionId === sid, { since: n, ms: 15000 });
      t.check(/it is a resend, not a duplicate/.test(p2.text) && /tell me a long story/.test(p2.userText), "the resend carries the resend line and the same message", p2.text.slice(0, 300));
      const shown = await h.visibleText(panel);
      t.check(/Once upon a/.test(shown), "the part of the reply that arrived stays on screen", shown.slice(-300));
      t.check(/連線中斷：Fake 上面的回覆不完整/.test(shown), "the chat says the reply was cut and will be resent", shown.slice(-300));
      gw.chunk(sid, "the full story");
      gw.endTurn(sid);
      await h.idle(panel);
      gw.hold = false;
      await h.send(panel, "thanks");
      const p3 = await gw.waitPrompt((p) => p.sessionId === sid && /thanks/.test(p.userText));
      t.check(!/it is a resend/.test(p3.text), "the next message carries no resend line", p3.text.slice(0, 200));
    },
  },
  {
    name: "a manual reconnect mid-turn: the turn is cancelled on the old socket and resent on the new one",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      const sid = await h.sessionOf(ctx, "Alpha");
      gw.hold = true;
      await h.send(panel, "a slow question");
      await gw.waitPrompt((p) => p.sessionId === sid && /a slow question/.test(p.userText));
      const n = gw.prompts.length;
      // The roster chip's R2 click (shown on an unhealthy link) calls connect() on the conn.
      await panel.evaluate(() => room.find((c) => c.enabled).connect());
      await gw.waitFor(() => gw.cancels.includes(sid), "session/cancel on the old socket");
      t.ok("the turn was cancelled before the old socket closed");
      const p2 = await gw.waitPrompt((p) => p.sessionId === sid, { since: n, ms: 15000 });
      t.check(/it is a resend, not a duplicate/.test(p2.text) && /a slow question/.test(p2.userText), "resent at once on the new socket, with the resend line", p2.text.slice(0, 300));
      const shown = await h.visibleText(panel);
      t.check(/連線中斷：Fake/.test(shown), "the chat says it will be resent", shown.slice(-300));
      gw.endTurn(sid, "end_turn", "the answer");
      await h.idle(panel);
      t.check(/the answer/.test(await h.visibleText(panel)), "the resent turn's reply arrives");
      t.check(await panel.evaluate(() => room.find((c) => c.enabled).pendingReqs.size) === 0, "nothing of the old socket is left pending (no timeout later)");
    },
  },
  {
    name: "an agent turned off mid-turn: the turn ends at once as stopped, never promises a resend, never resends",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      const sid = await h.sessionOf(ctx, "Alpha");
      gw.hold = true;
      await h.send(panel, "a question for later");
      await gw.waitPrompt((p) => p.sessionId === sid && /a question for later/.test(p.userText));
      gw.chunk(sid, "Half an ");
      await h.until(panel, () => document.body.innerText.includes("Half an"), "the partial reply on screen");
      // Removing / retargeting the agent, or archiving its last open conversation, calls disconnect().
      await panel.evaluate(() => { globalThis.__offConn = room.find((c) => c.enabled); globalThis.__offConn.disconnect(); });
      await gw.waitFor(() => gw.cancels.includes(sid), "session/cancel before the socket closed");
      // At once — not ~10 min later, when the turn's idle deadline would have fired.
      await h.until(panel, () => document.body.innerText.includes("已中斷與 Fake 的連線"), "the stopped line", undefined, 5000);
      const shown = await h.visibleText(panel);
      t.check(/已中斷與 Fake 的連線：這個回合停在一半，不會自動重送/.test(shown), "the chat says the turn stopped and will not be resent", shown.slice(-300));
      t.check(!/重新連線後會重送/.test(shown), "no promise of a resend", shown.slice(-300));
      t.check(/Half an/.test(shown), "the part of the reply that arrived stays on screen");
      const st = await panel.evaluate(() => {
        const c = globalThis.__offConn;
        const states = [...c.states.values()];
        return { pending: c.pendingReqs.size, queued: states.reduce((n, s) => n + s.promptQueue.length, 0), active: states.some((s) => s.turnActive) };
      });
      t.check(st.pending === 0 && st.queued === 0 && !st.active, "nothing pending, nothing requeued, no turn active", JSON.stringify(st));
      await h.idle(panel, "the stop button is gone");
      // Turned back on: the stopped turn is not resent on the new socket; only the next message goes.
      gw.hold = false;
      const n = gw.prompts.length;
      await panel.evaluate(() => globalThis.__offConn.connect());
      await h.send(panel, "a new question");
      const p2 = await gw.waitPrompt((p) => p.sessionId === sid, { since: n, ms: 15000 });
      t.check(/a new question/.test(p2.userText) && !/a question for later/.test(p2.userText) && !/it is a resend/.test(p2.text), "after reconnecting, only the new message goes out", p2.text.slice(0, 300));
    },
  },
];
