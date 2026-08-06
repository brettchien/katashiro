// room-core.js — pure multi-agent room routing/relay logic for katashiro.
//
// NO DOM / WebSocket / global state here — the caller (sidepanel.js) owns connections and
// rendering; this module is the testable brain of the room: attribution wrapping, @mention
// parsing, target routing, and the loop guard. Dual target: loaded as a classic <script> in
// sidepanel.html (exposes globalThis.RoomCore) and require()'d by the node --test suite
// (module.exports). No bundler, no MIME concerns — same shape as browser-mcp.js.
//
// Landed incrementally: this first cut carries the attribution + mention primitives that the
// relay (fan-out) and @mention routing build on; target-resolution and the loop guard land in
// their own steps.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod; // node (test)
  else root.RoomCore = mod; // extension global
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Sanitize a display name for use inside a <message from="..."> attribute: collapse newlines
  // and neutralize quotes so it can't break out of the attribute or inject a tag boundary.
  // (The agent still reads the value verbatim as text; this only keeps the wrapper well-formed.)
  function escapeAttr(name) {
    return String(name == null ? "" : name)
      .replace(/[\r\n]+/g, " ")
      .replace(/"/g, "'")
      .trim();
  }

  // Wrap a speaker's text with attribution, mirroring openab's Discord `<message from="...">`
  // convention so fleet agents (which already run that format) read it naturally. Used by the
  // fan-out relay to tell a receiving agent who spoke.
  function wrapRelay(fromName, text) {
    return `<message from="${escapeAttr(fromName)}">\n${text == null ? "" : text}\n</message>`;
  }

  // Extract @mention tokens from a message. Returns the raw names (without the leading @), in
  // order, with duplicates removed. A mention starts at string start or after whitespace and
  // runs over letters/digits/underscore/hyphen — so "email@host" is NOT a mention but
  // "@Falcon" and "hi @k04 @Kirin" are. Case is preserved; callers match case-insensitively.
  function parseMentions(text) {
    const out = [];
    const seen = new Set();
    const re = /(?:^|\s)@([A-Za-z0-9_-]+)/g;
    let m;
    while ((m = re.exec(String(text == null ? "" : text)))) {
      const name = m[1];
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(name);
      }
    }
    return out;
  }

  // Resolve @mention names to member ids (the name→conn registry lookup). Case-insensitive;
  // an unknown name simply yields no id. members: [{ id, name }], names: raw mention strings.
  function resolveNames(members, names) {
    if (!Array.isArray(members) || !Array.isArray(names)) return [];
    const wanted = new Set(names.map((n) => String(n).toLowerCase()));
    return members
      .filter((m) => m && wanted.has(String(m.name).toLowerCase()))
      .map((m) => m.id);
  }

  // Decide which room member ids should RECEIVE a given message (fan-out relay + routing).
  //   members : [{ id, name }] — the current roster.
  //   originId: the speaker's id. The human's id (or null) never matches a member, so a user
  //             message can reach every agent; an agent's relayed reply never echoes to itself.
  //   opts.mode   : "mention" (default) | "ambient".
  //   opts.text   : message text (mentions parsed from it) — or opts.mentions: pre-parsed names.
  //
  // "mention" mode (matches Brett's "@Falcon → only Falcon"): if the message @-addresses one or
  // more members IN THE ROOM, route ONLY to them (minus origin); if there are no mentions — or an
  // @name that isn't in the room — fall through to broadcast so a bare message isn't lost.
  // "ambient" mode: always broadcast (all except origin); each agent self-decides whether to reply.
  function resolveTargets(members, originId, opts = {}) {
    if (!Array.isArray(members)) return [];
    const others = members.filter((m) => m && m.id !== originId);
    const mode = opts.mode || "mention";
    if (mode === "mention") {
      const names = Array.isArray(opts.mentions) ? opts.mentions : parseMentions(opts.text);
      if (names.length) {
        const wanted = new Set(resolveNames(others, names));
        const targeted = others.filter((m) => wanted.has(m.id));
        if (targeted.length) return targeted.map((m) => m.id); // addressed member(s) only
        // else: @name(s) matched no member in the room → fall through to broadcast.
      }
    }
    return others.map((m) => m.id); // broadcast (no/unknown mention, or ambient mode)
  }

  // --- Room configuration (mode) ---------------------------------------------
  // The room's routing mode. "mention" (default): @-address to target, else broadcast — the
  // loop-safe default. "ambient": everything broadcasts, each agent self-decides whether to
  // chime in. The actual routing lives in resolveTargets(); this is the config layer the
  // settings UI persists.
  const MODES = ["mention", "ambient"];
  const DEFAULT_LOOP_GUARD_CAP = 6;

  // Tunnel-liveness heartbeat defaults (ADR browser-tunnel-liveness §5). Interval = how often to
  // probe the socket; timeout = how long to wait for the gateway's reply before calling it dead.
  const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000; // 60 s
  const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5000; // 5 s
  const MIN_HEARTBEAT_INTERVAL_MS = 5000; // don't let a misconfig hammer the gateway
  const MIN_HEARTBEAT_TIMEOUT_MS = 1000;

  function normalizeMode(mode) {
    return MODES.includes(mode) ? mode : "mention";
  }

  // Loop-guard cap: max consecutive agent→agent relays before the cascade is paused. Coerce to
  // a positive integer; anything junk/non-positive falls back to the default.
  function normalizeCap(cap) {
    const n = Number(cap);
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_LOOP_GUARD_CAP;
  }

  // Clamp a stored millisecond setting to a sane floor, falling back to a default when absent/junk.
  function normalizeMs(value, def, min) {
    const n = Number(value);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
  }

  function defaultRoomConfig() {
    return {
      mode: "mention",
      loopGuardCap: DEFAULT_LOOP_GUARD_CAP,
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
    };
  }

  // Validate/repair a stored room config into a known-good shape (forward-compatible: later
  // fields extend this).
  function normalizeRoomConfig(cfg) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    return {
      mode: normalizeMode(c.mode),
      loopGuardCap: normalizeCap(c.loopGuardCap),
      heartbeatIntervalMs: normalizeMs(c.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS, MIN_HEARTBEAT_INTERVAL_MS),
      heartbeatTimeoutMs: normalizeMs(c.heartbeatTimeoutMs, DEFAULT_HEARTBEAT_TIMEOUT_MS, MIN_HEARTBEAT_TIMEOUT_MS),
    };
  }

  // Heartbeat verdict: does a rejected probe (or turn) reason mean the SOCKET is dead, or just that
  // the peer answered with an error? Any response — including a JSON-RPC error like -32601 — proves
  // the socket is alive; only a client-side timeout or a closed/not-open socket means dead. Callers
  // send a probe the gateway answers immediately (an unknown method → -32601), so a non-timeout
  // rejection is positive liveness, and only these reasons trip a reconnect. (ADR §4.1 D1.)
  function isDeadProbeReason(reason) {
    return /timed out|connection closed|socket not open|\bnot open\b|\bclosed\b/i.test(String(reason == null ? "" : reason));
  }

  // Three-segment connection status for a roster chip (ADR browser-tunnel-liveness §8.2). Pure
  // mapping of a conn's runtime facts to LINK / TUNNEL / BROWSER segments, in dependency order.
  // A downstream segment is `dim: true` (rendered but greyed) when an upstream one is down, so a
  // dead link can never leave a green browser lying (§8.2). Each segment is { cls, dot?, word,
  // title, dim? }; `tunnel` and `browser` are null when the agent has no browser access at all.
  //
  //   facts = { acpReady, alive, lastFailure, enabled, online,  // link (WS/ACP socket)
  //             allowed, attached, tunnelFresh,                 // tunnel (MCP-over-ACP)
  //             actMode }                                       // browser (act mode)
  //
  // `alive === false` (heartbeat degraded) surfaces on the LINK segment as ⚠️ 無回應 — it is a
  // socket property, not a tunnel one. `tunnelFresh` (a recent inbound mcp/message, §8.3) splits
  // an attached tunnel into 活躍 vs 閒置; 閒置 is neutral (silence ≠ death), never an error.
  function roomStatus(facts) {
    const f = facts || {};

    // --- link: the extension↔gateway WS/ACP socket ---
    let link;
    if (f.enabled === false) link = { cls: "offline", dot: "◌", word: "已停用", title: "此 agent 已停用" };
    else if (f.lastFailure === "auth") link = { cls: "error", dot: "○", word: "認證失敗", title: "認證失敗（token 錯誤／被拒）" };
    else if (f.lastFailure === "unreachable") link = { cls: "error", dot: "○", word: "連不到", title: "連不到（伺服器未啟動／網址錯誤）" };
    else if (f.acpReady && f.alive === false) link = { cls: "degraded", dot: "⚠️", word: "無回應", title: "socket 心跳無回應 —— 連線可能已死" };
    else if (f.acpReady) link = { cls: "online", dot: "●", word: "已連線", title: "WS + ACP 連線正常" };
    else if (f.online) link = { cls: "connecting", dot: "◐", word: "握手中", title: "ACP 握手中…" };
    else link = { cls: "connecting", dot: "◐", word: "連線中", title: "連線中…" };

    const linkUp = f.acpReady === true && f.alive !== false; // upstream health gate for dim

    // --- tunnel + browser: only when this agent is allowed browser access ---
    let tunnel = null;
    let browser = null;
    if (f.allowed !== false) {
      if (!f.attached) tunnel = { cls: "detached", dot: "◌", word: "未連結", title: "瀏覽器 tunnel 未連結", dim: !linkUp };
      else if (f.tunnelFresh) tunnel = { cls: "active", dot: "●", word: "活躍", title: "tunnel 活躍（近期有 mcp/message 流量）", dim: !linkUp };
      else tunnel = { cls: "idle", dot: "○", word: "閒置", title: "tunnel 已連結但近期無流量（閒置，非死亡）", dim: !linkUp };

      const browserUp = linkUp && f.attached === true; // browser is usable only over a live tunnel
      browser = f.actMode
        ? { cls: "act", word: "可操作", title: "act mode 開 — agent 可操作瀏覽器", dim: !browserUp }
        : { cls: "read", word: "唯讀", title: "act mode 關 — 唯讀", dim: !browserUp };
    }

    return { link, tunnel, browser };
  }

  // --- Loop guard ------------------------------------------------------------
  // Bounds agent↔agent cascades (esp. ambient mode). Count consecutive AGENT relays; a human
  // message resets it. Once `cap` relays have gone through, further relays are suppressed until
  // a human speaks again. `tripped` is reported true only on the FIRST blocked attempt so the
  // caller surfaces the "paused cross-talk" system line exactly once.
  function createLoopGuard(cap) {
    let limit = normalizeCap(cap);
    let count = 0;
    let tripped = false;
    return {
      // Register an agent-relay attempt. Returns { allowed, tripped, count, cap }.
      onAgentRelay() {
        if (count >= limit) {
          const firstTrip = !tripped;
          tripped = true;
          return { allowed: false, tripped: firstTrip, count, cap: limit };
        }
        count += 1;
        return { allowed: true, tripped: false, count, cap: limit };
      },
      // A human message breaks the cascade — reset.
      onHuman() {
        count = 0;
        tripped = false;
      },
      // Re-cap live (e.g. the user changes the setting).
      setCap(nextCap) {
        limit = normalizeCap(nextCap);
      },
      state() {
        return { count, cap: limit, tripped };
      },
    };
  }

  // Coalesce all queued turns for one agent into a single prompt. When an agent is busy the user
  // (or an agent→agent relay) can pile up several messages; rather than replay them as N separate
  // turns, the next round sends the whole backlog as ONE turn — Discord-style batch delivery. Order
  // is preserved and entries are joined by a blank line so they still read as distinct messages;
  // empty / whitespace-only entries are dropped.
  function batchPrompts(list) {
    if (!Array.isArray(list)) return "";
    return list
      .map((t) => (t == null ? "" : String(t)))
      .filter((t) => t.trim() !== "")
      .join("\n\n");
  }

  return {
    escapeAttr,
    wrapRelay,
    batchPrompts,
    isDeadProbeReason,
    roomStatus,
    parseMentions,
    resolveNames,
    resolveTargets,
    MODES,
    normalizeMode,
    normalizeCap,
    DEFAULT_LOOP_GUARD_CAP,
    defaultRoomConfig,
    normalizeRoomConfig,
    createLoopGuard,
  };
});
