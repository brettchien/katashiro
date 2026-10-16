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
];
