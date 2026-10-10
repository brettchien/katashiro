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
    windowId: panelWindowId, incognito: historyStore === chrome.storage.session,
    actMode, optionalPermissions,
  };
}
const ACP_CWD = "/home/agent";
// Default request timeout — guards a peer that goes silent WITHOUT closing the socket
// (onclose rejects pending reqs, but a half-open connection never fires it), which would
// otherwise wedge that conn's queue with turnActive stuck true.
const ACP_REQUEST_TIMEOUT_MS = 60000;
const ACP_PROMPT_TIMEOUT_MS = 600000; // 10 min — agent turns stream long before resolving
const RECONNECT_INTERVAL_MS = 5000;
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

// --- Conn: one agent's connection + session + turn state ---------------------
class Conn {
  constructor(agent) {
    this.agent = agent;                                 // { name, url, token, browserAccess }
    this.id = agent.url;                                // stable routing identity (unique per agent)
    this.enabled = true;                                // user intent: should this conn be up?
    this.ws = null;
    // Per-window isolation: each side panel (one per Chrome window) gets its OWN openab session
    // via session/new — do NOT seed from the chrome.storage-shared acpSessionByUrl, or two windows
    // on the same agent would resume the SAME session → one channel → one browser tunnel → mixed.
    // Resume across a WS reconnect still works (this field survives in memory on the Conn); resume
    // across a full reload is intentionally dropped for isolation.
    this.acpSessionId = null;
    this.acpReady = false;
    this.online = false;
    this.nextReqId = 1;
    this.pendingReqs = new Map();                        // id -> { resolve, reject }
    this.promptQueue = [];
    this.pendingImages = [];                             // { mimeType, data(base64) } to ride the next turn
    this.turnActive = false;
    this.lastPrompt = null;                              // last turn's text, for retry
    this.lastImages = [];                                // …and its images, so a retry re-sends them
    this.canImage = false;                               // initialize → promptCapabilities.image
    this.mcpServer = null;                               // our type:acp MCP server instance
    // Router state: declared instances + connectionId → instance. A second client-side MCP
    // server would just be another entry in `servers`; the gateway tunnels to each separately.
    this.mcpState = { servers: [], connections: {}, mcpConnectionId: null };
    this.browserAttached = false;
    this.reconnectTimer = null;
    this.stream = null;                                  // { bubble, text } while streaming
    this.lastFailure = null;                             // null | "auth" | "unreachable"
    this.openedThisAttempt = false;                      // did the current attempt reach onopen?
    this.heartbeatTimer = null;                          // liveness probe timer (ADR tunnel-liveness)
    this.alive = false;                                  // last heartbeat verdict (socket responding?)
    this.lastRecvAt = 0;                                 // ts of the last inbound frame (passive liveness §8.6)
    this.lastTunnelMsgAt = 0;                            // ts of the last inbound mcp/message (tunnel freshness §8.3)
    this.missedProbes = 0;                               // consecutive idle-probe timeouts (debounce §8.6)
  }

  get name() { return this.agent.name || "Agent"; }

  // Declared in session/new / session/resume so the gateway opens a browser tunnel to us.
  // Per-conn id so N tunnels to the same active tab coexist. (Phase 3 will gate this on
  // agent.browserAccess; Phase 1 always declares it.)
  browserMcpServers() {
    if (this.agent.browserAccess === false) return [];   // per-agent browser access control (off)
    if (!this.mcpServer) {
      this.mcpServer = BrowserMcp.createServer({
        id: crypto.randomUUID(),
        name: "katashiro",
        serverName: "katashiro-browser",
        // Report the extension's own version to the agent rather than a second number that
        // would drift — "which katashiro is this?" should have one answer.
        version: chrome.runtime.getManifest().version
      });
      this.mcpState.servers = [this.mcpServer];
    }
    return this.mcpState.servers.map((s) => s.declaration());
  }

  mcpDeps() {
    return {
      chrome,
      crypto,
      send: (obj) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
      },
      onStatus: (attached) => this.setBrowserAttached(attached),
      // Per-tool activity signal for the chat transcript: name + outcome + MASKED args/summary/ms
      // (browser-mcp.js applies each tool's redact hook; raw args never reach the UI).
      onToolCall: (info) => this.renderToolActivity(info),
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
      // chat_history reads this window's persisted scrollback; notify tags its toasts with the
      // window so the click handler below focuses the right one.
      chatHistory: () => historyMessages,
      clientInfo: clientInfoSnapshot,
      // show_image renders into THIS agent's current turn (or as its own message between turns).
      showImage: (img) => this.showImage(img),
      windowId: panelWindowId,
    };
  }

  setBrowserAttached(attached) {
    if (attached === this.browserAttached) return;       // only real transitions
    this.browserAttached = attached;
    // A fresh attach (mcp/connect) is itself proof the tunnel is live right now — stamp it so the
    // segment reads 活躍 immediately, not 閒置 until the first mcp/message arrives (Falcon review).
    if (attached) this.lastTunnelMsgAt = Date.now();
    updateRoster();
  }

  // Send a JSON-RPC request on THIS conn's socket; resolve when its response arrives.
  acpRequest(method, params, timeoutMs = ACP_REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject("socket not open");
        return;
      }
      const id = this.nextReqId++;
      const timer = setTimeout(() => {
        if (this.pendingReqs.delete(id)) reject(`request timed out: ${method}`);
      }, timeoutMs);
      this.pendingReqs.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  rejectAllPending(reason) {
    for (const { reject } of this.pendingReqs.values()) reject(reason);
    this.pendingReqs.clear();
  }

  // Open (or reopen) this conn's socket and run the handshake.
  connect() {
    this.enabled = true;
    this.stopHeartbeat();                                // don't probe across a teardown/reconnect
    if (this.ws) {
      this.ws.onclose = null;                            // stale socket must not trigger reconnect
      this.ws.close();
    }
    clearTimeout(this.reconnectTimer);
    this.online = false;
    this.acpReady = false;
    this.alive = false;
    this.missedProbes = 0;                               // fresh socket ⇒ fresh debounce count
    this.openedThisAttempt = false;
    updateRoster();

    try {
      this.ws = new WebSocket(this.agent.url, acpProtocols(this.agent.token));

      this.ws.onopen = () => {
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

      this.ws.onclose = () => {
        this.online = false;
        this.acpReady = false;
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
        // resumes acpSessionId if we have one.
        if (this.enabled) this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_INTERVAL_MS);
      };

      this.ws.onerror = (error) => {
        console.error(`WebSocket[${this.name}] error:`, error);
        this.online = false;
        updateRoster();
      };
    } catch (e) {
      console.error(`Error creating WebSocket[${this.name}]:`, e);
    }
  }

  // Tear down permanently (no reconnect) — used on delete / retarget.
  disconnect() {
    this.enabled = false;
    this.stopHeartbeat();
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.cancelTurn();                               // stop an in-flight turn server-side before dropping the
                                                       // socket, so the gateway cancels the agent-core turn instead
                                                       // of leaving it running (no-op if no turn / socket not open)
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.online = false;
    this.acpReady = false;
    this.alive = false;
    this.finalizeStream();
    // Captures are page data: none outlive this agent being active. (A transient socket drop
    // keeps them — the resumed session still holds their imageIds.)
    if (this.mcpServer) this.mcpServer.clearImages();
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

  handshake() {
    BUILD_INFO
      .then(({ version, detail }) => this.acpRequest("initialize", {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: RoomCore.acpClientInfo(version, detail),
      }))
      .then((init) => {
        // Only send image blocks to an agent that declares it takes them; the gateway answers
        // `image: false` (and -32602 on an image block) until it supports them.
        this.canImage = Composer.canImage(init);
        if (this.acpSessionId) {
          return this.acpRequest("session/resume", {
            sessionId: this.acpSessionId,
            cwd: ACP_CWD,
            mcpServers: this.browserMcpServers(),
          }).then(() => {
            this.acpReady = true;
            this.alive = true;
            this.startHeartbeat();
            updateRoster();
            saveHistory();                 // persist the (confirmed) resumable session id
            appendSystemMessage(`已續接 ${this.name} 的 ACP session（${(this.acpSessionId || "").slice(0, 13) || "?"}）。`);
            this.flushQueue();
          });
        }
        return this.acpRequest("session/new", {
          cwd: ACP_CWD,
          mcpServers: this.browserMcpServers(),
        }).then((res) => {
          this.acpSessionId = res && res.sessionId; // seeded per-window; persisted below
          this.acpReady = true;
          this.alive = true;
          this.startHeartbeat();
          updateRoster();
          saveHistory();                 // persist the new session id for this window
          appendSystemMessage(`已連線至 ${this.name}（ACP session ${(this.acpSessionId || "").slice(0, 13) || "?"}）。`);
          this.flushQueue();
        });
      })
      .catch((err) => {
        // A resume can fail if the session id is unknown → fall back to a fresh one.
        if (this.acpSessionId) {
          this.acpSessionId = null; // stale in-memory session → fall back to a fresh session/new
          if (this.ws && this.ws.readyState === WebSocket.OPEN) this.handshake();
        } else {
          appendSystemMessage(`${this.name} ACP 握手失敗：` + err);
        }
      });
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

    // Server-initiated request (id + method): the gateway driving THIS conn's browser MCP
    // tunnel (mcp/connect, mcp/message, mcp/disconnect). Route + respond on this socket.
    if (msg.id !== undefined && msg.method) {
      BrowserMcp.handleServerRequest(msg, this.mcpDeps(), this.mcpState);
      return;
    }

    // Streaming agent reply.
    if (msg.method === "session/update" && msg.params && msg.params.update) {
      const u = msg.params.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content) {
        this.appendToStream(u.content.text || "");
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        this.renderAgentToolCall(u);                     // the agent's own tools (Bash, Edit, …)
      }
    }
  }

  enqueue(text, images) {
    this.promptQueue.push(text);
    if (images && images.length) this.pendingImages.push(...images);
    this.flushQueue();
  }

  // Send the next queued turn if THIS conn is idle and ready.
  flushQueue() {
    if (this.turnActive || this.promptQueue.length === 0) return;
    if (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.acpReady && this.acpSessionId)) return;

    // Batch delivery: drain the WHOLE backlog and send it as one turn, not one-per-round. If the
    // agent was busy while the user (or a relay) piled up several messages, they arrive together on
    // the next round — Discord-style — instead of dribbling out over N turns.
    const batch = this.promptQueue.splice(0);
    let text = RoomCore.batchPrompts(batch);
    // (A retried batch already carries the note — don't stack a second one.)
    if (text && RoomCore.needsReplyHint(batch) && !text.endsWith(RoomCore.REPLY_HINT)) text += `\n\n${RoomCore.REPLY_HINT}`;
    let images = [];
    if (this.pendingImages.length && !this.canImage) {
      const n = this.pendingImages.splice(0).length;
      appendSystemMessage(`${this.name} 不支援圖片，${text ? "只送出文字" : "這則沒有送出"}（${n} 張圖片未送出）。`);
    } else {
      // Batched backlog may hold several messages' images: send what fits one frame's budget and
      // leave the rest (plus an empty prompt to carry them) for the next turn.
      while (this.pendingImages.length && (images.length === 0 || Composer.fitsBudget(images, this.pendingImages[0].data.length))) {
        images.push(this.pendingImages.shift());
      }
      if (this.pendingImages.length) this.promptQueue.push("");
    }
    if (!text && images.length === 0) return;            // nothing sendable — stay idle
    this.lastPrompt = text;                              // remember for retry (the whole batch)
    this.lastImages = images;
    this.turnActive = true;
    this.skippedToolCalls = new Set();                   // katashiro tool calls seen this turn
    updateStopButton();
    this.startStream();

    this.acpRequest("session/prompt", {
      sessionId: this.acpSessionId,
      prompt: Composer.promptBlocks(text, images),
    }, ACP_PROMPT_TIMEOUT_MS)
      .then((res) => {
        this.turnActive = false;
        updateStopButton();
        const replyText = this.stream ? this.stream.text : "";
        this.finalizeStream(res && res.stopReason);      // stopReason "cancelled" ⇒ partial reply kept
        relayAgentReply(this, replyText); // fan this agent's reply out to the room
        this.flushQueue();
      })
      .catch((err) => {
        this.turnActive = false;
        updateStopButton();
        const socketOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
        const action = RoomCore.promptFailureAction(RoomCore.isDeadProbeReason(String(err)), socketOpen);
        if (action === "requeue") {
          // The socket genuinely closed / half-opened (an explicit close, or a heartbeat teardown
          // that rejects the in-flight turn with "connection closed"). The prompt almost certainly
          // never landed, so re-queue it — the onclose-scheduled reconnect flushes it on a fresh
          // session (ADR R3). Safe: a dead socket means the agent never received this turn.
          this.promptQueue.unshift(text);
          this.pendingImages.unshift(...images);         // the images never landed either
          this.finalizeStream();
        } else if (action === "cancel") {
          // Socket still OPEN but the turn "timed out" — it is very likely still ALIVE server-side
          // (a long tool phase that outran the idle/prompt timer; cf. openab's text-only idle timer
          // that supersedes tool-heavy turns). The old code force-reconnected and re-sent here, which
          // DUPLICATED a turn the agent had already received and acted on — the resend fired on
          // resume and the agent ran the same message 2–3× (the reconnect-duplication bug). Never
          // auto-re-send into a live session: cancel the stale turn and let the USER re-issue via the
          // retry button. No reconnect either — the socket + tunnel are fine.
          if (this.acpSessionId) {
            this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.acpSessionId } }));
          }
          this.finalizeStream();
          appendErrorMessage(this.name, "回合逾時（連線仍在）—— 已取消，未自動重送以免重複。需要就點重試。", () => this.retryLast());
        } else {
          this.finalizeStream("error");                  // render any partial reply, then a distinct
          appendErrorMessage(this.name, "回合失敗：" + String(err), () => this.retryLast()); // error bubble
        }
        this.flushQueue();
      });
  }

  // Stop the in-flight turn: session/cancel is a one-way NOTIFICATION (no id). The gateway fires
  // the prompt's cancel signal, which resolves our session/prompt request with stopReason
  // "cancelled" — so the normal .then path finalizes the (partial) reply; nothing to settle here.
  cancelTurn() {
    if (!this.turnActive || !this.acpSessionId) return;
    if (!(this.ws && this.ws.readyState === WebSocket.OPEN)) return;
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.acpSessionId } }));
  }

  // Re-send the last turn (after an error / stop). If the socket isn't live, reconnect first and
  // queue the turn so it flushes once the handshake completes — otherwise a retry on a dead/closed
  // socket would silently no-op (ADR tunnel-liveness R3, the reported "retry does nothing").
  retryLast() {
    // Single-active: a stale error bubble from a now-dormant agent still has a live 重試 button;
    // clicking it must NOT `connect()` this dormant Conn — that would bring a second agent online
    // alongside the active one (review: Orca, the C2 race).
    if (this.agent.url !== activeAgentUrl) return;
    if ((!this.lastPrompt && this.lastImages.length === 0) || this.turnActive) return;
    this.promptQueue.push(this.lastPrompt || "");        // "" still carries an image-only turn
    this.pendingImages.push(...this.lastImages);
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.acpReady) this.flushQueue();
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
    if (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.acpReady)) return; // nothing to probe
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
      this.connect();                                    // teardown + re-handshake (resume re-declares tunnel)
    }
  }

  // --- Streaming bubble (per conn — agents stream concurrently) --------------
  startStream() {
    this.stream = { bubble: null, text: "" };
    // Built entirely with createElement (no innerHTML) so the whole row is off the XSS-review
    // surface; name/avatar/time are set via textContent.
    const msgDiv = document.createElement("div");
    msgDiv.className = "message received";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
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
    messagesList.appendChild(msgDiv);
    this.stream.bubble = bubble;
    this.stream.contentEl = contentEl;   // anchor for the tool-activity strip (inserted above bubble)
    maybeScroll();
  }

  // Append a compact browser-tool activity marker to the current turn: verb + ⏳/✓/✗. It lets
  // the user see that tools ran (and whether they succeeded) during a long, text-silent tool
  // sequence — distinct from the agent's reply bubble, never confused for text. Details stay out
  // of the strip: hover shows the command + outcome + duration, click expands the full (masked)
  // arguments and a result excerpt underneath. `info.args` is already masked by browser-mcp.js.
  renderToolActivity(info) {
    if (!info || !info.name || !this.turnActive) return;   // only annotate an in-flight agent turn
    const s = this.ensureToolStrip();
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
    maybeScroll();
  }

  // The current turn's tool-activity strip (above the reply bubble), created on first use.
  // katashiro.show_image: decode first (a non-image rejects, so the tool reports it), then show it
  // inside the in-flight turn — between the tool strip and the reply bubble — or, between turns,
  // as a standalone message from this agent. Memory-only like pasted images; history gets a marker.
  async showImage({ dataUrl, caption }) {
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
    if (this.turnActive) {
      if (!this.stream || !this.stream.bubble) this.startStream();
      const s = this.stream;
      s.contentEl.insertBefore(fig, s.bubble);
      s.imageCount = (s.imageCount || 0) + 1;
      maybeScroll();
    } else {
      appendMessage({ senderId: this.id, senderName: this.name, text: caption, images: [src] });
    }
    return { width: im.naturalWidth, height: im.naturalHeight };
  }

  ensureToolStrip() {
    if (!this.stream || !this.stream.bubble) this.startStream();
    const s = this.stream;
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
  renderAgentToolCall(update) {
    if (!this.turnActive) return;                        // only annotate an in-flight agent turn
    const known = this.stream && this.stream.agentToolPills;
    const prev = (known && update && known.get(update.toolCallId)) || null;
    if (prev && AgentTools.isBrowserToolCall(update)) {
      // A placeholder title refined into a katashiro tool name: the browser pill covers it.
      prev.el.remove();
      known.delete(update.toolCallId);
      if (this.skippedToolCalls) this.skippedToolCalls.add(update.toolCallId);
      return;
    }
    const next = AgentTools.applyToolCallUpdate(prev && prev.info, update, this.skippedToolCalls);
    if (!next) return;                                   // not ours / unknown id with nothing to show
    const s = this.ensureToolStrip();
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
    maybeScroll();
  }

  appendToStream(chunk) {
    if (!chunk) return;                                  // keep dots until real text arrives
    if (!this.stream || !this.stream.bubble) this.startStream();
    if (this.stream.text === "") this.stream.bubble.classList.remove("typing");
    this.stream.text += chunk;
    this.stream.bubble.textContent = this.stream.text;   // textContent: no HTML injection
    maybeScroll();
  }

  finalizeStream(stopReason) {
    const s = this.stream;
    this.stream = null; // reset first: a render throw must not orphan stream state onto the next turn
    if (!s || !s.bubble) return;
    settleRunningPills(s);
    const cancelled = stopReason === "cancelled";
    if (s.text === "") {
      // Drop a bubble the turn never wrote into (e.g. a mid-turn disconnect). If the user stopped
      // it before any text arrived, say so rather than vanishing silently.
      // Exception: a turn that ran browser tools but emitted no text is a legitimate pure-action
      // turn — keep the row (and its tool-activity strip) so the user still sees what happened;
      // only the empty typing bubble is dropped.
      if ((s.toolStrip && s.toolStrip.childElementCount > 0) || s.imageCount) {
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
    const doneAt = Date.now();
    const split = RoomCore.replyParts(s.text);
    const first = split[0];
    const firstReply = first.replyTo ? replyTargetFor(first.replyTo) : null;
    renderMarkdownInto(s.bubble, first.text);
    if (firstReply && s.contentEl) s.contentEl.insertBefore(replyQuoteEl(firstReply), s.bubble);
    const row = s.bubble.closest(".message");
    const firstId = RoomCore.messageId(conversationId, doneAt);
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
        senderId: this.id, senderName: this.name, text: p.text, timestamp: doneAt + i + 1,   // +1 ms: distinct ids
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
    const c = new Conn(a);
    // Seed this window's saved session id so the first handshake resumes (not session/new).
    if (savedSessions[a.url]) c.acpSessionId = savedSessions[a.url];
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
// window's scrollback and resumable ACP session ids (storage.local) and synced settings survive
// (incognito windows keep theirs in storage.session, which the reload clears). Confirmed with
// confirm(), like 清除聊天. In-flight turns get session/cancel first, with a short delay so the
// notification leaves before the page dies (pagehide's cancel is best effort).
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
const CONFIG_KEYS = ["agents", "wsUrl", "roomConfig", "actMode", "activeAgentUrl", "jevToken", "screenshotConfig"];
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
    await loadHistory();   // seed saved session ids + replay scrollback BEFORE building/connecting
    buildRoom();
    connectAll();
    updateRoster();
  }
);

// katashiro.notify toasts: a click brings this panel's window forward. Every open panel hears every
// click, so each claims only the ids tagged with its own window.
if (chrome.notifications && chrome.notifications.onClicked) {
  chrome.notifications.onClicked.addListener((id) => {
    if (panelWindowId == null || id.indexOf(`${BrowserMcp.NOTIFY_ID_PREFIX}${panelWindowId}:`) !== 0) return;
    if (typeof panelWindowId === "number") chrome.windows.update(panelWindowId, { focused: true });
    chrome.notifications.clear(id);
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
    }
    renderSyncBadge();
    appendSystemMessage("已從 Google 帳號同步還原設定。");
  });
});

function persist() {
  userEdited = true;
  runningOnDefaults = false;           // whatever is in memory now is intentional, not a placeholder
  const cfg = { agents, roomConfig, actMode, activeAgentUrl, jevToken, screenshotConfig };
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

// --- Chat history (per-window, chrome.storage.local) --------------------------
// The side panel is a plain extension page: closing it tears down the DOM, losing the scrollback.
// Persist the messages AND each agent's resumable ACP session id to chrome.storage.local, keyed
// by window, so reopening the panel restores the same conversation and resumes the same session
// (the "已續接 …" path). Keyed by window so two windows keep separate history + sessions — the
// per-window isolation, but now restorable (the old shared-by-url seed was the thing that mixed
// tunnels; a per-window key does not). storage.local (not storage.session) so the scrollback also
// survives an extension reload / update — that is what lets a restarted agent recover the
// conversation via `chat_history`. It IS written to disk (the Chrome profile), never synced.
// Window ids are only stable for one browser run: after a browser restart the old keys belong to no
// window, so loadHistory() prunes every `history:<id>` whose window is gone.
// Incognito windows (manifest incognito defaults to "spanning", so they share storage.local) keep
// storage.session instead — an incognito conversation must never reach the profile on disk.
const HISTORY_CAP = 200;
const HISTORY_PREFIX = "history:";
let historyStore = chrome.storage.local;  // storage.session for an incognito window (loadHistory)
let historyKey = null;                    // "history:<windowId>"
let panelWindowId = null;                 // the window this panel lives in (set by loadHistory)
let savedSessions = {};                   // { <agentUrl>: acpSessionId } seeded at startup
const historyMessages = [];               // in-memory mirror of the persisted scrollback
// This scrollback's stable conversation id — message ids are `<conversationId>:<ms timestamp>`
// (RoomCore.messageId), the reference a reply points at. Minted once, kept across clears/reloads.
let conversationId = null;
function newConversationId() {
  return "c_" + globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}
let restoring = false;                    // true while replaying — suppresses re-recording

function currentWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getCurrent((w) => resolve({
        id: w && w.id != null ? w.id : "default",
        incognito: !!(w && w.incognito),
      }));
    } catch { resolve({ id: "default", incognito: false }); }
  });
}

function saveHistory() {
  if (!historyKey) return;
  const sessions = {};
  room.forEach((c) => { if (c.acpSessionId) sessions[c.agent.url] = c.acpSessionId; });
  historyStore.set({ [historyKey]: { conversationId, sessions, messages: historyMessages } });
}

// Append a record to the persisted scrollback (skipped while restoring). System/status notices are
// deliberately NOT recorded — they are regenerated on each (re)connect (the 已續接/已連線 lines).
function recordMessage(rec) {
  if (restoring) return;
  historyMessages.push(rec);
  if (historyMessages.length > HISTORY_CAP) historyMessages.splice(0, historyMessages.length - HISTORY_CAP);
  saveHistory();
}

function replayMessage(rec) {
  if (rec.kind === "error") appendErrorMessage(rec.senderName, rec.text, null); // no retry on restore
  else appendMessage({ senderId: rec.senderId, senderName: rec.senderName, text: rec.text, timestamp: rec.timestamp, replyTo: rec.replyTo || null });
}

// Drop the scrollback of windows that no longer exist (closed, or ids from a previous browser run).
// Only numeric window keys are pruned; the "default" fallback key is left alone. Best effort.
// Always prunes storage.local (the on-disk copy), whichever store this window uses. getAll() lists
// only normal + popup windows by default, so ask for every type — a panel in an app/devtools window
// would otherwise prune its own key on each open.
const ALL_WINDOW_TYPES = ["normal", "popup", "panel", "app", "devtools"];
async function pruneOrphanHistory() {
  try {
    const [all, wins] = await Promise.all([
      chrome.storage.local.get(null),
      chrome.windows.getAll({ windowTypes: ALL_WINDOW_TYPES }),
    ]);
    const live = new Set(wins.map((w) => String(w.id)));
    const stale = Object.keys(all).filter((k) => {
      if (!k.startsWith(HISTORY_PREFIX)) return false;
      const id = k.slice(HISTORY_PREFIX.length);
      return /^\d+$/.test(id) && !live.has(id);
    });
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch (_) { /* pruning is housekeeping — never block the panel on it */ }
}

// Load per-window history + saved session ids and replay the scrollback. Runs BEFORE the room is
// built so each conn seeds its acpSessionId (→ session/resume restores the same conversation) and
// the restored messages sit above the reconnect notices.
async function loadHistory() {
  const win = await currentWindow();
  panelWindowId = win.id;
  historyKey = `${HISTORY_PREFIX}${win.id}`;
  if (win.incognito) historyStore = chrome.storage.session;
  await pruneOrphanHistory();
  const got = await historyStore.get(historyKey);
  const data = (got && got[historyKey]) || {};
  savedSessions = data.sessions || {};
  conversationId = data.conversationId || newConversationId();
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  if (msgs.length) {
    restoring = true;
    historyMessages.push(...msgs);                       // first, so replayed "↩ time" markers resolve
    msgs.forEach(replayMessage);
    restoring = false;
  }
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
}

// --- UI event listeners ------------------------------------------------------
settingsBtn.addEventListener("click", () => {
  renderRoomConfig();
  renderActMode();
  renderAgentList();
  if (jevTokenInput) jevTokenInput.value = jevToken;
  renderScreenshotConfig();
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

// Clear the on-screen scrollback + this window's persisted mirror (storage.local). The agents'
// resumable ACP sessions are deliberately KEPT — this wipes the local transcript without making the
// agents forget, so `session/resume` still restores their side of the conversation on reconnect,
// just not the cleared bubbles. Guarded by a confirm since storage.local is the only copy.
function clearChat() {
  if (!confirm("清除聊天畫面？agent 端的對話記憶會保留，只清掉這個視窗顯示的訊息。")) return;
  messagesList.replaceChildren();
  historyMessages.length = 0;
  saveHistory();                 // persist the now-empty scrollback (session ids untouched)
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
    room.forEach((c) => { if (c.mcpServer) c.mcpServer.setImageStoreMax(screenshotConfig.storeMax); });
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
let stagingChain = Promise.resolve();                    // serialize pastes so the budget check holds
let stagingPending = 0;                                  // pastes still encoding — send waits for them

function updateSendEnabled() {
  sendBtn.disabled = stagingPending > 0 || (messageInput.value.trim().length === 0 && stagedImages.length === 0);
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
  attachPreview.hidden = stagedImages.length === 0;
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

async function stageImages(blobs) {
  for (const blob of blobs) {
    if (blob.size > MAX_SOURCE_BYTES) {
      appendSystemMessage(`圖片太大（約 ${Math.round(blob.size / 1048576)}MB），未附加`);
      continue;
    }
    const budget = Composer.MAX_TOTAL_IMAGE_B64 - Composer.stagedSize(stagedImages);
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
    stagedImages.push({ ...img, dataUrl: `data:${img.mimeType};base64,${img.data}` });
    renderStagedPreviews();
    updateSendEnabled();
  }
}

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
  stagingChain = stagingChain
    .then(() => stageImages(blobs))
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
if (stopBtn) stopBtn.addEventListener("click", () => room.forEach((c) => c.cancelTurn()));

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
  const text = messageInput.value.trim();
  const images = stagedImages.slice();                   // snapshot the staged attachments
  if (stagingPending > 0) return;                        // Enter mid-encode: don't strand the image for the next message
  if (!text && images.length === 0) return;

  const sentAt = Date.now();
  const replyTo = replyTarget;                           // what this message answers (or null)
  appendMessage({
    senderId: myUserId, senderName: myUserName, text, timestamp: sentAt,
    images: images.map((i) => i.dataUrl),                // show what we sent (not persisted to history)
    replyTo,
  });
  setReplyTarget(null);
  // What the agent receives: a [time sender (↩ quoted)] header + the text, so a batched backlog
  // keeps its message boundaries and a reply says what it answers (RoomCore.framePrompt).
  const framed = RoomCore.framePrompt({
    timestamp: sentAt, senderName: "user",
    replyTo: replyTo && { timestamp: replyTo.timestamp, senderName: promptName(replyTo.senderName), text: replyTo.text },
  }, text);

  loopGuard.onHuman();
  const targets = RoomCore.resolveTargets(roomMembers(), myUserId, { mode: roomConfig.mode, text });
  targets.forEach((id) => {
    const c = connById(id);
    if (c) c.enqueue(framed, images);
  });

  messageInput.value = "";
  messageInput.style.height = "auto";
  stagedImages = [];
  renderStagedPreviews();
  sendBtn.disabled = true;
}

// Relay an agent's finalized reply into the room so OTHER agents can see + respond to it — the
// "talk to each other like a Discord thread" mechanic. Wrapped with attribution, routed per
// mode, and bounded by the loop guard (surfaces a system line once when the cascade is paused).
function relayAgentReply(originConn, text) {
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
    if (c) c.enqueue(wrapped);
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
// --- show_image helpers ---------------------------------------------------------
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
  contentEl.appendChild(b);
}

// The newest recorded message sent in the second this ISO stamp names, as a reply target.
function findMessageByTime(stamp) {
  // Agents almost always answer the USER, so when several messages share that second prefer the
  // user's; otherwise the newest match.
  let fallback = null;
  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const m = historyMessages[i];
    if (!m || !Number.isFinite(m.timestamp) || m.kind === "error" || !RoomCore.sameSecond(stamp, m.timestamp)) continue;
    const t = { id: m.id || RoomCore.messageId(conversationId, m.timestamp), senderName: m.senderName, timestamp: m.timestamp, text: m.text };
    if (m.kind === "sent") return t;
    if (!fallback) fallback = t;
  }
  return fallback;
}

// The quote target for an agent's "↩ <time>" marker: the matched message, or a placeholder that
// says the original was not found (its quote does not jump anywhere).
function replyTargetFor(stamp) {
  return findMessageByTime(stamp) ||
    { id: null, senderName: "?", timestamp: Date.parse(stamp), text: "（找不到原訊息）" };
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
  const row = messagesList.querySelector(`[data-msg-id="${CSS.escape(id)}"]`);
  if (!row) return;                                      // trimmed out of the 200-message scrollback
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.classList.add("flash");
  setTimeout(() => row.classList.remove("flash"), 1500);
}

function appendMessage({ senderId, senderName, text, timestamp, images, replyTo }) {
  const isMe = senderId === myUserId;
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${isMe ? "sent" : "received"}`;
  const id = RoomCore.messageId(conversationId, timestamp);
  msgDiv.dataset.msgId = id;

  if (!isMe) {
    const avatar = document.createElement("div");
    avatar.className = "avatar";
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
  if (text) {                                           // sanitized sink (ADR §3.2) — never raw innerHTML
    if (isMe) renderMarkdownInto(bubble, text);
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
  content.appendChild(bubble);

  const ts = document.createElement("div");
  ts.className = "timestamp";
  ts.textContent = formatTime(timestamp);
  content.appendChild(ts);

  attachReplyButton(content, { id, senderName, timestamp, text });

  msgDiv.appendChild(content);
  messagesList.appendChild(msgDiv);
  recordMessage({
    kind: isMe ? "sent" : "received", id, senderId, senderName, timestamp,
    replyTo: replyTo ? recordReplyTo(replyTo) : undefined,
    text: Composer.historyText(text, Array.isArray(images) ? images.length : 0), // images are memory-only
  });
  // The user's own message always pulls the view down (they expect to follow it); an incoming
  // relayed message only follows if they're already at the bottom.
  if (isMe) scrollToBottom(); else maybeScroll();
}

// System notices carry handshake error strings (remote-reachable) — same XSS sink, same
// fix: textContent, never innerHTML.
function appendSystemMessage(text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = "message system";
  const inner = document.createElement("div");
  inner.className = "system-text";
  inner.textContent = text;
  msgDiv.appendChild(inner);
  messagesList.appendChild(msgDiv);
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
  messagesList.appendChild(msgDiv);
  recordMessage({ kind: "error", senderName, text, timestamp: Date.now() });
  maybeScroll();
}

// The stop button is shown whenever ANY agent has a turn in flight; clicking it cancels them all.
function anyTurnActive() {
  return room.some((c) => c.turnActive);
}
function updateStopButton() {
  if (stopBtn) stopBtn.hidden = !anyTurnActive();
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
