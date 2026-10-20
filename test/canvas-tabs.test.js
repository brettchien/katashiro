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

test("pickCanvasTab: the most recently used tab of that canvas, never a compare tab or another canvas", () => {
  const id = "cv_000000000001";
  const url = T.canvasTabUrl(BASE, id);
  assert.equal(url, `${BASE}?id=cv_000000000001`);
  const older = canvas({ id: 10, lastAccessed: 100 });
  const newer = canvas({ id: 11, lastAccessed: 200 });
  const compare = canvas({ id: 12, lastAccessed: 999, url: T.compareTabUrl(BASE, id) });
  const other = canvas({ id: 13, lastAccessed: 999, url: T.canvasTabUrl(BASE, "cv_000000000002") });
  assert.equal(T.pickCanvasTab([older, compare, newer, other], BASE, id).id, 11);
  assert.equal(T.pickCanvasTab([compare, other], BASE, id), null);
  assert.equal(T.pickCanvasTab([], BASE, id), null);
  // a tab still loading has only pendingUrl; without lastAccessed the first one listed wins
  assert.equal(T.pickCanvasTab([tab({ id: 20, url: "", pendingUrl: url }), canvas({ id: 21 })], BASE, id).id, 20);
});

test("isGalleryTab / openGalleryTab: one gallery tab, reused (most recent) or opened in the given window", async () => {
  const G = "chrome-extension://abc/canvas-gallery.html";
  assert.ok(T.isGalleryTab(tab({ url: G }), G));
  assert.ok(T.isGalleryTab(tab({ url: `${G}?q=x` }), G));
  assert.ok(T.isGalleryTab(tab({ url: "", pendingUrl: `${G}#top` }), G));
  assert.ok(!T.isGalleryTab(tab({ url: `${G}x` }), G));
  assert.ok(!T.isGalleryTab(canvas({}), G));
  assert.ok(!T.isGalleryTab(tab({ url: undefined }), G));

  const calls = [];
  const api = (tabs) => ({
    tabs: {
      query: async () => tabs,
      update: async (id, p) => { calls.push(["update", id, p]); },
      create: async (p) => { calls.push(["create", p]); return { id: 99, ...p }; },
    },
    windows: { update: async (id, p) => { calls.push(["window", id, p]); } },
  });
  const got = await T.openGalleryTab(api([tab({ id: 5, windowId: 2, url: G, lastAccessed: 1 }), tab({ id: 6, windowId: 3, url: G, lastAccessed: 9 })]), G, { windowId: 7 });
  assert.equal(got.id, 6);
  assert.deepEqual(calls, [["update", 6, { active: true }], ["window", 3, { focused: true }]]);
  calls.length = 0;
  await T.openGalleryTab(api([canvas({})]), G, { windowId: 7 });
  assert.deepEqual(calls, [["create", { url: G, active: true, windowId: 7 }]]);
  calls.length = 0;
  await T.openGalleryTab(api([]), G);
  assert.deepEqual(calls, [["create", { url: G, active: true }]]);
});

test("galleryUrl / openGalleryTab with a query (canvas_gallery, §3.11): #q= on a new or the open tab", async () => {
  const G = "chrome-extension://abc/canvas-gallery.html";
  assert.equal(T.galleryUrl(G), G);
  assert.equal(T.galleryUrl(G, null), G);
  assert.equal(T.galleryUrl(G, ""), `${G}#q=`);
  assert.equal(T.galleryUrl(G, "a b&c#+"), `${G}#q=a%20b%26c%23%2B`);
  const calls = [];
  const api = (tabs) => ({
    tabs: {
      query: async () => tabs,
      update: async (id, p) => { calls.push(["update", id, p]); },
      create: async (p) => { calls.push(["create", p]); return { id: 99, ...p }; },
    },
    windows: { update: async (id, p) => { calls.push(["window", id, p]); } },
  });
  await T.openGalleryTab(api([tab({ id: 6, windowId: 3, url: G })]), G, { query: "plan" });
  assert.deepEqual(calls, [["update", 6, { url: `${G}#q=plan`, active: true }], ["window", 3, { focused: true }]]);
  calls.length = 0;
  await T.openGalleryTab(api([]), G, { windowId: 7, query: "設計" });
  assert.deepEqual(calls, [["create", { url: `${G}#q=${encodeURIComponent("設計")}`, active: true, windowId: 7 }]]);
});

test("compareTabsFor: every compare tab of that canvas, never the canvas tab or another canvas's", () => {
  const id = "cv_000000000001";
  const tabs = [
    canvas({ id: 10 }),
    canvas({ id: 11, url: `${BASE}?id=${id}&view=agent` }),
    canvas({ id: 12, url: "", pendingUrl: `${BASE}?id=${id}&view=agent` }),
    canvas({ id: 13, url: `${BASE}?id=cv_000000000002&view=agent` }),
    tab({ id: 14, url: `https://example.com/?id=${id}&view=agent` }),
  ];
  assert.deepEqual(T.compareTabsFor(tabs, BASE, id).map((t) => t.id), [11, 12]);
  assert.deepEqual(T.compareTabsFor([], BASE, id), []);
});

// --- one tab group per conversation (multi-conversation ADR §4) ------------------------------------
const web = (id, url, o) => tab({ id, index: id, url, ...o });

test("restorableUrl / groupTabUrls: canvases and web pages of the group, in tab order, once", () => {
  assert.equal(T.restorableUrl(canvas({}), BASE), `${BASE}?id=cv_000000000001`);
  assert.equal(T.restorableUrl(tab({ url: "chrome://newtab/" }), BASE), null);
  assert.equal(T.restorableUrl(canvas({ url: `${BASE}?id=cv_1&view=agent` }), BASE), null);   // compare tab
  const tabs = [
    web(3, "https://b.example/", { groupId: 5, index: 3 }),
    web(1, "https://a.example/", { groupId: 5, index: 1 }),
    web(2, "chrome://newtab/", { groupId: 5, index: 2 }),
    web(4, "https://a.example/", { groupId: 5, index: 4 }),
    web(6, "https://other.example/", { groupId: 6, index: 6 }),
    canvas({ id: 7, index: 7, groupId: 5 }),
  ];
  assert.deepEqual(T.groupTabUrls(tabs, 5, BASE), ["https://a.example/", "https://b.example/", `${BASE}?id=cv_000000000001`]);
  assert.deepEqual(T.groupTabUrls(tabs, NONE, BASE), []);
  assert.deepEqual(T.groupTabUrls(tabs, null, BASE), []);
});

test("planGroupRestore: adopt what is open (no duplicates), open the rest, reuse Chrome's restored group", () => {
  const tabs = [
    web(1, "https://a.example/", { groupId: 40 }),
    web(2, "https://b.example/", { groupId: 40 }),
    web(3, "https://c.example/", { pinned: true }),
    web(4, "https://d.example/", { groupId: 9 }),                // another open conversation's group
    web(5, "https://e.example/", { windowId: 8 }),              // another window
    web(6, "https://f.example/", { splitViewId: 2 }),
  ];
  const p = T.planGroupRestore({
    urls: ["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/", "https://e.example/", "https://f.example/", "https://g.example/", "https://g.example/"],
    tabs, windowId: 7, otherGroupIds: [9],
  });
  assert.deepEqual(p.adopt, [1, 2]);
  assert.equal(p.reuseGroupId, 40);
  // pinned / split matches are open already: not opened again; d (another conversation's) and e (another window) are
  assert.deepEqual(p.open, ["https://d.example/", "https://e.example/", "https://g.example/"]);
  // adopted tabs from two groups (or ungrouped): no reuse
  const q = T.planGroupRestore({ urls: ["https://a.example/", "https://x.example/"], tabs: [...tabs, web(9, "https://x.example/")], windowId: 7, otherGroupIds: new Set() });
  assert.deepEqual(q.adopt, [1, 9]);
  assert.equal(q.reuseGroupId, null);
  // a URL saved twice is one tab
  const r = T.planGroupRestore({ urls: ["https://z.example/", "https://z.example/"], tabs: [web(1, "https://z.example/")], windowId: 7 });
  assert.deepEqual(r, { adopt: [1], open: [], reuseGroupId: null });
  assert.deepEqual(T.planGroupRestore({ urls: null, tabs, windowId: 7 }), { adopt: [], open: [], reuseGroupId: null });
});

test("otherGroupIds: every other conversation's group through the lookup (storage-backed after a panel reload)", async () => {
  const stored = new Map([["a", 10], ["b", 20], ["c", 20], ["d", null]]);
  const lookup = async (id) => (stored.has(id) ? stored.get(id) : null);
  assert.deepEqual(await T.otherGroupIds(["a", "b", "c", "d", "e"], "a", lookup), [20]);
  assert.deepEqual(await T.otherGroupIds(["a", "b"], "x", lookup), [10, 20]);
  assert.deepEqual(await T.otherGroupIds(null, "a", lookup), []);
  // the restore then neither adopts B's same-URL tab nor reuses B's group
  const others = await T.otherGroupIds(["a", "b"], "a", lookup);
  const p = T.planGroupRestore({ urls: ["https://s.example/"], tabs: [web(1, "https://s.example/", { groupId: 20 })], windowId: 7, otherGroupIds: others });
  assert.deepEqual(p, { adopt: [], open: ["https://s.example/"], reuseGroupId: null });
});

test("pickWorkingTab: same id + same origin, else the exact URL (ids are reused after a restart), else none", () => {
  const tabs = [web(1, "https://a.example/page2"), web(2, "https://b.example/x"), web(3, "https://c.example/")];
  assert.equal(T.pickWorkingTab({ saved: { id: 1, url: "https://a.example/page1" }, tabs }).id, 1);
  // id 2 now shows another site: not it; no tab has the URL either
  assert.equal(T.pickWorkingTab({ saved: { id: 2, url: "https://a.example/page1" }, tabs }), null);
  assert.equal(T.pickWorkingTab({ saved: { id: 99, url: "https://c.example/" }, tabs }).id, 3);
  assert.equal(T.pickWorkingTab({ saved: { id: 2, url: "https://c.example/" }, tabs }).id, 3);
  assert.equal(T.pickWorkingTab({ saved: null, tabs }), null);
  assert.equal(T.pickWorkingTab({ saved: { id: 1 }, tabs }), null);
});

test("planGroupSwitch (Q5): never collapses a group; expands the new one; activate step moves off another conversation's group", () => {
  const tabs = [
    web(1, "https://old.example/", { groupId: 10, active: true, lastAccessed: 50 }),
    web(2, "https://new.example/", { groupId: 20, lastAccessed: 10 }),
    web(3, "https://new2.example/", { groupId: 20, lastAccessed: 30 }),
    web(4, "https://free.example/", { lastAccessed: 40 }),
  ];
  // the result has no collapse list: the other groups stay as they are
  assert.deepEqual(Object.keys(T.planGroupSwitch({ tabs, groupId: 20, otherGroupIds: [10] })).sort(), ["activate", "expand"]);
  // the working tab wins when it is outside the other conversations' groups
  assert.deepEqual(T.planGroupSwitch({ tabs, groupId: 20, otherGroupIds: [10], workingTabId: 4 }), { activate: 4, expand: 20 });
  // no working tab: the new group's most recently used tab
  assert.deepEqual(T.planGroupSwitch({ tabs, groupId: 20, otherGroupIds: [10] }), { activate: 3, expand: 20 });
  // a working tab inside another conversation's group does not count
  assert.deepEqual(T.planGroupSwitch({ tabs, groupId: 20, otherGroupIds: [10], workingTabId: 1 }), { activate: 3, expand: 20 });
  // no group for the new conversation: the most recently used free tab
  assert.deepEqual(T.planGroupSwitch({ tabs, groupId: null, otherGroupIds: [10, 20] }), { activate: 4, expand: null });
  // the active tab is outside the other groups: nothing to activate; a gone group is not expanded
  const calm = tabs.map((t) => ({ ...t, active: t.id === 4 }));
  assert.deepEqual(T.planGroupSwitch({ tabs: calm, groupId: 20, otherGroupIds: [10, 77] }), { activate: null, expand: 20 });
  assert.deepEqual(T.planGroupSwitch({ tabs: calm, groupId: 77, otherGroupIds: [10] }), { activate: null, expand: null });
  // the active tab is in the new conversation's own group: stays
  const own = tabs.map((t) => ({ ...t, active: t.id === 2 }));
  assert.deepEqual(T.planGroupSwitch({ tabs: own, groupId: 20, otherGroupIds: [10] }), { activate: null, expand: 20 });
  // every tab is in another conversation's group: nowhere to go
  const all = [web(1, "https://old.example/", { groupId: 10, active: true })];
  assert.deepEqual(T.planGroupSwitch({ tabs: all, groupId: null, otherGroupIds: [10] }), { activate: null, expand: null });
});

test("planArchiveClose: close the group's tabs, keep dirty canvases, never empty the window", () => {
  const tabs = [web(1, "https://a.example/", { groupId: 5 }), canvas({ id: 2, groupId: 5 }), web(3, "https://mine.example/")];
  assert.deepEqual(T.planArchiveClose({ tabs, groupId: 5, dirtyIds: [2] }), { close: [1], keep: [2], needNewTab: false });
  assert.deepEqual(T.planArchiveClose({ tabs: tabs.slice(0, 2), groupId: 5, dirtyIds: [] }), { close: [1, 2], keep: [], needNewTab: true });
  assert.deepEqual(T.planArchiveClose({ tabs, groupId: null }), { close: [], keep: [], needNewTab: false });
});

test("requestConvOpen: leaves the request for a loading panel, sends it, returns the answer", async () => {
  const set = [], sent = [];
  const api = (answer) => ({
    storage: { session: { set: async (o) => { set.push(o); } } },
    runtime: { sendMessage: async (m) => { sent.push(m); if (answer instanceof Error) throw answer; return answer; } },
  });
  const opts = { id: "c_000000000001", windowId: 7, keyPrefix: "k.", newId: () => "r1" };
  assert.deepEqual(await T.requestConvOpen(api({ ok: true }), opts), { ok: true });
  assert.deepEqual(Object.keys(set[0]), ["k.7"]);
  assert.equal(set[0]["k.7"].id, "c_000000000001");
  assert.equal(set[0]["k.7"].reqId, "r1");
  assert.equal("canvasId" in set[0]["k.7"], false);              // the gallery's 重新打開: no canvas
  assert.deepEqual(sent[0], { type: "katashiro-conv-open", id: "c_000000000001", windowId: 7, reqId: "r1" });
  // From a canvas tab (§7.2): the canvas goes with both, so the panel can check it.
  set.length = sent.length = 0;
  await T.requestConvOpen(api({ ok: true }), { ...opts, canvasId: "cv_000000000001" });
  assert.equal(set[0]["k.7"].canvasId, "cv_000000000001");
  assert.equal(sent[0].canvasId, "cv_000000000001");
  // No panel listening (sendMessage rejects) or no answer in time → undefined.
  assert.equal(await T.requestConvOpen(api(new Error("Receiving end does not exist")), opts), undefined);
  const silent = { storage: { session: { set: async () => {} } }, runtime: { sendMessage: () => new Promise(() => {}) } };
  assert.equal(await T.requestConvOpen(silent, { ...opts, timeoutMs: 10 }), undefined);
  // No storage.session: the message still goes.
  sent.length = 0;
  const noSession = { storage: { session: { set: async () => { throw new Error("no"); } } }, runtime: api({ ok: false, error: "x" }).runtime };
  noSession.runtime.sendMessage = async (m) => { sent.push(m); return { ok: false, error: "x" }; };
  assert.deepEqual(await T.requestConvOpen(noSession, opts), { ok: false, error: "x" });
  assert.equal(sent.length, 1);
});
