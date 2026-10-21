// jev-grounding.js — pure Jev (TypeSafe System One) decision helper for katashiro.
//
// NO DOM / chrome APIs / global state here — the caller passes the user's OpenRouter token
// (BYO-key, read from chrome.storage) and optionally a fetch impl; this module builds the
// decisions request, calls it, and parses the typed answers. Dual target: loaded as a classic
// <script> in sidepanel.html (exposes globalThis.JevGrounding) and require()'d by the
// node --test suite (module.exports). Same shape as room-core.js / browser-mcp.js — no bundler.
//
// Jev = bounded typed decisions (noul yes/no-probability, choice, score). We use it to GROUND
// the browser loop: verify an action took effect, disambiguate which element to act on, or
// detect a page state — from the a11y snapshot, without spending a full agent turn on each.
//
// Endpoint is alpha (`/api/alpha/decisions`); the wire shape (field `instructions`, response
// `answers.<name>.noul`) is confirmed 2026-09-20 but may drift — this module isolates it.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod; // node (test)
  else root.JevGrounding = mod; // extension global
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // OpenRouter's decisions endpoint serves TypeSafe's Jev with a wide-open CORS policy
  // (access-control-allow-origin: *), so a browser extension can call it directly — no proxy.
  const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
  const JEV_MODEL = "typesafe/jev-1.13";
  const DEFAULT_TIMEOUT_MS = 3000;

  // Build the decisions HTTP request. `questions` is a map exactly as the endpoint expects:
  //   { <name>: { type: "noul"|"choice"|"score", instructions: "...", ... } }
  // (the field is `instructions`, NOT `prompt`). Returns { url, options } for fetch().
  function buildDecisionRequest(stateText, questions, opts) {
    opts = opts || {};
    const model = opts.model || JEV_MODEL;
    const headers = { "Content-Type": "application/json" };
    if (opts.token) headers["Authorization"] = "Bearer " + opts.token;
    // Optional OpenRouter dashboard attribution — allowed by the endpoint's CORS allow-headers.
    headers["HTTP-Referer"] = "katashiro";
    headers["X-Title"] = "katashiro";
    return {
      url: JEV_ENDPOINT,
      options: {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          model: model,
          state: String(stateText == null ? "" : stateText),
          questions: questions || {},
        }),
      },
    };
  }

  // Flatten the typed answers into { <name>: value }: noul → probability (0..1);
  // choice → selected option key; score → level. Missing/garbage → {} (never throws).
  function parseAnswers(json) {
    const out = {};
    const answers = json && json.answers;
    if (!answers || typeof answers !== "object") return out;
    for (const name of Object.keys(answers)) {
      const a = answers[name];
      if (!a || typeof a !== "object") continue;
      if (typeof a.noul === "number") out[name] = a.noul;
      else if ("choice" in a) out[name] = a.choice;
      else if ("score" in a) out[name] = a.score;
      else out[name] = undefined;
    }
    return out;
  }

  // Evaluate `questions` against `stateText` (typically an a11y snapshot). Returns the parsed
  // answer map, or NULL when grounding is unavailable (no token) or the call fails/times out.
  // Callers MUST treat null as "grounding off" and never block the browser action on it
  // (fail-open) — Jev is an optional enhancement, alpha, and must not wedge the loop.
  async function evaluate(stateText, questions, opts) {
    opts = opts || {};
    if (!opts.token) return null; // BYO-key: no key → grounding disabled
    const doFetch = opts.fetch || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) return null;
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    const built = buildDecisionRequest(stateText, questions, opts);

    let timer = null;
    let fetchOpts = built.options;
    if (typeof AbortController !== "undefined") {
      const ac = new AbortController();
      fetchOpts = Object.assign({}, built.options, { signal: ac.signal });
      timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    }
    try {
      const resp = await doFetch(built.url, fetchOpts);
      if (!resp || !resp.ok) return null;
      const json = await resp.json();
      return parseAnswers(json);
    } catch (_e) {
      return null; // fail-open (timeout, network, alpha endpoint hiccup)
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Read one noul probability (0..1) from an answer map, or null if absent.
  function noul(answers, name) {
    if (!answers || typeof answers[name] !== "number") return null;
    return answers[name];
  }

  // Read a choice answer (the selected option key) from an answer map, or null.
  function choice(answers, name) {
    if (!answers) return null;
    const v = answers[name];
    return typeof v === "string" ? v : null;
  }

  return {
    JEV_ENDPOINT: JEV_ENDPOINT,
    JEV_MODEL: JEV_MODEL,
    buildDecisionRequest: buildDecisionRequest,
    parseAnswers: parseAnswers,
    evaluate: evaluate,
    noul: noul,
    choice: choice,
  };
});
