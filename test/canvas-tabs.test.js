// canvas-tabs.test.js — the §3.1 tab group and Split View decisions: group reuse vs create,
// beside refusals, two canvases, and moving a canvas tab back after a split.
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../canvas-tabs.js");

const BASE = "chrome-extension://abc/canvas.html";
const NONE = T.TAB_GROUP_NONE;
const tab = (o) => ({ id: 1, index: 0, windowId: 7, groupId: NONE, splitViewId: T.SPLIT_NONE, pinned: false, url: "https://example.com/", ...o });
const canvas = (o) => tab({ id: 10, index: 5, groupId: 3, url: `${BASE}?id=cv_000000000001`, ...o });

test("classifyTab: canvas tabs, web pages, and everything else", () => {
  assert.equal(T.classifyTab(tab({}), BASE), "web");
  assert.equal(T.classifyTab(tab({ url: "file:///tmp/a.html" }), BASE), "web");
  assert.equal(T.classifyTab(canvas({}), BASE), "canvas");
  assert.equal(T.classifyTab(tab({ url: "", pendingUrl: `${BASE}?id=cv_1` }), BASE), "canvas");
  assert.equal(T.classifyTab(canvas({ url: `${BASE}?id=cv_1&view=agent` }), BASE), "other");   // compare tab
  assert.equal(T.classifyTab(tab({ url: `${BASE}?x=1` }), BASE), "other");
  assert.equal(T.classifyTab(tab({ url: "chrome-extension://abc/sidepanel.html" }), BASE), "other");
  assert.equal(T.classifyTab(tab({ url: "chrome://newtab/" }), BASE), "other");
  assert.equal(T.classifyTab(tab({ url: undefined }), BASE), "other");
});

test("planCanvasGroup: reuse a live group in this window, else create", () => {
  assert.deepEqual(T.planCanvasGroup({ storedGroupId: 3, groups: [{ id: 3, windowId: 7 }], windowId: 7 }), { action: "reuse", groupId: 3 });
  // stale id: the group was deleted (or Chrome restarted)
  assert.deepEqual(T.planCanvasGroup({ storedGroupId: 3, groups: [], windowId: 7 }), { action: "create" });
  // the group lives in another window
  assert.deepEqual(T.planCanvasGroup({ storedGroupId: 3, groups: [{ id: 3, windowId: 8 }], windowId: 7 }), { action: "create" });
  assert.deepEqual(T.planCanvasGroup({ storedGroupId: null, groups: [], windowId: 7 }), { action: "create" });
  assert.deepEqual(T.planCanvasGroup({ storedGroupId: NONE, groups: [{ id: NONE, windowId: 7 }], windowId: 7 }), { action: "create" });
  assert.equal(T.GROUP_TITLE, "Canvas");
  assert.equal(T.GROUP_COLOR, "blue");
});

test("planBeside: a web page in a group pulls the canvas tab into that group, to be moved back", () => {
  const p = T.planBeside({ canvasTab: canvas({}), pageTab: tab({ id: 2, groupId: 9 }), canvasBase: BASE });
  assert.deepEqual(p, { ok: true, kind: "web", regroup: { groupId: 9 }, restore: { returnGroupId: 3, pageTabId: 2 } });
});

test("planBeside: an ungrouped page ungroups the canvas tab", () => {
  const p = T.planBeside({ canvasTab: canvas({}), pageTab: tab({ id: 2 }), canvasBase: BASE });
  assert.deepEqual(p.regroup, { groupId: NONE });
  assert.deepEqual(p.restore, { returnGroupId: 3, pageTabId: 2 });
  // a canvas tab the user already took out of the group: nothing to move
  assert.deepEqual(T.planBeside({ canvasTab: canvas({ groupId: NONE }), pageTab: tab({ id: 2 }), canvasBase: BASE }),
    { ok: true, kind: "web", regroup: null, restore: null });
});

test("planBeside: two canvases in the canvas group split directly", () => {
  const other = canvas({ id: 11, index: 6, url: `${BASE}?id=cv_000000000002` });
  assert.deepEqual(T.planBeside({ canvasTab: canvas({}), pageTab: other, canvasBase: BASE }),
    { ok: true, kind: "canvas", regroup: null, restore: null });
});

test("planBeside: refusals", () => {
  const reason = (canvasTab, pageTab) => T.planBeside({ canvasTab, pageTab, canvasBase: BASE }).reason;
  assert.match(reason(null, tab({})), /not open/);
  assert.match(reason(canvas({}), null), /no active tab/);
  assert.match(reason(canvas({}), canvas({})), /the canvas is the active tab/);
  assert.match(reason(canvas({}), tab({ id: 2, url: "chrome://settings/" })), /not a web page/);
  assert.match(reason(canvas({}), tab({ id: 2, url: `${BASE}?id=cv_000000000001&view=agent` })), /not a web page/);
  assert.match(reason(canvas({}), tab({ id: 2, url: "chrome-extension://abc/sidepanel.html" })), /not a web page/);
  assert.match(reason(canvas({ windowId: 8 }), tab({ id: 2 })), /another window/);
  assert.match(reason(canvas({ splitViewId: 4 }), tab({ id: 2 })), /canvas is already in a Split View/);
  assert.match(reason(canvas({}), tab({ id: 2, splitViewId: 4 })), /page is already in a Split View/);
  assert.match(reason(canvas({}), tab({ id: 2, pinned: true })), /pinned/);
});

test("adjacentIndex and splitBlocker follow split_tabs' rule", () => {
  assert.equal(T.adjacentIndex({ index: 2 }, { index: 3 }), null);
  assert.equal(T.adjacentIndex({ index: 2 }, { index: 1 }), null);
  assert.equal(T.adjacentIndex({ index: 2 }, { index: 7 }), 3);
  assert.equal(T.adjacentIndex({ index: 5 }, { index: 1 }), 5);           // a shifts left once b is lifted
  assert.equal(T.splitBlocker(canvas({ groupId: 9 }), tab({ id: 2, groupId: 9 })), null);
  assert.match(T.splitBlocker(canvas({}), tab({ id: 2 })), /different tab groups/);
  assert.match(T.splitBlocker(canvas({ groupId: NONE, windowId: 8 }), tab({ id: 2 })), /another window/);
});

test("planRestore: back into a live canvas group", () => {
  const record = { movedToGroupId: 9, windowId: 7, returnGroupId: 3, canvasGroup: true };
  assert.deepEqual(T.planRestore({ canvasTab: canvas({ groupId: 9 }), record, groups: [{ id: 3, windowId: 7 }] }), { action: "group", groupId: 3 });
  // moved out of an ungrouped page's side
  const r2 = { movedToGroupId: NONE, windowId: 7, returnGroupId: 3, canvasGroup: true };
  assert.deepEqual(T.planRestore({ canvasTab: canvas({ groupId: NONE }), record: r2, groups: [{ id: 3, windowId: 7 }] }), { action: "group", groupId: 3 });
});

test("planRestore: the canvas group is gone (it was the only tab) → recreate; another group gone → leave", () => {
  const record = { movedToGroupId: NONE, windowId: 7, returnGroupId: 3, canvasGroup: true };
  assert.deepEqual(T.planRestore({ canvasTab: canvas({ groupId: NONE }), record, groups: [] }), { action: "recreate" });
  assert.equal(T.planRestore({ canvasTab: canvas({ groupId: NONE }), record: { ...record, canvasGroup: false }, groups: [] }).action, "none");
  // a group with that id in another window is not ours
  assert.deepEqual(T.planRestore({ canvasTab: canvas({ groupId: NONE }), record, groups: [{ id: 3, windowId: 8 }] }), { action: "recreate" });
});

test("planRestore: leaves the tab alone if it is gone, still split, or the user moved it", () => {
  const record = { movedToGroupId: 9, windowId: 7, returnGroupId: 3, canvasGroup: true };
  const groups = [{ id: 3, windowId: 7 }];
  assert.equal(T.planRestore({ canvasTab: null, record, groups }).action, "none");
  assert.equal(T.planRestore({ canvasTab: canvas({ groupId: 9, splitViewId: 2 }), record, groups }).action, "none");
  assert.equal(T.planRestore({ canvasTab: canvas({ groupId: 12 }), record, groups }).why, "moved by the user");
  assert.equal(T.planRestore({ canvasTab: canvas({ groupId: 9, windowId: 8 }), record, groups }).why, "moved by the user");
});

test("planRestore: a tab that was ungrouped before goes back to ungrouped", () => {
  const record = { movedToGroupId: 9, windowId: 7, returnGroupId: NONE, canvasGroup: false };
  assert.deepEqual(T.planRestore({ canvasTab: canvas({ groupId: 9 }), record, groups: [] }), { action: "ungroup" });
});

// --- Compare with agent's (§3.10) -----------------------------------------------------------------

const cmpUrl = (id) => T.compareTabUrl(BASE, id);

test("compare tab URL: view=agent, recognised per canvas id, never a canvas tab", () => {
  assert.equal(cmpUrl("cv_000000000001"), `${BASE}?id=cv_000000000001&view=agent`);
  const cmp = tab({ id: 11, url: cmpUrl("cv_000000000001") });
  assert.equal(T.isCompareTabFor(cmp, BASE, "cv_000000000001"), true);
  assert.equal(T.isCompareTabFor(cmp, BASE, "cv_000000000002"), false);
  assert.equal(T.isCompareTabFor(canvas({}), BASE, "cv_000000000001"), false);              // the canvas itself
  assert.equal(T.isCompareTabFor(tab({ url: "https://evil/canvas.html?id=cv_000000000001&view=agent" }), BASE, "cv_000000000001"), false);
  assert.equal(T.isCompareTabFor(tab({ url: "", pendingUrl: cmpUrl("cv_000000000001") }), BASE, "cv_000000000001"), true);
  assert.equal(T.classifyTab(cmp, BASE), "other");
});

test("planCompare: focus an existing compare split, else end the current split and open a new one", () => {
  const c = canvas({});
  assert.deepEqual(T.planCompare({ canvasTab: null, compareTab: null, canSplit: true }), { ok: false, reason: "the canvas tab is gone" });
  assert.deepEqual(T.planCompare({ canvasTab: c, compareTab: null, canSplit: true }),
    { ok: true, action: "open", closeOld: null, unsplit: null, split: true });
  // Split beside a web page (§3.1): that split ends first.
  assert.deepEqual(T.planCompare({ canvasTab: canvas({ splitViewId: 4 }), compareTab: null, canSplit: true }),
    { ok: true, action: "open", closeOld: null, unsplit: 4, split: true });
  // Already compared side by side: just focus.
  const pair = tab({ id: 11, splitViewId: 4, url: cmpUrl("cv_000000000001") });
  assert.deepEqual(T.planCompare({ canvasTab: canvas({ splitViewId: 4 }), compareTab: pair, canSplit: true }), { ok: true, action: "focus" });
  // A stray compare tab (not split with it) is replaced.
  const stray = tab({ id: 12, url: cmpUrl("cv_000000000001") });
  assert.deepEqual(T.planCompare({ canvasTab: c, compareTab: stray, canSplit: true }),
    { ok: true, action: "open", closeOld: 12, unsplit: null, split: true });
  // Chrome < 155: a normal tab; an open one in the same window is focused.
  assert.deepEqual(T.planCompare({ canvasTab: c, compareTab: null, canSplit: false }),
    { ok: true, action: "open", closeOld: null, unsplit: null, split: false });
  assert.deepEqual(T.planCompare({ canvasTab: c, compareTab: stray, canSplit: false }), { ok: true, action: "focus" });
  assert.deepEqual(T.planCompare({ canvasTab: c, compareTab: { ...stray, windowId: 8 }, canSplit: false }),
    { ok: true, action: "open", closeOld: 12, unsplit: null, split: false });
});

test("compareTabProps: right after the canvas tab, same window and pin; background only when it will be split", () => {
  assert.deepEqual(T.compareTabProps(canvas({ pinned: true }), "u", true), { url: "u", windowId: 7, index: 6, pinned: true, active: false });
  assert.deepEqual(T.compareTabProps(canvas({}), "u", false), { url: "u", windowId: 7, index: 6, pinned: false, active: true });
});
