// canvas-diagram-engine ADR: which engine draws a canvas's diagrams, in the real canvas tab.
//  - Pele by default (§2.1): a fresh profile draws with Pele, the one-time notice shows and is
//    remembered (canvas:peleNoticeShown), the header switch reads 圖表：Pele.
//  - Settings → 圖表引擎 Mermaid (canvas:diagramEngine): the open tab re-renders; mindmap, which
//    mermaid-tiny cannot draw, falls back to Pele with a note on its figure (§2.4).
//  - The header switch (§2.2): this tab only, marked （此分頁）, gone after a reload.
//  - canvas_view({engine}) (§2.3): the switch's path for the agent, with what drew each diagram;
//    client_info reports the setting.
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const DOC = "# Engines\n\n```mermaid\nflowchart LR\n  A[Alpha] --> B[Beta]\n```\n\n```mermaid\nmindmap\n  root((Katashiro))\n    Chat\n    Canvas\n```\n";

const canvasPage = (ctx, cvId) => h.until(null, async () => (await ctx.browser.pages()).find((p) => p.url().startsWith(ctx.ext("canvas.html")) && p.url().includes(`id=${cvId}`)), `the canvas tab of ${cvId}`);
const frameOf = (page) => page.frames().find((f) => f.url().includes("canvas-frame.html")) || null;
// What the frame shows: each figure's engine and fallback note.
const figures = async (page) => {
  const f = frameOf(page);
  if (!f) return null;
  return f.evaluate(() => Array.from(document.querySelectorAll("#doc figure.ks-mermaid"), (fig) => ({
    engine: fig.dataset.engine,
    note: fig.querySelector(".ks-mermaid-fallback") ? fig.querySelector(".ks-mermaid-fallback").textContent : "",
  }))).catch(() => null);
};
const engines = (figs) => (figs || []).map((x) => x.engine).join(",");
const header = (page) => page.evaluate(() => {
  const b = document.getElementById("canvas-engine");
  const bar = document.getElementById("canvas-notice-bar");
  return { shown: !b.hidden, text: b.textContent, notice: bar.hidden ? "" : document.getElementById("canvas-notice").textContent };
});

export default [
  {
    name: "diagram engine: Pele by default, Settings → Mermaid with a fallback to Pele, the header switch per tab, canvas_view({engine})",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Engines", { fresh: false });
      gw.hold = true;
      const since = gw.prompts.length;
      await h.send(panel, "draw two diagrams");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      const r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { title: "Engines", content: DOC }));
      const cvId = (/id (cv_[0-9a-f]+)/.exec(r.text) || [])[1];
      t.check(!r.isError && cvId, "canvas_open with a flowchart and a mindmap", r.text);
      const page = await canvasPage(ctx, cvId);

      // --- §2.1 the default: Pele, the one-time notice, the header switch ---
      let figs = await h.until(null, async () => { const f = await figures(page); return f && f.length === 2 ? f : null; }, "two diagrams drawn");
      t.check(engines(figs) === "pele,pele" && figs.every((x) => !x.note), "a fresh profile draws both with Pele (mindmap included), no fallback", figs);
      let hd = await h.until(null, async () => { const x = await header(page); return x.shown ? x : null; }, "the 圖表 switch shown");
      t.check(hd.text === "圖表：Pele", "the header switch reads 圖表：Pele", hd);
      t.check(/圖表現在用 Pele 繪製/.test(hd.notice), "the one-time notice says Pele draws the diagrams now", hd.notice);
      const flag = await ctx.control.evaluate(() => chrome.storage.local.get("canvas:peleNoticeShown"));
      t.check(flag["canvas:peleNoticeShown"] === true, "…and is remembered (canvas:peleNoticeShown)", flag);

      // --- Settings → 圖表引擎 Mermaid (the panel's button): the open tab follows; mindmap falls back to Pele ---
      const btns = () => panel.evaluate(() => ({ pele: document.getElementById("canvas-engine-pele").classList.contains("on"), mermaid: document.getElementById("canvas-engine-mermaid").classList.contains("on") }));
      t.check((await btns()).pele && !(await btns()).mermaid, "Settings shows Pele selected by default", await btns());
      await panel.evaluate(() => document.getElementById("canvas-engine-mermaid").click());
      const picked = await ctx.control.evaluate(() => chrome.storage.local.get("canvas:diagramEngine"));
      t.check(picked["canvas:diagramEngine"] === "mermaid" && (await btns()).mermaid, "the Mermaid button stores canvas:diagramEngine = mermaid", picked);
      figs = await h.until(null, async () => { const f = await figures(page); return f && engines(f) === "mermaid,pele" ? f : null; }, "re-rendered with Mermaid");
      t.check(figs[0].note === "" && /^以 Pele 繪製（Mermaid diagram 2: /.test(figs[1].note), "the flowchart by Mermaid; mindmap falls back to Pele with a note on its figure", figs);
      hd = await header(page);
      t.check(hd.text === "圖表：Mermaid" && !/顯示時發生錯誤|圖表有錯誤/.test(hd.notice), "the switch follows the setting; a fallback is no error banner", hd);

      // --- §2.2 the header switch: this tab only, not saved ---
      await page.evaluate(() => document.getElementById("canvas-engine").click());
      figs = await h.until(null, async () => { const f = await figures(page); return f && engines(f) === "pele,pele" ? f : null; }, "the switch re-renders with Pele");
      hd = await header(page);
      t.check(hd.text === "圖表：Pele（此分頁）", "the switch marks an override as this tab's", hd);
      const setting = await ctx.control.evaluate(() => chrome.storage.local.get("canvas:diagramEngine"));
      t.check(setting["canvas:diagramEngine"] === "mermaid", "…and leaves the setting alone", setting);
      await page.reload({ waitUntil: "load" });
      figs = await h.until(null, async () => { const f = await figures(page); return f && f.length === 2 ? f : null; }, "redrawn after reload");
      hd = await h.until(null, async () => { const x = await header(page); return x.shown ? x : null; }, "the switch after reload");
      t.check(engines(figs) === "mermaid,pele" && hd.text === "圖表：Mermaid" && !/圖表現在用 Pele/.test(hd.notice), "a reload goes back to the setting (Mermaid); the notice does not come back", { figs, hd });

      // --- §2.3 canvas_view({engine}) and client_info ---
      let v = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_view", { id: cvId, engine: "pele" }));
      t.check(!v.isError && /^"Engines" now draws its diagrams with Pele in its tab \(this tab only; Settings → 圖表引擎 is Mermaid\): 2 diagrams: 2 by Pele$/.test(v.text), "canvas_view({engine: pele}) switches the tab and says what drew each diagram", v.text);
      t.check(engines(await figures(page)) === "pele,pele" && (await header(page)).text === "圖表：Pele（此分頁）", "…the tab shows it like the header switch would");
      v = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_view", { id: cvId, engine: "default" }));
      t.check(!v.isError && /with Mermaid in its tab \(Settings → 圖表引擎\): 2 diagrams: 1 by Pele \(1 as the fallback\), 1 by Mermaid$/.test(v.text), "engine: default goes back to the setting; the fallback is reported", v.text);
      const ci = FakeGateway.text(await gw.callTool(sid, "katashiro.client_info", {}));
      t.check(/\ndiagram engine: mermaid \(Settings → 圖表引擎; the other engine is the fallback\)/.test(ci.text), "client_info reports the setting", ci.text);
      await panel.evaluate(() => document.getElementById("canvas-engine-pele").click());
      figs = await h.until(null, async () => { const f = await figures(page); return f && engines(f) === "pele,pele" ? f : null; }, "back to Pele from Settings");
      t.check((await btns()).pele, "Settings → Pele: the tab draws with Pele again");
      gw.endTurn(sid);
    },
  },
];
