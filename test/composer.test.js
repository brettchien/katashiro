// composer.test.js — pasted-image rules: paste classification, accepted types, size budget,
// capability gate and the prompt blocks sent over ACP.
const test = require("node:test");
const assert = require("node:assert/strict");
const Composer = require("../src/core/composer.js");

test("canImage reads initialize → agentCapabilities.promptCapabilities.image", () => {
  assert.equal(Composer.canImage({ agentCapabilities: { promptCapabilities: { image: true } } }), true);
  // The OpenAB gateway today: declares image:false.
  assert.equal(Composer.canImage({ agentCapabilities: { promptCapabilities: { image: false } } }), false);
  for (const res of [undefined, null, {}, { agentCapabilities: {} }, { agentCapabilities: { promptCapabilities: { image: "yes" } } }]) {
    assert.equal(Composer.canImage(res), false);
  }
});

test("classifyPaste stages a plain screenshot paste", () => {
  const plan = Composer.classifyPaste([{ kind: "file", type: "image/png" }]);
  assert.deepEqual(plan, { images: [0], rejected: [] });
});

test("classifyPaste leaves Office/Sheets copies (text/plain + text/html + image/png preview) as a text paste", () => {
  const items = [
    { kind: "string", type: "text/plain" },
    { kind: "string", type: "text/html" },
    { kind: "file", type: "image/png" }
  ];
  assert.deepEqual(Composer.classifyPaste(items), { images: [], rejected: [] });
});

test("classifyPaste stages a file copied in Finder/Explorer (file name as text/plain + the file)", () => {
  const items = [{ kind: "string", type: "text/plain" }, { kind: "file", type: "image/png" }];
  assert.deepEqual(Composer.classifyPaste(items), { images: [1], rejected: [] });
});

test("classifyPaste stages a browser 'Copy image' (text/html <img> + the image, no text/plain)", () => {
  const items = [{ kind: "string", type: "text/html" }, { kind: "file", type: "image/png" }];
  assert.deepEqual(Composer.classifyPaste(items), { images: [1], rejected: [] });
});

test("classifyPaste stages only png/jpeg/gif/webp and reports other image types once", () => {
  const items = [
    { kind: "file", type: "image/svg+xml" },
    { kind: "file", type: "image/jpeg" },
    { kind: "file", type: "image/svg+xml" },
    { kind: "file", type: "image/webp" },
    { kind: "file", type: "application/pdf" },
    { kind: "string", type: "text/html" }
  ];
  assert.deepEqual(Composer.classifyPaste(items), { images: [1, 3], rejected: ["image/svg+xml"] });
  assert.deepEqual(Composer.classifyPaste([]), { images: [], rejected: [] });
  assert.deepEqual(Composer.classifyPaste(undefined), { images: [], rejected: [] });
});

test("parseImageDataUrl accepts only base64 data URLs of the accepted types", () => {
  assert.deepEqual(Composer.parseImageDataUrl("data:image/png;base64,QUJD"), { mimeType: "image/png", data: "QUJD" });
  assert.deepEqual(Composer.parseImageDataUrl("data:IMAGE/JPEG;base64,QUJD"), { mimeType: "image/jpeg", data: "QUJD" });
  assert.equal(Composer.parseImageDataUrl("data:image/svg+xml;base64,QUJD"), null);
  assert.equal(Composer.parseImageDataUrl("data:image/png,raw"), null);
  assert.equal(Composer.parseImageDataUrl("https://x/a.png"), null);
  assert.equal(Composer.parseImageDataUrl(null), null);
});

test("fitDimensions caps the longest edge and keeps the aspect ratio", () => {
  assert.deepEqual(Composer.fitDimensions(800, 600, 1568), { width: 800, height: 600 });
  assert.deepEqual(Composer.fitDimensions(1568, 10, 1568), { width: 1568, height: 10 });
  assert.deepEqual(Composer.fitDimensions(3136, 1764, 1568), { width: 1568, height: 882 });
  assert.deepEqual(Composer.fitDimensions(1000, 4000, 1568), { width: 392, height: 1568 });
  assert.deepEqual(Composer.fitDimensions(100000, 1, 1568), { width: 1568, height: 1 }); // never 0
});

test("fitsBudget counts base64 across all of a turn's images", () => {
  const max = Composer.MAX_TOTAL_IMAGE_B64;
  const half = { data: "x".repeat(max / 2) };
  assert.equal(Composer.stagedSize([half, half]), max);
  assert.equal(Composer.fitsBudget([], max), true);
  assert.equal(Composer.fitsBudget([], max + 1), false);
  assert.equal(Composer.fitsBudget([half], max / 2), true);
  assert.equal(Composer.fitsBudget([half], max / 2 + 1), false);
  // Must stay under the ACP tunnel's per-frame cap (see browser-mcp.js screenshot comment).
  assert.ok(max <= 1024 * 1024);
});

test("promptBlocks: optional text first, then images; image-only turns have no text block", () => {
  const img = { mimeType: "image/png", data: "QUJD", dataUrl: "data:image/png;base64,QUJD" };
  assert.deepEqual(Composer.promptBlocks("hi", []), [{ type: "text", text: "hi" }]);
  assert.deepEqual(Composer.promptBlocks("hi", [img]), [
    { type: "text", text: "hi" },
    { type: "image", data: "QUJD", mimeType: "image/png" }      // dataUrl is not sent
  ]);
  assert.deepEqual(Composer.promptBlocks("", [img]), [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
  assert.deepEqual(Composer.promptBlocks("", undefined), []);
});

test("historyText leaves a marker for images that are not persisted", () => {
  assert.equal(Composer.historyText("hi", 0), "hi");
  assert.equal(Composer.historyText("", 1), "（1 張圖片未保存）");
  assert.equal(Composer.historyText("hi", 2), "hi\n\n（2 張圖片未保存）");
  // Dropped files leave one marker each (content never stored), after the image note.
  const files = [{ name: "notes.md", size: 3 * 1024, text: "secret" }, { name: "a.log", size: 10 }];
  assert.equal(Composer.historyText("", 0, files), "[file: notes.md, 3 KB]\n[file: a.log, 10 B]");
  assert.equal(Composer.historyText("hi", 1, files.slice(0, 1)), "hi\n\n（1 張圖片未保存）\n[file: notes.md, 3 KB]");
  assert.ok(!Composer.historyText("hi", 0, files).includes("secret"));
});

// --- Dropped files (ADR docs/adr/chat-attachments.md) -------------------------------------------

const bytes = (...xs) => Uint8Array.from(xs.flat());
const utf8 = (s) => new TextEncoder().encode(s);

test("sniffImage reads magic bytes only", () => {
  assert.equal(Composer.sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(Composer.sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(Composer.sniffImage(utf8("GIF89a")), "image/gif");
  assert.equal(Composer.sniffImage(utf8("RIFF\x10\x00\x00\x00WEBPVP8 ")), "image/webp");
  assert.equal(Composer.sniffImage(utf8("RIFF\x10\x00\x00\x00WAVEfmt ")), null);   // a WAV is RIFF too
  assert.equal(Composer.sniffImage(utf8("RIFF")), null);                          // too short for WEBP
  assert.equal(Composer.sniffImage(utf8("<svg xmlns=…>")), null);                 // SVG is not an image here
  assert.equal(Composer.sniffImage(bytes(0xff, 0xd8)), null);
  assert.equal(Composer.sniffImage(new Uint8Array(0)), null);
  assert.equal(Composer.sniffImage(undefined), null);
});

test("looksLikeText: NUL, strict UTF-8 (BOM, cut character) and the control-character ratio", () => {
  assert.equal(Composer.looksLikeText(utf8("hello\tworld\r\n\f"), true), true);
  assert.equal(Composer.looksLikeText(utf8("中文 / 日本語 / emoji 🐋"), true), true);
  assert.equal(Composer.looksLikeText(bytes(0xef, 0xbb, 0xbf, ...utf8("bom")), true), true);
  assert.equal(Composer.looksLikeText(new Uint8Array(0), true), true);
  assert.equal(Composer.looksLikeText(bytes(...utf8("abc"), 0, ...utf8("def")), true), false);   // NUL
  assert.equal(Composer.looksLikeText(bytes(0x61, 0xff, 0x62), true), false);                    // not UTF-8
  assert.equal(Composer.looksLikeText(bytes(0xc3, 0x28), true), false);                          // bad continuation
  // A multi-byte character cut by the 8 KB read: fine on a prefix, an error on a whole file.
  const cut = utf8("x".repeat(10) + "中").slice(0, 12);
  assert.equal(Composer.looksLikeText(cut, false), true);
  assert.equal(Composer.looksLikeText(cut, true), false);
  // Other C0 controls: up to 1% is text, more is binary.
  assert.equal(Composer.looksLikeText(utf8("\x01" + "a".repeat(99)), true), true);
  assert.equal(Composer.looksLikeText(utf8("\x01\x02" + "a".repeat(98)), true), false);
  // ESC is not counted: an ANSI-coloured log (~3% ESC) is text.
  const line = "\x1b[32m   Compiling\x1b[0m foo v0.1.0 (/tmp/foo)\n";
  assert.equal(Composer.looksLikeText(utf8(line.repeat(100)), true), true);
  // UTF-16 (BOM FF FE, or NULs in ASCII content) is refused, like any non-UTF-8 text.
  assert.equal(Composer.looksLikeText(bytes(0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65), true), false);
  assert.equal(Composer.looksLikeText(bytes(0x68, 0x00, 0x69, 0x00), true), false);
});

test("classifyFileBytes: image by magic, else text, else binary — never by name", () => {
  assert.deepEqual(Composer.classifyFileBytes(bytes(0x89, 0x50, 0x4e, 0x47), true), { kind: "image", mimeType: "image/png" });
  assert.deepEqual(Composer.classifyFileBytes(utf8("# notes\n"), true), { kind: "text" });
  assert.deepEqual(Composer.classifyFileBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00), true), { kind: "binary" }); // zip
  assert.deepEqual(Composer.classifyFileBytes(bytes(...utf8("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3), false), { kind: "binary" }); // PDF binary marker
  assert.deepEqual(Composer.classifyFileBytes(utf8("notes.png is just a name"), true), { kind: "text" });
  assert.equal(Composer.SNIFF_BYTES, 8192);
});

test("decodeText decodes strict UTF-8, drops a BOM, and refuses invalid bytes", () => {
  assert.equal(Composer.decodeText(bytes(0xef, 0xbb, 0xbf, ...utf8("hi 中"))), "hi 中");
  assert.equal(Composer.decodeText(bytes(...utf8("ok"), 0xff)), null);
  assert.equal(Composer.decodeText(new Uint8Array(0)), "");
  // The whole file is checked, not only the first 8 KB: a late NUL or control run is refused.
  assert.equal(Composer.decodeText(utf8("a".repeat(9000) + "\0")), null);
  assert.equal(Composer.decodeText(utf8("a".repeat(9000) + "\x01".repeat(200))), null);
});

test("normalizeAttachConfig: defaults 10 MB / 256 KB, clamped, junk falls back", () => {
  assert.deepEqual(Composer.normalizeAttachConfig(null), { maxFileMB: 10, textCapKB: 256 });
  assert.deepEqual(Composer.normalizeAttachConfig({ maxFileMB: "5", textCapKB: 512 }), { maxFileMB: 5, textCapKB: 512 });
  assert.deepEqual(Composer.normalizeAttachConfig({ maxFileMB: 0, textCapKB: 1e9 }), { maxFileMB: 1, textCapKB: 4096 });
  assert.deepEqual(Composer.normalizeAttachConfig({ maxFileMB: 999, textCapKB: -3 }), { maxFileMB: 20, textCapKB: 1 });
  assert.deepEqual(Composer.normalizeAttachConfig({ maxFileMB: "abc", textCapKB: "" }), { maxFileMB: 10, textCapKB: 256 });
});

test("planDrop refuses files over the size limit and past 10 attachments, in drop order", () => {
  const f = (size) => ({ size });
  assert.deepEqual(Composer.planDrop(0, [f(1), f(11), f(10)], 10), { accept: [0, 2], tooBig: [1], overCount: [] });
  assert.deepEqual(Composer.planDrop(8, [f(1), f(1), f(1), f(99)], 10), { accept: [0, 1], tooBig: [3], overCount: [2] });
  assert.deepEqual(Composer.planDrop(10, [f(1)], 10), { accept: [], tooBig: [], overCount: [0] });
  assert.deepEqual(Composer.planDrop(0, [], 10), { accept: [], tooBig: [], overCount: [] });
  assert.equal(Composer.MAX_ATTACHMENTS, 10);
});

test("formatBytes and displayName", () => {
  assert.equal(Composer.formatBytes(0), "0 B");
  assert.equal(Composer.formatBytes(1023), "1023 B");
  assert.equal(Composer.formatBytes(3 * 1024), "3 KB");
  assert.equal(Composer.formatBytes(256 * 1024), "256 KB");
  assert.equal(Composer.formatBytes(1024 * 1024), "1 MB");
  assert.equal(Composer.formatBytes(1.25 * 1024 * 1024), "1.3 MB");
  assert.equal(Composer.displayName("a\nb\r\n.md"), "a b .md");
  assert.equal(Composer.displayName(""), "file");
  assert.equal(Composer.displayName("a\u202etxt.exe"), "a txt.exe");             // RLO can't fake an extension
  assert.equal(Composer.displayName("a\u2066b\u2069\u200f\u0085c"), "a b c");
});

test("fenceLanguage comes from the extension (or a bare Dockerfile/Makefile) only", () => {
  assert.equal(Composer.fenceLanguage("notes.md"), "markdown");
  assert.equal(Composer.fenceLanguage("APP.PY"), "python");
  assert.equal(Composer.fenceLanguage("dir/x.config.json"), "json");
  assert.equal(Composer.fenceLanguage("Dockerfile"), "dockerfile");
  assert.equal(Composer.fenceLanguage("server.log"), "");
  assert.equal(Composer.fenceLanguage(".env"), "");
  assert.equal(Composer.fenceLanguage("README"), "");
  assert.equal(Composer.fenceLanguage("c"), "");                     // a bare name is not an extension
  assert.equal(Composer.fenceLanguage("x.constructor"), "");         // no prototype lookups
  assert.equal(Composer.fenceLanguage(undefined), "");
});

test("fenceFor is longer than any backtick run in the content, at least three", () => {
  assert.equal(Composer.fenceFor("plain"), "```");
  assert.equal(Composer.fenceFor("a `b` c"), "```");
  assert.equal(Composer.fenceFor("```js\nx\n```"), "````");
  assert.equal(Composer.fenceFor("`````"), "``````");
});

test("expandAttachments: typed text, then each file as a 📎 header + fenced block", () => {
  const notes = { name: "notes.md", size: 3 * 1024, text: "# Title\n\n```sh\nls\n```\n" };
  const log = { name: "a.log", size: 12, text: "line1\r\nline2" };
  assert.equal(Composer.attachmentBlock(notes), "📎 notes.md（3 KB）\n````markdown\n# Title\n\n```sh\nls\n```\n````");
  assert.equal(Composer.expandAttachments("please read", [notes, log]),
    "please read\n\n📎 notes.md（3 KB）\n````markdown\n# Title\n\n```sh\nls\n```\n````\n\n📎 a.log（12 B）\n```\nline1\r\nline2\n```");
  assert.equal(Composer.expandAttachments("", [log]), "📎 a.log（12 B）\n```\nline1\r\nline2\n```");
  assert.equal(Composer.expandAttachments("hi", []), "hi");
  assert.equal(Composer.attachmentMarker(notes), "[file: notes.md, 3 KB]");
});

test("textCapError refuses on send — per file and over the message total — never truncates", () => {
  const cap = 256 * 1024;
  assert.equal(Composer.textCapError([], cap), null);
  assert.equal(Composer.textCapError([{ name: "a.txt", size: cap }], cap), null);
  const one = Composer.textCapError([{ name: "big.txt", size: cap + 1 }, { name: "a.txt", size: 1 }], cap);
  assert.match(one, /big\.txt/);
  assert.doesNotMatch(one, /a\.txt/);
  assert.match(one, /256 KB/);
  const total = Composer.textCapError([{ name: "a.txt", size: cap / 2 }, { name: "b.txt", size: cap / 2 + 1 }], cap);
  assert.match(total, /合計/);
  assert.match(total, /沒有送出/);
});
