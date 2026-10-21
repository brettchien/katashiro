// Katashiro side panel.
//
// Each configured agent gets its OWN WebSocket, held in a `Conn`, with one ACP session per
// conversation bound to it (ADR agent-per-conversation): a conversation talks to exactly one
// agent, and the panel connects every agent an open conversation uses. There is no agent→agent
// relay, @mention routing or loop guard any more (removed with that ADR).

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

// An agent per conversation (ADR agent-per-conversation): each conversation is bound to one agent
// (conv.agentUrl), and the panel connects every agent an open conversation uses (syncConnections).
// The single-active `activeAgentUrl` is only read, by the one-time migration (§2.2), and no longer
// written (§2.1: it stays in storage.sync for builds from before this change).
let legacyActiveAgentUrl = null;
// Agents dropped from the stored list for repeating a URL (applyConfig), said once in the chat.
let dedupedAgents = [];
function noteDedupedAgents() {
  if (!dedupedAgents.length) return;
  appendSystemMessage(`設定裡有重複網址的 agent，已只保留第一個：${dedupedAgents.map((a) => `${a.name || "Agent"}（${a.url}）`).join("、")}`);
  dedupedAgents = [];
}

// Connection config (the heartbeat; RoomCore normalizes it). The routing mode and loop-guard cap
// it used to carry went with the relay.
let roomConfig = RoomCore.defaultRoomConfig();

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
// The agent conversation `id` is bound to (agent-per-conversation §2.1), as this panel loaded it.
function convAgentUrl(id) {
  const conv = id ? convs.get(id) : null;
  return conv ? conv.agentUrl : null;
}
// The Conn of conversation `id`'s agent (null: none, or the agent was removed, §2.6).
function connOfConv(id) {
  const url = convAgentUrl(id);
  return url ? room.find((c) => c.agent.url === url) || null : null;
}
// Is conversation `id` bound to an agent no longer in the agents list (§2.6: read-only)?
function convAgentMissing(id) {
  const url = convAgentUrl(id);
  return !!id && convs.has(id) && !agents.some((a) => a.url === url);
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
const COMMAND_TIMEOUT_MS = 30000;                         // a ⚡ command's raw prompt: the gateway answers it itself, at once
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
    this.resendPending = false;                          // §7 I8: the next prompt is a resend after a mid-turn drop
    this.promptQueue = [];
    this.pendingImages = [];                             // { mimeType, data(base64) } to ride the next turn
    this.turnActive = false;
    this.queuedMsgIds = [];                              // read receipt: user messages waiting in promptQueue
    this.turnHeard = false;                              // a session/update or tunnel call arrived for the turn in flight
    this.staleTurns = 0;                                 // timed-out turns (socket open) not answered yet
    this.stream = null;                                  // { bubble, text } while streaming
    this.skippedToolCalls = null;                        // katashiro tool calls seen this turn
    this.lastTurnActivityAt = 0;                         // ts of the last sign of life of its turn
    this.mcpServer = null;                               // this conversation's browser MCP server (§3.9)
    // ⚡ commands (command-core.js): a command holds the session (no queued turn starts meanwhile);
    // while its raw prompt is out, the gateway's reply text collects in commandChunks, not a bubble.
    this.commandActive = false;
    this.commandChunks = null;
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
    this.stalePrompts = new Map();                       // session/prompt id given up on (still open) -> SessionState
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

  /**
   * The session state of a conversation, created (seeded from its saved session id) on first use —
   * only for a conversation bound to THIS agent (agent-per-conversation §2.7); null otherwise.
   */
  stateFor(convId) {
    let st = this.states.get(convId);
    if (!st) {
      const conv = convs.get(convId);
      if (!conv || conv.agentUrl !== this.agent.url) return null;
      st = new SessionState(convId, conv.sessions ? conv.sessions[this.agent.url] : null);
      this.states.set(convId, st);
    }
    return st;
  }
  /**
   * The on-screen conversation's state, if it is bound to this agent (null while the panel has none,
   * §3.3, or it is another agent's: with several Conns connected, each must not take the on-screen
   * conversation for its own — agent-per-conversation §2.7).
   */
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
        // canvas_move / conversation_list (multi-conversation §7.3, Brett 2026-10-19 18:55 TPE: push and
        // pull, a confirm card every time). The list is metadata only — titles, never content.
        conversations: async (query) => {
          const metas = await canvasStore.allMetas();
          return ConvCore.moveTargets({ index: convIndex, exclude: st.convId, query, now: Date.now() }).map((r) => {
            const at = Number(convIndex[r.id] && convIndex[r.id].lastMessageAt) || 0;
            return {
              id: r.id, title: r.title, archived: r.archived, lastMessageAt: at ? new Date(at).toISOString() : null,
              canvases: metas.filter((m) => m && m.conversationId === r.id).map((m) => ({ id: m.id, title: m.title, kind: m.kind, version: m.version })),
            };
          });
        },
        // Read fresh, not convIndex: canvas_move asks again once its card is answered (a delete may have started).
        conversationInfo: async (id) => {
          if (!ConvCore.isConvId(id)) return null;
          let index = convIndex;
          try { index = (await chrome.storage.local.get(ConvCore.INDEX_KEY))[ConvCore.INDEX_KEY] || {}; } catch (_) { /* last read */ }
          if (!index[id]) return null;
          return { title: ConvCore.displayTitle(index[id], id), gone: ConvCore.reopenRefusal(index[id]) };
        },
        confirmMove: ({ title, version, push, otherTitle }) => confirmOutcome({
          title: `${this.name} 要移動畫布`,
          lines: [
            `「${title}」（v${version}）`,
            push ? `從這段對話移到「${otherTitle}」。` : `從「${otherTitle}」移進這段對話。`,
            push ? "移過去之後，這段對話的 agent 就讀不到也改不了它；那段對話的 agent 讀得到。"
              : "移進來之後，這段對話的 agent 讀得到也改得了它；原本那段對話的 agent 就讀不到了。",
          ],
        }, { conn: this, st, notAskedNote: `${this.name} 的回合已結束，移動畫布的要求未執行（沒有詢問你）。` }),
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

  // Turns given up on while the socket stayed open (stalePrompts) are forgotten with the socket.
  clearStalePrompts() {
    for (const st of this.stalePrompts.values()) st.staleTurns = 0;
    this.stalePrompts.clear();
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
      // A reconnect mid-turn (the roster chip's R2 click): stop the turn server-side first, as
      // disconnect() does, so its resend below does not meet it still running (no-op if not open).
      if (this.ws.readyState === WebSocket.OPEN) this.cancelTurn();
      this.ws.onclose = null;                            // stale socket must not trigger reconnect
      this.ws.close();
    }
    // onclose is detached: settle the old socket's requests here, as it would. An in-flight turn is
    // requeued and resent on the new socket (as after a drop), instead of timing out ~10 min later
    // with the new socket open — the "cancel" path, which would session/cancel whatever turn runs
    // then and leave a stale prompt that never answers (#182 review: Jellyfish).
    this.rejectAllPending("connection closed");
    this.clearStalePrompts();                            // their answers can only come on the old socket
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
        this.clearStalePrompts();                        // their answers can only come on this socket
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

  // Tear down permanently (no reconnect) — used on delete / retarget / its last open conversation archived.
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
    this.clearStalePrompts();                            // onclose is detached: forget its turns here
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
    // Both also mean the turn reached the agent (its read receipt), unless they may be an earlier,
    // timed-out turn's (RoomCore.turnActivityCounts).
    if (msg.method === "session/update" && msg.params) {
      const st = this.stateBySession(msg.params.sessionId);
      if (st) { st.lastTurnActivityAt = this.lastRecvAt; if (RoomCore.turnActivityCounts(st.turnActive, st.staleTurns)) st.turnHeard = true; }
    } else if (msg.method === "mcp/message") {
      const server = this.mcpState.connections && msg.params && this.mcpState.connections[msg.params.connectionId];
      const st = server && this.stateOfServer(server);
      if (st) { st.lastTurnActivityAt = this.lastRecvAt; if (RoomCore.turnActivityCounts(st.turnActive, st.staleTurns)) st.turnHeard = true; }
    }
    // The late answer of a turn we gave up on: that turn is over, its session's activity counts again.
    if (msg.id !== undefined && this.stalePrompts.has(msg.id) && (msg.result !== undefined || msg.error !== undefined)) {
      const st = this.stalePrompts.get(msg.id);
      this.stalePrompts.delete(msg.id);
      st.staleTurns = Math.max(0, st.staleTurns - 1);
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
      // A raw command's reply (the gateway answers /reset, /models, /model set itself): collected for
      // the command, never shown as the agent's reply.
      if (st && !st.turnActive && st.commandChunks) {
        const u = msg.params.update;
        if (u.sessionUpdate === "agent_message_chunk" && u.content) st.commandChunks.push(u.content.text || "");
        return;
      }
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
  // `msgId`: the user's chat message this prompt carries, for its read receipt (none for an ask
  // card's answer, which has no bubble of its own).
  enqueue(text, images, st = this.cur, msgId = null) {
    if (!st) return;
    st.promptQueue.push(text);
    if (msgId) st.queuedMsgIds.push(msgId);
    if (images && images.length) st.pendingImages.push(...images);
    // openSession, not flushQueue: a background conversation not yet resumed on this socket (e.g. a
    // relay after a reconnect) is opened first; one that is ready just flushes (review: Jellyfish, #143).
    this.openSession(st);
  }

  // Send the next queued turn if this session is idle and ready.
  flushQueue(st = this.cur) {
    if (!st || st.turnActive || st.promptQueue.length === 0) return;
    if (st.commandActive) return;                        // a ⚡ command holds the session; it flushes when done
    // P2 (§5): any open conversation runs its turn, on screen or not. Concurrency is the open count
    // (at most 3, Q7); one turn per conversation, so -32001 Session busy cannot happen.
    if (this.states.get(st.convId) !== st) return;       // archived meanwhile
    if (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.initialized && st.readyGen === this.socketGen && st.acpSessionId)) return;

    // Batch delivery: drain the WHOLE backlog and send it as one turn, not one-per-round. If the
    // agent was busy while the user (or a relay) piled up several messages, they arrive together on
    // the next round — Discord-style — instead of dribbling out over N turns.
    const batch = st.promptQueue.splice(0);
    const msgIds = st.queuedMsgIds.splice(0);            // read receipt: the user messages in it
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
    // Kept for this turn's error bubble's 重試 (the whole batch, no host line): that turn exactly,
    // not "the last one" — a pool-busy turn flushes the queue at once, so a later turn may have gone
    // out before 重試 is clicked (#180 review: Jellyfish).
    const turn = { text, images, msgIds };
    st.turnActive = true;
    st.turnHeard = false;
    // Read receipt: set as the batch goes out in session/prompt (the gateway answers that request
    // only when the turn ends, so this is the earliest sign); cleared below if the turn never
    // started. Only the ones this turn marked are cleared — a retry of a received turn keeps its tags.
    const marked = setReadReceipts(st.convId, msgIds, true);
    st.skippedToolCalls = new Set();                     // katashiro tool calls seen this turn
    updateStopButton();
    renderConvTabs();
    this.startStream(st);

    // U2 host line (§3.5): first, at flush time only — never stored, never in the retry copy.
    const hinted = st.hintPending;
    const resent = st.resendPending;                     // §7 I8: innermost, right above the message
    let sent = resent ? ConvCore.withResendHint(text) : text;
    // §7.3: canvases moved into / out of this conversation, until a prompt carrying them is accepted.
    const moveNotes = canvasMoveNotes.get(st.convId) || [];
    if (moveNotes.length) sent = ConvCore.withCanvasMoveNotes(sent, moveNotes);
    if (hinted) sent = ConvCore.withReconnectHint(sent);
    const startedAt = Date.now();
    st.lastTurnActivityAt = startedAt;
    const promptId = this.nextReqId;                     // the id acpRequest gives this session/prompt
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
          setReadReceipts(st.convId, marked, false);     // never reached the agent: no read tag
          updateStopButton();
          renderConvTabs();
          st.stream.text = "";                           // drop the line: finalize removes the empty row
          this.finalizeStream(undefined, st);
          this.inState(st, () => appendErrorMessage(this.name, ConvCore.promptFailureText("pool exhausted"), () => this.retryTurn(st, turn)));
          if (st.convId !== conversationId && this.states.get(st.convId) === st) notifyTurnDone(st.convId, this.name, true);
          this.flushQueue(st);
          return;
        }
        if (hinted) st.hintPending = false;              // accepted: the agent has seen the line
        if (moveNotes.length) canvasStore.takeMoveNotes({ conversationId: st.convId, seen: moveNotes }).catch(() => {});
        if (resent) st.resendPending = false;
        st.turnActive = false;
        updateStopButton();
        renderConvTabs();
        this.finalizeStream(res && res.stopReason, st);  // stopReason "cancelled" ⇒ partial reply kept
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
        if (!RoomCore.turnReachedAgent(action, st.turnHeard)) setReadReceipts(st.convId, marked, false);
        if (action === "requeue") {
          // The socket genuinely closed / half-opened (an explicit close, or a heartbeat teardown
          // that rejects the in-flight turn with "connection closed"). Re-queue it — the
          // onclose-scheduled reconnect flushes it (ADR R3). The prompt may well have LANDED: on
          // 2026-10-16 22:20:57 TPE the socket dropped 4 s after the gateway took it, the agent
          // answered into the dead connection, and the resend read as a duplicate. So the resend
          // carries RESEND_HINT (answer again in full), and the chat says what happened, under
          // whatever part of the reply had arrived (§7 I8). The host line is not re-queued: the
          // flag still stands, so the resend carries it again.
          const partial = !!(st.stream && st.stream.text);
          st.promptQueue.unshift(text);
          st.queuedMsgIds.unshift(...msgIds);            // waiting again: read once the resend goes out
          st.pendingImages.unshift(...images);           // the images never landed either
          st.resendPending = true;
          this.finalizeStream(undefined, st);
          this.inState(st, () => appendSystemMessage(partial
            ? `連線中斷：${this.name} 上面的回覆不完整，重新連線後會重送你的訊息，請它重新回答。`
            : `連線中斷：${this.name} 的回覆沒有送到，重新連線後會重送你的訊息，請它重新回答。`));
        } else if (action === "cancel") {
          // Socket still OPEN but the turn "timed out" — it is very likely still ALIVE server-side
          // (a long tool phase that outran the idle/prompt timer; cf. openab's text-only idle timer
          // that supersedes tool-heavy turns). The old code force-reconnected and re-sent here, which
          // DUPLICATED a turn the agent had already received and acted on — the resend fired on
          // resume and the agent ran the same message 2–3× (the reconnect-duplication bug). Never
          // auto-re-send into a live session: cancel the stale turn and let the USER re-issue via the
          // retry button. No reconnect either — the socket + tunnel are fine.
          if (hinted) st.hintPending = false;            // the prompt was received
          if (resent) st.resendPending = false;
          if (st.acpSessionId) this.socketSend({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: st.acpSessionId } });
          // It may still run (and update) while the next turn flushes below: until it answers,
          // its session's activity does not count as the next turn heard.
          this.stalePrompts.set(promptId, st);
          st.staleTurns++;
          this.finalizeStream(undefined, st);
          const why = /\(max\)/.test(String(err))
            ? `回合超過 ${RoomCore.TURN_MAX_TIMEOUT_MS / 60000} 分鐘上限`
            : `回合 ${RoomCore.TURN_IDLE_TIMEOUT_MS / 60000} 分鐘沒有任何動靜`;
          this.inState(st, () => appendErrorMessage(this.name, `${why}（連線仍在）—— 已取消，未自動重送以免重複。需要就點重試。`, () => this.retryTurn(st, turn)));
        } else {
          this.finalizeStream("error", st);              // render any partial reply, then a distinct
          // §5: the pool is shared with Discord and usercron; "pool exhausted" is said plainly and
          // never retried automatically — 重試 is the user's call.
          this.inState(st, () => appendErrorMessage(this.name, ConvCore.promptFailureText(String(err)), () => this.retryTurn(st, turn))); // error bubble
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

  // A ⚡ command on the wire: `text` (exactly "/reset", "/models", "/model set N") as its own
  // session/prompt — no [time user] header, no host line, not through the queue — because the
  // gateway answers a slash command only when the prompt is exactly the command. Resolves with the
  // gateway's reply chunks (CommandCore.replyText picks the text). The caller holds
  // st.commandActive (so no queued turn starts meanwhile) and has waited for any turn of this
  // session to end (the gateway refuses a second prompt on a busy session, -32001).
  async runRawCommand(st, text) {
    await this.openSession(st);
    if (this.states.get(st.convId) !== st) throw new Error("conversation closed");
    if (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.initialized && st.readyGen === this.socketGen && st.acpSessionId)) throw new Error("not connected");
    if (st.turnActive) throw new Error("a reply is running");
    const chunks = [];
    st.commandChunks = chunks;
    try {
      await this.acpRequest("session/prompt", { sessionId: st.acpSessionId, prompt: [{ type: "text", text }] }, COMMAND_TIMEOUT_MS);
      return chunks;
    } finally {
      if (st.commandChunks === chunks) st.commandChunks = null;
    }
  }

  // Re-send the last turn (after an error / stop). If the socket isn't live, reconnect first and
  // queue the turn so it flushes once the handshake completes — otherwise a retry on a dead/closed
  // socket would silently no-op (ADR tunnel-liveness R3, the reported "retry does nothing").
  // 重試 on a failed turn's error bubble: re-send exactly that turn ({ text, images, msgIds }).
  retryTurn(st, turn) {
    // Its conversation must still be open (P2: on screen or not — the button is in its own list) and
    // bound to this agent. A stale error bubble of a Conn that is no longer wanted (its last
    // conversation archived) must NOT `connect()` it (review: Orca, the C2 race; §2.7).
    if (!st || this.states.get(st.convId) !== st) return;
    if (!this.enabled || convAgentUrl(st.convId) !== this.agent.url) return;
    if ((!turn.text && turn.images.length === 0) || st.turnActive) return;
    st.promptQueue.push(turn.text || "");                // "" still carries an image-only turn
    st.queuedMsgIds.push(...turn.msgIds);                // read receipt: tagged when the retry goes out
    st.pendingImages.push(...turn.images);
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
      this.connect("heartbeat");                         // teardown (fails the dead socket's requests) + re-handshake (resume re-declares tunnel)
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
    // Not connected until an open conversation wants it (syncConnections): enabled:false renders
    // 已停用 rather than "連線中…".
    c.enabled = false;
    room.push(c);
  });
}

// agent-per-conversation §2.3 (Q2): connect every agent an open conversation of this window uses,
// and only those. Runs after start-up, ＋, archive, reopen and any change to the agents list. A
// Conn already up is left alone (connect() would replace its socket); one no longer wanted is
// disconnected, which closes its ask cards in every conversation (§2.8).
function wantedAgents() {
  const openUrls = windowRec.open.filter((id) => convs.has(id)).map((id) => convs.get(id).agentUrl);
  return ConvCore.wantedAgentUrls(openUrls, agents.map((a) => a.url));
}
function syncConnections() {
  const wanted = wantedAgents();
  room.forEach((c) => {
    if (wanted.has(c.agent.url)) { if (!c.enabled) c.connect(); }
    else if (c.enabled) c.disconnect();
  });
  updateRoster();
  if (settingsView && settingsView.classList.contains("active")) renderAgentList();
}

// Replace a single conn in place (retarget on url/token change); connected again only if wanted.
function reconnectConn(i) {
  if (i < 0 || i >= room.length) return;
  if (room[i]) room[i].disconnect();
  room[i] = new Conn(agents[i]);
  room[i].enabled = false;
  if (wantedAgents().has(agents[i].url)) room[i].connect();
}

// --- DOM refs ----------------------------------------------------------------
const messagesList = document.getElementById("messages-list");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const stopBtn = document.getElementById("stop-btn");
const cmdBtn = document.getElementById("cmd-btn");        // ⚡ — the stop button's slot while idle
const cmdMenu = document.getElementById("cmd-menu");
const composerHint = document.getElementById("composer-hint");
let cmdMenuState = null;                                 // ⚡ menu while open: { via: "typed" | "button", query, items, selected }
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
// conversation's scrollback and resumable ACP session ids (storage.local) and synced settings survive.
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
// Session ids + scrollback stay in storage.local (per conversation, never synced).
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
    // Two agents may not share a URL (it is the identity, agent-per-conversation §2.1). A stored
    // list from before that rule keeps the first of each; the list is saved as is until the next
    // Settings change (persist), so nothing is written behind the user's back.
    const d = RoomCore.dedupeAgents(r.agents);
    agents = d.agents.length ? d.agents : [{ ...DEFAULT_AGENT }];
    if (d.dropped.length) dedupedAgents = d.dropped;
  } else if (r.wsUrl) {
    agents = [{ name: "OpenAB", url: r.wsUrl }];
  } else {
    agents = [{ ...DEFAULT_AGENT }];
  }
  legacyActiveAgentUrl = typeof r.activeAgentUrl === "string" ? r.activeAgentUrl : null;   // migration only (§2.2)
  roomConfig = RoomCore.normalizeRoomConfig(r.roomConfig);
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
    noteDedupedAgents();
    // Conversations (migration, this window's open set and locks) BEFORE building/connecting, so
    // each conn resumes the current conversation's saved session.
    try { await loadConversations(); } catch (e) { console.error("katashiro: loading conversations failed:", e); }
    // Folder mirror catch-up (§3.6): canvases saved while the folder was not connected.
    canvasMirror.syncAll().catch(() => {});
    buildRoom();
    syncConnections();                                   // agent-per-conversation §2.3: the open conversations' agents
    updateRoster();
    markPanelReady();
    pickUpReopenRequest();
    pickUpPageAsk();
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
    if (!RoomCore.shouldAdoptRemoteConfig({ runningOnDefaults, userEdited, remote })) {
      // agent-per-conversation §7 I9: past the defaults stage only the agents list is followed live
      // (another window's or device's Settings edit) — the rest of the config stays as it is here.
      if ("agents" in changes) followRemoteAgents(changes.agents.newValue);
      return;
    }
    runningOnDefaults = false;
    applyConfig(remote);
    noteDedupedAgents();
    buildRoom();
    // §2.4: the conversations opened meanwhile sit on the placeholder agent this list replaces →
    // the old active agent, as the setup's Connect does (agents:seen is the default list, so §2.6
    // would read the placeholder as removed — its name is no other agent's). Then §2.6: a URL edit
    // in the arriving list rebinds this device's conversations before connecting.
    const placeholder = agents.some((a) => a.url === DEFAULT_AGENT.url)
      ? Promise.resolve()
      : rebindConversations(DEFAULT_AGENT.url, RoomCore.resolveActiveUrl(agents, legacyActiveAgentUrl))
        .catch((e) => console.warn("katashiro: rebinding conversations to the synced agents failed:", e));
    placeholder.then(() => reconcileAgents()).finally(() => { syncConnections(); renderConvTabs(); updateSendEnabled(); });
    updateRoster();
    if (settingsView && settingsView.classList.contains("active")) {
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

// agent-per-conversation §7 I9: the agents lists this panel wrote recently. storage.onChanged
// brings every write back to the panel that made it too, and a burst of edits can bring an older
// one back after a newer one: never follow those.
const recentAgentWrites = new Map();                     // JSON of the list → when it was written
function noteAgentsWrite() {
  const now = Date.now();
  for (const [k, at] of recentAgentWrites) if (now - at > 30000) recentAgentWrites.delete(k);
  recentAgentWrites.set(JSON.stringify(agents), now);
}

// §7 I9 (Brett 2026-10-16 22:37): another window or device changed the agents list — follow it
// without a reload. URL edits rebind this panel's conversations in memory too (I10: so it never
// writes the old URL back); a Conn stays when its URL, token and browser access are unchanged
// (renames apply in place; its running turns are untouched); a removed or retargeted one is
// disconnected (its cards close), a new one is added unconnected; then the usual sync.
let followChain = Promise.resolve();
function followRemoteAgents(nextRaw) {
  followChain = followChain.then(() => followRemoteAgentsNow(nextRaw)).catch((e) => console.warn("katashiro: following a synced agents list failed:", e));
  return followChain;
}
async function followRemoteAgentsNow(nextRaw) {
  if (!Array.isArray(nextRaw) || !nextRaw.length) return;
  const json = JSON.stringify(nextRaw);
  if (recentAgentWrites.has(json) || json === JSON.stringify(agents)) return;   // our own write
  const next = RoomCore.dedupeAgents(nextRaw).agents;
  if (!next.length) return;
  const edits = ConvCore.agentUrlEdits(agents, next);
  agents = next;
  const keep = new Map();
  for (const c of room) {
    const a = next.find((x) => x.url === c.agent.url);
    if (a && (a.token || "") === (c.agent.token || "") && (a.browserAccess !== false) === (c.agent.browserAccess !== false)) {
      c.agent = a;                                       // same socket; a new name shows on the next render
      keep.set(a.url, c);
    } else c.disconnect();
  }
  room.length = 0;
  for (const a of next) {
    let c = keep.get(a.url);
    if (!c) { c = new Conn(a); c.enabled = false; }
    room.push(c);
  }
  // Rebound after the retargeted Conns are dropped (as a Settings URL edit here does): nothing they
  // save or finalize while the rebind runs may put the old URL back.
  for (const { from, to } of edits) await rebindConversations(from, to);
  await reconcileAgents();                               // agents:seen = the list now followed
  syncConnections();                                     // re-renders Settings when it is open
  renderConvTabs();
  updateSendEnabled();
  if (convAgentMissing(conversationId)) noteAgentMissing(currentConv);
}

function persist() {
  userEdited = true;
  noteAgentsWrite();
  runningOnDefaults = false;           // whatever is in memory now is intentional, not a placeholder
  // No activeAgentUrl (agent-per-conversation §2.1): not written, never deleted — sync.set merges.
  const cfg = { agents, roomConfig, actMode, jevToken, screenshotConfig, attachConfig };
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

// --- Conversations / showing / switching / tab strip: moved to conversations.js; the load-time
// wiring and the DOM refs it reads stay here --------------------------------------------------------
// Other panels write conv:index too (adoptIndex, conversations.js): follow it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[ConvCore.INDEX_KEY]) return;
  adoptIndex(changes[ConvCore.INDEX_KEY].newValue);
  renderConvTabs();
});

// The lobby: notices while the panel has no conversation; chatList is where rows are appended
// (showConversation / showLobby, conversations.js).
const lobbyList = document.createElement("div");
lobbyList.className = "conv-messages conv-lobby";
messagesList.appendChild(lobbyList);
let chatList = lobbyList;                 // where rows are appended: the current conversation's list

// The pickers' dock above the input (dockPicker / undockPicker, conversations.js).
const pickerDock = document.getElementById("picker-dock");

// Another window's picker archives a conversation open in THIS panel.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-conv-archive") return false;
  if (!fromOwnPage(sender, "/sidepanel.html") || !convs.has(msg.id)) return false;
  archiveConversation(msg.id).then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

// 重新打開 in the gallery / 🗨️ 對話 in a canvas tab (handleReopen, conversations.js).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "katashiro-conv-open") return false;
  const fromCanvas = fromCanvasTab(sender);
  if (!(fromCanvas || fromOwnPage(sender, "/canvas-gallery.html")) || !ConvCore.isConvId(msg.id)) {
    sendResponse({ ok: false, error: "not from the Katashiro gallery or a canvas" });
    return false;
  }
  // A canvas tab's window is the tab's own, not what the message says.
  const wid = fromCanvas ? (sender.tab && sender.tab.windowId) : msg.windowId;
  if (panelWindowId == null || String(wid) !== String(panelWindowId)) return false;
  const canvasId = fromCanvas ? String(msg.canvasId || "") : null;
  panelReady
    .then(() => handleReopen(msg.id, typeof msg.reqId === "string" ? msg.reqId : null, canvasId))
    .then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

// §3.2: lastMessageAt always on panel hide.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") for (const conv of convs.values()) writeIndexTime(conv);
});

// The tab strip (renderConvTabs / startRename, conversations.js).
const convTabsEl = document.getElementById("conv-tabs");
setInterval(() => renderConvTabs(), 60 * 1000);          // "today" vs M/D

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

// agent-per-conversation §2.5, revised 2026-10-16 (Brett, §7 I1): a chip per configured agent, in
// Settings order. The on-screen conversation's agent is highlighted with the full status (click =
// reconnect); another agent this window is connected to shows its name and link state; one no open
// conversation uses is dimmed, 未使用. Only the current chip reacts to a click: a conversation is
// bound to its agent 1:1 (Q1), so another chip has nothing to switch to. A removed agent of the
// on-screen conversation gets a chip that says so (§2.6).
function rosterStatus(c) {
  return RoomCore.roomStatus({
    acpReady: c.acpReady, alive: c.alive, lastFailure: c.lastFailure,
    enabled: c.enabled, online: c.online,
    allowed: c.agent.browserAccess !== false,
    attached: c.browserAttached,
    tunnelFresh: Date.now() - (c.lastTunnelMsgAt || 0) < TUNNEL_FRESH_MS,
    actMode,
  });
}

function updateRoster() {
  const c = connOfConv(conversationId);
  const missing = convAgentMissing(conversationId);
  if (statusIndicator) {
    statusIndicator.className = "status-indicator " + (c && c.acpReady ? "online" : "offline");
  }
  if (activeAgentLabel) {
    activeAgentLabel.textContent = !currentConv ? "沒有開著的對話" : missing ? "agent 已移除" : c ? `${c.name}：${connState(c).label}` : "";
  }
  if (!rosterEl) return;
  rosterEl.innerHTML = "";
  if (missing) {
    const chip = document.createElement("div");
    chip.className = "roster-chip dormant current";
    chip.title = `${convAgentUrl(conversationId)} 不在設定裡了：在設定加回同一個網址就能繼續這段對話`;
    const nm = document.createElement("span");
    nm.className = "roster-name";
    nm.textContent = "agent 已移除";
    chip.appendChild(nm);
    rosterEl.appendChild(chip);
  }
  room.forEach((r) => {
    const chip = document.createElement("div");
    const nm = document.createElement("span");
    nm.className = "roster-name";
    nm.textContent = r.name;                             // textContent: agent name is user config

    if (r === c) {
      // The on-screen conversation's agent: highlighted, three-segment status (🔌 link · 🚇 tunnel ·
      // 🌐 browser, ADR §8.2).
      const s = rosterStatus(r);
      chip.className = "roster-chip active current " + s.link.cls;
      chip.appendChild(nm);
      chip.appendChild(renderSeg("link", "🔌", s.link));
      if (s.tunnel) chip.appendChild(renderSeg("tunnel", "🚇", s.tunnel));
      if (s.browser) chip.appendChild(renderSeg("browser", "🌐", s.browser));
      // Show which ACP session this chip is bound to (hover) — lets you confirm which
      // session you're talking to vs the gateway/mon-tick's `sess=` id.
      chip.title = `ACP session: ${r.acpSessionId || "—"}`;
      // R2 — one-click manual reconnect on an unhealthy link; a healthy link is inert.
      if (r.enabled !== false && s.link.cls !== "online") {
        chip.classList.add("clickable");
        chip.title = "點擊重新連線";
        chip.addEventListener("click", () => { r.connect(); updateRoster(); });
      }
    } else if (r.enabled) {
      // Connected for another open conversation of this window: its name and link state only.
      const s = rosterStatus(r);
      chip.className = "roster-chip other " + s.link.cls;
      chip.appendChild(nm);
      chip.appendChild(renderSeg("link", "🔌", s.link));
      chip.title = `${r.name}：${connState(r).label}（這個視窗另一段對話在用）`;
    } else {
      // No open conversation of this window uses it, so it is not connected — not broken.
      chip.className = "roster-chip dormant unused";
      chip.appendChild(nm);
      const note = document.createElement("span");
      note.className = "roster-note";
      note.textContent = "未使用";
      chip.appendChild(note);
      chip.title = "這個視窗沒有開著的對話用這個 agent，所以沒有連線。按 ＋ 選它就能開一段新對話。";
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
  closeCommandCards(conversationId);       // …and a ⚡ command card (it leaves with the list)
  chatList.replaceChildren();
  historyMessages.length = 0;
  shownImageChars = 0;           // the shown images left the DOM with the messages (an estimate across conversations)
  saveConv();                    // persist the now-empty scrollback (session ids untouched)
  if (jumpLatestBtn) jumpLatestBtn.hidden = true;
  appendSystemMessage("已清除聊天畫面（agent 端記憶仍保留）。");
}

if (clearChatBtn) clearChatBtn.addEventListener("click", clearChat);

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
  if (agents.some((a) => a.url === url)) { appendSystemMessage(`已經有一個 agent 用這個網址：${url}`); return; }
  agents.push({ name, url, token });
  persist();
  reconcileAgents();                                     // agents:seen follows the list (an addition is no URL edit)
  const c = new Conn(agents[agents.length - 1]);
  c.enabled = false;
  room.push(c);
  // Connected only if an open conversation is bound to its URL: one left read-only by removing an
  // agent with this URL comes back (agent-per-conversation §2.6).
  syncConnections();
  renderConvTabs();
  updateSendEnabled();
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
    const before = agents.map((a) => a.url);
    agents = [{ name, url }];
    persist();
    switchView("chat");
    buildRoom();
    // agent-per-conversation §2.4: the first-run setup binds the open conversations to the agent it
    // configures (they were on the placeholder agent it replaces).
    (async () => {
      for (const from of before) if (from !== url) await convStore.rebindAgent(from, url).catch(() => {});
      for (const conv of convs.values()) if (conv.agentUrl !== url) { delete conv.sessions[conv.agentUrl]; conv.agentUrl = url; }
      await reconcileAgents();
      syncConnections();
      updateSendEnabled();
    })();
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
      reconcileAgents();                                 // agents:seen gets the new name (§2.6 matches by name)
      updateRoster();
    });

    const url = document.createElement("input");
    url.className = "agent-url-input";
    url.value = a.url;
    url.addEventListener("change", () => {
      const next = url.value.trim() || a.url;
      url.value = next;
      if (next === a.url) return;
      if (agents.some((x) => x !== a && x.url === next)) { url.value = a.url; appendSystemMessage(`已經有一個 agent 用這個網址：${next}`); return; }
      // agent-per-conversation §2.6: every conversation on the old URL (open or archived) is rebound
      // to the new one before the agent reconnects there (its old Conn's cards close as disconnected).
      // Its Conn shares this agent object, so it is dropped first: nothing it saves while the
      // rebind runs may land under the new URL (its old server's session id under sessions[next]).
      const from = a.url;
      if (room[i]) room[i].disconnect();
      a.url = next;
      persist();
      // Rebound here, not through agents:seen (a rename since then would make it look like a
      // removal); reconcileAgents then only records the new list.
      rebindConversations(from, next)
        .catch((e) => console.warn("katashiro: rebinding conversations to an edited agent URL failed (retried on the next load):", e))
        .then(() => reconcileAgents())
        .finally(() => { reconnectConn(i); syncConnections(); renderConvTabs(); updateSendEnabled(); });
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

    // agent-per-conversation §2.5: how many conversations use it — open in this window, and in all
    // (archived and other windows too: the number the remove confirm gives). No "使用中" radio any
    // more: a conversation picks its agent at ＋.
    const uses = windowRec.open.filter((id) => convs.has(id) && convs.get(id).agentUrl === a.url).length;
    const total = ConvCore.conversationsUsing(convIndex, a.url);
    const useEl = document.createElement("span");
    useEl.className = "agent-uses" + (uses ? " on" : "");
    useEl.textContent = total ? `開著 ${uses} 段／共 ${total} 段` : "沒有對話";
    useEl.title = "開著：這個視窗開著、跟這個 agent 聊的對話；共：所有跟它聊的對話（含封存和其他視窗）";

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

    actions.appendChild(useEl);
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

// agent-per-conversation §2.6: removing an agent leaves its conversations read-only (adding the same
// URL back revives them), so a removal that touches any asks first.
function deleteAgent(i) {
  if (i < 0 || i >= agents.length) return;
  const n = ConvCore.conversationsUsing(convIndex, agents[i].url);
  if (n > 0 && !confirm(`${n} 段對話使用這個 agent，移除後無法再傳訊息（對話會保留，可以閱讀、封存或刪除；之後加回同一個網址就能繼續）。\n\n確定移除「${agents[i].name || "Agent"}」？`)) return;
  agents.splice(i, 1);
  // Only this agent's Conn goes (its cards close as disconnected): the other agents' conversations
  // may be replying right now, so the room is not rebuilt.
  const [gone] = room.splice(i, 1);
  if (gone) gone.disconnect();
  if (agents.length === 0) { agents = [{ ...DEFAULT_AGENT }]; buildRoom(); }
  persist();
  reconcileAgents();                                     // agents:seen follows the list (a removal is no URL edit)
  syncConnections();
  renderAgentList();
  renderConvTabs();
  updateSendEnabled();
  if (convAgentMissing(conversationId)) noteAgentMissing(currentConv);
}

// --- Pasted-image staging / Dropped files / Message input: moved to composer-ui.js; the load-time
// wiring and the DOM refs it reads stay here --------------------------------------------------------
// The staged attachments' preview strip (renderStagedPreviews, composer-ui.js).
const attachPreview = document.getElementById("attach-preview");
const messageInputPlaceholder = messageInput.placeholder;

// Dropped files (stageDroppedFiles, dragHasFiles / inDropZone / setDropHighlight: composer-ui.js).
const chatDropZone = chatView && chatView.querySelector(".chat-container");
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

// Message input (updateSendEnabled, sendMessage, stopReplyOnScreen: composer-ui.js).
messageInput.addEventListener("input", () => {
  updateSendEnabled();
  clearComposerHint();
  // "/" first in the composer opens the command menu; letters after it filter (CommandCore.menuQuery).
  const query = CommandCore.menuQuery(messageInput.value);
  if (query !== null) openCmdMenu("typed", query, cmdMenuState && cmdMenuState.items[cmdMenuState.selected].id);
  else if (cmdMenuState && cmdMenuState.via === "typed") closeCmdMenu();
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
  const active = connOfConv(conversationId);           // §2.7: the on-screen conversation's agent (staging is for it)
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
  // ⚡ command shortcuts (composer focused): Ctrl/⌘+/ toggles the menu, Ctrl/⌘+. stops the reply
  // like ⏹. Esc never stops a reply: it closes the menu, else clears the ↩ quote (below).
  const shortcut = CommandCore.composerShortcut(e);
  if (shortcut === "menu") { e.preventDefault(); if (cmdMenuState) closeCmdMenu(); else openCmdMenu("button"); return; }
  if (shortcut === "stop") { e.preventDefault(); stopReplyOnScreen(); return; }
  if (cmdMenuState && !e.isComposing && cmdMenuKey(e)) return;
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

if (stopBtn) stopBtn.addEventListener("click", stopReplyOnScreen);

// --- ⚡ command menu and commands: moved to cards.js --------------------------------------------
// What stays here from that section runs at load or is not a command: the ⚡ button and
// outside-click listeners, panel close, link clicks, sending, and the canvas → panel messages.
cmdBtn.addEventListener("click", () => {
  if (cmdMenuState) closeCmdMenu(); else openCmdMenu("button");
  messageInput.focus();                                  // the menu's keys work from the composer
});
// A click anywhere else closes the menu (its own items keep the focus in the composer).
document.addEventListener("mousedown", (e) => {
  if (cmdMenuState && !cmdMenu.contains(e.target) && !cmdBtn.contains(e.target) && !sendBtn.contains(e.target) && e.target !== messageInput) closeCmdMenu();
});

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

// The send (afterPageSend, sendMessage) moved to composer-ui.js; posting as the user stays here (the
// canvas → panel push below uses it too).
// Post a message as the user: show it, frame it, send it to the conversation's agent. Shared by the
// input box and the canvas's Send to agent / Send error (which compose their text in the canvas tab,
// §3.7). `files` (optional): dropped text files, expanded after the text in what the agent
// receives. Returns the agents it was enqueued to ([] or [its agent]).
function postUserText(text, images, replyTo, files, pageAt) {
  images = images || [];
  files = files || [];
  if (!currentConv) return [];
  // 💬 Ask agent on a page: not a ↩ (that names a chat message); the page target follows the text.
  const page = replyTo && replyTo.page ? replyTo.page : null;
  // Q4 (ADR ask-user §2.3): a message instead of answering closes the open ask cards OF THIS
  // CONVERSATION (multi-conversation §3.8); nothing is sent for them, this message goes out as usual.
  supersedePendingAsks(conversationId);
  closeCommandCards(conversationId);                     // …and a ⚡ command card still waiting there
  maybeAutoTitle(currentConv, text);                     // §3.3: the first user message names it
  // Unique per ms in this panel: the header's milliseconds name exactly this message (#62 follow-up).
  const sentAt = uniqueMsgMs(Date.now());
  const msgId = appendMessage({
    senderId: myUserId, senderName: myUserName, text, timestamp: sentAt,
    images: images.map((i) => i.dataUrl),                // show what we sent (not persisted to history)
    files: files.map((f) => ({ name: f.name, size: f.size })), // chips only; content is never kept
    replyTo: page ? { page: PageAskCore.historyPage(page) } : replyTo,
  });
  // What the agent receives: a [time sender (↩ quoted)] header + the text, so a batched backlog
  // keeps its message boundaries and a reply says what it answers (RoomCore.framePrompt).
  // A page target (§2.5): the plain [time user] header, the text, then the page as fenced data.
  const framed = page
    ? RoomCore.framePrompt({ timestamp: sentAt, senderName: "user", replyTo: null },
      PageAskCore.withPageTarget(Composer.expandAttachments(text, files), page, pageAt || {}))
    : RoomCore.framePrompt({
      timestamp: sentAt, senderName: "user",
      replyTo: replyTo && { timestamp: replyTo.timestamp, senderName: promptName(replyTo.senderName), text: replyTo.text, selection: replyTo.selection },
    }, RoomCore.withSelection(Composer.expandAttachments(text, files), replyTo && replyTo.selection));

  // A conversation's only recipient is its own agent (agent-per-conversation §2.7), and only while
  // this window wants it connected (`enabled`, user intent: a Conn reconnecting still queues, and
  // flushes once it is back). One not wanted must never pile up prompts in its queue (review: Orca).
  const c = connOfConv(conversationId);
  if (!c || !c.enabled) return [];
  // §7 I8 (review #160 nit 1): a resend flag left by a failed resend (error, not retried) is the
  // user's past, not this new message: only a requeued prompt still waiting keeps it.
  const st = c.stateFor(conversationId);
  if (st && st.resendPending && !st.turnActive && !st.promptQueue.length) st.resendPending = false;
  c.enqueue(framed, images, undefined, msgId);
  return [c];
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
  const active = connOfConv(cid);                       // §2.7: that conversation's agent
  if (!active || !active.initialized) { sendResponse({ ok: false, error: "the agent is not connected" }); return false; }
  if (cid !== conversationId) switchConversation(cid);   // P2: never blocked, a running reply continues behind
  seenPushIds.add(msg.reqId);
  const sentTo = postUserText(msg.text, [], null);
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
// --- canvas helpers / canvas folder mirror / canvas_view / canvas_gallery / canvas tab group + Split
// View / one tab group per conversation: moved to canvas-glue.js; the load-time wiring stays here ----
// Canvas folder mirror (runCanvasMirror, canvas-glue.js): a canvas change in storage queues a sync.
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
// Moved canvases (canvasMoveNotes, followMovedCanvas: canvas-glue.js): the notes are read at load,
// then kept current, and a moved canvas's tab follows it.
CanvasStore.getMatching(chrome.storage.local, (k) => MOVED_KEY_RE.test(k)).then((got) => {
  for (const [k, v] of Object.entries(got || {})) if (Array.isArray(v)) canvasMoveNotes.set(MOVED_KEY_RE.exec(k)[1], v);
}, () => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [k, ch] of Object.entries(changes)) {
    const mv = MOVED_KEY_RE.exec(k);
    if (mv) {
      if (Array.isArray(ch.newValue) && ch.newValue.length) canvasMoveNotes.set(mv[1], ch.newValue);
      else canvasMoveNotes.delete(mv[1]);
      continue;
    }
    const m = /^canvas:(cv_[0-9a-f]{12}):meta$/.exec(k);
    const from = m && ch.oldValue && ch.oldValue.conversationId;
    const to = m && ch.newValue && ch.newValue.conversationId;
    if (from && to && from !== to) followMovedCanvas(m[1], from, to);
  }
});
// A conversation's title change settles, then its mirror folder follows (canvasTitleSettle, canvas-glue.js).
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
// renderCanvasFolder / afterCanvasFolderConnected: canvas-glue.js.
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

// Tab events keep each conversation's group tabs and working tab current (canvas-glue.js).
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

// Split View moves (canvasSplitMoves, restoreCanvasTab, sweepCanvasRestores: canvas-glue.js).
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

// --- confirm card (#80) / ask card (katashiro.ask_user): moved to cards.js -------------------------
// The ask card's countdown counts only visible time (cards.js refreshAskVisibility); registered here
// so the listener order is unchanged.
document.addEventListener("visibilitychange", refreshAskVisibility);

// Q12: a conversation with a waiting card (hasWaitingCard, cards.js) — a notification…
// …raised when the user leaves a conversation with one: its tab shows ❓ and the OS shows this. The
// id carries the panel's window (only this panel claims the click) and the conversation to go back to.
let waitingNotifySeq = 0;
function notifyWaitingCard(id) {
  if (!chrome.notifications || typeof chrome.notifications.create !== "function" || panelWindowId == null) return;
  const title = ConvCore.displayTitle(convIndex[id], id);
  const nid = `${BrowserMcp.NOTIFY_ID_PREFIX}${panelWindowId}:conv:${id}:${Date.now()}-${++waitingNotifySeq}`;
  try {
    const p = chrome.notifications.create(nid, { type: "basic", iconUrl: "icons/icon128.png", title: "Katashiro：有問題等你回答", message: `「${title}」裡有一張卡片還沒回答。點這裡回到那段對話。` });
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
      type: "basic", iconUrl: "icons/icon128.png",
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

// --- reply-to / 💬 Ask agent on a web page: moved to composer-ui.js; the load-time wiring and the
// DOM refs it reads stay here ---------------------------------------------------------------------
// The ↩ quote chip (setReplyTarget, composer-ui.js).
const replyChip = document.getElementById("reply-chip");
// The page-ask input hint (hintPageAskInput / clearPageAskHint, composer-ui.js).
messageInput.addEventListener("focus", clearPageAskHint);
messageInput.addEventListener("animationend", () => messageInput.classList.remove("page-ask-flash"));

// A page target from the service worker (handlePageAsk, composer-ui.js).
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== PageAskCore.MSG_TYPE) return false;
  // §2.3 / §2.7: only from our own service worker (not another panel or extension page).
  if (!PageAskCore.fromServiceWorker(sender, { runtimeId: chrome.runtime.id, origin: new URL(chrome.runtime.getURL("")).origin })) return false;
  const p = PageAskCore.acceptPayload(msg);
  if (!p) return false;
  panelReady.then(() => { if (String(p.windowId) === String(panelWindowId)) handlePageAsk(p); });
  return false;
});

// 💬 on text selected in a chat message: what it does is described in composer-ui.js (above selAsk).
// The 💬 pill and its listeners (chatSelection / updateSelAsk / scheduleSelAsk: composer-ui.js).
const selAskPill = document.createElement("button");
selAskPill.type = "button";
selAskPill.className = "sel-ask-pill";
selAskPill.textContent = "💬";
selAskPill.title = "針對選取的文字問 agent";
selAskPill.hidden = true;
document.body.appendChild(selAskPill);

document.addEventListener("selectionchange", scheduleSelAsk);
messagesList.addEventListener("scroll", scheduleSelAsk, { passive: true });
window.addEventListener("resize", scheduleSelAsk);
// mousedown would clear the selection before the click lands.
selAskPill.addEventListener("mousedown", (e) => e.preventDefault());
selAskPill.addEventListener("click", () => {
  // Re-checked on click: the shown 💬 may be stale (the conversation switched without a
  // selectionchange, the message was trimmed). mousedown kept the selection, so it is still there.
  const s = chatSelection();
  if (!s) { selAsk = null; selAskPill.hidden = true; return; }
  const { target, text } = s;
  selAsk = null;
  selAskPill.hidden = true;
  const sel = document.getSelection();
  if (sel) sel.removeAllRanges();
  setReplyTarget({ ...target, selection: text });        // focuses the input
});

// --- Rendering helpers (continued) -----------------------------------------------------------------
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
  const r = { id: t.id, senderName: t.senderName, timestamp: t.timestamp, text: RoomCore.excerpt(t.text) };
  if (typeof t.selection === "string" && t.selection.trim()) r.selection = RoomCore.excerpt(t.selection, 500);
  return r;
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

// → the row's message id. `read`: the user's message already reached the agent (a replayed record).
function appendMessage({ senderId, senderName, text, timestamp, images, replyTo, historyCaption, files, read }) {
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

  // 💬 Ask agent on a page: the 📄 quote (the history's page, re-checked), not a ↩ quote.
  const page = replyTo && replyTo.page ? PageAskCore.readHistoryPage(replyTo.page) : null;
  if (page) content.appendChild(pageQuoteEl(page, targetConvId()));
  else if (replyTo) content.appendChild(replyQuoteEl(replyTo));

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
      // Full size in a new tab, like show_image (raster only: paste and drop take PNG/JPEG/GIF/WebP).
      im.addEventListener("click", () => openImageTab(src));
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
  if (isMe && read) ts.appendChild(readTagEl());
  content.appendChild(ts);

  // A files-only message is quoted by its markers, not as an empty quote.
  const quoteText = text || (Array.isArray(files) ? files.map(Composer.attachmentMarker).join(" ") : text);
  attachReplyButton(content, { id, senderName, timestamp, text: quoteText });

  msgDiv.appendChild(content);
  outList().appendChild(msgDiv);
  recordMessage({
    kind: isMe ? "sent" : "received", id, senderId, senderName, timestamp,
    replyTo: replyTo && !page ? recordReplyTo(replyTo) : undefined,
    page: page || undefined,                             // §2.6: kind, title, url (no query), excerpt, tabId
    // images are memory-only; a shown image's caption (rendered as a figcaption) is kept as text
    text: Composer.historyText(text || historyCaption || "", Array.isArray(images) ? images.length : 0, files),
    read: isMe ? !!read : undefined,                     // read receipt: set when a turn carrying it goes out
  });
  // The user's own message always pulls the view down (they expect to follow it); an incoming
  // relayed message only follows if they're already at the bottom.
  if (isMe && !scopeConv) scrollToBottom(); else maybeScroll();
  return id;
}

// Read receipt: a small gray "read" beside the time of a user message the agent has received.
function readTagEl() {
  const tag = document.createElement("span");
  tag.className = "read-tag";
  tag.textContent = "read";
  tag.title = "agent 已收到";
  return tag;
}

// Set (on) or clear the read receipt of the user messages `ids` in conversation `convId`: the
// stored record (persisted, so it survives a reload) and the row, if its list is built. Never
// part of what the agent sees (prompt, chat_history). → the ids whose receipt changed.
function setReadReceipts(convId, ids, on) {
  const conv = convs.get(convId);
  if (!conv || !ids || !ids.length) return [];
  const changed = [];
  for (const id of ids) {
    const rec = conv.messages.find((m) => m && m.kind === "sent" && m.id === id);
    if (!rec || RoomCore.isReadRecord(rec) === on) continue;   // cleared / trimmed, or already so
    rec.read = on;
    changed.push(id);
    const ts = conv.listEl && conv.listEl.querySelector(`[data-msg-id="${CSS.escape(id)}"] > .message-content > .timestamp`);
    const tag = ts && ts.querySelector(":scope > .read-tag");
    if (ts && on && !tag) ts.insertBefore(readTagEl(), ts.querySelector(":scope > .reply-btn"));
    else if (tag && !on) tag.remove();
  }
  if (changed.length) saveConv(conv);
  return changed;
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
// ⚡ takes the same slot while idle (one of the two always shows, so the layout never moves).
function updateStopButton() {
  const replying = !!(conversationId && convReplying(conversationId));
  if (stopBtn) stopBtn.hidden = !replying;
  if (cmdBtn) cmdBtn.hidden = replying && !!stopBtn;
  refreshCmdMenu();
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
