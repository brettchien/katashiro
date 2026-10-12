#!/usr/bin/env node
// acp-two-sessions.mjs — live check that ONE OpenAB /acp WebSocket runs TWO ACP sessions at once
// (ADR docs/adr/multi-conversation.md §5, "Before starting P2"): both turns run concurrently, and
// each agent calls a tool on ITS OWN client-declared MCP server over the MCP-over-ACP tunnel
// without crossing over to the other session's server.
//
//   ACP_TOKEN=… node scripts/acp-two-sessions.mjs --url wss://<gateway>/acp
//
// Options: --url (or ACP_URL) · --sessions N (1..3, default 2) · --timeout SEC (default 300)
//          · --hold SEC (whoami holds this long before answering, default 10) · --tunnel-wait SEC
//          (default 20) · --cwd PATH (default /home/agent) · --verbose (print every frame)
// The token comes ONLY from the ACP_TOKEN environment variable and is never printed.
//
// Needs Node 22+ (global WebSocket); no npm dependencies.
//
// What it does, on one socket, speaking exactly Katashiro's wire protocol (sidepanel.js +
// browser-mcp.js; openab docs/mcp-over-acp-tunnel-contract.md):
//   1. subprotocols `openab.bearer.<token>`, `acp.v1`; ACP `initialize` (protocolVersion 1).
//   2. `session/new` per session, each declaring its own MCP server
//      `{ type: "acp", id: <uuid>, name: "probeA" | "probeB" | … }`.
//   3. Serves the gateway's `mcp/connect` / `mcp/message` / `mcp/disconnect` (and the `mcp/cancel`
//      notification): inner MCP `initialize`, `notifications/initialized`, `tools/list` (one tool,
//      `whoami`), `tools/call` → "session=<label> nonce=<random>". Every tools/call is logged with
//      the connectionId and server it arrived on.
//   4. Sends every `session/prompt` back to back (no await in between), asking each agent to find
//      `whoami` through the OAB facade (search_capabilities → execute_capability) and reply with the
//      nonce, then records when each session/update / tool call arrives.
//   5. Prints a PASS/FAIL table; exit 0 on PASS, 1 on FAIL, 2 on a usage error.
// On --timeout it sends `session/cancel` for every running turn, then closes the socket.
//
// CAUTION: this starts N real agent sessions on the broker, and each running turn holds one slot of
// the broker pool (`[pool] max_sessions`, 3 by default, shared with Discord threads and usercron).
// Run it when the pool has room, or a turn fails with "pool exhausted" (reported as such). The
// sessions it creates are left idle on the broker (openab has no session/close); they age out with
// the pool's idle TTL. It never touches Katashiro's storage — it is not the extension, only a client
// that speaks the same protocol.
import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const core = require("./acp-two-sessions-core.cjs");

const USAGE = `usage: ACP_TOKEN=<token> node scripts/acp-two-sessions.mjs --url wss://<gateway>/acp
       [--sessions 2] [--timeout 300] [--hold 10] [--tunnel-wait 20] [--cwd /home/agent] [--verbose]`;

let opts;
try {
  opts = core.parseArgs(process.argv.slice(2), process.env);
} catch (e) {
  if (e instanceof core.UsageError) { console.error(`error: ${e.message}\n${USAGE}`); process.exit(2); }
  throw e;
}
if (opts.help) { console.log(USAGE); process.exit(0); }
if (typeof WebSocket !== "function") {
  console.error(`error: no global WebSocket — Node 22+ is required (this is ${process.version})`);
  process.exit(2);
}

const T0 = Date.now();
const rel = (t) => `+${((t - T0) / 1000).toFixed(3)}s`;
const log = (...a) => console.log(`[${rel(Date.now())}]`, ...a);
const short = (s) => String(s || "?").slice(0, 8);

// --- per-session state -------------------------------------------------------------------------
const sessions = core.labels(opts.sessions).map((label) => ({
  label,
  serverId: randomUUID(),
  serverName: core.serverName(label),
  nonce: randomBytes(6).toString("hex"),
  sessionId: null,
  created: false,
  createError: null,
  tunnelUp: false,
  connections: new Set(),
  calls: [],
  updates: [],
  activity: [],
  sentAt: null,
  doneAt: null,
  stopReason: null,
  error: null,
  replyText: "",
  toolEvents: 0,
}));
const byServerId = new Map(sessions.map((s) => [s.serverId, s]));
const bySessionId = new Map();
const connections = new Map();           // connectionId → session record
let strayCalls = 0;
let timedOut = false;

// --- socket + JSON-RPC ----------------------------------------------------------------------------
const ws = new WebSocket(opts.url, [`openab.bearer.${opts.token}`, "acp.v1"]);
let nextId = 1;
const pending = new Map();
let closed = false;

function send(obj) {
  if (opts.verbose) log(">>", JSON.stringify(obj));
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
function rpcError(err) {
  const e = new Error(err && err.message ? err.message : JSON.stringify(err));
  e.code = err && err.code;
  return e;
}

const opened = new Promise((resolve, reject) => {
  ws.addEventListener("open", () => resolve(), { once: true });
  ws.addEventListener("error", (ev) => reject(new Error(
    `WebSocket error before open (${(ev && ev.message) || "no detail"}) — check the URL, the token, and that the gateway echoes acp.v1`)), { once: true });
});
ws.addEventListener("close", (ev) => {
  closed = true;
  log(`socket closed (code ${ev.code}${ev.reason ? `, ${ev.reason}` : ""})`);
  for (const [, p] of pending) p.reject(new Error(`connection closed (code ${ev.code})`));
  pending.clear();
});
ws.addEventListener("message", (ev) => {
  let msg;
  try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")); }
  catch { log("!! unparseable frame ignored"); return; }
  if (opts.verbose) log("<<", JSON.stringify(msg));
  onMessage(msg);
});

function onMessage(msg) {
  const now = Date.now();
  // Response to one of our requests.
  if (msg.id !== undefined && msg.method === undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(rpcError(msg.error)); else p.resolve(msg.result);
    return;
  }
  // Gateway-initiated tunnel traffic.
  if (msg.method === "mcp/connect" || msg.method === "mcp/message" || msg.method === "mcp/disconnect") {
    onTunnel(msg, now);
    return;
  }
  if (msg.method === "mcp/cancel") {
    log(`mcp/cancel for request ${msg.params && msg.params.requestId} (a tool call outlived the tunnel timeout)`);
    return;
  }
  if (msg.method === "session/update" && msg.params) {
    const s = bySessionId.get(msg.params.sessionId);
    if (!s) { log(`session/update for an unknown session ${short(msg.params.sessionId)}`); return; }
    s.updates.push(now);
    s.activity.push(now);
    const u = msg.params.update || {};
    if (u.sessionUpdate === "agent_message_chunk" && u.content) {
      const text = u.content.text || "";
      s.replyText += text;
      log(`${s.label} chunk ${JSON.stringify(text.length > 60 ? text.slice(0, 60) + "…" : text)}`);
    } else {
      s.toolEvents++;
      log(`${s.label} update ${u.sessionUpdate || "?"}${u.title ? ` ${JSON.stringify(u.title)}` : ""}`);
    }
    return;
  }
  if (msg.id !== undefined && msg.method) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    log(`refused unexpected server request ${msg.method}`);
  }
}

function onTunnel(msg, now) {
  const p = msg.params || {};
  if (msg.method === "mcp/connect") {
    const s = byServerId.get(p.acpId);
    if (!s) {
      log(`mcp/connect for an undeclared server ${short(p.acpId)} — refused`);
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown server: ${p.acpId}` } });
      return;
    }
    const connectionId = randomUUID();
    connections.set(connectionId, s);
    s.connections.add(connectionId);
    log(`mcp/connect → ${s.serverName} (acpId ${short(s.serverId)}) as connection ${short(connectionId)}`);
    send({ jsonrpc: "2.0", id: msg.id, result: { connectionId } });
    return;
  }
  if (msg.method === "mcp/disconnect") {
    const s = connections.get(p.connectionId);
    connections.delete(p.connectionId);
    if (s) s.connections.delete(p.connectionId);
    log(`mcp/disconnect connection ${short(p.connectionId)}${s ? ` (${s.serverName})` : " (unknown)"}`);
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  // mcp/message: inner MCP flattened into params; correlate by the OUTER id; no id = notification.
  const s = connections.get(p.connectionId);
  if (!s) {
    if (p.method === "tools/call") strayCalls++;
    log(`mcp/message ${p.method} on an unknown connection ${short(p.connectionId)} — refused`);
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown connection: ${p.connectionId}` } });
    return;
  }
  const reply = (result) => { if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result }); };
  switch (p.method) {
    case "initialize":
      s.tunnelUp = true;
      log(`${s.serverName}: inner initialize on connection ${short(p.connectionId)}`);
      reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: s.serverName, version: "1.0.0" } });
      return;
    case "notifications/initialized":
      return;
    case "tools/list":
      log(`${s.serverName}: tools/list on connection ${short(p.connectionId)}`);
      reply({ tools: [{
        name: "whoami",
        description: "Protocol-test probe: returns which test session this MCP server belongs to and a random nonce.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }] });
      return;
    case "tools/call": {
      const name = (p.params && p.params.name) || "?";
      const call = { start: now, end: null, name, connectionId: p.connectionId };
      s.calls.push(call);
      s.activity.push(now);
      log(`${s.serverName}: tools/call ${name} on connection ${short(p.connectionId)} (server ${s.serverName}, acpId ${short(s.serverId)}, session ${s.label}); holding ${opts.holdSec}s`);
      setTimeout(() => {
        call.end = Date.now();
        if (name !== "whoami") {
          reply({ content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
          return;
        }
        reply({ content: [{ type: "text", text: core.whoamiText(s.label, s.nonce) }] });
        log(`${s.serverName}: answered whoami`);
      }, opts.holdSec * 1000);
      return;
    }
    default:
      log(`${s.serverName}: inner ${p.method} not supported`);
      if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${p.method}` } });
  }
}

// --- the run ---------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms) {
  const until = Date.now() + ms;
  while (!pred() && Date.now() < until && !closed) await sleep(100);
  return pred();
}

async function run() {
  await opened;
  log(`connected to ${new URL(opts.url).host} (subprotocol ${ws.protocol || "none"})`);
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "katashiro-two-session-test", title: "Katashiro two-session test", version: "0.0.0+test" },
  });
  log(`initialize ok (protocolVersion ${init && init.protocolVersion})`);

  for (const s of sessions) {
    try {
      const res = await request("session/new", {
        cwd: opts.cwd,
        mcpServers: [{ type: "acp", id: s.serverId, name: s.serverName }],
      });
      s.sessionId = res && res.sessionId;
      s.created = !!s.sessionId;
      if (s.sessionId) bySessionId.set(s.sessionId, s);
      log(`session ${s.label}: ${short(s.sessionId)} (declares ${s.serverName}, acpId ${short(s.serverId)})`);
    } catch (e) {
      s.createError = { code: e.code, message: e.message };
      log(`session ${s.label}: session/new failed: ${e.code != null ? `${e.code} ` : ""}${e.message}`);
    }
  }
  const live = sessions.filter((s) => s.created);
  if (live.length === 0) return;

  // The gateway opens the tunnels asynchronously after session/new; give them a moment so a slow
  // establish is not mistaken for a crossover. Prompting anyway after the wait is deliberate.
  const up = await waitFor(() => live.every((s) => s.tunnelUp), opts.tunnelWaitSec * 1000);
  if (!up) log(`not every tunnel finished its inner initialize within ${opts.tunnelWaitSec}s — prompting anyway`);

  // Back to back: every prompt goes out before any reply is awaited.
  const turns = live.map((s) => {
    s.sentAt = Date.now();
    log(`session ${s.label}: session/prompt sent`);
    return request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: core.buildPrompt(s.label) }] })
      .then((res) => {
        s.doneAt = Date.now();
        s.stopReason = res && res.stopReason;
        log(`session ${s.label}: turn ended (${s.stopReason})`);
      }, (e) => {
        s.doneAt = Date.now();
        s.error = { code: e.code, message: e.message };
        const kind = core.classifyError(s.error);
        log(`session ${s.label}: turn failed: ${e.code != null ? `${e.code} ` : ""}${e.message}${kind === "busy" ? "  [SESSION BUSY -32001]" : kind === "pool" ? "  [BROKER POOL EXHAUSTED]" : ""}`);
      });
  });

  let timer;
  const deadline = new Promise((resolve) => {
    const left = Math.max(0, opts.timeoutSec * 1000 - (Date.now() - T0));
    timer = setTimeout(() => { timedOut = true; resolve(); }, left);
  });
  await Promise.race([Promise.all(turns), deadline]);
  clearTimeout(timer);

  if (timedOut) {
    log(`--timeout ${opts.timeoutSec}s reached — cancelling running turns`);
    for (const s of live) {
      if (s.doneAt == null) send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s.sessionId } });
    }
    await Promise.race([Promise.all(turns), sleep(5000)]);
  }
}

let fatal = null;
try {
  await run();
} catch (e) {
  fatal = e;
  log(`fatal: ${e.code != null ? `${e.code} ` : ""}${e.message}`);
}
try { ws.close(1000, "done"); } catch { /* already closed */ }

// --- report ----------------------------------------------------------------------------------------
console.log("");
for (const s of sessions) {
  console.log(`session ${s.label} (${s.serverName}, nonce ${s.nonce}) reply:`);
  console.log((s.replyText || "(none)").split("\n").map((l) => `  | ${l}`).join("\n"));
  const kinds = new Set([s.createError, s.error, s.replyText].map(core.classifyError));
  if (kinds.has("busy")) console.log("  ! -32001 Session busy: a second prompt reached a session whose turn was still running");
  if (kinds.has("pool")) console.log("  ! broker pool exhausted: every pool slot is busy (Discord / usercron / other sessions) — retry when it has room");
}
console.log("\ntimeline (relative to start):");
const tl = core.renderTable(["session", "prompt sent", "first activity", "turn ended", "tool calls", "updates"],
  sessions.map((s) => [
    s.label,
    s.sentAt == null ? "-" : rel(s.sentAt),
    s.activity.length ? rel(Math.min(...s.activity)) : "-",
    s.doneAt == null ? "-" : rel(s.doneAt),
    s.calls.map((c) => `${rel(c.start)}..${c.end == null ? "?" : rel(c.end)}`).join(", ") || "-",
    String(s.updates.length),
  ]));
console.log(tl);

const verdict = core.evaluate(sessions, { strayCalls, timedOut });
if (fatal) verdict.rows.push(["no fatal error", "FAIL", ...sessions.slice(1).map(() => "")]);
const pass = verdict.pass && !fatal;
console.log("");
console.log(core.renderTable(["check", ...sessions.map((s) => s.label)], verdict.rows));
console.log("");
console.log(core.renderTable(["info", "value"], verdict.info));
console.log(`\nRESULT: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
