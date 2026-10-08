// composer.js — pure rules for images pasted into the chat composer: which clipboard pastes to
// intercept, which image types an agent can take, the per-turn size budget, and how text + images
// become an ACP `session/prompt` content array.
//
// NO DOM here — sidepanel.js owns the paste event, canvas re-encoding and rendering.
// Dual target like room-core.js: a classic <script> in sidepanel.html (globalThis.Composer)
// and require()'d by the node --test suite (module.exports).
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod; // node (test)
  else root.Composer = mod; // extension global
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // What model APIs accept as image input (Claude: png/jpeg/gif/webp). SVG renders fine in an
  // <img> but errors agent-side, so it is rejected at paste time.
  const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

  // Total base64 across one turn's images. Several MB of base64 in one frame overruns the ACP
  // tunnel's per-frame cap and drops the WebSocket (cf. browser-mcp.js screenshot → JPEG q70).
  const MAX_TOTAL_IMAGE_B64 = 1024 * 1024;
  // Longest edge after re-encoding; larger images are downscaled before they are staged.
  const MAX_IMAGE_EDGE = 1568;

  // Did the agent declare image prompts in its `initialize` result? Absent ⇒ no (ACP default).
  function canImage(initResult) {
    const caps = initResult && initResult.agentCapabilities;
    const pc = caps && caps.promptCapabilities;
    return !!(pc && pc.image === true);
  }

  // Decide what a paste carries, from its clipboard items ([{ kind, type }]).
  // Office apps / Google Sheets put `text/plain` AND a rendered `image/png` preview on the
  // clipboard — the user meant the text, so any `text/plain` makes this an ordinary text paste.
  // Returns { images: [item index…] to stage, rejected: [unsupported image mime…] }; the caller
  // preventDefault()s only when `images` is non-empty.
  function classifyPaste(items) {
    const list = Array.from(items || []);
    if (list.some((it) => it && it.kind === "string" && it.type === "text/plain")) {
      return { images: [], rejected: [] };
    }
    const images = [];
    const rejected = [];
    list.forEach((it, i) => {
      if (!it || it.kind !== "file" || typeof it.type !== "string" || !it.type.startsWith("image/")) return;
      if (IMAGE_MIME_TYPES.includes(it.type)) images.push(i);
      else if (!rejected.includes(it.type)) rejected.push(it.type);
    });
    return { images, rejected };
  }

  // Split a `data:<mime>;base64,<data>` URL into an ACP image block's fields, or null if it is not
  // a base64 data URL of an accepted type.
  function parseImageDataUrl(dataUrl) {
    const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!m) return null;
    const mimeType = m[1].toLowerCase();
    if (!IMAGE_MIME_TYPES.includes(mimeType)) return null;
    return { mimeType, data: m[2] };
  }

  // Scale (width, height) so the longest edge is at most maxEdge, keeping the aspect ratio.
  function fitDimensions(width, height, maxEdge) {
    const edge = Math.max(width, height);
    if (!(edge > maxEdge)) return { width, height };
    const k = maxEdge / edge;
    return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
  }

  function stagedSize(images) {
    return (images || []).reduce((n, img) => n + ((img && img.data) ? img.data.length : 0), 0);
  }

  // Would adding `addB64` more base64 chars keep this turn's images within the budget?
  function fitsBudget(images, addB64) {
    return stagedSize(images) + addB64 <= MAX_TOTAL_IMAGE_B64;
  }

  // ACP prompt is [ContentBlock]: an optional text block followed by the images.
  function promptBlocks(text, images) {
    const blocks = [];
    if (text) blocks.push({ type: "text", text });
    for (const img of images || []) blocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
    return blocks;
  }

  // The text persisted to history for a sent message — images are memory-only, so leave a marker
  // instead of an empty bubble after a reload.
  function historyText(text, imageCount) {
    if (!imageCount) return text;
    const note = `（${imageCount} 張圖片未保存）`;
    return text ? `${text}\n\n${note}` : note;
  }

  return {
    IMAGE_MIME_TYPES, MAX_TOTAL_IMAGE_B64, MAX_IMAGE_EDGE,
    canImage, classifyPaste, parseImageDataUrl, fitDimensions, stagedSize, fitsBudget, promptBlocks, historyText
  };
});
