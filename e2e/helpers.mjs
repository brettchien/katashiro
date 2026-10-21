// helpers.mjs — the building blocks of a T2 E2E case: a fresh Chrome with the real extension, its
// real side panel, a fake gateway behind it, a small web server for "the user's" / the agent's
// pages, and the panel / chrome.* operations the cases use. See e2e/README.md.
import http from "node:http";
import { launch, ROOT } from "./launch.mjs";
import { FakeGateway } from "./fake-gateway.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a case's verdicts ------------------------------------------------------------------------
export function checker(log = console.log) {
  const failures = [];
  return {
    failures,
    ok: (msg) => log(`ok   ${msg}`),
    fail: (msg) => { failures.push(msg); log(`FAIL ${msg}`); },
    check(cond, msg, got) {
      if (cond) this.ok(msg);
      else this.fail(`${msg}${got === undefined ? "" : `: ${JSON.stringify(got)}`}`);
      return !!cond;
    },
  };
}

/** Poll `fn` in the page (or in node when `page` is null) until truthy; throws on timeout. */
export async function until(page, fn, what, arg, ms = 10000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = page ? await page.evaluate(fn, arg) : await fn(arg); } catch (e) { last = undefined; if (Date.now() > end) throw e; }
    if (last) return last;
    if (Date.now() > end) throw new Error(`timed out (${ms} ms): ${what}`);
    await sleep(50);
  }
}

// --- the web pages the agent opens --------------------------------------------------------------
// GET /page/<name> → a small page titled <name> whose text says "Body of <name>".
// Answered after PAGE_DELAY_MS: a page that finishes loading while new_tab is still grouping the
// tab makes new_tab wait out its 8 s load bound (#149), so the
// pages load a little slower than that bookkeeping, as real pages do.
// `web.serve(path, html)`: a case's own page at `path` (the query is ignored), answered at once.
const PAGE_DELAY_MS = 700;
export async function startWebServer() {
  const routes = new Map();
  const server = http.createServer(async (req, res) => {
    const own = routes.get(req.url.split(/[?#]/)[0]);
    if (own != null) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(own);
      return;
    }
    const name = decodeURIComponent((req.url.match(/^\/page\/([^?#]*)/) || [])[1] || "index");
    await sleep(PAGE_DELAY_MS);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>${name}</title><h1>Page ${name}</h1><p>Body of ${name}.</p>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    serve: (p, html) => { routes.set(p, html); },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

// --- the browser ------------------------------------------------------------------------------
/**
 * A fresh profile with the extension loaded, the fake gateway configured as its only agent (act
 * mode on), the control page open in a normal window, and the real side panel opened on that
 * window (toolbar-icon path). → ctx (see the fields below). `ctx.close()` tears everything down.
 */
export async function startSession({ log = () => {} } = {}) {
  const gw = await new FakeGateway().start();
  const web = await startWebServer();
  const browser = await launch();
  const ctx = { gw, web, browser, log, panels: [] };
  ctx.close = async () => {
    await browser.close().catch(() => {});
    await gw.stop().catch(() => {});
    await web.close().catch(() => {});
  };
  try {
    await attachExtension(ctx);
    // The agent config, before any panel loads (what the user would set in ⚙️ Settings).
    await ctx.control.evaluate((url) => chrome.storage.sync.set({
      agents: [{ name: "Fake", url, token: "" }], activeAgentUrl: url, actMode: true,
    }), gw.url);
    ctx.windowId = await ctx.control.evaluate(() => chrome.windows.getCurrent().then((w) => w.id));
    ctx.panel = await openSidePanel(ctx, ctx.control);
    await waitReady(ctx, ctx.panel);
  } catch (e) {
    await ctx.close();
    throw e;
  }
  return ctx;
}

let controlSeq = 0;
/** A URL for a new control page; each one unique, so its CDP "tab" target can be told apart. */
export const controlUrl = (ctx) => ctx.ext(`e2e/control.html?n=${++controlSeq}`);

/** (Re)find the extension's service worker, its id and a control page. After a reload too. */
export async function attachExtension(ctx) {
  const swTarget = await ctx.browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/src/background.js"), { timeout: 15000 });
  ctx.extId = new URL(swTarget.url()).host;
  ctx.swTarget = swTarget;
  ctx.ext = (p) => `chrome-extension://${ctx.extId}/${p}`;
  ctx.cdp = ctx.cdp || await ctx.browser.target().createCDPSession();
  const pages = await ctx.browser.pages();
  const blank = pages.find((p) => p.url() === "about:blank");
  ctx.control = blank || await ctx.browser.newPage();
  const url = controlUrl(ctx);
  // Right after a reload the extension may not serve its pages yet: retry until chrome.* is there.
  await until(null, async () => {
    await ctx.control.goto(url, { waitUntil: "load" }).catch(() => {});
    return ctx.control.evaluate(() => typeof chrome !== "undefined" && !!chrome.tabs).catch(() => false);
  }, "the control page with chrome.* (extension loaded)", undefined, 15000);
  return ctx;
}

/**
 * Reload the extension from disk, as chrome://extensions ↻ does: storage.local stays,
 * storage.session is cleared, extension pages (the side panel, canvas tabs, the control page)
 * close, other tabs and their groups stay. (Not chrome.runtime.reload(): in this harness that
 * leaves a CDP-loaded unpacked extension disabled.) Then a new control page; reopen panels yourself.
 */
export async function reloadExtension(ctx) {
  const panels = ctx.panels.map((p) => p.target());
  await ctx.cdp.send("Extensions.loadUnpacked", { path: ROOT });
  await until(null, () => panels.every((t) => !ctx.browser.targets().includes(t)), "the side panels closed by the reload", undefined, 15000);
  ctx.panels = [];
  await attachExtension(ctx);
}

/**
 * Open the REAL side panel on the window of `page` (a control page) the way the user does: a click
 * on the toolbar icon (CDP Extensions.triggerAction on that tab; background.js sets
 * openPanelOnActionClick). → the side panel's Page.
 */
export async function openSidePanel(ctx, page) {
  const before = new Set(ctx.browser.targets().filter((t) => t.url().endsWith("/sidepanel.html")));
  const { targetInfos } = await ctx.cdp.send("Target.getTargets", { filter: [{ type: "tab" }] });
  const tab = targetInfos.find((x) => x.url === page.url());
  if (!tab) throw new Error(`no CDP tab target for ${page.url()}`);
  // background.js sets openPanelOnActionClick when its service worker starts; a click before that
  // lands does nothing.
  await until(page, () => chrome.sidePanel.getPanelBehavior().then((b) => b.openPanelOnActionClick), "openPanelOnActionClick set by background.js");
  await ctx.cdp.send("Extensions.triggerAction", { id: ctx.extId, targetId: tab.targetId });
  const target = await ctx.browser.waitForTarget((t) => t.url().endsWith("/sidepanel.html") && !before.has(t), { timeout: 10000 }).catch((e) => {
    throw new Error(`the side panel did not open after the toolbar click: ${e.message}`);
  });
  const panel = await target.asPage();
  panel.__errors = [];
  panel.on("pageerror", (e) => { panel.__errors.push(e.message); ctx.log(`  [panel error] ${e.message}`); });
  panel.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) ctx.log(`  [panel console] ${m.text()}`); });
  await until(panel, () => document.readyState === "complete" && document.querySelectorAll(".conv-tab, .conv-picker").length > 0, "the panel's tab strip");
  ctx.panels.push(panel);
  return panel;
}

/** The panel is connected and its conversation on screen has an ACP session. */
export async function waitReady(ctx, panel) {
  await until(null, () => ctx.gw.methods("session/new").length + ctx.gw.methods("session/resume").length > 0, "a session/new or session/resume");
  await until(panel, () => !!document.querySelector(".conv-tab.current"), "a current conversation");
  await until(panel, () => /已連線至|已續接/.test(document.body.innerText), "the connected notice in the chat");
}

// --- the panel ------------------------------------------------------------------------------------
export const strip = (panel) => panel.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).map((t) => ({
  title: (t.querySelector(".conv-tab-title") || {}).textContent || "",
  current: t.classList.contains("current"),
  mark: (t.querySelector(".conv-tab-mark") || {}).textContent || "",
  close: (t.querySelector(".conv-tab-close") || {}).textContent || "",
})));

/** The tab-strip mark (⏳ / ● / ❓ / "") of the conversation titled `title` (or at index `title`). */
export async function markOf(panel, title) {
  const s = await strip(panel);
  const t = typeof title === "number" ? s[title] : s.find((x) => x.title === title);
  return t ? t.mark : null;
}

export const currentTitle = (panel) => panel.evaluate(() => (document.querySelector(".conv-tab.current .conv-tab-title") || {}).textContent || "");

/** Type into the composer and press send (as the send button does). */
export async function send(panel, text) {
  await panel.evaluate((t) => {
    const i = document.getElementById("message-input");
    i.value = t;
    i.dispatchEvent(new Event("input"));
  }, text);
  await until(panel, () => !document.getElementById("send-btn").disabled, "the send button enabled");
  await panel.click("#send-btn");
}

/** ＋: a new conversation; resolves once it is current and has its ACP session. */
export async function newConversation(ctx, panel) {
  const n = (await strip(panel)).length;
  const sessions = ctx.gw.methods("session/new").length;
  // Not panel.click(): the strip is re-rendered as sessions settle, which can detach a handle.
  await panel.evaluate(() => document.querySelector(".conv-tab-new")?.click());
  await until(panel, (k) => document.querySelectorAll(".conv-tab").length === k + 1, "a new tab in the strip", n);
  await until(null, () => ctx.gw.methods("session/new").length > sessions, "session/new for the new conversation");
  await until(panel, () => !!document.querySelector(".conv-tab.current"), "it is current");
}

/** Click the conversation titled `title` in the strip. */
export async function switchTo(panel, title) {
  await panel.evaluate((t) => {
    const tab = Array.from(document.querySelectorAll(".conv-tab")).find((x) => x.querySelector(".conv-tab-title").textContent === t);
    if (!tab) throw new Error(`no conversation titled ${t}`);
    tab.click();
  }, title);
  await until(panel, (t) => (document.querySelector(".conv-tab.current .conv-tab-title") || {}).textContent === t, `switched to ${title}`, title);
}

/** Press the × / ⏹ on the strip tab titled `title`. */
export async function pressClose(panel, title) {
  await panel.evaluate((t) => {
    const tab = Array.from(document.querySelectorAll(".conv-tab")).find((x) => x.querySelector(".conv-tab-title").textContent === t);
    if (!tab) throw new Error(`no conversation titled ${t}`);
    tab.querySelector(".conv-tab-close").click();
  }, title);
}

/** Answer the pending ask card on screen by clicking the option labelled `label`. */
export async function answerAsk(panel, label) {
  await until(panel, () => !!document.querySelector(".conv-messages:not([hidden]) .ask-card.pending .ask-card-option"), "a pending ask card on screen");
  await panel.evaluate((l) => {
    const b = Array.from(document.querySelectorAll(".conv-messages:not([hidden]) .ask-card.pending .ask-card-option")).find((x) => x.textContent.trim() === l);
    if (!b) throw new Error(`no option ${l}`);
    b.click();
  }, label);
}

/** The text of the conversation list on screen; of every list with `all`. */
export const visibleText = (panel) => panel.evaluate(() => {
  const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden);
  return l ? l.innerText : "";
});
/** The text of the (possibly hidden) list of the conversation whose list contains `marker`. */
export const listContaining = (panel, marker) => panel.evaluate((m) => {
  const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => e.textContent.includes(m));
  return l ? { text: l.textContent, hidden: l.hidden } : null;
}, marker);

export const stopButtonVisible = (panel) => panel.evaluate(() => !document.getElementById("stop-btn").hidden);

// --- chrome.* as the extension sees it (through the control page) ------------------------------------
export const tabGroups = (ctx) => ctx.control.evaluate(() => chrome.tabGroups.query({}));
export const allTabs = (ctx) => ctx.control.evaluate(() => chrome.tabs.query({}));
export const activeTab = (ctx, windowId = ctx.windowId) => ctx.control.evaluate((w) => chrome.tabs.query({ active: true, windowId: w }).then((t) => t[0] || null), windowId);
export const notifications = (ctx) => ctx.control.evaluate(() => chrome.notifications.getAll());
export const clearNotifications = (ctx) => ctx.control.evaluate(async () => {
  for (const id of Object.keys(await chrome.notifications.getAll())) await chrome.notifications.clear(id);
});
/** conv:<id> records from chrome.storage.local. */
export const storedConvs = (ctx) => ctx.control.evaluate(async () => {
  const all = await chrome.storage.local.get(null);
  return Object.fromEntries(Object.entries(all).filter(([k]) => /^conv:c_/.test(k)).map(([k, v]) => [k.slice(5), v]));
});
/** The conversation id whose title (conv:index) is `title`. */
export const convIdByTitle = (ctx, title) => ctx.control.evaluate(async (t) => {
  const idx = (await chrome.storage.local.get("conv:index"))["conv:index"] || {};
  const hit = Object.entries(idx).find(([, e]) => e && e.title === t);
  return hit ? hit[0] : null;
}, title);

/**
 * The ACP session of the conversation titled `title`: conv:<id>.sessions[agentUrl], as the panel
 * saved it. Waits until it is saved.
 */
export async function sessionOf(ctx, title) {
  return until(null, async () => {
    const id = await convIdByTitle(ctx, title);
    if (!id) return null;
    const c = (await storedConvs(ctx))[id];
    return c && c.sessions && c.sessions[ctx.gw.url];
  }, `the ACP session of ${title}`);
}

/** Rename the current conversation by double-click (so a case can name it). */
export async function renameCurrent(panel, title) {
  await panel.evaluate(() => document.querySelector(".conv-tab.current").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await until(panel, () => !!document.querySelector(".conv-tab-rename"), "the rename box");
  await panel.evaluate((t) => {
    const i = document.querySelector(".conv-tab-rename");
    i.value = t;
    i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, title);
  await until(panel, (t) => (document.querySelector(".conv-tab.current .conv-tab-title") || {}).textContent === t, `renamed to ${title}`, title);
}

/**
 * A named conversation with a session: renames the one on screen (`fresh: false`) or opens a new
 * one with ＋, then waits for its ACP session. → its sessionId.
 */
export async function namedConversation(ctx, panel, title, { fresh = true } = {}) {
  if (fresh) await newConversation(ctx, panel);
  await renameCurrent(panel, title);
  return sessionOf(ctx, title);
}

/** Wait until the conversation on screen is idle (no stop button). */
export const idle = (panel, what = "the turn on screen is over") => until(panel, () => document.getElementById("stop-btn").hidden, what);
