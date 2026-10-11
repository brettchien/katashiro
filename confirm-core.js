// confirm-core.js — the pure half of the side panel's confirm card (#80): the text rules and the
// one-shot decision state machine. sidepanel.js builds the card and wires the buttons; this module
// has no DOM, so what the card may show and how a decision settles are unit-tested.
//
// Why a card and not window.confirm (#80): confirm() blocks the panel's main thread, so every other
// agent connection, heartbeat and tool call in the room freezes until the user answers, and a late
// "yes" still acts after the asking agent's turn has timed out. A card in the chat blocks nothing,
// several can be pending at once, and an unanswered one declines itself after TIMEOUT_MS.
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

  // Line breaks, C0/C1 controls, DEL, U+2028/2029, and bidi embedding/override/isolate marks. Any of
  // them lets agent-supplied text (a canvas title) fake a line of the card, e.g. a title ending in
  // "\n(temp file, safe to delete)", or reorder what the user reads (#80).
  const UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

  /** One line of plain text: unsafe characters become spaces, runs of spaces collapse, cut to `max`. */
  function plainText(s, max = LINE_MAX) {
    const t = String(s == null ? "" : s).replace(UNSAFE_RE, " ").replace(/ {2,}/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  /**
   * The card's content, every field plain text (the card sets it with textContent, never as HTML).
   * `lines` are separate rows the CALLER composed; each is still flattened, so an agent string
   * inside one cannot add rows. timeoutMs is clamped to (0, TIMEOUT_MS].
   */
  function normalizeSpec({ title, lines, allowLabel, denyLabel, timeoutMs } = {}) {
    const t = Number(timeoutMs);
    return {
      title: plainText(title, TITLE_MAX) || "確認",
      lines: (Array.isArray(lines) ? lines : []).slice(0, LINES_MAX).map((l) => plainText(l)).filter(Boolean),
      allowLabel: plainText(allowLabel, LABEL_MAX) || "允許",
      denyLabel: plainText(denyLabel, LABEL_MAX) || "拒絕",
      timeoutMs: Number.isFinite(t) && t > 0 ? Math.min(t, TIMEOUT_MS) : TIMEOUT_MS,
    };
  }

  // How a decided card reads afterwards (it stays in the chat, buttons gone). Only "allowed"
  // resolves true; a timeout or a cleared chat is a decline, and says why.
  const OUTCOMES = {
    allowed: { ok: true, text: (s) => (s.allowLabel === "允許" ? "已允許" : `已選擇：${s.allowLabel}`) },
    denied: { ok: false, text: (s) => (s.denyLabel === "拒絕" ? "已拒絕" : `已選擇：${s.denyLabel}`) },
    timeout: { ok: false, text: () => "已拒絕（逾時）" },
    cancelled: { ok: false, text: () => "已拒絕（聊天已清除）" },
  };

  function outcomeText(state, spec) {
    const o = OUTCOMES[state];
    return o ? o.text(spec || normalizeSpec()) : "";
  }

  /**
   * A one-shot decision: the first of allow() / deny() / timeout / cancel() wins, later ones are
   * no-ops (a click racing the timer cannot flip it). `promise` resolves true only for allow.
   * onSettle(state) runs once, synchronously, so the card can redraw before the caller continues.
   * Timers are injected for the tests.
   */
  function createDecision({ timeoutMs = TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, onSettle } = {}) {
    let state = "pending";
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const settle = (next) => {
      if (state !== "pending") return false;
      state = next;
      clearTimer(timer);
      try { if (onSettle) onSettle(next); } catch (_) { /* the decision stands even if the redraw fails */ }
      resolve(OUTCOMES[next].ok);
      return true;
    };
    const timer = setTimer(() => settle("timeout"), timeoutMs);
    return {
      promise,
      get state() { return state; },
      allow: () => settle("allowed"),
      deny: () => settle("denied"),
      cancel: () => settle("cancelled"),
    };
  }

  return { TIMEOUT_MS, TITLE_MAX, LINE_MAX, LINES_MAX, plainText, normalizeSpec, outcomeText, createDecision };
});
