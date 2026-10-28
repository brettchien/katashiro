// #205: a conversation works in its side panel's window. The tabs its agent opens land there and
// join its one group, page tools act on that window's active tab, and switch_tab refuses a tab in
// another window — even while another window is the last focused one.
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

export default [
  {
    name: "with another window focused, new_tab, page tools and switch_tab stay in the panel's window",
    async run(ctx, t) {
      const { gw } = ctx;
      const sid = await h.namedConversation(ctx, ctx.panel, "Alpha", { fresh: false });
      const win1 = await ctx.panel.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));

      // Window 2, created focused: Chrome's last-focused window from here on (no OS focus in headless,
      // so its model is what tabs.query({ lastFocusedWindow }) reads).
      const url2 = `${ctx.web.origin}/page/window-2`;
      const win2 = await ctx.control.evaluate((u) => chrome.windows.create({ url: u, type: "normal", focused: true }).then((w) => w.id), url2);
      const other = await h.until(null, async () => (await h.allTabs(ctx)).find((x) => x.windowId === win2 && x.url === url2), "window 2's page loaded");
      const focused = await ctx.control.evaluate(() => chrome.windows.getLastFocused().then((w) => w.id));
      t.check(focused === win2, "window 2 is the last-focused window", { focused, win1, win2 });

      gw.hold = true;
      let since = gw.prompts.length;
      await h.send(ctx.panel, "open a page");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      // The send focuses nothing in headless; make sure window 2 is still the last focused one.
      await ctx.control.evaluate((w) => chrome.windows.update(w, { focused: true }), win2);

      const url = `${ctx.web.origin}/page/alpha-1`;
      const r = FakeGateway.text(await gw.callTool(sid, "katashiro.new_tab", { url }));
      t.check(!r.isError, "new_tab works", r.text);
      const opened = await h.until(null, async () => (await h.allTabs(ctx)).find((x) => x.url === url && x.groupId > 0), "the agent's page grouped");
      t.check(opened.windowId === win1, "new_tab opened in the panel's window, not the focused one", { opened: opened.windowId, win1, win2 });
      const groups = (await h.tabGroups(ctx)).filter((g) => g.title === "Alpha");
      t.check(groups.length === 1 && groups[0].windowId === win1, "one group titled Alpha, in the panel's window", groups);

      // A page tool reads the panel window's active tab (the page just opened), not window 2's.
      const txt = FakeGateway.text(await gw.callTool(sid, "katashiro.get_text", {}));
      t.check(/Body of alpha-1/.test(txt.text) && !/Body of window-2/.test(txt.text), "get_text read the panel window's active tab", txt.text.slice(0, 200));

      // switch_tab to window 2's tab: refused, nothing activated or focused there.
      const sw = FakeGateway.text(await gw.callTool(sid, "katashiro.switch_tab", { url: "/page/window-2" }));
      t.check(sw.isError && /another window/.test(sw.text), "switch_tab to a tab in another window is refused", sw.text);
      const listing = FakeGateway.text(await gw.callTool(sid, "katashiro.tabs", {}));
      t.check(new RegExp(`window ${win1} \\(your window\\)`).test(listing.text) && !new RegExp(`window ${win2} \\(your window\\)`).test(listing.text), "tabs tags the panel's window as yours", listing.text);
      const otherNow = (await h.allTabs(ctx)).find((x) => x.id === other.id);
      t.check(otherNow && otherNow.groupId === -1, "window 2's page was not pulled into a group", otherNow);
      gw.endTurn(sid);
      await h.idle(ctx.panel);
    },
  },
];
