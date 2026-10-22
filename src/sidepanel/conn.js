// Katashiro side panel — connections: SessionState (one conversation's ACP session with one agent:
// its prompt queue, turn state, stream, ⚡ command state, browser MCP server) and Conn (one agent's
// WebSocket: connect / probe / handshake, heartbeat and liveness, ACP requests and message
// handling, opening sessions, the prompt queue and turns — enqueue, cancel, retry, raw ⚡ commands
// — and the reply rendering: stream, tool pills, show_image, ask_user, canvas writes), plus
// settleRunningPills. Moved verbatim out of sidepanel.js (plan B, step 5); no logic change.
//
// Classic script, loaded by sidepanel.html FIRST of the side panel scripts — BEFORE
// conversations.js, composer-ui.js, canvas-glue.js, cards.js and sidepanel.js; all scripts share
// one global scope. Load-order rule: this file holds declarations only — two class declarations
// (methods only: no class fields, static blocks, computed keys or extends, so evaluating them reads
// nothing) and one function declaration. Its top level must not run anything that touches a name
// declared in a later-loaded file (DOM refs, room state, …) — that would be a TDZ ReferenceError at
// load. Method bodies may use names from any file, later-loaded ones included (Conn.cur reads
// conversationId / convs in conversations.js, the rendering methods call appendSystemMessage and
// maybeScroll in sidepanel.js): they only run once every script has loaded. The Conns themselves
// (`new Conn(…)`: buildRoom, reconnectConn, followRemoteAgentsNow, the Settings add-agent button)
// are created in sidepanel.js, inside functions.

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
    this.askAnswers = new Set();                         // promptQueue items that are ask-card answers (dropped at a reset)
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
    // onclose is detached: settle the socket's requests here — but not as "connection closed",
    // which means "reconnect and resend": this conn will not reconnect, so an in-flight turn must
    // end as stopped, now, not requeue (or time out ~10 min later and requeue then) and promise a
    // resend that never comes (#183 follow-up).
    this.rejectAllPending(RoomCore.DISCONNECTED_REASON);
    this.clearStalePrompts();                            // onclose is detached: forget its turns here
    this.online = false;
    this.initialized = false;
    this.socketGen++;
    this.alive = false;
    for (const st of this.states.values()) this.finalizeStream(undefined, st);
    // Nothing flushes on a conn that is off: drop each idle session's queue now, and say so. A
    // session with a turn in flight drops its queue in that turn's "stopped" catch, under the
    // stopped line (its rejection above settles a few microtasks later).
    for (const st of this.states.values()) if (!st.turnActive) this.dropQueued(st);
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
  // card's answer, which has no bubble of its own). `askAnswer`: it is an ask card's answer — a
  // reset drops it while still queued (dropAskAnswers, #191 review d).
  enqueue(text, images, st = this.cur, msgId = null, { askAnswer = false } = {}) {
    if (!st) return;
    if (askAnswer) st.askAnswers.add(text);
    st.promptQueue.push(text);
    if (msgId) st.queuedMsgIds.push(msgId);
    if (images && images.length) st.pendingImages.push(...images);
    // openSession, not flushQueue: a background conversation not yet resumed on this socket (e.g. a
    // relay after a reconnect) is opened first; one that is ready just flushes (review: Jellyfish, #143).
    this.openSession(st);
    refreshCommandCards();                               // the Reset card's queued count (#191 review c)
  }

  // At a reset: the queued answers to the old session's ask cards are not sent to the new session,
  // which never asked them (#191 review d). → how many were dropped. An answer already batched into
  // a turn that was requeued after a socket drop is part of that turn's text and goes with it.
  dropAskAnswers(st) {
    const { kept, dropped } = CommandCore.withoutAskAnswers(st.promptQueue, st.askAnswers);
    st.askAnswers.clear();
    if (!dropped) return 0;
    st.promptQueue.splice(0, st.promptQueue.length, ...kept);
    updateStopButton();                                  // refreshes the ⚡ cards' queued count too
    return dropped;
  }

  // A conn turned off never flushes again, so a session's queue would wait for nothing: messages
  // typed while a turn ran (sent only if this same Conn were turned back on, unlike the stopped turn
  // itself; lost on retarget / removal, which make a new Conn), and a turn requeued after a socket
  // drop that the chat promised to resend. Drop it all and say so, like the stopped turn (#190
  // review a, b). Read tags: queued messages were never marked (a requeued turn's were cleared).
  dropQueued(st) {
    if (!st.promptQueue.length && !st.pendingImages.length) return;
    const promised = st.resendPending;
    st.promptQueue.length = 0;
    st.queuedMsgIds.length = 0;
    st.askAnswers.clear();
    st.pendingImages.length = 0;
    st.resendPending = false;
    this.inState(st, () => appendSystemMessage(RoomCore.queueDroppedText(this.name, promised)));
    updateStopButton();                                  // refreshes the ⚡ cards' queued count too
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
    st.askAnswers.clear();                               // the whole queue went out
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
        // Turned off (disconnect()): its requests reject with DISCONNECTED_REASON; `!this.enabled`
        // also covers a rejection that arrives later on a conn that is still off.
        const stopped = !this.enabled || String(err) === RoomCore.DISCONNECTED_REASON;
        const action = RoomCore.promptFailureAction(RoomCore.isDeadProbeReason(String(err)), socketOpen, stopped);
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
          refreshCommandCards();                         // updateStopButton above ran before the unshift (#191 review c)
          this.finalizeStream(undefined, st);
          this.inState(st, () => appendSystemMessage(partial
            ? `連線中斷：${this.name} 上面的回覆不完整，重新連線後會重送你的訊息，請它重新回答。`
            : `連線中斷：${this.name} 的回覆沒有送到，重新連線後會重送你的訊息，請它重新回答。`));
        } else if (action === "stopped") {
          // The user turned this agent off (or removed / retargeted it) mid-turn: disconnect() sent
          // session/cancel and closed the socket, and nothing reconnects it. Not requeued — a
          // resend would wait for a reconnect that never comes — and no 重試 button: this Conn may
          // be gone for good (retarget makes a new one), and a disabled one ignores retryTurn.
          // A resend that went out is no longer pending: dropQueued must not take back a promise
          // this very turn kept (#195 review k, like the cancel branch).
          if (resent) st.resendPending = false;
          this.finalizeStream(undefined, st);
          this.inState(st, () => appendSystemMessage(st.turnHeard
            ? `已中斷與 ${this.name} 的連線：這個回合停在一半，不會自動重送。需要的話，重新連線後再送一次。`
            : `已中斷與 ${this.name} 的連線：這則沒有收到回覆，不會自動重送。需要的話，重新連線後再送一次。`));
          this.dropQueued(st);                           // what the user typed meanwhile is not sent either
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
        // Q9: a background turn that ended badly is said too (a requeued one has not ended; a stopped
        // one is the user's own doing, like ⏹).
        if (action !== "requeue" && action !== "stopped" && st.convId !== conversationId && this.states.get(st.convId) === st) notifyTurnDone(st.convId, this.name, true);
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
    refreshCommandCards();                               // the Reset card's queued count (#198 review n)
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
        if (String(err) === RoomCore.DISCONNECTED_REASON) return;   // turned off meanwhile: no verdict
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
