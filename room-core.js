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
  const DEFAULT_LOOP_GUARD_CAP = 10;

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

  // Decide what to do when a turn's `session/prompt` rejects, extracted pure so the
  // reconnect-duplication fix is unit-testable and the policy is auditable in one place:
  //   - dead reason + CLOSED socket  → "requeue": the socket died, so the prompt almost certainly
  //       never landed; re-queue it for the reconnect to flush on a fresh session (ADR R3).
  //   - dead reason + OPEN socket    → "cancel": a timeout on a live connection — the turn is very
  //       likely still running server-side, so re-sending would DUPLICATE it. Cancel + let the user
  //       retry; never auto-re-send into a live session.
  //   - anything else                → "error": a genuine failure to surface with a retry button.
  // --- Config storage policy (Google-synced config) ---------------------------
  // Does a loaded config carry real, user-set data — as opposed to nothing, which means the caller
  // falls back to defaults? Same shape test the loader uses (agents list, or the legacy wsUrl).
  function hasStoredConfig(cfg) {
    return !!cfg && ((Array.isArray(cfg.agents) && cfg.agents.length > 0) || !!cfg.wsUrl);
  }

  // Startup write-back: only write back a config that actually came from storage. On a first load
  // (e.g. a new device) chrome.storage.sync can still be empty because the Google copy hasn't
  // downloaded yet — writing the defaults then would overwrite that copy (sync is last-write-wins).
  // (Removing the extension is a different case: Chrome deletes its synced keys server-side on
  // uninstall, so there is nothing to recover — see the config-storage note in sidepanel.js.)
  function shouldPersistOnStartup(loaded) {
    return hasStoredConfig(loaded);
  }

  // A synced config that arrives AFTER startup: adopt it only while we are still running on
  // defaults and the user hasn't changed anything locally since — a local edit always wins.
  function shouldAdoptRemoteConfig(state) {
    const s = state || {};
    return !!s.runningOnDefaults && !s.userEdited && hasStoredConfig(s.remote);
  }

  // Config-sync badge state — what the extension can actually OBSERVE. chrome.storage.sync exposes
  // no "uploaded to Google" signal, so this reports the local sync-area write, never cloud delivery:
  //   "local"   — the last write to storage.sync failed (e.g. quota) and fell back to storage.local
  //   "waiting" — no stored config yet: running on defaults, waiting for the synced copy to arrive
  //   "empty"   — still on defaults after the wait window: nothing synced exists for this extension
  //               (first use, or the extension was removed — Chrome deletes synced keys on uninstall)
  //   "synced"  — config lives in storage.sync
  function configSyncState(state) {
    const s = state || {};
    if (s.writeFailed) return "local";
    if (s.runningOnDefaults) return s.waitExpired ? "empty" : "waiting";
    return "synced";
  }

  function promptFailureAction(deadProbe, socketOpen) {
    if (deadProbe && !socketOpen) return "requeue";
    if (deadProbe) return "cancel";
    return "error";
  }

  // Turn timeout: a turn ends on silence, not on length. It times out `idleMs` after
  // the last sign of life (start, or the latest activity: a session/update for its session, or the
  // agent driving our MCP tunnel) — or at `maxMs` after the start, whichever comes first. A long
  // tool-heavy turn keeps streaming tool events and so keeps going; `maxMs` sits above the core's
  // own prompt hard timeout (30 min) so the client is never the first to give up on a live turn.
  // Note: one long tool call (a build, a sleep) is silent end to end, so `idleMs` must outlast it.
  const TURN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
  const TURN_MAX_TIMEOUT_MS = 35 * 60 * 1000;
  // → { at, reason }: when the turn times out and why ("idle" | "max"), given what we know now.
  function turnDeadline(f) {
    const o = f || {};
    const idleAt = Math.max(o.startedAt || 0, o.lastActivityAt || 0) + o.idleMs;
    const maxAt = (o.startedAt || 0) + o.maxMs;
    return idleAt < maxAt ? { at: idleAt, reason: "idle" } : { at: maxAt, reason: "max" };
  }

  // Heartbeat state-machine decisions (ADR §8.6), extracted pure so the #17 regression point is
  // unit-testable — the logic lives here; sidepanel.js only wires it to the socket + timer.

  // Probe ONLY genuine silence: never while a turn is active (self-evidently alive), and never within
  // `intervalMs` of the last inbound frame (recent traffic already proved the socket live).
  function shouldProbe(f) {
    const o = f || {};
    if (o.turnActive) return false;
    return (o.now - (o.lastRecvAt || 0)) >= o.intervalMs;
  }

  // Decide what a timed-out idle probe does. Always DEGRADE the badge (safe, non-destructive); a
  // destructive reconnect needs `threshold` consecutive misses AND no active turn (a live turn's
  // hang is R3's job, not the heartbeat's). Returns the next `missedProbes` and whether to reconnect.
  // Mid-turn leaves the counter untouched, so a turn can never be reconnected out from under itself.
  function onProbeTimeoutDecision(f) {
    const o = f || {};
    if (o.turnActive) return { degrade: true, reconnect: false, missedProbes: o.missedProbes || 0 };
    const mp = (o.missedProbes || 0) + 1;
    if (mp >= o.threshold) return { degrade: true, reconnect: true, missedProbes: 0 };
    return { degrade: true, reconnect: false, missedProbes: mp };
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

  // Which agent is the single active one (ADR single-active-agent). The stored `activeAgentUrl` wins
  // if it still names a configured agent; otherwise fall back to the FIRST agent — so an existing sole
  // config migrates to active with no user action, and a deleted active falls through to a valid one.
  // Returns null when there are no agents.
  function resolveActiveUrl(agents, stored) {
    const list = Array.isArray(agents) ? agents : [];
    if (stored && list.some((a) => a && a.url === stored)) return stored;
    return list.length ? list[0].url : null;
  }

  // ACP initialize `clientInfo` (ACP Implementation: name, title, version). The build — release tag
  // or sha from build-info.json, "dev" for an unstamped unpacked load — rides as semver build
  // metadata, so the agent side can tell which Katashiro build it is talking to
  // (ADR build-provenance-and-version-display). Anything outside [0-9A-Za-z.-] is dropped from it.
  function acpClientInfo(version, build) {
    const v = String(version || "0.0.0");
    const b = String(build || "").replace(/[^0-9A-Za-z.-]/g, "").slice(0, 40) || "dev";
    return { name: "katashiro", title: "Katashiro", version: `${v}+${b}` };
  }

  // --- reply-to / message headers ------------------------------------------------------------
  // Messages are referred to by time, not a #N counter — "#12" reads like a PR/issue number to an
  // agent. Agent-facing stamps are ISO 8601 / RFC 3339 in the user's local time WITH its offset —
  // 2026-10-10T16:05:12+08:00 — one token with no spaces, so it is clear where it ends; the same
  // form chat_history uses, so a header matches a history line verbatim.
  const pad2 = (n) => String(n).padStart(2, "0");
  function msgTime(ts) {
    const d = new Date(ts);
    const off = -d.getTimezoneOffset();
    const a = Math.abs(off);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T` +
      `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
      `${off >= 0 ? "+" : "-"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
  }
  // Human-facing (panel quotes / chip): local "YYYY-MM-DD HH:MM:SS".
  function uiTime(ts) {
    return msgTime(ts).slice(0, 19).replace("T", " ");
  }
  // Same second? — how a "↩ <time>" marker is matched to a message. Accepts any ISO form
  // (offset, Z, or none = local), so an agent that rewrites the stamp still matches.
  function sameSecond(stamp, ts) {
    const t = Date.parse(String(stamp || ""));
    return Number.isFinite(t) && Number.isFinite(ts) && Math.floor(t / 1000) === Math.floor(ts / 1000);
  }

  // One line, whitespace collapsed, at most `max` chars (+ "…") — the quoted excerpt of a reply.
  const REPLY_EXCERPT_MAX = 150;
  function excerpt(text, max = REPLY_EXCERPT_MAX) {
    const s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  // A message's stable id: the conversation it belongs to + its millisecond timestamp.
  function messageId(conversationId, ts) {
    return `${conversationId || "c"}:${ts}`;
  }

  // The header a user message carries in the prompt, so a batched backlog keeps its boundaries and
  // a reply says what it answers:
  //   [2026-10-10T16:05:12+08:00 user]
  //   [2026-10-10T16:07:30+08:00 user ↩ 2026-10-10T16:05:40+08:00 orca「沒辦法直接知道…」]
  // `replyTo` = { timestamp, senderName, text } of the quoted message (or null).
  function promptHeader({ timestamp, senderName, replyTo }) {
    let h = `${msgTime(timestamp)} ${senderName || "user"}`;
    if (replyTo) h += ` ↩ ${msgTime(replyTo.timestamp)} ${replyTo.senderName || "?"}「${excerpt(replyTo.text)}」`;
    return `[${h}]`;
  }

  // Header + body, as one prompt entry (batchPrompts then joins entries with blank lines).
  function framePrompt(meta, text) {
    const body = text == null ? "" : String(text);
    return body ? `${promptHeader(meta)}\n${body}` : promptHeader(meta);
  }

  // Agent-side reply-to: a line "↩ <ISO time>" (anything after the time is ignored) starts
  // a part of the reply that answers the message sent at that time. Split the reply into segments
  // { replyTo: "<time>" | null, text } — markers inside ``` fences are left alone.
  const REPLY_MARKER = /^\s*↩\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)(?:\s.*)?$/;
  function splitReplySegments(text) {
    const lines = String(text == null ? "" : text).split("\n");
    const segs = [];
    let cur = { replyTo: null, lines: [] };
    let fence = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) fence = !fence;
      const m = fence ? null : REPLY_MARKER.exec(line);
      if (m) {
        if (cur.replyTo || cur.lines.some((l) => l.trim())) segs.push(cur);
        cur = { replyTo: m[1], lines: [] };
      } else {
        cur.lines.push(line);
      }
    }
    if (cur.replyTo || cur.lines.some((l) => l.trim())) segs.push(cur);
    return segs.map((s) => ({ replyTo: s.replyTo, text: s.lines.join("\n").trim() }));
  }

  // How a finished agent reply is shown: one part per "↩" segment, or the whole text as one part when
  // it has no markers. Parts with no text (a bare marker) are dropped — never an empty bubble.
  function replyParts(text) {
    const segs = splitReplySegments(text).filter((s) => s.text);
    if (!segs.some((s) => s.replyTo)) return [{ replyTo: null, text: String(text == null ? "" : text) }];
    return segs;
  }

  // A batch the agent may want to answer piecewise — two or more user messages, or a reply — gets a
  // one-line note on the marker convention, so any agent can use it without a skill.
  const HEADER_RE = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2}) [^\]\n]*\]/;
  const REPLY_HINT = "(To answer a specific message above, start that part of your reply with a line " +
    "\"↩ <its time>\", copying the time from its header, e.g. \"↩ 2026-10-10T16:05:12+08:00\" — the " +
    "user sees it as a quote.)";
  function needsReplyHint(entries) {
    const framed = (Array.isArray(entries) ? entries : []).filter((e) => HEADER_RE.test(String(e || "")));
    return framed.length >= 2 || framed.some((e) => / ↩ /.test(String(e).split("\n")[0]));
  }

  // #56: after a browser restart every window id changes, so this window's history key is empty
  // while the previous run's keys sit orphaned (their window ids no longer exist). Plan which orphan
  // this window adopts — the most recently saved one, only if this window has no history key at all
  // — and which orphans are old enough to prune. Pure: the caller does the storage work under a lock.
  //   entries: { [key]: { savedAt?, messages? } } (only HISTORY keys), liveIds: Set of window id strings
  function planHistoryAdoption({ entries, liveIds, ownKey, prefix, now, keepMs }) {
    const own = entries[ownKey];
    // Only a window with no key at all adopts. A cleared chat keeps its key (messages: [] but the
    // same sessions + conversationId) and must not be swapped for another window's conversation.
    const ownEmpty = !own;
    const orphans = Object.keys(entries).filter((k) => {
      if (k === ownKey || !k.startsWith(prefix)) return false;
      const id = k.slice(prefix.length);
      return /^\d+$/.test(id) && !liveIds.has(id);
    });
    const savedAt = (k) => Number((entries[k] && entries[k].savedAt) || 0);
    let adopt = null;
    if (ownEmpty) {
      for (const k of orphans) {
        const e = entries[k];
        if (!e || !Array.isArray(e.messages) || !e.messages.length) continue;
        if (adopt === null || savedAt(k) > savedAt(adopt)) adopt = k;
      }
    }
    const prune = orphans.filter((k) => k !== adopt && now - savedAt(k) > keepMs);
    return { adopt, prune };
  }

  // #62: the batch text with the reply hint exactly once, at the end. A retried prompt already
  // carries the hint; if new messages were queued after it, endsWith() no longer saw it and the
  // hint ended up twice (once mid-prompt). Strip it from every item, then add it once if needed.
  function batchWithReplyHint(batch) {
    const suffix = `\n\n${REPLY_HINT}`;
    const items = (Array.isArray(batch) ? batch : []).map((t) => {
      let s = t == null ? "" : String(t);
      while (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
      return s === REPLY_HINT ? "" : s;
    });
    const text = batchPrompts(items);
    // A retried item had the hint for a reason (it batched several messages): keep it.
    const hadHint = (Array.isArray(batch) ? batch : []).some((t) => String(t == null ? "" : t).endsWith(suffix));
    return text && (hadHint || needsReplyHint(items)) ? `${text}${suffix}` : text;
  }

  // #62: message ids are <conversationId>:<ms>; two messages finishing in the same ms (a split
  // reply's parts, two agents) must not share one. Returns t, or last + 1 if t is not after last.
  function nextUniqueMs(last, t) {
    return t > last ? t : last + 1;
  }

  return {
    batchWithReplyHint,
    nextUniqueMs,
    planHistoryAdoption,
    splitReplySegments,
    replyParts,
    uiTime,
    sameSecond,
    needsReplyHint,
    REPLY_HINT,
    msgTime,
    excerpt,
    messageId,
    promptHeader,
    framePrompt,
    REPLY_EXCERPT_MAX,
    acpClientInfo,
    escapeAttr,
    wrapRelay,
    batchPrompts,
    isDeadProbeReason,
    promptFailureAction,
    turnDeadline,
    TURN_IDLE_TIMEOUT_MS,
    TURN_MAX_TIMEOUT_MS,
    hasStoredConfig,
    shouldPersistOnStartup,
    shouldAdoptRemoteConfig,
    configSyncState,
    shouldProbe,
    onProbeTimeoutDecision,
    roomStatus,
    resolveActiveUrl,
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
