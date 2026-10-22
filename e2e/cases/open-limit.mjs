// At most ConvCore.MAX_OPEN (3) conversations open across all windows (multi-conversation §3.3).
// ＋ with 3 open opens no 4th: the archive picker instead, no tab, no session/new; 取消 leaves the
// 3 as they were; picking one archives it and only then opens the new conversation (still 3).
import * as h from "../helpers.mjs";

const titles = (panel) => h.strip(panel).then((s) => s.map((x) => x.title));

export default [
  {
    name: "＋ with 3 open: the archive picker, no 4th conversation; picking one archives it, then the new one opens",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.namedConversation(ctx, panel, "Alpha", { fresh: false });
      await h.namedConversation(ctx, panel, "Beta");
      await h.send(panel, "hello Beta");                 // an empty conversation is deleted on archive, not kept
      await gw.waitPrompt((p) => /hello Beta/.test(p.userText));
      await h.idle(panel);
      await h.namedConversation(ctx, panel, "Gamma");
      t.check((await titles(panel)).join() === "Alpha,Beta,Gamma", "three open", await titles(panel));

      const news = gw.methods("session/new").length;
      await panel.evaluate(() => document.querySelector(".conv-tab-new")?.click());
      await h.until(panel, () => !!document.querySelector(".conv-picker"), "the picker with 3 open");
      const head = await panel.evaluate(() => document.querySelector(".conv-picker-head").textContent);
      t.check(/已經開了 3 段對話/.test(head), "the picker says 3 are open and asks which to archive", head);
      const opts = await panel.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-option")).map((b) => b.textContent));
      t.check(opts.join() === "Alpha,Beta,Gamma", "it lists the three open conversations", opts);
      // newConversation() returns before making an id when 3 are open, so with the picker up no tab can
      // follow; the re-check after 取消 below covers a late one.
      t.check((await h.strip(panel)).length === 3, "no 4th tab in the strip", await titles(panel));
      t.check(gw.methods("session/new").length === news, "no session/new for a 4th conversation");

      await panel.evaluate(() => document.querySelector(".conv-picker-cancel").click());
      await h.until(panel, () => !document.querySelector(".conv-picker"), "the picker closed");
      t.check((await titles(panel)).join() === "Alpha,Beta,Gamma", "取消: the three stay open, nothing archived", await titles(panel));
      t.check(gw.methods("session/new").length === news, "取消: still no session/new");

      await panel.evaluate(() => document.querySelector(".conv-tab-new")?.click());
      await h.until(panel, () => !!document.querySelector(".conv-picker"), "the picker again");
      await panel.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-option")).find((b) => b.textContent === "Beta").click());
      await h.until(null, () => gw.methods("session/new").length > news, "session/new for the new conversation");
      // Gamma was current already: wait for a current tab that is neither Alpha nor Gamma (the new one).
      await h.until(panel, () => {
        const cur = document.querySelector(".conv-tab.current .conv-tab-title");
        return !document.querySelector(".conv-picker") && !!cur && !["Alpha", "Gamma"].includes(cur.textContent);
      }, "the new conversation current");
      const after = await titles(panel);
      t.check(after.length === 3 && !after.includes("Beta") && after.includes("Alpha") && after.includes("Gamma"), "Beta archived, a new one in its place: still 3", after);
      const betaId = await h.convIdByTitle(ctx, "Beta");
      const idx = await ctx.control.evaluate(() => chrome.storage.local.get("conv:index").then((r) => r["conv:index"] || {}));
      t.check(!!(betaId && idx[betaId] && idx[betaId].archivedAt), "Beta is archived (in conv:index), not deleted", idx[betaId]);
      const msgs = await ctx.control.evaluate((id) => chrome.storage.local.get("conv:" + id).then((r) => (r["conv:" + id] || {}).messages || []), betaId);
      t.check(msgs.some((m) => /hello Beta/.test(JSON.stringify(m))), "Beta's messages are kept", msgs.length);
    },
  },
];
