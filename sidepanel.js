// Katashiro side panel — multi-agent room (Phase 1: N simultaneous connections).
//
// Each configured agent gets its OWN live WebSocket + ACP session, held in a `Conn`
// instance. All room members are connected at once; a user message is BROADCAST to
// every connected agent, and each agent streams its own reply (attributed) into the
// shared scrollback. There is NO agent-to-agent relay yet (that is Phase 2).

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

// Room routing config (mode + loop-guard cap). RoomCore owns the pure logic; we persist it.
let roomConfig = RoomCore.defaultRoomConfig();
let loopGuard = RoomCore.createLoopGuard(roomConfig.loopGuardCap);

// Act mode: may an agent CHANGE the page, or only read it? Off means read_dom/screenshot work
// and click/type/navigate are refused. Kept separate from roomConfig — that one is about who
// hears whom, this one is a consent boundary on the browser. Default off, and deliberately not
// per-agent: it answers "may this browser be written to at all", which the tab, not the agent,
// is the subject of.
let actMode = false;
function roomMembers() {
  return room.map((c) => ({ id: c.id, name: c.name }));
}
function connById(id) {
  return room.find((c) => c.id === id) || null;
}

// ACP constants
const ACP_PROTOCOL_VERSION = 1;
const ACP_CWD = "/home/agent";
// Default request timeout — guards a peer that goes silent WITHOUT closing the socket
// (onclose rejects pending reqs, but a half-open connection never fires it), which would
// otherwise wedge that conn's queue with turnActive stuck true.
const ACP_REQUEST_TIMEOUT_MS = 60000;
const ACP_PROMPT_TIMEOUT_MS = 600000; // 10 min — agent turns stream long before resolving
const RECONNECT_INTERVAL_MS = 5000;

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
    this.turnActive = false;
    this.mcpServer = null;                               // our type:acp MCP server instance
    // Router state: declared instances + connectionId → instance. A second client-side MCP
    // server would just be another entry in `servers`; the gateway tunnels to each separately.
    this.mcpState = { servers: [], connections: {}, mcpConnectionId: null };
    this.browserAttached = false;
    this.reconnectTimer = null;
    this.stream = null;                                  // { bubble, text } while streaming
    this.lastFailure = null;                             // null | "auth" | "unreachable"
    this.openedThisAttempt = false;                      // did the current attempt reach onopen?
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
        serverName: "katashiro-browser"
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
      // Read at dispatch time, not captured at connect time, so flipping the toggle applies to
      // the very next tool call — no reconnect, no stale consent.
      actMode,
    };
  }

  setBrowserAttached(attached) {
    if (attached === this.browserAttached) return;       // only real transitions
    this.browserAttached = attached;
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
    if (this.ws) {
      this.ws.onclose = null;                            // stale socket must not trigger reconnect
      this.ws.close();
    }
    clearTimeout(this.reconnectTimer);
    this.online = false;
    this.acpReady = false;
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
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.online = false;
    this.acpReady = false;
    this.finalizeStream();
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
    this.acpRequest("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {},
    })
      .then(() => {
        if (this.acpSessionId) {
          return this.acpRequest("session/resume", {
            sessionId: this.acpSessionId,
            cwd: ACP_CWD,
            mcpServers: this.browserMcpServers(),
          }).then(() => {
            this.acpReady = true;
            updateRoster();
            appendSystemMessage(`已續接 ${this.name} 的 ACP session。`);
            this.flushQueue();
          });
        }
        return this.acpRequest("session/new", {
          cwd: ACP_CWD,
          mcpServers: this.browserMcpServers(),
        }).then((res) => {
          this.acpSessionId = res && res.sessionId; // in-memory only (per-window; see constructor)
          this.acpReady = true;
          updateRoster();
          appendSystemMessage(`已連線至 ${this.name} (ACP)。`);
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
      }
    }
  }

  enqueue(text) {
    this.promptQueue.push(text);
    this.flushQueue();
  }

  // Send the next queued turn if THIS conn is idle and ready.
  flushQueue() {
    if (this.turnActive || this.promptQueue.length === 0) return;
    if (!(this.ws && this.ws.readyState === WebSocket.OPEN && this.acpReady && this.acpSessionId)) return;

    const text = this.promptQueue.shift();
    this.turnActive = true;
    this.startStream();

    this.acpRequest("session/prompt", {
      sessionId: this.acpSessionId,
      prompt: [{ type: "text", text }],
    }, ACP_PROMPT_TIMEOUT_MS)
      .then((res) => {
        this.turnActive = false;
        const replyText = this.stream ? this.stream.text : "";
        this.finalizeStream(res && res.stopReason);
        relayAgentReply(this, replyText); // fan this agent's reply out to the room
        this.flushQueue();
      })
      .catch((err) => {
        this.turnActive = false;
        if (/closed|not open/i.test(String(err))) {
          this.promptQueue.unshift(text);                // retry after resume
          this.finalizeStream();
        } else {
          this.appendToStream("\n[錯誤] " + err);
          this.finalizeStream("error");
        }
        this.flushQueue();
      });
  }

  // --- Streaming bubble (per conn — agents stream concurrently) --------------
  startStream() {
    this.stream = { bubble: null, text: "" };
    const msgDiv = document.createElement("div");
    msgDiv.className = "message received";
    const time = formatTime(Date.now());
    // Fixed template (no user data interpolated); name/avatar set via textContent below.
    msgDiv.innerHTML = `
      <div class="avatar"></div>
      <div class="message-content">
        <div class="sender-name"></div>
        <div class="bubble"></div>
        <div class="timestamp">${time}</div>
      </div>
    `;
    msgDiv.querySelector(".avatar").textContent = this.name.charAt(0).toUpperCase();
    msgDiv.querySelector(".sender-name").textContent = this.name;
    messagesList.appendChild(msgDiv);
    const bubble = msgDiv.querySelector(".bubble");
    bubble.classList.add("typing");
    bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
    this.stream.bubble = bubble;
    scrollToBottom();
  }

  appendToStream(chunk) {
    if (!chunk) return;                                  // keep dots until real text arrives
    if (!this.stream || !this.stream.bubble) this.startStream();
    if (this.stream.text === "") this.stream.bubble.classList.remove("typing");
    this.stream.text += chunk;
    this.stream.bubble.textContent = this.stream.text;   // textContent: no HTML injection
    scrollToBottom();
  }

  finalizeStream(_stopReason) {
    // Drop a bubble the turn never wrote into (e.g. a mid-turn disconnect).
    if (this.stream && this.stream.bubble && this.stream.text === "") {
      const row = this.stream.bubble.closest(".message");
      if (row) row.remove();
    }
    this.stream = null;
  }
}

// --- Room lifecycle ----------------------------------------------------------
function buildRoom() {
  room.forEach((c) => c.disconnect());
  room.length = 0;
  agents.forEach((a) => room.push(new Conn(a)));
}

function connectAll() {
  room.forEach((c) => c.connect());
}

// Replace a single conn in place (retarget on url/token change).
function reconnectConn(i) {
  if (i < 0 || i >= room.length) return;
  if (room[i]) room[i].disconnect();
  room[i] = new Conn(agents[i]);
  room[i].connect();
}

// --- DOM refs ----------------------------------------------------------------
const messagesList = document.getElementById("messages-list");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const statusIndicator = document.querySelector(".status-indicator");
const settingsBtn = document.getElementById("settings-btn");
const connectBtn = document.getElementById("connect-btn");
const wsUrlInput = document.getElementById("ws-url-input");
const rosterEl = document.getElementById("roster");
const activeAgentLabel = document.getElementById("active-agent-label");

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

const actReadBtn = document.getElementById("act-read");
const actWriteBtn = document.getElementById("act-write");
const actModeHintEl = document.getElementById("act-mode-hint");

// --- Startup -----------------------------------------------------------------
chrome.storage.local.get(["agents", "wsUrl", "roomConfig", "actMode"], (r) => {
    if (Array.isArray(r.agents) && r.agents.length) {
      agents = r.agents;
    } else if (r.wsUrl) {
      agents = [{ name: "OpenAB", url: r.wsUrl }];
    } else {
      agents = [{ ...DEFAULT_AGENT }];
    }
    roomConfig = RoomCore.normalizeRoomConfig(r.roomConfig);
    loopGuard = RoomCore.createLoopGuard(roomConfig.loopGuardCap);
    // Strict true: anything stored malformed (or absent) reads as read-only. The safe state
    // is the one you fall back into.
    actMode = r.actMode === true;
    persist();

    switchView("chat");
    buildRoom();
    connectAll();
    updateRoster();
  }
);

function persist() {
  chrome.storage.local.set({ agents, roomConfig, actMode });
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
    const st = connState(c);
    const chip = document.createElement("div");
    chip.className = "roster-chip " + st.cls;

    const dot = document.createElement("span");
    dot.className = "roster-dot";
    chip.appendChild(dot);

    const nm = document.createElement("span");
    nm.className = "roster-name";
    nm.textContent = c.name;                             // textContent: agent name is user config
    chip.appendChild(nm);

    if (c.browserAttached) {
      const br = document.createElement("span");
      br.className = "roster-browser";
      br.textContent = "🔗";
      br.title = "瀏覽器已連結 — 此 agent 可操作目前分頁";
      chip.appendChild(br);
    }

    chip.title = st.label;
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
  else if (viewName === "chat") chatView.classList.add("active");
  else if (viewName === "settings") settingsView.classList.add("active");
}

// --- UI event listeners ------------------------------------------------------
settingsBtn.addEventListener("click", () => {
  renderRoomConfig();
  renderActMode();
  renderAgentList();
  switchView("settings");
});

cancelSettingsBtn.addEventListener("click", () => switchView("chat"));

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
}

addAgentBtn.addEventListener("click", () => {
  const name = newAgentName.value.trim();
  const url = newAgentUrl.value.trim();
  const token = (newAgentToken?.value || "").trim();
  if (!name || !url) return;
  agents.push({ name, url, token });
  persist();
  const c = new Conn(agents[agents.length - 1]);
  room.push(c);
  c.connect();
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
    agents = [{ name: "OpenAB", url }];
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
      if (next !== a.url) { a.url = next; persist(); reconnectConn(i); updateRoster(); }
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
    meta.appendChild(tok);

    const actions = document.createElement("div");
    actions.className = "agent-actions";

    // Connect / disconnect toggle (reflects user intent, not transient network state).
    const connToggle = document.createElement("button");
    const isEnabled = !!(c && c.enabled);
    connToggle.className = "agent-conn-toggle" + (isEnabled ? " on" : "");
    connToggle.textContent = isEnabled ? "斷線" : "連線";
    connToggle.title = isEnabled ? "中斷此 agent 連線" : "連線此 agent";
    connToggle.addEventListener("click", () => {
      if (c && c.enabled) c.disconnect();
      else if (c) c.connect();
      renderAgentList();
      updateRoster();
    });

    // Per-agent browser access control (on ⇒ declares the browser MCP tunnel for this agent).
    const brOn = a.browserAccess !== false;              // default on (backward compatible)
    const brToggle = document.createElement("button");
    brToggle.className = "agent-browser-toggle" + (brOn ? " on" : "");
    brToggle.textContent = brOn ? "🔗 開" : "🔗 關";
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

    actions.appendChild(connToggle);
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
  if (room[i]) room[i].disconnect();
  room.splice(i, 1);
  agents.splice(i, 1);
  if (agents.length === 0) {
    agents = [{ ...DEFAULT_AGENT }];
    buildRoom();
    connectAll();
  }
  persist();
  renderAgentList();
  updateRoster();
}

// --- Message input -----------------------------------------------------------
messageInput.addEventListener("input", () => {
  const text = messageInput.value.trim();
  sendBtn.disabled = text.length === 0;
  messageInput.style.height = "auto";
  messageInput.style.height = (messageInput.scrollHeight - 2) + "px";
});

messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

sendBtn.addEventListener("click", sendMessage);

// Route a user turn per mode (@mention → addressed agents only; else broadcast) and reset the
// cascade — a human message always breaks any agent↔agent loop. User text goes verbatim (the
// gateway wraps it in its own sender_context); only agent→agent relay is <message from>-wrapped.
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  appendMessage({ senderId: myUserId, senderName: myUserName, text, timestamp: Date.now() });

  loopGuard.onHuman();
  const targets = RoomCore.resolveTargets(roomMembers(), myUserId, { mode: roomConfig.mode, text });
  targets.forEach((id) => {
    const c = connById(id);
    if (c) c.enqueue(text);
  });

  messageInput.value = "";
  messageInput.style.height = "auto";
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
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes} (TPE)`;
}

// Build message rows with createElement + textContent ONLY. NEVER innerHTML with
// senderName/text: they can carry remote-controlled content (agent output, or a handshake
// error echoed from a malicious/MITM server) — an innerHTML sink there is remote-XSS that
// could run arbitrary JS in the extension page and exfiltrate chrome.storage tokens.
function appendMessage({ senderId, senderName, text, timestamp }) {
  const isMe = senderId === myUserId;
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${isMe ? "sent" : "received"}`;

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

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  content.appendChild(bubble);

  const ts = document.createElement("div");
  ts.className = "timestamp";
  ts.textContent = formatTime(timestamp);
  content.appendChild(ts);

  msgDiv.appendChild(content);
  messagesList.appendChild(msgDiv);
  scrollToBottom();
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
  scrollToBottom();
}

function scrollToBottom() {
  messagesList.scrollTop = messagesList.scrollHeight;
}
