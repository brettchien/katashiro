// acp-two-sessions-core.cjs — the pure half of scripts/acp-two-sessions.mjs (argument parsing,
// the prompt, overlap / interleaving maths, error classification, the verdict and the PASS/FAIL
// table). No sockets, no clock, no randomness: everything the live script measures comes in as
// data, so test/acp-two-sessions-core.test.js can pin the verdict without a gateway.
"use strict";

const DEFAULTS = Object.freeze({
  sessions: 2,
  timeoutSec: 300,       // whole run, connect → last turn settled
  holdSec: 10,           // how long whoami holds before answering (widens the overlap window)
  tunnelWaitSec: 20,     // how long to wait for each tunnel's inner MCP initialize before prompting
  cwd: "/home/agent",    // what Katashiro sends (sidepanel.js ACP_CWD)
});
const MAX_SESSIONS = 3;  // the broker pool default; more than that is a different test

class UsageError extends Error {}

/** argv (without node + script) + env → options. Throws UsageError on bad input. */
function parseArgs(argv, env) {
  const o = {
    url: (env && env.ACP_URL) || "",
    token: ((env && env.ACP_TOKEN) || "").trim(),
    sessions: DEFAULTS.sessions,
    timeoutSec: DEFAULTS.timeoutSec,
    holdSec: DEFAULTS.holdSec,
    tunnelWaitSec: DEFAULTS.tunnelWaitSec,
    cwd: DEFAULTS.cwd,
    verbose: false,
    help: false,
  };
  const num = (flag, v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} must be a number in ${min}..${max} (got ${v})`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let val;
    const eq = a.indexOf("=");
    if (a.startsWith("--") && eq > 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    const next = () => {
      if (val !== undefined) return val;
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case "--url": o.url = next(); break;
      case "--sessions": o.sessions = num(a, next(), 1, MAX_SESSIONS); break;
      case "--timeout": o.timeoutSec = num(a, next(), 10, 3600); break;
      case "--hold": o.holdSec = num(a, next(), 0, 120); break;
      case "--tunnel-wait": o.tunnelWaitSec = num(a, next(), 0, 120); break;
      case "--cwd": o.cwd = next(); break;
      case "--verbose": case "-v": o.verbose = true; break;
      case "--help": case "-h": o.help = true; break;
      case "--token":
        throw new UsageError("pass the token in the ACP_TOKEN environment variable, not on the command line");
      // A positional value is not echoed: it may be a token pasted in the wrong place.
      default: throw new UsageError(a.startsWith("-") ? `unknown argument: ${a}` : "unexpected positional argument (value not shown); pass the token in ACP_TOKEN");
    }
  }
  o.sessions = Math.floor(o.sessions);
  if (o.help) return o;
  if (!o.url) throw new UsageError("missing --url (or ACP_URL), e.g. wss://host/acp");
  if (!/^wss?:\/\//i.test(o.url)) throw new UsageError(`--url must start with ws:// or wss:// (got ${o.url})`);
  if (!o.token) throw new UsageError("missing ACP_TOKEN in the environment");
  return o;
}

/** Session labels: A, B, C. */
function labels(n) {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
}

/** The MCP server name a session declares: probeA, probeB, … */
function serverName(label) { return `probe${label}`; }

/** What the agent is asked. It never contains the nonce — the agent can only learn it from the tool. */
function buildPrompt(label) {
  return [
    `This is an automated protocol test of the Katashiro client (session ${label}). Follow these steps exactly and use no other tools:`,
    `1. Call search_capabilities with the query "whoami".`,
    `2. Call execute_capability with the exact name of the whoami capability that search returned (there should be exactly one) and arguments {}.`,
    `3. Reply in plain text (no markdown formatting) with these lines, in this order:`,
    `   CAPS: <the capability names the search returned, comma-separated>`,
    `   NONCE: <the nonce value from the whoami result>`,
    `   then five short numbered lines (1. to 5.), each one sentence about the sea.`,
  ].join("\n");
}

/** The capability names from the reply's `CAPS:` line, or null when the line is missing. */
function capsLine(replyText) {
  // Tolerates markdown around the label (`**CAPS:**`, `- CAPS:`, `` `CAPS: …` ``): agents like to bold it.
  const m = /^[\s*_`>-]*CAPS[*_`]*:[*_`]*\s*(.*)$/im.exec(replyText || "");
  return m ? m[1].replace(/[*_`\s]+$/, "") : null;
}

/** The whoami result text. Kept parseable so a crossed-over nonce is easy to spot in a reply. */
function whoamiText(label, nonce) {
  return `session=${label} server=${serverName(label)} nonce=${nonce}`;
}

/** Overlap in ms of two [start, end] intervals (0 when they do not overlap or one is open). */
function overlapMs(a, b) {
  if (!a || !b || a[0] == null || a[1] == null || b[0] == null || b[1] == null) return 0;
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0]));
}

/**
 * How many times consecutive events switch session, in time order. Two sessions that each stream
 * all their chunks in one burst after the other give 1; real interleaving gives more.
 * `events`: [{ t, label }].
 */
function interleavings(events) {
  const sorted = events.slice().sort((x, y) => x.t - y.t);
  let n = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].label !== sorted[i - 1].label) n++;
  return n;
}

/** Max number of tool calls in flight at the same time. `calls`: [{ start, end }]. */
function maxInFlight(calls) {
  const edges = [];
  for (const c of calls) {
    if (c.start == null) continue;
    edges.push([c.start, 1]);
    edges.push([c.end == null ? Infinity : c.end, -1]);
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);   // an end before a start at the same instant
  let cur = 0, max = 0;
  for (const [, d] of edges) { cur += d; if (cur > max) max = cur; }
  return max;
}

/** "busy" (-32001 Session busy), "pool" (broker pool exhausted), or null. Takes an error or text. */
function classifyError(x) {
  if (x == null) return null;
  const code = typeof x === "object" ? x.code : undefined;
  const text = typeof x === "string" ? x : String((x && x.message) || "");
  if (code === -32001 || /session busy/i.test(text)) return "busy";
  // The broker's own wording, and what openab's error_display turns it into when it is relayed as
  // the agent's reply text instead of an error.
  if (/pool exhausted|all agent sessions are in use|service busy/i.test(text)) return "pool";
  return null;
}

/**
 * The verdict. `sessions`: one record per label —
 *   { label, nonce, created, createError, tunnelUp, calls: [{ start, end, name }], sentAt, doneAt,
 *     stopReason, error, replyText, activity: [t…] }
 * (`calls` only holds calls that arrived on THIS session's server; `activity` is every
 * session/update and tools/call timestamp of the session.) `extra`: { strayCalls, timedOut }.
 * Returns { pass, rows: [[check, ...cells]], info: [[name, value]] }.
 */
function evaluate(sessions, extra = {}) {
  const ok = (b) => (b ? "PASS" : "FAIL");
  const rows = [];
  const per = (name, fn) => rows.push([name, ...sessions.map((s) => fn(s))]);
  const others = (s) => sessions.filter((o) => o !== s);
  const window = (s) => [s.sentAt, s.doneAt];

  per("session/new", (s) => ok(s.created));
  per("tunnel up (mcp/connect + init)", (s) => ok(s.tunnelUp));
  per("whoami called on own server", (s) => ok(s.created && s.calls.some((c) => c.name === "whoami")));
  // Isolation: the facade must list only this session's server, so the CAPS line the agent copied
  // from search_capabilities may not name another session's probe (and has to be there at all).
  per("CAPS lists no other session's server", (s) => {
    const caps = capsLine(s.replyText);
    return ok(caps != null && !others(s).some((o) => caps.includes(serverName(o.label))));
  });
  // A call on this session's server outside its turn would mean some other turn reached it.
  per("calls inside own turn", (s) => (s.calls.length === 0 ? "-" : ok(s.calls.every((c) =>
    s.sentAt != null && c.start >= s.sentAt && (s.doneAt == null || c.start <= s.doneAt)))));
  per("turn ended (end_turn)", (s) => ok(!s.error && s.stopReason === "end_turn"));
  per("reply has own nonce", (s) => ok(!!s.replyText && s.replyText.includes(s.nonce)));
  per("no other session's nonce", (s) => ok(!others(s).some((o) => o.nonce && (s.replyText || "").includes(o.nonce))));
  per("no busy / pool exhausted", (s) => ok(!classifyError(s.error) && !classifyError(s.replyText) && !classifyError(s.createError)));

  // Concurrency. Serialised execution would let the later session do nothing until the earlier one
  // finished, so: every pair of turn windows overlaps, and the session that finished later showed
  // activity (an update or a tool call) before the earlier one finished.
  let pairsOverlap = sessions.length > 1;
  let laterActiveEarly = sessions.length > 1;
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i], b = sessions[j];
      if (!(overlapMs(window(a), window(b)) > 0)) pairsOverlap = false;
      if (a.doneAt == null || b.doneAt == null) { laterActiveEarly = false; continue; }
      const [first, later] = a.doneAt <= b.doneAt ? [a, b] : [b, a];
      // Only activity after the prompt counts: an update the gateway sends on its own (e.g. a future
      // available_commands_update right after session/new) says nothing about the turn running.
      if (!later.activity.some((t) => later.sentAt != null && t >= later.sentAt && t < first.doneAt)) laterActiveEarly = false;
    }
  }
  const glob = (name, b) => rows.push([name, ok(b), ...sessions.slice(1).map(() => "")]);
  glob("turns overlap in time", pairsOverlap);
  glob("later turn active before first ended", laterActiveEarly);
  glob("no calls on unknown connections", !(extra.strayCalls > 0));
  glob("finished before --timeout", !extra.timedOut);

  const allCalls = sessions.flatMap((s) => s.calls);
  const updates = sessions.flatMap((s) => (s.updates || []).map((t) => ({ t, label: s.label })));
  const info = [
    ["tool calls in flight at once (max)", String(maxInFlight(allCalls))],
    ["session/update switches between sessions", String(interleavings(updates))],
  ];
  const pass = rows.every((r) => r.slice(1).every((c) => c !== "FAIL"));
  return { pass, rows, info };
}

/** Display width: ASCII 1, East Asian wide / fullwidth 2 (enough for this table's text). */
function width(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || cp >= 0x1f000)) ? 2 : 1;
  }
  return w;
}

/** Fixed-width table: header, a ─ divider, one row per record, columns left-aligned, 1-space gutter. */
function renderTable(header, rows) {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => width(r[c] == null ? "" : r[c]))));
  const line = (r) => r.map((cell, c) => {
    const s = cell == null ? "" : String(cell);
    return c === r.length - 1 ? s : s + " ".repeat(widths[c] - width(s));
  }).join(" ").replace(/\s+$/, "");
  return [line(header), widths.map((w) => "─".repeat(w)).join(" "), ...rows.map(line)].join("\n");
}

module.exports = {
  DEFAULTS, MAX_SESSIONS, UsageError, parseArgs, labels, serverName, buildPrompt, whoamiText,
  capsLine, overlapMs, interleavings, maxInFlight, classifyError, evaluate, width, renderTable,
};
