#!/usr/bin/env node
// smoke-multi-conversation.mjs — the multi-conversation MVP (ADR docs/adr/multi-conversation.md §3)
// in the real sidepanel.html + sidepanel.js, with a fake ACP agent behind window.WebSocket. Needs a
// Chrome, so it is not part of `node --test`:
//
//   CHROME=/path/to/chrome-headless-shell PUPPETEER_CORE=/path/to/node_modules/puppeteer-core \
//     node scripts/smoke-multi-conversation.mjs
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
//   - no switching while a turn runs; a late session/update for another session is dropped;
//   - with 3 open, ＋ shows the picker; picking archives one (asks close as 對話已封存);
//   - a second window: a conversation open in window 1 is not opened again (Web Lock), and with 3
//     open there it gets the picker instead of a 4th;
//   - the gallery's 對話 section lists the archived conversation with its title.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = process.env.CHROME || "/tmp/pptr/chrome-headless-shell/linux-155.0.8059.39/chrome-headless-shell-linux64/chrome-headless-shell";
const PPTR = process.env.PUPPETEER_CORE || "/usr/local/share/mise/installs/npm-mermaid-js-mermaid-cli/12.0.0/lib/node_modules/@mermaid-js/mermaid-cli/node_modules/puppeteer-core";
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
  let tabId = 100;
  window.__focused = [];
  window.__sidePanelOpened = [];
  window.chrome = {
    runtime: {
      id: "stub", lastError: undefined, onMessage,
      getURL: (p) => location.origin + "/" + p,
      getManifest: () => ({ version: "0.0.0-smoke" }),
      sendMessage: async (msg) => { window.__messages.push(msg); return undefined; },
      reload() {},
    },
    storage: { local: area("local"), sync: area("sync", { agents: [{ name: "Orca", url: "ws://fake/acp" }], activeAgentUrl: "ws://fake/acp" }), session: area("session", {}), onChanged: { addListener: (f) => listeners.push(f), removeListener() {} } },
    windows: {
      getCurrent: (cb) => cb({ id: WIN }),
      getAll: async () => (read("__live") || [WIN]).map((id) => ({ id })),
      update: async (id) => { window.__focused.push(id); return { id }; },
    },
    tabs: {
      query: async () => [], create: async (o) => ({ id: ++tabId, windowId: WIN, ...o }), get: async (id) => ({ id, windowId: WIN, groupId: -1 }),
      update: async () => ({}), remove: async () => {}, group: async () => 1, ungroup: async () => {},
      getCurrent: async () => ({ id: 1, windowId: WIN, index: 0 }),
      onUpdated: ev(), onRemoved: ev(), onActivated: ev(),
    },
    tabGroups: { get: async () => { throw new Error("no group"); }, update: async () => ({}) },
    sidePanel: { open: async (o) => { window.__sidePanelOpened.push(o); } },
    notifications: { onClicked: ev() },
    permissions: { contains: async () => false, request: async () => false, remove: async () => false },
    management: { getSelf: async () => ({ installType: "development" }) },
  };

  // --- the fake ACP agent ---------------------------------------------------------------------
  const acp = window.__acp = { log: [], hold: false, held: [], sessions: 0, lateUpdateFor: null, servers: {}, responses: {}, askOnPrompt: false, conn: null, nextId: 9100 };
  // The agent side of a browser tunnel: connect to a session's declared server, call a tool on it.
  acp.release = () => { for (const h of acp.held.splice(0)) acp.ws.reply(h.id, { stopReason: "end_turn" }); };
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
        for (const h of acp.held.splice(0)) this.reply(h.id, { stopReason: "cancelled" });
        return undefined;
      }
      if (m.method === "session/prompt") {
        const sid = m.params.sessionId;
        if (acp.lateUpdateFor) this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: acp.lateUpdateFor, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LATE CHUNK FROM ANOTHER SESSION" } } } });
        this.emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "reply in " + sid } } } });
        if (acp.askOnPrompt) { acp.askOnPrompt = false; this.emit({ jsonrpc: "2.0", id: 9001, method: "mcp/connect", params: { acpId: acp.servers[sid] } }); }
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

const pkg = JSON.parse(fs.readFileSync(path.join(PPTR, "package.json"), "utf8"));
const puppeteer = (await import(pathToFileURL(path.join(PPTR, pkg.exports["."].import)).href)).default;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "shell", args: ["--no-sandbox"] });
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
    "history:1": { conversationId: ID(1), sessions: { "ws://fake/acp": "sess_old1" }, messages: [msg("sent", "First topic in window one", now - 60000), msg("received", "ok one", now - 50000)], savedAt: now - 50000 },
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

  // No switching while a turn runs; a late update of another session is dropped.
  await until(p1, () => document.getElementById("stop-btn").hidden, "third turn done");
  await p1.evaluate((sid) => { window.__acp.hold = true; window.__acp.lateUpdateFor = sid; }, "sess_old1");
  await send(p1, "long one");
  await until(p1, () => !document.getElementById("stop-btn").hidden, "a running turn");
  await p1.evaluate(() => document.querySelectorAll(".conv-tab")[0].click());
  t = await tabs(p1);
  check(t[1].current, "switching is refused while the turn runs", t);
  check((await visibleText(p1)).includes("回覆中不能切換"), "…and says why", null);
  check(!(await visibleText(p1)).includes("LATE CHUNK"), "a session/update for another session is dropped", null);
  await p1.evaluate(() => { window.__acp.hold = false; window.__acp.lateUpdateFor = null; document.getElementById("stop-btn").click(); });
  await until(p1, () => document.getElementById("stop-btn").hidden, "stopped");

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

  // An ask card in conversation 2, then a tool call from it while it is not on screen.
  await p1.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).find((t) => t.textContent.startsWith("Second topic")).click());
  await until(p1, () => document.querySelector(".conv-tab.current .conv-tab-title").textContent === "Second topic about tabs", "back on conversation 2");
  await p1.evaluate(() => { window.__acp.hold = true; window.__acp.askOnPrompt = true; });
  await send(p1, "ask me something");
  await until(p1, () => { const l = Array.from(document.querySelectorAll(".conv-messages")).find((e) => !e.hidden); return l && l.querySelector(".ask-card.pending"); }, "the ask card in conversation 2");
  await p1.evaluate(() => { window.__askCard = document.querySelector(".ask-card.pending"); window.__acp.hold = false; window.__acp.release(); });
  await until(p1, () => document.getElementById("stop-btn").hidden, "conversation 2 idle");
  const askRes = await p1.evaluate(() => window.__acp.responses[9100]);
  check(askRes && askRes.result && !askRes.result.isError, "ask_user over conversation 2's own tunnel works while it is on screen", askRes);
  await p1.evaluate(() => Array.from(document.querySelectorAll(".conv-tab")).find((t) => t.textContent.startsWith("My name")).click());
  await until(p1, () => document.querySelector(".conv-tab.current .conv-tab-title").textContent === "My name", "switched to conversation 1");
  const late = await p1.evaluate(() => window.__acp.callTool(window.__acp.conn, "katashiro.chat_history", {}));
  await until(p1, (id) => !!window.__acp.responses[id], "the late tool call is answered", late);
  const lateRes = await p1.evaluate((id) => window.__acp.responses[id], late);
  check(lateRes.result && lateRes.result.isError && /not on screen/.test(lateRes.result.content[0].text), "a tool call from a conversation not on screen is refused", lateRes);
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
  await until(p1, () => window.__acp.log.filter((m) => m.method === "session/resume").length === 2, "the reopened conversation resumes its session");
  log = await acpLog(p1);
  check(log.filter((m) => m.method === "session/resume")[1].params.sessionId === "sess_1", "…the same ACP session", log.filter((m) => m.method === "session/resume")[1]);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
