// canvas_inject_css: the sheet reaches the real canvas tab's sandboxed frame over runtime messaging,
// survives a re-render (an agent write), adds up, and clear removes it. Page tools on a canvas tab get
// the canvas-specific refusal, not "no grantable web origin".
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const canvasTabOf = async (ctx, cvId) => (await h.allTabs(ctx)).find((x) => x.url.startsWith(ctx.ext("canvas.html")) && x.url.includes(`id=${cvId}`));

/** The canvas tab's content frame (canvas-frame.html, sandboxed, opaque origin). */
async function contentFrame(ctx, cvId) {
  let frame = null;
  await h.until(null, async () => {
    const page = (await ctx.browser.pages()).find((p) => p.url().startsWith(ctx.ext("canvas.html")) && p.url().includes(`id=${cvId}`));
    frame = page && page.frames().find((f) => f.url().includes("canvas-frame.html"));
    return !!frame && (await frame.evaluate(() => !!document.querySelector("h1")).catch(() => false));
  }, `the content frame of ${cvId}`);
  return frame;
}
const h1Color = (frame) => frame.evaluate(() => getComputedStyle(document.querySelector("h1")).color);
const pBorder = (frame) => frame.evaluate(() => getComputedStyle(document.querySelector("p")).borderTopStyle);

export default [
  {
    name: "canvas_inject_css styles the real canvas frame, survives a re-render, clear removes it",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Styles", { fresh: false });
      gw.hold = true;
      const since = gw.prompts.length;
      await h.send(panel, "style it");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      let r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { title: "Doc", content: "# Title\n\nA paragraph." }));
      const cvId = (/id (cv_[0-9a-f]+)/.exec(r.text) || [])[1];
      t.check(!r.isError && cvId, "canvas_open", r.text);
      await h.until(null, async () => { const x = await canvasTabOf(ctx, cvId); return x && x.status === "complete"; }, "the canvas tab");
      let frame = await contentFrame(ctx, cvId);
      const before = await h1Color(frame);

      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_inject_css", { id: cvId, css: "h1 { color: rgb(255, 0, 0) !important }" }));
      t.check(!r.isError && /1 sheet now/.test(r.text), "canvas_inject_css is accepted", r.text);
      await h.until(null, async () => (await h1Color(frame)) === "rgb(255, 0, 0)", "the h1 turns red in the frame");
      t.ok(`the sheet applies inside the sandboxed frame (h1 ${before} → rgb(255, 0, 0))`);
      t.check((await h.activeTab(ctx)).id === (await canvasTabOf(ctx, cvId)).id, "…and the canvas tab is in front", (await h.activeTab(ctx)).url);

      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_inject_css", { id: cvId, css: "p { border: 2px dashed rgb(0, 0, 255) }" }));
      t.check(!r.isError && /2 sheets now/.test(r.text), "a second sheet adds up", r.text);
      await h.until(null, async () => (await pBorder(frame)) === "dashed", "the paragraph gets its border");
      t.check((await h1Color(frame)) === "rgb(255, 0, 0)", "…and the first sheet stays", await h1Color(frame));

      // An agent write re-renders the canvas: the sheets are still there.
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { id: cvId, baseVersion: 1, title: "Doc", content: "# Title v2\n\nAnother paragraph." }));
      t.check(!r.isError, "canvas_open update", r.text);
      await h.until(null, async () => (await frame.evaluate(() => document.querySelector("h1").textContent).catch(() => "")) === "Title v2", "the update renders");
      frame = await contentFrame(ctx, cvId);
      t.check((await h1Color(frame)) === "rgb(255, 0, 0)" && (await pBorder(frame)) === "dashed", "the sheets survive a re-render", [await h1Color(frame), await pBorder(frame)]);

      // Fetching sheets never reach the tab.
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_inject_css", { id: cvId, css: "h1 { background: url(https://example.com/x) }" }));
      t.check(r.isError && /url\(/.test(r.text), "a sheet with url() is refused", r.text);

      // Page tools on the canvas tab: the canvas-specific refusal.
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.read_dom", {}));
      t.check(r.isError && /Katashiro's own canvas/.test(r.text) && /canvas_inject_css/.test(r.text), "read_dom on the canvas tab names the canvas tools", r.text);

      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_inject_css", { id: cvId, clear: true }));
      t.check(!r.isError && /removed/.test(r.text), "clear", r.text);
      await h.until(null, async () => (await h1Color(frame)) === before && (await pBorder(frame)) !== "dashed", "the frame is back to its own styles");
      t.ok("clear removes every sheet");
      gw.endTurn(sid);
      await h.idle(panel);
    },
  },
];
