// P2 part 2 (#144, ADR multi-conversation §4.2 / §5.2, Q5 / Q8): real tab groups. A switch
// collapses no group and moves the user from the other conversation's group to the new one's
// working tab; a background conversation's page tool expands its group if the user collapsed it by
// hand, and succeeds; a background screenshot is refused.
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

/** The agent opens `url` in conversation `sid` (its turn must be open) → the tab. */
async function agentOpens(ctx, sid, url, active = true) {
  const r = FakeGateway.text(await ctx.gw.callTool(sid, "katashiro.new_tab", { url, active }));
  if (r.isError) throw new Error(`new_tab failed: ${r.text}`);
  return h.until(null, async () => (await h.allTabs(ctx)).find((x) => x.url === url && x.groupId > 0 && x.status === "complete"), `${url} open, grouped and loaded`);
}

/** A conversation `title` whose agent opened `path` (one turn: send, new_tab, end). → { sid, tab } */
async function conversationWithTab(ctx, title, path, { fresh }) {
  const { gw, panel } = ctx;
  const sid = await h.namedConversation(ctx, panel, title, { fresh });
  gw.hold = true;
  const since = gw.prompts.length;
  await h.send(panel, `research ${title}`);
  await gw.waitPrompt((p) => p.sessionId === sid, { since });
  const tab = await agentOpens(ctx, sid, `${ctx.web.origin}/page/${path}`);
  gw.endTurn(sid, "end_turn", `opened ${path}`);
  await h.idle(panel);
  return { sid, tab };
}

export default [
  {
    name: "switching collapses no group and moves to the new conversation's working tab",
    async run(ctx, t) {
      const { panel } = ctx;
      const a = await conversationWithTab(ctx, "Alpha", "alpha-1", { fresh: false });
      const b = await conversationWithTab(ctx, "Beta", "beta-1", { fresh: true });
      t.check(a.tab.groupId !== b.tab.groupId, "each conversation's tab is in its own group", [a.tab.groupId, b.tab.groupId]);
      let groups = await h.tabGroups(ctx);
      const title = (id) => (groups.find((g) => g.id === id) || {}).title;
      t.check(title(a.tab.groupId) === "Alpha" && title(b.tab.groupId) === "Beta", "the groups are titled after their conversations", groups.map((g) => [g.id, g.title]));
      let active = await h.activeTab(ctx);
      t.check(active && active.id === b.tab.id, "the user is on Beta's page (the agent opened it in front)", active && active.url);

      // Switch to Alpha while the active tab is in Beta's group → Alpha's working tab comes forward.
      await h.switchTo(panel, "Alpha");
      active = await h.until(null, async () => { const x = await h.activeTab(ctx); return x && x.id === a.tab.id && x; }, "Alpha's working tab active").catch(() => null);
      t.check(active, "switching to Alpha moves the user to Alpha's working tab", (await h.activeTab(ctx)).url);
      await h.sleep(300);
      groups = await h.tabGroups(ctx);
      t.check(groups.length === 2 && groups.every((g) => g.collapsed === false), "no group collapsed by the switch", groups.map((g) => [g.title, g.collapsed]));
      // And back.
      await h.switchTo(panel, "Beta");
      active = await h.until(null, async () => { const x = await h.activeTab(ctx); return x && x.id === b.tab.id && x; }, "Beta's working tab active").catch(() => null);
      t.check(active, "switching back moves the user to Beta's working tab", (await h.activeTab(ctx)).url);
      await h.sleep(300);
      groups = await h.tabGroups(ctx);
      t.check(groups.every((g) => g.collapsed === false), "still no group collapsed", groups.map((g) => [g.title, g.collapsed]));
      // The user on a tab of their own: a switch leaves them there.
      await ctx.control.evaluate(() => chrome.tabs.getCurrent().then((x) => chrome.tabs.update(x.id, { active: true })));
      const own = await h.activeTab(ctx);
      await h.switchTo(panel, "Alpha");
      await h.sleep(500);
      t.check((await h.activeTab(ctx)).id === own.id, "a switch leaves the user on a tab outside every conversation's group", (await h.activeTab(ctx)).url);
    },
  },
  {
    name: "a background page tool expands a group collapsed by hand and succeeds; screenshot is refused",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const a = await conversationWithTab(ctx, "Alpha", "alpha-1", { fresh: false });
      // Alpha's agent keeps working (turn open) while the user moves on to Beta.
      const since = gw.prompts.length;
      await h.send(panel, "keep reading in the background");
      await gw.waitPrompt((p) => p.sessionId === a.sid, { since });
      await h.namedConversation(ctx, panel, "Beta");
      const active = await h.until(null, async () => { const x = await h.activeTab(ctx); return x && x.groupId !== a.tab.groupId && x; }, "the user is moved off Alpha's group");
      // The user collapses Alpha's group by hand.
      await ctx.control.evaluate((g) => chrome.tabGroups.update(g, { collapsed: true }), a.tab.groupId);
      let g = await ctx.control.evaluate((id) => chrome.tabGroups.get(id), a.tab.groupId);
      t.check(g.collapsed === true, "Alpha's group is collapsed (by hand)", g);
      // Alpha's agent reads its working tab from the background.
      const r = FakeGateway.text(await gw.callTool(a.sid, "katashiro.get_text", {}));
      t.check(!r.isError && /Body of alpha-1/.test(r.text), "the background get_text reads Alpha's working tab", r.text.slice(0, 200));
      g = await ctx.control.evaluate((id) => chrome.tabGroups.get(id), a.tab.groupId);
      t.check(g.collapsed === false, "…and expanded Alpha's group first", g);
      const now = await h.activeTab(ctx);
      t.check(now.id === active.id, "…without activating anything", now.url);
      t.check((await h.currentTitle(panel)) === "Beta", "the panel stays on Beta");
      const shot = FakeGateway.text(await gw.callTool(a.sid, "katashiro.screenshot", {}));
      t.check(shot.isError && /in the background in Katashiro/.test(shot.text), "a background screenshot is refused", shot.text.slice(0, 200));
      gw.endTurn(a.sid);
    },
  },
];
