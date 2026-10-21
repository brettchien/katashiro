// canvas-tabs.js — the canvas tab group and Split View rules (ADR docs/adr/canvas.md §3.1) as pure
// functions over plain tab / tabGroup objects, so the decisions are unit-tested and sidepanel.js
// only makes the chrome.* calls (openGalleryTab, shared by the panel and the canvas tab, takes
// `chrome` as a parameter). Dual target like canvas-core.js (globalThis.CanvasTabs /
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

  // Where to move `b` so it sits right after `a`: if b is before a, a shifts left once b is lifted
  // out. null = already adjacent. Shared by canvas_open beside and katashiro.split_tabs (#90).
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

  // --- Compare with agent's (§3.10) ------------------------------------------------------------
  // A compare tab is canvas.html?id=<id>&view=agent: read-only, never "the canvas" (classifyTab
  // says "other", the card and findCanvasTab never pick it).
  function compareTabUrl(canvasBase, id) {
    return `${canvasBase}?id=${encodeURIComponent(id)}&view=agent`;
  }
  function isCompareTabFor(tab, canvasBase, id) {
    const url = tab && (tab.url || tab.pendingUrl);
    if (typeof url !== "string" || !canvasBase || !url.startsWith(`${canvasBase}?`)) return false;
    let p;
    try { p = new URL(url).searchParams; } catch (_) { return false; }
    return p.get("view") === "agent" && p.get("id") === id;
  }
  // Every open compare tab of canvas `id` (✕ 結束比較 and canvas_view({compare: false}) close them all).
  function compareTabsFor(tabs, canvasBase, id) {
    return (tabs || []).filter((t) => isCompareTabFor(t, canvasBase, id));
  }

  /**
   * The user clicked Compare with agent's in `canvasTab`. `compareTab` = an open compare tab of the
   * same canvas, if any. Rules (§3.10): an existing compare split with this canvas tab is just
   * focused; otherwise a stray compare tab is replaced, a split the canvas tab is in (e.g. beside a
   * page, §3.1) is ended first, and the new compare tab is split with the canvas tab. Without
   * Split View (Chrome < 155) the compare view is a normal tab.
   * → { ok: false, reason } | { ok: true, action: "focus" } |
   *   { ok: true, action: "open", closeOld: tabId | null, unsplit: splitViewId | null, split: boolean }
   */
  function planCompare({ canvasTab, compareTab, canSplit }) {
    if (!canvasTab) return { ok: false, reason: "the canvas tab is gone" };
    if (compareTab) {
      if (!canSplit && compareTab.windowId === canvasTab.windowId) return { ok: true, action: "focus" };
      if (canSplit && inSplit(canvasTab) && compareTab.splitViewId === canvasTab.splitViewId) return { ok: true, action: "focus" };
    }
    return {
      ok: true, action: "open",
      closeOld: compareTab ? compareTab.id : null,
      unsplit: canSplit && inSplit(canvasTab) ? canvasTab.splitViewId : null,
      split: !!canSplit,
    };
  }

  // chrome.tabs.create properties for the compare tab: right after the canvas tab, same window and
  // pinned state (a split needs both), in the background when it is about to be split.
  function compareTabProps(canvasTab, url, split) {
    return { url, windowId: canvasTab.windowId, index: canvasTab.index + 1, pinned: !!canvasTab.pinned, active: !split };
  }

  // --- Finding tabs (§3.1 duplicate-tab rule) -----------------------------------------------------
  // A canvas tab is canvas.html?id=<id> exactly: a compare tab (&view=agent) never matches.
  function canvasTabUrl(canvasBase, id) {
    return `${canvasBase}?id=${encodeURIComponent(id)}`;
  }
  // The most recently used of several tabs (lastAccessed, Chrome 121+; else the first one listed).
  function mostRecent(tabs) {
    let best = null;
    for (const t of tabs) if (!best || (t.lastAccessed || 0) > (best.lastAccessed || 0)) best = t;
    return best;
  }
  // The tab the card, the panel and the gallery bring to the front: the most recently used tab of
  // that canvas (the user may have duplicated it), never a compare tab. null = not open.
  function pickCanvasTab(tabs, canvasBase, id) {
    const want = canvasTabUrl(canvasBase, id);
    return mostRecent((tabs || []).filter((t) => t && (t.url === want || t.pendingUrl === want)));
  }

  // --- Canvas gallery (§3.7) -----------------------------------------------------------------------
  // One gallery tab is enough: canvas-gallery.html (any query or fragment) is reused.
  function isGalleryTab(tab, galleryBase) {
    const url = tab && (tab.url || tab.pendingUrl);
    return typeof url === "string" && !!galleryBase && (url === galleryBase || url.startsWith(`${galleryBase}?`) || url.startsWith(`${galleryBase}#`));
  }
  // The gallery URL with its search box prefilled (canvas_gallery({query}), §3.11): `#q=<encoded>`;
  // the page sanitises it (CanvasGalleryCore.queryFromHash) and clears the fragment. null/undefined
  // = no query (the box is left as it is); "" = an empty box.
  function galleryUrl(galleryBase, query) {
    return query == null ? galleryBase : `${galleryBase}#q=${encodeURIComponent(String(query))}`;
  }
  // Focus the open gallery tab, or open one (in `windowId` if given). `api` = chrome (tabs, windows),
  // passed in so the panel and the canvas tab share this and tests can fake it. With `query` the
  // open tab is navigated to the #q= URL (a fragment change: no reload, the page hears hashchange).
  // → the tab.
  async function openGalleryTab(api, galleryBase, { windowId, query } = {}) {
    const open = mostRecent((await api.tabs.query({})).filter((t) => isGalleryTab(t, galleryBase)));
    if (open) {
      await api.tabs.update(open.id, query == null ? { active: true } : { url: galleryUrl(galleryBase, query), active: true });
      await api.windows.update(open.windowId, { focused: true });
      return open;
    }
    const opts = { url: galleryUrl(galleryBase, query), active: true };
    if (windowId != null) opts.windowId = windowId;
    return api.tabs.create(opts);
  }

  // Ask the panel of `windowId` to open conversation `id` (multi-conversation §3.4 重新打開, §7.2 from
  // a canvas): the request is left in storage.session under `keyPrefix + windowId` for a panel still
  // loading, and sent as katashiro-conv-open. `canvasId`: the canvas tab asking (the panel checks
  // the canvas is that conversation's, and groups the tab). The caller opens the side panel first,
  // in its click (chrome.sidePanel.open needs the gesture, so it cannot wait for this). `api` =
  // chrome (storage.session, runtime). → the panel's answer, or undefined (no answer in time).
  async function requestConvOpen(api, { id, windowId, canvasId = null, keyPrefix, timeoutMs = 8000, newId = () => crypto.randomUUID() }) {
    const reqId = newId();
    const req = { id, reqId, at: Date.now() };
    if (canvasId) req.canvasId = canvasId;
    try { await api.storage.session.set({ [`${keyPrefix}${windowId}`]: req }); } catch (_) { /* the message below still works */ }
    let timer;
    try {
      const timeout = new Promise((res) => { timer = setTimeout(() => res(undefined), timeoutMs); });
      const msg = { type: "katashiro-conv-open", id, windowId, reqId };
      if (canvasId) msg.canvasId = canvasId;
      return await Promise.race([api.runtime.sendMessage(msg), timeout]);
    } catch (_) {
      return undefined;                                  // no panel listening at all
    } finally {
      clearTimeout(timer);
    }
  }

  // --- One tab group per conversation (multi-conversation ADR §4) -----------------------------------
  // The conversation's group holds its canvases and the tabs its agent opened. The GROUP is the
  // membership: a tab dragged out is the user's again, so everything below reads groupId, never a
  // list of tab ids Katashiro once grouped.

  const urlOf = (t) => (t && (t.url || t.pendingUrl)) || "";

  /**
   * The URL a group tab comes back as (§4.4), or null for a tab not worth reopening: a canvas tab
   * (never a compare tab) or an http(s)/file page; a blank, chrome:// or other extension page is not kept.
   */
  function restorableUrl(tab, canvasBase) {
    const kind = classifyTab(tab, canvasBase);
    return kind === "canvas" || kind === "web" ? urlOf(tab) : null;
  }

  /** The restorable URLs of group `groupId`'s tabs, in tab order, each once. */
  function groupTabUrls(tabs, groupId, canvasBase) {
    if (groupId == null || groupId === TAB_GROUP_NONE) return [];
    const out = [];
    const inGroup = (tabs || []).filter((t) => t && t.groupId === groupId).sort((a, b) => (a.windowId - b.windowId) || (a.index - b.index));
    for (const t of inGroup) {
      const u = restorableUrl(t, canvasBase);
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  }

  /**
   * The group ids of every conversation but `except`, each looked up through `lookup` (the panel
   * passes its storage-backed lookup: after a panel reload the in-memory map is empty until a tab
   * event warms it, and missing another conversation's group lets a restore adopt — or reuse — it).
   * → [groupId]
   */
  async function otherGroupIds(convIds, except, lookup) {
    const out = [];
    for (const id of convIds || []) {
      if (id === except) continue;
      const g = await lookup(id);
      if (g != null && !out.includes(g)) out.push(g);
    }
    return out;
  }

  /**
   * A conversation comes back (browser-restart adoption, or 重新打開 from the gallery, §4.4): which of
   * its saved URLs are already open in the panel's window (adopt those tabs into the group instead of
   * opening them twice) and which to open. A tab is adoptable when it shows exactly that URL, is in
   * the window, not pinned (a pinned tab cannot be grouped), not in a split (both sides of a split
   * share a group state, §3.1) and not in another open conversation's group. A URL whose only match
   * is a split or pinned tab is neither adopted nor opened again. If every adopted tab already sits
   * in the same group (Chrome's restored copy of this one), that group is reused.
   * → { adopt: [tabId], open: [url], reuseGroupId: groupId | null }
   */
  function planGroupRestore({ urls, tabs, windowId, otherGroupIds }) {
    const others = otherGroupIds instanceof Set ? otherGroupIds : new Set(otherGroupIds || []);
    const claimed = new Set();
    const adopt = [];
    const adoptGroups = new Set();
    const open = [];
    for (const url of new Set(Array.isArray(urls) ? urls : [])) {   // a URL is kept once (groupTabUrls)
      if (typeof url !== "string" || !url) continue;
      const same = (tabs || []).filter((t) => t && !claimed.has(t.id) && t.windowId === windowId && urlOf(t) === url && !others.has(groupOf(t)));
      const usable = same.find((t) => !t.pinned && !inSplit(t));
      if (usable) {
        claimed.add(usable.id);
        adopt.push(usable.id);
        adoptGroups.add(groupOf(usable));
      } else if (same.length) {
        claimed.add(same[0].id);                        // open already, just not groupable: no duplicate
      } else {
        open.push(url);
      }
    }
    const only = adoptGroups.size === 1 ? [...adoptGroups][0] : TAB_GROUP_NONE;
    return { adopt, open, reuseGroupId: only !== TAB_GROUP_NONE ? only : null };
  }

  function originOf(url) {
    try { const u = new URL(url); return u.protocol === "file:" ? "file:" : u.origin; } catch (_) { return null; }
  }

  /**
   * The conversation's working tab (§4.3), re-validated: the tab with the saved id if it still shows
   * the same origin (the user or the agent may have navigated it since); else (tab ids are reused after
   * a browser restart) the first open tab with exactly the saved URL; else null.
   * saved = { id, url } | null.
   */
  function pickWorkingTab({ saved, tabs }) {
    if (!saved || typeof saved.url !== "string") return null;
    const list = tabs || [];
    const byId = list.find((t) => t && t.id === saved.id);
    if (byId && originOf(urlOf(byId)) !== null && originOf(urlOf(byId)) === originOf(saved.url)) return byId;
    return list.find((t) => t && urlOf(t) === saved.url) || null;
  }

  /**
   * Q5 (§4.2): the panel switches conversation. No group is collapsed: a conversation's group stays
   * while the conversation is in the panel's tab strip (archive closes it, §4.5). `tabs` = the
   * panel's window's tabs; `groupId` = the new conversation's group (null if none here) — expanded,
   * in case the user collapsed it by hand; `otherGroupIds` = the other open conversations' groups.
   * → { activate: tabId | null (see switchActivate), expand: groupId | null }
   */
  function planGroupSwitch({ tabs, groupId, otherGroupIds, workingTabId }) {
    const list = tabs || [];
    const expand = groupId != null && groupId !== TAB_GROUP_NONE && list.some((t) => t && t.groupId === groupId) ? groupId : null;
    return { activate: switchActivate(list, groupId, otherGroupIds, workingTabId, expand), expand };
  }

  // planGroupSwitch's activate step: if the active tab sits in another open conversation's group,
  // move to the working tab when it is in this window and in no other conversation's group, else
  // the new group's most recently used tab, else the most recently used tab in no conversation's
  // group, else nowhere (null).
  function switchActivate(list, groupId, otherGroupIds, workingTabId, expand) {
    const others = [...new Set(otherGroupIds || [])].filter((g) => g != null && g !== TAB_GROUP_NONE && g !== groupId);
    const active = list.find((t) => t && t.active);
    if (!active || !others.includes(groupOf(active))) return null;
    const working = list.find((t) => t && t.id === workingTabId);
    if (working && !others.includes(groupOf(working))) return working.id;
    const inNew = expand != null ? mostRecent(list.filter((t) => t && t.groupId === expand)) : null;
    const pick = inNew || mostRecent(list.filter((t) => t && groupOf(t) === TAB_GROUP_NONE));
    return pick ? pick.id : null;
  }

  /**
   * §4.5: archive closes the group's tabs. `dirtyIds` = canvas tabs that said (or could not say
   * otherwise) they hold unsaved edits: those stay. If closing would empty the window, a New Tab
   * page must be opened first. → { close: [tabId], keep: [tabId], needNewTab }
   */
  function planArchiveClose({ tabs, groupId, dirtyIds }) {
    const dirty = new Set(dirtyIds || []);
    const inGroup = (tabs || []).filter((t) => t && groupId != null && groupId !== TAB_GROUP_NONE && t.groupId === groupId);
    const close = inGroup.filter((t) => !dirty.has(t.id)).map((t) => t.id);
    const keep = inGroup.filter((t) => dirty.has(t.id)).map((t) => t.id);
    const needNewTab = close.length > 0 && (tabs || []).filter((t) => t && !close.includes(t.id)).length === 0;
    return { close, keep, needNewTab };
  }

  return { GROUP_TITLE, GROUP_COLOR, restorableUrl, groupTabUrls, otherGroupIds, planGroupRestore, pickWorkingTab, planGroupSwitch, planArchiveClose, TAB_GROUP_NONE, SPLIT_NONE, groupOf, inSplit, classifyTab, planCanvasGroup, adjacentIndex, splitBlocker, planBeside, planRestore, compareTabUrl, isCompareTabFor, compareTabsFor, planCompare, compareTabProps, canvasTabUrl, pickCanvasTab, isGalleryTab, galleryUrl, openGalleryTab, requestConvOpen };
});
