// #139: after the extension reloads, chrome.storage.session — where the panel keeps conversation →
// tab group — is cleared, while the tab groups survive. The conversation takes back the one group
// in the window with its title and the group color, instead of making a second one.
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

export default [
  {
    name: "after an extension reload, a conversation's next tab joins its existing group (one group only)",
    async run(ctx, t) {
      const { gw } = ctx;
      const sid = await h.namedConversation(ctx, ctx.panel, "Alpha", { fresh: false });
      gw.hold = true;
      let since = gw.prompts.length;
      await h.send(ctx.panel, "open a page");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      const url = `${ctx.web.origin}/page/alpha-1`;
      const r = FakeGateway.text(await gw.callTool(sid, "katashiro.new_tab", { url, active: false }));
      if (r.isError) throw new Error(`new_tab: ${r.text}`);
      const web = await h.until(null, async () => (await h.allTabs(ctx)).find((x) => x.url === url && x.groupId > 0), "the agent's page in Alpha's group");
      gw.endTurn(sid);
      await h.idle(ctx.panel);
      let groups = (await h.tabGroups(ctx)).filter((g) => g.title === "Alpha");
      t.check(groups.length === 1, "before the reload: one group titled Alpha", groups);

      // Reload the extension (as chrome://extensions ↻ does). The panel, the control page and every
      // canvas tab close; the web page stays in its group.
      await h.reloadExtension(ctx);
      const kept = (await h.allTabs(ctx)).find((x) => x.id === web.id);
      t.check(kept && kept.groupId === web.groupId, "the agent's page is still in its group after the reload", kept);
      const resumes = gw.methods("session/resume").length;
      ctx.panel = await h.openSidePanel(ctx, ctx.control);
      await h.until(null, () => gw.methods("session/resume").length > resumes, "the reopened panel resumes Alpha's session");
      await h.until(ctx.panel, () => (document.querySelector(".conv-tab.current .conv-tab-title") || {}).textContent === "Alpha", "Alpha is back on screen");

      // Alpha's agent opens a canvas: it must join Alpha's existing group.
      since = gw.prompts.length;
      await h.send(ctx.panel, "now write notes");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      const c = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { title: "Notes", kind: "markdown", content: "# Notes\n\nText." }));
      t.check(!c.isError, "canvas_open works after the reload", c.text);
      const cvId = (/id (cv_[0-9a-f]+)/.exec(c.text) || [])[1];
      const cv = await h.until(null, async () => (await h.allTabs(ctx)).find((x) => x.url.includes(`id=${cvId}`) && x.groupId > 0), "the canvas tab grouped");
      await h.sleep(500);
      groups = (await h.tabGroups(ctx)).filter((g) => g.title === "Alpha");
      t.check(groups.length === 1, "one group titled Alpha, not two", groups.map((g) => [g.id, g.title]));
      t.check(cv.groupId === web.groupId, "the canvas joined the group of the agent's page", { canvas: cv.groupId, page: web.groupId });
      gw.endTurn(sid);
    },
  },
];
