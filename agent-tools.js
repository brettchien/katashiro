// agent-tools.js — pure mapping of the agent's own tool-call progress (ACP `session/update`
// kinds `tool_call` / `tool_call_update`, forwarded by the OpenAB gateway) to tool-strip pills.
//
// NO DOM here — sidepanel.js owns rendering; this module only decides what a pill should say.
// Dual target like room-core.js: a classic <script> in sidepanel.html (globalThis.AgentTools)
// and require()'d by the node --test suite (module.exports).
//
// Masking is deliberately NOT done here: the gateway owns redaction of tool titles before they
// reach any ACP client (owner decision). This side only truncates for layout.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod; // node (test)
  else root.AgentTools = mod; // extension global
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const LABEL_MAX = 40;
  const TITLE_MAX = 500;    // tooltip cap — a heredoc Bash command can run to kilobytes

  // ACP tool-call status → pill state (shared with the browser-tool pills' classes).
  const STATE_OF = { pending: "running", in_progress: "running", completed: "done", failed: "error" };
  const ICON_OF = { running: "⏳", done: "✓", error: "✗", stopped: "⏹" };

  function cleanTitle(t) {
    return typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "";
  }

  // Cut by code point, not UTF-16 unit, so an emoji is never split into a lone surrogate.
  function clipChars(s, max) {
    const cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max - 1).join("") + "…" : s;
  }
  const labelOf = (title) => clipChars(title, LABEL_MAX);

  // A katashiro browser tool reaching us as the agent's MCP call: the browser pill already
  // shows it (with details), so a second, agent-tool pill would double it. Matched on the MCP
  // tool name shape only — never a free substring, so a Bash command that merely mentions
  // "katashiro" (`cd katashiro && …`) still gets its pill.
  const BROWSER_TOOL_RE = /^(?:mcp__[^\s]*?katashiro[^\s]*?__|katashiro[._])\w/i;
  function isBrowserToolCall(update) {
    const u = update || {};
    const meta = u._meta && u._meta.claudeCode;
    const names = [cleanTitle(u.title), meta && typeof meta.toolName === "string" ? meta.toolName : ""];
    return names.some((n) => BROWSER_TOOL_RE.test(n));
  }

  /**
   * Fold one `session/update` into the pill it targets.
   *
   * @param {{id: string, title: string, label: string, state: string}|null} prev
   *   the pill already shown for this toolCallId in the current turn, or null
   * @param {object} update  `params.update` from the notification
   * @returns {{id: string, title: string, label: string, state: string, icon: string}|null}
   *   the pill's next state, or null when the update should be ignored (not a tool-call kind,
   *   no toolCallId, an update for a call we never saw that carries no title to show, or one of
   *   katashiro's own browser tools — see isBrowserToolCall).
   */
  function applyToolCallUpdate(prev, update) {
    const u = update || {};
    const kind = u.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") return null;
    const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
    if (!id) return null;
    if (isBrowserToolCall(u)) return null;
    const title = cleanTitle(u.title);
    // An update for an unknown call can only render if it brings a title of its own.
    if (!prev && kind === "tool_call_update" && !title) return null;

    // A later title refines the placeholder ("Terminal" → "cargo test"); no title keeps the old.
    const nextTitle = clipChars(title, TITLE_MAX) || (prev && prev.title) || "tool";
    // Unknown / absent status keeps the previous state; a fresh call starts as running.
    const state = STATE_OF[u.status] || (prev && prev.state) || "running";
    return { id, title: nextTitle, label: labelOf(nextTitle), state, icon: ICON_OF[state] };
  }

  return { applyToolCallUpdate, isBrowserToolCall, ICON_OF, LABEL_MAX, TITLE_MAX };
});
