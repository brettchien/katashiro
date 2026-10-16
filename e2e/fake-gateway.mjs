// fake-gateway.mjs — a scriptable stand-in for the OpenAB ACP gateway (`/acp`), for the T2 E2E
// cases (e2e/cases/*.mjs). It speaks the subset of ACP Katashiro uses (sidepanel.js `Conn`):
//
//   client → gateway   initialize, session/new, session/resume (session/load), session/prompt,
//                      session/cancel, katashiro/ping
//   gateway → client   session/update (agent_message_chunk), the session/prompt result
//                      ({ stopReason }), and the reverse-MCP tunnel: mcp/connect { acpId } →
//                      { connectionId }, mcp/message { connectionId, method, params } (inner MCP:
//                      initialize, notifications/initialized, tools/call), mcp/disconnect
//
// Same protocol knowledge as the in-page fake in scripts/smoke-multi-conversation.mjs
// (window.__acp), but over a real WebSocket, so the real extension's socket, heartbeat and tunnel
// code run. A test drives it per session:
//
//   gw.hold = true                      prompts stay open until the test ends them
//   await gw.waitPrompt(m => …)         the next (or a matching) session/prompt → { id, sessionId, text, userText, images }
//   gw.chunk(sid, "text")               stream a chunk into that session's turn
//   gw.endTurn(sid, "end_turn")         answer that session's open prompt(s)
//   gw.poolBusy = true                  answer prompts with openab's exact "Service Busy" chat line
//   gw.cancels                          the sessionIds of every session/cancel seen
//   await gw.callTool(sid, "katashiro.get_text", {})   → the MCP result (or { error })
//
// session/cancel ends only the named session's held prompt with stopReason "cancelled", like the
// broker. Listens on 127.0.0.1 on a free port; the case seeds the panel's agent URL (gw.url),
// so nothing collides with a real gateway on :8080.
import { WebSocketServer } from "ws";

// openab dispatch.rs on a full pool: "⚠️ " + format_user_error(e), sent as chat text, then end_turn
// (ConvCore.isPoolBusyReply recognises exactly this).
export const POOL_BUSY_TEXT = "⚠️ **Service Busy**\nAll agent sessions are in use, please try again shortly.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FakeGateway {
  // prefix: of the session ids it makes — two gateways in one case (two agents) stay apart.
  constructor({ prefix = "sess_" } = {}) {
    this.prefix = prefix;
    this.log = [];                 // every client → gateway request / notification, in order
    this.prompts = [];             // every session/prompt: { id, sessionId, text, ws, at, done }
    this.cancels = [];             // sessionId of each session/cancel
    this.hold = false;             // keep prompts open (the test ends them)
    this.poolBusy = false;
    this.replyText = (t) => `echo: ${t.userText.slice(0, 60)}`;   // the reply when not holding
    this.sessions = new Map();     // sessionId → { ws, acpId, connectionId, initialized }
    this.sockets = new Set();
    this.nextSession = 1;
    this.nextId = 50000;           // ids of gateway → client requests
    this.pending = new Map();      // id → { resolve }
  }

  async start() {
    this.wss = new WebSocketServer({
      host: "127.0.0.1", port: 0, path: "/acp",
      // Katashiro offers ["acp.v1"] (plus openab.bearer.<token> when a token is set); echo acp.v1.
      handleProtocols: (protocols) => (protocols.has("acp.v1") ? "acp.v1" : false),
    });
    await new Promise((r) => this.wss.once("listening", r));
    this.url = `ws://127.0.0.1:${this.wss.address().port}/acp`;
    this.wss.on("connection", (ws) => {
      this.sockets.add(ws);
      ws.on("close", () => this.sockets.delete(ws));
      ws.on("message", (data) => {
        let m;
        try { m = JSON.parse(String(data)); } catch (_) { return; }
        this.onFrame(ws, m);
      });
    });
    return this;
  }

  async stop() {
    for (const ws of this.sockets) ws.terminate();
    await new Promise((r) => this.wss.close(() => r()));
  }

  send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
  reply(ws, id, result) { this.send(ws, { jsonrpc: "2.0", id, result }); }

  onFrame(ws, m) {
    if (m.method === undefined) {                        // the client's answer to one of our requests
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p.resolve(m); }
      return;
    }
    this.log.push({ method: m.method, params: m.params, at: Date.now() });
    const p = m.params || {};
    switch (m.method) {
      case "initialize":
        return this.reply(ws, m.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } } });
      case "session/new": {
        const sid = `${this.prefix}${this.nextSession++}`;
        this.sessions.set(sid, { ws, acpId: p.mcpServers && p.mcpServers[0] && p.mcpServers[0].id, connectionId: null });
        return this.reply(ws, m.id, { sessionId: sid });
      }
      case "session/resume":
      case "session/load": {
        // A session this gateway never made (a previous run's) comes back as if the broker kept it.
        const s = this.sessions.get(p.sessionId) || {};
        this.sessions.set(p.sessionId, { ...s, ws, acpId: p.mcpServers && p.mcpServers[0] && p.mcpServers[0].id, connectionId: null });
        return this.reply(ws, m.id, {});
      }
      case "katashiro/ping":
        return this.reply(ws, m.id, {});
      case "session/cancel": {
        this.cancels.push(p.sessionId);
        for (const t of this.prompts) if (!t.done && t.sessionId === p.sessionId) this.finish(t, "cancelled");
        return undefined;
      }
      case "session/prompt": {
        const text = (p.prompt || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
        // userText: what the user typed, without Katashiro's "[<time> user]" header line (and host lines).
        const userText = text.split("\n").filter((l) => !/^\[.*\]$/.test(l.trim())).join("\n").trim();
        const images = (p.prompt || []).filter((b) => b.type === "image").length;
        const t = { id: m.id, sessionId: p.sessionId, text, userText, images, ws, at: Date.now(), done: false };
        this.prompts.push(t);
        if (this.poolBusy) {
          this.chunk(p.sessionId, POOL_BUSY_TEXT);
          return this.finish(t, "end_turn");
        }
        if (this.hold) return undefined;
        this.chunk(p.sessionId, this.replyText(t));
        return this.finish(t, "end_turn");
      }
      default:
        if (m.id !== undefined) this.send(ws, { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
        return undefined;
    }
  }

  wsOf(sid) {
    const s = this.sessions.get(sid);
    if (!s) throw new Error(`fake gateway: unknown session ${sid}`);
    return s.ws;
  }

  finish(t, stopReason) {
    if (t.done) return;
    t.done = true;
    t.stopReason = stopReason;
    this.reply(t.ws, t.id, { stopReason });
  }

  // --- what a test calls ---------------------------------------------------------------------

  chunk(sid, text) {
    this.send(this.wsOf(sid), { jsonrpc: "2.0", method: "session/update", params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  }

  /** End the open prompt(s) of one session; with `text`, stream it first. */
  endTurn(sid, stopReason = "end_turn", text) {
    if (text) this.chunk(sid, text);
    for (const t of this.prompts) if (!t.done && t.sessionId === sid) this.finish(t, stopReason);
  }

  openPrompts(sid) { return this.prompts.filter((t) => !t.done && (sid == null || t.sessionId === sid)); }

  /** Wait for a session/prompt matching `pred` (default: any) that arrived after `since` prompts. */
  async waitPrompt(pred = () => true, { since = 0, ms = 10000 } = {}) {
    return this.waitFor(() => this.prompts.slice(since).find(pred), `a session/prompt${pred.name ? ` (${pred.name})` : ""}`, ms);
  }

  async waitFor(fn, what, ms = 10000) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) throw new Error(`fake gateway: timed out waiting for ${what}`);
      await sleep(25);
    }
  }

  methods(name) { return this.log.filter((m) => m.method === name); }

  request(ws, method, params, ms = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`fake gateway: no answer to ${method} in ${ms} ms`)); }, ms);
      this.pending.set(id, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      this.send(ws, { jsonrpc: "2.0", id, method, params });
    });
  }

  /** Open the session's browser tunnel (mcp/connect on its declared server, inner MCP initialize). */
  async connectTunnel(sid) {
    const s = this.sessions.get(sid);
    if (!s || !s.acpId) throw new Error(`fake gateway: session ${sid} declared no MCP server`);
    if (s.connectionId && s.connectedOn === s.ws) return s.connectionId;
    const r = await this.request(s.ws, "mcp/connect", { acpId: s.acpId });
    if (!r.result) throw new Error(`fake gateway: mcp/connect refused: ${JSON.stringify(r.error)}`);
    s.connectionId = r.result.connectionId;
    s.connectedOn = s.ws;
    const init = await this.request(s.ws, "mcp/message", {
      connectionId: s.connectionId, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-gateway", version: "0" } },
    });
    if (!init.result) throw new Error(`fake gateway: inner MCP initialize failed: ${JSON.stringify(init.error)}`);
    this.send(s.ws, { jsonrpc: "2.0", method: "mcp/message", params: { connectionId: s.connectionId, method: "notifications/initialized", params: {} } });
    return s.connectionId;
  }

  /**
   * The agent calls a Katashiro tool in session `sid` → { result } | { error } (the outer frame).
   * `ms` bounds the wait: ask_user, say, only answers when the user does.
   */
  async callTool(sid, name, args = {}, ms = 30000) {
    const connectionId = await this.connectTunnel(sid);
    const r = await this.request(this.wsOf(sid), "mcp/message", { connectionId, method: "tools/call", params: { name, arguments: args } }, ms);
    return r;
  }

  /** callTool → the text of a result, and whether it is an MCP error. */
  static text(r) {
    if (!r) return { isError: true, text: "(no answer)" };
    if (r.error) return { isError: true, text: r.error.message || JSON.stringify(r.error) };
    const c = (r.result && r.result.content) || [];
    return { isError: !!(r.result && r.result.isError), text: c.filter((b) => b.type === "text").map((b) => b.text).join("\n") };
  }
}
