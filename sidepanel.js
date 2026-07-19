// State variables
let ws = null;
let reconnectInterval = 5000;
let reconnectTimer = null;
let myUserId = "me";
let myUserName = "You";

// Agents: [{ name, url, token }]; one is active at a time. `token` is the ACP
// transport key (OPENAB_ACP_AUTH_KEY): required for a non-loopback endpoint, optional
// on localhost. It is appended as `?token=` at connect time, not stored in the URL.
const DEFAULT_AGENT = { name: "OpenAB", url: "ws://localhost:8080/acp", token: "" };
let agents = [];
let activeIndex = 0;
let acpSessionByUrl = {};       // url -> last ACP sessionId (per-agent resume)
function activeAgent() { return agents[activeIndex] || DEFAULT_AGENT; }

// Carry the transport token via the WebSocket subprotocol list (browsers cannot set an
// Authorization header on a WS handshake). The server extracts the token from the
// `openab.bearer.<token>` entry and echoes the real `acp.v1` subprotocol. This keeps the
// token OUT of the URL — the de facto browser-WS bearer pattern.
function acpProtocols(token) {
  // Trim defensively: a pasted token often carries a trailing newline/space, which
  // makes the subprotocol string invalid and silently breaks the WebSocket handshake.
  const t = (token || "").trim();
  return t ? [`openab.bearer.${t}`, "acp.v1"] : ["acp.v1"];
}

// ACP (Agent Client Protocol) state (for the active connection)
const ACP_PROTOCOL_VERSION = 1;
const ACP_CWD = "/home/agent";
let acpSessionId = null;       // active agent's persisted ACP sessionId (resume)
let acpReady = false;          // true once initialize + session are established
let nextReqId = 1;             // JSON-RPC 2.0 request id counter
const pendingReqs = new Map(); // id -> { resolve, reject }
let browserMcpId = null;       // T6: our `type:acp` MCP server id, declared in session/new
let mcpConnectionId = null;    // T6: the connectionId established by the gateway's mcp/connect
let streamBubble = null;       // DOM .bubble element the agent turn is streaming into
let streamText = "";           // accumulated agent turn text

// DOM Elements
const messagesList = document.getElementById("messages-list");
const messageInput = document.getElementById("message-input");
const sendBtn = document.getElementById("send-btn");
const statusIndicator = document.querySelector(".status-indicator");
const settingsBtn = document.getElementById("settings-btn");
const connectBtn = document.getElementById("connect-btn");
const wsUrlInput = document.getElementById("ws-url-input");
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

// Load stored agents on init (with migration from the old single-url config)
chrome.storage.local.get(
  ["agents", "activeIndex", "acpSessionByUrl", "wsUrl", "acpSessionId"],
  (r) => {
    if (Array.isArray(r.agents) && r.agents.length) {
      agents = r.agents;
      activeIndex = Math.min(r.activeIndex || 0, agents.length - 1);
    } else if (r.wsUrl) {
      agents = [{ name: "OpenAB", url: r.wsUrl }];
    } else {
      agents = [{ ...DEFAULT_AGENT }];
    }
    acpSessionByUrl = r.acpSessionByUrl || {};
    if (r.acpSessionId && r.wsUrl && !(r.wsUrl in acpSessionByUrl)) {
      acpSessionByUrl[r.wsUrl] = r.acpSessionId; // migrate legacy session
    }
    persistAgents();
    updateActiveAgentUI();

    switchView("chat");
    connectActive();
  }
);

function persistAgents() {
  chrome.storage.local.set({ agents, activeIndex, acpSessionByUrl });
}

function updateActiveAgentUI() {
  if (activeAgentLabel) activeAgentLabel.textContent = activeAgent().name;
}

// Connect to the currently active agent
function connectActive() {
  const a = activeAgent();
  acpSessionId = acpSessionByUrl[a.url] || null; // resume this agent's own session
  promptQueue = []; // switching agents starts a fresh queue
  turnActive = false;
  updateActiveAgentUI();
  connectWebSocket(a.url, a.token);
}

// View switcher
function switchView(viewName) {
  setupView.classList.remove("active");
  chatView.classList.remove("active");
  settingsView.classList.remove("active");

  if (viewName === "setup") {
    setupView.classList.add("active");
  } else if (viewName === "chat") {
    chatView.classList.add("active");
  } else if (viewName === "settings") {
    settingsView.classList.add("active");
  }
}

// UI Event Listeners
settingsBtn.addEventListener("click", () => {
  renderAgentList();
  switchView("settings");
});

cancelSettingsBtn.addEventListener("click", () => switchView("chat"));

addAgentBtn.addEventListener("click", () => {
  const name = newAgentName.value.trim();
  const url = newAgentUrl.value.trim();
  const token = (newAgentToken?.value || "").trim();
  if (!name || !url) return;
  agents.push({ name, url, token });
  persistAgents();
  newAgentName.value = "";
  newAgentUrl.value = "";
  if (newAgentToken) newAgentToken.value = "";
  renderAgentList();
});

if (connectBtn) {
  connectBtn.addEventListener("click", () => {
    const url = wsUrlInput.value.trim();
    if (!url) return;
    agents = [{ name: "OpenAB", url }];
    activeIndex = 0;
    persistAgents();
    switchView("chat");
    connectActive();
  });
}

// Render the agent list in the settings view
function renderAgentList() {
  if (!agentListEl) return;
  agentListEl.innerHTML = "";
  agents.forEach((a, i) => {
    const row = document.createElement("div");
    row.className = "agent-row" + (i === activeIndex ? " active" : "");

    const meta = document.createElement("div");
    meta.className = "agent-meta";
    // Editable name + url — rename/retarget any agent (incl. the first) in place.
    const nm = document.createElement("input");
    nm.className = "agent-name-input";
    nm.value = a.name;
    nm.addEventListener("change", () => {
      a.name = nm.value.trim() || a.name;
      nm.value = a.name;
      persistAgents();
      if (i === activeIndex) updateActiveAgentUI();
    });
    const url = document.createElement("input");
    url.className = "agent-url-input";
    url.value = a.url;
    url.addEventListener("change", () => {
      a.url = url.value.trim() || a.url;
      url.value = a.url;
      persistAgents();
    });
    // Transport token (OPENAB_ACP_AUTH_KEY) — masked; appended as ?token= at connect.
    const tok = document.createElement("input");
    tok.className = "agent-token-input";
    tok.type = "password";
    tok.placeholder = "Token（伺服器需驗證時填）";
    tok.value = a.token || "";
    tok.addEventListener("change", () => {
      a.token = tok.value.trim();
      persistAgents();
    });
    meta.appendChild(nm);
    meta.appendChild(url);
    meta.appendChild(tok);

    const actions = document.createElement("div");
    actions.className = "agent-actions";
    const sel = document.createElement("button");
    sel.className = "agent-select";
    sel.textContent = i === activeIndex ? "使用中" : "連線";
    sel.disabled = i === activeIndex;
    sel.addEventListener("click", () => selectAgent(i));
    const del = document.createElement("button");
    del.className = "agent-delete";
    del.title = "刪除";
    del.textContent = "✕";
    del.addEventListener("click", () => deleteAgent(i));
    actions.appendChild(sel);
    actions.appendChild(del);

    row.appendChild(meta);
    row.appendChild(actions);
    agentListEl.appendChild(row);
  });
}

function selectAgent(i) {
  if (i < 0 || i >= agents.length) return;
  activeIndex = i;
  persistAgents();
  switchView("chat");
  connectActive();
}

function deleteAgent(i) {
  agents.splice(i, 1);
  if (agents.length === 0) agents = [{ ...DEFAULT_AGENT }];
  if (activeIndex >= agents.length) activeIndex = agents.length - 1;
  persistAgents();
  updateActiveAgentUI();
  renderAgentList();
}

// Message Input handling
messageInput.addEventListener("input", () => {
  const text = messageInput.value.trim();
  sendBtn.disabled = text.length === 0;
  
  // Auto-grow height
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

// Queue of pending user turns, sent one at a time (avoids -32001 "Session busy"
// and survives reconnects — queued turns flush once the session is ready again).
let promptQueue = [];
let turnActive = false;

// Enqueue a user turn; the queue drives the actual session/prompt sends.
function sendMessage() {
  const text = messageInput.value.trim();
  if (!text) return;

  appendMessage({
    senderId: myUserId,
    senderName: myUserName,
    text: text,
    timestamp: Date.now()
  });

  promptQueue.push(text);
  messageInput.value = "";
  messageInput.style.height = "auto";
  sendBtn.disabled = true;
  flushQueue();
}

// Send the next queued turn if the session is idle and ready.
function flushQueue() {
  if (turnActive || promptQueue.length === 0) return;
  if (!(ws && ws.readyState === WebSocket.OPEN && acpReady && acpSessionId)) return;

  const text = promptQueue.shift();
  turnActive = true;
  startStream(); // open an empty agent bubble to stream the reply into

  acpRequest("session/prompt", {
    sessionId: acpSessionId,
    prompt: [{ type: "text", text }]
  })
    .then((res) => {
      turnActive = false;
      finalizeStream(res && res.stopReason);
      flushQueue();
    })
    .catch((err) => {
      turnActive = false;
      if (/closed|not open/i.test(String(err))) {
        // Connection dropped mid-turn — retry this turn after resume.
        promptQueue.unshift(text);
        finalizeStream(); // drop the empty bubble; resume will re-run it
      } else {
        appendToStream("\n[錯誤] " + err);
        finalizeStream("error");
      }
      flushQueue();
    });
}

// Connect to the ACP WebSocket endpoint and run the handshake
function connectWebSocket(url, token) {
  if (ws) {
    ws.onclose = null; // prevent the stale socket's handler from triggering a reconnect
    ws.close();
  }

  clearTimeout(reconnectTimer);
  updateStatus(false);
  acpReady = false;

  try {
    ws = new WebSocket(url, acpProtocols(token));

    ws.onopen = () => {
      console.log("WebSocket connected to " + url);
      updateStatus(true);
      acpHandshake();
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.error("ACP: non-JSON frame:", err);
        return;
      }
      handleAcpMessage(msg);
    };

    ws.onclose = () => {
      console.log("WebSocket disconnected");
      updateStatus(false);
      acpReady = false;
      // Stale tunnel: a fresh handshake re-declares our type:acp server and the gateway
      // re-opens the tunnel (new mcp/connect). Drop the old connectionId.
      mcpConnectionId = null;
      rejectAllPending("connection closed");
      // Auto reconnect — the next handshake resumes acpSessionId if we have one.
      reconnectTimer = setTimeout(() => {
        console.log("Attempting to reconnect...");
        connectWebSocket(url, token);
      }, reconnectInterval);
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      updateStatus(false);
    };

  } catch (e) {
    console.error("Error creating WebSocket:", e);
    updateStatus(false);
  }
}

// --- ACP protocol layer -----------------------------------------------------

// Send a JSON-RPC request and resolve when its response arrives.
function acpRequest(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject("socket not open");
      return;
    }
    const id = nextReqId++;
    pendingReqs.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
}

function rejectAllPending(reason) {
  for (const { reject } of pendingReqs.values()) reject(reason);
  pendingReqs.clear();
}

// --- MCP-over-ACP tunnel: katashiro is the browser MCP server (T6) ---------------
// See docs/mcp-over-acp-tunnel-contract.md in the openab repo. We declare a `type:acp`
// MCP server in session/new; the gateway then opens a tunnel to us (server-initiated
// mcp/connect) and drives MCP over mcp/message. We execute browser tools in the active tab.

// Declared in session/new / session/resume so the gateway opens a tunnel to us.
function browserMcpServers() {
  if (!browserMcpId) browserMcpId = crypto.randomUUID();
  return [{ type: "acp", id: browserMcpId, name: "browser" }];
}

// Reply to a server-initiated request (JSON-RPC 2.0).
function sendResult(id, result) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
}
function sendError(id, code, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  }
}

// The browser tools we serve (advertised via tools/list; DOM-semantic, model-agnostic).
const BROWSER_TOOLS = [
  {
    name: "browser.click",
    description: "Click the element matching a CSS selector in the active browser tab.",
    inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector" } }, required: ["selector"] }
  },
  {
    name: "browser.read_dom",
    description: "Read a snapshot of the active tab's DOM (optionally scoped to a selector).",
    inputSchema: { type: "object", properties: { selector: { type: "string", description: "optional CSS selector to scope the snapshot" } } }
  },
  {
    name: "browser.navigate",
    description: "Navigate the active browser tab to a URL.",
    inputSchema: { type: "object", properties: { url: { type: "string", description: "absolute URL" } }, required: ["url"] }
  },
  {
    name: "browser.type",
    description: "Type text into the element matching a CSS selector in the active tab.",
    inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"] }
  },
  {
    name: "browser.screenshot",
    description: "Capture a screenshot of the active browser tab.",
    inputSchema: { type: "object", properties: {} }
  }
];

// Handle a server-initiated request from the gateway (tunnel control + MCP-over-ACP).
async function handleServerRequest(msg) {
  switch (msg.method) {
    case "mcp/connect": {
      // The gateway opens the tunnel to our declared server; we name the connection.
      mcpConnectionId = crypto.randomUUID();
      sendResult(msg.id, { connectionId: mcpConnectionId });
      return;
    }
    case "mcp/message": {
      // Inner MCP is flattened into params (method/params); the outer ACP id correlates.
      const inner = msg.params || {};
      try {
        const result = await handleMcpMessage(inner.method, inner.params || {});
        if (result !== undefined) sendResult(msg.id, result);
      } catch (e) {
        sendError(msg.id, e.code || -32603, e.message || String(e));
      }
      return;
    }
    case "mcp/disconnect": {
      mcpConnectionId = null;
      sendResult(msg.id, {});
      return;
    }
    default:
      sendError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

// The MCP server surface we expose over the tunnel (we are the MCP server, the agent is the
// client). Returns the inner MCP result; `undefined` for notifications (no reply).
async function handleMcpMessage(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "katashiro-browser", version: "1.0.0" }
      };
    case "notifications/initialized":
      return undefined; // notification — no response
    case "tools/list":
      return { tools: BROWSER_TOOLS };
    case "tools/call":
      // Tool-execution failures (no active tab, restricted page like chrome://, missing host
      // permission, injected-script error) become MCP isError results — not protocol errors —
      // so the agent sees the failure and can adapt.
      try {
        return await callBrowserTool(params.name, params.arguments || {});
      } catch (e) {
        return { content: [{ type: "text", text: `tool error: ${(e && e.message) || e}` }], isError: true };
      }
    default: {
      const err = new Error(`method not found: ${method}`);
      err.code = -32601;
      throw err;
    }
  }
}

// The currently active tab (the shikigami acts here).
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no active browser tab");
  return tab;
}

const okText = (t) => ({ content: [{ type: "text", text: t }] });
const errText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

// Execute a browser tool in the active tab via chrome.scripting/tabs. Returns an MCP
// CallToolResult ({ content, isError? }). DOM actions run injected in the page context.
async function callBrowserTool(name, args) {
  const tab = await activeTab();
  switch (name) {
    case "browser.click": {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel) => {
          const el = document.querySelector(sel);
          if (!el) return { ok: false, error: "no element for selector: " + sel };
          el.click();
          return { ok: true };
        },
        args: [args.selector]
      });
      return result.ok ? okText(`clicked ${args.selector}`) : errText(result.error);
    }
    case "browser.read_dom": {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel) => {
          const el = sel ? document.querySelector(sel) : document.body;
          if (!el) return { ok: false, error: "no element for selector: " + sel };
          return { ok: true, html: el.outerHTML.slice(0, 100000) };
        },
        args: [args.selector || null]
      });
      return result.ok ? okText(result.html) : errText(result.error);
    }
    case "browser.navigate": {
      await chrome.tabs.update(tab.id, { url: args.url });
      return okText(`navigating to ${args.url}`);
    }
    case "browser.type": {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sel, text) => {
          const el = document.querySelector(sel);
          if (!el) return { ok: false, error: "no element for selector: " + sel };
          el.focus();
          if ("value" in el) el.value = text;
          else el.textContent = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        },
        args: [args.selector, args.text]
      });
      return result.ok ? okText(`typed into ${args.selector}`) : errText(result.error);
    }
    case "browser.screenshot": {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
      return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
    }
    default: {
      const err = new Error(`unknown tool: ${name}`);
      err.code = -32602;
      throw err;
    }
  }
}

// initialize → (resume existing | new) session
function acpHandshake() {
  acpRequest("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {}
  })
    .then(() => {
      if (acpSessionId) {
        return acpRequest("session/resume", {
          sessionId: acpSessionId,
          cwd: ACP_CWD,
          mcpServers: browserMcpServers()
        }).then(() => {
          acpReady = true;
          appendSystemMessage(`已續接 ${activeAgent().name} 的 ACP session。`);
          flushQueue();
        });
      }
      return acpRequest("session/new", { cwd: ACP_CWD, mcpServers: browserMcpServers() })
        .then((res) => {
          acpSessionId = res && res.sessionId;
          acpSessionByUrl[activeAgent().url] = acpSessionId; // per-agent resume
          persistAgents();
          acpReady = true;
          appendSystemMessage(`已連線至 ${activeAgent().name} (ACP)。`);
          flushQueue();
        });
    })
    .catch((err) => {
      // A resume can fail if the session id is unknown → fall back to a fresh one.
      if (acpSessionId) {
        acpSessionId = null;
        delete acpSessionByUrl[activeAgent().url];
        persistAgents();
        if (ws && ws.readyState === WebSocket.OPEN) acpHandshake();
      } else {
        appendSystemMessage("ACP 握手失敗：" + err);
      }
    });
}

// Route an incoming JSON-RPC message: response to a request, or a notification.
function handleAcpMessage(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pendingReqs.get(msg.id);
    if (p) {
      pendingReqs.delete(msg.id);
      if (msg.error) p.reject(msg.error.message || JSON.stringify(msg.error));
      else p.resolve(msg.result);
    }
    return;
  }

  // Server-initiated request (has BOTH id and method): the gateway driving our browser MCP
  // server over the tunnel (mcp/connect, mcp/message, mcp/disconnect). Route + respond.
  if (msg.id !== undefined && msg.method) {
    handleServerRequest(msg);
    return;
  }

  if (msg.method === "session/update" && msg.params && msg.params.update) {
    const u = msg.params.update;
    if (u.sessionUpdate === "agent_message_chunk" && u.content) {
      appendToStream(u.content.text || "");
    }
  }
}

// --- Streaming agent bubble --------------------------------------------------

function startStream() {
  streamText = "";
  const name = activeAgent().name || "Agent";
  const msgDiv = document.createElement("div");
  msgDiv.className = "message received";
  const time = formatTime(Date.now());
  msgDiv.innerHTML = `
    <div class="avatar"></div>
    <div class="message-content">
      <div class="sender-name"></div>
      <div class="bubble"></div>
      <div class="timestamp">${time}</div>
    </div>
  `;
  // set name/avatar via textContent (agent name comes from user config)
  msgDiv.querySelector(".avatar").textContent = name.charAt(0).toUpperCase();
  msgDiv.querySelector(".sender-name").textContent = name;
  messagesList.appendChild(msgDiv);
  streamBubble = msgDiv.querySelector(".bubble");
  // Show a "thinking" indicator while Falcon ponders, until the first chunk arrives.
  streamBubble.classList.add("typing");
  streamBubble.innerHTML =
    '<span class="typing-dots"><span></span><span></span><span></span></span>';
  scrollToBottom();
}

function appendToStream(chunk) {
  if (!streamBubble) startStream();
  if (streamText === "") streamBubble.classList.remove("typing"); // first chunk: drop the dots
  streamText += chunk;
  streamBubble.textContent = streamText; // textContent: no HTML injection from agent output
  scrollToBottom();
}

function finalizeStream(_stopReason) {
  // Drop a bubble the turn never wrote into (e.g. a mid-turn disconnect).
  if (streamBubble && streamText === "") {
    const row = streamBubble.closest(".message");
    if (row) row.remove();
  }
  streamBubble = null;
  streamText = "";
}

// Helpers
function updateStatus(isOnline) {
  if (isOnline) {
    statusIndicator.className = "status-indicator online";
  } else {
    statusIndicator.className = "status-indicator offline";
  }
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes} (TPE)`;
}

function appendMessage({ senderId, senderName, text, timestamp }) {
  const isMe = senderId === myUserId;
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${isMe ? "sent" : "received"}`;

  let avatarHTML = "";
  let senderNameHTML = "";

  if (!isMe) {
    avatarHTML = `<div class="avatar">${senderName ? senderName[0] : "?"}</div>`;
    senderNameHTML = `<div class="sender-name">${senderName}</div>`;
  }

  msgDiv.innerHTML = `
    ${avatarHTML}
    <div class="message-content">
      ${senderNameHTML}
      <div class="bubble">${text}</div>
      <div class="timestamp">${formatTime(timestamp)}</div>
    </div>
  `;

  messagesList.appendChild(msgDiv);
  scrollToBottom();
}

function appendSystemMessage(text) {
  const msgDiv = document.createElement("div");
  msgDiv.className = "message system";
  msgDiv.innerHTML = `<div class="system-text">${text}</div>`;
  messagesList.appendChild(msgDiv);
  scrollToBottom();
}

function scrollToBottom() {
  messagesList.scrollTop = messagesList.scrollHeight;
}
