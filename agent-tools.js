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

  // Short, stable pill labels from the gateway's tool identity. Since openab#6 the gateway never
  // forwards the agent's free-text title (a command line could carry secrets): `title` is a
  // tool-name-shaped identity (core picks capability → name → kind, else "tool"), alongside
  // `kind` (ACP ToolKind), `name` and `_meta.openab.capability` — each re-checked gateway-side to
  // the shape `[A-Za-z0-9_.:/-]{1,128}`. The label takes the most specific one present:
  // capability > name > title > kind > "tool". An MCP name `mcp__server__tool` shows as
  // "server · tool". The first event often carries only `kind`, so a later, more specific update
  // upgrades the label — but never downgrades it.
  const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;
  function mcpLabel(name) {
    const m = MCP_NAME_RE.exec(name || "");
    return m ? `${m[1]} · ${m[2]}` : "";
  }
  const shortName = (n) => mcpLabel(n) || n;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  // { label, rank } for the most specific identity this update carries, or null.
  function identityOf(u) {
    const capability = str(u._meta && u._meta.openab && u._meta.openab.capability);
    if (capability) return { label: shortName(capability), rank: 4 };
    const name = str(u.name);
    if (name) return { label: shortName(name), rank: 3 };
    const title = cleanTitle(u.title);
    if (title && title !== "tool") return { label: shortName(title), rank: 2 };
    const kind = str(u.kind);
    if (kind) return { label: kind, rank: 1 };
    return title ? { label: title, rank: 0 } : null;
  }

  // A katashiro browser tool reaching us as the agent's MCP call: the browser pill already
  // shows it (with details), so a second, agent-tool pill would double it. Matched on the MCP
  // tool name shape only — never a free substring, so a Bash command that merely mentions
  // "katashiro" (`cd katashiro && …`) still gets its pill. Two shapes:
  //  - direct MCP: the tool name itself (`mcp__…katashiro…__click` / `katashiro.click`)
  //  - via the OAB MCP Facade: the tool is `…__execute_capability` and the real
  //    `katashiro.*` name rides in `_meta.openab.capability` (the OpenAB gateway since openab#6)
  //    or `rawInput.name` (a gateway that forwards the raw ACP update)
  // `name` / `_meta.claudeCode.toolName` are checked for the same reason: whichever the gateway sends.
  const BROWSER_TOOL_RE = /^(?:mcp__[^\s]*?katashiro[^\s]*?__|katashiro[._])\w/i;
  const BROWSER_CAPABILITY_RE = /^katashiro[._]\w/i;
  function isBrowserToolCall(update) {
    const u = update || {};
    const meta = u._meta && u._meta.claudeCode;
    const names = [cleanTitle(u.title), str(u.name), meta && typeof meta.toolName === "string" ? meta.toolName : ""];
    if (names.some((n) => BROWSER_TOOL_RE.test(n))) return true;
    if (BROWSER_CAPABILITY_RE.test(str(u._meta && u._meta.openab && u._meta.openab.capability))) return true;
    const capability = u.rawInput && typeof u.rawInput === "object" ? u.rawInput.name : null;
    return typeof capability === "string" && BROWSER_CAPABILITY_RE.test(capability);
  }

  /**
   * Fold one `session/update` into the pill it targets.
   *
   * @param {{id: string, title: string, label: string, labelRank: number, state: string}|null} prev
   *   the pill already shown for this toolCallId in the current turn, or null
   * @param {object} update  `params.update` from the notification
   * @param {Set<string>} [skipped]  this turn's toolCallIds already identified as katashiro
   *   browser tools. Later updates for them often carry only a title or status (no rawInput, so
   *   a Facade call no longer looks like one); remembering the id keeps them skipped.
   * @returns {{id: string, title: string, label: string, labelRank: number, state: string, icon: string}|null}
   *   the pill's next state, or null when the update should be ignored (not a tool-call kind,
   *   no toolCallId, an update for a call we never saw that carries no title to show, or one of
   *   katashiro's own browser tools — see isBrowserToolCall).
   */
  function applyToolCallUpdate(prev, update, skipped) {
    const u = update || {};
    const kind = u.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") return null;
    const id = typeof u.toolCallId === "string" ? u.toolCallId : "";
    if (!id) return null;
    if (skipped && skipped.has(id)) return null;
    if (isBrowserToolCall(u)) {
      if (skipped) skipped.add(id);
      return null;
    }
    const title = cleanTitle(u.title);
    const ident = identityOf(u);
    // An update for an unknown call can only render if it brings an identity of its own.
    if (!prev && kind === "tool_call_update" && !ident) return null;

    // No title keeps the old one (the tooltip).
    const nextTitle = clipChars(title, TITLE_MAX) || (prev && prev.title) || "tool";
    // Unknown / absent status keeps the previous state; a fresh call starts as running.
    const state = STATE_OF[u.status] || (prev && prev.state) || "running";
    // Upgrade the label only to a more specific identity; otherwise it holds.
    const keep = prev && (!ident || ident.rank <= (prev.labelRank || 0));
    const label = keep ? prev.label : labelOf(ident ? ident.label : "tool");
    const labelRank = keep ? (prev.labelRank || 0) : (ident ? ident.rank : 0);
    return { id, title: nextTitle, label, labelRank, state, icon: ICON_OF[state] };
  }

  return { applyToolCallUpdate, isBrowserToolCall, mcpLabel, ICON_OF, LABEL_MAX, TITLE_MAX };
});
