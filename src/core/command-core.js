// command-core.js — the pure half of the side panel's ⚡ command menu (Cancel / Reset session /
// Switch model) and of typed commands (`/cancel`, `/reset`, `/models`, `/model set <N|name>`).
//
// Why raw commands: the OpenAB gateway answers a slash command itself only when the prompt text is
// exactly the command (openab-core gateway.rs: `prompt.trim() == "/reset"`, handle_config_command).
// Every chat message Katashiro sends starts with a `[<ISO time> user]` header line, so a typed
// `/reset` reached the agent as ordinary text. A command is therefore sent as its own
// session/prompt with no header, outside the prompt queue, and its reply (plain text the gateway
// streams as one agent_message_chunk) is parsed here — never shown as an agent reply.
//
// The gateway's text formats are pinned by test/command-core.test.js against
// test/fixtures/openab-slash-replies.json: a change on the openab side fails a test instead of
// silently falling back to the raw text.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.CommandCore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The menu's three entries (Brett, 2026-10-22): no Help, no /help. `words` are what a typed
  // `/<prefix>` filters on; `key` runs it directly when the menu was opened by ⚡ or Ctrl/⌘+/.
  const COMMANDS = Object.freeze([
    Object.freeze({ id: "cancel", label: "Cancel", desc: "Stop the agent's reply", key: "c", words: Object.freeze(["cancel"]) }),
    Object.freeze({ id: "reset", label: "Reset session", desc: "The agent forgets this conversation", key: "r", words: Object.freeze(["reset"]) }),
    Object.freeze({ id: "model", label: "Switch model", desc: "Pick the model this agent uses", key: "m", words: Object.freeze(["model", "models", "switch"]) }),
  ]);
  const byId = (id) => COMMANDS.find((c) => c.id === id) || null;

  // What goes on the wire: exactly the command, nothing else (no header, no host line).
  const RESET_TEXT = "/reset";
  const MODELS_TEXT = "/models";
  const modelSetText = (arg) => `/model set ${String(arg).trim()}`;

  // Panel strings (English UI for the command feature, per Brett's brief).
  const TEXT = Object.freeze({
    // A leading space makes the text an ordinary message (parseCommand reads the raw text).
    noSuchCommand: "No such command — type / to see the commands, or start with a space to send it as text",
    nothingToStop: "Nothing to stop — the agent is not replying",
    notConnected: "Not connected to this conversation's agent",
    pendingAttachments: "Commands don't take attachments — send or remove them first",
    pendingQuote: "Commands don't take a ↩ quote — clear it first (Esc)",
    commandRunning: "Another command is still running",
    stopBeforeModel: "The agent is replying — stop it (⏹) before switching model",
    resetDone: "🔄 Session reset — the agent starts fresh; this chat stays on screen",
    resetNothing: "🔄 Session reset — there was no active session to clear",
    // The gateway's own buffer (cancel_buffered_thread) held messages that /reset dropped unsent.
    resetDropped: (n) => ` (the gateway dropped ${n} message${n === 1 ? "" : "s"} it was still holding)`,
    // Answers to the agent's ask cards still queued at a reset: the new session never asked them (#191 review d).
    askAnswersDropped: (n) => `${n} queued answer${n === 1 ? "" : "s"} to the agent's questions ${n === 1 ? "was" : "were"} not sent — the new session never asked ${n === 1 ? "it" : "them"}`,
    switched: (name) => `✅ Switched to ${name}`,
    noReply: "The gateway sent no reply",
  });

  /**
   * The menu's entries in order. While the agent is replying, Cancel comes first (and is the one
   * pre-selected, index 0); otherwise Reset session and Switch model lead and Cancel is last.
   * `query` (the text after a typed "/") keeps only the entries one of whose words starts with it.
   */
  function menuItems({ replying = false, query = "" } = {}) {
    const order = replying ? ["cancel", "reset", "model"] : ["reset", "model", "cancel"];
    const q = String(query || "").toLowerCase();
    return order.map(byId).filter((c) => !q || c.words.some((w) => w.startsWith(q)));
  }

  /**
   * The menu query of the composer's text when the menu is opened by typing: the text is "/" plus
   * letters only (no leading space, no second word) → the letters; anything else → null (the menu
   * closes, and Enter treats the text as a typed command or a message).
   */
  function menuQuery(text) {
    const m = /^\/([A-Za-z]*)$/.exec(String(text == null ? "" : text));
    return m ? m[1] : null;
  }

  /**
   * A key pressed in the composer while the menu is open → what to do.
   * `via`: "typed" (opened by typing "/": letters filter, so they pass through to the composer) or
   * "button" (⚡ or Ctrl/⌘+/: c / r / m run their command at once).
   * → { type: "move", delta } | { type: "run" } (the selected one) | { type: "run", id } |
   *   { type: "close" } | { type: "pass" } (let the composer have the key)
   */
  function menuKey({ key, ctrlKey = false, metaKey = false, altKey = false, via = "typed", items = COMMANDS } = {}) {
    if (key === "ArrowDown") return { type: "move", delta: 1 };
    if (key === "ArrowUp") return { type: "move", delta: -1 };
    if (key === "Enter" || key === "Tab") return { type: "run" };
    if (key === "Escape") return { type: "close" };
    if (via !== "typed" && !ctrlKey && !metaKey && !altKey && typeof key === "string" && key.length === 1) {
      const hit = items.find((c) => c.key === key.toLowerCase());
      if (hit) return { type: "run", id: hit.id };
    }
    return { type: "pass" };
  }

  /** The selected index after moving by `delta` among `count` entries (wraps). */
  function moveSelection(index, delta, count) {
    if (!(count > 0)) return 0;
    return (((index + delta) % count) + count) % count;
  }

  /**
   * Composer-wide shortcuts (the composer focused, menu open or not): Ctrl/⌘+/ opens the menu,
   * Ctrl/⌘+. stops the reply. Esc is deliberately NOT a stop key (it already clears the ↩ quote and
   * closes Settings). → "menu" | "stop" | null
   */
  function composerShortcut({ key, code, ctrlKey = false, metaKey = false, altKey = false } = {}) {
    if (!(ctrlKey || metaKey) || altKey) return null;
    if (key === "/" || code === "Slash") return "menu";
    if (key === "." || code === "Period") return "stop";
    return null;
  }

  /**
   * Is the composer's raw text (NOT trimmed — a leading space makes it a message) a command?
   * Detection: the first token is "/" + a letter. → null (send it as a message) |
   * { id: "cancel" | "reset" | "model" } | { id: "model-set", arg } | { id: "unknown", name }.
   * Anything starting like a command but not one of ours — /help, /agents, /compact, /tmp foo,
   * /etc/hosts — is "unknown": the panel keeps the text and says there is no such command.
   */
  function parseCommand(raw) {
    const s = String(raw == null ? "" : raw);
    if (!/^\/[A-Za-z]/.test(s)) return null;
    const parts = s.trim().split(/\s+/);
    const head = parts[0].toLowerCase();
    const rest = parts.slice(1);
    if (head === "/cancel" && !rest.length) return { id: "cancel" };
    if (head === "/reset" && !rest.length) return { id: "reset" };
    if (head === "/models" && !rest.length) return { id: "model" };
    if (head === "/model") {
      if (!rest.length || (rest.length === 1 && rest[0].toLowerCase() === "list")) return { id: "model" };
      if (rest[0].toLowerCase() === "set") {
        const arg = rest.slice(1).join(" ");
        return arg ? { id: "model-set", arg } : { id: "model" };
      }
    }
    return { id: "unknown", name: parts[0] };
  }

  /**
   * Why a command cannot run now (a hint for the composer), or null. Cancel never sends a prompt,
   * so attachments and a ↩ quote do not block it; it only has nothing to do when no reply runs.
   */
  function blocker(id, { connected = true, replying = false, staged = 0, quoted = false, running = false } = {}) {
    if (id === "unknown") return TEXT.noSuchCommand;
    if (id === "cancel") return replying ? null : TEXT.nothingToStop;
    if (staged > 0) return TEXT.pendingAttachments;
    if (quoted) return TEXT.pendingQuote;
    if (!connected) return TEXT.notConnected;
    if (running) return TEXT.commandRunning;
    if ((id === "model" || id === "model-set") && replying) return TEXT.stopBeforeModel;
    return null;                                         // reset while replying: stopped first, then reset
  }

  // --- the gateway's replies (openab-core gateway.rs) ---------------------------------------------

  const lines = (text) => String(text == null ? "" : text).replace(/\r\n?/g, "\n").split("\n");

  /**
   * `/models` (handle_config_command, action "list"):
   *   🔧 Available models:
   *     1. <name>
   *     2. <name> ✅
   *   (blank)
   *   Usage: /model set <number or name>
   * → { options: [{ n, name, current }], current: index | -1 }, or null when the text is anything
   * else (e.g. "⚠️ No model options available. Start a conversation first.") — the panel then shows
   * the gateway's text as it is.
   */
  function parseModelList(text) {
    const ls = lines(text);
    if (ls[0].trim() !== "🔧 Available models:") return null;
    const options = [];
    let i = 1;
    for (; i < ls.length; i++) {
      const m = /^ {2}(\d+)\. (.+?)( ✅)?$/.exec(ls[i]);
      if (!m) break;
      if (Number(m[1]) !== options.length + 1) return null;
      options.push({ n: Number(m[1]), name: m[2], current: !!m[3] });
    }
    if (!options.length) return null;
    const tail = ls.slice(i).map((l) => l.trim()).filter(Boolean);
    if (tail.length !== 1 || tail[0] !== "Usage: /model set <number or name>") return null;
    return { options, current: options.findIndex((o) => o.current) };
  }

  /** `/model set <N|name>` → { ok: true, name } for "✅ Switched to **<name>**", else null (show it raw). */
  function parseSwitchReply(text) {
    const m = /^✅ Switched to \*\*(.+)\*\*$/.exec(String(text == null ? "" : text).trim());
    return m ? { ok: true, name: m[1] } : null;
  }

  /**
   * `/reset` — the gateway's four answers (gateway.rs, `match (reset_session, dropped)`):
   *   "🔄 Session reset. Start a new conversation!"                          → { ok, none: false, dropped: 0 }
   *   "🔄 Session reset. Dropped N buffered message(s). Start a new conversation!" → { ok, none: false, dropped: N }
   *   "⚠️ No active session to reset."                                       → { ok, none: true, dropped: 0 }
   *   "🔄 Dropped N buffered message(s). No active session to reset."         → { ok, none: true, dropped: N }
   * `none`: there was no session — a fresh one is what the user asked for, so it still counts as ok.
   * Anything else → null (show it raw).
   */
  function parseResetReply(text) {
    const t = String(text == null ? "" : text).trim();
    let m = /^🔄 Session reset\. (?:Dropped (\d+) buffered message\(s\)\. )?Start a new conversation!$/.exec(t);
    if (m) return { ok: true, none: false, dropped: m[1] ? Number(m[1]) : 0 };
    if (t === "⚠️ No active session to reset.") return { ok: true, none: true, dropped: 0 };
    m = /^🔄 Dropped (\d+) buffered message\(s\)\. No active session to reset\.$/.exec(t);
    if (m) return { ok: true, none: true, dropped: Number(m[1]) };
    return null;
  }

  /**
   * The Reset session card's detail line, from the session's state NOW (the panel re-renders it while
   * the card waits — a reply that ends meanwhile drops its sentence, #179 review): `replying` the
   * conversation's turn is running, `queued` messages waiting in its prompt queue (they are sent after
   * the reset, to the new session — unlike the gateway's own /reset, which drops its buffer);
   * `answers` queued answers to the agent's ask cards (dropped at the reset, #191 review d).
   */
  function resetDetail(name, { replying = false, queued = 0, answers = 0 } = {}) {
    let s = `${name} starts a new session and forgets what was said here; the messages stay on screen.`;
    if (replying) s += " The reply in progress is stopped first.";
    if (queued > 0) s += ` ${queued} queued message${queued === 1 ? "" : "s"} will be sent to the new session.`;
    if (answers > 0) s += ` ${answers} queued answer${answers === 1 ? "" : "s"} to its questions will be dropped (the new session never asked ${answers === 1 ? "it" : "them"}).`;
    return s;
  }

  /**
   * What a session's prompt queue holds, for the Reset card (#191 review c): `messages` = queued
   * prompts with text that are not ask answers; `answers` = queued ask-card answers (`askAnswers`, a
   * Set of their exact texts). An empty string is not a message: it only carries images left over
   * from a turn that already went out (or an image-only retry of one), so it is not counted.
   */
  function queuedCounts(queue, askAnswers) {
    let messages = 0, answers = 0;
    for (const t of queue || []) {
      if (askAnswers && askAnswers.has(t)) answers++;
      else if (t) messages++;
    }
    return { messages, answers };
  }

  /** Split a prompt queue at a reset: `kept` (in order) and the number of ask answers `dropped`. */
  function withoutAskAnswers(queue, askAnswers) {
    const kept = [];
    let dropped = 0;
    for (const t of queue || []) {
      if (askAnswers && askAnswers.has(t)) dropped++;
      else kept.push(t);
    }
    return { kept, dropped };
  }

  /**
   * The reply text out of a command's chunks. The gateway answers in ONE chunk; a stray late chunk
   * of a reply that was just stopped can arrive first, so when the whole text does not parse
   * (`parse`) but the last chunk does, the last chunk is the gateway's answer.
   */
  function replyText(chunks, parse) {
    const list = Array.isArray(chunks) ? chunks.map((c) => String(c == null ? "" : c)) : [];
    const whole = list.join("");
    if (!parse || parse(whole) || !list.length) return whole;
    const last = list[list.length - 1];
    return parse(last) ? last : whole;
  }

  /** The muted system line for a /reset reply. */
  function resetMessage(text) {
    const r = parseResetReply(text);
    if (!r) return String(text || "").trim() || TEXT.noReply;
    return (r.none ? TEXT.resetNothing : TEXT.resetDone) + (r.dropped ? TEXT.resetDropped(r.dropped) : "");
  }

  /** The muted system line for a /model set reply. */
  function switchMessage(text) {
    const r = parseSwitchReply(text);
    if (!r) return String(text || "").trim() || TEXT.noReply;
    return TEXT.switched(r.name);
  }

  return {
    COMMANDS, TEXT, RESET_TEXT, MODELS_TEXT, modelSetText,
    menuItems, menuQuery, menuKey, moveSelection, composerShortcut, parseCommand, blocker,
    parseModelList, parseSwitchReply, parseResetReply, resetDetail, queuedCounts, withoutAskAnswers,
    replyText, resetMessage, switchMessage,
  };
});
