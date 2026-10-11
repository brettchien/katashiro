// confirm-core.js — the pure half of the side panel's confirm card (#80): the text rules and the
// one-shot decision state machine. sidepanel.js builds the card and wires the buttons; this module
// has no DOM, so what the card may show and how a decision settles are unit-tested.
//
// Why a card and not window.confirm (#80): confirm() blocks the panel's main thread, so every other
// agent connection, heartbeat and tool call in the room freezes until the user answers, and a late
// "yes" still acts after the asking agent's turn has timed out. A card in the chat blocks nothing,
// several can be pending at once, an unanswered one declines itself after TIMEOUT_MS, and one asked
// in an agent's turn declines when that turn ends (sidepanel.js calls end()), so it cannot act late.
// And one an agent asks after its turn already ended is not shown at all (shouldAsk): the agent's
// tool calls run one after another, so a second canvas_delete can arrive after the user stopped the
// turn while the first card was up; a card then would act for a turn that no longer exists.
// The API is general on purpose (title + lines + labels + timeout), so a later ask_user tool can
// reuse it; today only canvas_delete and the storage-full eviction ask.
//
// Dual target like room-core.js (globalThis.ConfirmCore / module.exports).
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.ConfirmCore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const TIMEOUT_MS = 2 * 60 * 1000;                      // no answer in 2 minutes = declined (Brett)
  const TITLE_MAX = 120;
  const LINE_MAX = 200;
  const LINES_MAX = 12;
  const LABEL_MAX = 20;

  // Line breaks, C0/C1 controls, DEL, U+2028/2029, bidi marks (LRM/RLM/ALM) and embedding/override/
  // isolate marks, and the invisible ZWSP / BOM. Any of them lets agent-supplied text (a canvas title) fake a line of the card, e.g. a title ending in
  // "\n(temp file, safe to delete)", or reorder what the user reads (#80).
  // ZWNJ/ZWJ (U+200C/D) stay: they shape emoji sequences and some scripts, and fake no row.
  const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

  /** One line of plain text: unsafe characters become spaces, runs of spaces collapse, cut to `max`. */
  function plainText(s, max = LINE_MAX) {
    const t = String(s == null ? "" : s).replace(UNSAFE_RE, " ").replace(/ {2,}/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  /**
   * The card's content, every field plain text (the card sets it with textContent, never as HTML).
   * `lines` are separate rows the CALLER composed; each is still flattened, so an agent string
   * inside one cannot add rows. timeoutMs is clamped to (0, TIMEOUT_MS]. allowDefault/denyDefault
   * record that a label is the built-in one, so the outcome text does not compare strings.
   */
  function normalizeSpec({ title, lines, allowLabel, denyLabel, timeoutMs } = {}) {
    const t = Number(timeoutMs);
    const allow = plainText(allowLabel, LABEL_MAX);
    const deny = plainText(denyLabel, LABEL_MAX);
    return {
      title: plainText(title, TITLE_MAX) || "確認",
      lines: (Array.isArray(lines) ? lines : []).slice(0, LINES_MAX).map((l) => plainText(l)).filter(Boolean),
      allowLabel: allow || "允許",
      denyLabel: deny || "拒絕",
      allowDefault: !allow,
      denyDefault: !deny,
      timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(t, TIMEOUT_MS) : TIMEOUT_MS,
    };
  }

  // How a decided card reads afterwards (it stays in the chat, buttons gone). Only "allowed"
  // resolves true; a timeout, a cleared chat or the asking turn ending is a decline, and says why.
  const OUTCOMES = {
    allowed: { ok: true, text: (s) => (s.allowDefault ? "已允許" : `已選擇：${s.allowLabel}`) },
    denied: { ok: false, text: (s) => (s.denyDefault ? "已拒絕" : `已選擇：${s.denyLabel}`) },
    timeout: { ok: false, text: () => "已拒絕（逾時）" },
    cancelled: { ok: false, text: () => "已拒絕（聊天已清除）" },
    ended: { ok: false, text: () => "已拒絕（回合已結束）" },
  };

  /**
   * Whether to show the card at all. Asked on behalf of an agent (forAgent) outside that agent's
   * turn → no: the turn that wanted the answer is over (stopped, failed, timed out), so the request
   * declines without a card ("skipped", NOT_ASKED). A caller that is not an agent (no conn) may ask
   * any time; its card stands on its own row.
   */
  function shouldAsk({ forAgent = false, turnActive = false } = {}) {
    return !forAgent || !!turnActive;
  }

  // The outcome of a request shouldAsk turned down: a decline nobody was shown (#80 follow-up).
  const NOT_ASKED = Object.freeze({ ok: false, state: "skipped" });

  function outcomeText(state, spec) {
    const o = OUTCOMES[state];
    return o ? o.text(spec || normalizeSpec()) : "";
  }

  /** The hint under the question: whole minutes when the timeout is whole minutes, else seconds. */
  function timeoutHint(spec) {
    const ms = spec.timeoutMs;
    return ms >= 60000 && ms % 60000 === 0
      ? `${ms / 60000} 分鐘內沒有回答視為${spec.denyLabel}。`
      : `${Math.ceil(ms / 1000)} 秒內沒有回答視為${spec.denyLabel}。`;
  }

  /**
   * A one-shot decision: the first of allow() / deny() / timeout / cancel() / end() wins, later
   * ones are no-ops (a click racing the timer cannot flip it). `promise` resolves true only for
   * allow; `outcome` resolves { ok, state }, for a caller that must tell "no" from "no answer".
   * onSettle(state) runs once, synchronously, so the card can redraw before the caller continues.
   * Timers are injected for the tests.
   */
  function createDecision({ timeoutMs = TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, onSettle } = {}) {
    let state = "pending";
    let resolve;
    const outcome = new Promise((r) => { resolve = r; });
    const promise = outcome.then((o) => o.ok);
    const settle = (next) => {
      if (state !== "pending") return false;
      state = next;
      clearTimer(timer);
      try { if (onSettle) onSettle(next); } catch (_) { /* the decision stands even if the redraw fails */ }
      resolve({ ok: OUTCOMES[next].ok, state: next });
      return true;
    };
    const timer = setTimer(() => settle("timeout"), timeoutMs);
    return {
      promise,
      outcome,
      get state() { return state; },
      allow: () => settle("allowed"),
      deny: () => settle("denied"),
      cancel: () => settle("cancelled"),
      end: () => settle("ended"),
    };
  }

  return { TIMEOUT_MS, TITLE_MAX, LINE_MAX, LINES_MAX, NOT_ASKED, plainText, normalizeSpec, shouldAsk, outcomeText, timeoutHint, createDecision };
});
