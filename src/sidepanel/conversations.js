// Katashiro side panel — conversations (ADR docs/adr/multi-conversation.md): their state (convs,
// conv:index, this window's record, the current one), persistence (saveConv, patchIndex, the 5 s
// lastMessageAt throttle, auto / agent titles), the load (loadConversations: adoption, locks, agent
// binding), showing / switching (one message list per conversation, drafts, ＋, × archive, reopen,
// the archive and agent pickers, the reopen request from the gallery or a canvas tab) and the tab
// strip. Moved verbatim out of sidepanel.js (plan B, step 4); no logic change.
//
// Classic script, loaded by sidepanel.html after conn.js and BEFORE composer-ui.js, canvas-glue.js,
// cards.js and sidepanel.js; all scripts share one global scope. Load-order rule: this file holds
// declarations only. Its top level must not run anything that touches a name declared in a
// later-loaded file (DOM refs, room state, …) — that would be a TDZ ReferenceError at load. Its
// initializers are plain values (literals, new Map(), a Promise whose executor only sets
// markPanelReady) or arrow functions, plus one pure src/core factory call
// (ConvCore.createConvStore: builds closures, no I/O; its `canvases` getter reads canvasStore at
// call time). Function bodies may use names from any file, later-loaded ones included
// (showConversation calls setReplyTarget in composer-ui.js, closeCmdMenu in cards.js and
// scrollToBottom in sidepanel.js): they only run once every script has loaded. The wiring that runs
// at load (the conv:index storage listener, the conv-archive / conv-open onMessage listeners, the
// visibilitychange listener, the tab strip's 60 s timer) and the DOM refs it reads (the lobby list,
// picker-dock, conv-tabs) stay in sidepanel.js, at the spot these sections came from, so their
// order is unchanged.

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
const freshIndexEntry = (agentUrl = null) => ({ title: null, titleSource: null, createdAt: Date.now(), lastMessageAt: null, archivedAt: null, agentUrl });

function currentWindow() {
  return new Promise((resolve) => {
    try {
      chrome.windows.getCurrent((w) => resolve({ id: w && w.id != null ? w.id : "default" }));
    } catch { resolve({ id: "default" }); }
  });
}

function makeConv(id, data) {
  const d = data && typeof data === "object" ? data : {};
  // agent-per-conversation §2.1: the index entry's agentUrl is the truth; a record that differs is
  // written back (a rebind cut short), and one with neither gets what the migration would give it
  // (§2.2: the old active agent, else the first) — never a different silent default.
  const bind = ConvCore.recordAgentUrl(convIndex[id], data, RoomCore.resolveActiveUrl(agents, legacyActiveAgentUrl));
  if (bind.writeIndex) {
    convIndex[id] = { ...(convIndex[id] || freshIndexEntry()), agentUrl: bind.url };
    patchIndex(id, () => ({ agentUrl: bind.url }));
  }
  if (bind.writeBack && data && typeof data === "object") {
    chrome.storage.local.set({ [ConvCore.convKey(id)]: { ...data, agentUrl: bind.url } }).catch(() => { /* quota — next saveConv */ });
  }
  return {
    id,
    agentUrl: bind.url,                   // agent-per-conversation: its agent, for its whole life (§2.6 URL edit aside)
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
  return chrome.storage.local.set({ [ConvCore.convKey(conv.id)]: { id: conv.id, agentUrl: conv.agentUrl, sessions: conv.sessions, messages: conv.messages, workingTab: conv.workingTab, groupTabs: conv.groupTabs, savedAt: Date.now() } })
    .catch(() => { /* quota — the on-screen chat is unaffected */ });
}

// Read-modify-write one index entry under conv:index; `patch(entry)` returns the fields to change.
function patchIndex(id, patch) {
  return convStore.updateIndex((idx) => {
    const e = idx[id] || freshIndexEntry(convAgentUrl(id));
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
  else appendMessage({ senderId: rec.senderId, senderName: rec.senderName, text: rec.text, timestamp: rec.timestamp, replyTo: rec.replyTo || (rec.page ? { page: rec.page } : null), read: RoomCore.isReadRecord(rec) });
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

// §2.6: every conversation on `from` (stored, and this panel's open ones) rebound to `to`.
async function rebindConversations(from, to) {
  await convStore.rebindAgent(from, to);
  for (const conv of convs.values()) if (conv.agentUrl === from) { conv.agentUrl = to; delete conv.sessions[from]; }
  for (const [id, e] of Object.entries(convIndex)) if (e && e.agentUrl === from) convIndex[id] = { ...e, agentUrl: to };
}

// agent-per-conversation §2.6: rebind this device's conversations for every URL edit since the
// agents list it last bound against (agents:seen) — a Settings edit here, or one synced from
// another device — then remember the list. A failed rebind leaves agents:seen as it was, so the
// next run finds the same edit again (rebinding is idempotent). → the edits applied.
async function reconcileAgents() {
  let seen = null;
  try { seen = (await chrome.storage.local.get(ConvCore.AGENTS_SEEN_KEY))[ConvCore.AGENTS_SEEN_KEY]; } catch (_) { /* none */ }
  const edits = Array.isArray(seen) ? ConvCore.agentUrlEdits(seen, agents) : [];
  for (const { from, to } of edits) {
    try { await rebindConversations(from, to); }
    catch (e) { console.warn("katashiro: rebinding conversations to an edited agent URL failed (retried on the next load):", e); return []; }
  }
  try { await chrome.storage.local.set({ [ConvCore.AGENTS_SEEN_KEY]: agents.map((a) => ({ name: a.name || "", url: a.url })) }); } catch (_) { /* next run */ }
  return edits;
}

// Load this window's conversations (§3.2, §3.6, §3.7). Runs BEFORE the room is built so each conn
// seeds the sessions from conv:<id> (→ session/resume restores the same conversation) and the
// restored messages sit above the reconnect notices.
async function loadConversations() {
  const win = await currentWindow();
  panelWindowId = win.id;
  // §3.2: AWAIT the migration (never ifAvailable), so a panel never builds from a half-migrated state.
  try { await convStore.migrate(); } catch (e) { console.warn("katashiro: conversation migration failed (retried on the next load):", e); }
  // agent-per-conversation §2.2: bind every conversation without an agent to the old active one
  // (activeAgentUrl is read, never deleted, §2.1); then §2.6: URL edits since this device last bound.
  try { await convStore.migrateAgents(RoomCore.resolveActiveUrl(agents, legacyActiveAgentUrl)); } catch (e) { console.warn("katashiro: binding conversations to agents failed (retried on the next load):", e); }
  await reconcileAgents();
  // §7.1: a delete cut short (gallery tab closed, browser quit) is finished here. Not awaited: its
  // conversation is in no window record any more, so nothing below depends on it.
  convStore.finishDeletions().catch((e) => console.warn("katashiro: finishing a conversation delete failed (retried on the next load):", e));
  const wid = String(win.id);
  const out = await withWindowsLock(async () => {
    const [windows, index, live] = await Promise.all([convStore.readWindows(), convStore.readIndex(), liveWindowIds()]);
    const own = windows[wid];
    // §3.7: a window with no record adopts the most recently used orphan record (browser restart);
    // old orphan records are pruned and their conversations archived.
    // An empty conversation (no messages, no canvases) is not adopted and takes no slot: there is
    // nothing to come back to, and with several agents a new conversation starts at the agent
    // picker instead (Brett 2026-10-16, agent-per-conversation §7 I3). The adopted record's empty
    // ones are archived with the rest, which deletes them. Read only when this window may adopt.
    const skip = new Set();
    if (!own) {
      const orphanIds = [...new Set(Object.entries(windows).filter(([w]) => w !== wid && !live.has(String(w)))
        .flatMap(([, rec]) => (Array.isArray(rec && rec.open) ? rec.open : []).filter(ConvCore.isConvId)))];
      if (orphanIds.length) {
        const got = await chrome.storage.local.get([...orphanIds.map(ConvCore.convKey), ...orphanIds.map(ConvCore.canvasIndexKey)]);
        for (const id of orphanIds) if (ConvCore.isEmptyConversation(got[ConvCore.convKey(id)], got[ConvCore.canvasIndexKey(id)])) skip.add(id);
      }
    }
    const plan = ConvCore.planAdoption({ ownWindowId: wid, windows, liveIds: live, index, now: Date.now(), skip });
    const wanted = own
      ? { open: (Array.isArray(own.open) ? own.open : []).filter(ConvCore.isConvId), current: own.current }
      : { open: plan.take, current: plan.current };
    // §3.6: drop every id whose lock another window took while this panel was closed.
    const open = [];
    const elsewhere = [];
    for (const id of wanted.open) ((await holdConvLock(id)) ? open : elsewhere).push(id);
    let current = open.includes(wanted.current) ? wanted.current : (open[0] || null);
    let full = false;
    let pick = false;
    if (!open.length) {
      windows[wid] = { open: [] };
      // Nothing to open: a new conversation — unless 3 are open elsewhere (§3.3: the picker), or
      // there are several agents to choose from (agent-per-conversation §2.4: the agent picker).
      if (ConvCore.liveOpenIds(windows, live).size >= ConvCore.MAX_OPEN) full = true;
      else if (agents.length > 1) pick = true;
      else {
        const id = newConversationId();
        if (await holdConvLock(id)) {
          await convStore.updateIndex((idx) => { idx[id] = freshIndexEntry(agents[0].url); return idx; });
          open.push(id);
          current = id;
        }
      }
    }
    // Write this window's record BEFORE dropping the adopted one: closing the panel in between
    // must leave the conversations in a record, not in none.
    windowRec = { open, current };
    await writeWindowRec();
    // §7 I3: the empty conversations of the other orphan records (not adopted, not pruned) leave
    // those records and are archived (= deleted) too, so none lingers as a "closed window" row.
    const leftEmpty = [];
    const emptyWrites = {};
    const liveNow = ConvCore.liveOpenIds(windows, live);   // never one open in a live window (as plan.archive; review #159)
    if (skip.size) {
      for (const [w, rec] of Object.entries(windows)) {
        if (w === wid || live.has(String(w)) || w === plan.adopt || plan.prune.includes(w)) continue;
        const ids = (Array.isArray(rec && rec.open) ? rec.open : []).filter((id) => skip.has(id) && !liveNow.has(id));
        if (!ids.length) continue;
        leftEmpty.push(...ids);
        emptyWrites[ConvCore.windowKey(w)] = { ...ids.reduce((r, id) => ConvCore.withClosed(r, id), rec), savedAt: rec.savedAt || 0 };
      }
    }
    if (Object.keys(emptyWrites).length) await chrome.storage.local.set(emptyWrites);
    if (plan.archive.length || leftEmpty.length) await convStore.archiveIds([...plan.archive, ...leftEmpty]);
    const drop = [...plan.prune, ...(plan.adopt !== null && !own ? [plan.adopt] : [])].map(ConvCore.windowKey);
    if (drop.length) await chrome.storage.local.remove(drop);
    // P1b §4.4: conversations adopted from an orphan record (a browser restart) are "coming back".
    const adopted = !own && plan.adopt !== null ? open.filter((id) => plan.take.includes(id)) : [];
    return { elsewhere, full, pick, adopted };
  });
  convIndex = await convStore.readIndex();
  const got = windowRec.open.length ? await chrome.storage.local.get(windowRec.open.map(ConvCore.convKey)) : {};
  for (const id of windowRec.open) convs.set(id, makeConv(id, got[ConvCore.convKey(id)]));
  if (windowRec.current) showConversation(windowRec.current);
  else showLobby();
  renderConvTabs();
  for (const id of out.elsewhere) noticeOpenElsewhere(id);
  if (out.full) startNewConversation();
  else if (out.pick) showAgentPicker();
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
  scheduleSelAsk();                                      // a 💬 on the old conversation's selection goes
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
  // A reply chip quotes a message of the conversation it was set in (a page target: was set for).
  if (replyTarget && (replyTarget.page ? replyTarget.convId !== id : !String(replyTarget.id || "").startsWith(`${id}:`))) setReplyTarget(null);
  if (switching) { closeCmdMenu(); clearComposerHint(); restoreDraft(conv); }
  if (convAgentMissing(id)) noteAgentMissing(conv); else conv.missingNoted = false;
  afterShow();
  updateSendEnabled();
}

// agent-per-conversation §2.6: a conversation whose agent was removed says so once, when shown (not
// recorded: regenerated, like other notices).
function noteAgentMissing(conv) {
  if (!conv || !convAgentMissing(conv.id) || conv.missingNoted) return;
  conv.missingNoted = true;
  appendSystemMessage(ConvCore.AGENT_REMOVED_TEXT, conv);
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

// The on-screen conversation's agent resumes (or creates) its session if it has not been on this
// socket yet; otherwise its queue is flushed (§3.5 steps). Conn.cur is null for every other agent.
function activateSessions() {
  room.forEach((c) => {
    if (c.enabled && c.cur) c.openSession(c.cur);
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

// ＋ (agent-per-conversation §2.4, Q3): with several agents, first the agent picker — every time;
// one agent → straight on. Then newConversation (which asks what to archive when 3 are open).
function startNewConversation() {
  if (agents.length <= 1) return newConversation(agents[0] && agents[0].url);
  if (!currentConv) showLobby();
  showAgentPicker();
  return Promise.resolve(false);
}

// ＋ (§3.3): a new, empty conversation bound to `agentUrl` (for its whole life, Q1), switched to.
// With 3 open in any window, first the archive picker.
async function newConversation(agentUrl) {
  if (!agentUrl || !agents.some((a) => a.url === agentUrl)) return false;
  const r = await withWindowsLock(async () => {
    const [windows, live] = await Promise.all([convStore.readWindows(), liveWindowIds()]);
    windows[String(panelWindowId)] = windowRec;
    if (ConvCore.liveOpenIds(windows, live).size >= ConvCore.MAX_OPEN) return { full: true };
    const id = newConversationId();
    if (!(await holdConvLock(id))) return {};
    const entry = freshIndexEntry(agentUrl);
    await convStore.updateIndex((idx) => { idx[id] = entry; return idx; });
    windowRec = ConvCore.withOpened(windowRec, id);
    await writeWindowRec();
    return { id, entry };
  });
  if (r.full) { showArchivePicker(() => newConversation(agentUrl)); return false; }
  if (!r.id) return false;
  if (currentConv) writeIndexTime(currentConv);
  convIndex[r.id] = r.entry;
  convs.set(r.id, makeConv(r.id, { agentUrl }));
  const prev = conversationId;
  showConversation(r.id);
  syncConnections();                                     // §2.3: its agent connects if it was not
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
  // §2.3: its agent's last open conversation → disconnect. Except with one agent, when closing the
  // last tab opens a new one on that same agent: connections are synced after it, so the socket
  // stays up (§4: nothing changes for a single-agent user). With several, the picker comes first.
  const reopensOnSame = wasCurrent && !(windowRec.current && convs.has(windowRec.current)) && agents.length <= 1;
  if (!reopensOnSame) syncConnections();
  if (wasCurrent) {
    currentConv = null;
    conversationId = null;
    if (windowRec.current && convs.has(windowRec.current)) { showConversation(windowRec.current); activateSessions(); applyGroupSwitch(); }
    else await startNewConversation();
  }
  if (reopensOnSame) syncConnections();
  renderConvTabs();
  // §4.5: close its group's tabs (no longer tracked: it left `convs` above). After the switch, so
  // what was kept open is said in the conversation now on screen.
  if (gid != null) await canvasTabQueue(() => closeConversationTabs(gid, title), id).catch((e) => console.warn("katashiro: closing an archived conversation's tabs failed:", e));
  return { ok: true };
}

// Reopen (§3.4, from the gallery's 對話 section): take the lock, move it out of a closed window's
// record if it is in one, clear archivedAt, add it to this window and switch to it.
// `adopt` (§7.2): called once the conversation is open here and its group's tabs are back — the
// canvas tab that asked joins the group then (not before: restoreGroupTabs would make a second one).
async function reopenConversation(id, { adopt } = {}) {
  if (convs.has(id)) { switchConversation(id); if (adopt) adopt(); return { ok: true }; }
  const r = await withWindowsLock(async () => {
    const [windows, live, index] = await Promise.all([convStore.readWindows(), liveWindowIds(), convStore.readIndex()]);
    // §7.1: deleted (or being deleted) — never recreated as an empty conversation by a stale gallery tab.
    const gone = ConvCore.reopenRefusal(index[id]);
    if (gone) return { gone };
    const wid = String(panelWindowId);
    windows[wid] = windowRec;
    const holder = ConvCore.windowHolding(windows, live, id);
    if (holder !== null && holder !== wid && live.has(holder)) return { elsewhere: true, holder };
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
  if (r.elsewhere) {
    noticeOpenElsewhere(id);
    // The window that has it, so a canvas tab or the gallery can offer to go there (§7.2).
    const windowId = /^\d+$/.test(String(r.holder)) ? Number(r.holder) : null;
    return { ok: false, error: ConvCore.OPEN_ELSEWHERE_TEXT, windowId };
  }
  const got = await chrome.storage.local.get([ConvCore.convKey(id), ConvCore.INDEX_KEY]);
  if (got[ConvCore.INDEX_KEY]) adoptIndex(got[ConvCore.INDEX_KEY]);
  if (currentConv) writeIndexTime(currentConv);
  convs.set(id, makeConv(id, got[ConvCore.convKey(id)]));
  const prev = conversationId;
  showConversation(id);
  syncConnections();                                     // §2.3: its agent connects if it was not
  activateSessions();
  // §4.4: it comes back with its group's tabs; then §4.2 (and Q12 for the one left).
  restoreGroupTabs(id).catch((e) => console.warn("katashiro: reopening a conversation's tabs failed:", e))
    .then(() => adopt && adopt()).then(() => afterLeaving(prev));
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
// The pickers (archive, agent) sit in a dock above the input, not in a conversation's list: a
// switch must not hide a picker that is still open, or a second ＋ would seem to do nothing
// (Brett 2026-10-16, agent-per-conversation §6).
function dockPicker(row) {
  pickerDock.appendChild(row);
  pickerDock.hidden = false;
  row.scrollIntoView({ block: "nearest" });
}
function undockPicker(row) {
  row.remove();
  pickerDock.hidden = !pickerDock.children.length;
}
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
  row.className = "picker-row";
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
  const close = () => { undockPicker(row); pickerCard = null; pickerThen = null; };
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
  dockPicker(row);
}

// The agent picker (agent-per-conversation §2.4, Q3): which agent a new conversation is with — for
// its whole life (Q1). A system card like the archive picker; one at a time. Each agent shows its
// link state if this window is connected to it, 未使用 otherwise (§7 I1; not probed just for this). The
// archive picker, if 3 are open, comes after the pick (newConversation).
let agentPickerCard = null;
function showAgentPicker() {
  if (agentPickerCard) { agentPickerCard.scrollIntoView({ block: "nearest" }); return; }
  const row = document.createElement("div");
  agentPickerCard = row;
  row.className = "picker-row";
  const card = document.createElement("div");
  card.className = "conv-picker agent-picker";
  card.setAttribute("role", "group");
  const head = document.createElement("div");
  head.className = "conv-picker-head";
  head.textContent = "新對話要跟哪個 agent 聊？";
  const hint = document.createElement("div");
  hint.className = "conv-picker-hint";
  hint.textContent = "選了之後這段對話就固定是這個 agent；要跟別的 agent 聊就再開一段。";
  const list = document.createElement("div");
  list.className = "conv-picker-list";
  const close = () => { undockPicker(row); agentPickerCard = null; };
  agents.forEach((a) => {
    const c = room.find((x) => x.agent.url === a.url);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "conv-picker-option";
    b.textContent = `${a.name || "Agent"}（${c && c.enabled ? `🔌 ${connState(c).label}` : "未使用"}）`;
    b.title = a.url;
    b.addEventListener("click", () => { close(); newConversation(a.url); });
    list.appendChild(b);
  });
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "conv-picker-cancel";
  cancel.textContent = "取消";
  cancel.addEventListener("click", () => {
    close();
    if (!currentConv) appendSystemMessage("目前沒有開著的對話：按上方 ＋ 開一段新對話。");
  });
  card.append(head, hint, list, cancel);
  row.appendChild(card);
  dockPicker(row);
}

// The panel has no conversation and the user cancelled the picker: say where the 3 are.
function noticeAllOpenElsewhere(ids) {
  appendSystemActions(`已經有 ${ConvCore.MAX_OPEN} 段對話開在其他視窗。`, [
    ...ids.map((id) => ({ label: `前往「${ConvCore.displayTitle(convIndex[id], id)}」`, onClick: () => focusConversationWindow(id) })),
    { label: "封存一段，開新對話", onClick: () => startNewConversation() },
  ]);
}

// A sender that is one of Katashiro's own pages (`path`, e.g. "/canvas-gallery.html").
function fromOwnPage(sender, path) {
  try {
    const u = new URL(sender && sender.url);
    return sender.id === chrome.runtime.id && u.origin === new URL(chrome.runtime.getURL("")).origin && u.pathname === path;
  } catch (_) { return false; }
}

// 重新打開 in the gallery (§3.4), and 🗨️ 對話 in a canvas tab or a gallery canvas row (§7.2):
// accepted only from canvas-gallery.html and canvas.html, answered by the panel of the sender's
// window. A sender that found no panel opened one and left the request in storage.session; the
// panel picks it up on load (pickUpReopenRequest). reqId dedupes the two. `canvasId` (a canvas
// tab): the conversation must be that canvas's — a canvas tab opens its own conversation, no other —
// and the canvas tab joins the conversation's group if it is in none (opened ungrouped from the
// gallery while the conversation was archived, canvas §3.7).
const handledReopens = new Set();
async function canvasOfConversation(canvasId, id) {
  if (!CanvasStore.ID_RE.test(String(canvasId))) return false;
  const k = CanvasStore.metaKey(canvasId);
  const meta = (await chrome.storage.local.get(k))[k];
  return !!meta && meta.conversationId === id;
}
async function adoptCanvasTab(canvasId, id) {
  try {
    const tab = await findCanvasTab(canvasId);
    if (!tab || tab.windowId !== panelWindowId || CanvasTabs.groupOf(tab) !== CanvasTabs.TAB_GROUP_NONE) return;
    await canvasTabQueue(() => addToCanvasGroup(tab, id), id);
  } catch (_) { /* grouping is cosmetic */ }
}
async function handleReopen(id, reqId, canvasId = null) {
  if (reqId) {
    if (handledReopens.has(reqId)) return { ok: true };
    handledReopens.add(reqId);
    const k = `${ConvCore.REOPEN_KEY_PREFIX}${panelWindowId}`;
    try {
      const got = await chrome.storage.session.get(k);
      if (got[k] && got[k].reqId === reqId) await chrome.storage.session.remove(k);
    } catch (_) { /* no storage.session */ }
  }
  if (canvasId == null) return reopenConversation(id);
  if (!(await canvasOfConversation(canvasId, id))) return { ok: false, error: "這個畫布不屬於那段對話" };
  return reopenConversation(id, { adopt: () => adoptCanvasTab(canvasId, id) });
}
async function pickUpReopenRequest() {
  const k = `${ConvCore.REOPEN_KEY_PREFIX}${panelWindowId}`;
  let r = null;
  try { r = (await chrome.storage.session.get(k))[k]; } catch (_) { return; }
  if (!r) return;
  try { await chrome.storage.session.remove(k); } catch (_) { /* best effort */ }
  if (ConvCore.isConvId(r.id) && Date.now() - Number(r.at || 0) < 60 * 1000) handleReopen(r.id, r.reqId || null, r.canvasId == null ? null : String(r.canvasId));
}

// --- tab strip (§3.3) ---------------------------------------------------------------------------
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
  plus.addEventListener("click", () => startNewConversation());
  convTabsEl.replaceChildren(...tabs, plus);
}

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
