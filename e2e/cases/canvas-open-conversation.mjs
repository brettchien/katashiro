// Multi-conversation §7.2: a canvas tab's 🗨️ opens its conversation in the real side panel, over
// real runtime messaging — switched to while it is open, reopened (archived) from a canvas tab the
// gallery opened ungrouped, which then sits in the conversation's group with no duplicate.
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const canvasTabsOf = async (ctx, cvId) => (await h.allTabs(ctx)).filter((x) => x.url.startsWith(ctx.ext("canvas.html")) && x.url.includes(`id=${cvId}`) && !x.url.includes("view="));
const canvasPage = async (ctx, cvId) => h.until(null, async () => (await ctx.browser.pages()).find((p) => p.url().startsWith(ctx.ext("canvas.html")) && p.url().includes(`id=${cvId}`)), `the page of ${cvId}`);
const titles = async (panel) => (await h.strip(panel)).map((x) => x.title);

/** Bring the canvas tab to the front and click its 🗨️ (a trusted click: sidePanel.open needs it). */
async function clickConv(ctx, cvId) {
  const [tab] = await canvasTabsOf(ctx, cvId);
  await ctx.control.evaluate((id) => chrome.tabs.update(id, { active: true }), tab.id);
  const page = await canvasPage(ctx, cvId);
  await h.until(page, () => !document.getElementById("canvas-conv").hidden, "the 🗨️ button");
  await page.click("#canvas-conv");
  return page;
}

export default [
  {
    name: "a canvas tab's 🗨️ switches to its conversation, and reopens it once archived (the tab joins its group)",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.hold = true;
      const since = gw.prompts.length;
      await h.send(panel, "write me notes");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      const r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { title: "Notes", kind: "markdown", content: "# Notes\n\nSome text." }));
      const cvId = (/id (cv_[0-9a-f]+)/.exec(r.text) || [])[1];
      t.check(!r.isError && cvId, "canvas_open", r.text);
      await h.until(null, async () => { const [x] = await canvasTabsOf(ctx, cvId); return x && x.status === "complete"; }, "the canvas tab");
      gw.endTurn(sid);
      await h.idle(panel);
      gw.hold = false;

      // Open, not current: 🗨️ switches the panel to it.
      await h.namedConversation(ctx, panel, "Beta");
      const page = await clickConv(ctx, cvId);
      t.check(await page.evaluate(() => document.getElementById("canvas-conv").textContent) === "🗨️ Alpha", "the button names the canvas's conversation");
      await h.until(panel, () => (document.querySelector(".conv-tab.current .conv-tab-title") || {}).textContent === "Alpha", "🗨️ switches to Alpha");
      t.ok("🗨️ on an open conversation's canvas switches the side panel to it");

      // Archived: its canvas tab closes with the group; the gallery would open the canvas ungrouped.
      await h.switchTo(panel, "Beta");
      await h.pressClose(panel, "Alpha");
      await h.until(panel, () => !Array.from(document.querySelectorAll(".conv-tab-title")).some((e) => e.textContent === "Alpha"), "Alpha archived");
      await h.until(null, async () => (await canvasTabsOf(ctx, cvId)).length === 0, "archive closes the canvas tab");
      const loose = await ctx.control.evaluate((u) => chrome.tabs.create({ url: u, active: true }), ctx.ext(`canvas.html?id=${cvId}`));
      t.check(loose.groupId === -1, "the canvas is open in a tab of no group (as the gallery does for an archived conversation)", loose.groupId);
      await h.until(null, async () => { const [x] = await canvasTabsOf(ctx, cvId); return x && x.status === "complete"; }, "the loose canvas tab loaded");

      await clickConv(ctx, cvId);
      await h.until(panel, () => (document.querySelector(".conv-tab.current .conv-tab-title") || {}).textContent === "Alpha", "🗨️ reopens Alpha");
      t.check((await titles(panel)).includes("Beta"), "Beta stays open", await titles(panel));
      await h.until(null, async () => {
        const tabs = await canvasTabsOf(ctx, cvId);
        if (tabs.length !== 1 || tabs[0].groupId < 0) return false;
        const g = (await h.tabGroups(ctx)).find((x) => x.id === tabs[0].groupId);
        return g && g.title === "Alpha";
      }, "the canvas tab in Alpha's group, once");
      t.ok("🗨️ on an archived conversation's canvas reopens it; the canvas tab is in its group, not duplicated");
      const p2 = await canvasPage(ctx, cvId);
      await h.until(p2, () => /已在側邊欄打開「Alpha」/.test(document.getElementById("canvas-notice").textContent), "the canvas tab says it opened");
      t.ok("…and the canvas tab says so");
    },
  },
];
