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
  {
    name: "an agent pulls another conversation's canvas with canvas_move after the user's 允許; a push the user refuses (拒絕) moves nothing",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const textOf = (x) => x.text || "";
      const pendingCard = ".conv-messages:not([hidden]) .confirm-card.pending";
      const sidG = await h.namedConversation(ctx, panel, "Gamma", { fresh: false });
      gw.hold = true;
      let since = gw.prompts.length;
      await h.send(panel, "draft the topic");
      await gw.waitPrompt((p) => p.sessionId === sidG, { since });
      let r = FakeGateway.text(await gw.callTool(sidG, "katashiro.canvas_open", { title: "Topic", kind: "markdown", content: "# Topic\n\nFrom Gamma." }));
      const cvId = (/id (cv_[0-9a-f]+)/.exec(r.text) || [])[1];
      t.check(!r.isError && cvId, "canvas_open in Gamma", r.text);
      await h.until(null, async () => { const x = await canvasTabOf(ctx, cvId); return x && x.status === "complete" && x.groupId > 0; }, "the canvas tab in Gamma's group");
      gw.endTurn(sidG);
      await h.idle(panel);

      const sidD = await h.namedConversation(ctx, panel, "Delta");
      since = gw.prompts.length;
      await h.send(panel, "bring the topic canvas here");
      await gw.waitPrompt((p) => p.sessionId === sidD, { since });
      r = FakeGateway.text(await gw.callTool(sidD, "katashiro.conversation_list", {}));
      const list = JSON.parse(r.text).conversations;
      const g = list.find((c) => c.title === "Gamma");
      t.check(g && g.canvases.some((c) => c.id === cvId && c.title === "Topic") && !list.some((c) => c.title === "Delta"), "conversation_list: Gamma with its canvas, not Delta itself", list);
      t.check(!r.text.includes("From Gamma"), "…titles only, no content");
      // Pull: the 🔒 card in Delta's turn; 允許.
      const pull = gw.callTool(sidD, "katashiro.canvas_move", { id: cvId });
      await h.until(panel, (sel) => !!document.querySelector(sel), "the confirm card", pendingCard);
      const card = await panel.evaluate((sel) => document.querySelector(sel).innerText, pendingCard);
      t.check(/要移動畫布/.test(card) && /Topic/.test(card) && /從「Gamma」移進這段對話/.test(card), "the card names the canvas and where it comes from", card);
      await panel.evaluate((sel) => document.querySelector(`${sel} .confirm-card-allow`).click(), pendingCard);
      r = FakeGateway.text(await pull);
      t.check(!r.isError && r.text.startsWith(`moved canvas "Topic" (${cvId}, v1) into this conversation from "Gamma"`), "允許 → pulled", r.text);
      await h.until(null, async () => (await groupTitleOf(ctx, await canvasTabOf(ctx, cvId))) === "Delta", "the canvas tab in Delta's group");
      t.ok("the pulled canvas's tab moved to Delta's group");
      r = FakeGateway.text(await gw.callTool(sidD, "katashiro.canvas_read", { id: cvId }));
      t.check(!r.isError && /From Gamma/.test(r.text), "Delta's agent reads it", r.text.slice(0, 80));
      // Push it back: 拒絕 → nothing moves.
      const push = gw.callTool(sidD, "katashiro.canvas_move", { id: cvId, to: g.id });
      await h.until(panel, (sel) => !!document.querySelector(sel), "the second confirm card", pendingCard);
      await panel.evaluate((sel) => document.querySelector(`${sel} .confirm-card-deny`).click(), pendingCard);
      r = FakeGateway.text(await push);
      t.check(/^declined/.test(r.text), "拒絕 → declined", r.text);
      t.check((await groupTitleOf(ctx, await canvasTabOf(ctx, cvId))) === "Delta", "…and it stays in Delta");
      gw.endTurn(sidD);
      await h.idle(panel);
      gw.hold = false;
      // Delta's agent made the move: no note for it. Gamma's agent is told the canvas left.
      since = gw.prompts.length;
      await h.send(panel, "thanks");
      let p = await gw.waitPrompt((x) => x.sessionId === sidD, { since });
      t.check(!textOf(p).includes("[katashiro: the user moved canvas"), "the mover gets no note", textOf(p).slice(0, 80));
      await h.idle(panel);
      await h.switchTo(panel, "Gamma");
      since = gw.prompts.length;
      await h.send(panel, "anything new?");
      p = await gw.waitPrompt((x) => x.sessionId === sidG, { since });
      t.check(textOf(p).includes(`(${cvId}) to another conversation`), "Gamma's agent is told it left", textOf(p).slice(0, 160));
      await h.idle(panel);
    },
  },
];
