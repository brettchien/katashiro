#!/usr/bin/env node
// smoke-multi-conversation.mjs — the multi-conversation MVP (ADR docs/adr/multi-conversation.md §3)
// in the real sidepanel.html + sidepanel.js, with a fake ACP agent behind window.WebSocket. Needs a
// Chrome, so it is not part of `node --test`:
//
//   npm ci && npm run chrome     # once
//   node scripts/smoke-multi-conversation.mjs      # or `npm run smoke` for all of them
//
// (CHROME / PUPPETEER_CORE override the Chrome and puppeteer-core it uses: see scripts/smoke-env.mjs.)
//
// The pages are served over http with a stub of the chrome.* APIs: chrome.storage.local lives in
// localStorage (one key per item), so several pages ("windows", ?win=N) share it, see each other's
// writes as storage.onChanged, and hold real Web Locks against each other. Not the extension:
// runtime messaging between pages, tab groups, the real gateway and the real gallery → side panel
// round trip still need the manual checks in TESTING.md. Checks:
//   - history:* keys migrate (pre-#61 entry included) into conv:/window:, ≤ 3 open, and resume;
//   - the tab strip: titles (auto from the first user message), ＋, switching, rename, ×;
//   - per-conversation sessions: session/new for a new one, session/resume on a switch back, its own
//     MCP server declared; the U2 host line goes first in the first prompt after a resume, once;
//   - A′ / E (tunnel-liveness §9): after a socket drop with a quick reconnect, no host line — in the
//     resumed conversation or one first resumed on the new socket; the drop is in storage.session and
//     in katashiro.client_info's "recent disconnects";
//   - no switching while a turn runs; a late session/update for another session is dropped;
//   - with 3 open, ＋ shows the picker; picking archives one (asks close as 對話已封存);
//   - a second window: a conversation open in window 1 is not opened again (Web Lock), and with 3
//     open there it gets the picker instead of a 4th;
//   - the gallery's 對話 section lists the archived conversation with its title;
//   - P1b (ADR §4), on a small model of tabs and groups: new_tab joins the conversation's group
//     (titled after it) and becomes the working tab; set_title (sanitised; never over a user name);
//     Q4 b order (a card asked after a queued message stays open); Q6 (send brings the working tab
//     forward; a canvas the agent highlights, or a canvas the user pushes from, becomes the working
//     tab, a canvas opened in the background does not); Q5 (no group collapses on a switch; the user is moved off the left conversation's group; a
//     group collapsed by hand is expanded when its conversation comes back on screen); Q12
//     (❓ + notification, whose click switches back); per-conversation drafts; archive closes the
//     group's tabs but keeps a canvas tab that does not confirm it is clean; push refusals say
//     已封存 vs "that window's panel is closed"; a canvas's 📨 To chat input (canvas §3.7) fills the
//     input box (a draft appended to, focused, nothing sent; switching, or B's draft while A replies), and the
//     canvas's Enter after it (katashiro-canvas-submit-input) sends the input as the send button would,
//     once (deduped), never for a conversation not on screen, an empty input or a compare tab; reopen and a browser restart bring the tabs back
//     into one group, adopting open ones instead of duplicating them.
//   - §7.1 delete from the gallery: the confirm says what goes; refused while another page holds the
//     conversation's lock; then its record, index entry, closed-window record
//     entry and canvases go, another conversation's stay; a stale reopen is refused; a delete cut
//     short (deletingAt left) is finished when a gallery loads.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

// The chrome.* surface the side panel and the gallery touch. Storage is localStorage ("ls:" + key,
// JSON). window.__acp is the fake agent: its log of frames, and knobs (hold prompts, late updates).
const STUB = String.raw`
(() => {
  const WIN = Number(new URLSearchParams(location.search).get("win") || 1);
  const P = "ls:";
  const read = (k) => { const v = localStorage.getItem(P + k); return v == null ? undefined : JSON.parse(v); };
  const keys = () => Object.keys(localStorage).filter((k) => k.startsWith(P)).map((k) => k.slice(P.length));
  const listeners = [];
  const fire = (changes, area) => { for (const l of listeners) try { l(changes, area); } catch (e) { console.error(e); } };
  window.addEventListener("storage", (e) => {
    if (!e.key || !e.key.startsWith(P)) return;
    const k = e.key.slice(P.length);
    fire({ [k]: { oldValue: e.oldValue == null ? undefined : JSON.parse(e.oldValue), newValue: e.newValue == null ? undefined : JSON.parse(e.newValue) } }, "local");
  });
  const done = (v, cb) => { if (cb) { setTimeout(() => cb(v), 0); return undefined; } return Promise.resolve(v); };
  const area = (name, mem) => ({
    get(k, cb) {
      const out = {};
      const all = mem ? Object.keys(mem) : keys();
      const want = k == null ? all : typeof k === "string" ? [k] : Array.isArray(k) ? k : Object.keys(k);
      for (const key of want) { const v = mem ? mem[key] : read(key); if (v !== undefined) out[key] = JSON.parse(JSON.stringify(v)); }
      return done(out, cb);
    },
    getKeys() { return Promise.resolve(mem ? Object.keys(mem) : keys()); },
    set(o, cb) {
      const changes = {};
      for (const [key, v] of Object.entries(o)) {
        changes[key] = { oldValue: mem ? mem[key] : read(key), newValue: v };
        if (mem) mem[key] = JSON.parse(JSON.stringify(v)); else localStorage.setItem(P + key, JSON.stringify(v));
      }
      if (!mem) setTimeout(() => fire(changes, name), 0);
      return done(undefined, cb);
    },
    remove(k, cb) {
      const changes = {};
      for (const key of [].concat(k)) {
        changes[key] = { oldValue: mem ? mem[key] : read(key), newValue: undefined };
        if (mem) delete mem[key]; else localStorage.removeItem(P + key);
      }
      if (!mem) setTimeout(() => fire(changes, name), 0);
      return done(undefined, cb);
    },
    getBytesInUse(_k, cb) { return done(0, cb); },
  });
  const ev = () => { const ls = []; return { addListener: (f) => ls.push(f), removeListener() {}, ls }; };
  const onMessage = ev();
  window.__messages = [];
  window.__deliver = (msg, senderPath) => new Promise((resolve) => {
    const sender = { id: "stub", url: location.origin + senderPath, tab: { id: 99, windowId: WIN } };
    let answered = false;
    const respond = (r) => { if (!answered) { answered = true; resolve(r); } };
    let async = false;
    for (const l of onMessage.ls) if (l(msg, sender, respond) === true) async = true;
    if (!async) setTimeout(() => respond(undefined), 50);
  });
  const TM = "__tabmodel";
  const tm = () => JSON.parse(localStorage.getItem(TM) || '{"tabs":[],"groups":{},"next":100,"nextGroup":500,"clock":1}');
  const tmSave = (m) => localStorage.setItem(TM, JSON.stringify(m));
  const tabsEv = { onUpdated: ev(), onRemoved: ev() };
  const fireT = (e, ...a) => { for (const l of tabsEv[e].ls) try { l(...a); } catch (x) { console.error(x); } };
  const notifyClicked = ev();
  window.__removed = [];
  window.__collapses = [];   // every tabGroups.update({collapsed: true}): only archive may do it
  window.__notes = [];
  window.__notifyClick = (id) => { for (const l of notifyClicked.ls) l(id); };
  // A tab the USER opens (not through Katashiro): active in this window.
  window.__userTab = (url) => window.chrome.tabs.create({ url, active: true });
  window.__tm = tm;
  window.__tmSave = tmSave;
  window.__focused = [];
  window.__sidePanelOpened = [];
  window.chrome = {
    runtime: {
      id: "stub", lastError: undefined, onMessage,
      getURL: (p) => location.origin + "/" + p,
      getManifest: () => ({ version: "0.0.0-smoke" }),
      // A canvas tab answers canvas_highlight (§4.3 working-tab check); nothing else is answered.
      sendMessage: async (msg) => { window.__messages.push(msg); return msg && msg.type === "katashiro-canvas-highlight" ? { ok: true, tag: "h1", text: "A" } : undefined; },
      reload() {},
    },
    storage: { local: area("local"), sync: area("sync", { agents: [{ name: "Orca", url: "ws://fake/acp" }], activeAgentUrl: "ws://fake/acp", actMode: true }), session: area("session", (() => {
      // ?reopen=<id>: a 重新打開 the gallery left for a panel that was not open yet (pickUpReopenRequest).
      const r = new URLSearchParams(location.search).get("reopen");
      return r ? { ["katashiro.convOpen." + WIN]: { id: r, reqId: "smoke-reopen", at: Date.now() } } : {};
    })()), onChanged: { addListener: (f) => listeners.push(f), removeListener() {} } },
    windows: {
      getCurrent: (cb) => cb({ id: WIN }),
      getAll: async () => (read("__live") || [WIN]).map((id) => ({ id })),
      update: async (id) => { window.__focused.push(id); return { id }; },
    },
    tabs: {
      // A small model of the browser's tabs and groups (P1b), in localStorage so every page ("window")
      // sees the same browser. Events fire only in the page that made the change.
      query: async (q = {}) => tm().tabs.filter((t) => (q.windowId == null || t.windowId === q.windowId) && (q.groupId == null || t.groupId === q.groupId) && (q.active == null || t.active === q.active)).map((t) => ({ ...t })),
      create: async (o) => {
        const m = tm();
        const t = { id: ++m.next, windowId: o.windowId ?? WIN, url: o.url || "chrome://newtab/", active: o.active !== false, groupId: -1, splitViewId: -1, pinned: false, index: m.tabs.length, lastAccessed: ++m.clock };
        if (t.active) m.tabs.forEach((x) => { if (x.windowId === t.windowId) x.active = false; });
        m.tabs.push(t);
        tmSave(m);
        return { ...t };
      },
      get: async (id) => { const t = tm().tabs.find((x) => x.id === id); if (!t) throw new Error("No tab with id: " + id); return { ...t }; },
      update: async (id, u) => {
        const m = tm();
        const t = m.tabs.find((x) => x.id === id);
        if (!t) throw new Error("No tab with id: " + id);
        if (u.active) {
          m.tabs.forEach((x) => { if (x.windowId === t.windowId) x.active = false; });
          t.active = true;
          t.lastAccessed = ++m.clock;
          if (m.groups[t.groupId]) m.groups[t.groupId].collapsed = false;   // Chrome expands it
        }
        if (u.url) t.url = u.url;
        tmSave(m);
        if (u.url) fireT("onUpdated", id, { url: u.url }, { ...t });
        return { ...t };
      },
      remove: async (ids) => {
        const m = tm();
        const list = [].concat(ids);
        m.tabs = m.tabs.filter((x) => !list.includes(x.id));
        tmSave(m);
        window.__removed.push(...list);
        for (const id of list) fireT("onRemoved", id, { windowId: WIN, isWindowClosing: false });
      },
      group: async (o) => {
        const m = tm();
        let g = o.groupId;
        if (g == null) { g = ++m.nextGroup; m.groups[g] = { id: g, windowId: (o.createProperties && o.createProperties.windowId) ?? WIN, collapsed: false, title: "" }; }
        for (const id of o.tabIds) { const t = m.tabs.find((x) => x.id === id); if (t) t.groupId = g; }
        tmSave(m);
        for (const id of o.tabIds) fireT("onUpdated", id, { groupId: g }, {});
        return g;
      },
      ungroup: async (ids) => { const m = tm(); for (const id of [].concat(ids)) { const t = m.tabs.find((x) => x.id === id); if (t) t.groupId = -1; } tmSave(m); },
      getCurrent: async () => ({ id: 1, windowId: WIN, index: 0 }),
      onUpdated: tabsEv.onUpdated, onRemoved: tabsEv.onRemoved, onActivated: ev(), onAttached: ev(), onDetached: ev(),
    },
    tabGroups: {
      get: async (id) => { const m = tm(); if (!m.groups[id] || !m.tabs.some((t) => t.groupId === id)) throw new Error("No group with id: " + id); return { ...m.groups[id] }; },
      update: async (id, u) => {
        const m = tm();
        if (!m.groups[id]) throw new Error("No group with id: " + id);
        if (u.collapsed) window.__collapses.push(id);
        Object.assign(m.groups[id], u);
        tmSave(m);
        return { ...m.groups[id] };
      },
    },
    sidePanel: { open: async (o) => { window.__sidePanelOpened.push(o); } },
    // Page tools (P2 Q8): which tab a script was injected into; the page answers with its URL.
    scripting: {
      executeScript: async (inj) => {
        (window.__scripted = window.__scripted || []).push(inj.target.tabId);
        const t = tm().tabs.find((x) => x.id === inj.target.tabId);
        return [{ frameId: 0, result: { ok: true, text: "PAGE " + (t ? t.url : "?") } }];
      },
    },
    notifications: {
      onClicked: notifyClicked,
      create: async (id, o) => { window.__notes.push({ id, ...o }); return id; },
      clear: async () => true,
    },
    permissions: { contains: async () => false, request: async () => false, remove: async () => false },
    management: { getSelf: async () => ({ installType: "development" }) },
  };

  // --- the fake ACP agent ---------------------------------------------------------------------
  const acp = window.__acp = { log: [], hold: false, held: [], sessions: 0, lateUpdateFor: null, servers: {}, responses: {}, askOnPrompt: false, conn: null, nextId: 9100 };
  // The agent side of a browser tunnel: connect to a session's declared server, call a tool on it.
  acp.release = () => { for (const h of acp.held.splice(0)) acp.ws.reply(h.id, { stopReason: "end_turn" }); };
  // P2: a turn finishing in a conversation not on screen — one session's held prompts only.
  acp.releaseSession = (sid, text) => {
    const keep = [];
    for (const h of acp.held.splice(0)) {
      if (h.params.sessionId !== sid) { keep.push(h); continue; }
      if (text) acp.ws.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      acp.ws.reply(h.id, { stopReason: "end_turn" });
    }
    acp.held.push(...keep);
  };
  acp.callTool = (connectionId, name, args) => {
    const id = acp.nextId++;
    acp.ws.emit({ jsonrpc: "2.0", id, method: "mcp/message", params: { connectionId, method: "tools/call", params: { name, arguments: args } } });
    return id;
  };
  class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0;
      acp.ws = this;
      setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 5);
    }
    emit(o) { setTimeout(() => { if (this.readyState === 1 && this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }, 1); }
    reply(id, result) { this.emit({ jsonrpc: "2.0", id, result }); }
    send(data) {
      const m = JSON.parse(data);
      if (m.method === undefined) {                      // our answer to a server request (tunnel)
        acp.responses[m.id] = m;
        if (m.id === 9001 && m.result) { acp.conn = m.result.connectionId; acp.callTool(acp.conn, "katashiro.ask_user", { question: "Pick one?", options: ["A", "B"] }); }
        if (m.id === 9002 && m.result) acp.conn = m.result.connectionId;          // connectOnPrompt: just the tunnel
        return undefined;
      }
      acp.log.push(m);
      if ((m.method === "session/resume" || m.method === "session/new") && m.params.mcpServers[0]) acp.pendingServer = m.params.mcpServers[0].id;
      if (m.method === "session/resume" && m.params.mcpServers[0]) acp.servers[m.params.sessionId] = m.params.mcpServers[0].id;
      if (m.method === "initialize") return this.reply(m.id, { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } });
      if (m.method === "session/new") {
        const sid = "sess_" + (++acp.sessions);
        if (m.params.mcpServers[0]) acp.servers[sid] = m.params.mcpServers[0].id;
        return this.reply(m.id, { sessionId: sid });
      }
      if (m.method === "session/resume") return this.reply(m.id, {});
      if (m.method === "katashiro/ping") return this.emit({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "nope" } });
      if (m.method === "session/cancel") {
        acp.log.cancels = (acp.log.cancels || 0) + 1;
        const keep = [];
        for (const h of acp.held.splice(0)) { if (h.params.sessionId === m.params.sessionId) this.reply(h.id, { stopReason: "cancelled" }); else keep.push(h); }
        acp.held.push(...keep);
        return undefined;
      }
      if (m.method === "session/prompt") {
        const sid = m.params.sessionId;
        // openab on a full pool: dispatch.rs sends "⚠️ " + format_user_error(e) as chat text, then end_turn.
        if (acp.poolBusy) {
          this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "⚠️ **Service Busy**\nAll agent sessions are in use, please try again shortly." } } } });
          return this.reply(m.id, { stopReason: "end_turn" });
        }
        if (acp.lateUpdateFor) this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: acp.lateUpdateFor, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE CHUNK FROM ANOTHER SESSION" } } } });
        this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply in " + sid } } } });
        if (acp.askOnPrompt) { acp.askOnPrompt = false; this.emit({ jsonrpc: "2.0", id: 9001, method: "mcp/connect", params: { acpId: acp.servers[sid] } }); }
        if (acp.connectOnPrompt) { acp.connectOnPrompt = false; acp.conn = null; this.emit({ jsonrpc: "2.0", id: 9002, method: "mcp/connect", params: { acpId: acp.servers[sid] } }); }
        if (acp.hold) { acp.held.push(m); return undefined; }
        return this.reply(m.id, { stopReason: "end_turn" });
      }
      return undefined;
    }
    close() { this.readyState = 3; }
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  window.WebSocket = FakeWS;
  window.confirm = () => true;
})();`;

const inject = { "/sidepanel.html": '<script src="vendor/markdown-it.iife.js">', "/canvas-gallery.html": '<script src="canvas-store.js">' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__stub.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(STUB); return; }
  const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const headers = { "content-type": TYPES[path.extname(file)] || "application/octet-stream" };
  if (inject[url.pathname]) {
    res.writeHead(200, headers);
    res.end(fs.readFileSync(file, "utf8").replace(inject[url.pathname], `<script src="__stub.js"></script>${inject[url.pathname]}`));
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await launch();
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);
const check = (cond, msg, got) => (cond ? ok(msg) : fail(`${msg}: ${JSON.stringify(got)}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const until = async (page, fn, what, arg, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() > end) { fail(`timed out: ${what}`); return v; }
    await sleep(50);
  }
};
const ID = (n) => `c_${String(n).padStart(12, "0")}`;
const msg = (kind, text, timestamp) => ({ kind, text, timestamp, senderName: kind === "sent" ? "You" : "Orca", senderId: kind === "sent" ? "me" : "ws://fake/acp" });

async function openPanel(win) {
  const page = await browser.newPage();
  await page.setViewport({ width: 420, height: 800 });
  page.on("pageerror", (e) => fail(`page error (win ${win}): ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") console.log(`  [console win ${win}] ${m.text()}`); });
  await page.goto(`${origin}/sidepanel.html?win=${win}`, { waitUntil: "load" });
  await until(page, () => document.querySelectorAll(".conv-tab, .conv-picker").length > 0, `panel ${win} loaded`);
  return page;
}
const tabs = (page) => page.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).map((t) => ({
  title: t.querySelector(".conv-tab-title") ? t.querySelector(".conv-tab-title").textContent : null,
  current: t.classList.contains("current"),
})));
const visibleText = (page) => page.evaluate(() => {
  const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden);
  return l ? l.innerText : "";
});
const send = async (page, text) => {
  await page.evaluate((t) => {
    const i = document.getElementById("message-input");
    i.value = t;
    i.dispatchEvent(new Event("input"));
    document.getElementById("send-btn").click();
  }, text);
};
const acpLog = (page) => page.evaluate(() => window.__acp.log.map((m) => ({ method: m.method, params: m.params })));
const storage = (page) => page.evaluate(() => {
  const out = {};
  for (const k of Object.keys(localStorage)) if (k.startsWith("ls:")) out[k.slice(3)] = JSON.parse(localStorage.getItem(k));
  return out;
});

try {
  // Seed: four pre-MVP history keys (one pre-#61 with no id), windows 1 and 2 live.
  const seed = await browser.newPage();
  await seed.goto(`${origin}/manifest.json`);
  const now = Date.now();
  await seed.evaluate((entries) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(entries)) localStorage.setItem("ls:" + k, JSON.stringify(v));
  }, {
    "__live": [1, 2],
    "history:1": { conversationId: ID(1), sessions: { "ws://fake/acp": "sess_old1" }, messages: [msg("sent", "First topic in window one", now - 60000), msg("received", "ok one", now - 50000), msg("sent", "replayed line one\nreplayed line two", now - 45000)], savedAt: now - 45000 },
    "history:7": { sessions: {}, messages: [msg("sent", "pre-61 closed window chat", now - 90000)], savedAt: now - 90000 },
    "history:8": { conversationId: ID(8), messages: [msg("sent", "older closed window", now - 900000)], savedAt: now - 900000 },
    "history:9": { conversationId: ID(9), messages: [msg("sent", "oldest closed window", now - 9000000)], savedAt: now - 9000000 },
  });
  await seed.close();

  // --- window 1: migration + resume -------------------------------------------------------------
  const p1 = await openPanel(1);
  await until(p1, () => window.__acp.log.some((m) => m.method === "session/resume"), "the migrated conversation resumes");
  let st = await storage(p1);
  check(!Object.keys(st).some((k) => k.startsWith("history:")), "history:* keys are gone after the migration", Object.keys(st));
  check(st["conv:schema"] === 1, "conv:schema = 1", st["conv:schema"]);
  const convKeys = Object.keys(st).filter((k) => /^conv:c_/.test(k));
  check(convKeys.length === 4, "four conversations migrated (pre-#61 included)", convKeys);
  const idx = st["conv:index"] || {};
  check(Object.values(idx).filter((e) => e.archivedAt === null).length === 3, "3 open, the rest archived", idx);
  check(idx[ID(9)] && idx[ID(9)].archivedAt !== null, "the oldest closed-window chat is archived", idx[ID(9)]);
  check(JSON.stringify(st["window:1"] && st["window:1"].open) === JSON.stringify([ID(1)]), "window 1 got its own conversation", st["window:1"]);
  let t = await tabs(p1);
  check(t.length === 1 && t[0].title === "First topic in window one" && t[0].current, "the tab strip shows the migrated conversation, titled", t);
  let log = await acpLog(p1);
  const resume = log.find((m) => m.method === "session/resume");
  check(resume && resume.params.sessionId === "sess_old1" && resume.params.mcpServers.length === 1, "it resumes its saved session with its own MCP server", resume);
  check((await visibleText(p1)).includes("ok one"), "its messages are replayed", await visibleText(p1));
  // The user's own multi-line message keeps its line breaks when replayed from history (breaks:true).
  const replayedBubble = await p1.evaluate(() => { const b = Array.from(document.querySelectorAll(".message.sent .bubble")).find((x) => x.textContent.includes("replayed line one")); return b ? b.innerHTML : null; });
  check(replayedBubble && /replayed line one<br>\s*replayed line two/.test(replayedBubble), "a replayed user message keeps its line break (<br>)", replayedBubble);

  // U2: the first prompt after the resume carries the host line first; the next one does not.
  await send(p1, "hello again");
  await until(p1, () => window.__acp.log.filter((m) => m.method === "session/prompt").length === 1, "first prompt");
  await until(p1, () => !document.getElementById("stop-btn") || document.getElementById("stop-btn").hidden, "first turn done");
  await send(p1, "and once more");
  await until(p1, () => window.__acp.log.filter((m) => m.method === "session/prompt").length === 2, "second prompt");
  log = await acpLog(p1);
  const prompts = log.filter((m) => m.method === "session/prompt").map((m) => m.params.prompt[0].text);
  check(prompts[0].startsWith("[katashiro: this conversation was just reconnected."), "U2: the first prompt after a resume starts with the host line", prompts[0].slice(0, 80));
  check(!prompts[1].includes("[katashiro: this conversation was just reconnected."), "U2: only once", prompts[1].slice(0, 80));
  st = await storage(p1);
  check(!JSON.stringify(st[`conv:${ID(1)}`].messages).includes("just reconnected"), "U2: the host line is not stored", null);

  // ＋: a new conversation, session/new, no host line on its first prompt; auto title.
  await until(p1, () => document.getElementById("stop-btn").hidden, "second turn done");
  await p1.click(".conv-tab-new");
  await until(p1, () => document.querySelectorAll(".conv-tab").length === 2, "a second tab");
  t = await tabs(p1);
  check(t[1].current && /^未命名 [0-9a-f]{7}$/.test(t[1].title), "＋ opens 未命名 <short id> and switches to it", t);
  await until(p1, () => window.__acp.log.filter((m) => m.method === "session/new").length === 1, "session/new for the new conversation");
  await send(p1, "Second   topic\nabout tabs");
  await until(p1, () => window.__acp.log.filter((m) => m.method === "session/prompt").length === 3, "third prompt");
  log = await acpLog(p1);
  const p3 = log.filter((m) => m.method === "session/prompt")[2];
  check(!p3.params.prompt[0].text.includes("just reconnected"), "a new conversation's first prompt has no host line", p3.params.prompt[0].text.slice(0, 60));
  check(p3.params.sessionId === "sess_1", "it goes to the new session", p3.params.sessionId);
  const news = log.filter((m) => m.method === "session/new");
  check(news[0].params.mcpServers[0].id !== resume.params.mcpServers[0].id, "each conversation declares its own MCP server", [news[0].params.mcpServers, resume.params.mcpServers]);
  await until(p1, () => document.querySelector(".conv-tab.current .conv-tab-title").textContent === "Second topic about tabs", "auto title");
  // The user's own message keeps the line break typed with Shift+Enter (live send).
  const sentBubble = await p1.evaluate(() => { const b = Array.from(document.querySelectorAll(".message.sent .bubble")).find((x) => x.textContent.includes("about tabs")); return b ? b.innerHTML : null; });
  check(sentBubble && /Second {3}topic<br>\s*about tabs/.test(sentBubble), "a sent multi-line user message shows a <br> between its lines", sentBubble);

  // P2 (§5): switching while a turn runs — the turn continues in the background and its reply lands
  // in its own (hidden) list: ⏳ + ⏹ on its tab while it runs, then ● and a notification (Q9). A late
  // update for a conversation with no turn running is dropped.
  const markOf = (page, i) => page.evaluate((k) => { const x = document.querySelectorAll(".conv-tab")[k]; return x ? [(x.querySelector(".conv-tab-mark") || {}).textContent || "", x.querySelector(".conv-tab-close").textContent] : null; }, i);
  await until(p1, () => document.getElementById("stop-btn").hidden, "third turn done");
  await p1.evaluate((sid) => { window.__acp.hold = true; window.__acp.lateUpdateFor = sid; window.__notes.length = 0; }, "sess_old1");
  await send(p1, "long one");
  await until(p1, () => !document.getElementById("stop-btn").hidden, "a running turn");
  await p1.evaluate(() => document.querySelectorAll(".conv-tab")[0].click());
  t = await tabs(p1);
  check(t[0].current, "P2: switching works while the turn runs", t);
  check(await p1.evaluate(() => document.getElementById("stop-btn").hidden), "P2: the stop button follows the conversation on screen (idle here)", null);
  let mk = await markOf(p1, 1);
  check(mk && mk[0] === "⏳" && mk[1] === "⏹", "P2: the replying tab shows ⏳, and ⏹ instead of ×", mk);
  check(!(await visibleText(p1)).includes("LATE CHUNK"), "a session/update for a conversation with no turn running is dropped", null);
  check(await p1.evaluate(() => !Array.from(document.querySelectorAll(".conv-messages")).some((l) => l.textContent.includes("LATE CHUNK"))), "…in no list at all", null);
  await p1.evaluate(() => { window.__acp.lateUpdateFor = null; window.__acp.hold = false; window.__acp.releaseSession("sess_1", " BACKGROUND DONE"); });
  await until(p1, () => { const x = document.querySelectorAll(".conv-tab")[1]; return x && (x.querySelector(".conv-tab-mark") || {}).textContent === "●"; }, "P2: ● once the background turn finished");
  mk = await markOf(p1, 1);
  check(mk[1] === "×", "P2: × is back once it finished", mk);
  check(!(await visibleText(p1)).includes("BACKGROUND DONE"), "P2: the background reply is not in the list on screen", null);
  const bg = await p1.evaluate(() => { const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => e.hidden && e.textContent.includes("long one")); return l ? l.textContent : ""; });
  check(bg.includes("BACKGROUND DONE"), "P2: …it is in its own conversation's list", bg.slice(-120));
  let notesP2 = await p1.evaluate(() => window.__notes);
  check(notesP2.length === 1 && /回覆完了/.test(notesP2[0].title) && /:conv:c_[0-9a-f]{12}:/.test(notesP2[0].id), "Q9: a notification for the finished background turn", notesP2);
  const st2 = await storage(p1);
  const conv2Id = Object.keys(st2).map((k) => k.slice(5)).find((id) => /^c_/.test(id) && (st2["conv:" + id].messages || []).some((m) => /long one/.test(m.text)));
  check(conv2Id && (st2["conv:" + conv2Id].messages || []).some((m) => m.kind === "received" && /BACKGROUND DONE/.test(m.text)), "P2: the background reply is recorded in its conversation", conv2Id);
  check(notesP2[0] && notesP2[0].id.includes(":conv:" + conv2Id + ":"), "Q9: …naming that conversation", notesP2[0] && notesP2[0].id);
  // ⏹ on a background tab stops only that conversation's turn.
  await p1.evaluate(() => { window.__acp.hold = true; });
  await p1.evaluate(() => document.querySelectorAll(".conv-tab")[1].click());
  check(!(await p1.evaluate(() => document.querySelectorAll(".conv-tab")[1].querySelector(".conv-tab-mark").textContent)), "P2: ● goes once the conversation is shown", null);
  check((await visibleText(p1)).includes("BACKGROUND DONE"), "P2: the background reply is there when switched to", null);
  await send(p1, "stop me from the strip");
  await until(p1, () => !document.getElementById("stop-btn").hidden, "a second running turn");
  await p1.evaluate(() => document.querySelectorAll(".conv-tab")[0].click());
  await until(p1, () => { const x = document.querySelectorAll(".conv-tab")[1]; return x && x.querySelector(".conv-tab-close").textContent === "⏹"; }, "⏹ on the background tab");
  await p1.evaluate(() => { window.__notes.length = 0; document.querySelectorAll(".conv-tab")[1].querySelector(".conv-tab-close").click(); });
  await until(p1, () => { const x = document.querySelectorAll(".conv-tab")[1]; return x && x.querySelector(".conv-tab-close").textContent === "×"; }, "P2: ⏹ stopped the background turn");
  check(await p1.evaluate(() => document.querySelectorAll(".conv-tab").length) === 2, "P2: ⏹ did not archive it", null);
  check((await p1.evaluate(() => window.__notes)).length === 0, "Q9: a turn the user stopped raises no notification", await p1.evaluate(() => window.__notes));
  await p1.evaluate(() => { window.__acp.hold = false; });
  await p1.evaluate(() => document.querySelectorAll(".conv-tab")[1].click());
  await until(p1, () => document.getElementById("stop-btn").hidden, "stopped");
  // §5: a full pool (openab's Service Busy chat line, review #143) is an error bubble with 重試 —
  // not an agent reply: nothing recorded as received; 重試 sends the same prompt again.
  await p1.evaluate(() => { window.__acp.poolBusy = true; });
  await send(p1, "while the pool is full");
  await until(p1, () => !!Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden)?.querySelector(".error-bubble .retry-btn"), "the pool-full error bubble");
  const busyText = await visibleText(p1);
  check(busyText.includes("同時進行的對話已滿") && !busyText.includes("Service Busy"), "§5: a full pool says so plainly, not as a reply", busyText.slice(-160));
  const busyConv = Object.values(await storage(p1)).find((v) => v && Array.isArray(v.messages) && v.messages.some((m) => /while the pool is full/.test(m.text)));
  check(busyConv && !busyConv.messages.some((m) => m.kind === "received" && /Service Busy/.test(m.text)), "§5: …and is not recorded as the agent's reply", busyConv && busyConv.messages.slice(-2));
  await p1.evaluate(() => { window.__acp.poolBusy = false; Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden).querySelector(".error-bubble .retry-btn").click(); });
  await until(p1, () => window.__acp.log.filter((m) => m.method === "session/prompt" && m.params.prompt[0].text.includes("while the pool is full")).length === 2, "§5: 重試 after a full pool");
  await until(p1, () => document.getElementById("stop-btn").hidden, "the retried turn done");

  // Switch back: no second resume on the same socket; its list (and messages) are back.
  await p1.evaluate(() => document.querySelectorAll(".conv-tab")[0].click());
  t = await tabs(p1);
  check(t[0].current, "switching back works once idle", t);
  check((await visibleText(p1)).includes("hello again"), "the first conversation's list is shown again", null);
  log = await acpLog(p1);
  check(log.filter((m) => m.method === "session/resume").length === 1, "no second session/resume on the same socket", log.filter((m) => m.method === "session/resume").length);

  // Rename by double-click.
  await p1.evaluate(() => document.querySelectorAll(".conv-tab")[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await until(p1, () => !!document.querySelector(".conv-tab-rename"), "the rename box");
  await p1.evaluate(() => { const i = document.querySelector(".conv-tab-rename"); i.value = "  My   name "; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  t = await tabs(p1);
  check(t[0].title === "My name", "rename sets a user title", t);
  await until(p1, () => { const i = JSON.parse(localStorage.getItem("ls:conv:index")); return Object.values(i).some((e) => e.title === "My name" && e.titleSource === "user"); }, "the user title is stored");

  // A′ (tunnel-liveness §9.2): a socket drop with a quick reconnect continues the run, so the
  // resumed conversation's next prompt has no host line (the agent replied in it during this run);
  // the drop is recorded for client_info (§9.3). Conversation 2's first prompt after its switch on
  // the new socket is checked below ("ask me something").
  await until(p1, () => document.getElementById("stop-btn").hidden, "idle before the drop");
  await p1.evaluate(() => { const ws = window.__acp.ws; ws.readyState = 3; ws.onclose({ code: 1006, reason: "", wasClean: false }); });
  await until(p1, () => window.__acp.log.filter((m) => m.method === "session/resume").length === 2, "the quick reconnect resumes conversation 1", null, 15000);
  await send(p1, "after the blip");
  await until(p1, () => window.__acp.log.some((m) => m.method === "session/prompt" && m.params.prompt[0].text.includes("after the blip")), "the prompt after the blip");
  log = await acpLog(p1);
  const blip = log.filter((m) => m.method === "session/prompt").pop().params.prompt[0].text;
  check(!blip.includes("just reconnected"), "A′: no host line after a quick reconnect", blip.slice(0, 80));
  const diag = await p1.evaluate(async () => (await chrome.storage.session.get("katashiro.diag.disconnects"))["katashiro.diag.disconnects"]);
  const d0 = Array.isArray(diag) ? diag[diag.length - 1] : null;
  // §9.5 (C): the socket was up well under 30 s, so this drop counts as a failure: retried after 1 s (±20 %).
  check(d0 && d0.code === 1006 && d0.wasClean === false && d0.path === "auto-reconnect" && d0.sameRun === true && Number.isFinite(d0.retryInMs) && d0.retryInMs >= 800 && d0.retryInMs <= 1200 && d0.reopenAfterMs >= d0.retryInMs && d0.windowId === 1,
    "E: the drop is recorded in storage.session with its code, path and same-run reopen", d0);
  await until(p1, () => document.getElementById("stop-btn").hidden, "idle after the blip");

  // An ask card in conversation 2, then a tool call from it while it is not on screen.
  await p1.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).find((t) => t.textContent.startsWith("Second topic")).click());
  await until(p1, () => document.querySelector(".conv-tab.current .conv-tab-title").textContent === "Second topic about tabs", "back on conversation 2");
  await p1.evaluate(() => { window.__acp.hold = true; window.__acp.askOnPrompt = true; });
  await send(p1, "ask me something");
  await until(p1, () => { const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden); return l && l.querySelector(".ask-card.pending"); }, "the ask card in conversation 2");
  await p1.evaluate(() => { window.__askCard = document.querySelector(".ask-card.pending"); window.__acp.hold = false; window.__acp.release(); });
  await until(p1, () => document.getElementById("stop-btn").hidden, "conversation 2 idle");
  const askPrompt = (await acpLog(p1)).filter((m) => m.method === "session/prompt").find((m) => m.params.prompt[0].text.includes("ask me something"));
  check(askPrompt && !askPrompt.params.prompt[0].text.includes("just reconnected"), "A′: no host line in a conversation first resumed on the new socket of the same run", askPrompt && askPrompt.params.prompt[0].text.slice(0, 80));
  const askRes = await p1.evaluate(() => window.__acp.responses[9100]);
  check(askRes && askRes.result && !askRes.result.isError, "ask_user over conversation 2's own tunnel works while it is on screen", askRes);
  // E (§9.3): the agent reads the drop through client_info, one line per disconnect.
  const ci = await p1.evaluate(() => window.__acp.callTool(window.__acp.conn, "katashiro.client_info", {}));
  await until(p1, (id) => !!window.__acp.responses[id], "client_info is answered", ci);
  const ciText = (await p1.evaluate((id) => window.__acp.responses[id], ci)).result.content[0].text;
  if (process.env.SHOW_CLIENT_INFO) console.log(ciText);
  check(/\nrecent disconnects \(newest first\):\n- \S+ \(\S+ ago\) Orca \[window 1\]: close 1006 unclean; .*→ auto-reconnect in \S+; reopened after \S+, same run/.test(ciText),
    "E: client_info lists the drop", ciText);
  await p1.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).find((t) => t.textContent.startsWith("My name")).click());
  await until(p1, () => document.querySelector(".conv-tab.current .conv-tab-title").textContent === "My name", "switched to conversation 1");
  // P2 §5: a conversation not on screen keeps the tools that touch no tab the user sees…
  const late = await p1.evaluate(() => window.__acp.callTool(window.__acp.conn, "katashiro.chat_history", {}));
  await until(p1, (id) => !!window.__acp.responses[id], "the late tool call is answered", late);
  const lateRes = await p1.evaluate((id) => window.__acp.responses[id], late);
  check(lateRes.result && !lateRes.result.isError && /ask me something/.test(lateRes.result.content[0].text) && !/hello again/.test(lateRes.result.content[0].text),
    "P2: chat_history from a conversation not on screen works, and reads ITS messages", lateRes);
  // …and is refused the rest (Q8 later opens its own group's tabs).
  const lateNav = await p1.evaluate(() => window.__acp.callTool(window.__acp.conn, "katashiro.navigate", { url: "https://example.com/" }));
  await until(p1, (id) => !!window.__acp.responses[id], "the background navigate is answered", lateNav);
  const lateNavRes = await p1.evaluate((id) => window.__acp.responses[id], lateNav);
  check(lateNavRes.result && lateNavRes.result.isError && /not on screen in Katashiro/.test(lateNavRes.result.content[0].text), "Q8: a page tool from a conversation not on screen needs a tab of its own group", lateNavRes);
  check(await p1.evaluate(() => window.__askCard.classList.contains("pending")), "its ask card stays pending (clock paused) while hidden", null);

  // Third conversation → 3 open; ＋ again → the picker.
  await p1.click(".conv-tab-new");
  await until(p1, () => document.querySelectorAll(".conv-tab").length === 3, "a third tab");
  st = await storage(p1);
  // Only live windows count (§3.3): the orphan records the migration kept for adoption do not.
  const openNow = [1, 2].flatMap((w) => (st[`window:${w}`] && st[`window:${w}`].open) || []);
  check(openNow.length === 3, "3 open across the live windows", openNow);
  await p1.click(".conv-tab-new");
  await until(p1, () => !!document.querySelector(".conv-picker"), "the picker with 3 open");
  const options = await p1.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-option")).map((b) => b.textContent));
  check(options.length === 3, "the picker lists the 3 open conversations", options);
  // Pick "Second topic about tabs" (open here, not current).
  await p1.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-option")).find((b) => b.textContent.startsWith("Second topic")).click());
  await until(p1, () => !document.querySelector(".conv-picker") && document.querySelectorAll(".conv-tab").length === 3, "archived one, opened a new one");
  t = await tabs(p1);
  check(!t.some((x) => x.title === "Second topic about tabs"), "the picked conversation left the strip", t);
  st = await storage(p1);
  const second = Object.entries(st["conv:index"]).find(([, e]) => e.title === "Second topic about tabs");
  check(second && second[1].archivedAt, "…and is archived, not deleted", second);
  const askOutcome = await p1.evaluate(() => window.__askCard.querySelector(".ask-card-result").textContent);
  check(askOutcome === "未回答（對話已封存）", "its pending ask card closed as archived (not 聊天已清除)", askOutcome);
  const lateArchived = await p1.evaluate(() => window.__acp.callTool(window.__acp.conn, "katashiro.chat_history", {}));
  await until(p1, (id) => !!window.__acp.responses[id], "a tool call on the archived conversation's tunnel is answered", lateArchived);
  const lar = await p1.evaluate((id) => window.__acp.responses[id], lateArchived);
  check(lar.error && /unknown connection/.test(lar.error.message), "…refused as an unknown connection (archive dropped its tunnels)", lar);

  // × on an empty conversation deletes it instead of archiving.
  const before = Object.keys(st["conv:index"]).length;
  await p1.evaluate(() => document.querySelector(".conv-tab.current .conv-tab-close").click());
  await until(p1, () => document.querySelectorAll(".conv-tab").length >= 1 && !document.querySelector(".conv-tab.current .conv-tab-title").textContent.startsWith("未命名") || document.querySelectorAll(".conv-tab").length === 2, "closed the empty tab");
  st = await storage(p1);
  check(Object.keys(st["conv:index"]).length <= before, "an empty conversation is not kept in the index", Object.keys(st["conv:index"]).length - before);

  // --- window 2: Web Lock + the 3-cap across windows --------------------------------------------
  // Fill window 1 back up to 3.
  while ((await p1.evaluate(() => document.querySelectorAll(".conv-tab").length)) < 3) {
    await p1.click(".conv-tab-new");
    await sleep(300);
  }
  const p2 = await openPanel(2);
  await until(p2, () => !!document.querySelector(".conv-picker"), "window 2 gets the picker (3 open in window 1)");
  const opts2 = await p2.evaluate(() => Array.from(document.querySelectorAll(".conv-picker-option")).map((b) => b.textContent));
  check(opts2.length === 3 && opts2.every((o) => o.endsWith("（另一個視窗）")), "window 2's picker lists window 1's conversations as another window's", opts2);
  await p2.evaluate(() => document.querySelector(".conv-picker-cancel").click());
  await until(p2, () => (document.querySelector(".conv-lobby") || {}).innerText.includes("已經有 3 段對話開在其他視窗"), "取消 leaves the notice with focus buttons");
  await p2.evaluate(() => Array.from(document.querySelectorAll(".system-action")).find((b) => b.textContent.startsWith("前往")).click());
  await until(p2, () => window.__focused.includes(1), "a 前往 button focuses window 1");

  // Window 2's record claims a conversation window 1 has open: the lock refuses it.
  await p2.close();
  const w1open = (await storage(p1))["window:1"].open;
  await p1.evaluate((id) => localStorage.setItem("ls:window:2", JSON.stringify({ open: [id], current: id, savedAt: Date.now() })), w1open[0]);
  const p2b = await browser.newPage();
  p2b.on("pageerror", (e) => fail(`page error (win 2b): ${e.message}`));
  await p2b.goto(`${origin}/sidepanel.html?win=2`, { waitUntil: "load" });
  await until(p2b, () => (document.getElementById("messages-list") || {}).innerText.includes("這段對話開在另一個視窗"), "window 2 does not open window 1's conversation");
  await p2b.close();

  // --- gallery: the 對話 section ------------------------------------------------------------------
  const g = await browser.newPage();
  g.on("pageerror", (e) => fail(`page error (gallery): ${e.message}`));
  await g.goto(`${origin}/canvas-gallery.html?win=1`, { waitUntil: "load" });
  await until(g, () => document.querySelectorAll("#conv-list .conv-row").length > 0, "the gallery lists conversations");
  const rows = await g.evaluate(() => Array.from(document.querySelectorAll("#conv-list .conv-row")).map((r) => r.innerText));
  check(rows.some((r) => r.includes("Second topic about tabs")), "the archived conversation is listed by title", rows);
  check(!rows.some((r) => r.includes("My name")), "a conversation open in a live window is not listed", rows);
  await g.evaluate(() => { const s = document.getElementById("gallery-search"); s.value = "second"; s.dispatchEvent(new Event("input")); });
  await sleep(400);
  const filtered = await g.evaluate(() => Array.from(document.querySelectorAll("#conv-list .conv-row")).map((r) => r.innerText));
  check(filtered.length === 1 && filtered[0].includes("Second topic"), "the search box filters conversation titles", filtered);
  // 重新打開: opens the side panel for its window in the click, leaves the request, asks the panel.
  await g.evaluate(() => document.querySelector("#conv-list .conv-reopen").click());
  await until(g, () => window.__sidePanelOpened.length === 1 && window.__messages.some((m) => m.type === "katashiro-conv-open"), "重新打開 opens the panel and sends katashiro-conv-open");
  const req = await g.evaluate(() => window.__messages.find((m) => m.type === "katashiro-conv-open"));
  check(req.windowId === 1 && /^c_[0-9a-f]{12}$/.test(req.id), "the request names the gallery's window and the conversation", req);
  // The panel handles it (delivered by hand: no runtime messaging between stub pages). Window 1 is full: the picker.
  const r1 = await p1.evaluate((m) => window.__deliver(m, "/canvas-gallery.html"), req);
  check(r1 && r1.ok === false, "reopen with 3 open is not done at once", r1);
  await until(p1, () => !!document.querySelector(".conv-picker"), "…the panel asks which to archive");
  await p1.evaluate(() => document.querySelector(".conv-picker-option:not(:disabled)").click());
  await until(p1, () => Array.from(document.querySelectorAll(".conv-tab-title")).some((e) => e.textContent === "Second topic about tabs"), "after archiving one, the conversation is reopened");
  t = await tabs(p1);
  check(t.find((x) => x.current).title === "Second topic about tabs", "…and switched to", t);
  check((await visibleText(p1)).includes("Second topic"), "its messages are back", null);
  // Resumes so far: conversation 1 on load and after the drop (A′ above), conversation 2 on its switch.
  await until(p1, () => window.__acp.log.filter((m) => m.method === "session/resume").length === 4, "the reopened conversation resumes its session");
  log = await acpLog(p1);
  check(log.filter((m) => m.method === "session/resume")[3].params.sessionId === "sess_1", "…the same ACP session", log.filter((m) => m.method === "session/resume")[3]);

  // A′: a clean close (the server shut its side on purpose — a rolling deploy or a restart) starts a
  // new run however fast the reconnect, so the next prompt carries the host line again.
  const resumesBefore = await p1.evaluate(() => window.__acp.log.filter((m) => m.method === "session/resume").length);
  await p1.evaluate(() => { const ws = window.__acp.ws; ws.readyState = 3; ws.onclose({ code: 1012, reason: "service restart", wasClean: true }); });
  await until(p1, (n) => window.__acp.log.filter((m) => m.method === "session/resume").length > n, "the reconnect after a clean close resumes", resumesBefore, 15000);
  await send(p1, "after the restart");
  await until(p1, () => window.__acp.log.some((m) => m.method === "session/prompt" && m.params.prompt[0].text.includes("after the restart")), "the prompt after the clean close");
  const restarted = (await acpLog(p1)).filter((m) => m.method === "session/prompt").pop().params.prompt[0].text;
  check(restarted.startsWith("[katashiro: this conversation was just reconnected."), "A′: the host line after a quick reconnect that followed a clean close", restarted.slice(0, 80));
  const diag2 = await p1.evaluate(async () => (await chrome.storage.session.get("katashiro.diag.disconnects"))["katashiro.diag.disconnects"]);
  const d1 = Array.isArray(diag2) ? diag2[diag2.length - 1] : null;
  check(d1 && d1.code === 1012 && d1.wasClean === true && d1.sameRun === false, "E: the clean close is recorded with a new-run reopen", d1);
  await until(p1, () => document.getElementById("stop-btn").hidden, "idle after the clean close");

  // 重新打開 into a window with no panel while 3 are open elsewhere: the panel loads full (picker →
  // "new conversation"), then picks up the pending reopen. After the pick the REOPEN must win.
  st = await storage(p1);
  const archivedNow = Object.entries(st["conv:index"]).filter(([, e]) => e.archivedAt && e.title).map(([id, e]) => ({ id, title: e.title }));
  check(archivedNow.length > 0, "an archived conversation to reopen", archivedNow);
  await p1.close();                                    // window 1 stays live; its locks are free
  const pr = await browser.newPage();
  pr.on("pageerror", (e) => fail(`page error (win 2, reopen): ${e.message}`));
  await pr.goto(`${origin}/sidepanel.html?win=2&reopen=${archivedNow[0].id}`, { waitUntil: "load" });
  await until(pr, () => !!document.querySelector(".conv-picker"), "the full panel shows the picker");
  await sleep(500);
  check(await pr.evaluate(() => document.querySelectorAll(".conv-picker").length) === 1, "one picker, not two", null);
  await pr.evaluate(() => document.querySelector(".conv-picker-option:not(:disabled)").click());
  await until(pr, (title) => Array.from(document.querySelectorAll(".conv-tab-title")).some((e) => e.textContent === title), "after the pick, the requested conversation is reopened (not a new blank one)", archivedNow[0].title);
  t = await tabs(pr);
  check(t.length === 1 && t[0].current && t[0].title === archivedNow[0].title, "…as window 2's only, current conversation", t);
  await pr.close();

  // --- P1b (ADR §4): a tab group per conversation, working tab, Q5/Q6/Q12, drafts, set_title, ---
  // archive closes / reopen restores, browser-restart adoption, push refusals, Q4 b order.
  {
    const pb = await browser.newPage();
    await pb.goto(`${origin}/manifest.json`);
    await pb.evaluate(() => { localStorage.clear(); localStorage.setItem("ls:__live", "[5]"); });
    await pb.close();
  }
  const q = await openPanel(5);
  await until(q, () => window.__acp.log.some((m) => m.method === "session/new"), "P1b: conversation A has a session");
  const turnIdle = () => until(q, () => document.getElementById("stop-btn").hidden, "turn idle");
  const tool = async (name, args) => {
    const id = await q.evaluate((n, a) => window.__acp.callTool(window.__acp.conn, n, a), name, args);
    await until(q, (i) => !!window.__acp.responses[i], `${name} answered`, id);
    return q.evaluate((i) => window.__acp.responses[i], id);
  };
  const tm = () => q.evaluate(() => window.__tm());
  const convA = await q.evaluate(() => JSON.parse(localStorage.getItem("ls:window:5")).current);
  // A turn whose tunnel is connected; the agent opens a tab in the background.
  await q.evaluate(() => { window.__acp.hold = true; window.__acp.connectOnPrompt = true; });
  await send(q, "Research topic A");
  await until(q, () => !!window.__acp.conn, "P1b: A's tunnel");
  let r = await tool("katashiro.new_tab", { url: "https://agent.example/a", active: false });
  check(r.result && !r.result.isError, "new_tab works", r);
  let model = await tm();
  const agentTab = model.tabs.find((t) => t.url === "https://agent.example/a");
  check(agentTab && agentTab.groupId > 0, "the agent's new tab joins a tab group", agentTab);
  const gA = agentTab && agentTab.groupId;
  check(model.groups[gA] && model.groups[gA].title === "Research topic A", "…titled after the conversation", model.groups[gA]);
  await until(q, (id) => { const c = JSON.parse(localStorage.getItem("ls:conv:" + id)); return c && c.groupTabs && c.groupTabs.includes("https://agent.example/a") && c.workingTab && c.workingTab.url === "https://agent.example/a"; }, "conv:<A> records groupTabs and the working tab", convA);
  r = await tool("katashiro.set_title", { title: "  Topic\u202E A  by agent " });
  check(r.result && !r.result.isError && /renamed to "Topic A by agent"/.test(r.result.content[0].text), "set_title renames (sanitised)", r);
  check((await tabs(q))[0].title === "Topic A by agent", "…the tab strip shows it", await tabs(q));
  await until(q, () => Object.values(JSON.parse(localStorage.getItem("ls:conv:index"))).some((e) => e.title === "Topic A by agent" && e.titleSource === "agent"), "…stored as titleSource agent");
  await until(q, (g) => window.__tm().groups[g].title === "Topic A by agent", "…and the group follows", gA);

  // Q4 b order (§3.8): a card pending at the send closes; one asked after it (message queued) stays.
  r = await tool("katashiro.ask_user", { question: "Before?", options: ["x", "y"] });
  await send(q, "typed while the turn runs");
  r = await tool("katashiro.ask_user", { question: "After?", options: ["x", "y"] });
  const cards = await q.evaluate(() => Array.from(document.querySelectorAll(".ask-card")).map((c) => [c.querySelector(".ask-card-question").textContent, c.className]));
  check(cards.length === 2 && /unanswered/.test(cards[0][1]) && /pending/.test(cards[1][1]), "Q4 b: the card pending at the send closes, the one asked after it stays", cards);
  await q.evaluate(() => { window.__acp.hold = false; window.__acp.release(); });
  await turnIdle();
  await sleep(300);
  await turnIdle();

  // Q6: the user is on a tab of their own; pressing send brings the working tab forward.
  const userTab = await q.evaluate(() => window.__userTab("https://user.example/"));
  model = await tm();
  check(!model.tabs.find((t) => t.id === userTab.id).groupId || model.tabs.find((t) => t.id === userTab.id).groupId === -1, "a tab the user opened is never grouped", null);
  await send(q, "now look");
  await until(q, (id) => window.__tm().tabs.find((t) => t.id === id).active, "Q6: the working tab is activated at the send", agentTab.id);
  await turnIdle();

  // §4.3 (fix 2026-10-13): a canvas the agent puts in front becomes the working tab, so the next send
  // stays on it instead of jumping back to the last page the agent touched; a background open does not.
  await q.evaluate(() => { window.__acp.hold = true; window.__acp.connectOnPrompt = true; window.__acp.conn = null; });
  await send(q, "show me the deck");
  await until(q, () => !!window.__acp.conn, "§4.3: A's tunnel for the canvas tools");
  r = await tool("katashiro.canvas_open", { title: "Deck", kind: "slides", content: "# A\n---\nb" });
  check(r.result && !r.result.isError, "canvas_open works", r);
  const deckId = r.result && (/id (cv_[0-9a-f]+)/.exec(r.result.content[0].text) || [])[1];
  model = await tm();
  const deckTab = model.tabs.find((t) => t.url.endsWith(`id=${deckId}`));
  check(deckTab && !deckTab.active, "a new canvas opens in a background tab", deckTab);
  let stW = (await storage(q))[`conv:${convA}`];
  check(stW.workingTab && stW.workingTab.id === agentTab.id, "…and does not take the working tab", stW.workingTab);
  r = await tool("katashiro.canvas_highlight", { id: deckId, heading: "A" });
  check(r.result && !r.result.isError, "canvas_highlight works", r);
  await until(q, (a) => { const c = JSON.parse(localStorage.getItem("ls:conv:" + a[0])); return c.workingTab && c.workingTab.id === a[1]; }, "§4.3: canvas_highlight makes the canvas tab the working tab", [convA, deckTab && deckTab.id]);
  await q.evaluate(() => { window.__acp.hold = false; window.__acp.release(); });
  await turnIdle();
  await q.evaluate((id) => window.chrome.tabs.update(id, { active: true }), agentTab.id);   // the user looks back at the page
  await send(q, "and now?");
  await until(q, (id) => window.__tm().tabs.find((t) => t.id === id).active, "§4.3: the send brings the canvas forward, not the old page", deckTab && deckTab.id);
  await turnIdle();
  // A push from a canvas tab (the stub's sender is tab 99) makes that tab the working tab.
  await q.evaluate((u) => { const m = window.__tm(); m.tabs.push({ id: 99, windowId: 5, url: u, active: false, groupId: -1, splitViewId: -1, pinned: false, index: 98, lastAccessed: 1 }); window.__tmSave(m); }, `${origin}/canvas.html?id=${deckId}`);
  r = await q.evaluate((m) => window.__deliver(m, "/canvas.html?id=" + m.id), { type: "katashiro-canvas-push", conversationId: convA, id: deckId, text: "from the deck", note: "", reqId: "pw1" });
  check(r && r.ok, "a push from a canvas tab is posted", r);
  await until(q, (a) => { const c = JSON.parse(localStorage.getItem("ls:conv:" + a)); return c.workingTab && c.workingTab.id === 99; }, "§4.3: a push makes the pushing canvas tab the working tab", convA);
  await turnIdle();
  // Put things back as the rest of the run expects: the agent's page is the working tab again.
  await q.evaluate(() => { const m = window.__tm(); m.tabs = m.tabs.filter((t) => t.id !== 99); window.__tmSave(m); });
  await q.evaluate(() => { window.__acp.hold = true; window.__acp.connectOnPrompt = true; window.__acp.conn = null; });
  await send(q, "back to the page");
  await until(q, () => !!window.__acp.conn, "A's tunnel for switch_tab");
  await tool("katashiro.switch_tab", { url: "https://agent.example/a" });
  await until(q, (a) => { const c = JSON.parse(localStorage.getItem("ls:conv:" + a[0])); return c.workingTab && c.workingTab.id === a[1]; }, "switch_tab: the agent's page is the working tab again", [convA, agentTab.id]);
  await q.evaluate(() => { window.__acp.hold = false; window.__acp.release(); });
  await turnIdle();

  // Draft: typed text stays with its conversation.
  await q.evaluate(() => { const i = document.getElementById("message-input"); i.value = "draft for A"; i.dispatchEvent(new Event("input")); });
  // Q12: a card left waiting in A.
  await q.evaluate(() => { window.__acp.hold = true; });
  await send(q, "ask me");
  r = await tool("katashiro.ask_user", { question: "Waiting?", options: ["x", "y"] });
  await q.evaluate(() => { window.__acp.hold = false; window.__acp.release(); });
  await turnIdle();
  await q.evaluate(() => { const i = document.getElementById("message-input"); i.value = "draft for A"; i.dispatchEvent(new Event("input")); });
  // ＋ → B: Q5 leaves A's group expanded (Brett 2026-10-13 16:01) but moves the user off it; Q12
  // marks A and notifies.
  await q.click(".conv-tab-new");
  await until(q, () => document.querySelectorAll(".conv-tab").length === 2, "P1b: conversation B");
  await until(q, (g) => !window.__tm().tabs.find((t) => t.active && t.windowId === 5 && t.groupId === g), "Q5: the active tab moves outside A's group", gA);
  model = await tm();
  check(model.groups[gA].collapsed === false, "Q5: A's group stays expanded on the switch", model.groups[gA]);
  check((await q.evaluate(() => window.__collapses)).length === 0, "Q5: no group is collapsed on a switch", await q.evaluate(() => window.__collapses));
  check(await q.evaluate(() => document.getElementById("message-input").value) === "", "draft: B starts with an empty composer", null);
  const marks = await q.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).map((t) => [t.classList.contains("mark-waiting"), (t.querySelector(".conv-tab-mark") || {}).textContent]));
  check(marks[0][0] && marks[0][1] === "❓" && !marks[1][0], "Q12: A's tab shows ❓", marks);
  const notes = await q.evaluate(() => window.__notes);
  check(notes.length === 1 && notes[0].id.startsWith("katashiro-notify:5:conv:" + convA + ":"), "Q12: a notification names A", notes);
  // P2 Q8: A is in the background. Its page tools act on its working tab (agent.example/a, in A's
  // group) without bringing it forward; if the user collapsed that group by hand, they expand it
  // (Chrome freezes a collapsed group's pages); screenshot is refused; the user's own tab is never its to touch;
  // new_tab opens in the background, in A's group, as its new working tab.
  {
    model = await tm();
    // The user collapses A's group by hand (Katashiro never does, Q5).
    await q.evaluate((g) => { const m = window.__tm(); m.groups[g].collapsed = true; window.__tmSave(m); }, gA);
    model = await tm();
    const aTab = model.tabs.find((x) => x.url === "https://agent.example/a");
    const userTab = model.tabs.find((x) => x.active && x.windowId === 5);
    await q.evaluate(() => { window.__scripted = []; });
    r = await tool("katashiro.get_text", {});
    check(r.result && !r.result.isError && /PAGE https:\/\/agent\.example\/a/.test(r.result.content[0].text), "Q8: a background page tool reads ITS working tab", r);
    model = await tm();
    check(model.tabs.find((x) => x.id === userTab.id).active && !model.tabs.find((x) => x.id === aTab.id).active,
      "Q8: …without activating it", model.tabs.filter((x) => x.active));
    check(model.groups[gA].collapsed === false, "Q8: …and its group, collapsed by hand, is expanded (a collapsed group is frozen)", model.groups[gA]);
    await q.evaluate((g) => { const m = window.__tm(); m.groups[g].collapsed = true; window.__tmSave(m); }, gA);
    r = await tool("katashiro.screenshot", {});
    check(r.result && r.result.isError && /in the background in Katashiro/.test(r.result.content[0].text), "Q8: screenshot is refused in the background", r);
    // The user steps onto A's tab (without switching the panel): A may not touch it, nor write in its group.
    await q.evaluate((id) => { const m = window.__tm(); m.tabs.forEach((x) => { if (x.windowId === 5) x.active = x.id === id; }); window.__tmSave(m); }, aTab.id);
    await q.evaluate(() => { window.__scripted = []; });
    r = await tool("katashiro.get_text", {});
    check(r.result && r.result.isError && /the user is looking at that tab/.test(r.result.content[0].text), "Q8: never the tab the user is on", r);
    check((await q.evaluate(() => window.__scripted)).length === 0, "Q8: …nothing was injected into it", await q.evaluate(() => window.__scripted));
    await q.evaluate((id) => { const m = window.__tm(); m.tabs.forEach((x) => { if (x.windowId === 5) x.active = x.id === id; }); window.__tmSave(m); }, userTab.id);
    // The user is on a tab of A's group in ANOTHER window (not the panel's, not focused): still seen.
    await q.evaluate((g) => { const m = window.__tm(); m.tabs.push({ id: 9001, windowId: 9, url: "https://agent.example/other-window", active: true, groupId: g, splitViewId: -1, pinned: false, index: m.tabs.length, lastAccessed: ++m.clock }); window.__tmSave(m); }, gA);
    r = await tool("katashiro.navigate", { url: "https://agent.example/x" });
    check(r.result && r.result.isError && /looking at one of your conversation's tabs/.test(r.result.content[0].text), "Q8: the active tab of every window counts as the user's", r);
    await q.evaluate(() => { const m = window.__tm(); m.tabs = m.tabs.filter((x) => x.id !== 9001); window.__tmSave(m); });
    // new_tab from the background: not active, in A's group (expanded), A's new working tab.
    r = await tool("katashiro.new_tab", { url: "https://agent.example/b", active: true });
    check(r.result && !r.result.isError && /your working tab/.test(r.result.content[0].text), "Q8: new_tab from the background says where it went", r);
    model = await tm();
    const bTab = model.tabs.find((x) => x.url === "https://agent.example/b");
    check(bTab && !bTab.active && bTab.groupId === gA && model.groups[gA].collapsed === false && model.tabs.find((x) => x.id === userTab.id).active,
      "Q8: …opened in the background, in A's group, which is expanded; the user stays where they were", { bTab, g: model.groups[gA] });
    await q.evaluate(() => { window.__scripted = []; });
    r = await tool("katashiro.get_text", {});
    check(r.result && !r.result.isError && /agent\.example\/b/.test(r.result.content[0].text), "Q8: the next page tool acts on the new tab", r);
    // switch_tab back to the first tab: selected, not activated.
    r = await tool("katashiro.switch_tab", { url: "agent.example/a" });
    model = await tm();
    check(r.result && !r.result.isError && /not brought to the front/.test(r.result.content[0].text) && !model.tabs.find((x) => x.id === aTab.id).active,
      "Q8: background switch_tab selects without activating", r);
    // close_tab of the user's own tab is refused; of its own tab, done.
    const list = await q.evaluate(() => chrome.tabs.query({}));
    r = await tool("katashiro.close_tab", { index: list.findIndex((x) => x.id === userTab.id) });
    check(r.result && r.result.isError && (await tm()).tabs.some((x) => x.id === userTab.id), "Q8: close_tab never closes the user's tab from the background", r);
    r = await tool("katashiro.close_tab", { url: "agent.example/b" });
    check(r.result && !r.result.isError && !(await tm()).tabs.some((x) => x.id === bTab.id), "Q8: close_tab closes one of its own tabs", r);
  }
  await q.evaluate(() => { const i = document.getElementById("message-input"); i.value = "draft for B"; i.dispatchEvent(new Event("input")); });
  // The notification click goes back to A, with its draft; A's group, collapsed by hand meanwhile,
  // is expanded on the switch (Q5), and still no group is collapsed by a switch.
  await q.evaluate((g) => { const m = window.__tm(); m.groups[g].collapsed = true; window.__tmSave(m); }, gA);
  await q.evaluate((id) => window.__notifyClick(id), notes[0].id);
  await until(q, () => document.querySelector(".conv-tab.current .conv-tab-title").textContent === "Topic A by agent", "Q12: the notification click switches to A");
  check(await q.evaluate(() => document.getElementById("message-input").value) === "draft for A", "draft: A's draft is back", await q.evaluate(() => document.getElementById("message-input").value));
  await until(q, (g) => window.__tm().groups[g].collapsed === false, "Q5: A's group, collapsed by hand, expands when A is back", gA);
  await q.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).find((t) => !t.classList.contains("current")).click());
  await until(q, () => document.querySelector(".conv-tab.current .conv-tab-title").textContent !== "Topic A by agent", "Q5: back to B");
  await new Promise((res) => setTimeout(res, 200));
  check((await tm()).groups[gA].collapsed === false && (await q.evaluate(() => window.__collapses)).length === 0,
    "Q5: switching to B again leaves A's group expanded", { g: (await tm()).groups[gA], c: await q.evaluate(() => window.__collapses) });
  check(await q.evaluate(() => document.getElementById("message-input").value) === "draft for B", "draft: B's draft is back", null);

  // To chat input (canvas §3.7, Brett 2026-10-13 01:12): a canvas's 📨 puts the selected text into
  // the input box of its conversation, as plain text; nothing is sent to the agent.
  {
    const convB = await q.evaluate(() => JSON.parse(localStorage.getItem("ls:window:5")).current);
    const prompts = async () => (await acpLog(q)).filter((m) => m.method === "session/prompt").length;
    const p0 = await prompts();
    const toInput = (conversationId, text, reqId, from = "/canvas.html?id=cv_000000000abc") =>
      q.evaluate((m, f) => window.__deliver(m, f), { type: "katashiro-canvas-to-input", conversationId, text, reqId }, from);
    const composer = () => q.evaluate(() => {
      const i = document.getElementById("message-input");
      return { value: i.value, focused: document.activeElement === i, caret: i.selectionStart, sendEnabled: !document.getElementById("send-btn").disabled };
    });
    const setInput = (t) => q.evaluate((v) => { const i = document.getElementById("message-input"); i.value = v; i.dispatchEvent(new Event("input")); i.blur(); }, t);
    // The current conversation, with a draft: kept, the selection on a new line, the input focused.
    r = await toInput(convB, "Selected words.", "ti1");
    let c = await composer();
    check(r && r.ok && !r.draft && c.value === "draft for B\nSelected words." && c.focused && c.caret === c.value.length && c.sendEnabled,
      "to input: a draft is kept, the selection appended on a new line, the input focused (caret at the end)", { r, c });
    r = await toInput(convB, "Selected words.", "ti1");
    check(r && !r.ok && r.error === "duplicate", "to input: the same request id twice goes in once", r);
    // An empty input: exactly the selection.
    await setInput("");
    r = await toInput(convB, "Only this, as selected.", "ti2");
    c = await composer();
    check(r && r.ok && c.value === "Only this, as selected." && c.focused, "to input: an empty input gets exactly the selection", c);
    // Refused: a compare tab, over the selection cap, an archived conversation (as a push).
    r = await toInput(convB, "x", "ti3", "/canvas.html?id=cv_000000000abc&view=agent");
    check(r && !r.ok && r.error === "not from a Katashiro canvas", "to input: refused from a compare tab", r);
    r = await toInput(convB, "x".repeat(20 * 1024 + 1), "ti4");
    check(r && !r.ok && (await composer()).value === "Only this, as selected.", "to input: over 20 KB is refused, the input untouched", r);
    // Another open conversation (A): the panel switches to it; A's draft is kept, B's goes with B.
    await setInput("draft for B");
    r = await toInput(convA, "From A's canvas.", "ti5");
    c = await composer();
    check(r && r.ok && !r.draft && c.value === "draft for A\nFrom A's canvas." && c.focused, "to input: A's canvas switches the panel to A, appended to A's draft", { r, c });
    check(await q.evaluate(() => document.querySelector(".conv-tab.current .conv-tab-title").textContent) === "Topic A by agent", "to input: A is current", null);
    // P2: while A is replying the panel still switches — B's canvas brings B, after B's own draft;
    // A keeps replying in the background.
    await q.evaluate(() => { window.__acp.hold = true; });
    await send(q, "busy in A");
    await until(q, () => !document.getElementById("stop-btn").hidden, "A replying");
    r = await toInput(convB, "While A replies.", "ti6");
    c = await composer();
    check(r && r.ok && !r.draft && c.value === "draft for B\nWhile A replies." && await q.evaluate(() => document.querySelector(".conv-tab.current .conv-tab-title").textContent) !== "Topic A by agent",
      "to input: while A replies, P2 still switches to B — the text after B's draft", { r, c });
    check(await q.evaluate(() => !!document.querySelector(".conv-tab.mark-replying")), "to input: A is still replying behind (⏳)", null);
    await q.evaluate(() => { window.__acp.hold = false; window.__acp.release(); });
    await until(q, () => !document.querySelector(".conv-tab.mark-replying"), "A done in the background");
    check(await prompts() === p0 + 1, "to input: nothing was sent to the agent (only the message typed in A)", { p0, now: await prompts() });

    // To chat input, then Enter (canvas §3.7, Brett 2026-10-13 16:31): the canvas tab asks the panel
    // to send its input, exactly as the send button.
    const submit = (conversationId, reqId, from = "/canvas.html?id=cv_000000000abc") =>
      q.evaluate((m, f) => window.__deliver(m, f), { type: "katashiro-canvas-submit-input", conversationId, reqId }, from);
    const inputNow = await composer();
    r = await submit(convB, "s0", "/canvas.html?id=cv_000000000abc&view=agent");
    check(r && !r.ok && r.error === "not from a Katashiro canvas", "submit: refused from a compare tab", r);
    r = await submit(convB, "s0b", "/sidepanel.html");
    check(r && !r.ok && r.error === "not from a Katashiro canvas", "submit: refused from a page that is not canvas.html", r);
    r = await submit(convA, "s1");
    check(r && !r.ok && r.notCurrent && (await composer()).value === inputNow.value && await prompts() === p0 + 1,
      "submit: a conversation not on screen is refused (nothing sent, the input untouched)", r);
    await setInput("   ");
    r = await submit(convB, "s2");
    check(r && !r.ok && /輸入框是空的/.test(r.error) && await prompts() === p0 + 1, "submit: an empty input sends nothing", r);
    await setInput("Sent from the canvas by Enter.");
    r = await submit(convB, "s3");
    check(r && r.ok && (await composer()).value === "", "submit: the input is sent and cleared, as by the send button", { r, c: await composer() });
    await until(q, (n) => window.__acp.log.filter((m) => m.method === "session/prompt").length === n, "submit: the prompt", p0 + 2);
    const last = (await acpLog(q)).filter((m) => m.method === "session/prompt").pop();
    check(JSON.stringify(last.params).includes("Sent from the canvas by Enter."), "submit: the agent gets the input's text", last.params);
    check((await visibleText(q)).includes("Sent from the canvas by Enter."), "submit: shown as the user's message", null);
    await setInput("again");
    r = await submit(convB, "s3");
    check(r && !r.ok && r.error === "duplicate" && (await composer()).value === "again", "submit: the same request id twice sends once", r);
    await new Promise((res) => setTimeout(res, 200));
    check(await prompts() === p0 + 2, "submit: exactly one prompt from the canvas's Enter", { p0, now: await prompts() });
    await turnIdle();
    await setInput("draft for B");
  }
  await q.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).find((t) => !t.classList.contains("current")).click());

  // set_title never overrides a user name.
  await q.evaluate(() => document.querySelector(".conv-tab.current").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
  await until(q, () => !!document.querySelector(".conv-tab-rename"), "the rename box (A)");
  await q.evaluate(() => { const i = document.querySelector(".conv-tab-rename"); i.value = "Brett's A"; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await q.evaluate(() => { window.__acp.hold = true; window.__acp.connectOnPrompt = true; });
  await send(q, "rename it?");
  await until(q, () => !!window.__acp.conn, "A's tunnel again");
  r = await tool("katashiro.set_title", { title: "Agent's idea" });
  check(r.result && r.result.isError && /user named this conversation/.test(r.result.content[0].text), "set_title refuses over a user name", r);
  check((await tabs(q)).find((t) => t.current).title === "Brett's A", "…the user's name stays", await tabs(q));
  await q.evaluate(() => { window.__acp.hold = false; window.__acp.release(); });
  await turnIdle();

  // Archive A: its group's tabs close (a canvas tab that does not answer the dirty check stays),
  // the list of URLs is kept for the reopen.
  const canvasUrl = `${origin}/canvas.html?id=cv_000000000abc`;
  await q.evaluate((u, g) => { const m = window.__tm(); m.tabs.push({ id: 900, windowId: 5, url: u, active: false, groupId: g, splitViewId: -1, pinned: false, index: 99, lastAccessed: 1 }); window.__tmSave(m); }, canvasUrl, gA);
  await q.evaluate(() => document.querySelector(".conv-tab.current .conv-tab-close").click());
  await until(q, () => document.querySelectorAll(".conv-tab").length === 1, "P1b: A archived", null, 12000);
  model = await tm();
  check(!model.tabs.some((t) => t.url === "https://agent.example/a"), "archive closes the agent's tab", model.tabs.map((t) => t.url));
  check(model.tabs.some((t) => t.id === 900), "…but not a canvas tab that may hold unsaved edits", null);
  check((await visibleText(q)).includes("未儲存的修改"), "…and says so", await visibleText(q));
  check(model.tabs.some((t) => t.id === userTab.id), "the user's own tab stays", null);
  let stA = (await storage(q))[`conv:${convA}`];
  check(stA.groupTabs.includes("https://agent.example/a") && stA.groupTabs.includes(canvasUrl), "the closed tabs' URLs stay recorded", stA.groupTabs);

  // Push refusals (§4.8): conversation A is archived → 已封存; a conversation open in a live window
  // whose panel is closed → that window's panel is closed.
  r = await q.evaluate((m) => window.__deliver(m, "/canvas.html?id=cv_000000000abc"), { type: "katashiro-canvas-push", conversationId: convA, text: "x", note: "", reqId: "p1" });
  check(r && r.ok === false && r.error === "這段對話已封存，先從總覽重新打開", "push for an archived conversation: 已封存", r);
  r = await q.evaluate((m) => window.__deliver(m, "/canvas.html?id=cv_000000000abc"), { type: "katashiro-canvas-to-input", conversationId: convA, text: "x", reqId: "ti9" });
  check(r && r.ok === false && r.error === "這段對話已封存，先從總覽重新打開", "to input for an archived conversation: the same 已封存", r);
  await q.evaluate((id) => { localStorage.setItem("ls:__live", "[5,6]"); localStorage.setItem("ls:window:6", JSON.stringify({ open: [id], current: id, savedAt: Date.now() })); }, ID(77));
  r = await q.evaluate((m) => window.__deliver(m, "/canvas.html?id=cv_000000000abc"), { type: "katashiro-canvas-push", conversationId: ID(77), text: "x", note: "", reqId: "p2" });
  check(r && r.ok === false && /另一個視窗，那個視窗的側邊欄沒開/.test(r.error) && r.windowId === 6, "push for a conversation whose window's panel is closed says so, with the window", r);
  await q.evaluate(() => { localStorage.setItem("ls:__live", "[5]"); localStorage.removeItem("ls:window:6"); });

  // Reopen A from the gallery: its tabs come back into one group; the open canvas tab is adopted, not duplicated.
  r = await q.evaluate((id) => window.__deliver({ type: "katashiro-conv-open", id, windowId: 5, reqId: "r1" }, "/canvas-gallery.html"), convA);
  check(r && r.ok, "reopen A", r);
  await until(q, () => window.__tm().tabs.some((t) => t.url === "https://agent.example/a"), "reopen: the agent's tab is opened again");
  await until(q, () => { const m = window.__tm(); const a = m.tabs.find((t) => t.url === "https://agent.example/a"); const c = m.tabs.find((t) => t.id === 900); return a && c && a.groupId > 0 && a.groupId === c.groupId; }, "reopen: back in one group with the canvas tab");
  model = await tm();
  check(model.tabs.filter((t) => t.url === canvasUrl).length === 1, "reopen: the open canvas tab is adopted, not opened twice", model.tabs.map((t) => t.url));
  const reA = model.tabs.find((t) => t.url === "https://agent.example/a");
  check(reA.active === false, "reopen: tabs come back in the background", reA);

  // Browser restart: window 5 is gone; Chrome restored the agent tab (new id, ungrouped) in window 7.
  await q.close();
  {
    const pb = await browser.newPage();
    await pb.goto(`${origin}/manifest.json`);
    await pb.evaluate((u) => {
      localStorage.setItem("ls:__live", "[7]");
      localStorage.setItem("__tabmodel", JSON.stringify({ tabs: [{ id: 5000, windowId: 7, url: u, active: true, groupId: -1, splitViewId: -1, pinned: false, index: 0, lastAccessed: 2 }], groups: {}, next: 6000, nextGroup: 800, clock: 10 }));
    }, "https://agent.example/a");
    await pb.close();
  }
  const q7 = await openPanel(7);
  await until(q7, () => window.__tm().tabs.length >= 2, "restart: the missing tab is reopened");
  await until(q7, () => { const m = window.__tm(); const a = m.tabs.find((t) => t.id === 5000); const c = m.tabs.find((t) => t.url.includes("/canvas.html?id=cv_000000000abc")); return a && c && a.groupId > 0 && a.groupId === c.groupId; }, "restart: Chrome's restored tab is adopted into the conversation's group with the reopened canvas tab");
  model = await q7.evaluate(() => window.__tm());
  check(model.tabs.filter((t) => t.url === "https://agent.example/a").length === 1, "restart: no duplicate of a tab Chrome restored", model.tabs.map((t) => t.url));
  await q7.close();

  // --- §7.1: deleting a conversation from the gallery ---------------------------------------------
  {
    const DX = ID(501), DK = ID(502), DH = ID(503);
    const pb = await browser.newPage();
    await pb.goto(`${origin}/manifest.json`);
    await pb.evaluate((DX, DK, DH) => {
      localStorage.clear();
      localStorage.setItem("ls:__live", "[1]");
      const set = (k, v) => localStorage.setItem("ls:" + k, JSON.stringify(v));
      const m = (text, timestamp) => ({ kind: "sent", text, timestamp, senderName: "You", senderId: "me" });
      set("conv:index", {
        [DX]: { title: "Delete me", titleSource: "user", createdAt: 1, lastMessageAt: 3, archivedAt: 4 },
        [DK]: { title: "Keep me", titleSource: "user", createdAt: 1, lastMessageAt: 2, archivedAt: 4 },
        [DH]: { title: "Held elsewhere", titleSource: "user", createdAt: 1, lastMessageAt: 1, archivedAt: null },
      });
      set(`conv:${DX}`, { id: DX, sessions: { "ws://fake/acp": "sess_x" }, messages: [m("one", 1), m("two", 2), m("three", 3)], savedAt: 3 });
      set(`conv:${DK}`, { id: DK, sessions: {}, messages: [m("keep", 2)], savedAt: 2 });
      set("window:9", { open: [DX, DH], current: DH, savedAt: 5 });     // a closed window's record
    }, DX, DK, DH);
    await pb.close();
    const gd = await browser.newPage();
    gd.on("pageerror", (e) => fail(`page error (gallery, delete): ${e.message}`));
    await gd.goto(`${origin}/canvas-gallery.html?win=1`, { waitUntil: "load" });
    // Canvases: two in DX (one with 2 versions), one in DK.
    const cv = await gd.evaluate(async (DX, DK) => {
      const st = CanvasStore.createCanvasStore({ storage: chrome.storage.local, lock: (n, fn) => navigator.locks.request(n, fn) });
      const a = await st.agentWrite({ conversationId: DX, title: "Plan X", content: "# one" });
      await st.agentWrite({ conversationId: DX, id: a.id, baseVersion: 1, title: "Plan X", content: "# two" });
      const b = await st.agentWrite({ conversationId: DX, title: "Notes X", content: "x" });
      const k = await st.agentWrite({ conversationId: DK, title: "Plan K", content: "k" });
      window.__confirms = [];
      window.confirm = (t) => { window.__confirms.push(t); return window.__confirmAnswer !== false; };
      return { a: a.id, b: b.id, k: k.id };
    }, DX, DK);
    await until(gd, (n) => document.querySelectorAll("#conv-list .conv-row").length === n && Array.from(document.querySelectorAll("#conv-list .conv-row")).some((r) => r.innerText.includes("2 個畫布")), "delete: the gallery lists the 3 conversations with canvas counts", 3);
    const rowBtn = (title) => gd.evaluate((t) => { const r = Array.from(document.querySelectorAll("#conv-list .conv-row")).find((x) => x.querySelector(".conv-title").textContent === t); r.querySelector(".conv-delete").click(); }, title);

    // Declined: nothing happens.
    await gd.evaluate(() => { window.__confirmAnswer = false; });
    await rowBtn("Delete me");
    await until(gd, () => window.__confirms.length === 1, "delete: the confirm is shown");
    const text = await gd.evaluate(() => window.__confirms[0]);
    check(/刪除對話「Delete me」？/.test(text) && text.includes("・3 則訊息") && text.includes("・2 個畫布，連同存著的 3 個版本") && text.includes("無法復原"), "delete: the confirm names the conversation and says 3 messages, 2 canvases, 3 versions, cannot be undone", text);
    await sleep(300);
    let st = await storage(gd);
    check(st[`conv:${DX}`] && st["conv:index"][DX], "delete: 取消 deletes nothing", null);

    // Refused while another page (a panel) holds the conversation's Web Lock; names its window.
    const holder = await browser.newPage();
    await holder.goto(`${origin}/manifest.json`);
    await holder.evaluate((id) => { navigator.locks.request(`conv:${id}`, () => new Promise((r) => { window.__release = r; })); }, DH);
    await gd.evaluate(() => { window.__confirmAnswer = true; });
    await rowBtn("Held elsewhere");
    await until(gd, () => document.getElementById("canvas-notice").textContent.includes("先在那裡封存再刪除"), "delete: refused while another window holds the conversation");
    // The holder here is a bare page, in no live window's record: no window to offer (a real panel
    // lists it in its window's record, and the unit tests check that the window is named).
    check(await gd.evaluate(() => document.getElementById("canvas-notice-action").hidden), "delete: …with no 前往 button when the holding window is unknown", null);
    st = await storage(gd);
    check(st[`conv:index`][DH] && !st["conv:index"][DH].deletingAt, "delete: the held conversation is untouched", st["conv:index"][DH]);
    await holder.evaluate(() => window.__release());
    await holder.close();

    // Confirmed.
    await rowBtn("Delete me");
    await until(gd, () => document.getElementById("canvas-notice").textContent.includes("已刪除對話「Delete me」和 2 個畫布"), "delete: done, and says so");
    st = await storage(gd);
    check(!st[`conv:${DX}`] && !st["conv:index"][DX], "delete: its record and index entry are gone", Object.keys(st).filter((k) => k.includes(DX)));
    check(!Object.keys(st).some((k) => k.startsWith(`canvas:${cv.a}:`) || k.startsWith(`canvas:${cv.b}:`) || k === `canvas:${DX}:index`), "delete: its canvases with every version are gone", Object.keys(st).filter((k) => k.startsWith("canvas:")));
    check(st[`canvas:${cv.k}:meta`] && st[`conv:${DK}`] && st["conv:index"][DK], "delete: another conversation and its canvas stay", null);
    check(JSON.stringify(st["window:9"].open) === JSON.stringify([DH]), "delete: it left the closed window's record", st["window:9"]);
    await until(gd, (id) => !Array.from(document.querySelectorAll("#conv-list .conv-row")).some((r) => r.dataset.id === id), "delete: the row is gone", DX);

    // A stale reopen (a gallery that still lists it) is refused, not recreated as an empty conversation.
    const pd = await openPanel(1);
    r = await pd.evaluate((id) => window.__deliver({ type: "katashiro-conv-open", id, windowId: 1, reqId: "del1" }, "/canvas-gallery.html"), DX);
    check(r && r.ok === false && r.error === "這段對話已經刪除了", "delete: a stale reopen is refused", r);
    st = await storage(pd);
    check(!st["conv:index"][DX] && !st[`conv:${DX}`], "delete: …and nothing is recreated", st["conv:index"][DX]);
    await pd.close();

    // A delete cut short (deletingAt left, records still there): the next gallery load finishes it.
    await gd.evaluate((id) => {
      const idx = JSON.parse(localStorage.getItem("ls:conv:index"));
      idx[id] = { ...idx[id], deletingAt: Date.now() };
      localStorage.setItem("ls:conv:index", JSON.stringify(idx));
    }, DK);
    await gd.reload({ waitUntil: "load" });
    await until(gd, (id) => { const idx = JSON.parse(localStorage.getItem("ls:conv:index")); return !idx[id] && localStorage.getItem("ls:conv:" + id) === null; }, "delete: a gallery load finishes a delete cut short", DK);
    st = await storage(gd);
    check(!st[`canvas:${cv.k}:meta`], "delete: …its canvas too", null);
    await gd.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
