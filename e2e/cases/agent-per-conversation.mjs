// An agent per conversation (ADR docs/adr/agent-per-conversation.md), in the real extension against
// two fake gateways (two agents, two URLs): the ＋ agent picker, two conversations on two agents
// streaming at once, the chip following the conversation on screen, Y's handshake opening no
// session for X's conversation (§2.7 Conn.cur), archiving an agent's last conversation closing its
// socket; then the migration, a URL edit rebinding, and removing an agent in use (read-only, revived
// by adding the URL back).
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const chips = (panel) => panel.evaluate(() => Array.from(document.querySelectorAll("#roster .roster-chip")).map((c) => (c.querySelector(".roster-name") || {}).textContent || ""));
const indexOf = (ctx) => ctx.control.evaluate(async () => (await chrome.storage.local.get("conv:index"))["conv:index"] || {});

async function openSettings(panel) {
  await panel.evaluate(() => document.getElementById("settings-btn").click());
  await h.until(panel, () => document.getElementById("settings-view").classList.contains("active"), "the settings view");
}
async function closeSettings(panel) {
  await panel.evaluate(() => document.getElementById("cancel-settings-btn").click());
  await h.until(panel, () => document.getElementById("chat-view").classList.contains("active"), "back in the chat");
}
async function addAgent(panel, name, url) {
  await openSettings(panel);
  await panel.evaluate((n, u) => {
    document.getElementById("new-agent-name").value = n;
    document.getElementById("new-agent-url").value = u;
    document.getElementById("add-agent-btn").click();
  }, name, url);
  await h.until(panel, (u) => Array.from(document.querySelectorAll(".agent-url-input")).some((i) => i.value === u), `${name} in the agent list`, url);
  await closeSettings(panel);
}
/** ＋ → the agent picker → pick `name`. Resolves once the new conversation is current. */
async function newWith(panel, name) {
  const n = (await h.strip(panel)).length;
  await panel.evaluate(() => document.querySelector(".conv-tab-new")?.click());
  await h.until(panel, () => !!document.querySelector(".agent-picker"), "the agent picker");
  const opts = await panel.evaluate(() => Array.from(document.querySelectorAll(".agent-picker .conv-picker-option")).map((b) => b.textContent));
  await panel.evaluate((nm) => Array.from(document.querySelectorAll(".agent-picker .conv-picker-option")).find((b) => b.textContent.startsWith(nm)).click(), name);
  await h.until(panel, (k) => document.querySelectorAll(".conv-tab").length === k + 1, "a new tab in the strip", n);
  return opts;
}
const socketsOf = (gw) => [...gw.sockets].filter((ws) => ws.readyState === 1).length;

export default [
  {
    name: "two agents: ＋ picks one; both stream at once; the chip follows; the last conversation archived closes its socket",
    async run(ctx, t) {
      const { gw: gwX, panel } = ctx;
      const gwY = await new FakeGateway({ prefix: "y_" }).start();
      try {
        await h.renameCurrent(panel, "Alpha");
        const sidA = await h.sessionOf(ctx, "Alpha");
        t.check((await chips(panel)).join() === "Fake", "one chip: the on-screen conversation's agent", await chips(panel));

        await addAgent(panel, "Other", gwY.url);
        t.check(socketsOf(gwY) === 0, "adding an agent connects nothing (no conversation uses it)");
        const newX = gwX.methods("session/new").length;
        const opts = await newWith(panel, "Other");
        t.check(opts.length === 2 && opts.some((o) => o.startsWith("Fake（🔌")) && opts.some((o) => o === "Other（未連線）"), "the picker lists both; the unconnected one says 未連線", opts);
        await h.until(null, () => gwY.methods("session/new").length === 1, "Y: session/new for the new conversation");
        await h.renameCurrent(panel, "Beta");
        await h.until(panel, () => /已連線至 Other/.test(document.body.innerText), "the connected notice for Other");
        t.check((await chips(panel)).join() === "Other", "the chip follows: Other", await chips(panel));
        t.check(gwX.methods("session/new").length === newX, "X opened no session for Y's conversation (§2.7 Conn.cur)", gwX.methods("session/new").length - newX);
        const idB = await h.convIdByTitle(ctx, "Beta");
        const idA = await h.convIdByTitle(ctx, "Alpha");
        let idx = await indexOf(ctx);
        t.check(idx[idA].agentUrl === gwX.url && idx[idB].agentUrl === gwY.url, "each conversation is bound to its agent (conv:index)", [idx[idA].agentUrl, idx[idB].agentUrl]);
        const stored = await h.storedConvs(ctx);
        t.check(stored[idB].agentUrl === gwY.url && !stored[idB].sessions[gwX.url], "Beta's record: agent Y, no session on X", stored[idB]);
        t.check(!stored[idA].sessions[gwY.url], "Alpha's record: no session on Y", stored[idA].sessions);

        // Both at once.
        gwX.hold = true; gwY.hold = true;
        await h.send(panel, "question for beta");
        const pB = await gwY.waitPrompt();
        await h.switchTo(panel, "Alpha");
        t.check((await chips(panel)).join() === "Fake", "back on Alpha, the chip is Fake", await chips(panel));
        await h.send(panel, "question for alpha");
        const pA = await gwX.waitPrompt();
        t.check(pA.sessionId === sidA && pB.sessionId.startsWith("y_"), "each prompt went to its own agent", [pA.sessionId, pB.sessionId]);
        t.check(!gwX.prompts.some((p) => /beta/.test(p.userText)) && !gwY.prompts.some((p) => /alpha/.test(p.userText)), "no prompt reached the other agent");
        gwX.chunk(pA.sessionId, "FROM-X");
        gwY.chunk(pB.sessionId, "FROM-Y");
        await h.until(panel, () => Array.from(document.querySelectorAll(".conv-messages")).some((e) => e.hidden && e.textContent.includes("FROM-Y")), "Y's reply in Beta's hidden list");
        await h.until(panel, () => { const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden); return l && l.textContent.includes("FROM-X"); }, "X's reply on screen");
        const beta = await h.listContaining(panel, "question for beta");
        t.check(beta && !beta.text.includes("FROM-X"), "Beta's list has only Y's reply", beta && beta.text.slice(-120));
        // Removing a third agent while both reply touches neither turn nor socket (no room rebuild).
        await addAgent(panel, "Spare", "ws://127.0.0.1:9/acp");
        await openSettings(panel);
        await panel.evaluate(() => Array.from(document.querySelectorAll(".agent-row")).find((r) => r.querySelector(".agent-url-input").value === "ws://127.0.0.1:9/acp").querySelector(".agent-delete").click());
        await h.until(panel, () => document.querySelectorAll(".agent-row").length === 2, "Spare removed");
        await closeSettings(panel);
        await h.sleep(300);
        t.check(!gwX.cancels.length && !gwY.cancels.length && gwX.openPrompts().length === 1 && gwY.openPrompts().length === 1, "removing another agent cancels no running turn", [gwX.cancels, gwY.cancels]);
        t.check(socketsOf(gwX) === 1 && socketsOf(gwY) === 1, "…and drops no socket", [socketsOf(gwX), socketsOf(gwY)]);
        gwX.endTurn(pA.sessionId); gwY.endTurn(pB.sessionId);
        await h.idle(panel);

        // Archive Beta (Y's only conversation) → Y disconnects; X stays.
        await h.until(panel, () => !document.querySelector(".conv-tab .conv-tab-mark") || !/⏳/.test(document.querySelector(".conv-tabs").textContent), "no turn running");
        await h.pressClose(panel, "Beta");
        await h.until(null, () => socketsOf(gwY) === 0, "Y's socket closed after its last conversation was archived");
        t.ok("archiving Y's last conversation closed Y's socket");
        t.check(socketsOf(gwX) === 1, "X stays connected", socketsOf(gwX));
      } finally {
        await gwY.stop();
      }
    },
  },
  {
    name: "migration binds to the old active agent and keeps activeAgentUrl; a URL edit rebinds; a removed agent leaves the conversation read-only until re-added",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      const sidA = await h.sessionOf(ctx, "Alpha");
      const idA = await h.convIdByTitle(ctx, "Alpha");
      let idx = await indexOf(ctx);
      t.check(idx[idA].agentUrl === gw.url, "the conversation is bound to the old activeAgentUrl", idx[idA]);
      const sync = await ctx.control.evaluate(() => chrome.storage.sync.get("activeAgentUrl"));
      t.check(sync.activeAgentUrl === gw.url, "activeAgentUrl is still in storage.sync (§2.1: not deleted)", sync);

      // URL edit → rebind (index + record), old session dropped, new session on the new URL.
      const gwZ = await new FakeGateway({ prefix: "z_" }).start();
      try {
        await openSettings(panel);
        await panel.evaluate((u) => {
          const i = document.querySelector(".agent-url-input");
          i.value = u;
          i.dispatchEvent(new Event("change"));
        }, gwZ.url);
        await h.until(null, () => gwZ.methods("session/new").length === 1, "the new URL: session/new for Alpha");
        await closeSettings(panel);
        idx = await indexOf(ctx);
        const rec = (await h.storedConvs(ctx))[idA];
        t.check(idx[idA].agentUrl === gwZ.url && rec.agentUrl === gwZ.url, "both copies rebound to the new URL", [idx[idA].agentUrl, rec.agentUrl]);
        await h.until(ctx.control, async (args) => { const r = (await chrome.storage.local.get(`conv:${args.id}`))[`conv:${args.id}`]; return r && !r.sessions[args.old] && !!r.sessions[args.next]; }, "the old session dropped, the new one saved", { id: idA, old: gw.url, next: gwZ.url });
        t.ok("the old URL's session is dropped, the new URL's saved");
        await h.until(null, () => socketsOf(gw) === 0, "the old URL disconnected");
        await h.send(panel, "after the move");
        await h.until(null, () => gwZ.prompts.some((p) => /after the move/.test(p.userText)), "the next message goes to the new URL");
        t.check(!gw.prompts.some((p) => /after the move/.test(p.userText)) && sidA, "…not the old one");
        await h.idle(panel);

        // Remove the agent in use (after adding another, so it is not the last).
        await addAgent(panel, "Spare", gw.url);
        panel.once("dialog", (d) => d.accept());
        await openSettings(panel);
        await panel.evaluate((u) => {
          const row = Array.from(document.querySelectorAll(".agent-row")).find((r) => r.querySelector(".agent-url-input").value === u);
          row.querySelector(".agent-delete").click();
        }, gwZ.url);
        await h.until(panel, (u) => !Array.from(document.querySelectorAll(".agent-url-input")).some((i) => i.value === u), "the agent is removed", gwZ.url);
        await closeSettings(panel);
        await h.until(null, () => socketsOf(gwZ) === 0, "its socket closed");
        t.check(await panel.evaluate(() => document.getElementById("message-input").disabled && document.getElementById("send-btn").disabled), "the composer is disabled (read-only)");
        t.check((await chips(panel)).join() === "agent 已移除", "the chip says agent 已移除", await chips(panel));
        t.check(/agent 已移除/.test(await h.visibleText(panel)), "the conversation says so");
        t.check((await h.strip(panel)).some((x) => x.title === "Alpha"), "the conversation stays open");

        // Add the same URL back → revived.
        await addAgent(panel, "Back", gwZ.url);
        await h.until(panel, () => !document.getElementById("message-input").disabled, "the composer is enabled again");
        await h.until(null, () => socketsOf(gwZ) === 1, "reconnected to the re-added URL");
        await h.until(panel, () => (document.querySelector("#roster .roster-name") || {}).textContent === "Back", "the chip shows the re-added agent");
        t.ok("adding the URL back revives the conversation");
      } finally {
        await gwZ.stop();
      }
    },
  },
  {
    name: "one agent: archiving the last conversation keeps the socket (the new one is on the same agent)",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      await h.renameCurrent(panel, "Alpha");
      await h.send(panel, "something to keep");
      await h.idle(panel);
      const ws = [...gw.sockets][0];
      const inits = gw.methods("initialize").length;
      await h.pressClose(panel, "Alpha");
      await h.until(panel, () => document.querySelectorAll(".conv-tab").length === 1 && (document.querySelector(".conv-tab.current .conv-tab-title") || {}).textContent !== "Alpha", "a new conversation in its place");
      await h.until(null, () => gw.methods("session/new").length >= 2, "session/new for the new conversation");
      t.check(socketsOf(gw) === 1 && [...gw.sockets][0] === ws && ws.readyState === 1, "the same socket stays open", socketsOf(gw));
      t.check(gw.methods("initialize").length === inits, "no new handshake", gw.methods("initialize").length - inits);
    },
  },
  {
    name: "fresh install: a conversation opened on the placeholder agent follows the synced agents when they arrive",
    async run(ctx, t) {
      const { gw } = ctx;
      // A new device: nothing synced yet, nothing local.
      await h.reloadExtension(ctx);
      const synced = await ctx.control.evaluate(() => chrome.storage.sync.get(null));
      await ctx.control.evaluate(async () => { await chrome.storage.sync.clear(); await chrome.storage.local.clear(); });
      const panel = await h.openSidePanel(ctx, ctx.control);
      await h.until(panel, () => !!document.querySelector(".conv-tab.current"), "a conversation on the placeholder agent");
      let idx = await indexOf(ctx);
      const ids = Object.keys(idx);
      t.check(ids.length === 1 && idx[ids[0]].agentUrl === "ws://localhost:8080/acp", "bound to the placeholder agent", idx);
      const news = gw.methods("session/new").length;
      // The synced config lands a few seconds later.
      await ctx.control.evaluate((s) => chrome.storage.sync.set(s), synced);
      await h.until(null, (n) => gw.methods("session/new").length > n, "session/new on the synced agent", news);
      await h.until(panel, () => !document.getElementById("message-input").disabled, "the composer is enabled");
      t.check(!/agent 已移除/.test(await h.visibleText(panel)), "not read-only (agent 已移除)");
      idx = await indexOf(ctx);
      t.check(idx[ids[0]].agentUrl === gw.url, "rebound to the synced agent (conv:index)", idx[ids[0]]);
      t.check((await h.storedConvs(ctx))[ids[0]]?.agentUrl !== "ws://localhost:8080/acp", "…and its record");
      await h.send(panel, "hello after sync");
      await h.until(null, () => gw.prompts.some((p) => /hello after sync/.test(p.userText)), "the message reaches the synced agent");
      t.ok("the conversation talks to the synced agent");
    },
  },
];
