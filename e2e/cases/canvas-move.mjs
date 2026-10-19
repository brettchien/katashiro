// Multi-conversation §7.3: ↪ 移到其他對話 in a real canvas tab — the picker, the move, the canvas tab
// changing tab group, and both agents: the old one can no longer read it, the new one can, and each
// hears about it in its next prompt (once).
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const canvasTabOf = async (ctx, cvId) => (await h.allTabs(ctx)).find((x) => x.url.startsWith(ctx.ext("canvas.html")) && x.url.includes(`id=${cvId}`) && !x.url.includes("view="));
const groupTitleOf = async (ctx, tab) => { const g = (await h.tabGroups(ctx)).find((x) => x.id === tab.groupId); return g ? g.title : null; };

export default [
  {
    name: "↪ moves a canvas to another open conversation: its tab group, both agents told once, only the new one can read it",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sidA = await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      gw.hold = true;
      let since = gw.prompts.length;
      await h.send(panel, "write me notes");
      await gw.waitPrompt((p) => p.sessionId === sidA, { since });
      let r = FakeGateway.text(await gw.callTool(sidA, "katashiro.canvas_open", { title: "Notes", kind: "markdown", content: "# Notes\n\nSame topic." }));
      const cvId = (/id (cv_[0-9a-f]+)/.exec(r.text) || [])[1];
      t.check(!r.isError && cvId, "canvas_open in Alpha", r.text);
      await h.until(null, async () => { const x = await canvasTabOf(ctx, cvId); return x && x.status === "complete" && x.groupId > 0; }, "the canvas tab in Alpha's group");
      gw.endTurn(sidA);
      await h.idle(panel);
      gw.hold = false;
      const sidB = await h.namedConversation(ctx, panel, "Beta");

      // The canvas tab: ↪ → the picker lists Beta (not Alpha, its own) → pick it.
      const tab = await canvasTabOf(ctx, cvId);
      await ctx.control.evaluate((id) => chrome.tabs.update(id, { active: true }), tab.id);
      const page = await h.until(null, async () => (await ctx.browser.pages()).find((p) => p.url() === tab.url), "the canvas page");
      await h.until(page, () => !document.getElementById("canvas-move").hidden, "the ↪ button");
      await page.click("#canvas-move");
      await h.until(page, () => !!document.querySelector("dialog.conv-picker[open] .conv-picker-row"), "the picker");
      const listed = await page.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-title")).map((e) => e.textContent));
      t.check(listed.includes("Beta") && !listed.includes("Alpha"), "the picker lists the other conversations, not its own", listed);
      await page.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-row")).find((b) => b.querySelector(".conv-picker-title").textContent === "Beta").click());
      await h.until(page, () => /已移到「Beta」/.test(document.getElementById("canvas-notice").textContent), "the canvas tab says it moved");
      await h.until(page, () => document.getElementById("canvas-conv").textContent === "🗨️ Beta", "its 🗨️ now names Beta");
      t.ok("↪ → picker → moved; the header follows");
      await h.until(null, async () => (await groupTitleOf(ctx, await canvasTabOf(ctx, cvId))) === "Beta", "the canvas tab in Beta's group");
      t.ok("the canvas tab moved to Beta's tab group");

      // Beta's agent is told and can read it; the note goes with the first accepted prompt.
      since = gw.prompts.length;
      await h.send(panel, "what do we have?");
      let p = await gw.waitPrompt((x) => x.sessionId === sidB, { since });
      const textOf = (x) => x.text || "";
      t.check(textOf(p).startsWith(`[katashiro: the user moved canvas "Notes" (${cvId}, v1) into this conversation from another one.`), "Beta's agent: told it is in, first in its next prompt", textOf(p).slice(0, 160));
      r = FakeGateway.text(await gw.callTool(sidB, "katashiro.canvas_read", { id: cvId }));
      t.check(!r.isError && /Same topic/.test(r.text), "Beta's agent can canvas_read it", r.text.slice(0, 120));
      await h.idle(panel);
      since = gw.prompts.length;
      await h.send(panel, "and next");
      p = await gw.waitPrompt((x) => x.sessionId === sidB, { since });
      t.check(!textOf(p).includes("[katashiro: the user moved canvas"), "…told once", textOf(p).slice(0, 80));
      await h.idle(panel);

      // Alpha's agent: refused, and told in its next prompt.
      r = FakeGateway.text(await gw.callTool(sidA, "katashiro.canvas_read", { id: cvId }));
      t.check(r.isError && /no canvas/.test(r.text), "Alpha's agent can no longer read it", r.text.slice(0, 120));
      await h.switchTo(panel, "Alpha");
      since = gw.prompts.length;
      await h.send(panel, "where are my notes?");
      p = await gw.waitPrompt((x) => x.sessionId === sidA, { since });
      t.check(textOf(p).startsWith(`[katashiro: the user moved canvas "Notes" (${cvId}) to another conversation.`) && !textOf(p).includes("Beta"), "Alpha's agent: told it left, without naming Beta", textOf(p).slice(0, 160));
      await h.idle(panel);
    },
  },
];
