// #141 (ADR multi-conversation §4.3, Q6): a canvas the agent puts in front with canvas_highlight /
// canvas_goto becomes the conversation's working tab, and the user's next send brings it forward —
// with the real canvas tab answering the side panel over runtime messaging.
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const workingTabOf = async (ctx, title) => {
  const id = await h.convIdByTitle(ctx, title);
  const c = (await h.storedConvs(ctx))[id];
  return c && c.workingTab;
};
const canvasTabOf = async (ctx, cvId) => (await h.allTabs(ctx)).find((x) => x.url.startsWith(ctx.ext("canvas.html")) && x.url.includes(`id=${cvId}`));
const toControlTab = (ctx) => ctx.control.evaluate(() => chrome.tabs.getCurrent().then((x) => chrome.tabs.update(x.id, { active: true })));

/** canvas_open in a background tab → its id, once its tab has loaded. */
async function openCanvas(ctx, sid, args) {
  const r = FakeGateway.text(await ctx.gw.callTool(sid, "katashiro.canvas_open", args));
  if (r.isError) throw new Error(`canvas_open: ${r.text}`);
  const cvId = (/id (cv_[0-9a-f]+)/.exec(r.text) || [])[1];
  if (!cvId) throw new Error(`canvas_open: no id in ${r.text}`);
  await h.until(null, async () => { const x = await canvasTabOf(ctx, cvId); return x && x.status === "complete"; }, `the tab of ${cvId}`);
  return cvId;
}

export default [
  {
    name: "canvas_highlight / canvas_goto make the canvas the working tab; the next send brings it forward",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.hold = true;
      let since = gw.prompts.length;
      await h.send(panel, "write me notes");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      const notes = await openCanvas(ctx, sid, { title: "Notes", kind: "markdown", content: "# Intro\n\nFirst paragraph.\n\n# Details\n\nSecond paragraph." });
      let tab = await canvasTabOf(ctx, notes);
      t.check(tab && !tab.active, "canvas_open opens the canvas in a background tab", tab);
      t.check((await workingTabOf(ctx, "Alpha")) == null || (await workingTabOf(ctx, "Alpha")).id !== tab.id, "…which does not become the working tab", await workingTabOf(ctx, "Alpha"));
      let r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_highlight", { id: notes, heading: "Details" }));
      t.check(!r.isError, "canvas_highlight works on the real canvas tab", r.text);
      await h.until(null, async () => { const w = await workingTabOf(ctx, "Alpha"); return w && w.id === tab.id; }, "canvas_highlight makes the canvas the working tab");
      t.ok("canvas_highlight makes the canvas tab the working tab");
      t.check((await h.activeTab(ctx)).id === tab.id, "…and brought it to the front", (await h.activeTab(ctx)).url);
      gw.endTurn(sid);
      await h.idle(panel);
      // The user goes back to their own tab and sends: Q6 brings the canvas forward.
      await toControlTab(ctx);
      t.check((await h.activeTab(ctx)).id !== tab.id, "the user is on their own tab");
      since = gw.prompts.length;
      await h.send(panel, "and now a deck");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      await h.until(null, async () => (await h.activeTab(ctx)).id === tab.id, "Q6: the send brings the canvas forward");
      t.ok("Q6: the user's send brings the highlighted canvas forward");

      // canvas_goto on a slides canvas: same.
      const deck = await openCanvas(ctx, sid, { title: "Deck", kind: "slides", content: "# One\n\n---\n\n# Two\n\n---\n\n# Three" });
      const deckTab = await canvasTabOf(ctx, deck);
      t.check(deckTab && !deckTab.active, "the deck opens in a background tab", deckTab);
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_goto", { id: deck, slide: 2 }));
      t.check(!r.isError && /slide 2 of 3/.test(r.text), "canvas_goto shows slide 2 of 3", r.text);
      await h.until(null, async () => { const w = await workingTabOf(ctx, "Alpha"); return w && w.id === deckTab.id; }, "canvas_goto makes the deck the working tab");
      t.ok("canvas_goto makes the deck tab the working tab");
      gw.endTurn(sid);
      await h.idle(panel);
      await toControlTab(ctx);
      since = gw.prompts.length;
      await h.send(panel, "next please");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      await h.until(null, async () => (await h.activeTab(ctx)).id === deckTab.id, "Q6: the send brings the deck forward");
      t.ok("Q6: the user's send brings the deck forward, not the earlier canvas");
      tab = await canvasTabOf(ctx, notes);
      t.check(tab && tab.groupId > 0 && tab.groupId === (await canvasTabOf(ctx, deck)).groupId, "both canvases are in the conversation's group", [tab && tab.groupId, deckTab.groupId]);
      gw.endTurn(sid);
    },
  },
];
