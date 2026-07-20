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

  function normalizeMode(mode) {
    return MODES.includes(mode) ? mode : "mention";
  }

  function defaultRoomConfig() {
    return { mode: "mention" };
  }

  // Validate/repair a stored room config into a known-good shape (forward-compatible: later
  // fields, e.g. the loop-guard cap, extend this).
  function normalizeRoomConfig(cfg) {
    const c = cfg && typeof cfg === "object" ? cfg : {};
    return { mode: normalizeMode(c.mode) };
  }

  return {
    escapeAttr,
    wrapRelay,
    parseMentions,
    resolveNames,
    resolveTargets,
    MODES,
    normalizeMode,
    defaultRoomConfig,
    normalizeRoomConfig,
  };
});
