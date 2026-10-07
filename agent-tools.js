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

  // ACP tool-call status → pill state (shared with the browser-tool pills' classes).
  const STATE_OF = { pending: "running", in_progress: "running", completed: "done", failed: "error" };
  const ICON_OF = { running: "⏳", done: "✓", error: "✗" };

  function cleanTitle(t) {
    return typeof t === "string" ? t.replace(/\s+/g, " ").trim() : "";
  }

  function labelOf(title) {
    return title.length > LABEL_MAX ? title.slice(0, LABEL_MAX - 1) + "…" : title;
  }

  /**
   * Fold one `session/update` into the pill it targets.
   *
   * @param {{id: string, title: string, label: string, state: string}|null} prev
   *   the pill already shown for this toolCallId in the current turn, or null
   * @param {object} update  `params.update` from the notification
   * @returns {{id: string, title: string, label: string, state: string, icon: string}|null}
   *   the pill's next state, or null when the update should be ignored (not a tool-call kind,
   *   no toolCallId, or an update for a call we never saw that carries no title to show).
   */
  function applyToolCallUpdate(prev, update) {
    const u = update || {};
    const kind = u.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") return null;
    const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
    if (!id) return null;
    const title = cleanTitle(u.title);
    // An update for an unknown call can only render if it brings a title of its own.
    if (!prev && kind === "tool_call_update" && !title) return null;

    // A later title refines the placeholder ("Terminal" → "cargo test"); no title keeps the old.
    const nextTitle = title || (prev && prev.title) || "tool";
    // Unknown / absent status keeps the previous state; a fresh call starts as running.
    const state = STATE_OF[u.status] || (prev && prev.state) || "running";
    return { id, title: nextTitle, label: labelOf(nextTitle), state, icon: ICON_OF[state] };
  }

  return { applyToolCallUpdate, LABEL_MAX };
});
