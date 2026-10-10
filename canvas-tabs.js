// canvas-tabs.js — the canvas tab group and Split View rules (ADR docs/adr/canvas.md §3.1) as pure
// functions over plain tab / tabGroup objects, so the decisions are unit-tested and sidepanel.js
// only makes the chrome.* calls. Dual target like canvas-core.js (globalThis.CanvasTabs /
// module.exports).
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod;
  else root.CanvasTabs = mod;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Until multi-conversation lands the group is titled "Canvas" (§6 Q5); one fixed color (§3.1).
  const GROUP_TITLE = "Canvas";
  const GROUP_COLOR = "blue";
  const TAB_GROUP_NONE = -1;                             // chrome.tabGroups.TAB_GROUP_ID_NONE
  const SPLIT_NONE = -1;                                 // chrome.tabs.SPLIT_VIEW_ID_NONE

  const groupOf = (t) => (t && t.groupId != null && t.groupId !== TAB_GROUP_NONE ? t.groupId : TAB_GROUP_NONE);
  const inSplit = (t) => !!t && t.splitViewId != null && t.splitViewId !== SPLIT_NONE;

  /**
   * What a tab is, for Split View: "canvas" (a canvas tab, canvas.html?id=…), "web" (a page the
   * user reads: http(s) or file), or "other" (a compare tab `view=agent` §3.10, any other extension
   * or chrome:// page, a tab with no URL yet). `canvasBase` = chrome.runtime.getURL("canvas.html").
   */
  function classifyTab(tab, canvasBase) {
    const url = tab && (tab.url || tab.pendingUrl);
    if (typeof url !== "string" || !url) return "other";
    if (canvasBase && url.startsWith(`${canvasBase}?`)) {
      let p;
      try { p = new URL(url).searchParams; } catch (_) { return "other"; }
      return p.get("id") && !p.get("view") ? "canvas" : "other";
    }
    return /^(https?|file):/i.test(url) ? "web" : "other";
  }

  /**
   * The conversation's canvas group: reuse the stored id if that group still exists in this
   * window, else create one. `groups` are the tabGroups we could read (a stale id is simply absent).
   * → { action: "reuse", groupId } | { action: "create" }
   */
  function planCanvasGroup({ storedGroupId, groups, windowId }) {
    if (Number.isInteger(storedGroupId) && storedGroupId !== TAB_GROUP_NONE) {
      const g = (groups || []).find((x) => x && x.id === storedGroupId);
      if (g && (windowId == null || g.windowId === windowId)) return { action: "reuse", groupId: storedGroupId };
    }
    return { action: "create" };
  }

  // Where to move `b` so it sits right after `a` (split_tabs' rule): if b is before a, a shifts left
  // once b is lifted out. null = already adjacent.
  function adjacentIndex(a, b) {
    if (Math.abs(a.index - b.index) === 1) return null;
    return b.index < a.index ? a.index : a.index + 1;
  }

  /**
   * Can these two tabs be split as they are now? Chrome's rule as split_tabs checks it: same
   * window, same pinned and tab-group state, neither already in a split. → reason string | null.
   */
  function splitBlocker(canvasTab, pageTab) {
    if (inSplit(canvasTab)) return "the canvas is already in a Split View";
    if (inSplit(pageTab)) return "the page is already in a Split View";
    if (canvasTab.windowId !== pageTab.windowId) return "the canvas tab is in another window";
    if (!!canvasTab.pinned !== !!pageTab.pinned) return "one of the tabs is pinned and the other is not";
    if (groupOf(canvasTab) !== groupOf(pageTab)) return "the tabs are in different tab groups";
    return null;
  }

  /**
   * canvas_open(…, beside: "current") (§3.1): show `canvasTab` in Split View with `pageTab`, the
   * active tab of the panel's window. Refusals are things Katashiro will not change for the user
   * (a split they made, a pin, another window). A web page's group decides: the canvas tab moves
   * into it (or out of every group), and is moved back later (planRestore). Two canvases in the
   * same group split directly.
   * → { ok: false, reason } | { ok: true, kind, regroup: null | { groupId }, restore: null | { returnGroupId, pageTabId } }
   *   regroup.groupId TAB_GROUP_NONE = ungroup.
   */
  function planBeside({ canvasTab, pageTab, canvasBase }) {
    if (!canvasTab) return { ok: false, reason: "the canvas tab is not open" };
    if (!pageTab) return { ok: false, reason: "no active tab in the panel's window" };
    if (pageTab.id === canvasTab.id) return { ok: false, reason: "the canvas is the active tab" };
    const kind = classifyTab(pageTab, canvasBase);
    if (kind === "other") return { ok: false, reason: "the active tab is not a web page" };
    if (canvasTab.windowId !== pageTab.windowId) return { ok: false, reason: "the canvas tab is in another window" };
    if (inSplit(canvasTab)) return { ok: false, reason: "the canvas is already in a Split View" };
    if (inSplit(pageTab)) return { ok: false, reason: "the page is already in a Split View" };
    // Pinning is the user's choice; Katashiro does not pin or unpin to make a split work.
    if (!!canvasTab.pinned !== !!pageTab.pinned) return { ok: false, reason: "one of the tabs is pinned and the other is not" };
    const from = groupOf(canvasTab);
    const to = groupOf(pageTab);
    if (from === to) return { ok: true, kind, regroup: null, restore: null };
    return { ok: true, kind, regroup: { groupId: to }, restore: { returnGroupId: from, pageTabId: pageTab.id } };
  }

  /**
   * The split ended or the page closed: put the canvas tab back (§3.1 "move back only if nothing
   * changed"). `record` = { movedToGroupId, windowId, returnGroupId, canvasGroup } saved when it was moved.
   * Left alone if the tab is gone, still split, or not where Katashiro put it (another group or
   * window — the user moved it). If its old group was the canvas group and is gone, it is recreated:
   * the canvas tab was often that group's only tab, and Chrome removes a group when its last tab
   * leaves. Another group that is gone (one the user had put the tab in) is not.
   * → { action: "none", why } | { action: "group", groupId } | { action: "recreate" } | { action: "ungroup" }
   */
  function planRestore({ canvasTab, record, groups }) {
    if (!canvasTab || !record) return { action: "none", why: "gone" };
    if (inSplit(canvasTab)) return { action: "none", why: "still split" };
    if (canvasTab.windowId !== record.windowId || groupOf(canvasTab) !== groupOf({ groupId: record.movedToGroupId })) {
      return { action: "none", why: "moved by the user" };
    }
    const back = groupOf({ groupId: record.returnGroupId });
    if (back === TAB_GROUP_NONE) return groupOf(canvasTab) === TAB_GROUP_NONE ? { action: "none", why: "already there" } : { action: "ungroup" };
    const g = (groups || []).find((x) => x && x.id === back);
    if (g && g.windowId === canvasTab.windowId) return { action: "group", groupId: back };
    return record.canvasGroup ? { action: "recreate" } : { action: "none", why: "its group is gone" };
  }

  return { GROUP_TITLE, GROUP_COLOR, TAB_GROUP_NONE, SPLIT_NONE, groupOf, inSplit, classifyTab, planCanvasGroup, adjacentIndex, splitBlocker, planBeside, planRestore };
});
