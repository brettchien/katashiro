// Katashiro side panel — multi-agent room.
//
// Each configured agent gets its OWN live WebSocket + ACP session, held in a `Conn`
// instance. All room members are connected at once; a user message is routed per room mode
// (@mention → addressed agents; else broadcast), and each agent streams its own reply
// (attributed) into the shared scrollback. Agent-to-agent relay is live — an agent's reply is
// fanned out to the others (`<message from="...">`-wrapped) under a loop guard (see room-core.js).

// --- Room-level state --------------------------------------------------------
let myUserId = "me";
let myUserName = "You";

// Agents: [{ name, url, token }]. `token` is the ACP transport key (OPENAB_ACP_AUTH_KEY):
// required for a non-loopback endpoint, optional on localhost. Carried via the WS
// subprotocol (`openab.bearer.<token>`), never in the URL.
const DEFAULT_AGENT = { name: "OpenAB", url: "ws://localhost:8080/acp", token: "" };
let agents = [];

// One live Conn per agent, kept index-parallel to `agents`.
const room = [];

// Single-active model (ADR single-active-agent): all agents are configured, but only THIS one is
// connected / in chat at a time. Resolved from storage at startup; changed via setActiveAgent().
let activeAgentUrl = null;

// Room routing config (mode + loop-guard cap). RoomCore owns the pure logic; we persist it.
let roomConfig = RoomCore.defaultRoomConfig();
let loopGuard = RoomCore.createLoopGuard(roomConfig.loopGuardCap);

// Jev grounding token (optional, BYO-key): the user's OpenRouter key for the Jev decisions
// API. Empty = grounding disabled. Persisted with the rest of config in chrome.storage.sync and
// passed into the browser tool layer so it can verify actions / disambiguate elements / detect page state.
let jevToken = "";
// Settings → 截圖: per-screenshot size cap + how many captures stay pasteable (browser-mcp clamps).
let screenshotConfig = BrowserMcp.normalizeScreenshotConfig(null);
// Settings → 附加檔案: file size limit at drop + text cap on send (ADR chat-attachments §2.3).
let attachConfig = Composer.normalizeAttachConfig(null);

// Act mode: may an agent CHANGE the page, or only read it? Off means read_dom/screenshot work
// and click/type/navigate are refused. Kept separate from roomConfig — that one is about who
// hears whom, this one is a consent boundary on the browser. Default off, and deliberately not
// per-agent: it answers "may this browser be written to at all", which the tab, not the agent,
// is the subject of.
let actMode = false;
function roomMembers() {
  // Single-active: only the active agent participates in routing (mention / broadcast / relay). A
  // dormant agent must never be a target — an enqueued prompt would silently pile up in its
  // promptQueue and flush when it is later activated (its Conn is reused) (review: Orca).
  return room
    .filter((c) => c.agent.url === activeAgentUrl)
    .map((c) => ({ id: c.id, name: c.name }));
}
function connById(id) {
  return room.find((c) => c.id === id) || null;
}

// ACP constants
const ACP_PROTOCOL_VERSION = 1;
// Which build this is: manifest version + release tag / sha from build-info.json ("dev" when
// absent — an unstamped unpacked load). Shared by the connection-screen badge and the ACP
// initialize clientInfo (ADR build-provenance-and-version-display). Never rejects.
const BUILD_INFO = (async () => {
  const version = chrome.runtime.getManifest().version;
  let detail = "dev", sha = null, builtAt = null;
  try {
    const res = await fetch(chrome.runtime.getURL("build-info.json"));
    if (res.ok) {
      const b = await res.json();
      detail = b.tag || b.sha || "dev";
      sha = b.sha || null;
      builtAt = b.builtAt || null;
    }
  } catch (_) { /* absent in unpacked dev → dev */ }
  return { version, detail, sha, builtAt };
})();

// Disconnect diagnostics (ADR browser-tunnel-liveness §9.3, E). Every socket end is one record,
// kept in memory and in storage.session (so a panel reload — the moment you'd want to look — does
// not lose them; a browser restart does). storage.session is shared by every window's panel, so
// writes are read-modify-write through one chain per panel and carry the window id.
const DISCONNECT_LOG_KEY = "katashiro.diag.disconnects";
let disconnectLog = [];                                  // this panel's own records (fallback)
let disconnectWrites = Promise.resolve();
function logDisconnectOp(op) {
  disconnectLog = RoomCore.applyDisconnectOp(disconnectLog, op);
  disconnectWrites = disconnectWrites.then(async () => {
    const got = await chrome.storage.session.get(DISCONNECT_LOG_KEY);
    await chrome.storage.session.set({ [DISCONNECT_LOG_KEY]: RoomCore.applyDisconnectOp(got && got[DISCONNECT_LOG_KEY], op) });
  }).catch(() => {});                                    // diagnostics never break the connection
}
// The newest `n` records, newest first, one line each (for katashiro.client_info).
async function recentDisconnects(n = 5) {
  await disconnectWrites;
  let list = disconnectLog;
  try {
    const got = await chrome.storage.session.get(DISCONNECT_LOG_KEY);
    if (got && Array.isArray(got[DISCONNECT_LOG_KEY])) list = got[DISCONNECT_LOG_KEY];
  } catch (_) { /* this panel's own records */ }
  const now = Date.now();
  return list.slice(-n).reverse().map((r) => RoomCore.formatDisconnect(r, now));
}

// katashiro.client_info: what this client is, read fresh per call (act mode / optional permissions
// can change while the panel is open). No URLs, tokens or agent config — build + capability state.
const OPTIONAL_PERMISSIONS = ["sessions"];
async function clientInfoSnapshot() {
  const { version, detail, sha, builtAt } = await BUILD_INFO;
  let installType = null;
  try { installType = (await chrome.management.getSelf()).installType; } catch (_) { /* unavailable */ }
  const optionalPermissions = {};
  for (const p of OPTIONAL_PERMISSIONS) {
    try { optionalPermissions[p] = await chrome.permissions.contains({ permissions: [p] }); }
    catch (_) { optionalPermissions[p] = false; }
  }
  const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent || "");
  return {
    version, build: detail, sha, builtAt, installType,
    extensionId: chrome.runtime.id,
    browser: m ? `Chrome ${m[1]}` : null,
    windowId: panelWindowId,
    actMode, optionalPermissions,
    recentDisconnects: await recentDisconnects(5),
  };
}
const ACP_CWD = "/home/agent";
// Default request timeout — guards a peer that goes silent WITHOUT closing the socket
// (onclose rejects pending reqs, but a half-open connection never fires it), which would
// otherwise wedge that conn's queue with turnActive stuck true.
const ACP_REQUEST_TIMEOUT_MS = 60000;
// session/prompt times out on silence, not length (RoomCore.turnDeadline): TURN_IDLE_TIMEOUT_MS
// after the last activity of the turn, or TURN_MAX_TIMEOUT_MS after its start.
const TUNNEL_FRESH_MS = 60000;        // an inbound mcp/message keeps the tunnel "活躍" this long (§8.3)
const HEARTBEAT_DEAD_THRESHOLD = 2;   // consecutive missed idle probes before a destructive reconnect (§8.6)
const ROSTER_REFRESH_MS = 15000;      // periodic re-render so time-based states (活躍→閒置) stay current

// Carry the transport token via the WebSocket subprotocol list (browsers cannot set an
// Authorization header on a WS handshake). The server extracts the token from the
// `openab.bearer.<token>` entry and echoes the real `acp.v1` subprotocol.
function acpProtocols(token) {
  // Trim defensively: a pasted token often carries a trailing newline/space, which makes
  // the subprotocol string invalid and silently breaks the handshake.
  const t = (token || "").trim();
  return t ? [`openab.bearer.${t}`, "acp.v1"] : ["acp.v1"];
}

// --- SessionState: one conversation's ACP session with one agent --------------
// Multi-conversation (ADR docs/adr/multi-conversation.md §3.5): everything that belongs to a
// session lives here, one per open conversation, not on the Conn. The Conn keeps the socket,
// heartbeat and liveness. In the MVP only the current conversation's state runs a turn (a switch is
// refused while one runs), so the Conn's rendering methods below act on the current state; P2 lets
// any state run.
class SessionState {
  constructor(convId, acpSessionId) {
    this.convId = convId;
    this.acpSessionId = acpSessionId || null;            // conv:<id>.sessions[agentUrl], replaceable
    this.readyGen = -1;                                  // the socket generation it was resumed / created on
    this.opening = null;                                 // the in-flight session/resume | session/new
    this.hintPending = false;                            // U2 (§3.5): the next accepted prompt carries the host line
    this.promptQueue = [];
    this.pendingImages = [];                             // { mimeType, data(base64) } to ride the next turn
    this.turnActive = false;
    this.lastPrompt = null;                              // last turn's text, for retry (never the host line)
    this.lastImages = [];                                // …and its images, so a retry re-sends them
    this.stream = null;                                  // { bubble, text } while streaming
    this.skippedToolCalls = null;                        // katashiro tool calls seen this turn
    this.lastTurnActivityAt = 0;                         // ts of the last sign of life of its turn
    this.mcpServer = null;                               // this conversation's browser MCP server (§3.9)
  }
}

// --- Conn: one agent's connection; one SessionState per open conversation -----
class Conn {
  constructor(agent) {
    this.agent = agent;                                 // { name, url, token, browserAccess }
    this.id = agent.url;                                // stable routing identity (unique per agent)
    this.enabled = true;                                // user intent: should this conn be up?
    this.ws = null;
    // One session per (conversation, agent), seeded from conv:<id>.sessions on first use — so a
    // reopened panel resumes the same session (the "已續接 …" path). Two windows never share one:
    // a conversation is open in one window at a time (Web Lock, §3.6).
    this.states = new Map();                             // conversationId → SessionState
    this.socketGen = 0;                                  // bumped per socket: "resumed on this socket?"
    this.initialized = false;                            // ACP initialize done on the current socket
    this.online = false;
    this.nextReqId = 1;
    this.pendingReqs = new Map();                        // id -> { resolve, reject }
    this.canImage = false;                               // initialize → promptCapabilities.image
    // Router state, shared by the socket: every declared instance (one per conversation) +
    // connectionId → instance. The tunnel a frame arrives on names its conversation (§3.9).
    this.mcpState = { servers: [], connections: {}, mcpConnectionId: null };
    this.reconnectTimer = null;
    this.reconnectFailures = 0;                          // attempts since the last socket that stayed up (§9.5)
    this.lastFailure = null;                             // null | "auth" | "unreachable"
    this.openedThisAttempt = false;                      // did the current attempt reach onopen?
    this.heartbeatTimer = null;                          // liveness probe timer (ADR tunnel-liveness)
    this.alive = false;                                  // last heartbeat verdict (socket responding?)
    this.lastRecvAt = 0;                                 // ts of the last inbound frame (passive liveness §8.6)
    this.lastTunnelMsgAt = 0;                            // ts of the last inbound mcp/message (tunnel freshness §8.3)
    this.missedProbes = 0;                               // consecutive idle-probe timeouts (debounce §8.6)
    // A′ (tunnel-liveness §9.2): when the current run of quick reconnects began — the open time of
    // the first socket since the panel loaded, or since a reconnect that took ≥ 2 min. Replies the
    // agent sent before it may be from an openab process that has since restarted.
    this.runStartAt = 0;
    // How the previous opened socket ended: "unclean" (no close frame, or a heartbeat teardown) can
    // continue the run, "clean" (the server closed on purpose, or we did) cannot; null = none yet.
    this.lastSocketEnd = null;
    // Disconnect diagnostics (§9.3): the current socket's open time (0 until onopen), the last
    // outbound frame, whether onerror fired, and the last record (its next open is filled in).
    this.socketOpenedAt = 0;
    this.lastSentAt = 0;
    this.sawError = false;
    this.lastDiag = null;                                // { id, at } of the latest disconnect record
  }

  get name() { return this.agent.name || "Agent"; }

  /** The session state of a conversation, created (seeded from its saved session id) on first use. */
  stateFor(convId) {
    let st = this.states.get(convId);
    if (!st) {
      const conv = convs.get(convId);
      st = new SessionState(convId, conv && conv.sessions ? conv.sessions[this.agent.url] : null);
      this.states.set(convId, st);
    }
    return st;
  }
  /** The current conversation's state (null while the panel has none, §3.3). */
  get cur() { return conversationId && convs.has(conversationId) ? this.stateFor(conversationId) : null; }
  stateBySession(sessionId) {
    if (!sessionId) return null;
    for (const st of this.states.values()) if (st.acpSessionId === sessionId) return st;
    return null;
  }
  stateOfServer(server) {
    for (const st of this.states.values()) if (st.mcpServer === server) return st;
    return null;
  }

  // Views of the current state, for the roster. The rendering methods below take the state they
  // render for (P2 §5: any open conversation may be running a turn), never "the current one".
  get acpSessionId() { const s = this.cur; return s ? s.acpSessionId : null; }
  // Ready = the socket is initialized and the conversation on screen has its session on it.
  get acpReady() { const s = this.cur; return this.initialized && (!s || (s.readyGen === this.socketGen && !!s.acpSessionId)); }
  // Any of its conversations replying (heartbeat, disconnect diagnostics, reload warning).
  get turnActive() { for (const s of this.states.values()) if (s.turnActive) return true; return false; }
  /** Render into a state's own conversation, on screen or not (P2 §5). */
  inState(st, fn) { return inConv(st ? convs.get(st.convId) : null, fn); }
  // Attached = a tunnel is open to the CURRENT conversation's browser server.
  get browserAttached() {
    const s = this.cur;
    return !!(s && s.mcpServer && Object.values(this.mcpState.connections || {}).includes(s.mcpServer));
  }

  // Declared in that conversation's session/new / session/resume so the gateway opens a browser
  // tunnel for that session: one server instance per (conversation, agent), never shared (§3.9).
  browserMcpServers(st) {
    if (this.agent.browserAccess === false) return [];   // per-agent browser access control (off)
    if (!st.mcpServer) {
      st.mcpServer = BrowserMcp.createServer({
        id: crypto.randomUUID(),
        name: "katashiro",
        serverName: "katashiro-browser",
        // Report the extension's own version to the agent rather than a second number that
        // would drift — "which katashiro is this?" should have one answer.
        version: chrome.runtime.getManifest().version
      });
      st.mcpServer.setImageStoreMax(screenshotConfig.storeMax);
      this.mcpState.servers.push(st.mcpServer);
    }
    return [st.mcpServer.declaration()];
  }

  /** Archive (§3.4): forget a conversation's session state, its server and that server's tunnels. */
  dropState(convId) {
    const st = this.states.get(convId);
    if (!st) return;
    this.states.delete(convId);
    if (!st.mcpServer) return;
    st.mcpServer.clearImages();
    this.mcpState.servers = this.mcpState.servers.filter((s) => s !== st.mcpServer);
    for (const [k, s] of Object.entries(this.mcpState.connections || {})) if (s === st.mcpServer) delete this.mcpState.connections[k];
    if (this.mcpState.mcpConnectionId && !this.mcpState.connections[this.mcpState.mcpConnectionId]) this.mcpState.mcpConnectionId = null;
    updateRoster();
  }

  socketSend(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(obj)); this.lastSentAt = Date.now(); }
  }

  // §9.3 (E): record one socket end. `ev` is the CloseEvent (null when connect() replaced an open
  // socket — its onclose is detached, so no event comes); `path` is what happens next. The frame
  // gaps count this socket only (null = none since it opened).
  recordDisconnect(ev, path, retryInMs) {
    const now = Date.now();
    const since = (t) => (this.socketOpenedAt > 0 && t >= this.socketOpenedAt ? now - t : null);
    const rec = {
      id: crypto.randomUUID().slice(0, 8), at: now, agent: this.name, windowId: panelWindowId,
      code: ev ? ev.code : null, reason: ev ? String(ev.reason || "") : "", wasClean: ev ? !!ev.wasClean : null,
      error: this.sawError, sinceRecvMs: since(this.lastRecvAt), sinceSendMs: since(this.lastSentAt),
      turnActive: this.turnActive, ageMs: this.socketOpenedAt > 0 ? now - this.socketOpenedAt : null, path,
    };
    if (Number.isFinite(retryInMs)) rec.retryInMs = retryInMs;
    this.lastDiag = { id: rec.id, at: now };
    (ev && ev.code === 1000 ? console.info : console.warn)(`ACP[${this.name}]: disconnect — ${RoomCore.formatDisconnect(rec)}`);
    logDisconnectOp({ push: rec });
  }

  // What the tunnel router (BrowserMcp.handleServerRequest) runs with: the socket, and per server the
  // deps of the conversation it belongs to.
  routerDeps() {
    return {
      chrome,
      crypto,
      send: (obj) => this.socketSend(obj),
      onStatus: (attached) => this.setBrowserAttached(attached),
      depsFor: (server) => {
        const st = this.stateOfServer(server);
        return st ? this.mcpDeps(st) : { chrome, crypto, send: (obj) => this.socketSend(obj), refuse: "this conversation was closed in Katashiro" };
      },
    };
  }

  // One conversation's tool deps. Every per-conversation dependency (canvases, chat_history, where
  // a card or an image goes) is bound to `st`, never to "the panel's" (§3.9).
  mcpDeps(st) {
    return {
      chrome,
      crypto,
      send: (obj) => this.socketSend(obj),
      // P2 §5 (Q8): a conversation not on screen works in its own tab group: the tools that would show
      // something or take the user's tab are refused (BrowserMcp.backgroundRefusal), and page tools
      // act on its working tab, checked by backgroundTabFor. Both read at dispatch time.
      refuse: (name, args) => (st.convId === conversationId ? null : BrowserMcp.backgroundRefusal(name, args)),
      backgroundTab: st.convId === conversationId ? undefined : (o) => backgroundTabFor(st.convId, o),
      // Per-tool activity signal for the chat transcript: name + outcome + MASKED args/summary/ms
      // (browser-mcp.js applies each tool's redact hook; raw args never reach the UI).
      onToolCall: (info) => this.renderToolActivity(info, st),
      // Read at dispatch time, not captured at connect time, so flipping the toggle applies to
      // the very next tool call — no reconnect, no stale consent.
      actMode,
      // Jev grounding token (BYO-key), same read-fresh rationale. Empty ⇒ grounding off:
      // browser-mcp appends no verification signal, behaviour is exactly as before.
      jevToken,
      // Settings → 截圖, read fresh like actMode. reencodeImage shrinks an over-cap capture here
      // (the panel has a canvas; browser-mcp.js stays DOM-free).
      screenshot: screenshotConfig,
      reencodeImage: reencodeJpeg,
      // chat_history reads the calling conversation's persisted scrollback; notify tags its toasts
      // with the window so the click handler below focuses the right one.
      chatHistory: () => { const c = convs.get(st.convId); return c ? c.messages : []; },
      clientInfo: clientInfoSnapshot,
      // show_image renders into THIS conversation's turn (or as its own message between turns).
      showImage: (img) => this.showImage(img, st),
      // ask_user shows its card in THIS agent's turn, and the answer comes back to THIS session only.
      askUser: (args) => this.askUser(args, st),
      // P1b (ADR §4.3): the tab this conversation's agent acted on becomes its working tab; a tab it
      // opened (new_tab) also joins the conversation's tab group (§4.1).
      // Returns the promise: new_tab / switch_tab await it, so a background conversation's next page
      // tool finds the tab already in its group and recorded as its working tab; false = it is not.
      onTabUsed: (tabId, o) => noteWorkingTab(st.convId, tabId, o).catch(() => false),
      workingTab: async () => { const t = await resolveWorkingTab(st.convId); return t ? t.id : null; },
      // P1b §4.6: set_title names the calling conversation; a user title always wins.
      setTitle: (title) => setAgentTitle(st.convId, title),
      // Canvas (ADR docs/adr/canvas.md): one store for the panel, keyed by the calling
      // conversation; a write shows its card in THIS agent's turn and opens a new canvas's tab.
      canvas: {
        store: canvasStore,
        conversationId: () => st.convId,
        onWrite: (res, opts) => this.onCanvasWrite(res, opts, st),
        waitNormalized: (id, version, raw) => waitCanvasNormalized(id, version, raw),
        // canvas_delete (Brett): any canvas, but only after the user says yes, here in the panel —
        // on a confirm card in this agent's turn, not window.confirm, which froze the whole room
        // (#80). The title is agent text: the card shows it as one plain-text line.
        // Resolves { ok, state }: the tool tells "the user said no" from "your turn had ended".
        confirmDelete: async ({ id, title, version, author }) => {
          const open = !!(await findCanvasTab(id).catch(() => null));
          return confirmOutcome({
            title: `${this.name} 要刪除畫布`,
            lines: [
              `「${title}」（v${version}${author === "user" ? "，含你的修改" : ""}）`,
              // canvas.js keeps a dirty editor on screen to copy from, but nothing saves it any more.
              // The dirty flag reaches the panel a frame late, so "usually".
              ...(open ? ["這個畫布正開在分頁中：分頁裡未儲存的修改會遺失（編輯中的文字通常會留在畫面上，可先複製）。"] : []),
              "這個動作無法復原。",
            ],
          }, { conn: this, st, notAskedNote: `${this.name} 的回合已結束，刪除畫布的要求未執行（沒有詢問你）。` });
        },
        // Storage full on this agent's canvas_open / canvas_patch: ask in this agent's turn (#80).
        confirmEvict: (info) => confirmEvictCard(info, this, st),
        gotoSlide: (id, slide) => gotoCanvasSlide(id, slide),
        highlight: (id, req) => highlightCanvasBlock(id, req),
        injectCss: (id, req) => injectCanvasCss(id, req),
        // canvas_view / canvas_gallery (§3.11): the agent's equivalents of the user's display switches.
        setShowChanges: (on) => setCanvasShowChanges(on),
        compare: (id, on) => (on ? startCanvasCompare(id) : endCanvasCompare(id)),
        openGallery: (query) => openCanvasGallery(query),
      },
      windowId: panelWindowId,
    };
  }

  // Tunnel set changed (the router's first-open / last-close events; per-conversation connects are
  // re-rendered from handleAcpMessage). `browserAttached` itself is derived from the connections.
  setBrowserAttached(attached) {
    // A fresh attach (mcp/connect) is itself proof the tunnel is live right now — stamp it so the
    // segment reads 活躍 immediately, not 閒置 until the first mcp/message arrives (Falcon review).
    if (attached) this.lastTunnelMsgAt = Date.now();
    updateRoster();
  }

  // Send a JSON-RPC request on THIS conn's socket; resolve when its response arrives.
  // `deadline()`, if given, replaces the fixed timeout: it returns { at, reason } and is asked again
  // whenever the timer fires, so activity in between pushes the deadline out (session/prompt).
  acpRequest(method, params, timeoutMs = ACP_REQUEST_TIMEOUT_MS, deadline = null) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject("socket not open");
        return;
      }
      const id = this.nextReqId++;
      const startedAt = Date.now();
      const next = deadline || (() => ({ at: startedAt + timeoutMs, reason: null }));
      let timer;
      const arm = () => {
        const d = next();
        const wait = d.at - Date.now();
        if (wait > 0) { timer = setTimeout(arm, wait); return; }
        if (this.pendingReqs.delete(id)) reject(`request timed out: ${method}${d.reason ? ` (${d.reason})` : ""}`);
      };
      this.pendingReqs.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      arm();                                       // after set(): a deadline already past rejects here
      if (!this.pendingReqs.has(id)) return;
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      this.lastSentAt = Date.now();
    });
  }

  rejectAllPending(reason) {
    for (const { reject } of this.pendingReqs.values()) reject(reason);
    this.pendingReqs.clear();
  }

  // Open (or reopen) this conn's socket and run the handshake. `reason` names the reconnect path
  // in the diagnostics when this replaces an open socket ("heartbeat" from onProbeTimeout).
  connect(reason = "manual") {
    this.enabled = true;
    this.stopHeartbeat();                                // don't probe across a teardown/reconnect
    if (reason !== "auto") this.reconnectFailures = 0;   // a manual / heartbeat reconnect starts the backoff over (§9.5)
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.openedThisAttempt) {
      this.recordDisconnect(null, `${reason}-reconnect`);
      // A heartbeat teardown replaces a silent socket (the unclean case); a manual retry starts afresh.
      this.lastSocketEnd = reason === "heartbeat" ? "unclean" : "clean";
    }
    if (this.ws) {
      this.ws.onclose = null;                            // stale socket must not trigger reconnect
      this.ws.close();
    }
    clearTimeout(this.reconnectTimer);
    this.online = false;
    this.initialized = false;
    this.socketGen++;                                    // every session must be resumed on the new socket
    this.alive = false;
    this.missedProbes = 0;                               // fresh socket ⇒ fresh debounce count
    this.openedThisAttempt = false;
    this.socketOpenedAt = 0;
    this.sawError = false;
    updateRoster();

    try {
      this.ws = new WebSocket(this.agent.url, acpProtocols(this.agent.token));

      this.ws.onopen = () => {
        // A′ (§9.2): read lastRecvAt BEFORE any frame on this socket stamps it — it is still the
        // previous socket's last inbound frame (0 if this conn never had one).
        const openedAt = Date.now();
        const sameRun = ConvCore.continuesRun({ prevLastRecvAt: this.lastRecvAt, prevEnd: this.lastSocketEnd, openedAt });
        if (!sameRun) this.runStartAt = openedAt;
        this.socketOpenedAt = openedAt;
        // §9.3: the latest drop gets its outcome — how long until this open, and the run verdict.
        if (this.lastDiag) {
          logDisconnectOp({ patch: { id: this.lastDiag.id, fields: { reopenAfterMs: openedAt - this.lastDiag.at, sameRun } } });
          this.lastDiag = null;
        }
        console.info(`ACP[${this.name}]: socket open — ${sameRun ? `same run (last frame ${Math.round((openedAt - this.lastRecvAt) / 1000)} s before)` : `new run (previous end: ${this.lastSocketEnd || "none"})`}`);
        this.online = true;
        this.openedThisAttempt = true;                   // upgrade succeeded ⇒ token accepted
        this.lastFailure = null;
        updateRoster();
        this.handshake();
      };

      this.ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); }
        catch (err) { console.error(`ACP[${this.name}]: non-JSON frame:`, err); return; }
        this.handleAcpMessage(msg);
      };

      this.ws.onclose = (ev) => {
        // §9.5 (C): retry at once after an unclean drop (1 s after a clean close), then back off
        // (1, 2, 4, 8, 16, 30 s…, ±20 %) while attempts fail or the new socket dies within 30 s.
        this.reconnectFailures = RoomCore.reconnectFailuresAfter({
          failures: this.reconnectFailures, opened: this.openedThisAttempt,
          upMs: this.socketOpenedAt > 0 ? Date.now() - this.socketOpenedAt : 0,
          clean: !!(ev && ev.wasClean && ev.code !== 1006),
        });
        const retryInMs = RoomCore.reconnectDelay(this.reconnectFailures);
        // §9.3 (E): an opened socket's end is one record; an attempt that never opened is counted
        // on the record before it (an outage keeps retrying and must not flush the history).
        if (this.openedThisAttempt) {
          this.recordDisconnect(ev, this.enabled ? "auto-reconnect" : "none", this.enabled ? retryInMs : undefined);
          this.lastSocketEnd = ev && ev.wasClean && ev.code !== 1006 ? "clean" : "unclean";
        }
        else if (this.lastDiag && this.enabled) logDisconnectOp({ bump: this.lastDiag.id });
        this.online = false;
        this.initialized = false;
        this.alive = false;
        this.stopHeartbeat();
        this.mcpState.connections = {};                  // every tunnel dies with the socket
        this.mcpState.mcpConnectionId = null;
        this.setBrowserAttached(false);
        this.rejectAllPending("connection closed");
        // Never reached onopen this attempt ⇒ the WS upgrade was rejected (bad/missing token)
        // or the server is unreachable. Probe to tell which, and surface it in the UI.
        if (!this.openedThisAttempt && this.enabled) this.probe();
        updateRoster();
        // Auto reconnect (only if the user still wants this conn up) — the next handshake
        // resumes the current conversation's session if it has one.
        if (this.enabled) this.reconnectTimer = setTimeout(() => this.connect("auto"), retryInMs);
      };

      this.ws.onerror = () => {
        // The Event carries nothing useful (the browser hides the cause); the CloseEvent that
        // follows has the code. Note it for that record.
        this.sawError = true;
        console.warn(`WebSocket[${this.name}] error (readyState ${this.ws ? this.ws.readyState : "?"})`);
        this.online = false;
        updateRoster();
      };
    } catch (e) {
      console.error(`Error creating WebSocket[${this.name}]:`, e);
    }
  }

  // Tear down permanently (no reconnect) — used on delete / retarget / another agent made active.
  disconnect() {
    this.enabled = false;
    this.stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.cancelTurn();                               // stop an in-flight turn server-side before dropping the
                                                       // socket, so the gateway cancels the agent-core turn instead
                                                       // of leaving it running (no-op if no turn / socket not open)
      // §9.3: onclose is detached below, so the user's stop is recorded here (path "none").
      if (this.ws.readyState === WebSocket.OPEN && this.openedThisAttempt) this.recordDisconnect(null, "none");
      this.lastSocketEnd = "clean";
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.online = false;
    this.initialized = false;
    this.socketGen++;
    this.alive = false;
    for (const st of this.states.values()) this.finalizeStream(undefined, st);
    // This agent's open ask_user cards close in EVERY conversation (§3.8): none of its sessions
    // will be flushed, so an answer would reach no session that asked.
    closePendingAsks(this);
    // Captures are page data: none outlive this agent being active. (A transient socket drop
    // keeps them — the resumed session still holds their imageIds.)
    for (const st of this.states.values()) if (st.mcpServer) st.mcpServer.clearImages();
  }

  // The WS handshake failed without ever opening. Probe the endpoint over plain HTTP (the
  // browser hides the WS upgrade's 401, but host_permissions lets us fetch it): if the server
  // responds at all it's reachable ⇒ the WS was rejected, almost always a bad/missing token;
  // if the fetch throws, the server is unreachable (down / wrong address).
  probe() {
    const httpUrl = this.agent.url.replace(/^ws/i, "http"); // ws→http, wss→https
    fetch(httpUrl, { method: "GET" })
      .then(() => { this.lastFailure = "auth"; })
      .catch(() => { this.lastFailure = "unreachable"; })
      .finally(() => updateRoster());
  }

  // Socket handshake: ACP initialize once per socket, then the current conversation's session.
  // Other open conversations are resumed when they are switched to (§3.5), not here.
  handshake() {
    const gen = this.socketGen;
    BUILD_INFO
      .then(({ version, detail }) => this.acpRequest("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: RoomCore.acpClientInfo(version, detail),
      }))
      .then((init) => {
        if (gen !== this.socketGen) return undefined;
        // Only send image blocks to an agent that declares it takes them; the gateway answers
        // `image: false` (and -32602 on an image block) until it supports them.
        this.canImage = Composer.canImage(init);
        this.initialized = true;
        this.alive = true;
        this.startHeartbeat();
        updateRoster();
        // The conversation on screen, and every other one with prompts waiting (P2 §5: a turn a
        // dropped socket re-queued in the background resends there too). Others resume on switch.
        const cur = this.cur;
        for (const st of this.states.values()) if (st !== cur && st.promptQueue.length) this.openSession(st);
        return cur ? this.openSession(cur) : undefined;
      })
      .catch((err) => {
        if (gen === this.socketGen) appendSystemMessage(`${this.name} ACP 握手失敗：` + err);
      });
  }

  // Resume (or create) one conversation's ACP session on this socket — once per socket (§3.5
  // steps): session/resume with its id and its OWN MCP server declaration, or session/new if it
  // has none for this agent. Messages typed meanwhile wait in its queue. Resolves when settled.
  openSession(st) {
    if (!this.initialized || !(this.ws && this.ws.readyState === WebSocket.OPEN)) return Promise.resolve();
    if (st.readyGen === this.socketGen) { this.flushQueue(st); return Promise.resolve(); }
    if (st.opening) return st.opening;
    const gen = this.socketGen;
    const resuming = !!st.acpSessionId;
    const gone = () => gen !== this.socketGen || this.states.get(st.convId) !== st;   // socket replaced / archived meanwhile
    const req = resuming
      ? this.acpRequest("session/resume", { sessionId: st.acpSessionId, cwd: ACP_CWD, mcpServers: this.browserMcpServers(st) })
      : this.acpRequest("session/new", { cwd: ACP_CWD, mcpServers: this.browserMcpServers(st) });
    const p = req.then((res) => {
      if (gone()) return undefined;
      if (!resuming) st.acpSessionId = res && res.sessionId;
      st.readyGen = gen;
      const conv = convs.get(st.convId);
      // U2 (§3.5) narrowed by A′ (tunnel-liveness §9.2): Katashiro cannot tell a resumed session
      // from one the broker silently recreated, so the host line goes with the first prompt unless
      // the session is almost certainly intact — resumed, and this agent replied here during the
      // current run of quick reconnects, < 1 h ago. Sticky: a later open never clears a pending
      // line (the socket may drop again before the user sends); only an accepted session/prompt does.
      const hint = ConvCore.reconnectHintDecision({
        messageCount: conv ? conv.messages.length : 0, queuedCount: st.promptQueue.length, resumed: resuming,
        runStartAt: this.runStartAt, lastReplyAt: ConvCore.lastReplyAt(conv && conv.messages, this.id), now: Date.now(),
      });
      st.hintPending = st.hintPending || hint.hint;
      console.info(`ACP[${this.name}]: ${st.convId} ${resuming ? "resumed" : "new session"} — reconnect hint ${hint.hint ? "added" : "skipped"} (${hint.reason})${st.hintPending && !hint.hint ? ", still pending from before" : ""}`);
      updateRoster();
      saveConv(conv);                                    // persist the (confirmed) resumable session id
      const short = (st.acpSessionId || "").slice(0, 13) || "?";
      appendSystemMessage(resuming ? `已續接 ${this.name} 的 ACP session（${short}）。` : `已連線至 ${this.name}（ACP session ${short}）。`, conv);
      this.flushQueue(st);
      return undefined;
    }, (err) => {
      if (gone()) return undefined;
      // The socket died under the request: keep the session id, the reconnect resumes it.
      if (RoomCore.isDeadProbeReason(String(err))) return undefined;
      if (resuming) {
        // A resume can fail if the session id is unknown → fall back to a fresh one. The fresh
        // session never asked: this conversation's cards for this agent close as `restarted`.
        st.acpSessionId = null;
        closePendingAsks(this, "restart", st.convId);
        st.opening = null;
        return this.openSession(st);
      }
      appendSystemMessage(`${this.name} ACP 握手失敗：` + err, convs.get(st.convId));
      return undefined;
    });
    st.opening = p;
    p.finally(() => { if (st.opening === p) st.opening = null; });
    return p;
  }

  // Route an incoming JSON-RPC message for this conn.
  handleAcpMessage(msg) {
    // Passive liveness (ADR §8.6): ANY inbound frame — a streaming chunk, a response, a
    // server-driven tunnel frame — proves the socket is alive. Stamp it and clear any degraded
    // state so the heartbeat never probes (nor false-positive-reconnects) a socket that traffic
    // already proves live. This is the fix for #17 killing healthy streaming turns. An inbound
    // mcp/message additionally freshens the tunnel-liveness clock (§8.3, 活躍 vs 閒置).
    this.lastRecvAt = Date.now();
    this.missedProbes = 0;
    if (this.alive !== true) this.markAlive(true);       // markAlive no-ops when already alive (no render spam)
    if (msg.method === "mcp/message") { this.lastTunnelMsgAt = this.lastRecvAt; updateRoster(); }
    // Turn activity (pushes the turn's idle deadline out): any update for a session — text, tool
    // events, or whatever else the gateway sends — and the agent driving that session's browser
    // tunnel (the connection names the server, the server its conversation, §3.9).
    if (msg.method === "session/update" && msg.params) {
      const st = this.stateBySession(msg.params.sessionId);
      if (st) st.lastTurnActivityAt = this.lastRecvAt;
    } else if (msg.method === "mcp/message") {
      const server = this.mcpState.connections && msg.params && this.mcpState.connections[msg.params.connectionId];
      const st = server && this.stateOfServer(server);
      if (st) st.lastTurnActivityAt = this.lastRecvAt;
    }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pendingReqs.get(msg.id);
      if (p) {
        this.pendingReqs.delete(msg.id);
        if (msg.error) p.reject(msg.error.message || JSON.stringify(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }

    // Server-initiated request (id + method): the gateway driving one of THIS conn's browser MCP
    // tunnels (mcp/connect, mcp/message, mcp/disconnect). Route + respond on this socket; a
    // connect or disconnect may change whether the conversation on screen is attached.
    if (msg.id !== undefined && msg.method) {
      const done = BrowserMcp.handleServerRequest(msg, this.routerDeps(), this.mcpState);
      if (msg.method !== "mcp/message") Promise.resolve(done).then(() => this.setBrowserAttached(msg.method === "mcp/connect"), () => {});
      return;
    }

    // Streaming agent reply, routed by sessionId to its own conversation (P2 §5), on screen or not.
    // A frame with no sessionId goes to the conversation on screen (MVP rule, §3.11); one for a
    // session no open conversation has (archived meanwhile) is dropped and logged.
    if (msg.method === "session/update" && msg.params && msg.params.update) {
      const sid = msg.params.sessionId;
      const st = sid ? this.stateBySession(sid) : this.cur;
      // Only into a turn in flight: a turn the user stopped whose agent kept going (§1.2) must not
      // grow a bubble that no turn will ever finalize.
      if (!st || !st.turnActive) {
        console.info(`ACP[${this.name}]: dropped a session/update for ${sid || "?"} (${st ? "no turn running in that conversation" : "no open conversation has it"})`);
        return;
      }
      const u = msg.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content) {
        this.appendToStream(u.content.text || "", st);
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        this.renderAgentToolCall(u, st);                 // the agent's own tools (Bash, Edit, …)
      }
    }
  }

  // Queue a prompt for a conversation's session (the current one by default; an ask card's answer
  // goes to the session that asked, §3.8).
  enqueue(text, images, st = this.cur) {
    if (!st) return;
    st.promptQueue.push(text);
    if (images && images.length) st.pendingImages.push(...images);
    // openSession, not flushQueue: a background conversation not yet resumed on this socket (e.g. a
    // relay after a reconnect) is opened first; one that is ready just flushes (review: Jellyfish, #143).
    this.openSession(st);
  }

  // Send the next queued turn if this session is idle and ready.
  flushQueue(st = this.cur) {
    if (!st || st.turnActive || st.promptQueue.length === 0) return;
    // P2 (§5): any open conversation runs its turn, on screen or not. Concurrency is the open count
    // (at most 3, Q7); one turn per conversation, so -32001 Session busy cannot happen.
    if (this.states.get(st.convId) !== st) return;       // archived meanwhile
    if (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.initialized && st.readyGen === this.socketGen && st.acpSessionId)) return;

    // Batch delivery: drain the WHOLE backlog and send it as one turn, not one-per-round. If the
    // agent was busy while the user (or a relay) piled up several messages, they arrive together on
    // the next round — Discord-style — instead of dribbling out over N turns.
    const batch = st.promptQueue.splice(0);
    // The reply hint exactly once, at the end — also when a retried prompt (which carries it) is
    // batched with newer messages (#62).
    let text = RoomCore.batchWithReplyHint(batch);
    let images = [];
    if (st.pendingImages.length && !this.canImage) {
      const n = st.pendingImages.splice(0).length;
      this.inState(st, () => appendSystemMessage(`${this.name} 不支援圖片，${text ? "只送出文字" : "這則沒有送出"}（${n} 張圖片未送出）。`));
    } else {
      // Batched backlog may hold several messages' images: send what fits one frame's budget and
      // leave the rest (plus an empty prompt to carry them) for the next turn.
      while (st.pendingImages.length && (images.length === 0 || Composer.fitsBudget(images, st.pendingImages[0].data.length))) {
        images.push(st.pendingImages.shift());
      }
      if (st.pendingImages.length) st.promptQueue.push("");
    }
    if (!text && images.length === 0) return;            // nothing sendable — stay idle
    st.lastPrompt = text;                                // remember for retry (the whole batch, no host line)
    st.lastImages = images;
    st.turnActive = true;
    st.skippedToolCalls = new Set();                     // katashiro tool calls seen this turn
    updateStopButton();
    renderConvTabs();
    this.startStream(st);

    // U2 host line (§3.5): first, at flush time only — never stored, never in the retry copy.
    const hinted = st.hintPending;
    const sent = hinted ? ConvCore.withReconnectHint(text) : text;
    const startedAt = Date.now();
    st.lastTurnActivityAt = startedAt;
    this.acpRequest("session/prompt", {
      sessionId: st.acpSessionId,
      prompt: Composer.promptBlocks(sent, images),
    }, 0, () => RoomCore.turnDeadline({
      startedAt, lastActivityAt: st.lastTurnActivityAt,
      idleMs: RoomCore.TURN_IDLE_TIMEOUT_MS, maxMs: RoomCore.TURN_MAX_TIMEOUT_MS,
    }))
      .then((res) => {
        const replyText = st.stream ? st.stream.text : "";
        if (ConvCore.isPoolBusyReply(replyText)) {
          // §5: the pool was full — openab says so as a chat line, not an error (ConvCore.isPoolBusyReply).
          // The turn never started: no record, no relay, the host line stays pending; error bubble + 重試.
          st.turnActive = false;
          updateStopButton();
          renderConvTabs();
          st.stream.text = "";                           // drop the line: finalize removes the empty row
          this.finalizeStream(undefined, st);
          this.inState(st, () => appendErrorMessage(this.name, ConvCore.promptFailureText("pool exhausted"), () => this.retryLast(st)));
          if (st.convId !== conversationId && this.states.get(st.convId) === st) notifyTurnDone(st.convId, this.name, true);
          this.flushQueue(st);
          return;
        }
        if (hinted) st.hintPending = false;              // accepted: the agent has seen the line
        st.turnActive = false;
        updateStopButton();
        renderConvTabs();
        this.finalizeStream(res && res.stopReason, st);  // stopReason "cancelled" ⇒ partial reply kept
        this.inState(st, () => relayAgentReply(this, replyText, st.convId)); // fan it out, within its conversation
        // Q9 (§5): a turn that finished where the user is not → ● on its tab (recordMessage) and a
        // notification. A stopped turn is the user's own doing: no notification.
        if (st.convId !== conversationId && this.states.get(st.convId) === st && !(res && res.stopReason === "cancelled")) notifyTurnDone(st.convId, this.name);
        this.flushQueue(st);
      })
      .catch((err) => {
        st.turnActive = false;
        updateStopButton();
        renderConvTabs();
        const socketOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
        const action = RoomCore.promptFailureAction(RoomCore.isDeadProbeReason(String(err)), socketOpen);
        if (action === "requeue") {
          // The socket genuinely closed / half-opened (an explicit close, or a heartbeat teardown
          // that rejects the in-flight turn with "connection closed"). The prompt almost certainly
          // never landed, so re-queue it — the onclose-scheduled reconnect flushes it on a fresh
          // session (ADR R3). Safe: a dead socket means the agent never received this turn. The
          // host line is not re-queued: the flag still stands, so the resend carries it again.
          st.promptQueue.unshift(text);
          st.pendingImages.unshift(...images);           // the images never landed either
          this.finalizeStream(undefined, st);
        } else if (action === "cancel") {
          // Socket still OPEN but the turn "timed out" — it is very likely still ALIVE server-side
          // (a long tool phase that outran the idle/prompt timer; cf. openab's text-only idle timer
          // that supersedes tool-heavy turns). The old code force-reconnected and re-sent here, which
          // DUPLICATED a turn the agent had already received and acted on — the resend fired on
          // resume and the agent ran the same message 2–3× (the reconnect-duplication bug). Never
          // auto-re-send into a live session: cancel the stale turn and let the USER re-issue via the
          // retry button. No reconnect either — the socket + tunnel are fine.
          if (hinted) st.hintPending = false;            // the prompt was received
          if (st.acpSessionId) this.socketSend({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: st.acpSessionId } });
          this.finalizeStream(undefined, st);
          const why = /\(max\)/.test(String(err))
            ? `回合超過 ${RoomCore.TURN_MAX_TIMEOUT_MS / 60000} 分鐘上限`
            : `回合 ${RoomCore.TURN_IDLE_TIMEOUT_MS / 60000} 分鐘沒有任何動靜`;
          this.inState(st, () => appendErrorMessage(this.name, `${why}（連線仍在）—— 已取消，未自動重送以免重複。需要就點重試。`, () => this.retryLast(st)));
        } else {
          this.finalizeStream("error", st);              // render any partial reply, then a distinct
          // §5: the pool is shared with Discord and usercron; "pool exhausted" is said plainly and
          // never retried automatically — 重試 is the user's call.
          this.inState(st, () => appendErrorMessage(this.name, ConvCore.promptFailureText(String(err)), () => this.retryLast(st))); // error bubble
        }
        // Q9: a background turn that ended badly is said too (a requeued one has not ended).
        if (action !== "requeue" && st.convId !== conversationId && this.states.get(st.convId) === st) notifyTurnDone(st.convId, this.name, true);
        this.flushQueue(st);
      });
  }

  // Stop the in-flight turn: session/cancel is a one-way NOTIFICATION (no id). The gateway fires
  // the prompt's cancel signal, which resolves our session/prompt request with stopReason
  // "cancelled" — so the normal .then path finalizes the (partial) reply; nothing to settle here.
  // `convId`: only that conversation's turn (the tab strip's ⏹, P2 §5); none = every turn.
  cancelTurn(convId = null) {
    for (const st of this.states.values()) {
      if (!st.turnActive || !st.acpSessionId || (convId && st.convId !== convId)) continue;
      this.socketSend({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: st.acpSessionId } });
    }
  }

  // Re-send the last turn (after an error / stop). If the socket isn't live, reconnect first and
  // queue the turn so it flushes once the handshake completes — otherwise a retry on a dead/closed
  // socket would silently no-op (ADR tunnel-liveness R3, the reported "retry does nothing").
  retryLast(st = this.cur) {
    // Single-active: a stale error bubble from a now-dormant agent still has a live 重試 button;
    // clicking it must NOT `connect()` this dormant Conn — that would bring a second agent online
    // alongside the active one (review: Orca, the C2 race).
    if (this.agent.url !== activeAgentUrl) return;
    // Its conversation must still be open (P2: on screen or not — the button is in its own list).
    if (!st || this.states.get(st.convId) !== st) return;
    if ((!st.lastPrompt && st.lastImages.length === 0) || st.turnActive) return;
    st.promptQueue.push(st.lastPrompt || "");            // "" still carries an image-only turn
    st.pendingImages.push(...st.lastImages);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.initialized) this.openSession(st);   // flushes once ready
    else this.connect();                                 // reconnect; flushQueue runs after handshake
  }

  // --- Liveness heartbeat (ADR browser-tunnel-liveness §8.6, reworked) --------
  // Traffic IS liveness: passive `lastRecvAt` (handleAcpMessage) covers every busy socket, so the
  // heartbeat only has to catch a genuinely SILENT-IDLE half-open (reports OPEN but is dead). It
  // probes with a request the gateway answers immediately (unknown method → -32601, in its read
  // loop, no agent — verified in openab acp_server.rs); ANY response, error included, proves life.
  // Unlike #17 it does NOT probe during a turn or recent traffic (that false-positived under a
  // chunk flood and killed healthy turns), and a single timeout only DEGRADES the badge — a
  // destructive reconnect needs HEARTBEAT_DEAD_THRESHOLD consecutive misses and never fires
  // mid-turn (§8.6).
  startHeartbeat() {
    this.stopHeartbeat();
    const interval = roomConfig.heartbeatIntervalMs || 60000;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), interval);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  heartbeatTick() {
    if (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.initialized)) return; // nothing to probe
    // Passive-first (§8.6): a turn in flight, or any inbound frame within the last interval, is
    // self-evident proof of life — only genuine silence gets a probe (decision in RoomCore, tested).
    const interval = roomConfig.heartbeatIntervalMs || 60000;
    if (!RoomCore.shouldProbe({ turnActive: this.turnActive, now: Date.now(), lastRecvAt: this.lastRecvAt, intervalMs: interval })) return;
    const timeout = roomConfig.heartbeatTimeoutMs || 5000;
    this.acpRequest("katashiro/ping", {}, timeout)
      .then(() => this.markAlive(true))                  // gateway answered (unlikely to resolve, but alive)
      .catch((err) => {
        if (RoomCore.isDeadProbeReason(String(err))) this.onProbeTimeout();
        else this.markAlive(true);                       // an error reply (e.g. -32601) still proves liveness
      });
  }

  markAlive(alive) {
    if (alive === true) this.missedProbes = 0;           // any positive verdict resets the debounce
    if (alive === this.alive) return;
    this.alive = alive;
    updateRoster();                                      // chip reflects alive vs ⚠️ 無回應
  }

  // A silent-idle probe timed out. The decision — DEGRADE the badge (safe) vs a destructive
  // reconnect (only on CONFIRMED death: ≥ HEARTBEAT_DEAD_THRESHOLD consecutive misses, never
  // mid-turn) — is RoomCore.onProbeTimeoutDecision (§8.6, unit-tested). This just enacts it: a live
  // turn's hang is R3's job, and any inbound frame resets `missedProbes` via markAlive/handleAcpMessage.
  onProbeTimeout() {
    const d = RoomCore.onProbeTimeoutDecision({
      turnActive: this.turnActive, missedProbes: this.missedProbes, threshold: HEARTBEAT_DEAD_THRESHOLD,
    });
    if (d.degrade) this.markAlive(false);                // display only — ⚠️ 無回應
    this.missedProbes = d.missedProbes;
    if (d.reconnect) {
      this.stopHeartbeat();
      this.rejectAllPending("connection closed");        // fail-fast the now-confirmed-dead socket
      this.connect("heartbeat");                         // teardown + re-handshake (resume re-declares tunnel)
    }
  }

  // --- Streaming bubble (per conn — agents stream concurrently) --------------
  startStream(st) {
    if (!st) return;
    st.stream = { bubble: null, text: "" };
    // Built entirely with createElement (no innerHTML) so the whole row is off the XSS-review
    // surface; name/avatar/time are set via textContent.
    const msgDiv = document.createElement("div");
    msgDiv.className = "message received";

    const avatar = document.createElement("div");
    avatar.className = `avatar tone-${RoomCore.avatarTone(this.id)}`;   // per agent, not per row
    avatar.textContent = this.name.charAt(0).toUpperCase();

    const contentEl = document.createElement("div");
    contentEl.className = "message-content";
    const nameEl = document.createElement("div");
    nameEl.className = "sender-name";
    nameEl.textContent = this.name;
    const bubble = document.createElement("div");
    bubble.className = "bubble typing";
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    bubble.appendChild(dots);
    const ts = document.createElement("div");
    ts.className = "timestamp";
    ts.textContent = formatTime(Date.now());
    contentEl.append(nameEl, bubble, ts);

    msgDiv.append(avatar, contentEl);
    st.stream.bubble = bubble;
    st.stream.contentEl = contentEl;     // anchor for the tool-activity strip (inserted above bubble)
    this.inState(st, () => { outList().appendChild(msgDiv); maybeScroll(); });
  }

  // Append a compact browser-tool activity marker to the current turn: verb + ⏳/✓/✗. It lets
  // the user see that tools ran (and whether they succeeded) during a long, text-silent tool
  // sequence — distinct from the agent's reply bubble, never confused for text. Details stay out
  // of the strip: hover shows the command + outcome + duration, click expands the full (masked)
  // arguments and a result excerpt underneath. `info.args` is already masked by browser-mcp.js.
  renderToolActivity(info, st) {
    if (!info || !info.name || !st || !st.turnActive) return;   // only annotate an in-flight agent turn
    const s = this.ensureToolStrip(st);
    const verb = info.name.replace(/^[^.]*\./, "");        // drop the "katashiro." provider prefix
    let pill;
    if (info.phase === "start") {
      pill = document.createElement("button");
      pill.type = "button";
      pill.className = "tool-pill running";
      pill.textContent = `${verb} ⏳`;
      pill.addEventListener("click", () => toggleToolDetail(s, pill));
      s.toolStrip.appendChild(pill);
      if (info.callId) s.toolPills[info.callId] = pill;
    } else {
      pill = info.callId && s.toolPills[info.callId];   // never guess: the last pill may be an agent pill
      if (!pill) return;
      const ok = info.phase !== "error";
      pill.className = `tool-pill ${ok ? "done" : "error"}`;
      pill.textContent = `${verb} ${ok ? "✓" : "✗"}`;
    }
    pill.toolInfo = { ...info, verb };
    pill.title = toolTooltip(pill.toolInfo);               // property, not markup
    if (s.toolDetailPill === pill) renderToolDetail(s, pill); // refresh an open expander on settle
    this.inState(st, maybeScroll);
  }

  // The current turn's tool-activity strip (above the reply bubble), created on first use.
  // katashiro.show_image: decode first (a non-image rejects, so the tool reports it), then show it
  // inside the in-flight turn — between the tool strip and the reply bubble — or, between turns,
  // as a standalone message from this agent. Memory-only like pasted images; history gets a marker.
  async showImage({ dataUrl, caption }, st = this.cur) {
    if (!st) throw Object.assign(new Error("this conversation was closed in Katashiro"), { code: "cap" });
    // Memory cap (#60): shown images live in the DOM as data: URLs (≤ 5 MB each, ×4/3 as base64).
    if (st.turnActive && st.stream && (st.stream.imageCount || 0) >= SHOW_IMAGE_PER_TURN) {
      throw Object.assign(new Error(`at most ${SHOW_IMAGE_PER_TURN} images per reply`), { code: "cap" });
    }
    if (shownImageChars + dataUrl.length > SHOW_IMAGE_SESSION_CHARS) {
      throw Object.assign(new Error("this panel already holds ~50 MB of shown images; ask the user to reload the panel"), { code: "cap" });
    }
    let src = dataUrl;                                   // a data: URL browser-mcp.js built from validated base64
    let im = new Image();
    im.src = src;
    await im.decode();
    // SVG: rasterize to PNG (2×) through a canvas. As an <img> an SVG is sandboxed (no script, no
    // fetches), but "open full size" would load it as a DOCUMENT; a PNG never runs anything. If the
    // canvas is tainted (Chrome may refuse foreignObject SVGs, e.g. mermaid labels), keep the SVG in
    // an <img> and enlarge it inside the panel instead of opening it as a page.
    let svgOnly = false;
    if (/^data:image\/svg\+xml[;,]/i.test(src)) {
      try {
        src = svgToPng(im);
        im = new Image();
        im.src = src;
        await im.decode();
      } catch (_) {
        svgOnly = true;
      }
    }
    im.className = "bubble-image agent-image";
    im.alt = caption || "image";
    im.addEventListener("click", () => (svgOnly ? openLightbox(src, caption) : openImageTab(src)));
    const fig = document.createElement("figure");
    fig.className = "agent-figure";
    fig.appendChild(im);
    if (caption) {
      const cap = document.createElement("figcaption");
      cap.textContent = caption;                         // textContent: agent-supplied text
      fig.appendChild(cap);
    }
    if (st.turnActive) {
      if (!st.stream || !st.stream.bubble) this.startStream(st);
      const s = st.stream;
      s.contentEl.insertBefore(fig, s.bubble);
      s.imageCount = (s.imageCount || 0) + 1;
      this.inState(st, maybeScroll);
    } else if (this.states.get(st.convId) === st) {
      // Between turns: its own message (so history keeps the "image not saved" marker), rendered
      // like the in-turn figure (#60): click to open, caption as text — not markdown.
      this.inState(st, () => {
        appendMessage({ senderId: this.id, senderName: this.name, text: "", images: [src], historyCaption: caption });
        const row = outList().lastElementChild;
        const placed = row && row.querySelector(".bubble-image");
        if (placed) placed.replaceWith(fig);
      });
    }
    shownImageChars += src.length;
    return { width: im.naturalWidth, height: im.naturalHeight };
  }

  // katashiro.ask_user (ADR docs/adr/ask-user.md): validate, show the card in this turn and return
  // its id at once; the answer reaches this agent later as a new prompt (askCard). Throws an Error
  // the tool reports to the agent. Asked after this agent's turn ended (the user stopped it): no
  // card, same rule as the confirm card (ConfirmCore.shouldAsk via AskCore.canAsk).
  askUser(args, st = this.cur) {
    const can = AskCore.canAsk({ turnActive: !!(st && st.turnActive), pending: st ? pendingAsksOf(this, st.convId) : 0 });
    if (can.reason === "turn") {
      this.inState(st, () => appendSystemMessage(`${this.name} 的回合已結束，它的提問沒有顯示。`));
      throw Object.assign(new Error("your turn had ended (the user stopped it) before the question could be shown; ask in your next reply instead"), { code: "turn" });
    }
    if (can.reason === "cap") {
      throw Object.assign(new Error(`${AskCore.PENDING_MAX} of your questions are already open; wait for an answer (or for them to time out) before asking another`), { code: "cap" });
    }
    const n = AskCore.normalizeSpec(args);
    if (!n.ok) throw Object.assign(new Error(n.error), { code: "invalid" });
    return { id: askCard(n.spec, this, st) };
  }

  // katashiro.canvas_open saved a canvas: put its card in this turn (or, between turns, as its own
  // row), and open a NEW canvas in a background tab of the canvas group (§3.1). An update needs no
  // tab work: an open canvas tab re-renders itself from storage.onChanged. beside:"current" also
  // shows it in Split View next to the user's page. Returns a short note for the tool result.
  async onCanvasWrite({ id, version, created, title }, { beside = null } = {}, st = this.cur) {
    const conv = st ? st.convId : conversationId;
    const card = canvasCard({ id, version, title, conv });
    if (st && st.turnActive) {
      if (!st.stream || !st.stream.bubble) this.startStream(st);
      st.stream.contentEl.insertBefore(card, st.stream.bubble);
      this.inState(st, maybeScroll);
    } else {
      this.inState(st, () => {
        const row = document.createElement("div");
        row.className = "message system";
        row.appendChild(card);
        outList().appendChild(row);
        maybeScroll();
      });
    }
    canvasTabQueue(sweepCanvasRestores, conv).catch(() => {});
    if (beside === "current") {
      // Shown to the user (Split View, or in front): the conversation's working tab (multi-conversation
      // §4.3). A plain new canvas opens in the background and does not count.
      const note = await showCanvasBeside(id, created, conv);
      const tab = await findCanvasTab(id).catch(() => null);
      return tab && (tab.active || CanvasTabs.inSplit(tab)) ? { note, tabId: tab.id } : note;
    }
    if (!created) return (await findCanvasTab(id)) ? "its open tab updated" : "";
    await openCanvasTab(id, { active: false, conv });
    return "opened in a background tab";
  }

  ensureToolStrip(st) {
    if (!st.stream || !st.stream.bubble) this.startStream(st);
    const s = st.stream;
    if (!s.toolStrip) {
      s.toolStrip = document.createElement("div");
      s.toolStrip.className = "tool-activity";
      s.contentEl.insertBefore(s.toolStrip, s.bubble);     // above the reply bubble
      s.toolPills = {};
      s.agentToolPills = new Map();                      // toolCallId → { el, info }
    }
    return s;
  }

  // The agent's OWN tool calls (Bash, Edit, …), forwarded by the gateway as ACP `tool_call` /
  // `tool_call_update`. One pill per toolCallId: the first event usually carries a placeholder
  // title ("Terminal") that a later update refines ("cargo test"), so updates rewrite the same
  // pill. Titles arrive already masked by the gateway; here they are only truncated for layout.
  renderAgentToolCall(update, st) {
    if (!st || !st.turnActive) return;                   // only annotate an in-flight agent turn
    const known = st.stream && st.stream.agentToolPills;
    const prev = (known && update && known.get(update.toolCallId)) || null;
    if (prev && AgentTools.isBrowserToolCall(update)) {
      // A placeholder title refined into a katashiro tool name: the browser pill covers it.
      prev.el.remove();
      known.delete(update.toolCallId);
      if (st.skippedToolCalls) st.skippedToolCalls.add(update.toolCallId);
      return;
    }
    const next = AgentTools.applyToolCallUpdate(prev && prev.info, update, st.skippedToolCalls);
    if (!next) return;                                   // not ours / unknown id with nothing to show
    const s = this.ensureToolStrip(st);
    let entry = s.agentToolPills.get(next.id);
    if (!entry) {
      entry = { el: document.createElement("span"), info: null };
      s.toolStrip.appendChild(entry.el);
      s.agentToolPills.set(next.id, entry);
    }
    entry.info = next;
    entry.el.className = `tool-pill agent-tool ${next.state}`;
    entry.el.textContent = `${next.label} ${next.icon}`;
    entry.el.title = next.title;                         // property, not markup
    this.inState(st, maybeScroll);
  }

  appendToStream(chunk, st) {
    if (!chunk || !st) return;                           // keep dots until real text arrives
    if (!st.stream || !st.stream.bubble) this.startStream(st);
    if (st.stream.text === "") st.stream.bubble.classList.remove("typing");
    st.stream.text += chunk;
    st.stream.bubble.textContent = st.stream.text;       // textContent: no HTML injection
    this.inState(st, maybeScroll);
  }

  // Ends a turn's bubble, rendering into ITS conversation (P2: on screen or not).
  finalizeStream(stopReason, st = this.cur) {
    this.inState(st, () => this.finalizeStreamHere(stopReason, st));
  }

  finalizeStreamHere(stopReason, st) {
    const s = st ? st.stream : null;
    if (st) st.stream = null; // reset first: a render throw must not orphan stream state onto the next turn
    // A confirm card still waiting in this turn declines: the turn ended (stop, timeout, error,
    // disconnect), so a late "yes" must not act for an agent that can no longer hear it (#80).
    if (s && s.confirms) for (const d of [...s.confirms]) d.end();
    if (!s || !s.bubble) return;
    settleRunningPills(s);
    const cancelled = stopReason === "cancelled";
    if (s.text === "") {
      // Drop a bubble the turn never wrote into (e.g. a mid-turn disconnect). If the user stopped
      // it before any text arrived, say so rather than vanishing silently.
      // Exception: a turn that ran browser tools but emitted no text is a legitimate pure-action
      // turn — keep the row (and its tool-activity strip) so the user still sees what happened;
      // only the empty typing bubble is dropped.
      // A confirm card asked in the turn keeps the row too: its outcome stays readable (#80).
      // So does an ask_user card: it outlives the turn by design (ADR ask-user §2.4).
      if ((s.toolStrip && s.toolStrip.childElementCount > 0) || s.imageCount || (s.confirms && s.contentEl.querySelector(".confirm-card")) ||
          (s.asked && s.contentEl.querySelector(".ask-card"))) {
        s.bubble.remove();
        if (s.imageCount) recordMessage({ kind: "received", senderId: this.id, senderName: this.name, text: Composer.historyText("", s.imageCount), timestamp: Date.now() });
        if (cancelled) appendSystemMessage(`⏹ 已停止 ${this.name}`);
        maybeScroll();
        return;
      }
      const row = s.bubble.closest(".message");
      if (row) row.remove();
      if (cancelled) appendSystemMessage(`⏹ 已停止 ${this.name}`);
      return;
    }
    // Render the accumulated markdown once, now that the turn is complete (ADR §3.3): streaming
    // stayed plain textContent; markdown is parsed+sanitized only here. A stream that stops/errors
    // still reaches finalize, so the message renders (not left as raw md).
    // A reply with "↩ <time>" markers becomes one message per part — the first part fills this
    // turn's bubble, each later part is its own row — every part quoting (clickable) the message it
    // answers, with its own id, ↩ button and history record, so a reload replays them split too.
    const doneAt = uniqueMsgMs(Date.now());
    const split = RoomCore.replyParts(s.text);
    const first = split[0];
    const firstReply = first.replyTo ? replyTargetFor(first.replyTo) : null;
    renderMarkdownInto(s.bubble, first.text);
    if (firstReply && s.contentEl) s.contentEl.insertBefore(replyQuoteEl(firstReply), s.bubble);
    const row = s.bubble.closest(".message");
    // The row showed the time streaming STARTED; the id, quotes and chat_history use doneAt (#62).
    const tsEl = s.contentEl && s.contentEl.querySelector(":scope > .timestamp");
    if (tsEl) tsEl.textContent = formatTime(doneAt);
    const firstId = RoomCore.messageId(st.convId, doneAt);
    if (row && s.contentEl) {
      row.dataset.msgId = firstId;
      attachReplyButton(s.contentEl, { id: firstId, senderName: this.name, timestamp: doneAt, text: first.text });
    }
    recordMessage({
      kind: "received", id: firstId, senderId: this.id, senderName: this.name,
      text: Composer.historyText(first.text, s.imageCount || 0), timestamp: doneAt,
      replyTo: firstReply ? recordReplyTo(firstReply) : undefined,
    });
    split.slice(1).forEach((p, i) => {
      appendMessage({
        senderId: this.id, senderName: this.name, text: p.text, timestamp: uniqueMsgMs(doneAt + i + 1),   // distinct ids
        replyTo: p.replyTo ? replyTargetFor(p.replyTo) : null,
      });
    });
    if (cancelled) appendSystemMessage(`⏹ 已停止 ${this.name}`); // note the stop after the partial reply
    maybeScroll();
  }
}

// A turn that ends (cancel, disconnect, error, or a completion we never received) leaves no pill
// spinning: anything still ⏳ becomes a neutral ⏹ — not ✓/✗, since we never learned the outcome.
function settleRunningPills(s) {
  if (!s.toolStrip) return;
  for (const pill of s.toolStrip.querySelectorAll(".tool-pill.running")) {
    pill.classList.replace("running", "stopped");
    pill.textContent = pill.textContent.replace(/⏳$/, AgentTools.ICON_OF.stopped);
  }
}

// --- Room lifecycle ----------------------------------------------------------
function buildRoom() {
  room.forEach((c) => c.disconnect());
  room.length = 0;
  agents.forEach((a) => {
    // Each conversation's saved session id seeds its state on first use (Conn.stateFor), so the
    // first handshake resumes (not session/new).
    const c = new Conn(a);
    // Single-active (ADR single-active-agent): a dormant agent stays enabled:false so it renders
    // 已停用 rather than "連線中…"; only the active one is connected by connectAll.
    c.enabled = (a.url === activeAgentUrl);
    room.push(c);
  });
}

function connectAll() {
  room.forEach((c) => { if (c.agent.url === activeAgentUrl) c.connect(); });
}

// Switch the single active agent: disconnect the current one, connect the chosen one, persist.
function setActiveAgent(url) {
  if (!url || url === activeAgentUrl || !agents.some((a) => a.url === url)) return;
  activeAgentUrl = url;
  persist();
  room.forEach((c) => {
    if (c.agent.url === url) c.connect();   // connect() flips enabled=true + handshakes
    else c.disconnect();                    // disconnect() flips enabled=false → 已停用
  });
  updateRoster();
  if (settingsView && settingsView.classList.contains("active")) renderAgentList();
}

// Replace a single conn in place (retarget on url/token change).
function reconnectConn(i) {
  if (i < 0 || i >= room.length) return;
  if (room[i]) room[i].disconnect();
  room[i] = new Conn(agents[i]);
  // Single-active: only re-connect if this is the active agent; editing a dormant agent's url/token
  // must not bring a second connection up.
  if (agents[i].url === activeAgentUrl) room[i].connect();
  else room[i].enabled = false;
}

// --- DOM refs ----------------------------------------------------------------
const messagesList = document.getElementById("messages-list");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const jumpLatestBtn = document.getElementById("jump-latest");
const statusIndicator = document.querySelector(".status-indicator");
const settingsBtn = document.getElementById("settings-btn");
const clearChatBtn = document.getElementById("clear-chat-btn");
const connectBtn = document.getElementById("connect-btn");
const wsUrlInput = document.getElementById("ws-url-input");
const setupNameInput = document.getElementById("setup-name-input");
const rosterEl = document.getElementById("roster");
const activeAgentLabel = document.getElementById("active-agent-label");
const buildBadgeEl = document.getElementById("build-badge");

const setupView = document.getElementById("setup-view");
const chatView = document.getElementById("chat-view");
const settingsView = document.getElementById("settings-view");

const agentListEl = document.getElementById("agent-list");
const newAgentName = document.getElementById("new-agent-name");
const newAgentUrl = document.getElementById("new-agent-url");
const newAgentToken = document.getElementById("new-agent-token");
const addAgentBtn = document.getElementById("add-agent-btn");
const cancelSettingsBtn = document.getElementById("cancel-settings-btn");

const modeMentionBtn = document.getElementById("mode-mention");
const modeAmbientBtn = document.getElementById("mode-ambient");
const modeHintEl = document.getElementById("mode-hint");
const loopGuardCapInput = document.getElementById("loopguard-cap");
const jevTokenInput = document.getElementById("jev-token-input");

const actReadBtn = document.getElementById("act-read");
const actWriteBtn = document.getElementById("act-write");
const actModeHintEl = document.getElementById("act-mode-hint");


// Build identity on the connection screen (ADR build-provenance-and-version-display): the manifest
// version always, plus a short sha/tag from build-info.json when present — release builds stamp it,
// unpacked dev shows "dev". Lets you confirm which build actually loaded after an Update + reopen.
async function loadBuildInfo() {
  if (!buildBadgeEl) return;
  const { version, detail } = await BUILD_INFO;
  buildBadgeEl.textContent = `v${version} · ${detail}`;
  buildBadgeEl.title = `Katashiro v${version}（build: ${detail}）`;
}
loadBuildInfo();

// Settings → 重新載入 Katashiro: chrome.runtime.reload() re-reads an unpacked extension from disk,
// exactly like chrome://extensions' reload button. It closes the side panel in EVERY window; each
// window's scrollback and resumable ACP session ids (storage.local) and synced settings survive.
// Confirmed with confirm(), like 清除聊天. In-flight turns get session/cancel first, with a short
// delay so the notification leaves before the page dies (pagehide's cancel is best effort).
const reloadExtensionBtn = document.getElementById("reload-extension-btn");
const RELOAD_CANCEL_GRACE_MS = 150;
if (reloadExtensionBtn) {
  reloadExtensionBtn.addEventListener("click", () => {
    const busy = room.some((c) => c.turnActive);
    const msg = "重新載入 Katashiro？\n\n所有視窗的側邊欄都會關掉，重新打開即可（對話紀錄、ACP session 和設定都會保留）。" +
      (busy ? "\n\nagent 正在回覆，會被中斷。" : "");
    if (!confirm(msg)) return;
    room.forEach((c) => c.cancelTurn());             // no-op unless a turn is in flight on an open socket
    setTimeout(() => chrome.runtime.reload(), busy ? RELOAD_CANCEL_GRACE_MS : 0);
  });
}

// Periodic re-render so purely time-based states stay current with no triggering event — chiefly
// the tunnel segment aging from 活躍 back to 閒置 TUNNEL_FRESH_MS after the last mcp/message (§8.3).
setInterval(() => updateRoster(), ROSTER_REFRESH_MS);

// --- Config storage: chrome.storage.sync (follows the Google account) --------
// Config — agents, tokens, room config, active agent, Jev key — lives in storage.sync so it syncs
// across devices signed into the same Chrome profile (with Chrome sync + Extensions enabled).
// It does NOT survive removing the extension: on uninstall Chrome clears the extension's sync
// storage and sends a DELETE for every synced key to the server (Chromium
// SyncStorageBackend::DeleteStorage → SyncableSettingsStorage::Clear → ACTION_DELETE). Upgrade an
// unpacked install with chrome://extensions ↻ reload, which keeps storage — never remove + re-add.
// Session ids + scrollback stay in storage.local (per-window, never synced).
// NOTE: agent URLs/tokens sync across devices too, so a device-specific endpoint (e.g.
// ws://localhost) may need adjusting on another machine.
const CONFIG_KEYS = ["agents", "wsUrl", "roomConfig", "actMode", "activeAgentUrl", "jevToken", "screenshotConfig", "attachConfig"];
function pickConfig(o) {
  const out = {};
  for (const k of CONFIG_KEYS) if (k in o) out[k] = o[k];
  return out;
}
// Read config from sync; one-time migrate a pre-sync storage.local config up if sync is still empty.
function loadConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(CONFIG_KEYS, (synced) => {
      const hasSynced = (Array.isArray(synced.agents) && synced.agents.length) || synced.wsUrl;
      if (hasSynced) return resolve(synced);
      chrome.storage.local.get(CONFIG_KEYS, (local) => {
        const hasLocal = (Array.isArray(local.agents) && local.agents.length) || local.wsUrl;
        if (hasLocal) chrome.storage.sync.set(pickConfig(local)); // migrate up (local left as fallback)
        resolve(hasLocal ? local : synced);
      });
    });
  });
}

// True while the in-memory config is the built-in default because storage had nothing yet (e.g.
// the Google-synced copy hadn't downloaded after a reinstall). Cleared once a real config lands.
let runningOnDefaults = false;
// Set by the first local config write (any user edit). A local edit always beats a late sync.
let userEdited = false;
// Config-sync badge inputs: did the last storage.sync write fail (fell back to local), and when did
// the last successful one land.
let syncWriteFailed = false;
let lastSyncWriteAt = null;
// How long to show ⏳ while waiting for a synced config before concluding none exists (📭).
const SYNC_WAIT_MS = 20000;
let syncWaitExpired = false;

// Paint the header config-sync badge. chrome.storage.sync gives no "uploaded to Google" signal, so
// the tooltip is explicit that ☁️ means "in Chrome's sync storage", and cloud delivery depends on
// Chrome sync being signed in with Extensions enabled (verify at chrome://sync-internals).
function renderSyncBadge() {
  const el = document.getElementById("sync-badge");
  if (!el) return;
  const state = RoomCore.configSyncState({
    writeFailed: syncWriteFailed, runningOnDefaults, waitExpired: syncWaitExpired,
  });
  el.hidden = false;
  el.classList.remove("synced", "waiting", "empty", "local");
  el.classList.add(state);
  if (state === "local") {
    el.textContent = "⚠️";
    el.title = "設定同步寫入失敗（可能超過 Chrome 同步容量），目前只存在這台機器 —— 重裝會遺失。";
    return;
  }
  if (state === "empty") {
    el.textContent = "📭";
    el.title = "雲端沒有找到 katashiro 的設定。第一次使用：直接設定，之後就會開始同步。" +
      "若是移除後重裝：移除 extension 時 Chrome 會一併刪除它的同步資料（設計如此），無法還原 —— " +
      "之後升級請用 chrome://extensions 的 ↻ 重新載入，不要移除。";
    return;
  }
  if (state === "waiting") {
    el.textContent = "⏳";
    el.title = "尚無已儲存的設定，目前用預設值。正在確認 Google 帳號是否有已同步的設定" +
      "（例如在新裝置第一次載入），有的話幾秒內會自動套用。";
    return;
  }
  el.textContent = "☁️";
  const when = lastSyncWriteAt
    ? new Date(lastSyncWriteAt).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" })
    : "本次啟動未寫入";
  chrome.storage.sync.getBytesInUse(null, (bytes) => {
    el.title = `設定已存進 Chrome 同步儲存（${bytes} bytes，上次寫入：${when}）。` +
      "是否已上傳到 Google 取決於 Chrome 同步設定（需登入並開啟「擴充功能」）—— 要確認請看 chrome://sync-internals。";
  });
}

// Load a stored (or empty → default) config object into the live state.
function applyConfig(r) {
  if (Array.isArray(r.agents) && r.agents.length) {
    agents = r.agents;
  } else if (r.wsUrl) {
    agents = [{ name: "OpenAB", url: r.wsUrl }];
  } else {
    agents = [{ ...DEFAULT_AGENT }];
  }
  activeAgentUrl = RoomCore.resolveActiveUrl(agents, r.activeAgentUrl); // single-active
  roomConfig = RoomCore.normalizeRoomConfig(r.roomConfig);
  loopGuard = RoomCore.createLoopGuard(roomConfig.loopGuardCap);
  // Strict true: anything stored malformed (or absent) reads as read-only. The safe state
  // is the one you fall back into.
  actMode = r.actMode === true;
  jevToken = (r.jevToken || "").trim();
  screenshotConfig = BrowserMcp.normalizeScreenshotConfig(r.screenshotConfig);
  attachConfig = Composer.normalizeAttachConfig(r.attachConfig);
}

// --- Startup -----------------------------------------------------------------
loadConfig().then(async (r) => {
    applyConfig(r);
    runningOnDefaults = !RoomCore.hasStoredConfig(r);
    // Never write the defaults back on startup: on a fresh install sync can still be empty only
    // because the Google copy hasn't arrived yet, and writing defaults would overwrite it
    // (last-write-wins). A real stored config is safe to re-save (normalizes the legacy wsUrl).
    if (RoomCore.shouldPersistOnStartup(r)) persist();
    // On defaults: give the synced copy a window to arrive, then stop pulsing and say plainly that
    // nothing synced exists (a late arrival still flips it to ☁️ via the onChanged listener).
    if (runningOnDefaults) {
      setTimeout(() => { syncWaitExpired = true; renderSyncBadge(); }, SYNC_WAIT_MS);
    }
    renderSyncBadge();

    switchView("chat");
    // Conversations (migration, this window's open set and locks) BEFORE building/connecting, so
    // each conn resumes the current conversation's saved session.
    try { await loadConversations(); } catch (e) { console.error("katashiro: loading conversations failed:", e); }
    // Folder mirror catch-up (§3.6): canvases saved while the folder was not connected.
    canvasMirror.syncAll().catch(() => {});
    buildRoom();
    connectAll();
    updateRoster();
    markPanelReady();
    pickUpReopenRequest();
  }
);

// katashiro.notify toasts: a click brings this panel's window forward. Every open panel hears every
// click, so each claims only the ids tagged with its own window.
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    if (panelWindowId == null || id.indexOf(`${BrowserMcp.NOTIFY_ID_PREFIX}${panelWindowId}:`) !== 0) return;
    if (typeof panelWindowId === "number") chrome.windows.update(panelWindowId, { focused: true });
    chrome.notifications.clear(id);
    // Q12 (multi-conversation §4.7): a card waiting in another conversation → switch to it.
    const m = id.slice(`${BrowserMcp.NOTIFY_ID_PREFIX}${panelWindowId}:`.length).match(/^conv:(c_[0-9a-f]{12}):/);
    if (m && convs.has(m[1])) switchConversation(m[1]);
  });
}

// The synced config can land a few seconds after startup (reinstall, new device). While we are
// still on defaults and the user hasn't touched anything, adopt it and reconnect — so the panel
// recovers without a reopen. Once the user edits locally, their edit wins over the late arrival.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !CONFIG_KEYS.some((k) => k in changes)) return;
  chrome.storage.sync.get(CONFIG_KEYS, (remote) => {
    if (!RoomCore.shouldAdoptRemoteConfig({ runningOnDefaults, userEdited, remote })) return;
    runningOnDefaults = false;
    applyConfig(remote);
    buildRoom();
    connectAll();
    updateRoster();
    if (settingsView && settingsView.classList.contains("active")) {
      renderRoomConfig();
      renderActMode();
      renderAgentList();
      if (jevTokenInput) jevTokenInput.value = jevToken;
      renderScreenshotConfig();
      renderAttachConfig();
    }
    renderSyncBadge();
    appendSystemMessage("已從 Google 帳號同步還原設定。");
  });
});

function persist() {
  userEdited = true;
  runningOnDefaults = false;           // whatever is in memory now is intentional, not a placeholder
  const cfg = { agents, roomConfig, actMode, activeAgentUrl, jevToken, screenshotConfig, attachConfig };
  chrome.storage.sync.set(cfg, () => {
    if (chrome.runtime.lastError) {
      // Sync quota exceeded (many agents / long tokens) — keep a local copy so nothing is lost.
      chrome.storage.local.set(cfg);
      console.warn("katashiro: config sync failed, kept local copy:", chrome.runtime.lastError.message);
      syncWriteFailed = true;
    } else {
      syncWriteFailed = false;
      lastSyncWriteAt = Date.now();
    }
    renderSyncBadge();
  });
}

// --- Conversations (ADR docs/adr/multi-conversation.md, MVP §3) ----------------
// The side panel is a plain extension page: closing it tears down the DOM, losing the scrollback.
// So each conversation persists in chrome.storage.local: conv:<id> = { id, sessions: { <agentUrl>:
// acpSessionId }, messages (≤ 200), savedAt }, its title and times in conv:index, and the
// conversations a window has open (tab order + current) in window:<windowId>. Reopening the panel
// restores them and resumes the same sessions (the "已續接 …" path). storage.local (not
// storage.session) so the scrollback also survives an extension reload / update — that is what lets
// a restarted agent recover the conversation via `chat_history`. It IS written to disk (the Chrome
// profile), never synced. Two rules hold it together:
//  - one window per conversation: the panel holds the Web Lock conv:<id> for every conversation in
//    its open list (§3.6); closing the panel or the window releases them, no heartbeat;
//  - at most 3 open across all LIVE windows (§3.3, Q4: the broker pool of 3 is global), counted and
//    changed under the conv:windows lock (which replaces #56's history:adopt).
// The decisions are in conv-core.js (unit-tested); this file does the DOM, the locks and the calls.
const HISTORY_CAP = 200;
// getAll() lists only normal + popup windows by default, so ask for every type — a panel in an
// app/devtools window would otherwise treat its own record as orphaned (#56).
const ALL_WINDOW_TYPES = ["normal", "popup", "panel", "app", "devtools"];
let panelWindowId = null;                 // the window this panel lives in (set by loadConversations)
const convs = new Map();                  // id → open conversation { id, messages, sessions, listEl, … }
let convIndex = {};                       // conv:index as last read (+ this panel's unsaved times)
let windowRec = { open: [], current: null };   // this window's record (this panel is its only writer)
let currentConv = null;                   // the conversation on screen (null: none, §3.3 picker)
// The current conversation's stable id — message ids are `<conversationId>:<ms timestamp>`
// (RoomCore.messageId), the reference a reply points at. Minted once per conversation.
let conversationId = null;
let historyMessages = [];                 // the current conversation's records (its `messages`)
let restoring = false;                    // true while replaying — suppresses re-recording
const convLockReleases = new Map();       // id → release() of the conv:<id> Web Lock this panel holds
let markPanelReady;
const panelReady = new Promise((r) => { markPanelReady = r; });

async function liveWindowIds() {
  let ids = new Set();
  try { ids = new Set((await chrome.windows.getAll({ windowTypes: ALL_WINDOW_TYPES })).map((w) => String(w.id))); } catch (_) { /* none known */ }
  if (panelWindowId != null) ids.add(String(panelWindowId));   // this panel's own window is live
  return ids;
}
const convStore = ConvCore.createConvStore({
  storage: chrome.storage.local,
  lock: (name, fn) => navigator.locks.request(name, fn),
  liveWindowIds,
  randomUUID: () => crypto.randomUUID(),
  // §7.1: only for finishing a delete a gallery tab left half done (finishDeletions on load).
  lockIfAvailable: (name, fn) => navigator.locks.request(name, { ifAvailable: true }, fn),
  get canvases() { return ConvCore.canvasOps(canvasStore); },       // read at call time: canvasStore is declared further down
  sessionStorage: chrome.storage.session,
});
const withWindowsLock = (fn) => navigator.locks.request(ConvCore.LOCK_WINDOWS, fn);
const newConversationId = () => ConvCore.mintId(() => crypto.randomUUID());
const freshIndexEntry = () => ({ title: null, titleSource: null, createdAt: Date.now(), lastMessageAt: null, archivedAt: null });

function currentWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getCurrent((w) => resolve({ id: w && w.id != null ? w.id : "default" }));
    } catch { resolve({ id: "default" }); }
  });
}

function makeConv(id, data) {
  const d = data && typeof data === "object" ? data : {};
  return {
    id,
    messages: Array.isArray(d.messages) ? d.messages.slice(-HISTORY_CAP) : [],
    sessions: d.sessions && typeof d.sessions === "object" ? { ...d.sessions } : {},
    // P1b (ADR §4.3, §4.4): the last tab its agent acted on, and the URLs of its tab group's tabs.
    workingTab: d.workingTab && typeof d.workingTab === "object" && typeof d.workingTab.url === "string" ? { ...d.workingTab } : null,
    groupTabs: Array.isArray(d.groupTabs) ? d.groupTabs.filter((u) => typeof u === "string") : [],
    draft: null,                          // §4.8: the composer's text + staged attachments while not current (memory only)
    listEl: null,                         // its message list, built the first time it is shown (§3.5)
    unread: false,                        // P2 §5: ● — something arrived while it was not on screen
    scrollTop: 0, stick: true,            // scroll position while hidden
    indexTimeAt: 0, indexTimeValue: 0,    // the last lastMessageAt written to conv:index, and when
  };
}

// The Web Lock conv:<id>, held until released on archive (§3.6). ifAvailable: never waits.
function holdConvLock(id) {
  if (convLockReleases.has(id)) return Promise.resolve(true);
  return new Promise((resolve) => {
    navigator.locks.request(`conv:${id}`, { ifAvailable: true }, (lock) => {
      if (!lock) { resolve(false); return undefined; }
      return new Promise((release) => { convLockReleases.set(id, release); resolve(true); });
    }).catch(() => resolve(false));
  });
}
function releaseConvLock(id) {
  const release = convLockReleases.get(id);
  convLockReleases.delete(id);
  if (release) release();
}

function writeWindowRec() {
  if (panelWindowId == null) return Promise.resolve();
  return chrome.storage.local.set({ [ConvCore.windowKey(panelWindowId)]: { open: windowRec.open, current: windowRec.current, savedAt: Date.now() } })
    .catch(() => { /* quota — the record is rewritten on the next change */ });
}

// Persist a conversation's messages and its agents' resumable session ids.
function saveConv(conv = currentConv) {
  if (!conv || !convs.has(conv.id)) return Promise.resolve();
  room.forEach((c) => {
    const st = c.states.get(conv.id);
    if (!st) return;
    if (st.acpSessionId) conv.sessions[c.agent.url] = st.acpSessionId;
    else delete conv.sessions[c.agent.url];
  });
  return chrome.storage.local.set({ [ConvCore.convKey(conv.id)]: { id: conv.id, sessions: conv.sessions, messages: conv.messages, workingTab: conv.workingTab, groupTabs: conv.groupTabs, savedAt: Date.now() } })
    .catch(() => { /* quota — the on-screen chat is unaffected */ });
}

// Read-modify-write one index entry under conv:index; `patch(entry)` returns the fields to change.
function patchIndex(id, patch) {
  return convStore.updateIndex((idx) => {
    const e = idx[id] || freshIndexEntry();
    idx[id] = { ...e, ...patch(e) };
    return idx;
  }).catch(() => {});
}

// lastMessageAt (Q1: any message, the agent's included): on screen at once, in conv:index at most
// every 5 s per conversation, and always on switch, archive and panel hide (§3.2).
function noteActivity(conv, ts) {
  if (!conv || !Number.isFinite(ts)) return;
  const e = convIndex[conv.id] || freshIndexEntry();
  if ((e.lastMessageAt || 0) >= ts) return;
  convIndex[conv.id] = { ...e, lastMessageAt: ts };
  renderConvTabs();
  if (ConvCore.shouldWriteIndexTime(conv.indexTimeAt, Date.now())) writeIndexTime(conv);
}
function writeIndexTime(conv) {
  if (!conv) return Promise.resolve();
  const at = (convIndex[conv.id] || {}).lastMessageAt || 0;
  if (at <= conv.indexTimeValue) return Promise.resolve();
  conv.indexTimeAt = Date.now();
  conv.indexTimeValue = at;
  return patchIndex(conv.id, (e) => ({ lastMessageAt: Math.max(e.lastMessageAt || 0, at) }));
}

// §3.3: the first user message names a conversation that has no title (a user name never changes).
function maybeAutoTitle(conv, text) {
  if (!conv) return;
  const next = ConvCore.titleAfterUserMessage(convIndex[conv.id] || freshIndexEntry(), text);
  if (!next) return;
  convIndex[conv.id] = next;
  patchIndex(conv.id, (e) => (e.titleSource === "user" || (e.title && (e.titleSource === "auto" || e.titleSource === "agent")) ? {} : { title: next.title, titleSource: "auto" }));
  renderConvTabs();
  updateCanvasGroupTitle(conv.id);
}

// Append a record to the current conversation's persisted scrollback (skipped while restoring).
// System/status notices are deliberately NOT recorded — they are regenerated on each (re)connect.
function recordMessage(rec) {
  const conv = targetConv();                             // P2: a background turn records into its own
  if (restoring || !conv) return;
  conv.messages.push(rec);
  if (conv.messages.length > HISTORY_CAP) conv.messages.splice(0, conv.messages.length - HISTORY_CAP);
  if (conv !== currentConv && !conv.unread) { conv.unread = true; renderConvTabs(); }   // P2 §5: ● until it is shown
  saveConv(conv);
  noteActivity(conv, rec.timestamp);
}

function replayMessage(rec) {
  if (rec.kind === "error") appendErrorMessage(rec.senderName, rec.text, null); // no retry on restore
  else appendMessage({ senderId: rec.senderId, senderName: rec.senderName, text: rec.text, timestamp: rec.timestamp, replyTo: rec.replyTo || null });
}

// Other panels write conv:index too (titles, archive, reopen): follow it, keeping this panel's own
// newer times that are not written yet (§3.2 throttle).
function adoptIndex(stored) {
  const next = { ...(stored || {}) };
  for (const id of convs.keys()) {
    const mine = convIndex[id];
    if (!mine) continue;
    if (!next[id]) next[id] = mine;
    else if ((mine.lastMessageAt || 0) > (next[id].lastMessageAt || 0)) next[id] = { ...next[id], lastMessageAt: mine.lastMessageAt };
  }
  convIndex = next;
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ConvCore.INDEX_KEY]) return;
  adoptIndex(changes[ConvCore.INDEX_KEY].newValue);
  renderConvTabs();
});

// Load this window's conversations (§3.2, §3.6, §3.7). Runs BEFORE the room is built so each conn
// seeds the sessions from conv:<id> (→ session/resume restores the same conversation) and the
// restored messages sit above the reconnect notices.
async function loadConversations() {
  const win = await currentWindow();
  panelWindowId = win.id;
  // §3.2: AWAIT the migration (never ifAvailable), so a panel never builds from a half-migrated state.
  try { await convStore.migrate(); } catch (e) { console.warn("katashiro: conversation migration failed (retried on the next load):", e); }
  // §7.1: a delete cut short (gallery tab closed, browser quit) is finished here. Not awaited: its
  // conversation is in no window record any more, so nothing below depends on it.
  convStore.finishDeletions().catch((e) => console.warn("katashiro: finishing a conversation delete failed (retried on the next load):", e));
  const wid = String(win.id);
  const out = await withWindowsLock(async () => {
    const [windows, index, live] = await Promise.all([convStore.readWindows(), convStore.readIndex(), liveWindowIds()]);
    const own = windows[wid];
    // §3.7: a window with no record adopts the most recently used orphan record (browser restart);
    // old orphan records are pruned and their conversations archived.
    const plan = ConvCore.planAdoption({ ownWindowId: wid, windows, liveIds: live, index, now: Date.now() });
    const wanted = own
      ? { open: (Array.isArray(own.open) ? own.open : []).filter(ConvCore.isConvId), current: own.current }
      : { open: plan.take, current: plan.current };
    // §3.6: drop every id whose lock another window took while this panel was closed.
    const open = [];
    const elsewhere = [];
    for (const id of wanted.open) ((await holdConvLock(id)) ? open : elsewhere).push(id);
    let current = open.includes(wanted.current) ? wanted.current : (open[0] || null);
    let full = false;
    if (!open.length) {
      windows[wid] = { open: [] };
      // Nothing to open: a new conversation — unless 3 are open elsewhere (§3.3: the picker).
      if (ConvCore.liveOpenIds(windows, live).size >= ConvCore.MAX_OPEN) full = true;
      else {
        const id = newConversationId();
        if (await holdConvLock(id)) {
          await convStore.updateIndex((idx) => { idx[id] = freshIndexEntry(); return idx; });
          open.push(id);
          current = id;
        }
      }
    }
    // Write this window's record BEFORE dropping the adopted one: closing the panel in between
    // must leave the conversations in a record, not in none.
    windowRec = { open, current };
    await writeWindowRec();
    if (plan.archive.length) await convStore.archiveIds(plan.archive);
    const drop = [...plan.prune, ...(plan.adopt !== null && !own ? [plan.adopt] : [])].map(ConvCore.windowKey);
    if (drop.length) await chrome.storage.local.remove(drop);
    // P1b §4.4: conversations adopted from an orphan record (a browser restart) are "coming back".
    const adopted = !own && plan.adopt !== null ? open.filter((id) => plan.take.includes(id)) : [];
    return { elsewhere, full, adopted };
  });
  convIndex = await convStore.readIndex();
  const got = windowRec.open.length ? await chrome.storage.local.get(windowRec.open.map(ConvCore.convKey)) : {};
  for (const id of windowRec.open) convs.set(id, makeConv(id, got[ConvCore.convKey(id)]));
  if (windowRec.current) showConversation(windowRec.current);
  else showLobby();
  renderConvTabs();
  for (const id of out.elsewhere) noticeOpenElsewhere(id);
  if (out.full) showArchivePicker(() => newConversation());
  if (out.adopted.length) {
    // §4.4: their group tabs come back (current first), then §4.2 expands the current one's group.
    const order = [windowRec.current, ...out.adopted.filter((id) => id !== windowRec.current)].filter((id) => out.adopted.includes(id));
    (async () => {
      for (const id of order) { try { await restoreGroupTabs(id); } catch (e) { console.warn("katashiro: reopening a conversation's tabs failed:", e); } }
      await applyGroupSwitch();
    })();
  }
}

// --- showing / switching ----------------------------------------------------------------------
// One DOM list per open conversation (§3.5), inside #messages-list (the scroll container): built
// from conv:<id> the first time it is shown, then kept, hidden while not current — so memory-only
// cards, reply buttons and scroll position survive a switch. The lobby holds notices while the
// panel has no conversation (3 open in other windows).
const lobbyList = document.createElement("div");
lobbyList.className = "conv-messages conv-lobby";
messagesList.appendChild(lobbyList);
let chatList = lobbyList;                 // where rows are appended: the current conversation's list

// P2 (multi-conversation §5): a turn runs in any open conversation, so what it renders and records
// goes to ITS conversation, on screen or not. `scopeConv` names that conversation for the duration of
// a synchronous render (inConv); null = the conversation on screen. Every append/record path reads
// it through outList() / targetConv(), never `chatList` / `currentConv` directly.
let scopeConv = null;
function targetConv() { return scopeConv || currentConv; }
function targetConvId() { const c = targetConv(); return c ? c.id : conversationId; }
function outList() { return scopeConv ? ensureListEl(scopeConv) : chatList; }
function inConv(conv, fn) {
  const prev = scopeConv;
  scopeConv = conv && conv !== currentConv && convs.has(conv.id) ? conv : null;
  try { return fn(); } finally { scopeConv = prev; }
}

// A conversation's message list, built (hidden) and filled from its records the first time it is
// needed: when it is first shown, or when a background turn first writes into it.
function ensureListEl(conv) {
  if (conv.listEl) return conv.listEl;
  conv.listEl = document.createElement("div");
  conv.listEl.className = "conv-messages";
  conv.listEl.hidden = true;
  messagesList.appendChild(conv.listEl);
  conv.stick = true;
  if (conv.messages.length) {
    const prev = scopeConv;
    scopeConv = conv;                                    // the records are already in conv.messages,
    restoring = true;                                    // so "↩ time" markers resolve
    try { conv.messages.slice().forEach(replayMessage); } finally { restoring = false; scopeConv = prev; }
  }
  return conv.listEl;
}

function hideCurrentList() {
  if (currentConv && currentConv.listEl) {
    currentConv.scrollTop = messagesList.scrollTop;
    currentConv.stick = stickToBottom;
    currentConv.listEl.hidden = true;
  }
}

function afterShow() {
  if (jumpLatestBtn) jumpLatestBtn.hidden = true;
  refreshAskVisibility();                                // a card in a hidden conversation does not count down
  updateRoster();
  updateStopButton();
  renderConvTabs();
}

function showConversation(id) {
  const conv = convs.get(id);
  if (!conv) return;
  const switching = currentConv !== conv;
  if (switching) { stashDraft(currentConv); hideCurrentList(); }
  lobbyList.hidden = true;
  currentConv = conv;
  conversationId = id;
  historyMessages = conv.messages;
  if (windowRec.current !== id) {
    windowRec = { ...windowRec, current: id };
    writeWindowRec();
  }
  chatList = ensureListEl(conv);
  chatList.hidden = false;
  if (conv.unread) { conv.unread = false; renderConvTabs(); }   // P2 §5: ● goes once it is on screen
  stickToBottom = conv.stick !== false;
  if (stickToBottom) scrollToBottom(); else messagesList.scrollTop = conv.scrollTop;
  // A reply chip quotes a message of the conversation it was set in.
  if (replyTarget && !String(replyTarget.id || "").startsWith(`${id}:`)) setReplyTarget(null);
  if (switching) restoreDraft(conv);
  afterShow();
}

// P1b §4.8: the composer's draft (text + staged images and files) belongs to its conversation:
// kept on the conversation object while another one is current (memory only, like the staged
// attachments themselves).
function stashDraft(conv) {
  if (!conv) return;
  const text = messageInput.value;
  conv.draft = text || stagedImages.length || stagedFiles.length ? { text, images: stagedImages, files: stagedFiles } : null;
}
function restoreDraft(conv) {
  const d = conv ? conv.draft : null;
  if (conv) conv.draft = null;
  messageInput.value = d ? d.text : "";
  stagedImages = d ? d.images : [];
  stagedFiles = d ? d.files : [];
  messageInput.style.height = "auto";
  if (messageInput.value) messageInput.style.height = (messageInput.scrollHeight - 2) + "px";
  renderStagedPreviews();
  updateSendEnabled();
}
// Where an attachment still being encoded goes: the composer if its conversation is current, else
// that conversation's draft (a switch happened meanwhile). null: its conversation is gone.
function stagingTarget(conv) {
  if (!conv || conv === currentConv) return { images: stagedImages, files: stagedFiles, live: true };
  if (!convs.has(conv.id)) return null;
  if (!conv.draft) conv.draft = { text: "", images: [], files: [] };
  return { images: conv.draft.images, files: conv.draft.files, live: false };
}

// P1b: after leaving conversation `prevId` for the current one — expand its group, move off
// another conversation's group (Q5, §4.2), and if a card still waits in the one left, mark it and notify (Q12, §4.7).
function afterLeaving(prevId) {
  applyGroupSwitch();
  if (prevId && prevId !== conversationId && convs.has(prevId) && hasWaitingCard(prevId)) notifyWaitingCard(prevId);
}

function showLobby() {
  stashDraft(currentConv);
  hideCurrentList();
  currentConv = null;
  conversationId = null;
  historyMessages = [];
  chatList = lobbyList;
  lobbyList.hidden = false;
  setReplyTarget(null);
  afterShow();
}

// The active agent resumes (or creates) the current conversation's session if it has not been on
// this socket yet; otherwise its queue is flushed (§3.5 steps).
function activateSessions() {
  room.forEach((c) => {
    if (c.enabled && c.agent.url === activeAgentUrl && c.cur) c.openSession(c.cur);
  });
}

// §3.4 + P2 §5: may conversation `id` be archived (×, the picker)? → the refusal text, or null.
// Since P2 every open conversation flushes its own queue, so queued prompts count for any of them.
// Switching and ＋ are never blocked: the turn continues in the background.
function convArchiveBlock(id = conversationId) {
  if (!id) return null;
  return ConvCore.archiveBlocked(room.map((c) => {
    const st = c.states.get(id);
    return st && { turnActive: st.turnActive, queued: st.promptQueue.length, online: !!(c.ws && c.ws.readyState === WebSocket.OPEN && c.initialized) };
  }));
}
// Is conversation `id` replying (any agent)? The tab strip's ⏳ (P2 §5).
function convReplying(id) {
  return room.some((c) => { const st = c.states.get(id); return !!(st && st.turnActive); });
}

function switchConversation(id) {
  if (id === conversationId || !convs.has(id)) return true;
  if (currentConv) writeIndexTime(currentConv);          // §3.2: always on switch
  const prev = conversationId;
  showConversation(id);
  activateSessions();
  afterLeaving(prev);
  return true;
}

// ＋ (§3.3): a new, empty conversation, switched to. With 3 open in any window, first the picker.
async function newConversation() {
  const r = await withWindowsLock(async () => {
    const [windows, live] = await Promise.all([convStore.readWindows(), liveWindowIds()]);
    windows[String(panelWindowId)] = windowRec;
    if (ConvCore.liveOpenIds(windows, live).size >= ConvCore.MAX_OPEN) return { full: true };
    const id = newConversationId();
    if (!(await holdConvLock(id))) return {};
    const entry = freshIndexEntry();
    await convStore.updateIndex((idx) => { idx[id] = entry; return idx; });
    windowRec = ConvCore.withOpened(windowRec, id);
    await writeWindowRec();
    return { id, entry };
  });
  if (r.full) { showArchivePicker(() => newConversation()); return false; }
  if (!r.id) return false;
  if (currentConv) writeIndexTime(currentConv);
  convIndex[r.id] = r.entry;
  convs.set(r.id, makeConv(r.id, null));
  const prev = conversationId;
  showConversation(r.id);
  activateSessions();
  afterLeaving(prev);
  return true;
}

// × (§3.4): archive — Katashiro-side only (there is no session/close): archivedAt set, out of the
// window's open list, Web Lock released, in-memory state, MCP server and its tunnels dropped, its
// ask cards closed as `archived`. Messages, sessions, canvases and their tabs stay. An empty
// conversation (no messages, no canvases) is deleted instead. Closing the last tab leaves a new one.
async function archiveConversation(id) {
  const conv = convs.get(id);
  if (!conv) return { ok: false, error: "這段對話沒有開在這個側邊欄" };
  const blocked = convArchiveBlock(id);
  if (blocked) { appendSystemMessage(blocked); return { ok: false, error: blocked }; }
  const wasCurrent = id === conversationId;
  // P1b §4.4–4.5: the group's tab list is final before its tabs close (they come back on reopen).
  await refreshGroupTabs(id).catch(() => {});
  const gid = await storedCanvasGroupId(id);
  const title = ConvCore.displayTitle(convIndex[id], id);
  await saveConv(conv);
  conv.indexTimeAt = 0;
  await writeIndexTime(conv);                            // §3.2: always on archive
  settlePendingAsks("archive", { convId: id });
  cancelPendingConfirms(id);                             // none in practice: a confirm lives in a running turn
  room.forEach((c) => c.dropState(id));
  await withWindowsLock(async () => {
    windowRec = ConvCore.withClosed(windowRec, id);
    await convStore.archiveIds([id]);
    await writeWindowRec();
  });
  releaseConvLock(id);
  convs.delete(id);
  if (conv.listEl) conv.listEl.remove();
  await forgetCanvasGroupId(id);
  if (wasCurrent) {
    currentConv = null;
    conversationId = null;
    if (windowRec.current && convs.has(windowRec.current)) { showConversation(windowRec.current); activateSessions(); applyGroupSwitch(); }
    else await newConversation();
  }
  renderConvTabs();
  // §4.5: close its group's tabs (no longer tracked: it left `convs` above). After the switch, so
  // what was kept open is said in the conversation now on screen.
  if (gid != null) await canvasTabQueue(() => closeConversationTabs(gid, title), id).catch((e) => console.warn("katashiro: closing an archived conversation's tabs failed:", e));
  return { ok: true };
}

// Reopen (§3.4, from the gallery's 對話 section): take the lock, move it out of a closed window's
// record if it is in one, clear archivedAt, add it to this window and switch to it.
async function reopenConversation(id) {
  if (convs.has(id)) { switchConversation(id); return { ok: true }; }
  const r = await withWindowsLock(async () => {
    const [windows, live, index] = await Promise.all([convStore.readWindows(), liveWindowIds(), convStore.readIndex()]);
    // §7.1: deleted (or being deleted) — never recreated as an empty conversation by a stale gallery tab.
    const gone = ConvCore.reopenRefusal(index[id]);
    if (gone) return { gone };
    const wid = String(panelWindowId);
    windows[wid] = windowRec;
    const holder = ConvCore.windowHolding(windows, live, id);
    if (holder !== null && holder !== wid && live.has(holder)) return { elsewhere: true };
    if (ConvCore.liveOpenIds(windows, live).size >= ConvCore.MAX_OPEN) return { full: true };
    if (!(await holdConvLock(id))) return { elsewhere: true };
    const writes = {};
    for (const [w, rec] of Object.entries(windows)) {
      if (w === wid || !Array.isArray(rec && rec.open) || !rec.open.includes(id)) continue;
      writes[ConvCore.windowKey(w)] = { ...ConvCore.withClosed(rec, id), savedAt: rec.savedAt || 0 };
    }
    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    await convStore.updateIndex((idx) => { idx[id] = { ...(idx[id] || freshIndexEntry()), archivedAt: null }; return idx; });
    windowRec = ConvCore.withOpened(windowRec, id);
    await writeWindowRec();
    return { ok: true };
  });
  if (r.full) {
    showArchivePicker(() => reopenConversation(id));
    return { ok: false, error: "已經開了 3 段對話：在側邊欄選一段封存後就會打開" };
  }
  if (r.gone) { appendSystemMessage(r.gone); return { ok: false, error: r.gone }; }
  if (r.elsewhere) { noticeOpenElsewhere(id); return { ok: false, error: ConvCore.OPEN_ELSEWHERE_TEXT }; }
  const got = await chrome.storage.local.get([ConvCore.convKey(id), ConvCore.INDEX_KEY]);
  if (got[ConvCore.INDEX_KEY]) adoptIndex(got[ConvCore.INDEX_KEY]);
  if (currentConv) writeIndexTime(currentConv);
  convs.set(id, makeConv(id, got[ConvCore.convKey(id)]));
  const prev = conversationId;
  showConversation(id);
  activateSessions();
  // §4.4: it comes back with its group's tabs; then §4.2 (and Q12 for the one left).
  restoreGroupTabs(id).catch((e) => console.warn("katashiro: reopening a conversation's tabs failed:", e)).then(() => afterLeaving(prev));
  return { ok: true };
}

// A conversation open in another window: focus the window that has it (§3.6).
async function focusConversationWindow(id) {
  try {
    const [windows, live] = await Promise.all([convStore.readWindows(), liveWindowIds()]);
    const w = ConvCore.windowHolding(windows, live, id);
    if (w !== null && live.has(w) && /^\d+$/.test(w)) await chrome.windows.update(Number(w), { focused: true });
  } catch (_) { /* the window closed meanwhile */ }
}

// The lock was taken, but no other live window lists the id: a gallery delete holds it (§7.1,
// before its mark is down) — no window to go to.
async function noticeOpenElsewhere(id) {
  let other = true;
  try {
    const [windows, live] = await Promise.all([convStore.readWindows(), liveWindowIds()]);
    const own = String(panelWindowId);
    other = Object.entries(windows).some(([w, rec]) => w !== own && live.has(String(w)) && Array.isArray(rec && rec.open) && rec.open.includes(id));
  } catch (_) { /* unknown: offer the button, as before */ }
  if (!other) { appendSystemMessage(`${ConvCore.CONV_BUSY_TEXT}：「${ConvCore.displayTitle(convIndex[id], id)}」`); return; }
  appendSystemActions(`${ConvCore.OPEN_ELSEWHERE_TEXT}：「${ConvCore.displayTitle(convIndex[id], id)}」`, [
    { label: "前往那個視窗", onClick: () => focusConversationWindow(id) },
  ]);
}

// Archive a conversation wherever it is open: here; in another window's panel (it holds the lock,
// so ask it); or, with no panel showing it (lock free), straight in the records.
async function archiveAnywhere(id) {
  if (convs.has(id)) return archiveConversation(id);
  if (await holdConvLock(id)) {
    try {
      await withWindowsLock(async () => {
        const windows = await convStore.readWindows();
        const writes = {};
        for (const [w, rec] of Object.entries(windows)) {
          if (Array.isArray(rec && rec.open) && rec.open.includes(id)) writes[ConvCore.windowKey(w)] = { ...ConvCore.withClosed(rec, id), savedAt: rec.savedAt || 0 };
        }
        if (Object.keys(writes).length) await chrome.storage.local.set(writes);
        await convStore.archiveIds([id]);
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    } finally {
      releaseConvLock(id);
    }
  }
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(null), 5000); });
  let r;
  try { r = await Promise.race([chrome.runtime.sendMessage({ type: "katashiro-conv-archive", id }), timeout]); }
  catch (_) { r = null; }
  clearTimeout(timer);
  return r || { ok: false, error: "另一個視窗的側邊欄沒有回應" };
}

// The picker (§3.4): with 3 open (in any window), which one to archive first. A system card, not
// agent-styled; a conversation that is replying here cannot be picked (one replying in another
// window refuses there). 取消 reopens nothing.
// One card at a time, claimed before the first await so two calls cannot each build one. What
// follows the pick is the LATEST request's: on load a full panel first asks for "new
// conversation", then a pending 重新打開 from the gallery asks again — that reopen must win.
let pickerCard = null;
let pickerThen = null;
async function showArchivePicker(then) {
  pickerThen = then;
  if (pickerCard) { pickerCard.scrollIntoView({ block: "nearest" }); return; }
  const row = document.createElement("div");
  pickerCard = row;
  let ids = [];
  try {
    const [windows, live] = await Promise.all([convStore.readWindows(), liveWindowIds()]);
    windows[String(panelWindowId)] = windowRec;
    ids = [...ConvCore.liveOpenIds(windows, live)];
  } catch (_) { /* nothing to list */ }
  row.className = "message system";
  const card = document.createElement("div");
  card.className = "conv-picker";
  card.setAttribute("role", "group");
  const head = document.createElement("div");
  head.className = "conv-picker-head";
  head.textContent = `已經開了 ${ConvCore.MAX_OPEN} 段對話（所有視窗合計）。要封存哪一段？`;
  const hint = document.createElement("div");
  hint.className = "conv-picker-hint";
  hint.textContent = "封存的對話可以從 🗂️ 總覽重新打開。";
  const list = document.createElement("div");
  list.className = "conv-picker-list";
  const status = document.createElement("div");
  status.className = "conv-picker-status";
  status.hidden = true;
  const close = () => { row.remove(); pickerCard = null; pickerThen = null; };
  const buttons = [];
  for (const id of ids) {
    const mine = convs.has(id);
    const busy = mine && !!convArchiveBlock(id);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "conv-picker-option";
    b.textContent = `${ConvCore.displayTitle(convIndex[id], id)}${mine ? "" : "（另一個視窗）"}${busy ? "（回覆中）" : ""}`;
    b.disabled = busy;
    b.addEventListener("click", async () => {
      buttons.forEach((x) => { x.disabled = true; });
      const r = await archiveAnywhere(id);
      if (r && r.ok) { const next = pickerThen; close(); if (next) next(); return; }
      status.textContent = `沒有封存：${(r && r.error) || "未知錯誤"}`;
      status.hidden = false;
      buttons.forEach((x) => { x.disabled = x.dataset.busy === "1"; });
    });
    b.dataset.busy = busy ? "1" : "";
    buttons.push(b);
    list.appendChild(b);
  }
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "conv-picker-cancel";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    close();
    if (!currentConv) noticeAllOpenElsewhere(ids);
  });
  buttons.push(cancel);
  card.append(head, hint, list, status, cancel);
  row.appendChild(card);
  chatList.appendChild(row);
  maybeScroll();
}

// The panel has no conversation and the user cancelled the picker: say where the 3 are.
function noticeAllOpenElsewhere(ids) {
  appendSystemActions(`已經有 ${ConvCore.MAX_OPEN} 段對話開在其他視窗。`, [
    ...ids.map((id) => ({ label: `前往「${ConvCore.displayTitle(convIndex[id], id)}」`, onClick: () => focusConversationWindow(id) })),
    { label: "封存一段，開新對話", onClick: () => showArchivePicker(() => newConversation()) },
  ]);
}

// A sender that is one of Katashiro's own pages (`path`, e.g. "/canvas-gallery.html").
function fromOwnPage(sender, path) {
  try {
    const u = new URL(sender && sender.url);
    return sender.id === chrome.runtime.id && u.origin === new URL(chrome.runtime.getURL("")).origin && u.pathname === path;
  } catch (_) { return false; }
}

// Another window's picker archives a conversation open in THIS panel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-conv-archive") return false;
  if (!fromOwnPage(sender, "/sidepanel.html") || !convs.has(msg.id)) return false;
  archiveConversation(msg.id).then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

// 重新打開 in the gallery (§3.4): accepted only from canvas-gallery.html, answered by the panel of
// the gallery's window. A gallery that found no panel opened one and left the request in
// storage.session; the panel picks it up on load (pickUpReopenRequest). reqId dedupes the two.
const handledReopens = new Set();
async function handleReopen(id, reqId) {
  if (reqId) {
    if (handledReopens.has(reqId)) return { ok: true };
    handledReopens.add(reqId);
    const k = `${ConvCore.REOPEN_KEY_PREFIX}${panelWindowId}`;
    try {
      const got = await chrome.storage.session.get(k);
      if (got[k] && got[k].reqId === reqId) await chrome.storage.session.remove(k);
    } catch (_) { /* no storage.session */ }
  }
  return reopenConversation(id);
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-conv-open") return false;
  if (!fromOwnPage(sender, "/canvas-gallery.html") || !ConvCore.isConvId(msg.id)) {
    sendResponse({ ok: false, error: "not from the Katashiro gallery" });
    return false;
  }
  if (panelWindowId == null || String(msg.windowId) !== String(panelWindowId)) return false;
  panelReady
    .then(() => handleReopen(msg.id, typeof msg.reqId === "string" ? msg.reqId : null))
    .then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});
async function pickUpReopenRequest() {
  const k = `${ConvCore.REOPEN_KEY_PREFIX}${panelWindowId}`;
  let r = null;
  try { r = (await chrome.storage.session.get(k))[k]; } catch (_) { return; }
  if (!r) return;
  try { await chrome.storage.session.remove(k); } catch (_) { /* best effort */ }
  if (ConvCore.isConvId(r.id) && Date.now() - Number(r.at || 0) < 60 * 1000) handleReopen(r.id, r.reqId || null);
}

// §3.2: lastMessageAt always on panel hide.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") for (const conv of convs.values()) writeIndexTime(conv);
});

// --- tab strip (§3.3) ---------------------------------------------------------------------------
const convTabsEl = document.getElementById("conv-tabs");
let convRenaming = null;                  // the id whose name is being edited (no re-render meanwhile)

function renderConvTabs() {
  if (!convTabsEl || convRenaming) return;
  const now = Date.now();
  const tabs = windowRec.open.filter((id) => convs.has(id)).map((id) => {
    const e = convIndex[id];
    const title = ConvCore.displayTitle(e, id);
    const current = id === conversationId;
    const replying = convReplying(id);
    const busy = replying || !!convArchiveBlock(id);
    const waiting = !current && hasWaitingCard(id);       // Q12 (§4.7)
    // P2 §5: ❓ a card waiting > ⏳ replying > ● something new arrived while it was not on screen.
    const m = ConvCore.tabMark({ current, replying, waiting, unread: !!(convs.get(id) || {}).unread });
    const tab = document.createElement("div");
    tab.className = `conv-tab${current ? " current" : ""}${busy ? " busy" : ""}${m.kind ? ` mark-${m.kind}` : ""}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", current ? "true" : "false");
    tab.tabIndex = 0;
    tab.title = `${title}${m.label ? `\n${m.icon} ${m.label}` : ""}\n（雙擊改名）`;
    const mark = document.createElement("span");
    mark.className = "conv-tab-mark";
    mark.setAttribute("aria-label", m.label || "");
    mark.textContent = m.icon || "";
    mark.hidden = !m.icon;
    const name = document.createElement("span");
    name.className = "conv-tab-title";
    name.textContent = title;                             // textContent: a title is user/agent text
    const time = document.createElement("span");
    time.className = "conv-tab-time";
    time.textContent = ConvCore.tabTime(e && e.lastMessageAt, now);
    const x = document.createElement("button");
    x.type = "button";
    x.className = "conv-tab-close";
    // While it replies, × becomes ⏹: stop that conversation's turn (P2 §5); archiving waits for it.
    x.textContent = replying ? "⏹" : "×";
    x.title = replying ? "停止這段對話的回覆" : (busy ? "回覆中不能封存" : "封存這段對話（可從 🗂️ 總覽重新打開）");
    x.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (replying) room.forEach((c) => c.cancelTurn(id));
      else archiveConversation(id);
    });
    tab.append(mark, name, time, x);
    tab.addEventListener("click", () => switchConversation(id));
    tab.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); switchConversation(id); } });
    tab.addEventListener("dblclick", (ev) => { ev.preventDefault(); startRename(tab, name, id); });
    return tab;
  });
  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "conv-tab-new";
  plus.textContent = "＋";
  plus.title = `新對話（所有視窗合計最多 ${ConvCore.MAX_OPEN} 段）`;
  plus.addEventListener("click", () => newConversation());
  convTabsEl.replaceChildren(...tabs, plus);
}
setInterval(() => renderConvTabs(), 60 * 1000);          // "today" vs M/D

// Double-click a tab to rename it (titleSource "user"); an empty name returns to the auto title.
function startRename(tab, nameEl, id) {
  const conv = convs.get(id);
  if (!conv) return;
  convRenaming = id;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "conv-tab-rename";
  input.maxLength = ConvCore.USER_TITLE_MAX * 2;
  input.value = (convIndex[id] && convIndex[id].title) || "";
  input.placeholder = ConvCore.displayTitle(null, id);
  input.setAttribute("aria-label", "對話名稱");
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    convRenaming = null;
    if (save) {
      const next = ConvCore.renamedEntry(convIndex[id] || freshIndexEntry(), input.value, conv.messages);
      convIndex[id] = next;
      patchIndex(id, () => ({ title: next.title, titleSource: next.titleSource }));
      updateCanvasGroupTitle(id);
    }
    renderConvTabs();
  };
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    ev.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (ev) => ev.stopPropagation());
  input.addEventListener("dblclick", (ev) => ev.stopPropagation());
  nameEl.replaceWith(input);
  input.focus();
  input.select();
}

// --- Roster (per-agent online + browser status) ------------------------------
// Single source of truth for a conn's display state (roster chips + settings rows).
function connState(c) {
  if (!c) return { cls: "offline", label: "離線" };
  if (c.acpReady) return { cls: "online", label: "已連線" };
  if (c.lastFailure === "auth") return { cls: "error", label: "認證失敗（token 錯誤／被拒）" };
  if (c.lastFailure === "unreachable") return { cls: "error", label: "連不到（伺服器未啟動／網址錯誤）" };
  if (!c.enabled) return { cls: "offline", label: "已停用" };
  if (c.online) return { cls: "connecting", label: "握手中…" };
  return { cls: "connecting", label: "連線中…" };
}

// Render one status segment (ADR §8.2): a lead glyph (🔌/🚇/🌐) + an optional state dot + a short
// word. `seg` is a RoomCore.roomStatus() segment { cls, dot?, word, title, dim? }; `dim` greys a
// segment whose upstream is down so it can't read as healthy.
function renderSeg(kind, glyph, seg) {
  const el = document.createElement("span");
  el.className = `status-seg seg-${kind} ${seg.cls}` + (seg.dim ? " dim" : "");
  el.title = seg.title || "";
  const g = document.createElement("span");
  g.className = "seg-glyph";
  g.textContent = glyph;                                 // textContent: static lead glyph
  el.appendChild(g);
  if (seg.dot) {
    const d = document.createElement("span");
    d.className = "seg-dot";
    d.textContent = seg.dot;                             // textContent: static state glyph
    el.appendChild(d);
  }
  const w = document.createElement("span");
  w.className = "seg-word";
  w.textContent = seg.word;
  el.appendChild(w);
  return el;
}

function updateRoster() {
  const onlineCount = room.filter((c) => c.acpReady).length;
  if (statusIndicator) {
    statusIndicator.className = "status-indicator " + (onlineCount > 0 ? "online" : "offline");
  }
  if (activeAgentLabel) {
    activeAgentLabel.textContent = `${onlineCount}/${room.length} agents 上線`;
  }
  if (!rosterEl) return;
  rosterEl.innerHTML = "";
  room.forEach((c) => {
    const isActive = c.agent.url === activeAgentUrl;
    const chip = document.createElement("div");

    const nm = document.createElement("span");
    nm.className = "roster-name";
    nm.textContent = c.name;                             // textContent: agent name is user config

    // Dormant agent (single-active): a selector chip. Click activates it (radio) — the switch the
    // user wants on the chips, not only in Settings.
    if (!isActive) {
      chip.className = "roster-chip dormant clickable";
      chip.title = "點此設為使用中的 agent";
      chip.appendChild(nm);
      const hint = document.createElement("span");
      hint.className = "roster-activate";
      hint.textContent = "點此啟用";
      chip.appendChild(hint);
      chip.addEventListener("click", () => setActiveAgent(c.agent.url));
      rosterEl.appendChild(chip);
      return;
    }

    // Active agent — full three-segment status (🔌 link · 🚇 tunnel · 🌐 browser, ADR §8.2).
    const s = RoomCore.roomStatus({
      acpReady: c.acpReady, alive: c.alive, lastFailure: c.lastFailure,
      enabled: c.enabled, online: c.online,
      allowed: c.agent.browserAccess !== false,
      attached: c.browserAttached,
      tunnelFresh: Date.now() - (c.lastTunnelMsgAt || 0) < TUNNEL_FRESH_MS,
      actMode,
    });
    chip.className = "roster-chip active " + s.link.cls;
    chip.appendChild(nm);
    chip.appendChild(renderSeg("link", "🔌", s.link));
    if (s.tunnel) chip.appendChild(renderSeg("tunnel", "🚇", s.tunnel));
    if (s.browser) chip.appendChild(renderSeg("browser", "🌐", s.browser));

    // Show which ACP session this chip is bound to (hover) — lets you confirm which
    // session you're talking to vs the gateway/mon-tick's `sess=` id.
    chip.title = `ACP session: ${c.acpSessionId || "—"}`;

    // R2 — one-click manual reconnect on an unhealthy link; a healthy link is inert.
    if (c.enabled !== false && s.link.cls !== "online") {
      chip.classList.add("clickable");
      chip.title = "點擊重新連線";
      chip.addEventListener("click", () => { c.connect(); updateRoster(); });
    }

    rosterEl.appendChild(chip);
  });

  // Keep the settings list's per-row status live too, when it's open.
  if (settingsView && settingsView.classList.contains("active")) updateAgentListStatus();
}

// --- View switcher -----------------------------------------------------------
function switchView(viewName) {
  setupView.classList.remove("active");
  chatView.classList.remove("active");
  settingsView.classList.remove("active");
  if (viewName === "setup") setupView.classList.add("active");
  else if (viewName === "chat") {
    chatView.classList.add("active");
    updateRoster();                                    // reflect any act-mode change made in Settings
    // Scroll math is invalid while a view is display:none (scrollHeight/clientHeight read 0), so a
    // reply that streamed in under Settings leaves chat pinned to the top on return. Re-pin to the
    // bottom once it's visible again — but only if the user was following the latest.
    if (stickToBottom) requestAnimationFrame(scrollToBottom);
  }
  else if (viewName === "settings") settingsView.classList.add("active");
  refreshAskVisibility();                                // an ask card's clock runs only while the chat shows
}

// --- UI event listeners ------------------------------------------------------
settingsBtn.addEventListener("click", () => {
  renderRoomConfig();
  renderActMode();
  renderAgentList();
  if (jevTokenInput) jevTokenInput.value = jevToken;
  renderScreenshotConfig();
  renderAttachConfig();
  renderCanvasFolder();
  switchView("settings");
});

cancelSettingsBtn.addEventListener("click", () => switchView("chat"));

// Close on Escape or a click on the backdrop itself (not the card) — standard modal UX.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsView.classList.contains("active")) switchView("chat");
});
settingsView.addEventListener("click", (e) => {
  if (e.target === settingsView) switchView("chat");
});

// Clear the current conversation's scrollback + its persisted copy (conv:<id>), and nothing else
// (§3.3: other conversations, and its title, stay). The agents'
// resumable ACP sessions are deliberately KEPT — this wipes the local transcript without making the
// agents forget, so `session/resume` still restores their side of the conversation on reconnect,
// just not the cleared bubbles. Guarded by a confirm since the stored copy (storage.local) is the
// only one.
function clearChat() {
  if (!currentConv) return;
  if (!confirm("清除這段對話的聊天畫面？agent 端的對話記憶會保留，只清掉這段對話顯示的訊息。")) return;
  cancelPendingConfirms(conversationId);   // a confirm card leaving the screen is a "no" (#80)
  cancelPendingAsks(conversationId);       // …and an ask card closes unanswered, telling the agent nothing
  chatList.replaceChildren();
  historyMessages.length = 0;
  shownImageChars = 0;           // the shown images left the DOM with the messages (an estimate across conversations)
  saveConv();                    // persist the now-empty scrollback (session ids untouched)
  if (jumpLatestBtn) jumpLatestBtn.hidden = true;
  appendSystemMessage("已清除聊天畫面（agent 端記憶仍保留）。");
}

if (clearChatBtn) clearChatBtn.addEventListener("click", clearChat);

// Room routing config controls (static elements — wire once).
if (modeMentionBtn) modeMentionBtn.addEventListener("click", () => setRoomMode("mention"));
if (modeAmbientBtn) modeAmbientBtn.addEventListener("click", () => setRoomMode("ambient"));
if (loopGuardCapInput) {
  loopGuardCapInput.addEventListener("change", () => {
    roomConfig.loopGuardCap = RoomCore.normalizeCap(loopGuardCapInput.value);
    loopGuardCapInput.value = String(roomConfig.loopGuardCap);
    loopGuard.setCap(roomConfig.loopGuardCap);
    persist();
  });
}

// Jev grounding token (BYO-key). Trim on save — a pasted key often carries trailing whitespace.
if (jevTokenInput) {
  jevTokenInput.addEventListener("change", () => {
    jevToken = (jevTokenInput.value || "").trim();
    jevTokenInput.value = jevToken;
    persist();
  });
}

// Settings → 截圖. Clamped on save (browser-mcp's limits), and the inputs show the clamped value.
const screenshotMaxKbInput = document.getElementById("screenshot-max-kb");
const screenshotStoreMaxInput = document.getElementById("screenshot-store-max");
function renderScreenshotConfig() {
  if (screenshotMaxKbInput) screenshotMaxKbInput.value = String(screenshotConfig.maxKB);
  if (screenshotStoreMaxInput) screenshotStoreMaxInput.value = String(screenshotConfig.storeMax);
}
[screenshotMaxKbInput, screenshotStoreMaxInput].forEach((input) => {
  if (!input) return;
  input.addEventListener("change", () => {
    screenshotConfig = BrowserMcp.normalizeScreenshotConfig({
      maxKB: screenshotMaxKbInput && screenshotMaxKbInput.value,
      storeMax: screenshotStoreMaxInput && screenshotStoreMaxInput.value,
    });
    renderScreenshotConfig();
    // A lower storeMax trims what each agent already holds now, not at its next capture.
    room.forEach((c) => { for (const st of c.states.values()) if (st.mcpServer) st.mcpServer.setImageStoreMax(screenshotConfig.storeMax); });
    persist();
  });
});

// Settings → 附加檔案 (ADR chat-attachments §2.3). Clamped on save like 截圖.
const attachMaxMbInput = document.getElementById("attach-max-mb");
const attachTextCapInput = document.getElementById("attach-text-cap-kb");
function renderAttachConfig() {
  if (attachMaxMbInput) attachMaxMbInput.value = String(attachConfig.maxFileMB);
  if (attachTextCapInput) attachTextCapInput.value = String(attachConfig.textCapKB);
}
[attachMaxMbInput, attachTextCapInput].forEach((input) => {
  if (!input) return;
  input.addEventListener("change", () => {
    attachConfig = Composer.normalizeAttachConfig({
      maxFileMB: attachMaxMbInput && attachMaxMbInput.value,
      textCapKB: attachTextCapInput && attachTextCapInput.value,
    });
    renderAttachConfig();
    persist();
  });
});

// Shrink a JPEG screenshot (base64): scale by `scale`, and further so the long edge is at most
// `maxEdge` when given; then re-encode. Runs in the panel (OffscreenCanvas). Returns base64, or null
// when nothing would change (scale ≥ 1 and already within maxEdge).
async function reencodeJpeg(base64, { scale = 1, quality, maxEdge }) {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bmp = await createImageBitmap(new Blob([raw], { type: "image/jpeg" }));
  const k = Math.min(scale, maxEdge ? maxEdge / Math.max(bmp.width, bmp.height) : 1);
  if (k >= 1 && maxEdge) { bmp.close(); return null; }
  const w = Math.max(1, Math.round(bmp.width * k));
  const h = Math.max(1, Math.round(bmp.height * k));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const out = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer());
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(bin);
}

// A 👁 toggle that reveals/masks a password input — lets the user verify a pasted token
// (catch truncation / stray whitespace) instead of debugging blind behind the mask.
function makeRevealBtn(input) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary-btn reveal-btn";
  btn.textContent = "👁";
  btn.title = "顯示 / 隱藏 token";
  btn.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    btn.textContent = reveal ? "🙈" : "👁";
  });
  return btn;
}

// Wrap a token <input> and its 👁 toggle in a flex row so the eye sits at the field's right edge.
function attachReveal(input) {
  if (!input || !input.parentNode) return;
  const row = document.createElement("div");
  row.className = "token-row";
  input.parentNode.insertBefore(row, input);
  row.appendChild(input);
  row.appendChild(makeRevealBtn(input));
}

// Attach reveal toggles to the two static token fields (Jev grounding + add-agent token).
[jevTokenInput, document.getElementById("new-agent-token")].forEach(attachReveal);

// Reflect the room routing config (mode + cap) in the settings UI.
function renderRoomConfig() {
  const mode = roomConfig.mode;
  if (modeMentionBtn) modeMentionBtn.classList.toggle("on", mode === "mention");
  if (modeAmbientBtn) modeAmbientBtn.classList.toggle("on", mode === "ambient");
  if (modeHintEl) {
    modeHintEl.textContent =
      mode === "mention"
        ? "＠ 指名才觸發該 agent；沒 ＠ 則廣播全體。"
        : "全體都收到每則訊息、各自決定是否回應（靠 loop guard 收斂）。";
  }
  if (loopGuardCapInput) loopGuardCapInput.value = String(roomConfig.loopGuardCap);
}

function setRoomMode(mode) {
  roomConfig.mode = RoomCore.normalizeMode(mode);
  persist();
  renderRoomConfig();
}

// Act mode controls. No reconnect on change: the tunnel stays up and the gate is consulted per
// tool call, so turning writes off takes hold on the next call rather than the next handshake.
if (actReadBtn) actReadBtn.addEventListener("click", () => setActMode(false));
if (actWriteBtn) actWriteBtn.addEventListener("click", () => setActMode(true));

function renderActMode() {
  if (actReadBtn) actReadBtn.classList.toggle("on", !actMode);
  if (actWriteBtn) actWriteBtn.classList.toggle("on", actMode);
  if (actModeHintEl) {
    actModeHintEl.textContent = actMode
      ? "Agent 可以 click／輸入／導向頁面 —— 用的是你已登入的身分，任何你能做的操作它都能做。"
      : "Agent 只能讀取頁面（read_dom／screenshot），寫入類工具一律拒絕。";
  }
}

function setActMode(on) {
  actMode = on === true;
  persist();
  renderActMode();
  updateRoster(); // browser status monkeys reflect act mode (🐵 operational / 🙊 read-only)
}

// reopen_tab needs `sessions`, which is optional: together with `tabs` it also lets the extension
// read other signed-in devices' history, far beyond undoing a close_tab. Chrome holds the grant (no
// config key), and permissions.request needs a user gesture — hence a settings button, not a prompt
// on the tool's first call.
const SESSIONS_PERM = { permissions: ["sessions"] };
const sessionsOnBtn = document.getElementById("sessions-on");
const sessionsOffBtn = document.getElementById("sessions-off");
const sessionsPermHintEl = document.getElementById("sessions-perm-hint");

async function renderSessionsPerm() {
  let on = false;
  try { on = await chrome.permissions.contains(SESSIONS_PERM); } catch { /* treat as not granted */ }
  if (sessionsOnBtn) sessionsOnBtn.classList.toggle("on", on);
  if (sessionsOffBtn) sessionsOffBtn.classList.toggle("on", !on);
  if (sessionsPermHintEl) {
    sessionsPermHintEl.textContent = on
      ? "Agent 可以用 reopen_tab 重開最近關閉的單一分頁。這個 Chrome 權限也能讀其他已登入裝置的瀏覽紀錄，katashiro 不會用到。"
      : "reopen_tab 已停用。按「允許」時 Chrome 會跳出權限確認（讀取所有已登入裝置上的瀏覽紀錄）。";
  }
}

if (sessionsOnBtn) sessionsOnBtn.addEventListener("click", () => {
  chrome.permissions.request(SESSIONS_PERM).catch(() => false).then(renderSessionsPerm);
});
if (sessionsOffBtn) sessionsOffBtn.addEventListener("click", () => {
  chrome.permissions.remove(SESSIONS_PERM).catch(() => false).then(renderSessionsPerm);
});
renderSessionsPerm();


addAgentBtn.addEventListener("click", () => {
  const name = newAgentName.value.trim();
  const url = newAgentUrl.value.trim();
  const token = (newAgentToken?.value || "").trim();
  if (!name || !url) return;
  agents.push({ name, url, token });
  // Single-active: a newly added agent stays dormant (selectable via its chip / the radio) unless it
  // is the very first agent — then it becomes active. Never auto-connect it alongside the active one.
  const makeActive = !activeAgentUrl;
  if (makeActive) activeAgentUrl = url;
  persist();
  const c = new Conn(agents[agents.length - 1]);
  c.enabled = makeActive;
  room.push(c);
  if (makeActive) c.connect();
  newAgentName.value = "";
  newAgentUrl.value = "";
  if (newAgentToken) newAgentToken.value = "";
  renderAgentList();
  updateRoster();
});

if (connectBtn) {
  connectBtn.addEventListener("click", () => {
    const url = wsUrlInput.value.trim();
    if (!url) return;
    const name = (setupNameInput?.value || "").trim() || "OpenAB";   // setup now captures the name
    agents = [{ name, url }];
    activeAgentUrl = url;                                             // the sole agent is active
    persist();
    switchView("chat");
    buildRoom();
    connectAll();
    updateRoster();
  });
}

// Render the agent list in settings. Editing url/token retargets that conn live.
function renderAgentList() {
  if (!agentListEl) return;
  agentListEl.innerHTML = "";
  agents.forEach((a, i) => {
    const row = document.createElement("div");
    const c = room[i];
    row.className = "agent-row" + (c && c.acpReady ? " active" : "");

    const meta = document.createElement("div");
    meta.className = "agent-meta";

    const nm = document.createElement("input");
    nm.className = "agent-name-input";
    nm.value = a.name;
    nm.addEventListener("change", () => {
      a.name = nm.value.trim() || a.name;
      nm.value = a.name;
      persist();
      updateRoster();
    });

    const url = document.createElement("input");
    url.className = "agent-url-input";
    url.value = a.url;
    url.addEventListener("change", () => {
      const next = url.value.trim() || a.url;
      url.value = next;
      if (next !== a.url) {
        if (a.url === activeAgentUrl) activeAgentUrl = next;   // keep the active pointer on this agent
        a.url = next; persist(); reconnectConn(i); updateRoster();
      }
    });

    const tok = document.createElement("input");
    tok.className = "agent-token-input";
    tok.type = "password";
    tok.placeholder = "Token（伺服器需驗證時填）";
    tok.value = a.token || "";
    tok.addEventListener("change", () => {
      const next = tok.value.trim();
      if (next !== (a.token || "")) { a.token = next; persist(); reconnectConn(i); updateRoster(); }
    });

    // Per-row connection status (dot + text), updated live via updateAgentListStatus().
    const statusPill = document.createElement("div");
    statusPill.className = "agent-status";
    statusPill.dataset.idx = i;
    const sdot = document.createElement("span");
    sdot.className = "agent-status-dot";
    const stxt = document.createElement("span");
    stxt.className = "agent-status-text";
    statusPill.appendChild(sdot);
    statusPill.appendChild(stxt);

    meta.appendChild(statusPill);
    meta.appendChild(nm);
    meta.appendChild(url);
    const tokRow = document.createElement("div");   // token input + 👁 reveal on one row
    tokRow.className = "token-row";
    tokRow.appendChild(tok);
    tokRow.appendChild(makeRevealBtn(tok));
    meta.appendChild(tokRow);

    const actions = document.createElement("div");
    actions.className = "agent-actions";

    // Single-active selector (ADR single-active-agent): "設為使用中" activates this agent (connects it,
    // disconnects the others) — the radio, mirrored on the roster chips. Replaces the old per-agent
    // connect/disconnect toggle, which doesn't fit a one-active-at-a-time model.
    const activeBtn = document.createElement("button");
    const isActive = a.url === activeAgentUrl;
    activeBtn.className = "agent-active-toggle" + (isActive ? " on" : "");
    activeBtn.textContent = isActive ? "● 使用中" : "設為使用中";
    activeBtn.title = isActive ? "目前在聊天中使用的 agent" : "切為使用中（會斷開目前的 agent）";
    activeBtn.disabled = isActive;
    activeBtn.addEventListener("click", () => { setActiveAgent(a.url); });

    // Per-agent browser access control (on ⇒ declares the browser MCP tunnel for this agent).
    const brOn = a.browserAccess !== false;              // default on (backward compatible)
    const brToggle = document.createElement("button");
    brToggle.className = "agent-browser-toggle" + (brOn ? " on" : "");
    // 🌐 to match the roster's browser badge — the control and the status now speak one vocabulary
    // (ADR §4.3 S; retires the old 🔗 which collided with the connection glyph).
    brToggle.textContent = brOn ? "🌐 開" : "🌐 關";
    brToggle.title = brOn
      ? "此 agent 可操作瀏覽器（點擊關閉存取）"
      : "此 agent 無瀏覽器存取（點擊開啟）";
    brToggle.addEventListener("click", () => {
      a.browserAccess = !brOn;
      persist();
      if (c && c.enabled) reconnectConn(i);              // re-handshake with/without browser server
      renderAgentList();
      updateRoster();
    });

    const del = document.createElement("button");
    del.className = "agent-delete";
    del.title = "刪除";
    del.textContent = "✕";
    del.addEventListener("click", () => deleteAgent(i));

    actions.appendChild(activeBtn);
    actions.appendChild(brToggle);
    actions.appendChild(del);

    row.appendChild(meta);
    row.appendChild(actions);
    agentListEl.appendChild(row);
  });
  updateAgentListStatus();
}

// Update just the per-row status dots/text (no input rebuild, so typing isn't disrupted).
function updateAgentListStatus() {
  if (!agentListEl) return;
  agentListEl.querySelectorAll(".agent-status").forEach((pill) => {
    const st = connState(room[+pill.dataset.idx]);
    pill.classList.remove("online", "connecting", "offline", "error");
    pill.classList.add(st.cls);
    const txt = pill.querySelector(".agent-status-text");
    if (txt) txt.textContent = st.label;
  });
}

function deleteAgent(i) {
  if (i < 0 || i >= agents.length) return;
  const wasActive = agents[i].url === activeAgentUrl;
  agents.splice(i, 1);
  if (agents.length === 0) agents = [{ ...DEFAULT_AGENT }];
  // If the active agent was deleted, pick a new one; otherwise keep it (still valid).
  activeAgentUrl = RoomCore.resolveActiveUrl(agents, wasActive ? null : activeAgentUrl);
  persist();
  buildRoom();      // disconnects the old room, rebuilds index-parallel to `agents`
  connectAll();     // connects only the active one
  renderAgentList();
  updateRoster();
}

// --- Pasted-image staging ----------------------------------------------------
// Screenshots pasted into the composer are staged as ACP image content blocks and previewed
// before send. Kept in memory only (never persisted to history) to avoid bloating storage.local.
// Composer owns the rules (accepted types, paste classification, the per-turn size budget).
const attachPreview = document.getElementById("attach-preview");
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;              // refuse to even decode beyond this
let stagedImages = [];                                   // [{ mimeType, data(base64), dataUrl }]
let stagedFiles = [];                                    // dropped text files: [{ name, size, text }]
let stagingChain = Promise.resolve();                    // serialize pastes so the budget check holds
let stagingPending = 0;                                  // pastes still encoding — send waits for them

function updateSendEnabled() {
  sendBtn.disabled = stagingPending > 0
    || (messageInput.value.trim().length === 0 && stagedImages.length === 0 && stagedFiles.length === 0);
}

function renderStagedPreviews() {
  if (!attachPreview) return;
  attachPreview.textContent = "";
  stagedImages.forEach((img, i) => {
    const thumb = document.createElement("div");
    thumb.className = "attach-thumb";
    const el = document.createElement("img");
    el.src = img.dataUrl;                                // our own canvas/FileReader output, safe
    el.alt = "pasted image";
    const rm = document.createElement("button");
    rm.className = "attach-remove";
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "移除";
    rm.addEventListener("click", () => { stagedImages.splice(i, 1); renderStagedPreviews(); updateSendEnabled(); });
    thumb.append(el, rm);
    attachPreview.appendChild(thumb);
  });
  // Text files: a chip (name + size), expanded into the prompt only on send (ADR chat-attachments §2.4).
  stagedFiles.forEach((f, i) => {
    const chip = fileChipEl(f);
    const rm = document.createElement("button");
    rm.className = "attach-remove";
    rm.type = "button";
    rm.textContent = "×";
    rm.title = "移除";
    rm.addEventListener("click", () => { stagedFiles.splice(i, 1); renderStagedPreviews(); updateSendEnabled(); });
    chip.appendChild(rm);
    attachPreview.appendChild(chip);
  });
  attachPreview.hidden = stagedImages.length === 0 && stagedFiles.length === 0;
}

// A text attachment as a chip — in the composer and in the sent bubble. Text only (textContent).
function fileChipEl(f) {
  const chip = document.createElement("div");
  chip.className = "attach-file";
  const name = Composer.displayName(f.name);
  chip.title = name;
  const label = document.createElement("span");
  label.className = "attach-file-name";
  label.textContent = `📎 ${name}`;
  const size = document.createElement("span");
  size.className = "attach-file-size";
  size.textContent = Composer.formatBytes(f.size);
  chip.append(label, size);
  return chip;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Fit one image into `budget` base64 chars: as-is if it is already small enough, else downscaled
// to MAX_IMAGE_EDGE and re-encoded as JPEG at falling quality. null if it still does not fit.
async function encodeForAgent(blob, budget) {
  const bmp = await createImageBitmap(blob);
  try {
    const { width, height } = Composer.fitDimensions(bmp.width, bmp.height, Composer.MAX_IMAGE_EDGE);
    if (width === bmp.width && height === bmp.height) {
      const img = Composer.parseImageDataUrl(await blobToDataUrl(blob));
      if (img && img.data.length <= budget) return img;
    }
    const canvas = new OffscreenCanvas(width, height);
    const ctx2d = canvas.getContext("2d");
    ctx2d.fillStyle = "#fff";                            // JPEG has no alpha — flatten onto white
    ctx2d.fillRect(0, 0, width, height);
    ctx2d.drawImage(bmp, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const img = Composer.parseImageDataUrl(await blobToDataUrl(await canvas.convertToBlob({ type: "image/jpeg", quality })));
      if (img && img.data.length <= budget) return img;
    }
    return null;
  } finally {
    bmp.close();
  }
}

// `target` = the conversation it was pasted / dropped in: a switch while it encodes must not move it
// into another conversation's composer (multi-conversation §4.8).
async function stageImages(blobs, target = currentConv) {
  for (const blob of blobs) {
    if (blob.size > MAX_SOURCE_BYTES) {
      appendSystemMessage(`圖片太大（約 ${Math.round(blob.size / 1048576)}MB），未附加`);
      continue;
    }
    if (!stagingTarget(target)) return;                  // its conversation was archived meanwhile
    const budget = Composer.MAX_TOTAL_IMAGE_B64 - Composer.stagedSize(stagingTarget(target).images);
    let img = null;
    try {
      img = budget > 0 ? await encodeForAgent(blob, budget) : null;
    } catch {
      appendSystemMessage("無法讀取這張圖片，未附加");
      continue;
    }
    if (!img) {
      appendSystemMessage("圖片超過單次傳送上限（所有圖片合計約 1MB，已縮小並壓縮過），未附加");
      continue;
    }
    const into = stagingTarget(target);
    if (!into) return;
    into.images.push({ ...img, dataUrl: `data:${img.mimeType};base64,${img.data}` });
    if (into.live) { renderStagedPreviews(); updateSendEnabled(); }
  }
}

// --- Dropped files (ADR docs/adr/chat-attachments.md) -------------------------
// The whole chat area takes files; what a file is comes from its bytes (Composer). Images join the
// paste pipeline above; text files become chips. Everything stays in memory.
const chatDropZone = chatView && chatView.querySelector(".chat-container");

async function stageDroppedFiles(files, target = currentConv) {
  const at = stagingTarget(target);
  if (!at) return;
  const plan = Composer.planDrop(at.images.length + at.files.length,
    files.map((f) => ({ size: f.size })), attachConfig.maxFileMB * 1024 * 1024);
  const names = (idx) => idx.map((i) => Composer.displayName(files[i].name)).join("、");
  if (plan.tooBig.length) appendSystemMessage(`檔案超過大小上限 ${attachConfig.maxFileMB} MB（${names(plan.tooBig)}），未附加。可到設定 → 附加檔案調整。`);
  if (plan.overCount.length) appendSystemMessage(`一則訊息最多附加 ${Composer.MAX_ATTACHMENTS} 個檔案（${names(plan.overCount)} 未附加）。`);
  const images = [];
  const binary = [];
  for (const i of plan.accept) {
    const file = files[i];
    const name = Composer.displayName(file.name);
    let kind;
    try {
      const head = new Uint8Array(await file.slice(0, Composer.SNIFF_BYTES).arrayBuffer());
      kind = Composer.classifyFileBytes(head, file.size <= Composer.SNIFF_BYTES).kind;
    } catch {
      appendSystemMessage(`無法讀取 ${name}（是資料夾嗎？），未附加`);
      continue;
    }
    if (kind === "image") { images.push(file); continue; }
    if (kind === "binary") { binary.push(name); continue; }
    // Never sendable at any cap setting — refuse before reading the whole file into memory.
    const hardCapKB = Composer.ATTACH_LIMITS.textCapKB[1];
    if (file.size > hardCapKB * 1024) {
      appendSystemMessage(`文字檔 ${name}（${Composer.formatBytes(file.size)}）超過可傳送的最大上限 ${Composer.formatBytes(hardCapKB * 1024)}，未附加`);
      continue;
    }
    let text = null;
    try { text = Composer.decodeText(new Uint8Array(await file.arrayBuffer())); } catch { /* reported below */ }
    if (text === null) {
      appendSystemMessage(`${name} 不是有效的 UTF-8 文字檔，未附加`);
      continue;
    }
    const into = stagingTarget(target);
    if (!into) return;
    into.files.push({ name: file.name, size: file.size, text });
    if (into.live) { renderStagedPreviews(); updateSendEnabled(); }
  }
  if (binary.length) appendSystemMessage(`不支援的檔案類型（看起來是二進位檔）：${binary.join("、")}，未附加`);
  if (!images.length) return;
  const active = room.find((c) => c.agent.url === activeAgentUrl);
  if (active && active.acpReady && !active.canImage) {
    appendSystemMessage(`${active.name} 不支援圖片，未附加`);
    return;
  }
  await stageImages(images, target);
}

function dragHasFiles(e) {
  return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files"));
}
function inDropZone(node) {
  return !!(chatDropZone && chatView.classList.contains("active") && node && chatDropZone.contains(node));
}
function setDropHighlight(on) {
  if (chatDropZone) chatDropZone.classList.toggle("drop-active", on);
}
// Document-level so a file dropped anywhere else in the panel is ignored instead of replacing the
// panel with the file (the browser default).
document.addEventListener("dragover", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  const ok = inDropZone(e.target);
  e.dataTransfer.dropEffect = ok ? "copy" : "none";
  setDropHighlight(ok);
});
document.addEventListener("dragleave", (e) => {
  if (!dragHasFiles(e)) return;
  if (!inDropZone(e.relatedTarget)) setDropHighlight(false);     // left the chat area (or the panel)
});
document.addEventListener("drop", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  setDropHighlight(false);
  if (!inDropZone(e.target)) return;
  const files = Array.from(e.dataTransfer.files || []);
  if (!files.length) return;
  stagingPending++;
  updateSendEnabled();
  const target = currentConv;
  stagingChain = stagingChain
    .then(() => stageDroppedFiles(files, target))
    .catch(() => appendSystemMessage("檔案處理失敗，未附加"))     // keep the chain alive
    .finally(() => { stagingPending--; updateSendEnabled(); });
});
document.addEventListener("dragend", () => setDropHighlight(false));

// --- Message input -----------------------------------------------------------
messageInput.addEventListener("input", () => {
  updateSendEnabled();
  messageInput.style.height = "auto";
  messageInput.style.height = (messageInput.scrollHeight - 2) + "px";
});

messageInput.addEventListener("paste", (e) => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const plan = Composer.classifyPaste(items.map((it) => ({ kind: it.kind, type: it.type })));
  if (plan.rejected.length) {
    appendSystemMessage(`不支援的圖片格式（${plan.rejected.join("、")}），只接受 PNG / JPEG / GIF / WebP`);
  }
  if (plan.images.length === 0) return;                  // text (Office/Sheets copies too) — paste normally
  e.preventDefault();                                    // don't also paste the image's path/text into the box
  const active = room.find((c) => c.agent.url === activeAgentUrl);
  if (active && active.acpReady && !active.canImage) {
    appendSystemMessage(`${active.name} 不支援圖片，未附加`);
    return;
  }
  const blobs = plan.images.map((i) => items[i].getAsFile()).filter(Boolean);
  stagingPending++;
  updateSendEnabled();
  const target = currentConv;
  stagingChain = stagingChain
    .then(() => {
      // Counted when the chain gets here, after any drop still being staged.
      const at = stagingTarget(target);
      if (!at) return undefined;
      const room = Math.max(0, Composer.MAX_ATTACHMENTS - at.images.length - at.files.length);
      if (blobs.length > room) appendSystemMessage(`一則訊息最多附加 ${Composer.MAX_ATTACHMENTS} 個檔案，${blobs.length - room} 張圖片未附加。`);
      return stageImages(blobs.slice(0, room), target);
    })
    .catch(() => appendSystemMessage("圖片處理失敗，未附加"))  // keep the chain alive for later pastes
    .finally(() => { stagingPending--; updateSendEnabled(); });
});

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && replyTarget) {
    e.preventDefault();
    setReplyTarget(null);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

// Stop every in-flight turn (each conn sends its own session/cancel).
if (stopBtn) stopBtn.addEventListener("click", () => { if (conversationId) room.forEach((c) => c.cancelTurn(conversationId)); });

// Panel closing: best-effort cancel any in-flight turn so the gateway stops the agent-core turn
// instead of leaving it running to completion (whose reply is then dropped as stale). This is the
// client half of session teardown; reaping the server-side agent process is a gateway-side fix.
window.addEventListener("pagehide", () => { room.forEach((c) => c.cancelTurn()); });

// Anchors in rendered markdown open in a real browser tab — navigating inside the side panel is
// broken UX. Re-validate the scheme at click time (http(s)/mailto only); never trust the
// post-sanitize href blindly (ADR §3.5). Delegated so it covers every current/future bubble.
messagesList.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href]");
  if (!a || !messagesList.contains(a)) return;
  const url = (a.getAttribute("href") || "").trim();
  // http(s) opens in a real tab (side-panel navigation is broken UX); re-validate the scheme at
  // click time. mailto: falls through to the browser's default handler (the mail client) — routing
  // it through chrome.tabs.create would open a blank tab.
  if (/^https?:/i.test(url)) {
    e.preventDefault();
    chrome.tabs.create({ url });
  }
});

// Route a user turn per mode (@mention → addressed agents only; else broadcast) and reset the
// cascade — a human message always breaks any agent↔agent loop. User text is sent under a
// [time user (↩ quoted)] header (RoomCore.framePrompt; the gateway adds its own sender_context on
// top); agent→agent relay stays <message from>-wrapped. @mention routing reads the raw text.
function sendMessage() {
  if (!currentConv) { appendSystemMessage("目前沒有開著的對話：先封存一段，或從 🗂️ 總覽重新打開。"); return; }
  const text = messageInput.value.trim();
  const images = stagedImages.slice();                   // snapshot the staged attachments
  const files = stagedFiles.slice();
  if (stagingPending > 0) return;                        // Enter mid-encode: don't strand the image for the next message
  if (!text && images.length === 0 && files.length === 0) return;
  // Text cap on send (ADR chat-attachments §2.3): refuse, never truncate; keep everything staged.
  const capError = Composer.textCapError(files, attachConfig.textCapKB * 1024);
  if (capError) { appendSystemMessage(capError); return; }
  const replyTo = replyTarget;                           // what this message answers (or null)
  setReplyTarget(null);
  postUserText(text, images, replyTo, undefined, files);
  // Q6 (multi-conversation §4.3): at the send — never mid-turn — bring the conversation's working
  // tab to the front if the user is looking at another tab.
  switchToWorkingTab(conversationId).catch(() => {});

  messageInput.value = "";
  messageInput.style.height = "auto";
  stagedImages = [];
  stagedFiles = [];
  renderStagedPreviews();
  sendBtn.disabled = true;
}

// Post a message as the user: show it, frame it, route it to the room. Shared by the input box and
// the canvas's Send to agent / Send error (which compose their text in the canvas tab, §3.7).
// `mentions` (optional): route by these @names instead of parsing `text` — a canvas push carries
// canvas data that must not pick the recipients. `files` (optional): dropped text files, expanded
// after the text in what the agent receives; routing still reads only `text`. Returns the agents it
// was enqueued to.
function postUserText(text, images, replyTo, mentions, files) {
  images = images || [];
  files = files || [];
  if (!currentConv) return [];
  // Q4 (ADR ask-user §2.3): a message instead of answering closes the open ask cards OF THIS
  // CONVERSATION (multi-conversation §3.8); nothing is sent for them, this message goes out as usual.
  supersedePendingAsks(conversationId);
  maybeAutoTitle(currentConv, text);                     // §3.3: the first user message names it
  // Unique per ms in this panel: the header's milliseconds name exactly this message (#62 follow-up).
  const sentAt = uniqueMsgMs(Date.now());
  appendMessage({
    senderId: myUserId, senderName: myUserName, text, timestamp: sentAt,
    images: images.map((i) => i.dataUrl),                // show what we sent (not persisted to history)
    files: files.map((f) => ({ name: f.name, size: f.size })), // chips only; content is never kept
    replyTo,
  });
  // What the agent receives: a [time sender (↩ quoted)] header + the text, so a batched backlog
  // keeps its message boundaries and a reply says what it answers (RoomCore.framePrompt).
  const framed = RoomCore.framePrompt({
    timestamp: sentAt, senderName: "user",
    replyTo: replyTo && { timestamp: replyTo.timestamp, senderName: promptName(replyTo.senderName), text: replyTo.text },
  }, Composer.expandAttachments(text, files));

  loopGuard.onHuman();
  const targets = RoomCore.resolveTargets(roomMembers(), myUserId, { mode: roomConfig.mode, text, mentions });
  const sentTo = [];
  targets.forEach((id) => {
    const c = connById(id);
    if (c) { c.enqueue(framed, images); sentTo.push(c); }
  });
  return sentTo;
}

// §3.7: a canvas tab asks this panel to post as the user (Send to agent / Ask agent / Send error). Only from
// Katashiro's own canvas.html (never a content script in a web page), only for a conversation open
// in THIS panel (every open panel hears the broadcast), only while an agent is connected, capped,
// and deduped by request id against double clicks. Multi-conversation §3.10: an open but not
// current conversation is switched to first (refused while the current one is replying); one open
// nowhere (archived, or left in a closed window) is refused by the panel of the canvas tab's window.
const seenPushIds = new Set();
// From Katashiro's own canvas.html, never a compare tab (§3.10), never a content script in a web page.
function fromCanvasTab(sender) {
  try {
    const u = new URL(sender && sender.url);
    return sender.id === chrome.runtime.id && u.origin === new URL(chrome.runtime.getURL("")).origin && u.pathname === "/canvas.html"
      && !u.searchParams.get("view");
  } catch (_) { return false; }                                       // no or bad url
}
// A canvas request for conversation `cid`, not open in this panel. Held by another panel → that one
// answers. Free → no panel has it, and the panel of the canvas tab's window says what is really the
// case (P1b §4.8): open in another window whose panel is closed, or not open anywhere (archived).
// → the onMessage return value (true: answered later).
function refuseNotHere(cid, sender, sendResponse) {
  if (!ConvCore.isConvId(cid) || !sender.tab || sender.tab.windowId !== panelWindowId) return false;
  navigator.locks.query().then(async (st) => {
    if ((st.held || []).some((l) => l.name === `conv:${cid}`)) return;
    const [windows, live] = await Promise.all([convStore.readWindows(), liveWindowIds()]);
    const r = ConvCore.pushRefusal({ windows, liveIds: live, id: cid, ownWindowId: panelWindowId });
    sendResponse({ ok: false, error: r.text, windowId: r.windowId == null ? null : Number(r.windowId) });
  }).catch(() => sendResponse({ ok: false, error: ConvCore.ARCHIVED_PUSH_TEXT }));
  return true;
}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-canvas-push") return false;
  if (!fromCanvasTab(sender)) {
    sendResponse({ ok: false, error: "not from a Katashiro canvas" });
    return false;
  }
  const cid = msg.conversationId;
  if (!convs.has(cid)) return refuseNotHere(cid, sender, sendResponse);
  if (typeof msg.text !== "string" || !msg.text.trim() || msg.text.length > CanvasCore.PUSH_TEXT_MAX || typeof msg.note !== "string") {
    sendResponse({ ok: false, error: "nothing to send, or too long" });
    return false;
  }
  if (typeof msg.reqId !== "string" || seenPushIds.has(msg.reqId)) { sendResponse({ ok: false, error: "duplicate" }); return false; }
  const active = connById(activeAgentUrl);
  if (!active || !active.initialized) { sendResponse({ ok: false, error: "the agent is not connected" }); return false; }
  if (cid !== conversationId) switchConversation(cid);   // P2: never blocked, a running reply continues behind
  seenPushIds.add(msg.reqId);
  // @mentions come from the user's note only, never from the diff / error text inside the fence.
  const sentTo = postUserText(msg.text, [], null, RoomCore.parseMentions(msg.note));
  if (!sentTo.length) { sendResponse({ ok: false, error: "no agent in this conversation received it" }); return false; }
  // §4.3: the user is working in this canvas tab; the next send from the composer stays here.
  if (sender.tab && Number.isInteger(sender.tab.id)) noteWorkingTab(cid, sender.tab.id).catch(() => {});
  // A canvas tab in another window posts here: it says so (P1b §4.8), or the user sees nothing happen.
  sendResponse({ ok: true, agent: sentTo.map((c) => c.name).join("、"), elsewhere: !!sender.tab && sender.tab.windowId !== panelWindowId });
  return false;
});

// §3.7 To chat input (Brett 2026-10-13 01:12): a canvas tab's 📨 puts the selected text into the
// input box of the canvas's conversation. Nothing is sent: the user reads it, edits it and sends it
// as their own message (so it is the user's words by design, unlike a push's fenced data). Same gate
// and refusals as a push (Katashiro's canvas.html, the conversation open in THIS panel, deduped by
// request id); no agent has to be connected. An open but not current conversation is switched to,
// as for a push (P2: never blocked); should it still not be current, the text goes into that
// conversation's draft instead (`draft: true`). A draft is kept: the text goes after it on a new
// line (CanvasCore.inputWithSelection). Capped at the frame's selection cap (refused over it).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-canvas-to-input") return false;
  if (!fromCanvasTab(sender)) {
    sendResponse({ ok: false, error: "not from a Katashiro canvas" });
    return false;
  }
  const cid = msg.conversationId;
  if (!convs.has(cid)) return refuseNotHere(cid, sender, sendResponse);
  if (typeof msg.text !== "string" || !msg.text.trim() || msg.text.length > CanvasCore.SELECTION_MAX) {
    sendResponse({ ok: false, error: "nothing to put in, or too long" });
    return false;
  }
  if (typeof msg.reqId !== "string" || seenPushIds.has(msg.reqId)) { sendResponse({ ok: false, error: "duplicate" }); return false; }
  seenPushIds.add(msg.reqId);
  const conv = convs.get(cid);
  if (cid !== conversationId) switchConversation(cid);
  const elsewhere = !!sender.tab && sender.tab.windowId !== panelWindowId;
  if (conv !== currentConv) {
    if (!conv.draft) conv.draft = { text: "", images: [], files: [] };
    conv.draft.text = CanvasCore.inputWithSelection(conv.draft.text, msg.text);
    sendResponse({ ok: true, draft: true, elsewhere });
    return false;
  }
  messageInput.value = CanvasCore.inputWithSelection(messageInput.value, msg.text);
  messageInput.dispatchEvent(new Event("input"));       // its height, the send button
  messageInput.focus();
  messageInput.setSelectionRange(messageInput.value.length, messageInput.value.length);
  messageInput.scrollTop = messageInput.scrollHeight;
  sendResponse({ ok: true, elsewhere });
  return false;
});

// §3.7 To chat input, then Enter (Brett 2026-10-13 16:31): this panel's focus() cannot take the
// keyboard focus from the canvas tab, so the canvas tab reads Enter itself after a 📨 and asks this
// panel to send its input exactly as the send button would (sendMessage). Same gate as To chat
// input (Katashiro's canvas.html, never a compare tab or a web page; the conversation open in THIS
// panel; deduped by request id). Refused unless the canvas's conversation is the one on screen (its
// input box holds the text — a draft in another conversation is never sent from here), the input
// is not empty, and no earlier request is still being sent. The canvas tab becomes the working tab
// first (§4.3, as for a push: the user is working there), so the send does not move them off it.
let canvasSubmitPending = false;
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-canvas-submit-input") return false;
  if (!fromCanvasTab(sender)) {
    sendResponse({ ok: false, error: "not from a Katashiro canvas" });
    return false;
  }
  const cid = msg.conversationId;
  if (!convs.has(cid)) return refuseNotHere(cid, sender, sendResponse);
  if (typeof msg.reqId !== "string" || seenPushIds.has(msg.reqId)) { sendResponse({ ok: false, error: "duplicate" }); return false; }
  seenPushIds.add(msg.reqId);
  const isCurrent = () => cid === conversationId && !!currentConv && convs.get(cid) === currentConv;
  const refused = CanvasCore.submitInputRefusal({ isCurrent: isCurrent(), inputText: messageInput.value, busy: canvasSubmitPending || stagingPending > 0 });
  if (refused) { sendResponse({ ok: false, ...refused }); return false; }
  canvasSubmitPending = true;
  const elsewhere = !!sender.tab && sender.tab.windowId !== panelWindowId;
  const tabId = sender.tab && Number.isInteger(sender.tab.id) ? sender.tab.id : null;
  (tabId == null ? Promise.resolve() : noteWorkingTab(cid, tabId).catch(() => {})).then(() => {
    // Checked again: the user may have switched conversations or cleared the input meanwhile.
    const late = CanvasCore.submitInputRefusal({ isCurrent: isCurrent(), inputText: messageInput.value, busy: stagingPending > 0 });
    if (late) { sendResponse({ ok: false, ...late }); return; }
    sendMessage();
    // sendMessage clears the input when it sent; else it said why in the panel (a text cap, …).
    if (messageInput.value === "") sendResponse({ ok: true, elsewhere });
    else sendResponse({ ok: false, error: "側邊欄沒送出（原因寫在側邊欄）" });
  }).finally(() => { canvasSubmitPending = false; });
  return true;
});

// Relay an agent's finalized reply into the room so OTHER agents can see + respond to it — the
// "talk to each other like a Discord thread" mechanic. Wrapped with attribution, routed per
// mode, and bounded by the loop guard (surfaces a system line once when the cascade is paused).
// `convId`: the conversation the reply was in — a relay goes to the other agents' sessions of that
// same conversation (P2 §5: it may not be the one on screen).
function relayAgentReply(originConn, text, convId = conversationId) {
  if (!text || !text.trim()) return;
  const guard = loopGuard.onAgentRelay();
  if (!guard.allowed) {
    if (guard.tripped) {
      appendSystemMessage(`⏸️ 已暫停 agent 互相接話（連續 ${guard.cap} 次）— 你說句話就繼續。`);
    }
    return;
  }
  const targets = RoomCore.resolveTargets(roomMembers(), originConn.id, {
    mode: roomConfig.mode,
    text,
  });
  if (!targets.length) return;
  const wrapped = RoomCore.wrapRelay(originConn.name, text);
  targets.forEach((id) => {
    const c = connById(id);
    if (c && convs.has(convId)) c.enqueue(wrapped, [], c.stateFor(convId));
  });
}

// --- Rendering helpers -------------------------------------------------------
// --- Tool pill details (hover tooltip + click expander) ---------------------------
// Everything here renders via textContent / the `title` property. The arguments arrive already
// masked by browser-mcp.js (per-tool `redact` hooks); this side never sees raw args.

// `{ref:"e12", button:"right"}` — compact one-line form of the masked arguments.
function formatToolArgs(v, depth = 0) {
  if (v === undefined || v === null) return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return String(v);
  if (depth > 3) return "…";
  if (Array.isArray(v)) return `[${v.map((x) => formatToolArgs(x, depth + 1)).join(", ")}]`;
  const parts = Object.entries(v)
    .filter(([, x]) => x !== undefined)
    .map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}:${formatToolArgs(x, depth + 1)}`);
  return `{${parts.join(", ")}}`;
}

function toolCommandLine(t) {
  if (t.args == null) return `${t.verb} (參數未顯示)`;
  const a = formatToolArgs(t.args);
  return a === "{}" ? t.verb : `${t.verb} ${a}`;
}

function toolTooltip(t) {
  const cmd = toolCommandLine(t);
  const shortCmd = cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd;
  if (t.phase === "start") return `${shortCmd}\n⏳ 執行中…`;
  const mark = t.phase === "error" ? "✗" : "✓";
  const ms = typeof t.ms === "number" ? ` · ${t.ms} ms` : "";
  return `${shortCmd}\n${mark} ${t.summary || (t.phase === "error" ? "失敗" : "完成")}${ms}\n（點擊展開詳情）`;
}

// One expander per tool strip, shown under it; clicking the open pill again collapses it.
function toggleToolDetail(s, pill) {
  if (s.toolDetailPill === pill) {
    if (s.toolDetail) s.toolDetail.remove();
    s.toolDetail = null;
    s.toolDetailPill = null;
    pill.classList.remove("expanded");
    return;
  }
  if (s.toolDetailPill) s.toolDetailPill.classList.remove("expanded");
  s.toolDetailPill = pill;
  pill.classList.add("expanded");
  renderToolDetail(s, pill);
}

function renderToolDetail(s, pill) {
  const t = pill.toolInfo;
  if (!t) return;
  if (!s.toolDetail) {
    s.toolDetail = document.createElement("div");
    s.toolDetail.className = "tool-detail";
    s.toolStrip.after(s.toolDetail);
  }
  const d = s.toolDetail;
  d.replaceChildren();
  const head = document.createElement("div");
  head.className = "tool-detail-head";
  const status = t.phase === "start" ? "⏳ 執行中" : t.phase === "error" ? "✗ 失敗" : "✓ 成功";
  head.textContent = `${t.name} · ${status}${typeof t.ms === "number" ? ` · ${t.ms} ms` : ""}`;
  const argsLabel = document.createElement("div");
  argsLabel.className = "tool-detail-label";
  argsLabel.textContent = "參數";
  const argsPre = document.createElement("pre");
  argsPre.textContent = t.args == null ? "(參數未顯示)" : JSON.stringify(t.args, null, 2);
  d.append(head, argsLabel, argsPre);
  if (t.phase !== "start") {
    const resLabel = document.createElement("div");
    resLabel.className = "tool-detail-label";
    resLabel.textContent = "結果";
    const resPre = document.createElement("pre");
    resPre.textContent = t.preview || t.summary || "(無文字結果)";
    d.append(resLabel, resPre);
  }
  maybeScroll();
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} (TPE)`;
}

// Build message rows with createElement + textContent for everything EXCEPT the message body,
// which is markdown → sanitized HTML via the single `renderMarkdown` sink (ADR §3.2). senderName
// stays textContent (never trusted to innerHTML). `text` is remote-controlled (agent output, or a
// handshake error echoed from a malicious/MITM server), so it may reach innerHTML ONLY through
// renderMarkdown — DOMPurify is the XSS guard that textContent used to be.
// --- canvas helpers ----------------------------------------------------------------
// The panel's canvas store: chrome.storage.local, serialized by Web Locks shared with the canvas
// tabs (same extension origin), per canvas-store.js.
const canvasStore = CanvasStore.createCanvasStore({
  storage: chrome.storage.local,
  lock: (name, fn) => navigator.locks.request(name, fn),
  // Over the budget (§3.6): never evict a canvas open in a tab, and ask once, here in the
  // panel (the agent's write arrives here; no canvas tab may be open).
  isOpen: async (id) => !!(await findCanvasTab(id)),
  // A confirm card, not window.confirm (#80); the write waits on it (no lock held, §3.6). An
  // agent's write passes its own (ctx.canvas.confirmEvict, in its turn). This default is only a
  // fallback, with no caller today: the panel makes no user save (canvas.js saves through its own
  // store, which has no confirmEvict, so a user save over budget fails with a quota error, no card).
  confirmEvict: (info) => confirmEvictCard(info, null),
});

function confirmEvictCard({ evict }, conn, st = null) {
  return confirmCard({
    title: "畫布儲存空間已滿",
    lines: [
      `要刪除最久沒打開的 ${evict.length} 個畫布嗎？這個動作無法復原。`,
      ...evict.slice(0, 10).map((e) => `• ${e.title}`),
      ...(evict.length > 10 ? [`…還有 ${evict.length - 10} 個`] : []),
    ],
  }, { conn, st, notAskedNote: conn ? `${conn.name} 的回合已結束，清出畫布儲存空間的要求未執行（沒有詢問你）。` : "" });
}

// --- canvas folder mirror (ADR §3.6; decisions and file writes in canvas-mirror.js) -----------
// The panel writes the agent's saves (and anything else that changes a canvas while it is open);
// canvas tabs write their own saves, so the folder stays current with the panel closed. Both are
// serialized by the canvas:<id> lock, and a sync with nothing new is a no-op. Writes happen only
// while Chrome already grants access: the panel never prompts on its own (that needs a click).
// #98: while a canvas tab is open, an agent markdown write is mirrored once, after that tab's
// normalization (bounded wait, CanvasMirror.createNormalizeHold); with none open, at once as before.
// A new canvas (v1) waits too: canvas_open opens its tab right after the write (onCanvasWrite).
const canvasNormalizeHold = CanvasMirror.createNormalizeHold({
  rendering: async (id, meta) => meta.version === 1 || !!(await findCanvasTab(id)),
  retry: (id) => { canvasMirrorPending.add(id); runCanvasMirror(); },
});
const canvasMirror = CanvasMirror.createCanvasMirror({
  storage: chrome.storage.local,
  lock: (name, fn) => navigator.locks.request(name, fn),
  getRoot: () => CanvasMirror.grantedRoot(),
  holdForNormalization: canvasNormalizeHold.hold,
});
const canvasMirrorPending = new Set();
let canvasMirrorRunning = false;
async function runCanvasMirror() {
  if (canvasMirrorRunning) return;
  canvasMirrorRunning = true;
  try {
    while (canvasMirrorPending.size) {
      const id = canvasMirrorPending.values().next().value;
      canvasMirrorPending.delete(id);
      try { await canvasMirror.sync(id); } catch (_) { /* recorded in meta.file by the mirror */ }
    }
  } finally {
    canvasMirrorRunning = false;
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [k, ch] of Object.entries(changes)) {
    const m = /^canvas:(cv_[0-9a-f]{12}):(meta|latest)$/.exec(k);
    if (!m || ch.newValue === undefined) continue;            // deleted: the files stay (§3.6)
    // The mirror's own bookkeeping is not a content change.
    if (m[2] === "meta" && !changes[CanvasStore.latestKey(m[1])] && CanvasMirror.onlyMirrorFieldsChanged(ch.oldValue, ch.newValue)) continue;
    canvasMirrorPending.add(m[1]);
  }
  if (canvasMirrorPending.size) runCanvasMirror();
});
// Multi-conversation §7 / #101: a conversation's mirror folder follows its title. A title change
// moves nothing by itself; once it has settled (CanvasMirror.TITLE_SETTLE_MS without another change)
// the conversation's canvases are synced, which moves their files to the new folder in one go.
const canvasTitleSettle = CanvasMirror.createTitleSettle({
  settled: (convId) => { canvasMirror.syncConversation(convId).catch(() => {}); },
});
chrome.storage.onChanged.addListener((changes, area) => {
  const ch = area === "local" && changes[CanvasMirror.CONV_INDEX_KEY];
  if (ch) canvasTitleSettle.changed(CanvasMirror.convTitlesChanged(ch.oldValue, ch.newValue));
});

// Settings → 畫布存到資料夾. Picking and reconnecting need this click (File System Access).
const canvasFolderStatusEl = document.getElementById("canvas-folder-status");
// Settings → 畫布版本紀錄 (§3.5): N in chrome.storage.local, where every canvas store (this panel's
// and each canvas tab's) reads it on every write. Clamped on save (CanvasStore.historyLimit), and the
// input shows the clamped value; other panels follow through storage.onChanged.
const canvasHistoryMaxInput = document.getElementById("canvas-history-max");
if (canvasHistoryMaxInput) {
  const K = CanvasStore.HISTORY_MAX_KEY;
  const show = (raw) => { canvasHistoryMaxInput.value = String(CanvasStore.historyLimit(raw)); };
  chrome.storage.local.get(K).then((got) => show(got[K]), () => show(undefined));
  canvasHistoryMaxInput.addEventListener("change", () => {
    const n = CanvasStore.historyLimit(canvasHistoryMaxInput.value);
    show(n);
    chrome.storage.local.set({ [K]: n }).catch(() => {});
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[K] && document.activeElement !== canvasHistoryMaxInput) show(changes[K].newValue);
  });
}

const canvasFolderPickBtn = document.getElementById("canvas-folder-pick");
const canvasFolderReconnectBtn = document.getElementById("canvas-folder-reconnect");
const canvasFolderStopBtn = document.getElementById("canvas-folder-stop");
async function renderCanvasFolder(extra = "") {
  if (!canvasFolderStatusEl) return;
  const show = (pick, reconnect, stop) => {
    canvasFolderPickBtn.hidden = !pick;
    canvasFolderReconnectBtn.hidden = !reconnect;
    canvasFolderStopBtn.hidden = !stop;
  };
  if (typeof globalThis.showDirectoryPicker !== "function") { canvasFolderStatusEl.textContent = "這個瀏覽器不支援選擇資料夾（File System Access）。"; show(false, false, false); return; }
  const st = await CanvasMirror.folderStatus();
  if (!st.configured) {
    canvasFolderStatusEl.textContent = `未設定：畫布只存在這個 Chrome 設定檔裡。${extra}`;
    canvasFolderPickBtn.textContent = "📁 選擇資料夾";
    show(true, false, false);
  } else if (st.permission === "granted") {
    canvasFolderStatusEl.textContent = `✅ 寫入中：「${st.name}」${extra}`;
    canvasFolderPickBtn.textContent = "📁 換資料夾";
    show(true, false, true);
  } else {
    canvasFolderStatusEl.textContent = `⚠️ 「${st.name}」需要重新授權（瀏覽器重開後常見）。在那之前畫布照常存在 Katashiro 裡，連上後會補寫進資料夾。${extra}`;
    canvasFolderPickBtn.textContent = "📁 換資料夾";
    show(true, true, true);
  }
}
async function afterCanvasFolderConnected() {
  await renderCanvasFolder("（正在補寫…）");
  let counts = {};
  try { counts = await canvasMirror.syncAll(); } catch (_) { /* per-canvas state is in meta */ }
  const wrote = (counts.write || 0) + (counts.conflict || 0) + (counts.adopt || 0);
  const failed = counts.error || 0;
  await renderCanvasFolder(wrote || failed ? `（寫入 ${wrote} 個畫布${failed ? `，${failed} 個失敗` : ""}）` : "");
}
if (canvasFolderPickBtn) {
  canvasFolderPickBtn.addEventListener("click", async () => {
    try {
      await CanvasMirror.pickFolder();                  // the picker must open within this click
    } catch (e) {
      if (!e || e.name !== "AbortError") await renderCanvasFolder(`（沒有設定成功：${String((e && e.message) || e).slice(0, 120)}）`);
      return;
    }
    await afterCanvasFolderConnected();
  });
  canvasFolderReconnectBtn.addEventListener("click", async () => {
    if (await CanvasMirror.requestAccess()) await afterCanvasFolderConnected();
    else await renderCanvasFolder("（沒有取得權限）");
  });
  canvasFolderStopBtn.addEventListener("click", async () => {
    if (!confirm("停止把畫布寫進資料夾？資料夾裡已經寫好的檔案會保留。")) return;
    try { await CanvasMirror.stopMirror(); } catch (_) { /* nothing stored */ }
    await renderCanvasFolder();
  });
}

// §3.5: after an agent markdown write, wait (briefly) for an open canvas tab to normalize it, then
// return { diff } — raw → stored text ("" if unchanged) — or null if no tab rendered it in time.
const CANVAS_NORMALIZE_WAIT_MS = 4000;
async function waitCanvasNormalized(id, version, raw) {
  if (!(await findCanvasTab(id))) return null;           // nothing will render it now
  const key = CanvasStore.metaKey(id);
  const done = (m) => m && (m.agentVersion !== version || m.normalized === true);
  const ready = await new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; chrome.storage.onChanged.removeListener(onChange); clearTimeout(timer); resolve(v); };
    const onChange = (changes, area) => { if (area === "local" && changes[key] && done(changes[key].newValue)) finish(true); };
    const timer = setTimeout(() => finish(false), CANVAS_NORMALIZE_WAIT_MS);
    chrome.storage.onChanged.addListener(onChange);
    chrome.storage.local.get(key).then((got) => { if (done(got[key])) finish(true); }, () => {});
  });
  if (!ready) return null;
  const stored = await canvasStore.readAgentCopy(id);
  if (stored == null || typeof raw !== "string") return null;
  return { diff: CanvasStore.unifiedDiff(raw, stored) || "" };
}

// canvas_goto: bring the canvas's tab to the front (opening it if needed) and ask it — an extension
// page, reached by runtime messaging — to show slide N. A freshly opened tab may not listen yet,
// so retry for a few seconds. Returns { ok, index, total } or { ok:false, error }, plus the tabId it
// put in front (the working tab, multi-conversation §4.3).
async function gotoCanvasSlide(id, slide) {
  const tab = await openCanvasTab(id, { active: true });
  const r = await askCanvasTab({ type: "katashiro-canvas-goto", id, slide });
  return tab ? { ...r, tabId: tab.id } : r;
}

// Ask the canvas tab (runtime messaging; only canvas tabs of that id answer, never compare tabs),
// retrying for a few seconds while a fresh tab starts listening.
const CANVAS_TAB_TIMEOUT = "the canvas tab did not answer in time";
async function askCanvasTab(msg, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Each send is bounded by what is left of the deadline: a listener that returned true but never
    // answers must not hold the tool call (Jellyfish #79).
    let timer;
    const timeout = new Promise((res) => { timer = setTimeout(() => res(null), Math.max(0, deadline - Date.now())); });
    let r;
    try { r = await Promise.race([chrome.runtime.sendMessage(msg), timeout]); }
    catch (_) { r = undefined; }
    clearTimeout(timer);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 300));
  }
  return { ok: false, error: CANVAS_TAB_TIMEOUT };
}

// canvas_highlight (§3.10): an open tab is asked first and brought to the front only once it has
// shown the block — while the user edits it answers `deferred` and must not take focus. A canvas
// not open in a tab is opened in front (nobody is editing it). Returns the canvas tab's answer, plus
// the tabId when it put the tab in front (the working tab, multi-conversation §4.3).
async function highlightCanvasBlock(id, req) {
  const existing = await findCanvasTab(id);
  let front = existing ? null : await openCanvasTab(id, { active: true });
  const r = await askCanvasTab({ type: "katashiro-canvas-highlight", id, ...req });
  if (existing && r && r.ok && !r.deferred) {
    try {
      const tab = (await findCanvasTab(id)) || existing;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      front = tab;
    } catch (_) { /* highlighted either way */ }
  }
  return front && r ? { ...r, tabId: front.id } : r;
}

// canvas_inject_css: every open tab of the canvas takes the sheet (each listens; the first answer
// is the result), like canvas_highlight an open tab comes to the front only once it applied it, and
// a canvas not open is opened in front. `clear` never opens or moves a tab: no tab, no sheets.
async function injectCanvasCss(id, req) {
  const existing = await findCanvasTab(id);
  if (req.clear && !existing) return { ok: true, sheets: 0 };
  let front = existing ? null : await openCanvasTab(id, { active: true });
  const r = await askCanvasTab({ type: "katashiro-canvas-css", id, ...req });
  if (existing && !req.clear && r && r.ok) {
    try {
      const tab = (await findCanvasTab(id)) || existing;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      front = tab;
    } catch (_) { /* applied either way */ }
  }
  return front && r ? { ...r, tabId: front.id } : r;
}

// --- canvas_view / canvas_gallery (§3.11): the user's display switches, for the agent ----------
// ◐ 顯示變更 is one switch for every canvas tab: writing it here is what a click in a tab does, and
// every canvas tab follows through storage.onChanged. → { was } (the state before).
async function setCanvasShowChanges(on) {
  const k = CanvasCore.SHOW_CHANGES_KEY;
  const was = (await chrome.storage.local.get(k))[k] === true;
  if (was !== on) await chrome.storage.local.set({ [k]: on });
  return { was };
}

// ⇆ Compare with agent's: pre-checked from storage (a canvas that cannot compare is not opened for
// nothing), then the canvas tab (the open one, or a new one in front) runs the button's own path, which
// asks this panel back (katashiro-canvas-compare) — so this must not run under canvasTabQueue.
// Only the picked tab answers (two tabs of one canvas must not both open a compare). An open tab is
// brought to the front only once the compare started: while the user edits it refuses, and must not
// take focus (Jellyfish #123). Its answer waits on the tab queue, so the deadline is longer than other
// asks; past it, a compare tab that did open meanwhile still counts (Jellyfish #123).
const COMPARE_ASK_MS = 20000;
async function startCanvasCompare(id) {
  let c, agentCopy;
  try {
    c = await canvasStore.read({ conversationId, id });
    agentCopy = await canvasStore.readAgentCopy(id);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  const blocked = CanvasCore.compareBlocker({ kind: c.kind, author: c.author, agentCopy, content: c.content, editing: false, framed: true });
  if (blocked) return { ok: false, error: blocked };
  const base = chrome.runtime.getURL("canvas.html");
  const existing = await findCanvasTab(id);
  const tab = existing || (await openCanvasTab(id, { active: true }));
  // The working tab (multi-conversation §4.3) is the canvas tab even when a plain compare tab is in
  // front: ✕ closes the compare tab, and a closed working tab would leave Q6 with nothing (Jellyfish #141).
  let shown = existing ? null : tab;
  let r = await askCanvasTab({ type: "katashiro-canvas-compare-start", id, tabId: tab.id }, COMPARE_ASK_MS);
  if (!r.ok && r.error === CANVAS_TAB_TIMEOUT) {
    if (!CanvasTabs.compareTabsFor(await chrome.tabs.query({}), base, id).length) {
      return { ok: false, error: `${CANVAS_TAB_TIMEOUT}; the compare may still open — check the tabs before asking again` };
    }
    r = { ok: true };                       // it did open: shown below like any started compare
  }
  if (existing && r.ok) {
    // Started: now show it — the compare tab when it opened as a plain tab, else the canvas tab
    // (Split View brings its pair along).
    try {
      const cmp = CanvasTabs.compareTabsFor(await chrome.tabs.query({}), base, id)[0];
      const canvasTab = (await findCanvasTab(id)) || existing;
      const front = cmp && cmp.active ? cmp : canvasTab;
      await chrome.tabs.update(front.id, { active: true });
      await chrome.windows.update(front.windowId, { focused: true });
      shown = canvasTab;
    } catch (_) { /* compared either way */ }
  }
  return shown ? { ...r, tabId: shown.id } : r;
}

// ✕ 結束比較: close that canvas's compare tab(s), as the button does; the canvas tab sees the close
// and clears its compare markers (§3.10). → { ok, closed }
async function endCanvasCompare(id) {
  const tabs = CanvasTabs.compareTabsFor(await chrome.tabs.query({}), chrome.runtime.getURL("canvas.html"), id);
  if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id));
  return { ok: true, closed: tabs.length };
}

// 🗂️: the panel's gallery button, optionally with the search box filled (#q=, sanitised there).
function openCanvasGallery(query) {
  return CanvasTabs.openGalleryTab(chrome, chrome.runtime.getURL("canvas-gallery.html"), { windowId: typeof panelWindowId === "number" ? panelWindowId : undefined, query });
}

function canvasTabUrl(id) {
  return CanvasTabs.canvasTabUrl(chrome.runtime.getURL("canvas.html"), id);
}

async function findCanvasTab(id) {
  // Match patterns do not cover chrome-extension://, so list tabs and compare URLs (needs "tabs").
  // Several tabs of one canvas: the most recently used (§3.1); never a compare tab.
  return CanvasTabs.pickCanvasTab(await chrome.tabs.query({}), chrome.runtime.getURL("canvas.html"), id);
}

// Canvas gallery (§3.7): a row click asks the panel that has that canvas's conversation OPEN
// (current or not, multi-conversation §3.10) to open it, so it goes through openCanvasTab (focus the
// most recently used tab, or open it in that conversation's canvas group) without switching. Only
// from Katashiro's own canvas-gallery.html; a conversation open nowhere is left to the gallery,
// which opens the tab itself, ungrouped, when no panel answers.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-canvas-open") return false;
  let fromGallery = false;
  try {
    const u = new URL(sender && sender.url);
    fromGallery = sender.id === chrome.runtime.id && u.origin === new URL(chrome.runtime.getURL("")).origin && u.pathname === "/canvas-gallery.html";
  } catch (_) { /* no or bad url */ }
  if (!fromGallery || !CanvasStore.ID_RE.test(String(msg.id))) { sendResponse({ ok: false, error: "not from the Katashiro canvas gallery" }); return false; }
  if (!convs.has(msg.conversationId)) return false;                  // another window's panel answers
  // Answer once the tab exists, not after grouping: the group queue has no timeout, and a stalled
  // queue must not make the gallery report a failed open for a tab that is already there.
  let answered = false;
  const answer = (r) => { if (!answered) { answered = true; sendResponse(r); } };
  openCanvasTab(msg.id, { active: true, conv: msg.conversationId, onTab: () => answer({ ok: true }) })
    .then(() => answer({ ok: true }), (e) => answer({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

const canvasGalleryBtn = document.getElementById("canvas-gallery-btn");
if (canvasGalleryBtn) {
  canvasGalleryBtn.addEventListener("click", () => {
    openCanvasGallery().catch(() => {});
  });
}

// Focus the canvas's tab, or open it (in the panel's window, after the active tab) and put it in
// its conversation's canvas group (§3.1; `conv`, the current one by default). A tab found by URL
// stays wherever the user left it. `onTab` is called as soon as the tab is created, before the
// (cosmetic) grouping.
async function openCanvasTab(id, { active = true, onTab, conv = conversationId } = {}) {
  const existing = await findCanvasTab(id);
  if (existing) {
    if (active) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing;
  }
  const opts = { url: canvasTabUrl(id), active };
  if (typeof panelWindowId === "number") opts.windowId = panelWindowId;
  const tab = await chrome.tabs.create(opts);
  if (onTab) onTab(tab);
  // Grouping is cosmetic: a failure (old Chrome, no tabGroups, the tab already closed) never fails
  // the open. Re-read so callers see the tab's group.
  try {
    await canvasTabQueue(() => addToCanvasGroup(tab, conv), conv);
    return (await chrome.tabs.get(tab.id)) || tab;
  } catch (_) {
    return tab;
  }
}

// --- canvas tab group + Split View (§3.1; decisions in canvas-tabs.js) -----------------------
// One queue per conversation for its group / split moves (§3.1 "one queue per conversation";
// multi-conversation §3.10), so two quick canvas_open calls create one group, not two. A queued fn
// must not call openCanvasTab or canvasTabQueue for the same conversation: it would wait on itself.
// No timeout — a Chrome call that never settles stalls later group moves (accepted for phase 1).
const canvasTabChains = new Map();                       // conversationId → chain
function canvasTabQueue(fn, conv = conversationId) {
  const run = (canvasTabChains.get(conv) || Promise.resolve()).then(fn, fn);
  canvasTabChains.set(conv, run.catch(() => {}));
  return run;
}

const canGroupTabs = () => !!(chrome.tabGroups && typeof chrome.tabGroups.update === "function" && typeof chrome.tabs.group === "function");
const canSplitTabs = () => typeof chrome.tabs.createSplit === "function";

// A conversation's group id (taken explicitly, §3.10): in memory, mirrored to storage.session
// (survives a panel reload, not a browser restart — group ids do not either). Always verified before reuse.
const canvasGroupIds = new Map();                       // conversationId → groupId
const canvasGroupKey = (conv) => `katashiro.canvasGroup.${conv}`;
async function storedCanvasGroupId(conv) {
  if (canvasGroupIds.has(conv)) return canvasGroupIds.get(conv);
  try {
    const k = canvasGroupKey(conv);
    const got = await chrome.storage.session.get(k);
    if (Number.isInteger(got[k])) canvasGroupIds.set(conv, got[k]);
  } catch (_) { /* no storage.session: memory only */ }
  return canvasGroupIds.has(conv) ? canvasGroupIds.get(conv) : null;
}
async function rememberCanvasGroupId(conv, groupId) {
  canvasGroupIds.set(conv, groupId);
  try { await chrome.storage.session.set({ [canvasGroupKey(conv)]: groupId }); } catch (_) { /* memory only */ }
}
// The group is named after its conversation (§3.3, replacing "Canvas").
const canvasGroupTitle = (conv) => ConvCore.displayTitle(convIndex[conv], conv);
async function updateCanvasGroupTitle(conv) {
  if (!canGroupTabs()) return;
  const gid = await storedCanvasGroupId(conv);
  if (gid == null) return;
  try { await chrome.tabGroups.update(gid, { title: canvasGroupTitle(conv) }); } catch (_) { /* gone, or cosmetic */ }
}

// Put a tab in its conversation's canvas group in the tab's window: reuse the stored group if it
// still exists there, else create one (titled after the conversation, fixed color). Returns the
// group id, or null without tabGroups.
async function addToCanvasGroup(tab, conv = conversationId) {
  if (!canGroupTabs()) return null;
  const stored = await storedCanvasGroupId(conv);
  let groups = [];
  if (stored != null) { try { groups = [await chrome.tabGroups.get(stored)]; } catch (_) { /* gone */ } }
  const plan = CanvasTabs.planCanvasGroup({ storedGroupId: stored, groups, windowId: tab.windowId });
  if (plan.action === "reuse") {
    await chrome.tabs.group({ groupId: plan.groupId, tabIds: [tab.id] });
    return plan.groupId;
  }
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await rememberCanvasGroupId(conv, groupId);
  try { await chrome.tabGroups.update(groupId, { title: canvasGroupTitle(conv) || CanvasTabs.GROUP_TITLE, color: CanvasTabs.GROUP_COLOR }); } catch (_) { /* cosmetic */ }
  return groupId;
}

// --- one tab group per conversation (multi-conversation ADR §4; plans in canvas-tabs.js) -----------
// The canvas group above is the conversation's group: it also takes the tabs the agent opens
// (new_tab). The GROUP is the membership: a tab the user drags out is theirs again.
const canvasBase = () => chrome.runtime.getURL("canvas.html");

// A conversation's group id if that group still exists, else null.
async function liveGroupId(conv) {
  if (!canGroupTabs()) return null;
  const gid = await storedCanvasGroupId(conv);
  if (gid == null) return null;
  try { await chrome.tabGroups.get(gid); return gid; } catch (_) { return null; }
}
async function forgetCanvasGroupId(conv) {
  canvasGroupIds.delete(conv);
  try { await chrome.storage.session.remove(canvasGroupKey(conv)); } catch (_) { /* memory only */ }
}

// §4.3: the agent of conversation `convId` acted on `tabId` (opened it, with o.opened). → false when
// the tab could not be recorded (or, opened, could not join the group), else true.
async function noteWorkingTab(convId, tabId, { opened = false } = {}) {
  const conv = convs.get(convId);
  if (!conv || !Number.isInteger(tabId)) return false;
  const tab = await getTab(tabId);
  if (!tab) return false;
  // §4.1: an agent-opened tab joins the conversation's group (a tab the user opened never does).
  // A conversation not on screen works in that group: if the user collapsed it by hand, expand it —
  // Chrome freezes the pages of a collapsed group (Q8, §5.2).
  let grouped = true;
  if (opened) {
    const gid = await canvasTabQueue(() => addToCanvasGroup(tab, convId), convId).catch(() => null);
    grouped = gid != null;
    if (grouped && convId !== conversationId) await expandGroup(gid);
  }
  conv.workingTab = { id: tab.id, url: tab.url || tab.pendingUrl || "", at: Date.now() };
  saveConv(conv);
  return grouped;
}

// Q8 (§5.2) safeguard: Katashiro never collapses a conversation's group (Q5), but the user may do
// so by hand, and Chrome freezes the pages of a collapsed tab group (a freezing vote per tab) — a
// frozen page runs no timers or scripts, so a background conversation's page tools would stall.
// Expanding its group lifts that; it moves no tab and activates nothing.
async function expandGroup(gid) {
  if (gid == null || !canGroupTabs()) return;
  try {
    const g = await chrome.tabGroups.get(gid);
    if (g && g.collapsed) await chrome.tabGroups.update(gid, { collapsed: false });
  } catch (_) { /* gone: the tab check already decided */ }
}

// §4.3: the working tab, re-validated (same id + origin, else the exact URL), or null.
async function resolveWorkingTab(convId) {
  const conv = convs.get(convId);
  if (!conv || !conv.workingTab) return null;
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch (_) { return null; }
  return CanvasTabs.pickWorkingTab({ saved: conv.workingTab, tabs });
}

// P2 Q8 (§5): the tab a conversation NOT on screen may act on — the one it names (switch_tab,
// close_tab), else its working tab — checked by ConvCore.backgroundTabRefusal: in its own group,
// not a tab the user is on, no write while the user is on one of its group's tabs. → { tab } | { error }.
// "The user is on" = the active tab of EVERY window: an unfocused window on another screen is seen too.
// The tab the agent may act on gets its group expanded (expandGroup: a collapsed group is frozen).
async function backgroundTabFor(convId, { tabId = null, write = false } = {}) {
  const named = tabId != null;
  const tab = named ? await getTab(tabId) : await resolveWorkingTab(convId);
  const groupId = await liveGroupId(convId);
  const userTabs = [];
  try { userTabs.push(...await chrome.tabs.query({ active: true })); } catch (_) { /* no tab API: nothing known to be in front */ }
  const error = ConvCore.backgroundTabRefusal({ tab, groupId, userTabs, write, named });
  if (error) return { error };
  await expandGroup(groupId);
  return { tab };
}

// Q6 (§4.3): the user pressed send. If the conversation has a working tab in this window and it is
// not the active tab, activate it now — at the send, never during the turn.
async function switchToWorkingTab(convId) {
  if (typeof panelWindowId !== "number") return;
  const t = await resolveWorkingTab(convId);
  if (!t || t.windowId !== panelWindowId || t.active) return;
  try { await chrome.tabs.update(t.id, { active: true }); } catch (_) { /* closed meanwhile, or being dragged */ }
}

// §4.4: conv.groupTabs follows the group (debounced). A conversation with no known group (after a
// browser restart, before its tabs came back) keeps the list it has.
const groupTabsTimers = new Map();
function scheduleGroupTabsRefresh(convId) {
  clearTimeout(groupTabsTimers.get(convId));
  groupTabsTimers.set(convId, setTimeout(() => { groupTabsTimers.delete(convId); refreshGroupTabs(convId).catch(() => {}); }, 400));
}
function scheduleAllGroupTabsRefresh() { for (const id of convs.keys()) scheduleGroupTabsRefresh(id); }
async function refreshGroupTabs(convId) {
  const conv = convs.get(convId);
  if (!conv || !canGroupTabs()) return;
  const gid = await storedCanvasGroupId(convId);
  if (gid == null) return;
  let tabs;
  try { tabs = await chrome.tabs.query({ groupId: gid }); } catch (_) { return; }
  const urls = CanvasTabs.groupTabUrls(tabs, gid, canvasBase());
  if (convs.get(convId) !== conv || JSON.stringify(urls) === JSON.stringify(conv.groupTabs)) return;
  conv.groupTabs = urls;
  saveConv(conv);
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!("url" in changeInfo) && !("groupId" in changeInfo)) return;
  scheduleAllGroupTabsRefresh();
  // The working tab's URL follows navigation, so its origin check (§4.3) stays meaningful.
  if ("url" in changeInfo) {
    for (const conv of convs.values()) {
      if (conv.workingTab && conv.workingTab.id === tabId && conv.workingTab.url !== changeInfo.url) {
        conv.workingTab = { ...conv.workingTab, url: changeInfo.url };
        saveConv(conv);
      }
    }
  }
});
// A tab closed with its window (also the browser quitting) leaves the lists alone: they are what
// brings the tabs back (§4.4).
chrome.tabs.onRemoved.addListener((_tabId, info) => { if (!(info && info.isWindowClosing)) scheduleAllGroupTabsRefresh(); });
if (chrome.tabs.onAttached) chrome.tabs.onAttached.addListener(() => scheduleAllGroupTabsRefresh());
if (chrome.tabs.onDetached) chrome.tabs.onDetached.addListener(() => scheduleAllGroupTabsRefresh());

// §4.4: a conversation comes back (browser-restart adoption, 重新打開): open its group's tabs again
// in the background, adopting the ones already open (by URL) instead of opening them twice. Not
// when its group still exists (a panel reload, a plain switch).
async function restoreGroupTabs(convId) {
  const conv = convs.get(convId);
  if (!conv || !conv.groupTabs.length || typeof panelWindowId !== "number") return;
  if ((await liveGroupId(convId)) != null) return;
  await canvasTabQueue(async () => {
    const all = await chrome.tabs.query({});
    const others = await CanvasTabs.otherGroupIds([...convs.keys()], convId, storedCanvasGroupId);
    const plan = CanvasTabs.planGroupRestore({ urls: conv.groupTabs, tabs: all, windowId: panelWindowId, otherGroupIds: others });
    const ids = [...plan.adopt];
    for (const url of plan.open) {
      try { ids.push((await chrome.tabs.create({ url, active: false, windowId: panelWindowId })).id); } catch (_) { /* a URL Chrome will not open */ }
    }
    if (!ids.length || !canGroupTabs()) return;
    let gid = plan.reuseGroupId;
    if (gid != null) {
      await rememberCanvasGroupId(convId, gid);
      await chrome.tabs.group({ groupId: gid, tabIds: ids });
    } else {
      gid = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: panelWindowId } });
      await rememberCanvasGroupId(convId, gid);
    }
    try { await chrome.tabGroups.update(gid, { title: canvasGroupTitle(convId), color: CanvasTabs.GROUP_COLOR }); } catch (_) { /* cosmetic */ }
  }, convId);
}

// Q5 (§4.2): after a switch, expand the current conversation's group (the user may have collapsed
// it by hand) and, if the active tab sits in another conversation's group, activate one outside it.
// No group is collapsed — a conversation's group stays until archive (§4.5). Serialized; best effort.
let groupSwitchChain = Promise.resolve();
function applyGroupSwitch() {
  const run = groupSwitchChain.then(async () => {
    const cur = conversationId;
    if (!cur || !canGroupTabs() || typeof panelWindowId !== "number") return;
    const tabs = await chrome.tabs.query({ windowId: panelWindowId });
    const groupId = await storedCanvasGroupId(cur);
    const others = await CanvasTabs.otherGroupIds([...convs.keys()], cur, storedCanvasGroupId);
    const conv = convs.get(cur);
    const working = conv && conv.workingTab ? CanvasTabs.pickWorkingTab({ saved: conv.workingTab, tabs }) : null;
    const plan = CanvasTabs.planGroupSwitch({ tabs, groupId, otherGroupIds: others, workingTabId: working ? working.id : null });
    if (cur !== conversationId) return;                  // switched again meanwhile: the next run decides
    if (plan.activate != null) await chrome.tabs.update(plan.activate, { active: true });
    if (plan.expand != null) { try { await chrome.tabGroups.update(plan.expand, { collapsed: false }); } catch (_) { /* gone */ } }
  });
  groupSwitchChain = run.catch(() => {});
  return groupSwitchChain;
}

// §4.5: may this canvas tab be closed? Asks that tab (only it answers); no answer in time → treated
// as dirty: an edit must never be lost to an archive. A discarded / unloaded tab holds no editor.
async function canvasTabDirty(tab) {
  if (tab.discarded || tab.status === "unloaded") return false;
  let timer;
  const timeout = new Promise((res) => { timer = setTimeout(() => res(null), 1500); });
  let r;
  try { r = await Promise.race([chrome.runtime.sendMessage({ type: "katashiro-canvas-dirty", tabId: tab.id }), timeout]); } catch (_) { r = null; }
  clearTimeout(timer);
  return !(r && r.dirty === false);
}

// §4.5: archive closes the group's tabs (they come back with it, §4.4), keeping any canvas tab with
// unsaved edits, and never the window's last tab.
async function closeConversationTabs(gid, title) {
  if (gid == null || !canGroupTabs()) return;
  const all = await chrome.tabs.query({});
  const inGroup = all.filter((t) => t.groupId === gid);
  if (!inGroup.length) return;
  const win = inGroup[0].windowId;
  const dirty = [];
  for (const t of inGroup) if (CanvasTabs.classifyTab(t, canvasBase()) === "canvas" && (await canvasTabDirty(t))) dirty.push(t.id);
  const plan = CanvasTabs.planArchiveClose({ tabs: all.filter((t) => t.windowId === win), groupId: gid, dirtyIds: dirty });
  if (plan.needNewTab) await chrome.tabs.create({ windowId: win, active: true });
  if (plan.close.length) await chrome.tabs.remove(plan.close);
  if (plan.keep.length) {
    try { await chrome.tabGroups.update(gid, { collapsed: true }); } catch (_) { /* cosmetic */ }
    appendSystemMessage(`「${title}」有 ${plan.keep.length} 個畫布分頁還有未儲存的修改（或沒有回應），沒有關掉；存好後可以自己關。`);
  }
}

// §4.6 katashiro.set_title: the calling conversation's name, decided again under the index lock
// (the user may have renamed it meanwhile; a user title always wins).
async function setAgentTitle(convId, title) {
  if (!convs.has(convId)) return { ok: false, error: "this conversation was closed in Katashiro" };
  let out = null;
  await convStore.updateIndex((idx) => {
    out = ConvCore.agentTitledEntry(idx[convId] || convIndex[convId] || freshIndexEntry(), title);
    if (!out.ok) return undefined;
    idx[convId] = out.entry;
    return idx;
  });
  if (!out || !out.ok) return out || { ok: false, error: "not renamed" };
  convIndex[convId] = { ...(convIndex[convId] || freshIndexEntry()), title: out.title, titleSource: "agent" };
  renderConvTabs();
  updateCanvasGroupTitle(convId);
  return { ok: true, title: out.title };
}

// Canvas tabs moved out of their group for a split: canvasTabId → { movedToGroupId, windowId,
// returnGroupId, canvasGroup, pageTabId, conv }. In memory only: a panel reload forgets them, and those
// tabs simply stay in the page's group (acceptable, §3.1).
const canvasSplitMoves = new Map();

const getTab = (tabId) => chrome.tabs.get(tabId).catch(() => null);

// The split ended or the page closed: put the canvas tab back, if nothing else moved it.
async function restoreCanvasTab(tabId) {
  const record = canvasSplitMoves.get(tabId);
  if (!record) return;
  const tab = await getTab(tabId);
  if (tab && CanvasTabs.inSplit(tab)) return;          // still split: keep the record
  let groups = [];
  if (record.returnGroupId !== CanvasTabs.TAB_GROUP_NONE) {
    try { groups = [await chrome.tabGroups.get(record.returnGroupId)]; } catch (_) { /* gone */ }
  }
  const plan = CanvasTabs.planRestore({ canvasTab: tab, record, groups });
  // The record is dropped only once the move worked: a rejected call (e.g. "Tabs cannot be edited
  // right now" while the user drags a tab) keeps it, so the next sweep tries again. No cooldown or
  // attempt cap (Brett, 2026-10-11, #90): retries come only with a canvas_open or a tab event.
  if (plan.action === "group") await chrome.tabs.group({ groupId: plan.groupId, tabIds: [tabId] });
  else if (plan.action === "ungroup") await chrome.tabs.ungroup([tabId]);
  else if (plan.action === "recreate") await addToCanvasGroup(tab, record.conv || conversationId);
  if (canvasSplitMoves.get(tabId) === record) canvasSplitMoves.delete(tabId);
}

// Lazy fallback (§3.1): if Chrome sent no "split ended" event, the next canvas_open moves back
// whatever is no longer split.
async function sweepCanvasRestores() {
  for (const tabId of [...canvasSplitMoves.keys()]) {
    try { await restoreCanvasTab(tabId); } catch (_) { /* best effort */ }
  }
}

// Whether tabs.onUpdated reports splitViewId changes has not been tested live; the sweep above
// covers it if not. A closed page ends its split, so its canvas tab goes back too.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!canvasSplitMoves.has(tabId) || !("splitViewId" in changeInfo)) return;
  canvasTabQueue(() => restoreCanvasTab(tabId), canvasSplitMoves.get(tabId).conv).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (canvasSplitMoves.delete(tabId)) return;          // the canvas tab itself closed
  for (const [canvasTabId, r] of canvasSplitMoves) {
    if (r.pageTabId === tabId) canvasTabQueue(() => restoreCanvasTab(canvasTabId), r.conv).catch(() => {});
  }
});

// Compare with agent's (§3.10): the canvas tab asks; this panel opens the read-only compare tab
// (canvas.html?id=…&view=agent) and splits it with the canvas tab. Only from that canvas tab itself
// (Katashiro's canvas.html, the same id, not a compare tab, a content script or another page), and
// only for this window's conversation (every open panel hears it).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-canvas-compare") return false;
  let fromCanvasTab = false;
  try {
    const u = new URL(sender && sender.url);
    fromCanvasTab = sender.id === chrome.runtime.id && !!sender.tab && u.origin === new URL(chrome.runtime.getURL("")).origin &&
      u.pathname === "/canvas.html" && CanvasTabs.classifyTab(sender.tab, chrome.runtime.getURL("canvas.html")) === "canvas" &&
      u.searchParams.get("id") === msg.id && !u.searchParams.get("view");
  } catch (_) { /* no or bad url */ }
  if (!fromCanvasTab) { sendResponse({ ok: false, error: "not from a Katashiro canvas tab" }); return false; }
  if (!convs.has(msg.conversationId)) return false;                  // another window's panel answers
  canvasTabQueue(() => compareCanvasTab(sender.tab.id, msg.id), msg.conversationId)
    .then((r) => sendResponse(r), (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

// Under the canvas tab queue. Ends a split the canvas tab is in (and moves it back to its group
// under the §3.1 rules), then opens the compare tab beside it in the canvas tab's group and splits
// them. The earlier split is not restored afterwards. Never leaves a half-made compare tab behind
// if the canvas tab closes mid-way. → { ok, note? } | { ok: false, error }
async function compareCanvasTab(canvasTabId, id) {
  const base = chrome.runtime.getURL("canvas.html");
  let c = await getTab(canvasTabId);
  const existing = (await chrome.tabs.query({})).find((t) => CanvasTabs.isCompareTabFor(t, base, id)) || null;
  const plan = CanvasTabs.planCompare({ canvasTab: c, compareTab: existing, canSplit: canSplitTabs() });
  if (!plan.ok) return { ok: false, error: plan.reason };
  if (plan.action === "focus") {
    await chrome.tabs.update(existing.id, { active: true });
    return { ok: true };
  }
  if (plan.closeOld != null) { try { await chrome.tabs.remove(plan.closeOld); } catch (_) { /* already gone */ } }
  if (plan.unsplit != null) {
    try { await chrome.tabs.unsplit(plan.unsplit); } catch (e) { return { ok: false, error: `could not end the current Split View: ${(e && e.message) || e}` }; }
    try { await restoreCanvasTab(canvasTabId); } catch (_) { /* stays where it is */ }
    c = await getTab(canvasTabId);
    if (!c) return { ok: false, error: "the canvas tab closed" };
  }
  const created = await chrome.tabs.create(CanvasTabs.compareTabProps(c, CanvasTabs.compareTabUrl(base, id), plan.split));
  // Re-read after every await (§3.1); the compare tab follows the canvas tab's group.
  const fresh = async () => [await getTab(canvasTabId), await getTab(created.id)];
  let [cv, cmp] = await fresh();
  if (!cv) { try { await chrome.tabs.remove(created.id); } catch (_) { /* gone */ } return { ok: false, error: "the canvas tab closed" }; }
  if (!cmp) return { ok: false, error: "the compare tab closed" };
  const g = CanvasTabs.groupOf(cv);
  if (canGroupTabs() && CanvasTabs.groupOf(cmp) !== g) {
    try {
      if (g === CanvasTabs.TAB_GROUP_NONE) await chrome.tabs.ungroup([cmp.id]);
      else await chrome.tabs.group({ groupId: g, tabIds: [cmp.id] });
    } catch (_) { /* the split check below decides */ }
    [cv, cmp] = await fresh();
    if (!cv || !cmp) { if (cmp) { try { await chrome.tabs.remove(cmp.id); } catch (_) { /* gone */ } } return { ok: false, error: "a tab closed while opening the compare view" }; }
  }
  const asTab = async (why) => {
    await chrome.tabs.update(cmp.id, { active: true });
    return { ok: true, note: `比較畫面開在一般分頁：${why}` };
  };
  if (!plan.split) return asTab("這個瀏覽器沒有 Split View（需要 Chrome 155+）");
  const blocked = CanvasTabs.splitBlocker(cv, cmp);
  if (blocked) return asTab(blocked);
  try {
    await chrome.tabs.createSplit([cv.id, cmp.id]);
  } catch (e) {
    return asTab(`could not create the split: ${(e && e.message) || e}`);
  }
  return { ok: true };
}

// canvas_open(…, beside: "current"): Split View with the active tab of the panel's window.
// Returns the note for the tool result — never throws (the canvas is saved either way).
async function showCanvasBeside(id, created, conv = conversationId) {
  try {
    if (!canSplitTabs()) {
      await openCanvasTab(id, { active: true, conv });
      return "Split View is unavailable in this browser (needs Chrome 155+); its tab was brought to the front instead";
    }
    const canvasTab = await openCanvasTab(id, { active: false, conv });
    const note = await canvasTabQueue(() => splitCanvasWithActive(canvasTab, conv), conv);
    if (note.ok) return note.text;
    await openCanvasTab(id, { active: true, conv });
    return `${created ? "opened" : "its tab was brought to the front"}, not in Split View: ${note.text}`;
  } catch (e) {
    return `not shown in Split View: ${(e && e.message) || e}`;
  }
}

async function splitCanvasWithActive(canvasTab, conv = conversationId) {
  const query = { active: true };
  if (typeof panelWindowId === "number") query.windowId = panelWindowId;
  const [page] = await chrome.tabs.query(query);
  const canvasBase = chrome.runtime.getURL("canvas.html");
  const plan = CanvasTabs.planBeside({ canvasTab, pageTab: page, canvasBase });
  if (!plan.ok) return { ok: false, text: plan.reason };
  // Re-read after every await (§3.1): the user may close or move either tab mid-sequence.
  const fresh = async () => [await getTab(canvasTab.id), await getTab(page.id)];
  let record = null;
  const rollback = async () => {
    if (!record) return;
    canvasSplitMoves.set(canvasTab.id, record);
    try { await restoreCanvasTab(canvasTab.id); } catch (_) { /* best effort */ }
  };
  // Follows the page's group as it is now (the user may have dragged the page elsewhere), and the
  // record always names the group the canvas tab was put in, so planRestore still recognises it.
  const from = CanvasTabs.groupOf(canvasTab);
  const regroup = async (c, p) => {
    const g = CanvasTabs.groupOf(p);
    if (CanvasTabs.groupOf(c) === g) return;
    if (!record) {
      const stored = await storedCanvasGroupId(conv);
      record = {
        windowId: canvasTab.windowId, pageTabId: page.id, returnGroupId: from,
        canvasGroup: from !== CanvasTabs.TAB_GROUP_NONE && from === stored, conv,
      };
    }
    record.movedToGroupId = CanvasTabs.groupOf(c);      // where Katashiro's moves have left it so far
    if (g === CanvasTabs.TAB_GROUP_NONE) await chrome.tabs.ungroup([c.id]);
    else await chrome.tabs.group({ groupId: g, tabIds: [c.id] });
    record.movedToGroupId = g;                          // only once Chrome has moved it
  };
  try {
    if (plan.regroup) await regroup(canvasTab, page);
    let [c, p] = await fresh();
    if (!c || !p) { await rollback(); return { ok: false, text: "a tab closed while moving it" }; }
    const to = CanvasTabs.adjacentIndex(p, c);
    if (to != null) {
      await chrome.tabs.move(c.id, { index: to });
      [c, p] = await fresh();
      if (!c || !p) { await rollback(); return { ok: false, text: "a tab closed while moving it" }; }
      await regroup(c, p);                              // a move can pull a tab into / out of a group
      [c, p] = await fresh();
      if (!c || !p) { await rollback(); return { ok: false, text: "a tab closed while moving it" }; }
    }
    const blocked = CanvasTabs.splitBlocker(c, p);
    if (blocked) { await rollback(); return { ok: false, text: blocked }; }
    await chrome.tabs.createSplit([p.id, c.id]);
  } catch (e) {
    await rollback();
    return { ok: false, text: `could not create the split: ${(e && e.message) || e}` };
  }
  if (record) canvasSplitMoves.set(canvasTab.id, record);
  // The page title is page content: bounded (by code point, so no half emoji), JSON-quoted, and
  // only ever a label.
  const t = Array.from(String(page.title || page.url || "the page")).slice(0, 80).join("");
  return { ok: true, text: `shown beside ${JSON.stringify(t)} in Split View` };
}

// The chat card for a canvas write: "📄 <title> · v<N> — 開啟". Title is agent text → textContent.
function canvasCard({ id, version, title, conv = conversationId }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "canvas-card";
  const icon = document.createElement("span");
  icon.className = "canvas-card-icon";
  icon.textContent = "📄";
  const name = document.createElement("span");
  name.className = "canvas-card-title";
  name.textContent = String(title || "Canvas").slice(0, 120);
  const meta = document.createElement("span");
  meta.className = "canvas-card-meta";
  meta.textContent = `v${version} — 開啟`;
  card.append(icon, name, meta);
  card.title = "在分頁中開啟這個畫布";
  card.addEventListener("click", () => { openCanvasTab(id, { active: true, conv }).catch(() => {}); });
  return card;
}

// --- confirm card (#80) ---------------------------------------------------------------
// A yes/no question in the chat instead of window.confirm, which blocked the panel's main thread:
// every agent connection, heartbeat and tool call in the room froze until the user answered.
// Nothing here blocks, several cards can wait at once, and each one declines itself after
// ConfirmCore.TIMEOUT_MS (2 minutes) — or when the agent turn it was asked in ends. The text rules and the decision live in confirm-core.js.
// Every string goes in with textContent (agent text included), and the card is a "system" element:
// the 🔒 header and its border come from sidepanel.css on an element markdown cannot produce
// (html:false, and the card sits outside any .bubble), so an agent reply cannot imitate one.
// General on purpose (title / lines / labels / timeout). ask_user has its own card (below): an
// agent's question must not look like this one.
const pendingConfirms = new Map();                       // decision → the conversation it was asked in

/**
 * Ask the user on a card in the chat: in `conn`'s turn while it is in flight, else as its own row.
 * Asked for an agent (`conn`) whose turn has already ended: no card, declined at once
 * (ConfirmCore.shouldAsk) — only a small non-interactive note (`notAskedNote`) says what was dropped.
 * @param {{ title: string, lines?: string[], allowLabel?: string, denyLabel?: string, timeoutMs?: number }} spec
 * @returns {Promise<boolean>} true only if the user clicked allow; a timeout, a cleared chat, the
 *   end of `conn`'s turn, or a turn that had ended before asking is false
 */
function confirmCard(spec, opts) {
  return confirmOutcome(spec, opts).then((o) => o.ok);
}

/** confirmCard, resolving { ok, state } (state: allowed / denied / timeout / cancelled / ended / skipped). */
// `st`: the asking conversation's session state (P2 §5: the card goes into ITS turn, on screen or not);
// without one, the conversation on screen's state of `conn`.
function confirmOutcome(spec, { conn = null, st = null, notAskedNote = "" } = {}) {
  if (conn && !st) st = conn.cur;
  if (!ConfirmCore.shouldAsk({ forAgent: !!conn, turnActive: !!(st && st.turnActive) })) {
    if (notAskedNote) inConv(st ? convs.get(st.convId) : null, () => appendSystemMessage(notAskedNote));
    return Promise.resolve(ConfirmCore.NOT_ASKED);
  }
  const s = ConfirmCore.normalizeSpec(spec);
  const card = document.createElement("div");
  card.className = "confirm-card pending";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", s.title);
  const head = document.createElement("div");
  head.className = "confirm-card-head";
  const lockIcon = document.createElement("span");
  lockIcon.className = "confirm-card-lock";
  lockIcon.textContent = "🔒";
  lockIcon.title = "Katashiro 的確認，不是 agent 的訊息";
  const title = document.createElement("span");
  title.className = "confirm-card-title";
  title.textContent = s.title;
  head.append(lockIcon, title);
  card.appendChild(head);
  for (const line of s.lines) {
    const el = document.createElement("div");
    el.className = "confirm-card-line";
    el.textContent = line;
    card.appendChild(el);
  }
  const hint = document.createElement("div");
  hint.className = "confirm-card-hint";
  hint.textContent = ConfirmCore.timeoutHint(s);
  const actions = document.createElement("div");
  actions.className = "confirm-card-actions";
  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "confirm-card-deny";
  deny.textContent = s.denyLabel;
  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "confirm-card-allow";
  allow.textContent = s.allowLabel;
  actions.append(deny, allow);                           // no autofocus: a stray Enter must not answer
  const result = document.createElement("div");
  result.className = "confirm-card-result";
  result.hidden = true;
  card.append(hint, actions, result);

  // Asked in a turn: the card sits in that turn and declines when it ends (finalizeStream). P2 §5:
  // the turn may be in a conversation not on screen — ❓ on its tab and a notification (Q12); its
  // 2-minute clock is wall-clock (a 🔒 card holds the agent's tool call open, ≤ 170 s per call).
  if (conn && st && st.turnActive && (!st.stream || !st.stream.bubble)) conn.startStream(st);
  const turn = conn && st && st.turnActive ? st.stream : null;
  const askedIn = st ? st.convId : conversationId;

  // The card stays in the chat with the outcome; the buttons go, so a late click cannot act.
  const decision = ConfirmCore.createDecision({
    timeoutMs: s.timeoutMs,
    onSettle: (state) => {
      pendingConfirms.delete(decision);
      renderConvTabs();
      if (turn) turn.confirms.delete(decision);
      hint.remove();
      actions.remove();
      card.className = `confirm-card ${state === "allowed" ? "allowed" : "declined"}`;
      result.textContent = ConfirmCore.outcomeText(state, s);
      result.hidden = false;
    },
  });
  pendingConfirms.set(decision, askedIn);
  if (turn) (turn.confirms || (turn.confirms = new Set())).add(decision);
  allow.addEventListener("click", () => decision.allow());
  deny.addEventListener("click", () => decision.deny());

  inConv(convs.get(askedIn), () => {
    if (turn) {
      turn.contentEl.insertBefore(card, turn.bubble);
    } else {
      const row = document.createElement("div");
      row.className = "message system";
      row.appendChild(card);
      outList().appendChild(row);
    }
    maybeScroll();
  });
  if (askedIn !== conversationId && convs.has(askedIn)) { renderConvTabs(); notifyWaitingCard(askedIn); }
  return decision.outcome;
}

// Every card still waiting in conversation `convId` resolves as declined (its chat is being
// cleared, or it is archived); 🧹 cancels only the current conversation's (§3.8).
function cancelPendingConfirms(convId) {
  for (const [d, c] of [...pendingConfirms]) if (!convId || c === convId) d.cancel();
}

// --- ask card (katashiro.ask_user, ADR docs/adr/ask-user.md) -------------------------------------
// An agent's multiple-choice question. Unlike the confirm card it is the AGENT talking, not the
// system: no 🔒, its own border and accent (sidepanel.css), and a title the panel writes
// ("<agent> 問你"); the agent supplies only the question and labels, as plain text (AskCore).
// Asynchronous: the tool has already returned when the user answers, so the answer goes to the
// asking agent as a new prompt through its own queue (Conn.enqueue) — batched into its next turn if
// one is running. A card does not close when the turn ends; it closes on an answer, on a timeout that
// counts only visible time (Q1), when the user sends another message (Q4), when the chat is cleared,
// or when its agent is disconnected. Only an answer sends anything. The answer is data: it
// authorises nothing (destructive tools still ask on their own 🔒 card). Memory-only, like confirm cards.
const pendingAsks = new Map();                           // id → { ask, conn, state, conversationId }

// Multi-conversation §3.8 (ADR ask-user §2.3, Q1): is this card's conversation the one on screen?
// A switch calls refreshAskVisibility(), so a card in a hidden conversation does not count down.
function askConversationShown(entry) {
  return entry.conversationId === conversationId;
}

// Can the user see the card right now? Panel document visible, chat view (not Settings / setup)
// shown, and its conversation the current one. Scroll position is deliberately not part of it.
function askVisible(entry) {
  return document.visibilityState === "visible" && chatView.classList.contains("active") && askConversationShown(entry);
}

function refreshAskVisibility() {
  for (const e of pendingAsks.values()) e.ask.setVisible(askVisible(e));
}
document.addEventListener("visibilitychange", refreshAskVisibility);

// The 3-pending-card cap is per agent per conversation (ask-user §2.5, multi-conversation §3.8).
function pendingAsksOf(conn, convId) {
  let n = 0;
  for (const e of pendingAsks.values()) if (e.conn === conn && e.conversationId === convId) n++;
  return n;
}

// Show `spec` (already AskCore.normalizeSpec'd) as a card in `conn`'s in-flight turn of session
// state `st` (the asking conversation); returns its id.
function askCard(spec, conn, st = conn.cur) {
  let id;
  do { id = AskCore.newAskId((n) => crypto.getRandomValues(new Uint8Array(n))); } while (pendingAsks.has(id));
  const card = document.createElement("div");
  card.className = "ask-card pending";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `${conn.name} 問你`);
  const head = document.createElement("div");
  head.className = "ask-card-head";
  const icon = document.createElement("span");
  icon.className = "ask-card-icon";
  icon.textContent = "💬";
  const title = document.createElement("span");
  title.className = "ask-card-title";
  title.textContent = `${conn.name} 問你`;
  title.title = "agent 的提問：回答只會傳給它，不代表同意任何動作";
  head.append(icon, title);
  const question = document.createElement("div");
  question.className = "ask-card-question";
  question.textContent = spec.question;
  card.append(head, question);

  // Everything the user can act on sits in `controls`, removed as one when the card settles.
  const controls = document.createElement("div");
  controls.className = "ask-card-controls";
  const options = document.createElement("div");
  options.className = `ask-card-options${spec.multi ? " multi" : ""}`;
  controls.appendChild(options);
  let submit = () => {};
  if (spec.multi) {
    const boxes = spec.options.map((label) => {
      const row = document.createElement("label");
      row.className = "ask-card-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      const text = document.createElement("span");
      text.textContent = label;
      row.append(box, text);
      options.appendChild(row);
      return box;
    });
    const send = document.createElement("button");
    send.type = "button";
    send.className = "ask-card-submit";
    send.textContent = "送出";
    send.disabled = true;
    options.addEventListener("change", () => { send.disabled = !boxes.some((b) => b.checked); });
    send.addEventListener("click", () => submit({ choices: boxes.flatMap((b, i) => (b.checked ? [i] : [])) }));
    controls.appendChild(send);
  } else {
    spec.options.forEach((label, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ask-card-option";
      b.textContent = label;
      b.addEventListener("click", () => submit({ choice: i }));
      options.appendChild(b);
    });
  }
  if (spec.allowOther) {
    const form = document.createElement("form");
    form.className = "ask-card-other";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = AskCore.OTHER_MAX;
    input.placeholder = "其他…";
    input.setAttribute("aria-label", "其他回答");
    const go = document.createElement("button");
    go.type = "submit";
    go.textContent = "送出";
    form.append(input, go);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (input.value.trim()) submit({ other: input.value });
    });
    controls.appendChild(form);
  }
  const hint = document.createElement("div");
  hint.className = "ask-card-hint";
  hint.textContent = AskCore.timeoutHint(spec);
  const result = document.createElement("div");
  result.className = "ask-card-result";
  result.hidden = true;
  card.append(controls, hint, result);

  // The entry keeps the session state, not just the Conn: the answer goes to the asking
  // conversation's session (§3.8), which stays true when P2 lets several run.
  const entry = { conn, state: st, conversationId: st ? st.convId : conversationId, ask: null };
  entry.ask = AskCore.createAsk({
    timeoutMs: spec.timeoutMs,
    onSettle: (state, answer) => {
      pendingAsks.delete(id);
      renderConvTabs();                                  // a ❓ on another conversation's tab may go (§4.7)
      controls.remove();
      hint.remove();
      card.className = `ask-card ${state === "answered" ? "answered" : "unanswered"}`;
      result.textContent = AskCore.outcomeText(state, answer);
      result.hidden = false;
    },
  });
  pendingAsks.set(id, entry);
  // The answer: settle first (a second click is a no-op), then send it to the asking agent only,
  // framed like any user message. It is the user speaking, so it resets the agent↔agent loop guard.
  submit = (raw) => {
    const answer = AskCore.normalizeAnswer(spec, raw);
    if (!answer || !entry.ask.answer(answer)) return;
    loopGuard.onHuman();
    conn.enqueue(RoomCore.framePrompt({ timestamp: Date.now(), senderName: "user" }, AskCore.answerMessage(id, answer)), [], entry.state);
  };

  // Asked in the turn (AskCore.canAsk guarantees one): the card sits in it, above the reply. P2 §5:
  // that turn may be in a conversation not on screen — its clock waits (visible time only, Q1),
  // and ❓ on its tab plus a notification tell the user (Q12).
  if (!st.stream || !st.stream.bubble) conn.startStream(st);
  const turn = st.stream;
  turn.asked = true;                                     // finalizeStream keeps the row for the card
  turn.contentEl.insertBefore(card, turn.bubble);
  entry.ask.setVisible(askVisible(entry));
  conn.inState(st, maybeScroll);
  if (entry.conversationId !== conversationId) { renderConvTabs(); notifyWaitingCard(entry.conversationId); }
  return id;
}

// Close open ask cards unanswered (multi-conversation §3.8 scopes): `how` is supersede (another
// message in that conversation), cancel (that conversation's chat cleared), archive (that
// conversation archived), restart (one conversation's session could not be resumed: that
// conversation, that agent) or disconnect (the agent deliberately disconnected: its cards in EVERY
// conversation). A transient socket drop closes nothing. Nothing is sent to any agent.
function settlePendingAsks(how, { conn = null, convId = null } = {}) {
  for (const e of AskCore.selectToSettle([...pendingAsks.values()], { conn, convId })) e.ask[how]();
}
function supersedePendingAsks(convId) { settlePendingAsks("supersede", { convId }); }
function cancelPendingAsks(convId) { settlePendingAsks("cancel", { convId }); }
function closePendingAsks(conn, how = "disconnect", convId = null) { settlePendingAsks(how, { conn, convId }); }

// Q12 (multi-conversation §4.7): an ask or 🔒 confirm card still waiting in conversation `id`.
function hasWaitingCard(id) {
  for (const e of pendingAsks.values()) if (e.conversationId === id) return true;
  for (const c of pendingConfirms.values()) if (c === id) return true;
  return false;
}
// …raised when the user leaves a conversation with one: its tab shows ❓ and the OS shows this. The
// id carries the panel's window (only this panel claims the click) and the conversation to go back to.
let waitingNotifySeq = 0;
function notifyWaitingCard(id) {
  if (!chrome.notifications || typeof chrome.notifications.create !== "function" || panelWindowId == null) return;
  const title = ConvCore.displayTitle(convIndex[id], id);
  const nid = `${BrowserMcp.NOTIFY_ID_PREFIX}${panelWindowId}:conv:${id}:${Date.now()}-${++waitingNotifySeq}`;
  try {
    const p = chrome.notifications.create(nid, { type: "basic", iconUrl: "icon128.png", title: "Katashiro：有問題等你回答", message: `「${title}」裡有一張卡片還沒回答。點這裡回到那段對話。` });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) { /* notifications off: the ❓ on the tab still shows it */ }
}

// Q9 (multi-conversation §5): a turn that finished in a conversation not on screen. Same id scheme
// as notifyWaitingCard, so the click focuses this window and switches to that conversation.
function notifyTurnDone(id, agentName, failed = false) {
  if (!chrome.notifications || typeof chrome.notifications.create !== "function" || panelWindowId == null) return;
  const title = ConvCore.displayTitle(convIndex[id], id);
  const nid = `${BrowserMcp.NOTIFY_ID_PREFIX}${panelWindowId}:conv:${id}:${Date.now()}-${++waitingNotifySeq}`;
  try {
    const p = chrome.notifications.create(nid, {
      type: "basic", iconUrl: "icon128.png",
      title: failed ? "Katashiro：背景對話的回覆失敗了" : "Katashiro：背景對話回覆完了",
      message: `「${title}」：${agentName} ${failed ? "這一輪沒有完成" : "回覆完了"}。點這裡回到那段對話。`,
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) { /* notifications off: the ● on the tab still shows it */ }
}

// Message ids are <conversationId>:<ms>; never hand out the same ms twice in this panel (#62).
let lastMsgMs = 0;
function uniqueMsgMs(t) {
  lastMsgMs = RoomCore.nextUniqueMs(lastMsgMs, t);
  return lastMsgMs;
}

// --- show_image helpers ---------------------------------------------------------
const SHOW_IMAGE_PER_TURN = 10;                          // #60 memory cap
const SHOW_IMAGE_SESSION_CHARS = 50 * 1024 * 1024 * 4 / 3; // ~50 MB of images, as data: URL chars
let shownImageChars = 0;
const SVG_RASTER_MAX_EDGE = 4096;                       // px, after the 2× scale
const SVG_DEFAULT_SIZE = { width: 1200, height: 800 };  // an SVG with no intrinsic size

// Draw a decoded SVG <img> onto a canvas at 2× and return a PNG data URL. Throws if the canvas is
// tainted (toDataURL SecurityError) — the caller falls back to showing the SVG as an <img>.
function svgToPng(img) {
  const w0 = img.naturalWidth || SVG_DEFAULT_SIZE.width;
  const h0 = img.naturalHeight || SVG_DEFAULT_SIZE.height;
  const { width, height } = Composer.fitDimensions(w0 * 2, h0 * 2, SVG_RASTER_MAX_EDGE);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";                              // SVGs are often transparent; the panel is dark
  g.fillRect(0, 0, width, height);
  g.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

// Full size in a new tab. Chrome refuses to open data: URLs at top level, so go through a blob: URL —
// decoded by hand, since the CSP's connect-src does not allow fetch(data:). Raster images only.
function openImageTab(dataUrl) {
  const [head, b64] = dataUrl.split(",", 2);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: head.slice(5, head.indexOf(";")) }));
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// Enlarge inside the panel (still an <img>, never a document) — used for an SVG we could not rasterize.
function openLightbox(src, caption) {
  const overlay = document.createElement("div");
  overlay.className = "image-lightbox";
  const big = document.createElement("img");
  big.src = src;
  big.alt = caption || "image";
  overlay.appendChild(big);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.appendChild(overlay);
}

// --- reply-to ------------------------------------------------------------------------------------
// ↩ on a message → a quote chip above the input; the next send answers it (framed in the prompt as
// "↩ HH:MM:SS sender「excerpt」"). The chip shows who/when/what; ✕ or Esc cancels.
let replyTarget = null;                                  // { id, senderName, timestamp, text } or null
const replyChip = document.getElementById("reply-chip");

// How a sender appears to the agent: the user's own messages are "user" (the panel calls them "You").
function promptName(name) {
  return name === myUserName ? "user" : (name || "?");
}

function setReplyTarget(t) {
  replyTarget = t || null;
  if (!replyChip) return;
  replyChip.replaceChildren();
  replyChip.hidden = !replyTarget;
  if (!replyTarget) return;
  const label = document.createElement("span");
  label.className = "reply-chip-text";
  label.textContent = `↩ 回覆 ${replyTarget.senderName || "?"} ${RoomCore.uiTime(replyTarget.timestamp)}：「${RoomCore.excerpt(replyTarget.text, 60)}」`;
  label.title = RoomCore.excerpt(replyTarget.text, 400);
  label.addEventListener("click", () => jumpToMessage(replyTarget && replyTarget.id));
  const x = document.createElement("button");
  x.type = "button";
  x.className = "reply-chip-cancel";
  x.textContent = "✕";
  x.title = "取消回覆";
  x.addEventListener("click", () => setReplyTarget(null));
  replyChip.append(label, x);
  messageInput.focus();
}

// The small "↩ sender time：excerpt" line above a reply's bubble; click jumps to the original.
function replyQuoteEl(replyTo) {
  const q = document.createElement("div");
  q.className = "reply-quote";
  const when = Number.isFinite(replyTo.timestamp) ? RoomCore.uiTime(replyTo.timestamp) : "?";
  q.textContent = `↩ ${replyTo.senderName || "?"} ${when}：${RoomCore.excerpt(replyTo.text, 80)}`;
  if (!replyTo.id) q.classList.add("missing");
  q.title = "跳到原訊息";
  q.addEventListener("click", () => jumpToMessage(replyTo.id));
  return q;
}

function attachReplyButton(contentEl, target) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "reply-btn";
  b.textContent = "↩";
  b.title = "回覆這則";
  b.addEventListener("click", () => setReplyTarget(target));
  // Beside the message's time ("19:04 (TPE) ↩", Brett): never on top of the bubble's own controls
  // (code-block copy) or the tool pills. Falls back to the content box if a row has no timestamp.
  const ts = contentEl.querySelector(":scope > .timestamp");
  (ts || contentEl).appendChild(b);
}

// The recorded message an ISO stamp names, as a reply target: exactly that millisecond when the
// stamp has one (headers carry ms, #62 follow-up), else the second rule (RoomCore.findByStamp).
function findMessageByTime(stamp) {
  const conv = targetConv();                             // P2: the conversation being rendered into
  const m = RoomCore.findByStamp(conv ? conv.messages : historyMessages, stamp);
  return m ? { id: m.id || RoomCore.messageId(targetConvId(), m.timestamp), senderName: m.senderName, timestamp: m.timestamp, text: m.text } : null;
}

// The quote target for an agent's "↩ <time>" marker: the matched message, or a placeholder that
// says the original was not found (its quote does not jump anywhere).
function replyTargetFor(stamp) {
  return findMessageByTime(stamp) ||
    { id: null, senderName: "?", timestamp: (RoomCore.parseStamp(stamp) || { ms: NaN }).ms, text: "（找不到原訊息）" };
}

// What a history record keeps of the message a reply answers.
function recordReplyTo(t) {
  return { id: t.id, senderName: t.senderName, timestamp: t.timestamp, text: RoomCore.excerpt(t.text) };
}

// Render an agent's reply. Plain text → the markdown sink as before. With "↩ time" marker lines,
// each part is rendered on its own (still through the sanitized sink) under a quote of the message
// it answers; a marker whose time matches nothing shows the time with "找不到原訊息".
function renderAgentText(el, text) {
  const segs = RoomCore.splitReplySegments(text);
  if (!segs.some((s) => s.replyTo)) { renderMarkdownInto(el, text); return; }
  el.replaceChildren();
  for (const seg of segs) {
    if (seg.replyTo) {
      const target = findMessageByTime(seg.replyTo);
      if (target) el.appendChild(replyQuoteEl(target));
      else {
        const q = document.createElement("div");
        q.className = "reply-quote missing";
        q.textContent = `↩ ${seg.replyTo}（找不到原訊息）`;
        el.appendChild(q);
      }
    }
    if (seg.text) {
      const part = document.createElement("div");
      part.className = "reply-part";
      renderMarkdownInto(part, seg.text);
      el.appendChild(part);
    }
  }
}

function jumpToMessage(id) {
  if (!id) return;
  const row = chatList.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
  if (!row) return;                                      // trimmed out of the 200-message scrollback
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1500);
}

function appendMessage({ senderId, senderName, text, timestamp, images, replyTo, historyCaption, files }) {
  const isMe = senderId === myUserId;
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${isMe ? "sent" : "received"}`;
  const id = RoomCore.messageId(targetConvId(), timestamp);
  msgDiv.dataset.msgId = id;

  if (!isMe) {
    const avatar = document.createElement("div");
    // Per sender (its id; the name for old records without one), the same as its live rows.
    avatar.className = `avatar tone-${RoomCore.avatarTone(senderId || senderName)}`;
    avatar.textContent = senderName ? senderName[0] : "?";
    msgDiv.appendChild(avatar);
  }

  const content = document.createElement("div");
  content.className = "message-content";

  if (!isMe) {
    const nameEl = document.createElement("div");
    nameEl.className = "sender-name";
    nameEl.textContent = senderName || "";
    content.appendChild(nameEl);
  }

  if (replyTo) content.appendChild(replyQuoteEl(replyTo));

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  // A pasted image with no text: show the image itself, not inside a padded blue frame.
  if (!(text && text.trim()) && Array.isArray(images) && images.length) bubble.classList.add("image-only");
  if (text) {                                           // sanitized sink (ADR §3.2) — never raw innerHTML
    if (isMe) renderMarkdownInto(bubble, text, { userText: true }); // keeps typed line breaks
    else renderAgentText(bubble, text);                  // agent text may carry "↩ time" reply markers
  }
  if (Array.isArray(images)) {
    for (const src of images) {
      const im = document.createElement("img");
      im.className = "bubble-image";
      im.src = src;                                     // our own FileReader data URL
      im.alt = "image";
      bubble.appendChild(im);
    }
  }
  if (Array.isArray(files) && files.length) {           // dropped text files: name + size, no content
    const list = document.createElement("div");
    list.className = "bubble-files";
    for (const f of files) list.appendChild(fileChipEl(f));
    bubble.appendChild(list);
  }
  content.appendChild(bubble);

  const ts = document.createElement("div");
  ts.className = "timestamp";
  ts.textContent = formatTime(timestamp);
  content.appendChild(ts);

  // A files-only message is quoted by its markers, not as an empty quote.
  const quoteText = text || (Array.isArray(files) ? files.map(Composer.attachmentMarker).join(" ") : text);
  attachReplyButton(content, { id, senderName, timestamp, text: quoteText });

  msgDiv.appendChild(content);
  outList().appendChild(msgDiv);
  recordMessage({
    kind: isMe ? "sent" : "received", id, senderId, senderName, timestamp,
    replyTo: replyTo ? recordReplyTo(replyTo) : undefined,
    // images are memory-only; a shown image's caption (rendered as a figcaption) is kept as text
    text: Composer.historyText(text || historyCaption || "", Array.isArray(images) ? images.length : 0, files),
  });
  // The user's own message always pulls the view down (they expect to follow it); an incoming
  // relayed message only follows if they're already at the bottom.
  if (isMe && !scopeConv) scrollToBottom(); else maybeScroll();
}

// System notices carry handshake error strings (remote-reachable) — same XSS sink, same
// fix: textContent, never innerHTML. `conv` (optional): the conversation the notice is about —
// one whose list is not built yet (never shown) gets none; they are not recorded anyway.
function appendSystemMessage(text, conv) {
  const list = conv ? conv.listEl : outList();
  if (!list) return null;
  const msgDiv = document.createElement("div");
  msgDiv.className = "message system";
  const inner = document.createElement("div");
  inner.className = "system-text";
  inner.textContent = text;
  msgDiv.appendChild(inner);
  list.appendChild(msgDiv);
  if (list === chatList) maybeScroll();
  return inner;
}

// A system notice with buttons (open elsewhere → focus that window, the picker's cancel notice).
function appendSystemActions(text, actions) {
  const inner = appendSystemMessage(text);
  if (!inner) return;
  inner.classList.add("with-actions");
  const row = document.createElement("div");
  row.className = "system-actions";
  for (const a of actions) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "system-action";
    b.textContent = a.label;
    b.addEventListener("click", a.onClick);
    row.appendChild(b);
  }
  inner.appendChild(row);
  maybeScroll();
}

// A failed turn gets its OWN bubble (distinct red styling), separate from agent content, with an
// optional retry. The error text is remote-reachable (a prompt/handshake error echoed from a
// malicious/MITM server), so it stays textContent — never markdown/innerHTML (same guard as
// system notices).
function appendErrorMessage(senderName, text, onRetry) {
  const msgDiv = document.createElement("div");
  msgDiv.className = "message received error";

  const avatar = document.createElement("div");
  avatar.className = "avatar error-avatar";
  avatar.textContent = "!";
  msgDiv.appendChild(avatar);

  const content = document.createElement("div");
  content.className = "message-content";
  if (senderName) {
    const nameEl = document.createElement("div");
    nameEl.className = "sender-name";
    nameEl.textContent = senderName;
    content.appendChild(nameEl);
  }
  const bubble = document.createElement("div");
  bubble.className = "bubble error-bubble";
  const msg = document.createElement("div");
  msg.className = "error-text";
  msg.textContent = text;
  bubble.appendChild(msg);
  if (onRetry) {
    const retry = document.createElement("button");
    retry.className = "retry-btn";
    retry.type = "button";
    retry.textContent = "重試";
    retry.addEventListener("click", () => { retry.disabled = true; onRetry(); });
    bubble.appendChild(retry);
  }
  content.appendChild(bubble);
  msgDiv.appendChild(content);
  outList().appendChild(msgDiv);
  recordMessage({ kind: "error", senderName, text, timestamp: Date.now() });
  maybeScroll();
}

// The stop button is shown while the conversation ON SCREEN is replying and stops only its turn
// (P2 §5); a conversation replying in the background is stopped from its tab (⏹).
function updateStopButton() {
  if (stopBtn) stopBtn.hidden = !(conversationId && convReplying(conversationId));
}

function scrollToBottom() {
  messagesList.scrollTop = messagesList.scrollHeight;
}

// Stick-to-bottom: auto-follow new content while the user is pinned near the bottom, and stop
// (surfacing a "jump to latest" affordance) the moment they scroll up to read history.
const NEAR_BOTTOM_PX = 80;
function isNearBottom() {
  return messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < NEAR_BOTTOM_PX;
}
// Follow flag driven by REAL user scrolls — not re-derived per streamed chunk. The old approach
// recomputed isNearBottom() right after appending a chunk; a single chunk taller than
// NEAR_BOTTOM_PX then read as "user scrolled away" and killed the auto-follow mid-stream. A sticky
// flag only flips when the user actually scrolls, so streaming stays glued to the bottom.
let stickToBottom = true;
function maybeScroll() {
  if (scopeConv) return;                                 // P2: rendering into a hidden conversation
  if (stickToBottom) scrollToBottom();
  else if (jumpLatestBtn) jumpLatestBtn.hidden = false;
}
if (jumpLatestBtn) {
  jumpLatestBtn.addEventListener("click", () => { stickToBottom = true; scrollToBottom(); jumpLatestBtn.hidden = true; });
}
// A user scroll updates the follow flag; a programmatic scrollToBottom lands near-bottom, so the
// flag stays true and we keep following. Only a manual scroll-up flips it off.
messagesList.addEventListener("scroll", () => {
  stickToBottom = isNearBottom();
  if (jumpLatestBtn && stickToBottom) jumpLatestBtn.hidden = true;
});
