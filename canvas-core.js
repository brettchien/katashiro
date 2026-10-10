// canvas-core.js — the canvas host's security decisions as pure functions (ADR §3.2), so they
// are unit-tested rather than living only in DOM glue. Used by canvas.js; dual target like
// browser-mcp.js (globalThis.CanvasCore / module.exports).
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.CanvasCore = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ERROR_MAX = 500;      // error{msg} is shown with textContent, capped (§3.2)
  const URL_MAX = 2048;
  const COPY_MAX = 1024 * 1024;

  // What canvas-frame.html may send (§3.2 per-frame allow-list). MVP: no editor, so no save /
  // selection yet. Anything else is dropped.
  const FRAME_TYPES = {
    ready: () => true,
    rendered: (m) => Number.isInteger(m.version),
    error: (m) => typeof m.msg === "string",
    openLink: (m) => typeof m.url === "string",
    // #69: the frame has no clipboard; it asks the host (a user click in the frame gives the host
    // transient activation too). Text only, bounded; the reply goes back as copied{reqId, ok}.
    copy: (m) => typeof m.text === "string" && m.text.length <= COPY_MAX && Number.isInteger(m.reqId),
  };

  /**
   * Accept a message only if it comes from our frame's window, carries the current nonce, and is
   * an allow-listed type with well-formed fields. Returns the message or null.
   */
  function acceptFrameMessage(event, { frameWindow, nonce }) {
    if (!event || !frameWindow || event.source !== frameWindow) return null;
    const m = event.data;
    if (!m || typeof m !== "object" || typeof m.type !== "string") return null;
    if (!nonce || m.nonce !== nonce) return null;
    if (!Object.prototype.hasOwnProperty.call(FRAME_TYPES, m.type)) return null;
    if (!FRAME_TYPES[m.type](m)) return null;
    return m;
  }

  // openLink: http(s) only, absolute, bounded. Returns the normalized URL or null.
  function safeLinkUrl(raw) {
    if (typeof raw !== "string" || raw.length > URL_MAX) return null;
    let u;
    try { u = new URL(raw); } catch (_) { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;          // no credentials smuggled in a link
    return u.href;
  }

  function clipError(msg) {
    const s = String(msg == null ? "" : msg);
    return s.length > ERROR_MAX ? `${s.slice(0, ERROR_MAX)}…` : s;
  }

  /**
   * The load gate (§3.2). The host counts the iframe loads it causes itself; any other load means
   * the frame navigated away (a link it should not have followed, a script that set location),
   * and the frame must be dropped before anything else is posted to it.
   */
  function createLoadGate() {
    let expected = 0;
    return {
      /** Call right before setting the iframe's src. */
      expect() { expected += 1; },
      /** Call on every iframe `load`; false = an unexpected navigation. */
      onLoad() {
        if (expected > 0) { expected -= 1; return true; }
        return false;
      },
    };
  }

  function newNonce(cryptoObj) {
    const b = new Uint8Array(16);
    (cryptoObj || globalThis.crypto).getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  return { acceptFrameMessage, safeLinkUrl, clipError, createLoadGate, newNonce, ERROR_MAX };
});
