// A conn turned off (disconnect()) with something waiting in a conversation's queue (#190 review a, b).
import * as h from "../helpers.mjs";

// #190 review a, b: what waits in the queue of a conn that is turned off — messages typed while
// a turn ran, a turn requeued after a socket drop — is dropped with a line, on every path that calls
// disconnect() (turn off, retarget, remove), and never sent later.
const QUEUE_DROPPED = "已中斷與 Fake 的連線：排隊中的訊息沒有送出，不會自動重送";
const RESEND_TAKEN_BACK = "已中斷與 Fake 的連線：上面說的「重新連線後會重送」不會發生";
const offState = (panel) => panel.evaluate(() => {
  const c = globalThis.__offConn;
  const states = [...c.states.values()];
  return {
    pending: c.pendingReqs.size, active: states.some((s) => s.turnActive),
    queued: states.reduce((n, s) => n + s.promptQueue.length, 0),
    ids: states.reduce((n, s) => n + s.queuedMsgIds.length, 0),
    resend: states.some((s) => s.resendPending),
  };
});
const empty = (st) => st.pending === 0 && st.queued === 0 && st.ids === 0 && !st.active && !st.resend;

// A turn in flight with two messages queued behind it; resolves once both wait in the queue.
async function turnWithQueue(ctx, panel, gw, sid) {
  gw.hold = true;
  await h.send(panel, "the first question");
  await gw.waitPrompt((p) => p.sessionId === sid && /the first question/.test(p.userText));
  gw.chunk(sid, "Partly ");
  await h.until(panel, () => document.body.innerText.includes("Partly"), "the partial reply on screen");
  await h.send(panel, "queued one");
  await h.send(panel, "queued two");
  await h.until(panel, () => room.find((c) => c.enabled).cur.promptQueue.length === 2, "two messages queued behind the turn");
}

// Off and on again (same Conn): only a new message goes out — not the stopped turn, not the queue.
async function onlyNewGoesOut(panel, gw, sid, turnOn) {
  gw.hold = false;
  const n = gw.prompts.length;
  await panel.evaluate(turnOn);
  await h.send(panel, "a fresh message");
  const p = await gw.waitPrompt((x) => x.sessionId === sid, { since: n, ms: 15000 });
  return /a fresh message/.test(p.userText) && !/queued one|queued two|the first question|tell me again/.test(p.userText) && !/it is a resend/.test(p.text) ? null : p.text.slice(0, 300);
}

export default [
  {
    name: "an agent turned off mid-turn with messages queued: the queue is dropped with a line, never sent later",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      const sid = await h.sessionOf(ctx, "Alpha");
      await turnWithQueue(ctx, panel, gw, sid);
      await panel.evaluate(() => { globalThis.__offConn = room.find((c) => c.enabled); globalThis.__offConn.disconnect(); });
      await h.until(panel, (m) => document.body.innerText.includes(m), "the queue-dropped line", QUEUE_DROPPED, 5000);
      const shown = await h.visibleText(panel);
      t.check(/已中斷與 Fake 的連線：這個回合停在一半/.test(shown), "the stopped line for the turn", shown.slice(-400));
      t.check(shown.indexOf("這個回合停在一半") < shown.indexOf(QUEUE_DROPPED), "the queue line comes under the stopped line", shown.slice(-400));
      t.check(!/重新連線後會重送/.test(shown), "no promise of a resend", shown.slice(-400));
      const st = await offState(panel);
      t.check(empty(st), "nothing pending, queued or active", JSON.stringify(st));
      await h.idle(panel, "the stop button is gone");
      const bad = await onlyNewGoesOut(panel, gw, sid, () => globalThis.__offConn.connect());
      t.check(!bad, "turned back on: the queued messages are not sent, only the new one", bad);
    },
  },
  {
    name: "a socket dropped (resend promised), then the agent turned off while reconnecting: the promise is taken back",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      const sid = await h.sessionOf(ctx, "Alpha");
      gw.hold = true;
      await h.send(panel, "tell me again");
      await gw.waitPrompt((p) => p.sessionId === sid && /tell me again/.test(p.userText));
      gw.refuse = true;                                   // the gateway is down: reconnects keep failing
      for (const ws of gw.sockets) ws.terminate();
      await h.until(panel, () => document.body.innerText.includes("連線中斷：Fake"), "the「重新連線後會重送」line");
      const before = await panel.evaluate(() => { const s = room.find((c) => c.enabled).cur; return { q: s.promptQueue.length, resend: s.resendPending }; });
      t.check(before.q === 1 && before.resend, "the turn waits requeued, a resend promised", JSON.stringify(before));
      await panel.evaluate(() => { globalThis.__offConn = room.find((c) => c.enabled); globalThis.__offConn.disconnect(); });
      await h.until(panel, (m) => document.body.innerText.includes(m), "the line taking the resend back", RESEND_TAKEN_BACK, 5000);
      const st = await offState(panel);
      t.check(empty(st), "nothing queued, no resend pending", JSON.stringify(st));
      gw.refuse = false;
      const n = gw.prompts.length;
      await h.sleep(1500);
      t.check(gw.prompts.length === n, "nothing is resent while it is off", String(gw.prompts.length - n));
      const bad = await onlyNewGoesOut(panel, gw, sid, () => globalThis.__offConn.connect());
      t.check(!bad, "turned back on: the requeued turn is not resent, only the new message goes", bad);
    },
  },
  {
    name: "an agent retargeted mid-turn with messages queued: the old Conn drops its queue with a line; the new one sends none of it",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      const sid = await h.sessionOf(ctx, "Alpha");
      await turnWithQueue(ctx, panel, gw, sid);
      // reconnectConn: a token / URL change replaces the Conn (here the same URL, so it reconnects).
      await panel.evaluate(() => { const i = room.findIndex((c) => c.enabled); globalThis.__offConn = room[i]; reconnectConn(i); });
      await h.until(panel, (m) => document.body.innerText.includes(m), "the queue-dropped line", QUEUE_DROPPED, 5000);
      const st = await offState(panel);
      t.check(empty(st), "the old Conn: nothing pending, queued or active", JSON.stringify(st));
      await h.idle(panel, "the stop button is gone");
      gw.hold = false;
      const n = gw.prompts.length;
      await h.sleep(1500);
      t.check(gw.prompts.slice(n).every((p) => !/queued one|queued two|the first question/.test(p.userText)), "the new Conn sends none of the old queue", JSON.stringify(gw.prompts.slice(n).map((p) => p.userText)));
      await h.send(panel, "a fresh message");
      const p = await gw.waitPrompt((x) => /a fresh message/.test(x.userText), { since: n, ms: 15000 });
      t.check(!/queued one|queued two/.test(p.userText), "the next message goes alone", p.userText.slice(0, 200));
    },
  },
  {
    name: "an agent removed mid-turn with messages queued: its queue is dropped with a line",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      const sid = await h.sessionOf(ctx, "Alpha");
      await turnWithQueue(ctx, panel, gw, sid);
      await panel.evaluate(() => { globalThis.confirm = () => true; const i = room.findIndex((c) => c.enabled); globalThis.__offConn = room[i]; deleteAgent(i); });
      await h.until(panel, (m) => document.body.innerText.includes(m), "the queue-dropped line", QUEUE_DROPPED, 5000);
      const st = await offState(panel);
      t.check(empty(st), "nothing pending, queued or active", JSON.stringify(st));
      const n = gw.prompts.length;
      await h.sleep(1500);
      t.check(gw.prompts.length === n, "nothing more is sent", String(gw.prompts.length - n));
    },
  },
];
