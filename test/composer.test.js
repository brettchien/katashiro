// composer.test.js — pasted-image rules: paste classification, accepted types, size budget,
// capability gate and the prompt blocks sent over ACP.
const test = require("node:test");
const assert = require("node:assert/strict");
const Composer = require("../composer.js");

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

test("classifyPaste leaves Office/Sheets copies (text/plain + image/png preview) as a text paste", () => {
  const items = [
    { kind: "string", type: "text/plain" },
    { kind: "string", type: "text/html" },
    { kind: "file", type: "image/png" }
  ];
  assert.deepEqual(Composer.classifyPaste(items), { images: [], rejected: [] });
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
});
