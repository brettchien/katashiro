// ask-core.js — the pure half of katashiro.ask_user (ADR docs/adr/ask-user.md): what a question may
// say, how a card settles, how long it has been on screen, and the text its answer is sent as.
// sidepanel.js builds the card and sends the answer; this module has no DOM, so all of that is
// unit-tested.
//
// Asynchronous by design (ADR §2.1): the tool returns as soon as the card is shown, and the answer
// goes to the asking agent later as a new prompt. One tunnelled tool call can wait at most 170 s
// (openab's tunnel_timeout_seconds, under a 180 s hard ceiling), far less than a user who is not
// looking may take.
//
// Agent text goes through ConfirmCore.plainText, the same sanitising as the 🔒 confirm card, so a
// question or label cannot fake a row of the card or reorder what the user reads (ADR §2.6).
//
// Dual target like confirm-core.js (globalThis.AskCore / module.exports); needs ConfirmCore first.
(function (root, factory) {
  const confirmCore = typeof module !== "undefined" && module.exports ? require("./confirm-core.js") : root.ConfirmCore;
  const mod = factory(confirmCore);
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.AskCore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function (ConfirmCore) {
  "use strict";

  const QUESTION_MAX = 300;
  const OPTION_MAX = 60;
  const OPTIONS_MIN = 2;
  const OPTIONS_MAX = 8;                                 // Q3 = a: hard max 8 (Brett)
  const OTHER_MAX = 500;
  const TIMEOUT_DEFAULT_SEC = 120;                       // Q2 = c: default 120, clamped to 30–300 (Brett)
  const TIMEOUT_MIN_SEC = 30;
  const TIMEOUT_MAX_SEC = 300;
  const PENDING_MAX = 3;                                 // pending cards per agent (ADR §2.5)

  // A label cleaned as the card shows it, or "" when nothing printable is left. Never cut here:
  // a label longer than its cap is refused (normalizeSpec), so the agent gets back what it sent.
  const clean = (s) => ConfirmCore.plainText(s, Number.MAX_SAFE_INTEGER);

  /** timeoutSec → ms: a number is clamped to [30, 300] s; anything else is the 120 s default. */
  function clampTimeoutMs(timeoutSec) {
    const n = Number(timeoutSec);
    if (timeoutSec == null || timeoutSec === "" || !Number.isFinite(n)) return TIMEOUT_DEFAULT_SEC * 1000;
    return Math.round(Math.min(TIMEOUT_MAX_SEC, Math.max(TIMEOUT_MIN_SEC, n)) * 1000);
  }

  /**
   * The tool's arguments → { ok: true, spec } or { ok: false, error } (an error the agent can fix).
   * spec = { question, options: string[], multi, allowOther, timeoutMs }, every string plain text.
   */
  function normalizeSpec(args) {
    const a = args && typeof args === "object" ? args : {};
    const question = clean(a.question);
    if (!question) return { ok: false, error: "`question` is required (plain text)" };
    if (question.length > QUESTION_MAX) return { ok: false, error: `question is ${question.length} chars; ask_user is capped at ${QUESTION_MAX}` };
    if (!Array.isArray(a.options)) return { ok: false, error: `\`options\` must be an array of ${OPTIONS_MIN}–${OPTIONS_MAX} short labels` };
    if (a.options.length < OPTIONS_MIN || a.options.length > OPTIONS_MAX) {
      return { ok: false, error: `give ${OPTIONS_MIN}–${OPTIONS_MAX} options (got ${a.options.length}); for an open question just ask in your reply` };
    }
    const options = [];
    for (let i = 0; i < a.options.length; i++) {
      const raw = a.options[i];
      if (typeof raw !== "string") return { ok: false, error: `option ${i + 1} is not a string` };
      const label = clean(raw);
      if (!label) return { ok: false, error: `option ${i + 1} is empty` };
      if (label.length > OPTION_MAX) return { ok: false, error: `option ${i + 1} is ${label.length} chars; labels are capped at ${OPTION_MAX} (put detail in the question)` };
      if (options.includes(label)) return { ok: false, error: `option ${i + 1} repeats "${label}"` };
      options.push(label);
    }
    return {
      ok: true,
      spec: { question, options, multi: a.multi === true, allowOther: a.allowOther === true, timeoutMs: clampTimeoutMs(a.timeoutSec) },
    };
  }

  /**
   * May this agent show a card now? Same turn rule as the confirm card (ConfirmCore.shouldAsk): a
   * call that arrives after the asking turn ended (the user stopped it) shows nothing. Then the
   * per-agent cap. → { ok: true } | { ok: false, reason: "turn" | "cap" }.
   */
  function canAsk({ turnActive = false, pending = 0 } = {}) {
    if (!ConfirmCore.shouldAsk({ forAgent: true, turnActive })) return { ok: false, reason: "turn" };
    if (pending >= PENDING_MAX) return { ok: false, reason: "cap" };
    return { ok: true };
  }

  /** "ask_" + 8 hex digits; randomBytes(n) returns n random bytes (crypto.getRandomValues in the panel). */
  function newAskId(randomBytes) {
    const b = randomBytes(4);
    return "ask_" + Array.from(b, (x) => (x & 0xff).toString(16).padStart(2, "0")).join("");
  }

  /**
   * What the user picked on the card → a checked answer, or null when it does not fit the spec:
   *   { choice: index }        one option (not multi)
   *   { choices: index[] }     multi: ≥ 1 distinct indices, kept in option order
   *   { other: text }          allowOther: the 其他 box, 1–OTHER_MAX chars after sanitising
   * Returns { kind: "choice" | "choices" | "other", labels?: string[], other?: string }.
   */
  function normalizeAnswer(spec, raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    const valid = (i) => Number.isInteger(i) && i >= 0 && i < spec.options.length;
    if ("other" in r) {
      if (!spec.allowOther) return null;
      const other = clean(r.other);
      if (!other || other.length > OTHER_MAX) return null;
      return { kind: "other", other };
    }
    if (spec.multi) {
      if (!Array.isArray(r.choices) || !r.choices.length || !r.choices.every(valid)) return null;
      const idx = [...new Set(r.choices)].sort((x, y) => x - y);
      return { kind: "choices", labels: idx.map((i) => spec.options[i]) };
    }
    if (!valid(r.choice)) return null;
    return { kind: "choice", labels: [spec.options[r.choice]] };
  }

  // The answer as one line (ADR §2.2): a single label bare, several in 「」 so a label holding 、
  // stays unambiguous, a free-text answer marked （其他）.
  function answerText(answer) {
    if (!answer) return "";
    if (answer.kind === "other") return `（其他）${answer.other}`;
    if (answer.kind === "choices") return answer.labels.map((l) => `「${l}」`).join("、");
    return answer.labels[0];
  }

  /** The prompt body sent to the asking agent (sidepanel.js frames it like any user message). */
  function answerMessage(id, answer) {
    return `↩ 回答 ${id}：${answerText(answer)}`;
  }

  // How a settled card reads afterwards (it stays in the chat, controls gone). Only "answered"
  // sends anything; every other state is silence towards the agent (ADR §2.4).
  const OUTCOMES = {
    answered: (a) => `已回答：${answerText(a)}`,
    timeout: () => "未回答（逾時）",
    superseded: () => "未回答（你送了別的訊息）",
    cancelled: () => "未回答（聊天已清除）",
    disconnected: () => "未回答（agent 已中斷連線）",
  };
  function outcomeText(state, answer) {
    const f = OUTCOMES[state];
    return f ? f(answer) : "";
  }

  /** The hint under the options: seconds, or whole minutes; says that hidden time does not count. */
  function timeoutHint(spec) {
    const s = Math.round(spec.timeoutMs / 1000);
    const span = s >= 60 && s % 60 === 0 ? `${s / 60} 分鐘` : `${s} 秒`;
    return `${span}內沒有回答就不再等（側邊欄沒顯示時不計時）。`;
  }

  /**
   * One question's lifecycle. The first of answer() / timeout / supersede() / cancel() /
   * disconnect() settles it; later ones are no-ops (a click racing the timer cannot flip it).
   * The timeout counts only VISIBLE time (Q1 = b): setVisible(true) starts the clock, (false)
   * banks what is left and stops it; a card created hidden waits with a full budget.
   * onSettle(state, answer) runs once, synchronously. Clock and timers are injected for the tests.
   */
  function createAsk({ timeoutMs = TIMEOUT_DEFAULT_SEC * 1000, visible = false, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onSettle } = {}) {
    let state = "pending";
    let answer = null;
    let left = timeoutMs;                                // budget not yet spent
    let since = null;                                    // when the current visible stretch began
    let timer = null;
    const stopClock = () => {
      if (since !== null) left = Math.max(0, left - (now() - since));
      since = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    };
    const settle = (next, ans) => {
      if (state !== "pending") return false;
      stopClock();
      state = next;
      answer = ans || null;
      try { if (onSettle) onSettle(next, answer); } catch (_) { /* the outcome stands even if the redraw fails */ }
      return true;
    };
    const setVisible = (v) => {
      if (state !== "pending") return;
      if (v && since === null) {
        since = now();
        timer = setTimer(() => { timer = null; settle("timeout"); }, left);
      } else if (!v && since !== null) {
        stopClock();
      }
    };
    if (visible) setVisible(true);
    return {
      get state() { return state; },
      get picked() { return answer; },
      /** ms of visible time left before the card times out. */
      remainingMs: () => (since === null ? left : Math.max(0, left - (now() - since))),
      setVisible,
      answer: (a) => settle("answered", a),
      supersede: () => settle("superseded"),
      cancel: () => settle("cancelled"),
      disconnect: () => settle("disconnected"),
    };
  }

  return {
    QUESTION_MAX, OPTION_MAX, OPTIONS_MIN, OPTIONS_MAX, OTHER_MAX, PENDING_MAX,
    TIMEOUT_DEFAULT_SEC, TIMEOUT_MIN_SEC, TIMEOUT_MAX_SEC,
    clampTimeoutMs, normalizeSpec, canAsk, newAskId, normalizeAnswer, answerText, answerMessage,
    outcomeText, timeoutHint, createAsk,
  };
});
