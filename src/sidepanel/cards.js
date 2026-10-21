// Katashiro side panel — chat cards: the 🔒 confirm card (#80), the ask_user card, and the ⚡
// command menu with its commands and command cards. Moved verbatim out of sidepanel.js (plan B,
// step 1); no logic change.
//
// Classic script, loaded by sidepanel.html after conn.js, conversations.js, composer-ui.js and
// canvas-glue.js and BEFORE sidepanel.js; all scripts share one global scope. Load-order rule: this
// file holds declarations only. Its top level must not run anything that touches a name declared in
// sidepanel.js (DOM refs, room state, …) — that would be a TDZ ReferenceError at load. Function
// bodies may use names from any file, sidepanel.js included: they only run once every script has
// loaded. The wiring that runs at load (the ⚡ button and outside-click listeners, the ask card's
// visibilitychange listener) stays in sidepanel.js, at the spot these sections came from, as do the
// sending / canvas-message code that sat in the command section (its sendMessage / afterPageSend
// later moved to composer-ui.js) and the notifications + message ids that sat at the end of the ask
// section (not cards).

// --- ⚡ command menu and commands (command-core.js) ------------------------------------------------
// Cancel / Reset session / Switch model. Opened by ⚡ (the slot ⏹ takes while a reply runs), by
// Ctrl/⌘+/, or by typing "/" first in the composer (then letters filter). A command never goes
// through the prompt queue or gets the [time user] header: Cancel is session/cancel; Reset and
// Switch model send the bare gateway command as their own prompt (Conn.runRawCommand) and turn the
// gateway's plain-text answer into a Katashiro card or a muted system line. Commands, their cards
// and results are not recorded in the conversation's history (like system notices): they vanish on
// reload, and chat_history never shows them.

const onScreenReplying = () => !!(conversationId && convReplying(conversationId));

function showComposerHint(text) {
  composerHint.textContent = text;
  composerHint.hidden = !text;
}
function clearComposerHint() {
  if (composerHint.hidden) return;
  composerHint.hidden = true;
  composerHint.textContent = "";
}

// `keep`: the entry to keep selected if it is still listed (a refresh while the user moves through it).
function openCmdMenu(via, query = "", keep = null) {
  const replying = onScreenReplying();
  const items = CommandCore.menuItems({ replying, query });
  if (!items.length) { closeCmdMenu(); return; }
  clearComposerHint();
  const kept = keep ? items.findIndex((c) => c.id === keep) : -1;
  cmdMenuState = { via, query, items, replying, selected: kept >= 0 ? kept : 0 };   // replying: Cancel is first, so pre-selected
  renderCmdMenu();
}

function closeCmdMenu() {
  cmdMenuState = null;
  cmdMenu.hidden = true;
  cmdMenu.replaceChildren();
  cmdBtn.setAttribute("aria-expanded", "false");
}

function renderCmdMenu() {
  const m = cmdMenuState;
  cmdMenu.replaceChildren(...m.items.map((c, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cmd-item${i === m.selected ? " selected" : ""}`;
    b.dataset.cmd = c.id;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", String(i === m.selected));
    const label = document.createElement("span");
    label.className = "cmd-item-label";
    label.textContent = c.label;
    const desc = document.createElement("span");
    desc.className = "cmd-item-desc";
    desc.textContent = c.desc;
    const key = document.createElement("span");
    key.className = "cmd-item-key";
    key.textContent = c.key;
    b.append(label, desc, key);
    b.addEventListener("mousedown", (e) => e.preventDefault());   // the composer keeps the focus
    b.addEventListener("click", () => runCmdMenuItem(c.id));
    return b;
  }));
  cmdMenu.hidden = false;
  cmdBtn.setAttribute("aria-expanded", "true");
}

// The reply started or ended while the menu is open: re-order it (Cancel first while replying).
function refreshCmdMenu() {
  const m = cmdMenuState;
  if (!m || m.replying === onScreenReplying()) return;
  openCmdMenu(m.via, m.query);
}

// A key in the composer while the menu is open; true if the menu took it.
function cmdMenuKey(e) {
  const m = cmdMenuState;
  const a = CommandCore.menuKey({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, via: m.via, items: m.items });
  if (a.type === "move") { m.selected = CommandCore.moveSelection(m.selected, a.delta, m.items.length); renderCmdMenu(); }
  else if (a.type === "close") closeCmdMenu();
  else if (a.type === "run") runCmdMenuItem(a.id || m.items[m.selected].id);
  else {
    // Opened by ⚡ / Ctrl+/: typing anything else closes it (the text is the user's draft). Opened
    // by typing "/": the input handler re-filters.
    if (m.via !== "typed" && e.key.length === 1 && !e.ctrlKey && !e.metaKey) closeCmdMenu();
    return false;
  }
  e.preventDefault();
  return true;
}

function runCmdMenuItem(id) {
  const typed = cmdMenuState && cmdMenuState.via === "typed";
  closeCmdMenu();
  // A command picked from a typed "/re" consumes that text; from ⚡ the draft stays.
  if (runCommand({ id }) && typed) clearComposer();
}

function clearComposer() {
  messageInput.value = "";
  messageInput.style.height = "auto";
  updateSendEnabled();
}

/**
 * Run a command ({ id } from CommandCore.parseCommand or the menu) for the conversation on screen.
 * → true if it started (the caller may clear a typed command), false if refused with a hint.
 */
function runCommand(cmd) {
  if (cmd.id === "cancel") {
    if (!onScreenReplying()) { showComposerHint(CommandCore.TEXT.nothingToStop); return false; }
    stopReplyOnScreen();
    return true;
  }
  const c = currentConv && !convAgentMissing(conversationId) ? connOfConv(conversationId) : null;
  const st = c && c.enabled ? c.stateFor(conversationId) : null;
  const why = CommandCore.blocker(cmd.id, {
    connected: !!(st && c.ws && c.ws.readyState === WebSocket.OPEN && c.initialized),
    replying: onScreenReplying(),
    staged: stagedImages.length + stagedFiles.length + stagingPending,
    quoted: !!replyTarget,
    running: !!(st && st.commandActive),
  });
  if (why) { showComposerHint(why); return false; }
  clearComposerHint();
  if (cmd.id === "reset") confirmReset(c, st);
  else if (cmd.id === "model") pickModel(c, st);
  else if (cmd.id === "model-set") setModel(c, st, cmd.arg);
  return true;
}

// Hold the session for a command: no queued turn starts until it is done; then the queue (messages
// typed meanwhile) flushes as usual.
async function withCommandHold(c, st, fn) {
  st.commandActive = true;
  try { return await fn(); } finally {
    st.commandActive = false;
    if (c.states.get(st.convId) === st) c.flushQueue(st);
  }
}

async function waitTurnEnd(st, ms = 15000) {
  const end = Date.now() + ms;
  while (st.turnActive) {
    if (Date.now() > end) throw new Error("the reply did not stop");
    await new Promise((r) => setTimeout(r, 50));
  }
}

const errText = (err) => String((err && err.message) || err);

// The command as sent (muted, on the user's side). Not recorded, like system notices.
function appendCommandEcho(text, conv) {
  const list = conv ? conv.listEl : outList();
  if (!list) return;
  const row = document.createElement("div");
  row.className = "message command";
  const inner = document.createElement("div");
  inner.className = "command-text";
  inner.textContent = text;
  row.appendChild(inner);
  list.appendChild(row);
  if (list === chatList) maybeScroll();
}

// A Katashiro card for a command (the ask card's look, grey and ⚡: Katashiro's own, not the agent's).
// `onPick(i)` → Promise<string | null>: the result line, or null to leave the card open (refused
// with a hint). Closed unanswered when the user sends a message or opens another command card in
// that conversation. Memory-only, like ask and confirm cards.
const pendingCommandCards = new Map();                   // card element → { convId, close }
function commandCard({ conv, title, question, detail, options, onPick }) {
  for (const [, e] of [...pendingCommandCards]) if (e.convId === conv.id) e.close("Closed");
  const card = document.createElement("div");
  card.className = "ask-card command-card pending";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", title);
  const head = document.createElement("div");
  head.className = "ask-card-head";
  const icon = document.createElement("span");
  icon.className = "ask-card-icon";
  icon.textContent = "⚡";
  const name = document.createElement("span");
  name.className = "ask-card-title";
  name.textContent = `Katashiro · ${title}`;
  name.title = "Katashiro's own card, not a message from the agent";
  head.append(icon, name);
  const q = document.createElement("div");
  q.className = "ask-card-question";
  q.textContent = question;
  card.append(head, q);
  if (detail) {
    const d = document.createElement("div");
    d.className = "ask-card-hint";
    d.textContent = detail;
    card.appendChild(d);
  }
  const controls = document.createElement("div");
  controls.className = "ask-card-controls";
  const opts = document.createElement("div");
  opts.className = "ask-card-options";
  controls.appendChild(opts);
  const result = document.createElement("div");
  result.className = "ask-card-result";
  result.hidden = true;
  card.append(controls, result);
  const close = (text, answered = false) => {
    if (!pendingCommandCards.delete(card)) return;
    controls.remove();
    card.className = `ask-card command-card ${answered ? "answered" : "unanswered"}`;
    result.textContent = text;
    result.hidden = false;
  };
  const buttons = options.map((o, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ask-card-option${o.current ? " current" : ""}`;
    b.textContent = o.label;
    b.dataset.option = String(i);
    b.addEventListener("click", async () => {
      if (!pendingCommandCards.has(card)) return;
      for (const x of buttons) x.disabled = true;
      let text = null;
      try { text = await onPick(i); } catch (err) { text = errText(err); }
      if (text == null) { for (const x of buttons) x.disabled = false; return; }
      close(text, true);
    });
    opts.appendChild(b);
    return b;
  });
  pendingCommandCards.set(card, { convId: conv.id, close });
  const row = document.createElement("div");
  row.className = "message system";
  row.appendChild(card);
  if (conv.listEl) { conv.listEl.appendChild(row); if (conv.listEl === chatList) maybeScroll(); }
  return card;
}
function closeCommandCards(convId) {
  for (const [, e] of [...pendingCommandCards]) if (e.convId === convId) e.close("Closed");
}

// Reset session: a local confirm card; on yes, stop a running reply first, then the bare /reset.
function confirmReset(c, st) {
  const conv = convs.get(st.convId);
  if (!conv) return;
  commandCard({
    conv,
    title: "Reset session",
    question: "Clear the agent's memory of this conversation?",
    detail: `${c.name} starts a new session and forgets what was said here; the messages stay on screen.${st.turnActive ? " The reply in progress is stopped first." : ""}`,
    options: [{ label: "Reset session" }, { label: "Keep" }],
    onPick: async (i) => {
      if (i !== 0) return "Kept the session";
      if (st.commandActive) { showComposerHint(CommandCore.TEXT.commandRunning); return null; }
      try {
        const text = await withCommandHold(c, st, async () => {
          if (st.turnActive) { c.cancelTurn(st.convId); await waitTurnEnd(st); }
          appendCommandEcho(CommandCore.RESET_TEXT, conv);
          return CommandCore.replyText(await c.runRawCommand(st, CommandCore.RESET_TEXT), CommandCore.parseResetReply);
        });
        // The new session never asked this conversation's open questions: close them.
        if (CommandCore.parseResetReply(text)) closePendingAsks(c, "restart", st.convId);
        appendSystemMessage(CommandCore.resetMessage(text), conv);
        return "Reset session";
      } catch (err) {
        appendSystemMessage(`Reset failed: ${errText(err)}`, conv);
        return "Reset failed";
      }
    },
  });
}

// Switch model: the bare /models, its numbered list as a card (current ✅); a pick runs /model set N.
// A text that is not the list (no models yet on a fresh session, a format change) is shown as is.
async function pickModel(c, st) {
  const conv = convs.get(st.convId);
  if (!conv) return;
  appendCommandEcho(CommandCore.MODELS_TEXT, conv);
  let text;
  try {
    text = await withCommandHold(c, st, async () => CommandCore.replyText(await c.runRawCommand(st, CommandCore.MODELS_TEXT), CommandCore.parseModelList));
  } catch (err) {
    appendSystemMessage(`Switch model failed: ${errText(err)}`, conv);
    return;
  }
  const list = CommandCore.parseModelList(text);
  if (!list) { appendSystemMessage(text.trim() || CommandCore.TEXT.noReply, conv); return; }
  commandCard({
    conv,
    title: "Switch model",
    question: `Which model should ${c.name} use?`,
    options: list.options.map((o) => ({ label: `${ConfirmCore.plainText(o.name, 80)}${o.current ? " ✅" : ""}`, current: o.current })),
    onPick: async (i) => {
      const why = CommandCore.blocker("model-set", { connected: true, replying: st.turnActive, running: st.commandActive });
      if (why) { showComposerHint(why); return null; }
      return setModel(c, st, String(list.options[i].n));
    },
  });
}

// /model set <N|name>, bare; → the muted result line (also the card's result).
async function setModel(c, st, arg) {
  const conv = convs.get(st.convId);
  const wire = CommandCore.modelSetText(arg);
  if (conv) appendCommandEcho(wire, conv);
  let line;
  try {
    const text = await withCommandHold(c, st, async () => CommandCore.replyText(await c.runRawCommand(st, wire), CommandCore.parseSwitchReply));
    line = CommandCore.switchMessage(text);
  } catch (err) {
    line = `Switch model failed: ${errText(err)}`;
  }
  if (conv) appendSystemMessage(line, conv);
  return line;
}

// --- confirm card (#80) ---------------------------------------------------------------
// A yes/no question in the chat instead of window.confirm, which blocked the panel's main thread:
// every agent connection, heartbeat and tool call in the room froze until the user answered.
// Nothing here blocks, several cards can wait at once, and each one declines itself after
// ConfirmCore.TIMEOUT_MS (2 minutes) — or when the agent turn it was asked in ends. The text rules and the decision live in confirm-core.js.
// Every string goes in with textContent (agent text included), and the card is a "system" element:
// the 🔒 header and its border come from sidepanel.css on an element markdown cannot produce
// (html:false, and the card sits outside any .bubble), so an agent reply cannot imitate one.
// General on purpose (title / lines / labels / timeout). ask_user has its own card (below): an
// agent's question must not look like this one.
const pendingConfirms = new Map();                       // decision → the conversation it was asked in

/**
 * Ask the user on a card in the chat: in `conn`'s turn while it is in flight, else as its own row.
 * Asked for an agent (`conn`) whose turn has already ended: no card, declined at once
 * (ConfirmCore.shouldAsk) — only a small non-interactive note (`notAskedNote`) says what was dropped.
 * @param {{ title: string, lines?: string[], allowLabel?: string, denyLabel?: string, timeoutMs?: number }} spec
 * @returns {Promise<boolean>} true only if the user clicked allow; a timeout, a cleared chat, the
 *   end of `conn`'s turn, or a turn that had ended before asking is false
 */
function confirmCard(spec, opts) {
  return confirmOutcome(spec, opts).then((o) => o.ok);
}

/** confirmCard, resolving { ok, state } (state: allowed / denied / timeout / cancelled / ended / skipped). */
// `st`: the asking conversation's session state (P2 §5: the card goes into ITS turn, on screen or not);
// without one, the conversation on screen's state of `conn`.
function confirmOutcome(spec, { conn = null, st = null, notAskedNote = "" } = {}) {
  if (conn && !st) st = conn.cur;
  if (!ConfirmCore.shouldAsk({ forAgent: !!conn, turnActive: !!(st && st.turnActive) })) {
    if (notAskedNote) inConv(st ? convs.get(st.convId) : null, () => appendSystemMessage(notAskedNote));
    return Promise.resolve(ConfirmCore.NOT_ASKED);
  }
  const s = ConfirmCore.normalizeSpec(spec);
  const card = document.createElement("div");
  card.className = "confirm-card pending";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", s.title);
  const head = document.createElement("div");
  head.className = "confirm-card-head";
  const lockIcon = document.createElement("span");
  lockIcon.className = "confirm-card-lock";
  lockIcon.textContent = "🔒";
  lockIcon.title = "Katashiro 的確認，不是 agent 的訊息";
  const title = document.createElement("span");
  title.className = "confirm-card-title";
  title.textContent = s.title;
  head.append(lockIcon, title);
  card.appendChild(head);
  for (const line of s.lines) {
    const el = document.createElement("div");
    el.className = "confirm-card-line";
    el.textContent = line;
    card.appendChild(el);
  }
  const hint = document.createElement("div");
  hint.className = "confirm-card-hint";
  hint.textContent = ConfirmCore.timeoutHint(s);
  const actions = document.createElement("div");
  actions.className = "confirm-card-actions";
  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "confirm-card-deny";
  deny.textContent = s.denyLabel;
  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "confirm-card-allow";
  allow.textContent = s.allowLabel;
  actions.append(deny, allow);                           // no autofocus: a stray Enter must not answer
  const result = document.createElement("div");
  result.className = "confirm-card-result";
  result.hidden = true;
  card.append(hint, actions, result);

  // Asked in a turn: the card sits in that turn and declines when it ends (finalizeStream). P2 §5:
  // the turn may be in a conversation not on screen — ❓ on its tab and a notification (Q12); its
  // 2-minute clock is wall-clock (a 🔒 card holds the agent's tool call open, ≤ 170 s per call).
  if (conn && st && st.turnActive && (!st.stream || !st.stream.bubble)) conn.startStream(st);
  const turn = conn && st && st.turnActive ? st.stream : null;
  const askedIn = st ? st.convId : conversationId;

  // The card stays in the chat with the outcome; the buttons go, so a late click cannot act.
  const decision = ConfirmCore.createDecision({
    timeoutMs: s.timeoutMs,
    onSettle: (state) => {
      pendingConfirms.delete(decision);
      renderConvTabs();
      if (turn) turn.confirms.delete(decision);
      hint.remove();
      actions.remove();
      card.className = `confirm-card ${state === "allowed" ? "allowed" : "declined"}`;
      result.textContent = ConfirmCore.outcomeText(state, s);
      result.hidden = false;
    },
  });
  pendingConfirms.set(decision, askedIn);
  if (turn) (turn.confirms || (turn.confirms = new Set())).add(decision);
  allow.addEventListener("click", () => decision.allow());
  deny.addEventListener("click", () => decision.deny());

  inConv(convs.get(askedIn), () => {
    if (turn) {
      turn.contentEl.insertBefore(card, turn.bubble);
    } else {
      const row = document.createElement("div");
      row.className = "message system";
      row.appendChild(card);
      outList().appendChild(row);
    }
    maybeScroll();
  });
  if (askedIn !== conversationId && convs.has(askedIn)) { renderConvTabs(); notifyWaitingCard(askedIn); }
  return decision.outcome;
}

// Every card still waiting in conversation `convId` resolves as declined (its chat is being
// cleared, or it is archived); 🧹 cancels only the current conversation's (§3.8).
function cancelPendingConfirms(convId) {
  for (const [d, c] of [...pendingConfirms]) if (!convId || c === convId) d.cancel();
}

// --- ask card (katashiro.ask_user, ADR docs/adr/ask-user.md) -------------------------------------
// An agent's multiple-choice question. Unlike the confirm card it is the AGENT talking, not the
// system: no 🔒, its own border and accent (sidepanel.css), and a title the panel writes
// ("<agent> 問你"); the agent supplies only the question and labels, as plain text (AskCore).
// Asynchronous: the tool has already returned when the user answers, so the answer goes to the
// asking agent as a new prompt through its own queue (Conn.enqueue) — batched into its next turn if
// one is running. A card does not close when the turn ends; it closes on an answer, on a timeout that
// counts only visible time (Q1), when the user sends another message (Q4), when the chat is cleared,
// or when its agent is disconnected. Only an answer sends anything. The answer is data: it
// authorises nothing (destructive tools still ask on their own 🔒 card). Memory-only, like confirm cards.
const pendingAsks = new Map();                           // id → { ask, conn, state, conversationId }

// Multi-conversation §3.8 (ADR ask-user §2.3, Q1): is this card's conversation the one on screen?
// A switch calls refreshAskVisibility(), so a card in a hidden conversation does not count down.
function askConversationShown(entry) {
  return entry.conversationId === conversationId;
}

// Can the user see the card right now? Panel document visible, chat view (not Settings / setup)
// shown, and its conversation the current one. Scroll position is deliberately not part of it.
function askVisible(entry) {
  return document.visibilityState === "visible" && chatView.classList.contains("active") && askConversationShown(entry);
}

function refreshAskVisibility() {
  for (const e of pendingAsks.values()) e.ask.setVisible(askVisible(e));
}
// The 3-pending-card cap is per agent per conversation (ask-user §2.5, multi-conversation §3.8).
function pendingAsksOf(conn, convId) {
  let n = 0;
  for (const e of pendingAsks.values()) if (e.conn === conn && e.conversationId === convId) n++;
  return n;
}

// Show `spec` (already AskCore.normalizeSpec'd) as a card in `conn`'s in-flight turn of session
// state `st` (the asking conversation); returns its id.
function askCard(spec, conn, st = conn.cur) {
  let id;
  do { id = AskCore.newAskId((n) => crypto.getRandomValues(new Uint8Array(n))); } while (pendingAsks.has(id));
  const card = document.createElement("div");
  card.className = "ask-card pending";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `${conn.name} 問你`);
  const head = document.createElement("div");
  head.className = "ask-card-head";
  const icon = document.createElement("span");
  icon.className = "ask-card-icon";
  icon.textContent = "💬";
  const title = document.createElement("span");
  title.className = "ask-card-title";
  title.textContent = `${conn.name} 問你`;
  title.title = "agent 的提問：回答只會傳給它，不代表同意任何動作";
  head.append(icon, title);
  const question = document.createElement("div");
  question.className = "ask-card-question";
  question.textContent = spec.question;
  card.append(head, question);

  // Everything the user can act on sits in `controls`, removed as one when the card settles.
  const controls = document.createElement("div");
  controls.className = "ask-card-controls";
  const options = document.createElement("div");
  options.className = `ask-card-options${spec.multi ? " multi" : ""}`;
  controls.appendChild(options);
  let submit = () => {};
  if (spec.multi) {
    const boxes = spec.options.map((label) => {
      const row = document.createElement("label");
      row.className = "ask-card-check";
      const box = document.createElement("input");
      box.type = "checkbox";
      const text = document.createElement("span");
      text.textContent = label;
      row.append(box, text);
      options.appendChild(row);
      return box;
    });
    const send = document.createElement("button");
    send.type = "button";
    send.className = "ask-card-submit";
    send.textContent = "送出";
    send.disabled = true;
    options.addEventListener("change", () => { send.disabled = !boxes.some((b) => b.checked); });
    send.addEventListener("click", () => submit({ choices: boxes.flatMap((b, i) => (b.checked ? [i] : [])) }));
    controls.appendChild(send);
  } else {
    spec.options.forEach((label, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ask-card-option";
      b.textContent = label;
      b.addEventListener("click", () => submit({ choice: i }));
      options.appendChild(b);
    });
  }
  if (spec.allowOther) {
    const form = document.createElement("form");
    form.className = "ask-card-other";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = AskCore.OTHER_MAX;
    input.placeholder = "其他…";
    input.setAttribute("aria-label", "其他回答");
    const go = document.createElement("button");
    go.type = "submit";
    go.textContent = "送出";
    form.append(input, go);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (input.value.trim()) submit({ other: input.value });
    });
    controls.appendChild(form);
  }
  const hint = document.createElement("div");
  hint.className = "ask-card-hint";
  hint.textContent = AskCore.timeoutHint(spec);
  const result = document.createElement("div");
  result.className = "ask-card-result";
  result.hidden = true;
  card.append(controls, hint, result);

  // The entry keeps the session state, not just the Conn: the answer goes to the asking
  // conversation's session (§3.8), which stays true when P2 lets several run.
  const entry = { conn, state: st, conversationId: st ? st.convId : conversationId, ask: null };
  entry.ask = AskCore.createAsk({
    timeoutMs: spec.timeoutMs,
    onSettle: (state, answer) => {
      pendingAsks.delete(id);
      renderConvTabs();                                  // a ❓ on another conversation's tab may go (§4.7)
      controls.remove();
      hint.remove();
      card.className = `ask-card ${state === "answered" ? "answered" : "unanswered"}`;
      result.textContent = AskCore.outcomeText(state, answer);
      result.hidden = false;
    },
  });
  pendingAsks.set(id, entry);
  // The answer: settle first (a second click is a no-op), then send it to the asking agent only,
  // framed like any user message.
  submit = (raw) => {
    const answer = AskCore.normalizeAnswer(spec, raw);
    if (!answer || !entry.ask.answer(answer)) return;
    conn.enqueue(RoomCore.framePrompt({ timestamp: Date.now(), senderName: "user" }, AskCore.answerMessage(id, answer)), [], entry.state);
  };

  // Asked in the turn (AskCore.canAsk guarantees one): the card sits in it, above the reply. P2 §5:
  // that turn may be in a conversation not on screen — its clock waits (visible time only, Q1),
  // and ❓ on its tab plus a notification tell the user (Q12).
  if (!st.stream || !st.stream.bubble) conn.startStream(st);
  const turn = st.stream;
  turn.asked = true;                                     // finalizeStream keeps the row for the card
  turn.contentEl.insertBefore(card, turn.bubble);
  entry.ask.setVisible(askVisible(entry));
  conn.inState(st, maybeScroll);
  if (entry.conversationId !== conversationId) { renderConvTabs(); notifyWaitingCard(entry.conversationId); }
  return id;
}

// Close open ask cards unanswered (multi-conversation §3.8 scopes): `how` is supersede (another
// message in that conversation), cancel (that conversation's chat cleared), archive (that
// conversation archived), restart (one conversation's session could not be resumed: that
// conversation, that agent) or disconnect (the agent deliberately disconnected: its cards in EVERY
// conversation). A transient socket drop closes nothing. Nothing is sent to any agent.
function settlePendingAsks(how, { conn = null, convId = null } = {}) {
  for (const e of AskCore.selectToSettle([...pendingAsks.values()], { conn, convId })) e.ask[how]();
}
function supersedePendingAsks(convId) { settlePendingAsks("supersede", { convId }); }
function cancelPendingAsks(convId) { settlePendingAsks("cancel", { convId }); }
function closePendingAsks(conn, how = "disconnect", convId = null) { settlePendingAsks(how, { conn, convId }); }

// Q12 (multi-conversation §4.7): an ask or 🔒 confirm card still waiting in conversation `id`.
function hasWaitingCard(id) {
  for (const e of pendingAsks.values()) if (e.conversationId === id) return true;
  for (const c of pendingConfirms.values()) if (c === id) return true;
  return false;
}
