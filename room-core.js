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

  // Decide which room member ids should RECEIVE a given message (fan-out relay).
  //   members : [{ id, name }] — the current roster.
  //   originId: the speaker's id. The human's id (or null) never matches a member, so a user
  //             message reaches EVERY agent; an agent's relayed reply reaches every agent
  //             EXCEPT itself — a message is never echoed back to its origin.
  //   opts    : reserved for @mention routing (#3) and @mention/ambient mode (#4); unused here.
  // Baseline = broadcast: all members except the origin.
  function resolveTargets(members, originId, opts = {}) {
    if (!Array.isArray(members)) return [];
    return members.filter((m) => m && m.id !== originId).map((m) => m.id);
  }

  return { escapeAttr, wrapRelay, parseMentions, resolveTargets };
});
