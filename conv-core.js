// conv-core.js — multi-conversation (ADR docs/adr/multi-conversation.md, MVP §3): the storage layout,
// the one-time migration from `history:<windowId>`, the rules of the open set (at most 3 open across
// all live windows), adoption after a browser restart, titles, and the U2 host line.
//
// The decisions are pure functions (plan*, title, time and guard helpers). The few storage steps that
// must be done in a fixed order under fixed locks — the migration, archiving ids, index writes — are
// in createConvStore(), with chrome.storage and the Web Lock injected, so a fake storage in the tests
// can cut a run short at any step and check that the next run completes it. sidepanel.js owns the
// DOM, the per-conversation Web Locks (`conv:<id>`) and the ACP sessions.
//
// Lock order, everywhere: `conv:migrate` → `conv:windows` → `conv:index`. A `conv:<id>` lock is only
// ever taken with ifAvailable, so it never waits and cannot deadlock with these. A delete (§7.1)
// holds `conv:<id>` and then waits for `conv:windows`: safe, because whoever holds `conv:windows`
// only ever TRIES `conv:<id>` (ifAvailable) and never waits for it.
//
// Dual target like ask-core.js (globalThis.ConvCore / module.exports); needs ConfirmCore first
// (titles are sanitised like confirm-card text).
(function (root, factory) {
  const confirmCore = typeof module !== "undefined" && module.exports ? require("./confirm-core.js") : root.ConfirmCore;
  const mod = factory(confirmCore);
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.ConvCore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ConfirmCore) {
  "use strict";

  const MAX_OPEN = 3;                                    // Q4: mirrors the broker pool of 3 (global)
  const AUTO_TITLE_MAX = 40;                             // §3.3: first 40 characters of the first user message
  const USER_TITLE_MAX = 80;                             // a typed name; the ADR sets no cap, the tab truncates anyway
  const INDEX_TIME_MIN_MS = 5000;                        // §3.2: lastMessageAt written at most every 5 s
  const ORPHAN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;        // §3.7, as #56
  const HISTORY_PREFIX = "history:";
  const CONV_PREFIX = "conv:";
  const WINDOW_PREFIX = "window:";
  const INDEX_KEY = "conv:index";
  const SCHEMA_KEY = "conv:schema";
  const REOPEN_KEY_PREFIX = "katashiro.convOpen.";       // storage.session: a gallery reopen for a panel not open yet
  const GROUP_KEY_PREFIX = "katashiro.canvasGroup.";     // storage.session: a conversation's tab group (sidepanel.js canvasGroupKey)
  const LOCK_MIGRATE = "conv:migrate";
  const LOCK_WINDOWS = "conv:windows";
  const LOCK_INDEX = "conv:index";
  const ID_RE = /^c_[0-9a-f]{12}$/;

  // The texts the panel shows for the rules below (Traditional Chinese, Taiwan).
  // P2 §5: switching and ＋ no longer wait for a reply (it continues in the background); archiving does.
  const ARCHIVE_BLOCKED_TEXT = "回覆中不能封存——等回完或先按 ⏹ 停止";
  // §5: the broker pool (shared with Discord threads and usercron) had no free session for the turn.
  const POOL_EXHAUSTED_TEXT = "agent 那邊同時進行的對話已滿（和 Discord、排程共用）——等其他回覆結束再按重試";
  const OPEN_ELSEWHERE_TEXT = "這段對話開在另一個視窗";
  const ARCHIVED_PUSH_TEXT = "這段對話已封存，先從總覽重新打開";
  // P1b §4.8: a push for a conversation open in another live window whose panel is closed.
  const PANEL_CLOSED_PUSH_TEXT = "這段對話開在另一個視窗，那個視窗的側邊欄沒開：到那個視窗打開側邊欄再送";
  // §7.1 deleting a conversation.
  const DELETED_TEXT = "這段對話已經刪除了";
  const DELETE_OPEN_TEXT = "這段對話開在另一個視窗：先在那裡封存再刪除";
  const DELETE_CHANGED_TEXT = "這段對話在確認期間有變動：再按一次 🗑，看過新的內容再確認";
  const DELETE_MISSING_TEXT = "找不到這段對話（可能已經在別的分頁刪除了）";
  // A panel could not take conv:<id> and no live window lists it: held by a delete in progress
  // (§7.1), not by another window's panel — so no "前往那個視窗".
  const CONV_BUSY_TEXT = "這段對話正在別處處理中（可能正在刪除）：稍後再試";
  // P1b §4.6: set_title refusals the agent reads (English, like every tool result).
  const SET_TITLE_USER_TEXT = "the user named this conversation; set_title never replaces a name the user typed";
  const SET_TITLE_EMPTY_TEXT = "title is empty after removing control and layout characters";

  // §3.5 U2: added at flush time only, BEFORE the batch (batchWithReplyHint strips the reply hint by
  // endsWith, so a line after it would break that on a retry).
  const RECONNECT_HINT = "[katashiro: this conversation was just reconnected. If you do not have its earlier messages, " +
    "read them with katashiro.chat_history before answering.]";

  const isConvId = (id) => typeof id === "string" && ID_RE.test(id);
  const convKey = (id) => `${CONV_PREFIX}${id}`;
  const windowKey = (windowId) => `${WINDOW_PREFIX}${windowId}`;
  const canvasIndexKey = (id) => `canvas:${id}:index`;   // CanvasStore's per-conversation index

  /** "c_" + 12 hex from a UUID (crypto.randomUUID in the panel and the worker). */
  function mintId(randomUUID) {
    return "c_" + String(randomUUID()).replace(/-/g, "").slice(0, 12);
  }

  /** The 7-character short id a new conversation is named by (and, in P4, its mirror folder). */
  function shortId(id) {
    return String(id || "").replace(/^c_/, "").slice(0, 7);
  }

  /** A first user message → its auto title: sanitised like confirm-card text, whitespace collapsed, 40 code points. "" if nothing printable. */
  function autoTitle(text) {
    const t = ConfirmCore.plainText(text, Number.MAX_SAFE_INTEGER).replace(/\s+/g, " ").trim();
    return Array.from(t).slice(0, AUTO_TITLE_MAX).join("").trim();
  }

  /** What a tab, the canvas group and the gallery call a conversation. */
  function displayTitle(entry, id) {
    const t = entry && typeof entry.title === "string" ? entry.title.trim() : "";
    return t || `未命名 ${shortId(id)}`;
  }

  // The first user message's auto title, from a conversation's records (oldest first), or null.
  function firstUserTitle(messages) {
    for (const m of Array.isArray(messages) ? messages : []) {
      if (m && m.kind === "sent") {
        const t = autoTitle(m.text);
        if (t) return t;
      }
    }
    return null;
  }

  /**
   * The index entry after a user message: the first one with text names a conversation that has no
   * title yet. A user name is never replaced, an auto title is never re-derived (🧹 keeps it).
   * → the new entry, or null when nothing changes.
   */
  function titleAfterUserMessage(entry, text) {
    const e = entry || {};
    if (e.titleSource === "user" || (e.title && (e.titleSource === "auto" || e.titleSource === "agent"))) return null;
    const t = autoTitle(text);
    if (!t) return null;
    return { ...e, title: t, titleSource: "auto" };
  }

  // A name typed by the user or given by the agent: sanitised like confirm-card text, whitespace
  // collapsed, ≤ 80 code points.
  function cleanName(name) {
    return Array.from(ConfirmCore.plainText(name, Number.MAX_SAFE_INTEGER).replace(/\s+/g, " ").trim()).slice(0, USER_TITLE_MAX).join("").trim();
  }

  /**
   * P1b §4.6 katashiro.set_title: the agent names its conversation. A user title always wins (the
   * call changes nothing); an auto title or an earlier agent title is replaced.
   * → { ok: true, entry, title } | { ok: false, error }
   */
  function agentTitledEntry(entry, title) {
    const e = entry || {};
    if (e.titleSource === "user") return { ok: false, error: SET_TITLE_USER_TEXT, title: e.title };
    const t = cleanName(typeof title === "string" ? title : "");
    if (!t) return { ok: false, error: SET_TITLE_EMPTY_TEXT };
    return { ok: true, entry: { ...e, title: t, titleSource: "agent" }, title: t };
  }

  /** Double-click rename: a typed name wins; an empty one returns to the auto title (or none). */
  function renamedEntry(entry, name, messages) {
    const e = entry || {};
    const typed = cleanName(name);
    if (typed) return { ...e, title: typed, titleSource: "user" };
    const auto = firstUserTitle(messages);
    return auto ? { ...e, title: auto, titleSource: "auto" } : { ...e, title: null, titleSource: null };
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  /** Q1: a tab's time — HH:MM today, else M/D (local time). "" with no message yet. */
  function tabTime(ts, now) {
    if (!Number.isFinite(ts) || ts <= 0) return "";
    const d = new Date(ts);
    const n = new Date(now);
    const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
    return sameDay ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`;
  }

  /** §3.2: write lastMessageAt now? At most every 5 s per conversation (switch / archive / hide force it). */
  function shouldWriteIndexTime(lastWrittenAt, now) {
    return !Number.isFinite(lastWrittenAt) || now - lastWrittenAt >= INDEX_TIME_MIN_MS;
  }

  /**
   * §3.4 + P2 §5: may a conversation be archived (×, the picker)? Not while its turn runs or it has
   * prompts queued on a live connection (they would be sent to a session nobody shows). A queue
   * waiting for a reconnect does not hold it. Switching away is never blocked since P2.
   * states: [{ turnActive, queued, online }] — one per agent → the refusal text, or null.
   */
  function archiveBlocked(states) {
    for (const s of Array.isArray(states) ? states : []) {
      if (!s) continue;
      if (s.turnActive || (s.queued > 0 && s.online)) return ARCHIVE_BLOCKED_TEXT;
    }
    return null;
  }

  /**
   * P2 §5: the one mark a tab-strip tab shows. A card waiting for the user (❓, Q12) outranks a
   * reply in progress (⏳), which outranks something new that arrived while it was not on screen
   * (●, Q9). The conversation on screen shows only ⏳ (its cards and replies are in front of the user).
   * → { kind, icon, label } (all null: no mark).
   */
  function tabMark({ current = false, replying = false, waiting = false, unread = false } = {}) {
    if (waiting && !current) return { kind: "waiting", icon: "❓", label: "有問題等你回答" };
    if (replying) return { kind: "replying", icon: "⏳", label: "回覆中" };
    if (unread && !current) return { kind: "unread", icon: "●", label: "有新回覆" };
    return { kind: null, icon: null, label: null };
  }

  /** §5: what a failed session/prompt says. "pool exhausted" is never retried automatically. */
  function promptFailureText(err) {
    const e = String(err == null ? "" : err);
    return /pool[ _-]?(is )?exhausted/i.test(e) ? `回合沒有開始：${POOL_EXHAUSTED_TEXT}` : `回合失敗：${e}`;
  }

  /**
   * §5: openab never fails session/prompt on a full pool — dispatch.rs (dispatch_batch) turns the
   * error into a chat line, "⚠️ " + format_user_error(e) (error_display.rs: "pool exhausted" →
   * "**Service Busy**\nAll agent sessions are in use…"), and the turn ends end_turn. A reply that is
   * exactly that line is the pool refusal, not an agent reply (review: Jellyfish, #143).
   */
  function isPoolBusyReply(text) {
    return /^\s*⚠️\s*\*\*Service Busy\*\*\s*\n\s*All agent sessions are in use\b[^\n]*\s*$/.test(String(text == null ? "" : text));
  }

  /**
   * §3.5 U2: does the first prompt after a session/resume or session/new carry the host line? Only
   * for a conversation that has messages from BEFORE this prompt: a brand-new conversation's first
   * message is already recorded when its session/new finishes, and is the queued prompt itself.
   */
  function needsReconnectHint({ messageCount = 0, queuedCount = 0 } = {}) {
    return messageCount > queuedCount;
  }

  // Tunnel-liveness §9.2 (A′). A socket that opens within QUICK_RECONNECT_MS of the previous
  // socket's last inbound frame is almost certainly talking to the same openab process (an edge
  // network blip, not a restart), so its pooled sessions are intact. POOL_TTL_MS mirrors openab's
  // `session_ttl_hours = 1`: a session idle longer may have been suspended or evicted.
  const QUICK_RECONNECT_MS = 2 * 60 * 1000;
  const POOL_TTL_MS = 60 * 60 * 1000;

  /**
   * §9.2: does a socket opening at `openedAt` continue the current run of the agent's sockets?
   * `prevLastRecvAt` = the last inbound frame of any earlier socket of this conn in this panel's
   * lifetime (0 = none: a panel reload or a new conn → a new run; we cannot know what happened).
   * `prevEnd` = how that socket ended: only an `"unclean"` drop (no close frame — a network blip
   * cannot send one) or a heartbeat teardown can continue the run. A clean close means the server
   * side closed on purpose (openab or cloudflared shutting down: a rolling deploy, a restart), so
   * the next socket may reach a new process however fast it opens; `"clean"` / null → a new run.
   */
  function continuesRun({ prevLastRecvAt = 0, prevEnd = null, openedAt, quickMs = QUICK_RECONNECT_MS } = {}) {
    if (prevEnd !== "unclean") return false;
    if (!(prevLastRecvAt > 0) || !Number.isFinite(openedAt)) return false;
    const gap = openedAt - prevLastRecvAt;
    return gap >= 0 && gap < quickMs;
  }

  /** The newest reply of `agentId` in a conversation's messages (0 if none) — §9.2 rule 3. */
  function lastReplyAt(messages, agentId) {
    let at = 0;
    for (const m of Array.isArray(messages) ? messages : []) {
      if (m && m.kind === "received" && m.senderId === agentId && Number.isFinite(m.timestamp) && m.timestamp > at) at = m.timestamp;
    }
    return at;
  }

  /**
   * §9.2 (A′): after a session/resume or session/new, does the conversation's next prompt carry the
   * host line? Skip it only when the agent's session is almost certainly intact: it was resumed, the
   * agent replied in this conversation during the current run of quick reconnects (so the same
   * openab process holds it — this also covers a switch / gallery reopen on a live socket), and that
   * reply is younger than the pool TTL. Everything we cannot vouch for keeps the line.
   * Known gap: an openab restart under QUICK_RECONNECT_MS whose socket drops uncleanly (no close
   * frame reached the browser) looks like a quick reconnect.
   * → { hint, reason } (the reason is for the console log).
   */
  function reconnectHintDecision({
    messageCount = 0, queuedCount = 0, resumed = false, runStartAt = 0, lastReplyAt: replyAt = 0, now,
    poolTtlMs = POOL_TTL_MS,
  } = {}) {
    if (!needsReconnectHint({ messageCount, queuedCount })) return { hint: false, reason: "no earlier messages" };
    if (!resumed) return { hint: true, reason: "new session" };
    if (!(runStartAt > 0)) return { hint: true, reason: "no connection run" };
    if (!(replyAt > 0)) return { hint: true, reason: "no reply from this agent" };
    if (replyAt < runStartAt) return { hint: true, reason: "last reply before this connection run" };
    if (!Number.isFinite(now) || now - replyAt >= poolTtlMs) return { hint: true, reason: "last reply older than the pool TTL" };
    return { hint: false, reason: "session intact (same connection run)" };
  }

  /** The prompt text with the host line first (flush time only; never stored or retried). */
  function withReconnectHint(text) {
    const t = text == null ? "" : String(text);
    return t ? `${RECONNECT_HINT}\n\n${t}` : RECONNECT_HINT;
  }

  // --- the open set -------------------------------------------------------------------------------

  const isWindowId = (w) => /^\d+$/.test(String(w));
  const openOf = (rec) => (rec && Array.isArray(rec.open) ? rec.open.filter(isConvId) : []);

  /**
   * §3.3: the ids open in LIVE windows (their `window:` records), optionally not counting one window.
   * windows: { [windowId]: record }, liveIds: Set of window id strings.
   */
  function liveOpenIds(windows, liveIds, exceptWindowId) {
    const out = new Set();
    for (const [w, rec] of Object.entries(windows || {})) {
      if (exceptWindowId != null && String(w) === String(exceptWindowId)) continue;
      if (!liveIds.has(String(w))) continue;
      for (const id of openOf(rec)) out.add(id);
    }
    return out;
  }

  /** Which window record holds `id` open (live windows first), or null — for "focus that window". */
  function windowHolding(windows, liveIds, id) {
    let orphan = null;
    for (const [w, rec] of Object.entries(windows || {})) {
      if (!openOf(rec).includes(id)) continue;
      if (liveIds.has(String(w))) return String(w);
      if (orphan === null) orphan = String(w);
    }
    return orphan;
  }

  /** A record with `id` opened and current (tab order kept; a new id goes last). */
  function withOpened(rec, id) {
    const open = openOf(rec).filter((x) => x !== id);
    const at = openOf(rec).indexOf(id);
    if (at >= 0) open.splice(at, 0, id); else open.push(id);
    return { open, current: id };
  }

  /** A record with `id` closed; the current one stays, or moves to the right-hand neighbour, else the left. */
  function withClosed(rec, id) {
    const before = openOf(rec);
    const at = before.indexOf(id);
    const open = before.filter((x) => x !== id);
    let current = rec && rec.current;
    if (current === id || !open.includes(current)) current = open.length ? open[Math.min(Math.max(at, 0), open.length - 1)] : null;
    return { open, current };
  }

  /**
   * §3.7 (Q3): a window with no `window:` record adopts the most recently used orphan record — a
   * window id that is not live and holds open ids. "Most recently used" = the newer of its savedAt
   * and its conversations' lastMessageAt, so a window that was chatting beats one that only loaded.
   * It takes as many ids as fit under the 3 still free in live windows: current first, then newest
   * lastMessageAt. What does not fit is archived (reopenable from the gallery) so it is never left in
   * no record at all. With no free slot nothing is adopted: the record stays for a later window (a
   * second window opened while 3 are open elsewhere must not archive a closed window's chats).
   * Other orphan records older than keepMs are pruned and their ids archived.
   * → { adopt: windowId | null, take: [ids], current, archive: [ids], prune: [windowIds] }
   */
  function planAdoption({ ownWindowId, windows, liveIds, index, now, keepMs = ORPHAN_KEEP_MS, maxOpen = MAX_OPEN }) {
    const own = String(ownWindowId);
    const idx = index || {};
    const lastAt = (id) => Number((idx[id] && idx[id].lastMessageAt) || 0);
    const usedAt = (w) => Math.max(Number((windows[w] && windows[w].savedAt) || 0), ...openOf(windows[w]).map(lastAt), 0);
    const orphans = Object.keys(windows || {}).filter((w) => w !== own && isWindowId(w) && !liveIds.has(w));
    let adopt = null;
    const free0 = Math.max(0, maxOpen - liveOpenIds(windows, liveIds, own).size);
    if (!windows[own] && free0 > 0) {
      for (const w of orphans) {
        if (!openOf(windows[w]).length) continue;
        if (adopt === null || usedAt(w) > usedAt(adopt)) adopt = w;
      }
    }
    const take = [];
    const archive = [];
    let current = null;
    if (adopt !== null) {
      const rec = windows[adopt];
      const ids = openOf(rec);
      const cur = ids.includes(rec.current) ? rec.current : null;
      const ordered = [...(cur ? [cur] : []), ...ids.filter((x) => x !== cur).sort((a, b) => lastAt(b) - lastAt(a))];
      const busy = liveOpenIds(windows, liveIds, own);
      let free = Math.max(0, maxOpen - busy.size);
      for (const id of ordered) {
        if (busy.has(id)) continue;                      // already open in a live window: theirs
        if (free > 0) { take.push(id); free--; } else archive.push(id);
      }
      // Tab order as it was in the adopted record.
      take.sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
      current = take.includes(cur) ? cur : (take[0] || null);
    }
    const prune = orphans.filter((w) => w !== adopt && now - usedAt(w) > keepMs);
    for (const w of prune) for (const id of openOf(windows[w])) if (!take.includes(id) && !archive.includes(id)) archive.push(id);
    // An id archived from a pruned record but still open in a live window is not archived.
    const liveNow = liveOpenIds(windows, liveIds, own);
    return { adopt, take, current, archive: archive.filter((id) => !liveNow.has(id)), prune };
  }

  // --- migration (§3.2) ---------------------------------------------------------------------------

  /** Step 1: every `history:` entry without a conversation id gets one minted (written back first). → { [key]: entry } */
  function planIdFixes(histories, mint) {
    const out = {};
    for (const [k, v] of Object.entries(histories || {})) {
      if (!k.startsWith(HISTORY_PREFIX)) continue;
      const e = v && typeof v === "object" ? v : {};
      if (!isConvId(e.conversationId)) out[k] = { ...e, conversationId: mint() };
    }
    return out;
  }

  const msgsOf = (e) => (e && Array.isArray(e.messages) ? e.messages : []);
  const savedAtOf = (e) => Number((e && e.savedAt) || 0);
  const tsOf = (m) => (m && Number.isFinite(m.timestamp) ? m.timestamp : null);

  /** A conversation record's index fields (title, times) from its messages. */
  function indexFieldsFor(conv) {
    const msgs = msgsOf(conv);
    const times = msgs.map(tsOf).filter((t) => t !== null);
    const title = firstUserTitle(msgs);
    return {
      title, titleSource: title ? "auto" : null,
      createdAt: times.length ? times[0] : savedAtOf(conv) || null,
      lastMessageAt: times.length ? times[times.length - 1] : null,
    };
  }

  /**
   * Steps 2–5, given every `history:` entry WITH an id (step 1 done), the existing `conv:<id>`
   * records, the index and the `window:` records. Pure and idempotent: running it again on its own
   * output (or on a run cut short anywhere) gives the same result.
   * → { convWrites: { [id]: conv }, index: next index, windowWrites: { [windowId]: record }, remove: [history keys] }
   */
  function planMigration({ histories, convs, index, windows, liveIds, now, maxOpen = MAX_OPEN }) {
    const idx = { ...(index || {}) };
    const wins = windows || {};
    // 2. Deduplicate by conversation id: the newer savedAt wins (ties: the lower key, for a stable plan).
    const winner = {};
    const remove = [];
    for (const k of Object.keys(histories || {}).sort()) {
      if (!k.startsWith(HISTORY_PREFIX)) continue;
      remove.push(k);
      const e = histories[k];
      if (!e || !isConvId(e.conversationId)) continue;   // step 1 not done for it: removed, never guessed at
      const id = e.conversationId;
      if (!winner[id] || savedAtOf(e) > savedAtOf(histories[winner[id]])) winner[id] = k;
    }
    // 3. conv:<id> and its index entry. An existing record that is as new or newer wins as a whole.
    const convWrites = {};
    const ids = Object.keys(winner);
    const finalConv = {};
    for (const id of ids) {
      const h = histories[winner[id]];
      const existing = convs && convs[id];
      if (!existing || savedAtOf(h) > savedAtOf(existing)) {
        const sessions = h.sessions && typeof h.sessions === "object" ? h.sessions : {};
        convWrites[id] = { id, sessions, messages: msgsOf(h), savedAt: savedAtOf(h) || now };
        finalConv[id] = convWrites[id];
      } else {
        finalConv[id] = existing;
      }
      const prev = idx[id] || {};
      const f = indexFieldsFor(finalConv[id]);
      idx[id] = {
        title: prev.titleSource === "user" ? prev.title : (f.title || prev.title || null),
        titleSource: prev.titleSource === "user" ? "user" : (f.title ? "auto" : (prev.titleSource || null)),
        createdAt: prev.createdAt || f.createdAt || now,
        lastMessageAt: Math.max(Number(prev.lastMessageAt || 0), Number(f.lastMessageAt || 0)) || null,
        archivedAt: prev.archivedAt == null ? null : prev.archivedAt,
      };
    }
    // 4. Open at most 3. Already placed (in any window record — an earlier run, or the newer version
    // already running): left where they are. The rest are ranked live-window first, then newest.
    const placed = new Set();
    for (const rec of Object.values(wins)) for (const id of openOf(rec)) placed.add(id);
    const busy = liveOpenIds(wins, liveIds);
    for (const id of ids) if (placed.has(id) && !busy.has(id)) busy.add(id);   // placed in an orphan record: holds its slot
    let free = Math.max(0, maxOpen - busy.size);
    const winOf = (id) => winner[id].slice(HISTORY_PREFIX.length);
    const candidates = ids.filter((id) => !placed.has(id)).sort((a, b) => {
      const la = liveIds.has(winOf(a)) ? 1 : 0, lb = liveIds.has(winOf(b)) ? 1 : 0;
      if (la !== lb) return lb - la;
      return Number(idx[b].lastMessageAt || 0) - Number(idx[a].lastMessageAt || 0) || (a < b ? -1 : 1);
    });
    const windowWrites = {};
    for (const id of ids) if (placed.has(id)) idx[id] = { ...idx[id], archivedAt: null };
    for (const id of candidates) {
      if (free > 0) {
        free--;
        const w = winOf(id);
        const base = windowWrites[w] || wins[w];
        windowWrites[w] = { ...withOpened(base, id), savedAt: Math.max(savedAtOf(histories[winner[id]]), savedAtOf(base)) || now };
        idx[id] = { ...idx[id], archivedAt: null };
      } else {
        idx[id] = { ...idx[id], archivedAt: idx[id].archivedAt || now };
      }
    }
    return { convWrites, index: idx, windowWrites, remove };
  }

  /**
   * P1b §4.8: a canvas push for conversation `id` that no panel holds (its Web Lock is free), answered
   * by the panel of the canvas tab's window. Open in another LIVE window's record → that window's
   * panel is closed (say so, and which window); otherwise (archived, or only in a closed window's
   * record) → it is not open anywhere.
   * → { text, windowId: string | null }
   */
  function pushRefusal({ windows, liveIds, id, ownWindowId }) {
    const holder = windowHolding(windows, liveIds, id);
    if (holder !== null && liveIds.has(holder) && holder !== String(ownWindowId)) return { text: PANEL_CLOSED_PUSH_TEXT, windowId: holder };
    return { text: ARCHIVED_PUSH_TEXT, windowId: null };
  }

  // --- the gallery's 對話 section (§3.4) ----------------------------------------------------------

  function normalize(s) {
    const t = String(s == null ? "" : s);
    return (typeof t.normalize === "function" ? t.normalize("NFKC") : t).toLowerCase();
  }

  /**
   * Every conversation not open in a live window (archived, or left in a closed window's record),
   * newest lastMessageAt first, filtered by title (the gallery's search box: all terms must match).
   * → [{ id, title, time, at, canvases, archived }]
   */
  function galleryRows({ index, openLive, canvasCounts, query, now }) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    const rows = [];
    for (const [id, e] of Object.entries(index || {})) {
      if (!isConvId(id) || !e || openLive.has(id)) continue;
      if (e.deletingAt != null) continue;              // §7.1: being deleted (finished on the next start)
      const title = displayTitle(e, id);
      if (terms.length && !terms.every((t) => normalize(title).includes(t))) continue;
      const at = Number(e.lastMessageAt || e.createdAt || 0);
      rows.push({ id, title, at, time: tabTime(at, now), canvases: Number((canvasCounts && canvasCounts[id]) || 0), archived: e.archivedAt != null });
    }
    return rows.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
  }

  // --- deleting a conversation (§7.1) ---------------------------------------------------------------

  /**
   * Step 1 of a delete, decided under `conv:windows` → `conv:index`. Refused while the id is in a LIVE
   * window's record (open there: archive it first) — with that window, for "focus it". Otherwise the
   * id leaves every (closed-window) record that still lists it and its index entry gets deletingAt,
   * written together in one set(). An id with no index entry still gets one (just the mark), so a
   * delete cut short after this step is finished by the next start rather than leaving its
   * conv:<id> and canvases behind with nothing pointing at them.
   * → { refuse: "open", windowId } | { refuse: null, windowWrites: { [windowId]: record }, entry, known }
   */
  function planDelete({ id, windows, liveIds, index, now }) {
    const holder = windowHolding(windows, liveIds, id);
    if (holder !== null && liveIds.has(holder)) return { refuse: "open", windowId: holder };
    const windowWrites = {};
    for (const [w, rec] of Object.entries(windows || {})) {
      if (openOf(rec).includes(id)) windowWrites[w] = { ...withClosed(rec, id), savedAt: Number((rec && rec.savedAt) || 0) };
    }
    const e = index && index[id];
    const base = e && typeof e === "object" ? e : { title: null, titleSource: null, createdAt: now, lastMessageAt: null, archivedAt: now };
    return { refuse: null, windowWrites, entry: { ...base, deletingAt: base.deletingAt != null ? base.deletingAt : now }, known: !!e };
  }

  /**
   * What the gallery's confirm dialog showed (§7.1), as one comparable string: read again under the
   * conversation's lock after 確定, a different value means the dialog under-reports what would go.
   * null = no index entry, or one already being deleted (another tab deleted it meanwhile).
   * entry = its index entry, conv = conv:<id>, canvases = the canvas metas naming it.
   */
  function deleteSnapshot({ entry, conv, canvases }) {
    if (!entry || typeof entry !== "object" || entry.deletingAt != null) return null;
    const messages = conv && Array.isArray(conv.messages) ? conv.messages.length : 0;
    const cs = (canvases || []).filter((m) => m && typeof m.id === "string")
      .map((m) => [m.id, Number(m.version || 0), Number(m.at || 0)])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return JSON.stringify({ lastMessageAt: Number(entry.lastMessageAt || 0), messages, canvases: cs });
  }

  /** The refusal for a delete whose dialog showed `before` and now finds `after` → null | "missing" | "changed". */
  function deleteRecheck(before, after) {
    if (after === null) return "missing";
    return before === after ? null : "changed";
  }

  /** The ids a delete was started for and not finished (their index entry still carries deletingAt). */
  function pendingDeletions(index) {
    return Object.entries(index || {}).filter(([id, e]) => isConvId(id) && e && e.deletingAt != null).map(([id]) => id);
  }

  /** A reopen (§3.4) of a conversation that is gone or being deleted is refused → the text, or null. */
  function reopenRefusal(entry) {
    return !entry || entry.deletingAt != null ? DELETED_TEXT : null;
  }

  /**
   * The gallery's confirm text (§7.1): what goes, that the mirror folder's files stay, that it cannot
   * be undone. The title is agent-writable (set_title, first message): flattened to one line, like
   * a confirm card's, so it cannot add a line such as "(nothing will be deleted)".
   * summary = { canvases, versions, images, mirrored } (CanvasGalleryCore.conversationDeleteSummary).
   */
  function deleteConfirmText({ title, messages = 0, summary = {} } = {}) {
    const t = ConfirmCore.plainText(title, 60) || "未命名";
    const n = Math.max(0, Number(messages) || 0);
    const c = Math.max(0, Number(summary.canvases) || 0);
    const v = Math.max(0, Number(summary.versions) || 0);
    const img = Math.max(0, Number(summary.images) || 0);
    const lines = [`刪除對話「${t}」？`, "", "會刪除："];
    lines.push(`・${n} 則訊息`);
    if (c) lines.push(`・${c} 個畫布，連同存著的 ${v} 個版本${img ? `和 ${img} 張圖片（其他畫布也用到的圖片會留著）` : ""}`);
    else lines.push("・沒有畫布");
    lines.push("・Katashiro 記著的 agent session（不會通知 agent；它那邊閒置後自己結束）");
    lines.push("");
    if (summary.mirrored) lines.push("資料夾裡的畫布檔案不會被刪除。");
    lines.push("這個動作無法復原。");
    return lines.join("\n");
  }

  /**
   * The canvas side of a delete, from a CanvasStore (canvas-store.js createCanvasStore): the canvases
   * whose meta names the conversation, each through store.remove (the canvas 🗑's path: every
   * version, the index entry; conversationId set so a canvas of another conversation can never go),
   * and one image sweep after all of them, as removeIncognitoLeftovers does.
   */
  function canvasOps(store) {
    return {
      async idsOf(conversationId) {
        return (await store.allMetas()).filter((m) => m && m.conversationId === conversationId && /^cv_[0-9a-f]{12}$/.test(String(m.id))).map((m) => m.id);
      },
      remove: (id, conversationId) => store.remove({ conversationId, id, sweep: false }),
      sweep: () => store.sweepImages(),
    };
  }

  // --- storage steps (chrome.storage.local + Web Locks injected) ------------------------------------

  async function getMatching(storage, test) {
    if (typeof storage.getKeys === "function") {
      const keys = (await storage.getKeys()).filter(test);
      return keys.length ? (await storage.get(keys)) || {} : {};
    }
    const all = (await storage.get(null)) || {};
    const out = {};
    for (const [k, v] of Object.entries(all)) if (test(k)) out[k] = v;
    return out;
  }

  /**
   * deps = { storage, lock(name, fn), liveWindowIds: async () => Set<string>, randomUUID, now,
   *          lockIfAvailable(name, fn(lock | null)), canvases: canvasOps(store), sessionStorage }
   * (the last three only for deleting, §7.1).
   */
  function createConvStore(deps) {
    const { storage, lock } = deps;
    const now = () => (deps.now ? deps.now() : Date.now());
    const getOne = async (k) => ((await storage.get(k)) || {})[k];

    async function readWindows() {
      const raw = await getMatching(storage, (k) => k.startsWith(WINDOW_PREFIX));
      const out = {};
      for (const [k, v] of Object.entries(raw)) out[k.slice(WINDOW_PREFIX.length)] = v;
      return out;
    }
    async function readIndex() {
      const v = await getOne(INDEX_KEY);
      return v && typeof v === "object" ? v : {};
    }
    /** Read-modify-write the index under `conv:index`; fn(index) returns the next index (or undefined = unchanged). */
    function updateIndex(fn) {
      return lock(LOCK_INDEX, async () => {
        const idx = await readIndex();
        const next = await fn({ ...idx });
        if (next) await storage.set({ [INDEX_KEY]: next });
        return next || idx;
      });
    }

    /**
     * Archive `ids` (call under `conv:windows`): a conversation with no messages and no canvases is
     * deleted instead (§3.2 "empty conversations are not kept"); the rest get archivedAt. Removes
     * nothing from window records — the caller decides those.
     */
    async function archiveIds(ids) {
      const list = [...new Set((ids || []).filter(isConvId))];
      if (!list.length) return { archived: [], deleted: [] };
      const got = (await storage.get([...list.map(convKey), ...list.map(canvasIndexKey)])) || {};
      const empty = list.filter((id) => !msgsOf(got[convKey(id)]).length && !(Array.isArray(got[canvasIndexKey(id)]) && got[canvasIndexKey(id)].length));
      const t = now();
      await updateIndex((idx) => {
        for (const id of list) {
          if (empty.includes(id)) delete idx[id];
          else idx[id] = { ...(idx[id] || { title: null, titleSource: null, createdAt: t, lastMessageAt: null }), archivedAt: t };
        }
        return idx;
      });
      if (empty.length) await storage.remove(empty.map(convKey));
      return { archived: list.filter((id) => !empty.includes(id)), deleted: empty };
    }

    /**
     * The one-time migration (§3.2), safe to run any number of times and to be cut short anywhere.
     * Runs whenever a `history:` key exists, under `conv:migrate`; callers AWAIT it, so a panel
     * never builds from a half-migrated state. → { migrated: number }
     */
    function migrate() {
      return lock(LOCK_MIGRATE, async () => {
        let histories = await getMatching(storage, (k) => k.startsWith(HISTORY_PREFIX));
        if (!Object.keys(histories).length) return { migrated: 0 };
        // 1. Fix every id first, written back before anything else.
        const fixes = planIdFixes(histories, () => mintId(deps.randomUUID));
        if (Object.keys(fixes).length) {
          await storage.set(fixes);
          histories = { ...histories, ...fixes };
        }
        const ids = [...new Set(Object.values(histories).map((h) => h && h.conversationId).filter(isConvId))];
        let plan;
        await lock(LOCK_WINDOWS, () => lock(LOCK_INDEX, async () => {
          const [convsRaw, index, windows, liveIds] = await Promise.all([
            ids.length ? storage.get(ids.map(convKey)) : {},
            readIndex(),
            readWindows(),
            deps.liveWindowIds(),
          ]);
          const convs = {};
          for (const id of ids) if (convsRaw && convsRaw[convKey(id)]) convs[id] = convsRaw[convKey(id)];
          plan = planMigration({ histories, convs, index, windows, liveIds, now: now() });
          const writes = { [INDEX_KEY]: plan.index };
          for (const [id, c] of Object.entries(plan.convWrites)) writes[convKey(id)] = c;
          for (const [w, rec] of Object.entries(plan.windowWrites)) writes[windowKey(w)] = rec;
          // One set(): conversations, index and window records land together (3.–4.).
          await storage.set(writes);
        }));
        // 5. Only now the old keys go; then the informational marker.
        await storage.remove(plan.remove);
        await storage.set({ [SCHEMA_KEY]: 1 });
        return { migrated: Object.keys(plan.convWrites).length };
      });
    }

    // --- §7.1 delete ---------------------------------------------------------------------------------

    // Step 1 (planDelete), under conv:windows → conv:index; records and mark in ONE set().
    function markDeleting(id) {
      return lock(LOCK_WINDOWS, () => lock(LOCK_INDEX, async () => {
        const [windows, index, liveIds] = await Promise.all([readWindows(), readIndex(), deps.liveWindowIds()]);
        const plan = planDelete({ id, windows, liveIds, index, now: now() });
        if (plan.refuse) return { ok: false, reason: plan.refuse, windowId: plan.windowId };
        const writes = { [INDEX_KEY]: { ...index, [id]: plan.entry } };
        for (const [w, rec] of Object.entries(plan.windowWrites)) writes[windowKey(w)] = rec;
        await storage.set(writes);
        return { ok: true, known: plan.known };
      }));
    }

    // Steps 2–4. Each finds nothing to do once done, so a run cut short is simply run again.
    // sweepAlways: a resumed run sweeps even with no canvas left to remove — the cut may have come
    // after the last remove and before (or inside) the sweep, leaving their images behind.
    async function finishDeletion(id, { sweepAlways = false } = {}) {
      const ops = deps.canvases;
      let canvases = 0;
      if (ops) {
        const ids = await ops.idsOf(id);
        for (const cid of ids) if ((await ops.remove(cid, id)).removed) canvases++;
        // One sweep after all of them; best effort (the next save or delete sweeps again).
        if (ids.length || sweepAlways) { try { await ops.sweep(); } catch (_) { /* best effort */ } }
      }
      await storage.remove([convKey(id), canvasIndexKey(id)]);
      if (deps.sessionStorage) { try { await deps.sessionStorage.remove(`${GROUP_KEY_PREFIX}${id}`); } catch (_) { /* best effort */ } }
      // Last: the mark itself (only if it is still a mark: never an entry someone re-created).
      await updateIndex((idx) => {
        if (!idx[id] || idx[id].deletingAt == null) return undefined;
        delete idx[id];
        return idx;
      });
      return canvases;
    }

    /**
     * Delete conversation `id` (§7.1): its messages, sessions, canvases with every version, and
     * (by the sweep) images nothing else uses. Holds the conversation's Web Lock for the whole run,
     * taken with ifAvailable: a panel holding it has it open → refused with the window holding it.
     * recheck (the gallery's): run once the lock is held, before anything is written; a reason it
     * returns refuses the delete, nothing touched (the dialog's counts are no longer what would go).
     * → { ok: true, canvases, known } | { ok: false, reason: "open" | "locked" | <recheck's>, windowId }
     * known = false: there was no index entry (only leftovers went; nothing the user saw).
     */
    function deleteConversation(id, { recheck } = {}) {
      if (!isConvId(id)) return Promise.resolve({ ok: false, reason: "invalid", windowId: null });
      return deps.lockIfAvailable(`${CONV_PREFIX}${id}`, async (held) => {
        if (!held) {
          // The panel holding it lists it in its live window's record; a closed window's record is
          // no answer to "which window" (nothing to focus there).
          let windowId = null;
          try {
            const live = await deps.liveWindowIds();
            const w = windowHolding(await readWindows(), live, id);
            if (w !== null && live.has(w)) windowId = w;
          } catch (_) { /* unknown */ }
          return { ok: false, reason: "locked", windowId };
        }
        if (recheck) {
          const why = await recheck();
          if (why) return { ok: false, reason: why, windowId: null };
        }
        const mark = await markDeleting(id);
        if (!mark.ok) return mark;
        return { ok: true, canvases: await finishDeletion(id), known: mark.known };
      });
    }

    /**
     * Finish every delete a run left half done (§7.1: worker start, panel load, gallery load). A
     * conversation whose lock is held is skipped: a delete of it is running right now elsewhere.
     * → the ids finished.
     */
    async function finishDeletions() {
      const done = [];
      for (const id of pendingDeletions(await readIndex())) {
        await deps.lockIfAvailable(`${CONV_PREFIX}${id}`, async (held) => {
          if (!held) return;
          const mark = await markDeleting(id);
          if (!mark.ok) return;
          await finishDeletion(id, { sweepAlways: true });
          done.push(id);
        });
      }
      return done;
    }

    return { readWindows, readIndex, updateIndex, archiveIds, migrate, deleteConversation, finishDeletions, getMatching: (test) => getMatching(storage, test) };
  }

  return {
    MAX_OPEN, AUTO_TITLE_MAX, USER_TITLE_MAX, INDEX_TIME_MIN_MS, ORPHAN_KEEP_MS,
    HISTORY_PREFIX, CONV_PREFIX, WINDOW_PREFIX, INDEX_KEY, SCHEMA_KEY, REOPEN_KEY_PREFIX, GROUP_KEY_PREFIX,
    DELETED_TEXT, DELETE_OPEN_TEXT, DELETE_CHANGED_TEXT, DELETE_MISSING_TEXT, CONV_BUSY_TEXT,
    planDelete, deleteSnapshot, deleteRecheck, pendingDeletions, reopenRefusal, deleteConfirmText, canvasOps,
    LOCK_MIGRATE, LOCK_WINDOWS, LOCK_INDEX, ID_RE,
    ARCHIVE_BLOCKED_TEXT, POOL_EXHAUSTED_TEXT, OPEN_ELSEWHERE_TEXT, ARCHIVED_PUSH_TEXT, PANEL_CLOSED_PUSH_TEXT, RECONNECT_HINT,
    SET_TITLE_USER_TEXT, SET_TITLE_EMPTY_TEXT, cleanName, agentTitledEntry, pushRefusal,
    isConvId, convKey, windowKey, canvasIndexKey, mintId, shortId,
    autoTitle, displayTitle, firstUserTitle, titleAfterUserMessage, renamedEntry, tabTime, shouldWriteIndexTime,
    archiveBlocked, promptFailureText, isPoolBusyReply, tabMark, needsReconnectHint, withReconnectHint,
    QUICK_RECONNECT_MS, POOL_TTL_MS, continuesRun, lastReplyAt, reconnectHintDecision,
    liveOpenIds, windowHolding, withOpened, withClosed, planAdoption,
    planIdFixes, indexFieldsFor, planMigration, galleryRows, createConvStore,
  };
});
