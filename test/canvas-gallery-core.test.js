// canvas-gallery-core.test.js — the canvas gallery (ADR §3.7): rows from metas, newest first,
// title / content search with NFKC + case folding, the content-read cap, and formatting.
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../src/core/canvas-gallery-core.js");

const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();    // local time, so formats are TZ-independent
const meta = (o) => ({
  id: "cv_000000000001", conversationId: "c_0123456789ab", title: "Plan", kind: "markdown",
  version: 1, author: "agent", at: NOW - 5 * 60 * 1000, agentVersion: 1, bytes: 100, agentBytes: 0, ...o,
});

test("buildRows: newest first, stable ties, labels, footprint size; malformed metas skipped", () => {
  const rows = G.buildRows([
    meta({ id: "cv_000000000001", title: "Old", at: NOW - 3 * 86400 * 1000 }),
    meta({ id: "cv_000000000002", title: "New", at: NOW - 30 * 1000, kind: "slides", author: "user", version: 4, bytes: 2048, agentBytes: 1024 }),
    meta({ id: "cv_000000000004", title: "Same", at: NOW - 3600 * 1000, kind: "image", author: "file" }),
    meta({ id: "cv_000000000003", title: "Same", at: NOW - 3600 * 1000 }),
    null, "x", { title: "no id" },
  ], { now: NOW });
  assert.deepEqual(rows.map((r) => r.id), ["cv_000000000002", "cv_000000000003", "cv_000000000004", "cv_000000000001"]);
  const [n, , img, old] = rows;
  assert.equal(n.icon, "🖼️");
  assert.equal(n.kindLabel, "投影片");
  assert.equal(n.author, "你");
  assert.equal(n.version, 4);
  assert.equal(n.bytes, 3072);                           // latest + agent copy (§3.6 footprint)
  assert.equal(n.size, "3.0 KB");
  assert.equal(n.timeRel, "剛剛");
  assert.equal(n.timeAbs, "2026-10-11 11:59");
  assert.equal(n.conversation, "c_012345");
  assert.equal(n.conversationId, "c_0123456789ab");
  assert.equal(img.icon, "🏞️");
  assert.equal(img.author, "資料夾檔案");
  assert.equal(old.timeRel, "3 天前");
});

test("buildRows: missing fields degrade, titles are capped", () => {
  const [r] = G.buildRows([{ id: "cv_000000000009", title: "x".repeat(300) }], { now: NOW });
  assert.equal(r.title.length, 120);
  assert.equal(r.kind, "markdown");
  assert.equal(r.version, 0);
  assert.equal(r.timeRel, "");
  assert.equal(r.conversation, "（未知對話）");
  assert.equal(r.size, "0 B");
});

test("relativeTime / absoluteTime / formatSize", () => {
  assert.equal(G.relativeTime(NOW + 5000, NOW), "剛剛");             // a clock a little ahead
  assert.equal(G.relativeTime(NOW - 59 * 1000, NOW), "剛剛");
  assert.equal(G.relativeTime(NOW - 60 * 1000, NOW), "1 分鐘前");
  assert.equal(G.relativeTime(NOW - 2 * 3600 * 1000, NOW), "2 小時前");
  assert.equal(G.relativeTime(NOW - 29 * 86400 * 1000, NOW), "29 天前");
  assert.equal(G.relativeTime(new Date(2026, 0, 2, 3, 4).getTime(), NOW), "2026-01-02");
  assert.equal(G.absoluteTime(new Date(2026, 0, 2, 3, 4).getTime()), "2026-01-02 03:04");
  assert.equal(G.absoluteTime(NaN), "");
  assert.equal(G.formatSize(0), "0 B");
  assert.equal(G.formatSize(1023), "1023 B");
  assert.equal(G.formatSize(1536), "1.5 KB");
  assert.equal(G.formatSize(200 * 1024), "200 KB");
  assert.equal(G.formatSize(5.25 * 1024 * 1024), "5.3 MB");
  assert.equal(G.formatSize(200 * 1024 * 1024), "200 MB");
});

test("queryTerms / normalize: NFKC + lower case, whitespace-split", () => {
  assert.deepEqual(G.queryTerms("  Ｑ３  Plan "), ["q3", "plan"]);
  assert.deepEqual(G.queryTerms(""), []);
  assert.deepEqual(G.queryTerms(null), []);
  assert.equal(G.normalize("ＡＢＣ　ｄｅｆ"), "abc def");
});

test("filterRows: every term in the title (or conversation label); empty query shows all", () => {
  const rows = G.buildRows([
    meta({ id: "cv_000000000001", title: "Q3 營運計畫" }),
    meta({ id: "cv_000000000002", title: "Weekly notes", conversationId: "c_ffffff000000" }),
  ], { now: NOW });
  assert.equal(G.filterRows(rows, "").length, 2);
  assert.deepEqual(G.filterRows(rows, "ｑ３ 計畫").map((r) => r.id), ["cv_000000000001"]);
  assert.deepEqual(G.filterRows(rows, "q3 weekly").map((r) => r.id), []);    // AND, not OR
  assert.deepEqual(G.filterRows(rows, "c_ffff").map((r) => r.id), ["cv_000000000002"]);
  assert.equal(G.filterRows(rows, "WEEKLY")[0].snippet, undefined);         // a title hit has no snippet
});

test("filterRows: content hits only at the row's current rev, with a snippet", () => {
  const rows = G.buildRows([meta({ id: "cv_000000000001", title: "Plan", version: 3 })], { now: NOW });
  const text = G.normalize("# Intro\n\nThe budget for Q4 is approved.\nMore text follows here.");
  const contents = new Map([["cv_000000000001", { rev: "3", text }]]);
  const [hit] = G.filterRows(rows, "Budget q4", contents);
  assert.equal(hit.id, "cv_000000000001");
  assert.match(hit.snippet, /the budget for q4 is approved/);
  // an older read must not match: the canvas changed since
  contents.set("cv_000000000001", { rev: "2", text });
  assert.equal(G.filterRows(rows, "budget", contents).length, 0);
  // applyNormalized rewrites latest without a version bump: a pre-normalization read is stale too
  contents.set("cv_000000000001", { rev: "3", text });
  const normalized = G.buildRows([meta({ id: "cv_000000000001", title: "Plan", version: 3, normalized: true })], { now: NOW });
  assert.equal(normalized[0].rev, "3n");
  assert.equal(G.filterRows(normalized, "budget", contents).length, 0);
});

test("buildRows: canvases left by incognito windows (noMirror, before #109) are not listed", () => {
  const rows = G.buildRows([meta({ id: "cv_000000000001" }), meta({ id: "cv_000000000002", noMirror: true })], { now: NOW });
  assert.deepEqual(rows.map((r) => r.id), ["cv_000000000001"]);
});

test("snippet: around the earliest hit, ellipses where cut, whitespace collapsed", () => {
  const t = `${"a".repeat(100)} needle\n\n${"b".repeat(100)}`;
  const s = G.snippet(t, ["needle"], 10);
  assert.ok(s.startsWith("…") && s.endsWith("…"));
  assert.match(s, /a+ needle b+/);
  assert.equal(G.snippet("short needle", ["needle"], 40), "short needle");
  assert.equal(G.snippet("nothing here", ["needle"]), "");
});

test("planContentReads: text kinds only, skips what is cached at the current rev, capped", () => {
  const rows = G.buildRows([
    meta({ id: "cv_000000000001", at: NOW - 1, bytes: 600 }),
    meta({ id: "cv_000000000002", at: NOW - 2, kind: "slides", bytes: 600 }),
    meta({ id: "cv_000000000003", at: NOW - 3, kind: "image", bytes: 10 }),
    meta({ id: "cv_000000000004", at: NOW - 4, bytes: 10, version: 2 }),
    meta({ id: "cv_000000000005", at: NOW - 5, bytes: 10 }),
  ], { now: NOW });
  const cache = new Map([["cv_000000000004", { rev: "2", text: "" }], ["cv_000000000005", { rev: "0", text: "" }]]);
  assert.deepEqual(G.planContentReads(rows, cache), { ids: ["cv_000000000001", "cv_000000000002", "cv_000000000005"], skipped: 0 });
  // byte cap: the newest first, the rest skipped (searched by title only)
  assert.deepEqual(G.planContentReads(rows, cache, { maxBytes: 1000 }), { ids: ["cv_000000000001", "cv_000000000005"], skipped: 1 });
  assert.deepEqual(G.planContentReads(rows, cache, { maxCount: 1 }), { ids: ["cv_000000000001"], skipped: 2 });
});

test("mermaid canvases: their own icon and label, and their source is searchable", () => {
  assert.equal(G.KIND_ICONS.mermaid, "🔀");
  assert.equal(G.KIND_LABELS.mermaid, "Mermaid 圖表");
  assert.ok(G.TEXT_KINDS.has("mermaid"));
});

test("buildRows: with CanvasStore.footprint the size is the whole version history (§3.5, §3.6)", () => {
  const CanvasStore = require("../src/core/canvas-store.js");
  const history = [{ v: 2, bytes: 1024 }, { v: 3, bytes: 1024 }, { v: 4, bytes: 2048 }];
  const [r] = G.buildRows([meta({ id: "cv_000000000001", version: 4, bytes: 2048, history })], { now: NOW, footprint: CanvasStore.footprint });
  assert.equal(r.bytes, 4096);
  assert.equal(r.size, "4.0 KB");
  // A canvas stored before history: latest + agent copy, as before.
  const [old] = G.buildRows([meta({ id: "cv_000000000002", version: 2, agentVersion: 1, bytes: 100, agentBytes: 50 })], { now: NOW, footprint: CanvasStore.footprint });
  assert.equal(old.bytes, 150);
});

test("queryFromHash (canvas_gallery, ADR §3.11): #q= decoded, control/bidi characters dropped, capped", () => {
  assert.equal(G.queryFromHash(""), null);
  assert.equal(G.queryFromHash("#"), null);
  assert.equal(G.queryFromHash("#top"), null);
  assert.equal(G.queryFromHash("#x=1"), null);
  assert.equal(G.queryFromHash("#q="), "");
  assert.equal(G.queryFromHash(`#q=${encodeURIComponent("設計 ADR")}`), "設計 ADR");
  assert.equal(G.queryFromHash(`#q=${encodeURIComponent("a+b&c")}`), "a+b&c");
  assert.equal(G.queryFromHash(`#q=${encodeURIComponent("  a\n\tb‮c\u0000d  ")}`), "a b c d");
  assert.equal(G.queryFromHash(`#q=${encodeURIComponent("de\u200bsign\u200c\u200d\u2060\ufeff")}`), "design");   // zero-width: dropped, not spaced
  assert.equal(G.queryFromHash(`#q=${encodeURIComponent("<img src=x onerror=1>")}`), "<img src=x onerror=1>");   // a value, never markup
  assert.equal(typeof G.queryFromHash("#q=%E0%A4%A"), "string");                                                   // malformed escape: lenient, no throw
  const long = G.queryFromHash(`#q=${encodeURIComponent("😀".repeat(300))}`);
  assert.equal(Array.from(long).length, G.QUERY_MAX);
});

test("buildRows: the 對話 column shows the conversation's title when known (multi-conversation §3.3)", () => {
  const rows = G.buildRows([
    { id: "cv_000000000001", conversationId: "c_0123456789ab", title: "A", at: 2 },
    { id: "cv_000000000002", conversationId: "c_ba9876543210", title: "B", at: 1 },
  ], { now: NOW, titles: { c_0123456789ab: "  Release plan " } });
  assert.equal(rows[0].conversation, "Release plan");
  assert.equal(rows[1].conversation, "c_ba9876");
  assert.equal(G.conversationLabel("c_0123456789ab", { c_0123456789ab: "   " }), "c_012345");
});

test("conversationDeleteSummary: that conversation's canvases, stored versions, distinct images, bytes, mirrored", () => {
  const CanvasStore = require("../src/core/canvas-store.js");
  const metas = [
    { id: "cv_000000000001", conversationId: "c_a", version: 3, bytes: 10, history: [{ v: 1, bytes: 5 }, { v: 2, bytes: 6 }, { v: 3, bytes: 10 }] },
    { id: "cv_000000000002", conversationId: "c_a", kind: "image", version: 2, bytes: 120, file: { folder: "f" },
      history: [{ v: 1, bytes: 120, image: "h1", imageBytes: 100 }, { v: 2, bytes: 120, image: "h1", imageBytes: 100 }] },
    { id: "cv_000000000003", conversationId: "c_b", version: 1, bytes: 99, filesByFolder: { f: {} } },
    { id: "cv_000000000004", conversationId: "c_a", version: 2, bytes: 4, agentVersion: 1, agentBytes: 3 },   // before history
    null, { conversationId: "c_a" },
  ];
  const s = G.conversationDeleteSummary(metas, "c_a", { historyOf: CanvasStore.historyOf, footprint: CanvasStore.footprint });
  assert.deepEqual(s, { canvases: 3, versions: 7, images: 1, bytes: 21 + 140 + 7, mirrored: true });
  assert.deepEqual(G.conversationDeleteSummary(metas, "c_b"), { canvases: 1, versions: 1, images: 0, bytes: 99, mirrored: true });
  assert.deepEqual(G.conversationDeleteSummary(metas, "c_none"), { canvases: 0, versions: 0, images: 0, bytes: 0, mirrored: false });
});
