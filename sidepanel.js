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
    this.lastPrompt = null;                              // last turn's text, for retry
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
            saveHistory();                 // persist the (confirmed) resumable session id
            appendSystemMessage(`已續接 ${this.name} 的 ACP session。`);
            this.flushQueue();
          });
        }
        return this.acpRequest("session/new", {
          cwd: ACP_CWD,
          mcpServers: this.browserMcpServers(),
        }).then((res) => {
          this.acpSessionId = res && res.sessionId; // seeded per-window; persisted below
          this.acpReady = true;
          updateRoster();
          saveHistory();                 // persist the new session id for this window
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
    this.lastPrompt = text;                              // remember for retry
    this.turnActive = true;
    updateStopButton();
    this.startStream();

    this.acpRequest("session/prompt", {
      sessionId: this.acpSessionId,
      prompt: [{ type: "text", text }],
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
        if (/closed|not open/i.test(String(err))) {
          this.promptQueue.unshift(text);                // transient: retry after resume
          this.finalizeStream();
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

  // Re-send the last turn (after an error / stop). No-op if a turn is already in flight.
  retryLast() {
    if (this.lastPrompt && !this.turnActive) this.enqueue(this.lastPrompt);
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

  finalizeStream(_stopReason) {
    const s = this.stream;
    this.stream = null; // reset first: a render throw must not orphan stream state onto the next turn
    if (!s || !s.bubble) return;
    if (s.text === "") {
      // Drop a bubble the turn never wrote into (e.g. a mid-turn disconnect).
      const row = s.bubble.closest(".message");
      if (row) row.remove();
      return;
    }
    // Render the accumulated markdown once, now that the turn is complete (ADR §3.3): streaming
    // stayed plain textContent; markdown is parsed+sanitized only here. A stream that stops/errors
    // still reaches finalize, so the message renders (not left as raw md).
    renderMarkdownInto(s.bubble, s.text);
    recordMessage({ kind: "received", senderId: this.id, senderName: this.name, text: s.text, timestamp: Date.now() });
    maybeScroll();
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
    room.push(c);
  });
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
const stopBtn = document.getElementById("stop-btn");
const jumpLatestBtn = document.getElementById("jump-latest");
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
chrome.storage.local.get(["agents", "wsUrl", "roomConfig", "actMode"], async (r) => {
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
    await loadHistory();   // seed saved session ids + replay scrollback BEFORE building/connecting
    buildRoom();
    connectAll();
    updateRoster();
  }
);

function persist() {
  chrome.storage.local.set({ agents, roomConfig, actMode });
}

// --- Chat history (per-window, chrome.storage.session) ------------------------
// The side panel is a plain extension page: closing it tears down the DOM, losing the scrollback.
// Persist the messages AND each agent's resumable ACP session id to chrome.storage.session, keyed
// by window, so reopening the panel restores the same conversation and resumes the same session
// (the "已續接 …" path). Keyed by window so two windows keep separate history + sessions — the
// per-window isolation, but now restorable (the old shared-by-url seed was the thing that mixed
// tunnels; a per-window key does not). storage.session clears on browser close, so conversations
// are never written to disk.
const HISTORY_CAP = 200;
let historyKey = null;                    // "history:<windowId>"
let savedSessions = {};                   // { <agentUrl>: acpSessionId } seeded at startup
const historyMessages = [];               // in-memory mirror of the persisted scrollback
let restoring = false;                    // true while replaying — suppresses re-recording

function currentWindowId() {
  return new Promise((resolve) => {
    try { chrome.windows.getCurrent((w) => resolve(w && w.id != null ? w.id : "default")); }
    catch { resolve("default"); }
  });
}

function saveHistory() {
  if (!historyKey) return;
  const sessions = {};
  room.forEach((c) => { if (c.acpSessionId) sessions[c.agent.url] = c.acpSessionId; });
  chrome.storage.session.set({ [historyKey]: { sessions, messages: historyMessages } });
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
  else appendMessage({ senderId: rec.senderId, senderName: rec.senderName, text: rec.text, timestamp: rec.timestamp });
}

// Load per-window history + saved session ids and replay the scrollback. Runs BEFORE the room is
// built so each conn seeds its acpSessionId (→ session/resume restores the same conversation) and
// the restored messages sit above the reconnect notices.
async function loadHistory() {
  const wid = await currentWindowId();
  historyKey = `history:${wid}`;
  const got = await chrome.storage.session.get(historyKey);
  const data = (got && got[historyKey]) || {};
  savedSessions = data.sessions || {};
  const msgs = Array.isArray(data.messages) ? data.messages : [];
  if (msgs.length) {
    restoring = true;
    msgs.forEach(replayMessage);
    historyMessages.push(...msgs);
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
    // 🔗 linked / ⛓️‍💥 broken — the exact reason (auth failed / unreachable / connecting) is in the title.
    dot.textContent = st.cls === "online" ? "🔗" : "⛓️‍💥";
    dot.title = st.label;
    chip.appendChild(dot);

    const nm = document.createElement("span");
    nm.className = "roster-name";
    nm.textContent = c.name;                             // textContent: agent name is user config
    chip.appendChild(nm);

    // Browser tunnel: three states, shown only when this agent is allowed browser access. Separate
    // from the config toggle (which only says "allowed"): this reflects the RUNTIME tunnel.
    if (c.agent.browserAccess !== false) {
      const br = document.createElement("span");
      if (c.browserAttached && actMode) {
        br.className = "roster-browser attached";
        br.textContent = "🐵";                   // live + operational (act mode on — can act on the tab)
        br.title = "瀏覽器已連結 + 可操作（act mode 開）";
      } else if (c.browserAttached) {
        br.className = "roster-browser attached";
        br.textContent = "🙊";                   // live but read-only (act mode off)
        br.title = "瀏覽器已連結，唯讀（act mode 關 — Settings → 瀏覽器寫入 可開啟操作）";
      } else {
        br.className = "roster-browser detached";
        br.textContent = "🙈";                   // see-no-evil — tunnel not attached
        br.title = "瀏覽器 tunnel 未連結（agent 尚未接上或無 live 分頁）";
      }
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
  updateRoster(); // browser status monkeys reflect act mode (🐵 operational / 🙊 read-only)
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

// Stop every in-flight turn (each conn sends its own session/cancel).
if (stopBtn) stopBtn.addEventListener("click", () => room.forEach((c) => c.cancelTurn()));

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

// Build message rows with createElement + textContent for everything EXCEPT the message body,
// which is markdown → sanitized HTML via the single `renderMarkdown` sink (ADR §3.2). senderName
// stays textContent (never trusted to innerHTML). `text` is remote-controlled (agent output, or a
// handshake error echoed from a malicious/MITM server), so it may reach innerHTML ONLY through
// renderMarkdown — DOMPurify is the XSS guard that textContent used to be.
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
  renderMarkdownInto(bubble, text);          // sanitized sink (ADR §3.2) — never raw innerHTML
  content.appendChild(bubble);

  const ts = document.createElement("div");
  ts.className = "timestamp";
  ts.textContent = formatTime(timestamp);
  content.appendChild(ts);

  msgDiv.appendChild(content);
  messagesList.appendChild(msgDiv);
  recordMessage({ kind: isMe ? "sent" : "received", senderId, senderName, text, timestamp });
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

// Stick-to-bottom: only auto-follow new content when the user is already near the bottom.
// If they've scrolled up to read history, incoming chunks must NOT yank the viewport down;
// instead surface a "jump to latest" affordance they can tap.
const NEAR_BOTTOM_PX = 80;
function isNearBottom() {
  return messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < NEAR_BOTTOM_PX;
}
function maybeScroll() {
  if (isNearBottom()) scrollToBottom();
  else if (jumpLatestBtn) jumpLatestBtn.hidden = false;
}
if (jumpLatestBtn) {
  jumpLatestBtn.addEventListener("click", () => { scrollToBottom(); jumpLatestBtn.hidden = true; });
  // Hide the affordance again once the user scrolls back to the bottom on their own.
  messagesList.addEventListener("scroll", () => { if (isNearBottom()) jumpLatestBtn.hidden = true; });
}
