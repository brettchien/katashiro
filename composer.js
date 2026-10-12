// composer.js — pure rules for images pasted into the chat composer: which clipboard pastes to
// intercept, which image types an agent can take, the per-turn size budget, and how text + images
// become an ACP `session/prompt` content array. Also files dropped on the chat (ADR
// docs/adr/chat-attachments.md): what a file is from its bytes, the limits, and how a text file is
// expanded into the prompt.
//
// NO DOM here — sidepanel.js owns the paste/drop events, file reading, canvas re-encoding and
// rendering.
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
  // Office apps / Google Sheets put `text/plain` + `text/html` AND a rendered `image/png` preview
  // on the clipboard — the user meant the text, so that pair makes this an ordinary text paste.
  // `text/plain` alone is not enough: a file copied in Finder/Explorer carries its file name as
  // text/plain next to the file itself, and the user meant the image.
  // Returns { images: [item index…] to stage, rejected: [unsupported image mime…] }; the caller
  // preventDefault()s only when `images` is non-empty.
  function classifyPaste(items) {
    const list = Array.from(items || []);
    const hasString = (type) => list.some((it) => it && it.kind === "string" && it.type === type);
    if (hasString("text/plain") && hasString("text/html")) {
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

  // The text persisted to history for a sent message — images and attached files are memory-only,
  // so leave a marker instead of an empty bubble after a reload. `files`: [{ name, size }].
  function historyText(text, imageCount, files) {
    const notes = [];
    if (imageCount) notes.push(`（${imageCount} 張圖片未保存）`);
    for (const f of files || []) notes.push(attachmentMarker(f));
    if (!notes.length) return text;
    const note = notes.join("\n");
    return text ? `${text}\n\n${note}` : note;
  }

  // --- Dropped files (ADR docs/adr/chat-attachments.md) -----------------------------------------

  // How much of a file is read to decide what it is (git uses the same 8 KB).
  const SNIFF_BYTES = 8192;
  // Images + text files staged for one message.
  const MAX_ATTACHMENTS = 10;
  // Settings → 附加檔案. maxFileMB is refused at drop; textCapKB is checked on send. The file limit
  // stays at or under what the panel is willing to decode as an image (sidepanel MAX_SOURCE_BYTES).
  const ATTACH_DEFAULTS = { maxFileMB: 10, textCapKB: 256 };
  const ATTACH_LIMITS = { maxFileMB: [1, 20], textCapKB: [1, 4096] };

  function clampInt(v, [lo, hi], dflt) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || v === "" || v == null) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  function normalizeAttachConfig(raw) {
    const r = raw && typeof raw === "object" ? raw : {};
    return {
      maxFileMB: clampInt(r.maxFileMB, ATTACH_LIMITS.maxFileMB, ATTACH_DEFAULTS.maxFileMB),
      textCapKB: clampInt(r.textCapKB, ATTACH_LIMITS.textCapKB, ATTACH_DEFAULTS.textCapKB),
    };
  }

  // Image type from magic bytes (never the name or MIME), or null.
  function sniffImage(bytes) {
    const b = bytes || [];
    const at = (i, seq) => seq.every((v, k) => b[i + k] === v);
    if (at(0, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
    if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
    if (at(0, [0x47, 0x49, 0x46, 0x38])) return "image/gif";                   // "GIF8"
    if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp"; // RIFF····WEBP
    return null;
  }

  // Text or not: no NUL (git's check), strict UTF-8 (BOM ok), and at most ~1% other C0 controls (tab,
  // LF, CR, FF and ESC excluded — ESC so ANSI-coloured logs pass). `complete` false ⇒ `bytes` is a
  // prefix of a longer file, so a multi-byte character cut at its end is tolerated (stream: true).
  function looksLikeText(bytes, complete) {
    const b = bytes || new Uint8Array(0);
    let controls = 0;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (c === 0) return false;
      if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c && c !== 0x1b) controls++;
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(b, { stream: !complete });
    } catch {
      return false;
    }
    return controls * 100 <= b.length;
  }

  // What a dropped file is, from its first SNIFF_BYTES (`complete`: those are the whole file).
  function classifyFileBytes(bytes, complete) {
    const mimeType = sniffImage(bytes);
    if (mimeType) return { kind: "image", mimeType };
    return looksLikeText(bytes, complete) ? { kind: "text" } : { kind: "binary" };
  }

  // A whole text file as a string (a UTF-8 BOM is dropped), or null when the whole file does not pass
  // looksLikeText — the first 8 KB can be clean while a later part is not (bad UTF-8, a NUL); never
  // decode that with U+FFFD.
  function decodeText(bytes) {
    const b = bytes || new Uint8Array(0);
    if (!looksLikeText(b, true)) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {
      return null;
    }
  }

  // Which dropped files to take, in order: a file over the size limit or past MAX_ATTACHMENTS (with
  // `staged` attachments already in the composer) is left out and named.
  function planDrop(staged, files, maxBytes) {
    const accept = [];
    const tooBig = [];
    const overCount = [];
    let room = Math.max(0, MAX_ATTACHMENTS - (staged || 0));
    Array.from(files || []).forEach((f, i) => {
      if (!(f && f.size <= maxBytes)) tooBig.push(i);
      else if (room > 0) { accept.push(i); room--; }
      else overCount.push(i);
    });
    return { accept, tooBig, overCount };
  }

  // "512 B", "3 KB", "1.2 MB".
  function formatBytes(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v < 1024) return `${v} B`;
    if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
    return `${(v / 1048576).toFixed(1).replace(/\.0$/, "")} MB`;
  }

  // A file name on one line: control characters (line breaks included) and bidi controls (which can
  // fake an extension, "a\u202etxt.exe") become spaces.
  function displayName(name) {
    return String(name == null ? "" : name)
      .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ")
      .trim() || "file";
  }

  const FENCE_LANGS = {
    md: "markdown", markdown: "markdown", txt: "", log: "", js: "javascript", mjs: "javascript",
    cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", json: "json", jsonl: "json",
    yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini", xml: "xml", html: "html", htm: "html",
    css: "css", scss: "scss", py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
    kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
    php: "php", sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", sql: "sql", csv: "csv",
    tsv: "tsv", diff: "diff", patch: "diff", tf: "hcl", hcl: "hcl", lua: "lua", r: "r",
    dockerfile: "dockerfile", mk: "makefile",
  };

  // Code-fence language from the file name (extension, or a bare Dockerfile/Makefile), "" if unknown.
  function fenceLanguage(name) {
    const base = String(name || "").split(/[\\/]/).pop().toLowerCase();
    const dot = base.lastIndexOf(".");
    if (dot < 0) return base === "dockerfile" || base === "makefile" ? base : "";
    const key = dot === 0 ? "" : base.slice(dot + 1);                  // ".env" has no extension
    return Object.prototype.hasOwnProperty.call(FENCE_LANGS, key) ? FENCE_LANGS[key] : "";
  }

  // A backtick fence longer than any backtick run in `content`, at least three.
  function fenceFor(content) {
    let longest = 0;
    for (const m of String(content).matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
    return "`".repeat(Math.max(3, longest + 1));
  }

  // One text attachment as it goes into the prompt: a 📎 header line, then the content fenced.
  function attachmentBlock(file) {
    const body = String(file.text == null ? "" : file.text).replace(/\r?\n$/, "");
    const fence = fenceFor(body);
    return `📎 ${displayName(file.name)}（${formatBytes(file.size)}）\n${fence}${fenceLanguage(file.name)}\n${body}\n${fence}`;
  }

  // The message text the agent receives: what the user typed, then each text attachment.
  function expandAttachments(text, files) {
    const parts = [];
    if (text) parts.push(text);
    for (const f of files || []) parts.push(attachmentBlock(f));
    return parts.join("\n\n");
  }

  // History keeps only this, never the content: "[file: notes.md, 3 KB]".
  function attachmentMarker(file) {
    return `[file: ${displayName(file && file.name)}, ${formatBytes(file && file.size)}]`;
  }

  // Send-time check of the text cap (bytes), per file and over all text files of one message. The
  // message to show the user, or null when the message may go. Never truncates (issue #85 (a)).
  function textCapError(files, capBytes) {
    const list = files || [];
    const over = list.filter((f) => f.size > capBytes).map((f) => displayName(f.name));
    if (over.length) {
      return `文字檔超過單次傳送上限 ${formatBytes(capBytes)}（${over.join("、")}），這則沒有送出。請移除該附件，或到設定 → 附加檔案調高上限。`;
    }
    const total = list.reduce((n, f) => n + f.size, 0);
    if (total > capBytes) {
      return `文字附件合計 ${formatBytes(total)}，超過單次傳送上限 ${formatBytes(capBytes)}，這則沒有送出。請移除部分附件，或到設定 → 附加檔案調高上限。`;
    }
    return null;
  }

  return {
    IMAGE_MIME_TYPES, MAX_TOTAL_IMAGE_B64, MAX_IMAGE_EDGE,
    canImage, classifyPaste, parseImageDataUrl, fitDimensions, stagedSize, fitsBudget, promptBlocks, historyText,
    SNIFF_BYTES, MAX_ATTACHMENTS, ATTACH_DEFAULTS, ATTACH_LIMITS, normalizeAttachConfig,
    sniffImage, looksLikeText, classifyFileBytes, decodeText, planDrop, formatBytes, displayName,
    fenceLanguage, fenceFor, attachmentBlock, expandAttachments, attachmentMarker, textCapError
  };
});
