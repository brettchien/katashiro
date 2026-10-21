// e2e-style unit tests for the katashiro browser MCP server (browser-mcp.js).
//
// Runs under `node --test` with NO real Chrome: chrome.* (tabs/scripting/captureVisibleTab),
// crypto, and the socket `send` are mocked. We drive the module exactly as the gateway does
// over the tunnel — server-initiated `mcp/connect` / `mcp/message` (initialize, tools/list,
// tools/call) / `mcp/disconnect` — and assert both the JSON-RPC frames sent back AND the
// chrome API calls the tools make. This exercises the same code path the extension uses.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const BrowserMcp = require("../browser-mcp.js");

// --- mocks ------------------------------------------------------------------

// A mock chrome that records calls and returns a configurable executeScript result.
function mockChrome(opts = {}) {
  const calls = { query: [], executeScript: [], tabsUpdate: [], captureVisibleTab: [], goBack: [], goForward: [], reload: [], tabsCreate: [], tabsRemove: [], windowsUpdate: [], insertCSS: [], removeCSS: [], tabsGroup: [], tabsUngroup: [], tabsMove: [], tabsDuplicate: [], groupsUpdate: [], sessionsRestore: [], createSplit: [], unsplit: [] };
  const chrome = {
    tabs: {
      query: async (q) => {
        calls.query.push(q);
        if (opts.noTab) return [];
        // active-tab lookup (activeTab()) vs list-all (katashiro.tabs / new_tab / switch_tab): the
        // latter can be seeded via opts.tabsList.
        if (!q.active && opts.tabsList) return opts.tabsList;
        // The active tab carries a url so the supported-scheme check has an origin to inspect;
        // opts.tabUrl overrides it (e.g. a chrome:// page with no scriptable origin).
        return [{ id: 42, windowId: 7, url: opts.tabUrl || "https://t/" }];
      },
      update: async (tabId, upd) => {
        calls.tabsUpdate.push({ tabId, upd });
      },
      create: async (props) => {
        calls.tabsCreate.push(props);
        return opts.createdTab || { id: 99, windowId: 7, url: props.url };
      },
      remove: async (tabId) => { calls.tabsRemove.push(tabId); },
      group: async (o) => { calls.tabsGroup.push(o); if (opts.groupThrows) throw new Error(opts.groupThrows); return o.groupId ?? 501; },
      ungroup: async (ids) => { calls.tabsUngroup.push(ids); },
      move: async (tabId, o) => { calls.tabsMove.push({ tabId, o }); },
      duplicate: async (tabId) => { calls.tabsDuplicate.push(tabId); return { id: 777 }; },
      // Split View (Chrome 155+); opts.noSplit drops both methods. createSplit tags the listed tabs.
      createSplit: opts.noSplit ? undefined : async (ids) => {
        calls.createSplit.push(ids);
        if (opts.splitThrows) throw new Error(opts.splitThrows);
        for (const t of opts.tabsList || []) if (ids.includes(t.id)) t.splitViewId = 900;
        return 900;
      },
      unsplit: opts.noSplit ? undefined : async (id) => { calls.unsplit.push(id); },
      goBack: async (tabId) => { calls.goBack.push(tabId); if (opts.historyThrows) throw new Error("Cannot find a previous page in history."); },
      goForward: async (tabId) => { calls.goForward.push(tabId); if (opts.historyThrows) throw new Error("Cannot find a next page in history."); },
      reload: async (tabId, o) => { calls.reload.push({ tabId, o }); },
      captureVisibleTab: async (windowId, o) => {
        calls.captureVisibleTab.push({ windowId, o });
        return opts.dataUrl || "data:image/png;base64,QUJD"; // "ABC"
      }
    },
    windows: {
      update: async (windowId, o) => { calls.windowsUpdate.push({ windowId, o }); },
      getCurrent: async () => ({ id: opts.currentWindowId ?? 7 })
    },
    // tabGroups / sessions are optional APIs: opts.noTabGroups / opts.noSessions drop them.
    tabGroups: opts.noTabGroups ? undefined : {
      query: async () => opts.groups || [],
      update: async (id, upd) => {
        calls.groupsUpdate.push({ id, upd });
        const g = (opts.groups || []).find((x) => x.id === id);
        if (!g && !opts.anyGroup) throw new Error(`No group with id: ${id}.`);
        return { ...(g || { id, color: "grey", title: "" }), ...upd };
      }
    },
    // permissions: present only when a test seeds opts.sessionsGranted (live grant after a revoke).
    permissions: opts.sessionsGranted == null ? undefined : { contains: async () => opts.sessionsGranted },
    sessions: opts.noSessions ? undefined : {
      getRecentlyClosed: async () => opts.recentlyClosed || [],
      restore: async (sessionId) => {
        calls.sessionsRestore.push(sessionId);
        if (opts.restoreThrows) throw new Error(opts.restoreThrows);
        return opts.restored || { tab: { id: 88, url: "https://r/", title: "R" } };
      }
    },
    scripting: {
      executeScript: async (inj) => {
        calls.executeScript.push(inj);
        // Simulate the in-page func's return (the func itself needs a DOM; not run here). frameId:0
        // is the top frame — the merge/all-frames path keys on it.
        // opts.frameResults stands in for an allFrames run that answers from several frames.
        if (opts.frameResults && inj.target.allFrames && inj.func) return opts.frameResults;
        return [{ frameId: 0, result: opts.scriptResult ?? { ok: true } }];
      },
      insertCSS: async (inj) => { calls.insertCSS.push(inj); },
      removeCSS: async (inj) => { calls.removeCSS.push(inj); }
    },
  };
  return { chrome, calls };
}

// A fixed uuid, or an array to hand out one per call (multi-server needs distinct handles).
const mockCrypto = (uuid = "conn-abc") => {
  const queue = Array.isArray(uuid) ? [...uuid] : null;
  return { randomUUID: () => (queue ? queue.shift() : uuid) };
};

// Collects frames written by the module's `send`.
function mockSend() {
  const sent = [];
  return { send: (obj) => sent.push(obj), sent };
}

// Build the deps bag the module expects, plus expose the recorders.
// `actMode` defaults to ON here so the tool-mechanics tests below exercise the tool bodies
// rather than the consent gate; the gate itself is covered by its own tests, which pass
// `actMode: false` explicitly. (The extension's default is the opposite — off.)
function deps(opts = {}) {
  const { chrome, calls } = mockChrome(opts);
  const { send, sent } = mockSend();
  const statuses = []; // records onStatus(attached) transitions
  return {
    deps: {
      chrome,
      crypto: mockCrypto(opts.uuid),
      send,
      onStatus: (a) => statuses.push(a),
      actMode: opts.actMode !== false
    },
    calls,
    sent,
    statuses
  };
}

// --- registry ---------------------------------------------------------------

test("the advertised tool set IS the implemented tool set (no drift)", () => {
  const advertised = BrowserMcp.BROWSER_TOOLS.map((t) => t.name).sort();
  const implemented = Object.keys(BrowserMcp.TOOLS).sort();
  assert.deepEqual(advertised, implemented);
});

test("every registry entry carries a description, an object schema, and a callable", () => {
  for (const [name, def] of Object.entries(BrowserMcp.TOOLS)) {
    assert.ok(def.description, `${name} needs a description`);
    assert.equal(def.inputSchema.type, "object", `${name} needs an object inputSchema`);
    assert.equal(typeof def.call, "function", `${name} needs a call() implementation`);
  }
});

test("a required-arg schema only names properties the schema declares", () => {
  for (const [name, def] of Object.entries(BrowserMcp.TOOLS)) {
    for (const req of def.inputSchema.required || []) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(def.inputSchema.properties || {}, req),
        `${name} requires "${req}" but never declares it`
      );
    }
  }
});

// --- MCP surface: handleMcpMessage ------------------------------------------

test("initialize advertises tools capability + serverInfo", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage("initialize", {}, d);
  assert.equal(res.protocolVersion, "2025-06-18");
  assert.deepEqual(res.capabilities, { tools: {} });
  assert.equal(res.serverInfo.name, "katashiro-browser");
});

test("notifications/initialized is a notification (no result)", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage("notifications/initialized", {}, d);
  assert.equal(res, undefined);
});

test("tools/list returns every browser tool, in order", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/list", {}, d);
  const names = res.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "katashiro.click",
    "katashiro.click_text",
    "katashiro.type_text",
    "katashiro.assert",
    "katashiro.read_dom",
    "katashiro.navigate",
    "katashiro.type",
    "katashiro.screenshot",
    "katashiro.snapshot",
    "katashiro.wait_for",
    "katashiro.get_text",
    "katashiro.scroll",
    "katashiro.tabs",
    "katashiro.new_tab",
    "katashiro.switch_tab",
    "katashiro.close_tab",
    "katashiro.reopen_tab",
    "katashiro.tab_update",
    "katashiro.tab_groups",
    "katashiro.group_tabs",
    "katashiro.ungroup_tabs",
    "katashiro.update_tab_group",
    "katashiro.split_tabs",
    "katashiro.unsplit_tabs",
    "katashiro.history",
    "katashiro.press_key",
    "katashiro.hover",
    "katashiro.highlight",
    "katashiro.client_info",
    "katashiro.get_selection",
    "katashiro.select_option",
    "katashiro.fill_form",
    "katashiro.upload_file",
    "katashiro.paste_image",
    "katashiro.reload",
    "katashiro.inject_css",
    "katashiro.show_image",
    "katashiro.ask_user",
    "katashiro.canvas_open",
    "katashiro.canvas_read",
    "katashiro.canvas_patch",
    "katashiro.canvas_delete",
    "katashiro.conversation_list",
    "katashiro.canvas_move",
    "katashiro.canvas_goto",
    "katashiro.canvas_highlight",
    "katashiro.canvas_inject_css",
    "katashiro.canvas_view",
    "katashiro.canvas_gallery",
    "katashiro.canvas_list",
    "katashiro.chat_history",
    "katashiro.set_title",
    "katashiro.notify"
  ]);
  // every tool carries a JSON-Schema inputSchema
  for (const t of res.tools) assert.equal(t.inputSchema.type, "object");
});

test("unknown MCP method throws -32601", async () => {
  const { deps: d } = deps();
  await assert.rejects(
    () => BrowserMcp.handleMcpMessage("does/not/exist", {}, d),
    (e) => e.code === -32601
  );
});

// --- tools/call → chrome.* --------------------------------------------------

test("katashiro.read_dom injects a script and returns the DOM as text", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, html: "<body>hi</body>" } });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.read_dom", arguments: { selector: "#main" } },
    d
  );
  assert.equal(calls.executeScript.length, 1);
  assert.equal(calls.executeScript[0].target.tabId, 42);
  assert.deepEqual(calls.executeScript[0].args, ["#main"]);
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, "<body>hi</body>");
});

test("katashiro.click on a missing element yields an isError result", async () => {
  const { deps: d } = deps({ scriptResult: { ok: false, error: "no element for selector: #gone" } });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.click", arguments: { selector: "#gone" } },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no element/);
});

test("katashiro.navigate drives chrome.tabs.update", async () => {
  const { deps: d, calls } = deps();
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.navigate", arguments: { url: "https://example.com" } },
    d
  );
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 42, upd: { url: "https://example.com" } }]);
  assert.match(res.content[0].text, /example\.com/);
});

// --- tab management: new_tab / switch_tab -----------------------------------

test("katashiro.new_tab opens an active tab at a URL and snapshots it", async () => {
  const { deps: d, calls } = deps({ createdTab: { id: 99, windowId: 7, url: "https://new/" }, tabsList: [{ id: 42, windowId: 7, url: "https://t/" }, { id: 99, windowId: 7, url: "https://new/" }] });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.new_tab", arguments: { url: "https://new/" } },
    d
  );
  assert.deepEqual(calls.tabsCreate, [{ active: true, url: "https://new/" }]);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /opened new tab \[1\] \(now active\) — https:\/\/new\//);
  assert.match(res.content[0].text, /# snapshot/);            // switched to a scriptable page ⇒ snapshot
});

test("katashiro.new_tab in the background does not steal focus or snapshot", async () => {
  const { deps: d, calls } = deps({ createdTab: { id: 99, windowId: 7, url: "https://bg/" } });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.new_tab", arguments: { url: "https://bg/", active: false } },
    d
  );
  assert.deepEqual(calls.tabsCreate, [{ active: false, url: "https://bg/" }]);
  assert.match(res.content[0].text, /\(background\)/);
  assert.doesNotMatch(res.content[0].text, /# snapshot/);      // background ⇒ no snapshot
});

test("katashiro.new_tab with no url opens a blank tab (no snapshot)", async () => {
  const { deps: d, calls } = deps({ createdTab: { id: 99, windowId: 7, url: "chrome://newtab/" } });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.new_tab", arguments: {} },
    d
  );
  assert.deepEqual(calls.tabsCreate, [{ active: true }]);      // no url key
  assert.match(res.content[0].text, /\(new tab page\)/);
  assert.doesNotMatch(res.content[0].text, /# snapshot/);
});

test("katashiro.new_tab works even when the active tab is a chrome:// page", async () => {
  // sessionScope bypasses the active-tab origin pre-flight that would reject page tools here.
  const { deps: d, calls } = deps({ tabUrl: "chrome://settings/", createdTab: { id: 99, windowId: 7, url: "https://ok/" }, tabsList: [{ id: 99, windowId: 7, url: "https://ok/" }] });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.new_tab", arguments: { url: "https://ok/" } },
    d
  );
  assert.equal(res.isError, undefined);
  assert.equal(calls.tabsCreate.length, 1);
});

test("katashiro.switch_tab by index activates the tab and focuses its window", async () => {
  const tabsList = [
    { id: 42, windowId: 7, url: "https://a/", title: "A" },
    { id: 55, windowId: 8, url: "https://b/", title: "B" }
  ];
  const { deps: d, calls } = deps({ tabsList });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.switch_tab", arguments: { index: 1 } },
    d
  );
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 55, upd: { active: true } }]);
  assert.deepEqual(calls.windowsUpdate, [{ windowId: 8, o: { focused: true } }]);
  assert.match(res.content[0].text, /switched to tab \[1\] — B — https:\/\/b\//);
});

test("katashiro.switch_tab by url substring picks the first match", async () => {
  const tabsList = [
    { id: 42, windowId: 7, url: "https://a.example/", title: "A" },
    { id: 55, windowId: 7, url: "https://mail.google.com/", title: "Mail" }
  ];
  const { deps: d, calls } = deps({ tabsList });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.switch_tab", arguments: { url: "mail.google" } },
    d
  );
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 55, upd: { active: true } }]);
  assert.match(res.content[0].text, /switched to tab \[1\] — Mail/);
});

test("katashiro.switch_tab with an out-of-range index is a clean error", async () => {
  const { deps: d, calls } = deps({ tabsList: [{ id: 42, windowId: 7, url: "https://a/" }] });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.switch_tab", arguments: { index: 9 } },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /out of range/);
  assert.equal(calls.tabsUpdate.length, 0);                    // nothing activated
});

test("katashiro.switch_tab with no index or url is a clean error", async () => {
  const { deps: d } = deps({ tabsList: [{ id: 42, windowId: 7, url: "https://a/" }] });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.switch_tab", arguments: {} },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /needs an `index`.*a `url` substring or `tab: "working"`/);
});

test("katashiro.close_tab by index removes that tab", async () => {
  const tabsList = [
    { id: 42, windowId: 7, url: "https://a/", title: "A" },
    { id: 55, windowId: 7, url: "https://b/", title: "B" }
  ];
  const { deps: d, calls } = deps({ tabsList });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.close_tab", arguments: { index: 1 } },
    d
  );
  assert.deepEqual(calls.tabsRemove, [55]);
  assert.match(res.content[0].text, /closed tab \[1\] — B — https:\/\/b\//);
});

test("katashiro.close_tab by url substring closes the first match", async () => {
  const tabsList = [
    { id: 42, windowId: 7, url: "https://a.example/", title: "A" },
    { id: 55, windowId: 7, url: "https://mail.google.com/", title: "Mail" }
  ];
  const { deps: d, calls } = deps({ tabsList });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.close_tab", arguments: { url: "mail.google" } },
    d
  );
  assert.deepEqual(calls.tabsRemove, [55]);
  assert.match(res.content[0].text, /closed tab \[1\] — Mail/);
});

test("katashiro.close_tab with no index or url closes the active tab", async () => {
  // The mock's active-tab lookup returns id 42.
  const tabsList = [
    { id: 55, windowId: 7, url: "https://b/", title: "B" },
    { id: 42, windowId: 7, url: "https://t/", title: "T", active: true }
  ];
  const { deps: d, calls } = deps({ tabsList });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.close_tab", arguments: {} },
    d
  );
  assert.deepEqual(calls.tabsRemove, [42]);
  assert.match(res.content[0].text, /closed tab \[1\] — T/);
});

test("katashiro.close_tab with an out-of-range index or unmatched url is a clean error", async () => {
  const tabsList = [{ id: 42, windowId: 7, url: "https://a/" }, { id: 55, windowId: 7, url: "https://b/" }];
  for (const args of [{ index: 9 }, { url: "nope.example" }]) {
    const { deps: d, calls } = deps({ tabsList });
    const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.close_tab", arguments: args }, d);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /out of range|no open tab whose URL contains/);
    assert.equal(calls.tabsRemove.length, 0);                  // nothing closed
  }
});

test("katashiro.close_tab refuses to close the only open tab", async () => {
  const { deps: d, calls } = deps({ tabsList: [{ id: 42, windowId: 7, url: "https://a/" }] });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.close_tab", arguments: { index: 0 } },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /last tab in its window/);
  assert.equal(calls.tabsRemove.length, 0);
});

test("katashiro.close_tab refuses a window's last tab even when other windows have tabs", async () => {
  // Closing the only tab in window 8 would close that window — and the side panel if it lives there
  // — so the check counts tabs per window, not across all windows.
  const tabsList = [
    { id: 42, windowId: 7, url: "https://a/" },
    { id: 43, windowId: 7, url: "https://b/" },
    { id: 55, windowId: 8, url: "https://c/" }
  ];
  const { deps: d, calls } = deps({ tabsList });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.close_tab", arguments: { url: "https://c/" } },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /last tab in its window/);
  assert.equal(calls.tabsRemove.length, 0);
});

test("katashiro.close_tab is a write — refused when act mode is off", async () => {
  const { deps: d, calls } = deps({ actMode: false, tabsList: [{ id: 42 }, { id: 55 }] });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.close_tab", arguments: { index: 1 } },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /act mode is off/);
  assert.equal(calls.tabsRemove.length, 0);                    // gated before any browser call
});

test("katashiro.new_tab is a write — refused when act mode is off", async () => {
  const { deps: d, calls } = deps({ actMode: false });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.new_tab", arguments: { url: "https://x/" } },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /act mode is off/);
  assert.equal(calls.tabsCreate.length, 0);                    // gated before any browser call
});

test("katashiro.tabs lists tabs even when the active tab is a chrome:// page", async () => {
  // Regression: tabs is sessionScope, so listing no longer requires a scriptable active tab.
  const { deps: d } = deps({ tabUrl: "chrome://newtab/", tabsList: [{ id: 42, windowId: 7, url: "https://a/", title: "A", active: true }] });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.tabs", arguments: {} }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /\[0\] A — https:\/\/a\//);
});

test("tools/call fires onToolCall start→done with a shared callId on success", async () => {
  const { deps: d } = deps();
  const events = [];
  d.onToolCall = (e) => events.push(e);
  await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.navigate", arguments: { url: "https://example.com" } },
    d
  );
  assert.deepEqual(events.map((e) => e.phase), ["start", "done"]);
  assert.equal(events[0].name, "katashiro.navigate");
  assert.equal(events[1].name, "katashiro.navigate");
  assert.equal(events[0].callId, events[1].callId, "start and settle share one callId");
  // args reach the UI only in their masked form (navigate: the default — strings clipped).
  assert.deepEqual(events[0].args, { url: "https://example.com" });
  assert.deepEqual(events[1].args, { url: "https://example.com" });
});

test("tools/call fires onToolCall start→error when the tool result isError", async () => {
  const { deps: d } = deps({ scriptResult: { ok: false, error: "no element for selector: #gone" } });
  const events = [];
  d.onToolCall = (e) => events.push(e);
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.click", arguments: { selector: "#gone" } },
    d
  );
  assert.equal(res.isError, true);
  assert.deepEqual(events.map((e) => e.phase), ["start", "error"]);
});

test("katashiro.type injects the walker, then types via selector fallback", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, how: "selector #q" } });
  await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.type", arguments: { selector: "#q", text: "hello" } },
    d
  );
  // first call injects the vendored lib + walker; the act call carries [ref, snapshotId, selector, text]
  assert.deepEqual(calls.executeScript[0].files, ["vendor/dom-accessibility-api.iife.js", "page/a11y-walker.js"]);
  const act = calls.executeScript.find((c) => Array.isArray(c.args) && c.args.includes("hello"));
  assert.deepEqual(act.args, [null, null, "#q", "hello"]);
});

test("katashiro.click resolves a ref and returns the post-action snapshot", async () => {
  const { deps: d, calls } = deps({
    scriptResult: { ok: true, how: "ref e5", snapshotId: 2, title: "T", url: "https://t/", tree: "- button [ref=e5]" }
  });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.click", arguments: { ref: "e5", snapshotId: 1 } },
    d
  );
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /clicked ref e5/);
  assert.match(res.content[0].text, /# snapshot [0-9]+/); // snapshot-after-action appended
  // walker injected; act call carries [ref, snapshotId, selector, ...]
  assert.deepEqual(calls.executeScript[0].files, ["vendor/dom-accessibility-api.iife.js", "page/a11y-walker.js"]);
  assert.ok(calls.executeScript.some((c) => Array.isArray(c.args) && c.args[0] === "e5"));
});

test("a ref without its snapshotId is refused (the stale guard cannot be skipped)", async () => {
  for (const name of ["katashiro.click", "katashiro.type"]) {
    const { deps: d } = deps();
    const args = name === "katashiro.type" ? { ref: "e5", text: "x" } : { ref: "e5" };
    const res = await BrowserMcp.handleMcpMessage("tools/call", { name, arguments: args }, d);
    assert.equal(res.isError, true, `${name} must refuse a ref with no snapshotId`);
    assert.match(res.content[0].text, /snapshotId/);
  }
});

test("katashiro.wait_for polls then returns a snapshot; missing condition errors", async () => {
  const ok = deps({ scriptResult: { ok: true, snapshotId: 3, title: "T", url: "u", tree: "- x" } });
  const hit = await BrowserMcp.handleMcpMessage(
    "tools/call", { name: "katashiro.wait_for", arguments: { selector: "#ready" } }, ok.deps
  );
  assert.equal(hit.isError, undefined);
  assert.match(hit.content[0].text, /# snapshot [0-9]+/);

  const bad = deps();
  const none = await BrowserMcp.handleMcpMessage(
    "tools/call", { name: "katashiro.wait_for", arguments: {} }, bad.deps
  );
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /needs a selector or text/);
});

test("katashiro.screenshot captures the tab as JPEG and returns base64 image content", async () => {
  const { deps: d, calls } = deps({ dataUrl: "data:image/jpeg;base64,QUJD" });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.screenshot", arguments: {} },
    d
  );
  assert.equal(calls.captureVisibleTab.length, 1);
  assert.equal(calls.captureVisibleTab[0].windowId, 7);
  assert.equal(calls.captureVisibleTab[0].o.format, "jpeg"); // JPEG to stay under the frame cap
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].mimeType, "image/jpeg");
  assert.equal(res.content[0].data, "QUJD"); // data: prefix stripped
});

test("tools/call with no active tab returns an isError result (not a throw)", async () => {
  const { deps: d } = deps({ noTab: true });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.read_dom", arguments: {} },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no active browser tab/);
});

test("tools/call for an unknown tool returns an isError result", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.teleport", arguments: {} },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /unknown tool/);
});

// --- breadth tools: get_text / scroll / tabs / history / press_key / hover / select_option ---

test("get_text returns the element innerText", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, text: "hello page" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.get_text", arguments: {} }, d);
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, "hello page");
});

test("get_text reports a missing selector as an error", async () => {
  const { deps: d } = deps({ scriptResult: { ok: false, error: "no element for selector: #x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.get_text", arguments: { selector: "#x" } }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no element for selector/);
});

test("scroll (page) reports the move and returns the post-action snapshot", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, how: "to bottom", title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.scroll", arguments: { to: "bottom" } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /scrolled to bottom/);
  assert.match(res.content[0].text, /# snapshot [0-9]+/);
});

test("scroll is read-only — runs with act mode off", async () => {
  const { deps: d } = deps({ actMode: false, scriptResult: { ok: true, how: "down 800px", title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.scroll", arguments: { direction: "down" } }, d);
  assert.equal(res.isError, undefined); // not gated
  assert.match(res.content[0].text, /scrolled down 800px/);
});

test("tabs lists open tabs with the active marker", async () => {
  const { deps: d } = deps({ tabsList: [
    { active: true, title: "A", url: "https://a/" },
    { active: false, title: "B", url: "https://b/" }
  ] });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.tabs", arguments: {} }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /\* \[0\] A — https:\/\/a\//);
  assert.match(res.content[0].text, /\[1\] B — https:\/\/b\//);
});

test("history goes back and returns the post-action snapshot", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.history", arguments: { direction: "back" } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /went back/);
  assert.match(res.content[0].text, /# snapshot [0-9]+/);
  assert.deepEqual(calls.goBack, [42]);
});

test("history at the end of the stack returns a clean error, not a throw", async () => {
  const { deps: d } = deps({ historyThrows: true });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.history", arguments: { direction: "back" } }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no back history/);
});

test("scroll with no positioning argument is refused", async () => {
  const { deps: d, calls } = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.scroll", arguments: {} }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /needs one of/);
  assert.equal(calls.executeScript.length, 0); // refused before touching the page
});

test("press_key dispatches to a ref and returns the snapshot", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, how: "ref e5", title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.press_key", arguments: { key: "Enter", ref: "e5", snapshotId: 1 } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /pressed Enter on ref e5/);
  assert.match(res.content[0].text, /# snapshot [0-9]+/);
});

test("press_key with a ref but no snapshotId is refused", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.press_key", arguments: { key: "Enter", ref: "e5" } }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /must carry its snapshotId/);
});

test("hover dispatches pointer events and returns the snapshot", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, how: "ref e5", title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.hover", arguments: { ref: "e5", snapshotId: 1 } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /hovered ref e5/);
  assert.match(res.content[0].text, /# snapshot [0-9]+/);
});

test("hover is read-only — runs with act mode off", async () => {
  const { deps: d } = deps({ actMode: false, scriptResult: { ok: true, how: "ref e5", title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.hover", arguments: { ref: "e5", snapshotId: 1 } }, d);
  assert.equal(res.isError, undefined); // not gated
  assert.match(res.content[0].text, /hovered ref e5/);
});

test("select_option selects by value and returns the snapshot", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, how: "ref e5", selected: "v2", title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.select_option", arguments: { ref: "e5", snapshotId: 1, value: "v2" } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /selected v2 in ref e5/);
  assert.match(res.content[0].text, /# snapshot [0-9]+/);
});

test("select_option without value or label is refused", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.select_option", arguments: { ref: "e5", snapshotId: 1 } }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /needs a value or a label/);
});

test("reload reloads the active tab and returns the snapshot", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.reload", arguments: {} }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /reloaded/);
  assert.match(res.content[0].text, /# snapshot [0-9]+/);
  assert.deepEqual(calls.reload, [{ tabId: 42, o: { bypassCache: false } }]);
});

test("reload with bypassCache does a hard reload", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, title: "T", url: "https://t/", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.reload", arguments: { bypassCache: true } }, d);
  assert.match(res.content[0].text, /reloaded \(bypassing cache\)/);
  assert.deepEqual(calls.reload, [{ tabId: 42, o: { bypassCache: true } }]);
});

// --- act mode: the write consent gate ---------------------------------------

// Which tools mutate state (the page, or the browser's tabs) is a registry fact, so assert it
// there rather than restating the list in every gate test below.
const WRITE_TOOLS = Object.entries(BrowserMcp.TOOLS)
  .filter(([, t]) => t.write)
  .map(([name]) => name);

test("exactly the mutating tools are marked write", () => {
  assert.deepEqual(WRITE_TOOLS.sort(), [
    "katashiro.click",
    "katashiro.click_text",
    "katashiro.close_tab",
    "katashiro.fill_form",
    "katashiro.group_tabs",
    "katashiro.history",
    "katashiro.inject_css",
    "katashiro.navigate",
    "katashiro.new_tab",
    "katashiro.paste_image",
    "katashiro.press_key",
    "katashiro.reload",
    "katashiro.reopen_tab",
    "katashiro.select_option",
    "katashiro.split_tabs",
    "katashiro.switch_tab",
    "katashiro.tab_update",
    "katashiro.type",
    "katashiro.type_text",
    "katashiro.ungroup_tabs",
    "katashiro.unsplit_tabs",
    "katashiro.update_tab_group",
    "katashiro.upload_file"
  ]);
});

test("act mode off refuses every write tool with a usable explanation", async () => {
  for (const name of WRITE_TOOLS) {
    const { deps: d, calls } = deps({ actMode: false });
    const res = await BrowserMcp.handleMcpMessage(
      "tools/call",
      { name, arguments: { selector: "#x", text: "t", url: "https://example.com" } },
      d
    );
    assert.equal(res.isError, true, `${name} should be refused`);
    assert.match(res.content[0].text, /act mode is off/);
    // Refused means not executed — no script injected, no navigation issued.
    assert.equal(calls.executeScript.length, 0, `${name} must not touch the page`);
    assert.equal(calls.tabsUpdate.length, 0, `${name} must not navigate`);
  }
});

test("act mode off still allows the read tools", async () => {
  const { deps: d } = deps({ actMode: false, scriptResult: { ok: true, html: "<p>hi</p>" } });
  const dom = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.read_dom", arguments: {} },
    d
  );
  assert.equal(dom.isError, undefined);
  assert.equal(dom.content[0].text, "<p>hi</p>");

  const shot = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.screenshot" }, d);
  assert.equal(shot.isError, undefined);
  assert.equal(shot.content[0].type, "image");
});

test("act mode on lets a write through", async () => {
  const { deps: d, calls } = deps({ actMode: true });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.click", arguments: { selector: "#go" } },
    d
  );
  assert.equal(res.isError, undefined);
  assert.ok(calls.executeScript.length >= 1, "the write executed (inject + act + post-snapshot)");
});

test("a refused write says it was refused, not that there was no tab", async () => {
  // Consent is checked before the environment: with act mode off AND no tab, the user-facing
  // reason must be the gate, or the operator chases a phantom browser problem.
  const { deps: d } = deps({ actMode: false, noTab: true });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.click", arguments: { selector: "#go" } },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /act mode is off/);
  assert.doesNotMatch(res.content[0].text, /no active browser tab/);
});

test("write tools stay advertised while act mode is off (discovery is cached)", async () => {
  const { deps: d } = deps({ actMode: false });
  const res = await BrowserMcp.handleMcpMessage("tools/list", {}, d);
  const names = res.tools.map((t) => t.name);
  for (const name of WRITE_TOOLS) assert.ok(names.includes(name), `${name} should still list`);
});

// --- supported-scheme check + act-mode ordering -----------------------------

test("a page with no scriptable web origin (chrome://) is refused with a clear message", async () => {
  const { deps: d, calls } = deps({ tabUrl: "chrome://settings", scriptResult: { ok: true, html: "x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.read_dom", arguments: {} }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no grantable web origin/);
  assert.equal(calls.executeScript.length, 0, "an unsupported page is never scripted");
});

test("a write with act mode off is refused with the act-mode message", async () => {
  const { deps: d } = deps({ actMode: false });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.click", arguments: { selector: "#x" } }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /act mode is off/);
});

// --- tunnel control: handleServerRequest ------------------------------------

test("mcp/connect names the connection, stores it, and fires onStatus(true)", async () => {
  const { deps: d, sent, statuses } = deps({ uuid: "conn-xyz" });
  const state = { mcpConnectionId: null };
  await BrowserMcp.handleServerRequest({ id: 1, method: "mcp/connect", params: {} }, d, state);
  assert.deepEqual(sent, [{ jsonrpc: "2.0", id: 1, result: { connectionId: "conn-xyz" } }]);
  assert.equal(state.mcpConnectionId, "conn-xyz");
  assert.deepEqual(statuses, [true]); // UI told the browser is now attached
});

// Open a tunnel the way the gateway does, and hand back the connection id every later frame
// has to carry. Messaging an un-established connection is not a shape the gateway can produce.
async function connect(bag) {
  const state = { connections: {} };
  await BrowserMcp.handleServerRequest({ id: 0, method: "mcp/connect", params: {} }, bag.deps, state);
  const connectionId = bag.sent[bag.sent.length - 1].result.connectionId;
  bag.sent.length = 0; // drop the connect frame; each test asserts on its own
  return { state, connectionId };
}

test("mcp/message initialize replies on the outer ACP id", async () => {
  const bag = deps();
  const { state, connectionId } = await connect(bag);
  await BrowserMcp.handleServerRequest(
    { id: 9, method: "mcp/message", params: { connectionId, method: "initialize", params: {} } },
    bag.deps,
    state
  );
  assert.equal(bag.sent.length, 1);
  assert.equal(bag.sent[0].id, 9);
  assert.equal(bag.sent[0].result.serverInfo.name, "katashiro-browser");
});

test("mcp/message notifications/initialized sends NO response frame", async () => {
  const bag = deps();
  const { state, connectionId } = await connect(bag);
  await BrowserMcp.handleServerRequest(
    { id: 10, method: "mcp/message", params: { connectionId, method: "notifications/initialized" } },
    bag.deps,
    state
  );
  assert.equal(bag.sent.length, 0);
});

// This is the frame OpenAB's discovery cache actually sends (one `tools/list` per declared
// server, result cached and reused across reconnects — ADR §6.3). It arrives with NO inner
// `params` key at all, because the gateway sends `None`; serving it is the whole of the
// katashiro side of pull-based discovery.
test("mcp/message tools/list: discovery round-trip with no inner params", async () => {
  const bag = deps();
  const { state, connectionId } = await connect(bag);
  await BrowserMcp.handleServerRequest(
    { id: 12, method: "mcp/message", params: { connectionId, method: "tools/list" } },
    bag.deps,
    state
  );
  assert.equal(bag.sent.length, 1);
  assert.equal(bag.sent[0].id, 12, "the reply correlates on the OUTER acp id");

  // The shape the gateway deserializes into its own Tool type: drop any of these three
  // fields and discovery silently caches nothing.
  const tools = bag.sent[0].result.tools;
  assert.equal(tools.length, BrowserMcp.BROWSER_TOOLS.length);
  for (const t of tools) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.description, "string");
    assert.equal(t.inputSchema.type, "object");
  }
  assert.deepEqual(
    tools.map((t) => t.name),
    Object.keys(BrowserMcp.TOOLS),
    "what we publish over the tunnel is the registry itself"
  );
});

test("mcp/message tools/call read_dom: full tunnel round-trip", async () => {
  const bag = deps({ scriptResult: { ok: true, html: "<h1>ok</h1>" } });
  const { state, connectionId } = await connect(bag);
  await BrowserMcp.handleServerRequest(
    {
      id: 11,
      method: "mcp/message",
      params: {
        connectionId,
        method: "tools/call",
        params: { name: "katashiro.read_dom", arguments: {} }
      }
    },
    bag.deps,
    state
  );
  assert.equal(bag.calls.executeScript.length, 1);
  assert.equal(bag.sent.length, 1);
  assert.equal(bag.sent[0].id, 11);
  assert.equal(bag.sent[0].result.content[0].text, "<h1>ok</h1>");
});

// --- unknown connections are refused, never guessed at ----------------------

test("mcp/message on a connection we never minted is refused, not served", async () => {
  const bag = deps();
  const { state } = await connect(bag);
  await BrowserMcp.handleServerRequest(
    { id: 20, method: "mcp/message", params: { connectionId: "not-ours", method: "tools/list" } },
    bag.deps,
    state
  );
  assert.equal(bag.sent.length, 1);
  assert.equal(bag.sent[0].error.code, -32602);
  assert.match(bag.sent[0].error.message, /unknown connection/);
  assert.equal(bag.sent[0].result, undefined, "an unknown handle must not receive a tool list");
});

test("mcp/disconnect on an unknown connection does not take the live ones down", async () => {
  const bag = await twoServers();
  bag.statuses.length = 0;
  await BrowserMcp.handleServerRequest(
    { id: 21, method: "mcp/disconnect", params: { connectionId: "not-ours" } },
    bag.deps,
    bag.state
  );
  assert.deepEqual(bag.sent[bag.sent.length - 1], { jsonrpc: "2.0", id: 21, result: {} }, "still acked");
  assert.deepEqual(Object.keys(bag.state.connections).sort(), ["conn-k", "conn-n"]);
  assert.deepEqual(bag.statuses, [], "no detach event for a handle that was never ours");
});

test("mcp/disconnect clears the connection state, acks, and fires onStatus(false)", async () => {
  const { deps: d, sent, statuses } = deps();
  const state = { mcpConnectionId: "still-here" };
  await BrowserMcp.handleServerRequest({ id: 2, method: "mcp/disconnect", params: {} }, d, state);
  assert.deepEqual(sent, [{ jsonrpc: "2.0", id: 2, result: {} }]);
  assert.equal(state.mcpConnectionId, null);
  assert.deepEqual(statuses, [false]); // UI told the browser detached
});

test("unknown server-initiated method returns JSON-RPC -32601", async () => {
  const { deps: d, sent } = deps();
  const state = { mcpConnectionId: null };
  await BrowserMcp.handleServerRequest({ id: 3, method: "mcp/bogus", params: {} }, d, state);
  assert.equal(sent[0].error.code, -32601);
});

// --- multi-server: two client-declared servers in one session ---------------
//
// The gateway `mcp/connect`s once per declared `type:acp` server and addresses each by the
// `connectionId` we hand back. This is the client end of OpenAB's multi-server fan-out: two
// instances, two registries, one socket.

// A second client-side MCP server that has nothing to do with the browser.
const notesTools = {
  "notes.list": {
    description: "List the user's notes.",
    inputSchema: { type: "object", properties: {} },
    async call() {
      return { content: [{ type: "text", text: "note-1" }] };
    }
  }
};

// Declare both servers and open a tunnel to each; returns their connection ids.
async function twoServers(opts = {}) {
  const bag = deps({ ...opts, uuid: ["conn-k", "conn-n"] });
  const katashiro = BrowserMcp.createServer({
    id: "srv-k",
    name: "katashiro",
    serverName: "katashiro-browser"
  });
  const notes = BrowserMcp.createServer({ id: "srv-n", name: "notes", tools: notesTools });
  const state = { servers: [katashiro, notes], connections: {} };

  await BrowserMcp.handleServerRequest(
    { id: 1, method: "mcp/connect", params: { acpId: "srv-k" } },
    bag.deps,
    state
  );
  await BrowserMcp.handleServerRequest(
    { id: 2, method: "mcp/connect", params: { acpId: "srv-n" } },
    bag.deps,
    state
  );
  return { ...bag, state, katashiro, notes };
}

// Drive one inner MCP request over a given connection and return the reply frame.
async function overTunnel(bag, id, connectionId, method, params) {
  const before = bag.sent.length;
  await BrowserMcp.handleServerRequest(
    { id, method: "mcp/message", params: { connectionId, method, params } },
    bag.deps,
    bag.state
  );
  return bag.sent[before];
}

test("declaration() is the session/new entry for the instance", () => {
  const s = BrowserMcp.createServer({ id: "srv-x", name: "notes", tools: notesTools });
  assert.deepEqual(s.declaration(), { type: "acp", id: "srv-x", name: "notes" });
});

test("each declared server gets its own connection handle", async () => {
  const { sent, state } = await twoServers();
  assert.equal(sent[0].result.connectionId, "conn-k");
  assert.equal(sent[1].result.connectionId, "conn-n");
  assert.equal(state.connections["conn-k"].name, "katashiro");
  assert.equal(state.connections["conn-n"].name, "notes");
});

test("tools/list is answered per connection, not globally", async () => {
  const bag = await twoServers();
  const k = await overTunnel(bag, 3, "conn-k", "tools/list", {});
  const n = await overTunnel(bag, 4, "conn-n", "tools/list", {});
  assert.deepEqual(k.result.tools.map((t) => t.name), Object.keys(BrowserMcp.TOOLS));
  assert.deepEqual(n.result.tools.map((t) => t.name), ["notes.list"]);
});

test("initialize reports the addressed server's own identity", async () => {
  const bag = await twoServers();
  const k = await overTunnel(bag, 3, "conn-k", "initialize", {});
  const n = await overTunnel(bag, 4, "conn-n", "initialize", {});
  assert.equal(k.result.serverInfo.name, "katashiro-browser");
  assert.equal(n.result.serverInfo.name, "notes");
});

test("tools/call reaches the addressed server's registry", async () => {
  const bag = await twoServers({ scriptResult: { ok: true, html: "<p>page</p>" } });
  const n = await overTunnel(bag, 3, "conn-n", "tools/call", { name: "notes.list", arguments: {} });
  assert.equal(n.result.content[0].text, "note-1");

  const k = await overTunnel(bag, 4, "conn-k", "tools/call", {
    name: "katashiro.read_dom",
    arguments: {}
  });
  assert.equal(k.result.content[0].text, "<p>page</p>");
});

test("a server cannot be reached through another server's connection", async () => {
  const bag = await twoServers();
  const res = await overTunnel(bag, 3, "conn-k", "tools/call", {
    name: "notes.list",
    arguments: {}
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /unknown tool/);
});

// Multi-conversation §3.9: one browser server per (conversation, agent). An mcp/connect whose
// acpId names no declared server (a late connect for an archived conversation) is refused, never
// routed to another conversation's server — however many are left. Only a missing acpId falls back.
test("mcp/connect: an unknown acpId is refused when several servers are declared", async () => {
  const bag = await twoServers();
  const before = Object.keys(bag.state.connections).length;
  await BrowserMcp.handleServerRequest({ id: 9, method: "mcp/connect", params: { acpId: "srv-gone" } }, bag.deps, bag.state);
  const reply = bag.sent[bag.sent.length - 1];
  assert.equal(reply.id, 9);
  assert.match(reply.error.message, /unknown server: srv-gone/);
  assert.equal(Object.keys(bag.state.connections).length, before);
});

test("mcp/connect: with a single declared server an unknown acpId is still refused", async () => {
  const bag = deps({ uuid: ["conn-1"] });
  const only = BrowserMcp.createServer({ id: "srv-1", name: "katashiro" });
  const state = { servers: [only], connections: {} };
  await BrowserMcp.handleServerRequest({ id: 1, method: "mcp/connect", params: { acpId: "srv-other" } }, bag.deps, state);
  assert.match(bag.sent[0].error.message, /unknown server: srv-other/);
  assert.deepEqual(state.connections, {});
});

test("mcp/connect: archiving one of two conversations, a late connect for it is not routed to the survivor", async () => {
  const bag = deps({ uuid: ["conn-1"] });
  const a = BrowserMcp.createServer({ id: "srv-a", name: "katashiro" });
  const b = BrowserMcp.createServer({ id: "srv-b", name: "katashiro" });
  const state = { servers: [a, b], connections: {} };
  state.servers = state.servers.filter((s) => s !== a);          // what Conn.dropState does
  await BrowserMcp.handleServerRequest({ id: 1, method: "mcp/connect", params: { acpId: "srv-a" } }, bag.deps, state);
  assert.match(bag.sent[0].error.message, /unknown server: srv-a/);
  assert.deepEqual(state.connections, {});
});

test("mcp/connect: with a single declared server a missing acpId falls back to it", async () => {
  const bag = deps({ uuid: ["conn-1"] });
  const only = BrowserMcp.createServer({ id: "srv-1", name: "katashiro" });
  const state = { servers: [only], connections: {} };
  await BrowserMcp.handleServerRequest({ id: 1, method: "mcp/connect", params: {} }, bag.deps, state);
  assert.equal(bag.sent[0].result.connectionId, "conn-1");
  assert.equal(state.connections["conn-1"], only);
});

test("depsFor: each server's calls run with its own deps; a refusing instance runs nothing and shows no pill", async () => {
  const bag = await twoServers({ scriptResult: { ok: true, html: "<p>page</p>" } });
  const events = [];
  bag.deps.depsFor = (server) => (server === bag.notes
    ? { ...bag.deps, refuse: "this conversation is not on screen in Katashiro", onToolCall: (e) => events.push(e) }
    : { ...bag.deps, onToolCall: (e) => events.push(e) });
  const n = await overTunnel(bag, 3, "conn-n", "tools/call", { name: "notes.list", arguments: {} });
  assert.equal(n.result.isError, true);
  assert.equal(n.result.content[0].text, "this conversation is not on screen in Katashiro");
  assert.equal(events.length, 0);
  const k = await overTunnel(bag, 4, "conn-k", "tools/call", { name: "katashiro.read_dom", arguments: {} });
  assert.equal(k.result.content[0].text, "<p>page</p>");
  assert.deepEqual(events.map((e) => e.phase), ["start", "done"]);
  // tools/list and initialize still answer on a refusing instance (a late handshake must not hang).
  const l = await overTunnel(bag, 5, "conn-n", "tools/list", {});
  assert.deepEqual(l.result.tools.map((t) => t.name), ["notes.list"]);
});

test("onStatus fires once on the first tunnel, not per server", async () => {
  const { statuses } = await twoServers();
  assert.deepEqual(statuses, [true]);
});

test("one server disconnecting leaves the other callable and still attached", async () => {
  const bag = await twoServers();
  await BrowserMcp.handleServerRequest(
    { id: 5, method: "mcp/disconnect", params: { connectionId: "conn-n" } },
    bag.deps,
    bag.state
  );
  assert.deepEqual(bag.statuses, [true], "the browser is still reachable — no detach event");
  assert.equal(bag.state.connections["conn-n"], undefined);

  const k = await overTunnel(bag, 6, "conn-k", "tools/list", {});
  assert.equal(k.result.tools.length, BrowserMcp.BROWSER_TOOLS.length, "the surviving server still answers");
});

test("onStatus(false) only when the LAST tunnel closes", async () => {
  const bag = await twoServers();
  for (const [i, id] of ["conn-n", "conn-k"].entries()) {
    await BrowserMcp.handleServerRequest(
      { id: 10 + i, method: "mcp/disconnect", params: { connectionId: id } },
      bag.deps,
      bag.state
    );
  }
  assert.deepEqual(bag.statuses, [true, false]);
  assert.equal(bag.state.mcpConnectionId, null);
});

// --- snapshot (a11y-tree perception) ----------------------------------------

test("snapshot injects the vendored a11y engine + walker, then returns the tree with a header", async () => {
  const { chrome, calls } = mockChrome({
    scriptResult: {
      ok: true, snapshotId: 3, url: "https://example.test/", title: "Example",
      tree: '- button "Go" [ref=e1]'
    }
  });
  // Read-only: reachable even with act mode OFF (no write gate).
  const res = await BrowserMcp.callBrowserTool("katashiro.snapshot", {}, { chrome, actMode: false });
  assert.equal(res.isError, undefined, "snapshot is not gated by act mode");
  assert.match(res.content[0].text, /snapshot [0-9]+ — Example/);
  assert.match(res.content[0].text, /\[ref=e1\]/);
  // It injected the vendored lib + walker as files, then ran a func to build the snapshot.
  const filesInj = calls.executeScript.find((c) => c.files);
  assert.deepEqual(filesInj.files, ["vendor/dom-accessibility-api.iife.js", "page/a11y-walker.js"]);
  assert.ok(calls.executeScript.some((c) => typeof c.func === "function"), "runs the snapshot func");
});

test("K3: snapshot forwards a `selector` to the walker as the rootSelector arg (scoped re-snapshot)", async () => {
  const seen = [];
  const chrome = {
    tabs: { query: async () => [{ id: 42, windowId: 7, url: "https://top/" }] },
    scripting: {
      executeScript: async (inj) => {
        if (inj.files) return [{ frameId: 0, result: { ok: true } }];
        seen.push(inj.args);
        return [{ frameId: 0, result: { ok: true, matched: true, title: "Top", url: "https://top/", tree: "- button [ref=e1]" } }];
      }
    }
  };
  await BrowserMcp.callBrowserTool("katashiro.snapshot", { selector: "#results" }, { chrome, actMode: false });
  const snapArgs = seen.find((a) => Array.isArray(a) && a[2] === "#results"); // [snapshotId, after, rootSelector]
  assert.ok(snapArgs, "the selector reaches the injected func as the rootSelector arg");
  assert.equal(snapArgs[1], false, "an explicit snapshot uses the non-after path");
});

test("K3: a selector that matches no frame returns an explicit signal, not an empty snapshot", async () => {
  const chrome = {
    tabs: { query: async () => [{ id: 42, windowId: 7, url: "https://top/" }] },
    scripting: {
      executeScript: async (inj) => {
        if (inj.files) return [{ frameId: 0, result: { ok: true } }];
        return [{ frameId: 0, result: { ok: true, matched: false, title: "Top", url: "https://top/", tree: "" } }];
      }
    }
  };
  const res = await BrowserMcp.callBrowserTool("katashiro.snapshot", { selector: "#nope" }, { chrome, actMode: false });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /matched no element/);
  assert.match(res.content[0].text, /#nope/);
});

test("K3: an invalid selector is reported (not silently dropped by the frame merge)", async () => {
  const chrome = {
    tabs: { query: async () => [{ id: 42, windowId: 7, url: "https://top/" }] },
    scripting: {
      executeScript: async (inj) => {
        if (inj.files) return [{ frameId: 0, result: { ok: true } }];
        return [{ frameId: 0, result: { ok: true, matched: false, selectorError: "'::::' is not a valid selector", title: "Top", url: "https://top/", tree: "" } }];
      }
    }
  };
  const res = await BrowserMcp.callBrowserTool("katashiro.snapshot", { selector: "::::" }, { chrome, actMode: false });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /invalid selector/);
  assert.match(res.content[0].text, /not a valid selector/);
});

test("K2: a snapshot-bearing result is NOT annotated (its header already has the current tab; no stale/dup)", async () => {
  // click returns "clicked …\n\n# snapshot N — <title>" — the header carries the current page.
  const { deps: d } = deps({ scriptResult: { ok: true, how: "ref e5", snapshotId: 2, title: "T", url: "https://t/", tree: "- x", matched: undefined } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.click", arguments: { selector: "#b" } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /# snapshot \d+ —/);
  assert.ok(!res.content.some((c) => /^— tab:/.test((c && c.text) || "")), "snapshot returns skip the tab block");
});

test("K2: a TRUNCATED snapshot header also skips the tab block (Orca — big pages are the stale-prone case)", async () => {
  // header build adds ` (truncated)` before the ` — `; the skip must not be defeated by it.
  const { deps: d } = deps({ scriptResult: { ok: true, how: "ref e5", snapshotId: 9, title: "Big", url: "https://big/", tree: "- x", truncated: true } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.click", arguments: { selector: "#b" } }, d);
  assert.match(res.content[0].text, /# snapshot \d+ \(truncated\) —/);
  assert.ok(!res.content.some((c) => /^— tab:/.test((c && c.text) || "")), "truncated snapshot returns also skip the tab block");
});

test("K2: a successful read carries a trailing active-tab context block; errors do not", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, text: "hello page" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.get_text", arguments: {} }, d);
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, "hello page");                       // raw content untouched
  const last = res.content[res.content.length - 1];
  assert.match(last.text, /^— tab: /);                                   // context is its own block
  assert.match(last.text, /https:\/\/t\//);                              // the mock active-tab url

  const { deps: e } = deps({ scriptResult: { ok: false, error: "no element for selector: #x" } });
  const err = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.get_text", arguments: { selector: "#x" } }, e);
  assert.equal(err.isError, true);
  assert.ok(!err.content.some((c) => /^— tab:/.test((c && c.text) || "")), "errors are not annotated");
});

test("snapshot with no usable frame content degrades to a placeholder, not a crash", async () => {
  // The multi-frame merge is resilient: a frame that yields nothing doesn't fail the whole snapshot.
  const { chrome } = mockChrome({ scriptResult: { ok: false, error: "no body" } });
  const res = await BrowserMcp.callBrowserTool("katashiro.snapshot", {}, { chrome, actMode: true });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /# snapshot [0-9]+/);
});

// --- frames (fN:eM) ---------------------------------------------------------

test("snapshot merges child frames with f<id>:eN namespaced refs", async () => {
  const chrome = {
    tabs: { query: async () => [{ id: 42, windowId: 7, url: "https://top/" }] },
    scripting: {
      executeScript: async (inj) => {
        if (inj.files) return [{ frameId: 0, result: { ok: true } }];
        return [
          { frameId: 0, result: { ok: true, title: "Top", url: "https://top/", tree: '- button "A" [ref=e1]' } },
          { frameId: 7, result: { ok: true, title: "", url: "https://iframe/", tree: '- textbox "Email" [ref=e1]' } }
        ];
      }
    }
  };
  const res = await BrowserMcp.callBrowserTool("katashiro.snapshot", {}, { chrome, actMode: false });
  const text = res.content[0].text;
  assert.match(text, /# snapshot [0-9]+ — Top/);
  assert.match(text, /- button "A" \[ref=e1\]/);                 // top frame: bare ref
  assert.match(text, /--- frame f7 \(https:\/\/iframe\/\) ---/); // child frame section
  assert.match(text, /- textbox "Email" \[ref=f7:e1\]/);         // child frame: namespaced ref
});

test("click on a child-frame ref targets that frame with the bare ref", async () => {
  const calls = [];
  const chrome = {
    tabs: { query: async () => [{ id: 42, windowId: 7, url: "https://top/" }] },
    scripting: {
      executeScript: async (inj) => {
        calls.push(inj);
        return [{ frameId: 0, result: { ok: true, how: "ref e3", title: "T", url: "u", tree: "- x" } }];
      }
    }
  };
  await BrowserMcp.callBrowserTool("katashiro.click", { ref: "f7:e3", snapshotId: 5 }, { chrome, actMode: true });
  const framed = calls.filter((c) => c.target && Array.isArray(c.target.frameIds) && c.target.frameIds[0] === 7);
  assert.ok(framed.length >= 1, "inject + act targeted frame 7");
  const act = calls.find((c) => Array.isArray(c.args) && c.args[0] === "e3");
  assert.ok(act, "act call passes the bare in-frame ref e3, not the prefixed one");
});

// --- Jev semantic tool: click_text (Phase 3) --------------------------------
// click_text snapshots the page, asks Jev `choice` to disambiguate the description to a ref,
// then delegates to the click tool. Refused (isError) when no Jev token is set.
const mockJevChoice = {
  evaluate: async () => ({ pick: "e5" }),
  choice: (a, n) => (a && typeof a[n] === "string" ? a[n] : null),
  noul: (a, n) => (a && typeof a[n] === "number" ? a[n] : null),
};

test("click_text: Jev disambiguates the description to a ref and clicks it", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, how: "ref e5", snapshotId: 2, title: "T", url: "https://t/", tree: '- button "Submit" [ref=e5]' } });
  d.jevToken = "sk-or-x";
  d.jev = mockJevChoice;
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.click_text", arguments: { description: "the submit button" } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /click_text "the submit button" . e5/);
});

test("click_text: refused (isError) when no Jev token is set", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, title: "T", url: "u", tree: '- button [ref=e5]' } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.click_text", arguments: { description: "x" } }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /needs a Jev token/);
});

test("click_text: is advertised in the tool registry", () => {
  assert.ok(BrowserMcp.TOOLS["katashiro.click_text"], "click_text is registered");
  assert.equal(BrowserMcp.TOOLS["katashiro.click_text"].write, true, "click_text is a write tool (act-gated)");
});

// --- click_text candidate context: relevance-ranked extractRefCandidates -----
// The old first-N-in-document-order cut dropped a deep target on busy pages; ranking by
// description-keyword overlap must keep the target in the criteria Jev sees.
test("extractRefCandidates ranks the description-matching target above the cap (busy page)", () => {
  const lines = [];
  for (let i = 1; i <= 65; i++) lines.push(`- link "nav item ${i}" [ref=e${i}]`);
  lines.push('- link "中信兄弟 精華 highlights" [ref=e99]'); // the target, deep past the 60 cap
  const cands = BrowserMcp.extractRefCandidates(lines.join("\n"), "中信兄弟 精華", 60);
  assert.ok(cands["e99"], "deep matching target survives the cap via relevance ranking");
  assert.match(cands["e99"], /中信兄弟/);
});

test("extractRefCandidates keeps document order when the description has no usable keywords", () => {
  const lines = ["- button \"b1\" [ref=e1]", "- button \"b2\" [ref=e2]", "- button \"b3\" [ref=e3]"];
  const cands = BrowserMcp.extractRefCandidates(lines.join("\n"), "", 60);
  assert.deepEqual(Object.keys(cands), ["e1", "e2", "e3"]);
});

test("extractRefCandidates strips the ref marker, keeping role + accessible name as the label", () => {
  const cands = BrowserMcp.extractRefCandidates('- button "Sign in" [ref=e5]', "sign in", 60);
  assert.equal(cands["e5"], 'button "Sign in"');
});

// --- Jev semantic tools: type_text + assert ---------------------------------
const mockJevPick = {
  evaluate: async () => ({ pick: "e5" }),
  choice: (a, n) => (a && typeof a[n] === "string" ? a[n] : null),
  noul: (a, n) => (a && typeof a[n] === "number" ? a[n] : null),
};
const mockJevNoul = {
  evaluate: async () => ({ holds: 0.92 }),
  choice: (a, n) => (a && typeof a[n] === "string" ? a[n] : null),
  noul: (a, n) => (a && typeof a[n] === "number" ? a[n] : null),
};

test("type_text: Jev disambiguates the field and types into it", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, how: "ref e5", snapshotId: 2, title: "T", url: "https://t/", tree: '- textbox "Search" [ref=e5]' } });
  d.jevToken = "sk-or-x"; d.jev = mockJevPick;
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.type_text", arguments: { description: "the search box", text: "hello" } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /type_text "the search box" . e5/);
});

test("type_text: refused (isError) without a Jev token", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, tree: '- textbox "Search" [ref=e5]' } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.type_text", arguments: { description: "x", text: "y" } }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /needs a Jev token/);
});

test("assert: returns Jev's yes/no verdict + probability, read-only (runs with act mode off)", async () => {
  const { deps: d } = deps({ actMode: false, scriptResult: { ok: true, title: "T", url: "u", tree: '- heading "Sign in"' } });
  d.jevToken = "sk-or-x"; d.jev = mockJevNoul;
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.assert", arguments: { question: "is this a login wall?" } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /assert "is this a login wall\?" . yes \(0\.92\)/);
});

test("assert: refused (isError) without a Jev token", async () => {
  const { deps: d } = deps({ scriptResult: { ok: true, tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.assert", arguments: { question: "?" } }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /needs a Jev token/);
});

test("extractRefCandidates ranks non-Chinese scripts too (\\p{L} coverage, e.g. Hangul)", () => {
  const lines = [];
  for (let i = 1; i <= 65; i++) lines.push(`- link "nav ${i}" [ref=e${i}]`);
  lines.push('- button "로그인 하기" [ref=e99]'); // Korean "log in", deep past the 60 cap
  const cands = BrowserMcp.extractRefCandidates(lines.join("\n"), "로그인", 60);
  assert.ok(cands["e99"], "Hangul target survives the cap (old zh-only regex would have dropped it)");
});

// --- click button / doubleClick ---------------------------------------------

test("click passes the click mode to the page: single by default, right / double on request", async () => {
  for (const [extra, mode, verb] of [[{}, "single", "clicked"], [{ button: "right" }, "right", "right-clicked"], [{ doubleClick: true }, "double", "double-clicked"]]) {
    const { deps: d, calls } = deps({ scriptResult: { ok: true, how: "selector #m", tree: "- x" } });
    const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.click", arguments: { selector: "#m", ...extra } }, d);
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, new RegExp(`^${verb} selector #m`));
    const act = calls.executeScript.find((c) => Array.isArray(c.args) && c.args[2] === "#m");
    assert.equal(act.args[3], mode);
  }
});

test("click refuses an unknown button and a right-button double-click", async () => {
  for (const extra of [{ button: "middle" }, { button: "right", doubleClick: true }]) {
    const { deps: d, calls } = deps();
    const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.click", arguments: { selector: "#m", ...extra } }, d);
    assert.equal(res.isError, true);
    assert.equal(calls.executeScript.length, 0, "refused before touching the page");
  }
});

// --- highlight ----------------------------------------------------------------

test("highlight is read-only — runs with act mode off and returns no snapshot", async () => {
  const { deps: d, calls } = deps({ actMode: false, scriptResult: { ok: true, how: "ref e5" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.highlight", arguments: { ref: "e5", snapshotId: 3, label: "this one" } }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /^highlighted ref e5 for 4000ms — "this one"/);
  assert.doesNotMatch(res.content[0].text, /# snapshot/);
  const act = calls.executeScript.find((c) => Array.isArray(c.args) && c.args[0] === "e5");
  assert.deepEqual(act.args, ["e5", 3, null, "this one", 4000]);
});

test("highlight clamps the duration and refuses an over-long label", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, how: "selector #a" } });
  await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.highlight", arguments: { selector: "#a", durationMs: 600000 } }, d);
  assert.equal(calls.executeScript.find((c) => Array.isArray(c.args) && c.args[2] === "#a").args[4], 15000);

  const long = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.highlight", arguments: { selector: "#a", label: "x".repeat(81) } }, long.deps);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /keep it to 80/);
  assert.equal(long.calls.executeScript.length, 0);
});

test("highlight clear sweeps every frame; no target and no clear is an error", async () => {
  const { deps: d, calls } = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.highlight", arguments: { clear: true } }, d);
  assert.match(res.content[0].text, /^cleared highlights/);
  assert.equal(calls.executeScript[0].target.allFrames, true);

  const bad = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.highlight", arguments: {} }, deps().deps);
  assert.equal(bad.isError, true);
});

// --- get_selection --------------------------------------------------------------

test("get_selection reports the selection with its container, labelling child frames", async () => {
  const { deps: d, calls } = deps({
    actMode: false,
    frameResults: [
      { frameId: 0, result: { text: "hello world", within: "p#intro", url: "https://t/" } },
      { frameId: 5, result: { text: "" } },
      { frameId: 7, result: { text: "in a frame", within: "td", url: "https://f/" } }
    ]
  });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.get_selection", arguments: {} }, d);
  assert.equal(res.isError, undefined);
  assert.equal(calls.executeScript[0].target.allFrames, true);
  assert.match(res.content[0].text, /^selection in p#intro:\nhello world/);
  assert.match(res.content[0].text, /selection in td \[frame f7: https:\/\/f\/\]:\nin a frame/);
  assert.doesNotMatch(res.content[0].text, /f5/);
});

test("get_selection with nothing selected says so (not an error)", async () => {
  const { deps: d } = deps({ frameResults: [{ frameId: 0, result: { text: "" } }] });
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.get_selection", arguments: {} }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /nothing is selected/);
});

// --- fill_form ------------------------------------------------------------------

test("fill_form validates every field before filling any (two passes per frame)", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", {
    name: "katashiro.fill_form",
    arguments: { snapshotId: 9, fields: [{ ref: "e1", value: "Ada" }, { ref: "f3:e2", checked: true }, { selector: "#c", value: "TW" }] }
  }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /^filled 3 fields: e1, f3:e2, #c/);
  const acts = calls.executeScript.filter((c) => Array.isArray(c.args) && Array.isArray(c.args[0]));
  // frame 0 (e1 + #c) and frame 3 (e2): validate both, then apply both.
  assert.deepEqual(acts.map((c) => [c.target.frameIds[0], c.args[2]]), [[0, false], [3, false], [0, true], [3, true]]);
  assert.deepEqual(acts[1].args[0], [{ i: 1, ref: "e2", label: "f3:e2", selector: null, value: null, checked: true }]);
  assert.equal(acts[0].args[1], 9);
});

test("fill_form fills nothing when the check pass fails", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: false, error: "field 0 (#x) is disabled or read-only" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", {
    name: "katashiro.fill_form", arguments: { fields: [{ selector: "#x", value: "a" }] }
  }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /nothing was filled/);
  assert.ok(!calls.executeScript.some((c) => Array.isArray(c.args) && c.args[2] === true), "no apply pass ran");
});

test("fill_form argument checks: empty, missing target, missing value, ref without snapshotId", async () => {
  for (const [args, re] of [
    [{ fields: [] }, /non-empty/],
    [{ fields: [{ value: "a" }] }, /field 0 needs a ref/],
    [{ fields: [{ selector: "#a" }] }, /field 0 needs a `value`/],
    [{ fields: [{ ref: "e1", value: "a" }] }, /snapshotId/],
    [{ fields: Array.from({ length: 51 }, () => ({ selector: "#a", value: "a" })) }, /at most 50/]
  ]) {
    const { deps: d, calls } = deps();
    const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.fill_form", arguments: args }, d);
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, re);
    assert.equal(calls.executeScript.length, 0);
  }
});

// --- upload_file ----------------------------------------------------------------

test("upload_file sends normalized files to the page and reports the byte total", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, how: "selector #f", tree: "- x" } });
  const res = await BrowserMcp.handleMcpMessage("tools/call", {
    name: "katashiro.upload_file",
    arguments: { selector: "#f", files: [{ name: "a.txt", text: "héllo" }, { name: "b.png", mimeType: "image/png", base64: "QUJD\nRA==" }] }
  }, d);
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /^attached a\.txt, b\.png \(10 bytes\) to selector #f/); // 6 UTF-8 + 4 decoded
  const act = calls.executeScript.find((c) => Array.isArray(c.args) && c.args[2] === "#f");
  assert.deepEqual(act.args[3], [
    { name: "a.txt", type: "application/octet-stream", text: "héllo", base64: null },
    { name: "b.png", type: "image/png", text: null, base64: "QUJDRA==" }
  ]);
});

test("upload_file argument checks run before the page is touched", async () => {
  const big = "A".repeat(Math.ceil((5 * 1024 * 1024 + 3) / 3) * 4);
  for (const [args, re] of [
    [{ files: [{ name: "a", text: "x" }] }, /needs a ref/],
    [{ selector: "#f", files: [] }, /non-empty/],
    [{ selector: "#f", files: [{ text: "x" }] }, /needs a `name`/],
    [{ selector: "#f", files: [{ name: "a" }] }, /exactly one of/],
    [{ selector: "#f", files: [{ name: "a", text: "x", base64: "QQ==" }] }, /exactly one of/],
    [{ selector: "#f", files: [{ name: "a", base64: "not base64!" }] }, /not valid base64/],
    [{ selector: "#f", files: [{ name: "a", base64: big }] }, /capped at/]
  ]) {
    const { deps: d, calls } = deps();
    const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.upload_file", arguments: args }, d);
    assert.equal(res.isError, true, JSON.stringify(args).slice(0, 80));
    assert.match(res.content[0].text, re);
    assert.equal(calls.executeScript.length, 0);
  }
});

// --- inject_css -----------------------------------------------------------------

test("inject_css inserts into every frame, and clear removes exactly what it inserted", async () => {
  const { deps: d, calls } = deps();
  const css = ".banner { display: none !important; }";
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.inject_css", arguments: { css } }, d);
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.insertCSS, [{ target: { tabId: 42, allFrames: true }, css }]);

  const cleared = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.inject_css", arguments: { clear: true } }, d);
  assert.match(cleared.content[0].text, /^removed 1 injected stylesheet/);
  assert.deepEqual(calls.removeCSS, [{ target: { tabId: 42, allFrames: true }, css }]);

  const again = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.inject_css", arguments: { clear: true } }, d);
  assert.match(again.content[0].text, /^removed 0 injected stylesheets/);
});

test("inject_css refuses stylesheets that can fetch, and CSS escapes", async () => {
  for (const css of [
    "input[value^=a] { background: url(https://evil/a) }",
    "a { background: URL ( //x ) }",
    "@import 'https://evil/x.css';",
    "a { background: image-set('x.png' 1x) }",
    "@font-face { font-family: x; src: local(Arial) }",
    "a { background: u\\72l(https://evil/) }"
  ]) {
    const { deps: d, calls } = deps();
    const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.inject_css", arguments: { css } }, d);
    assert.equal(res.isError, true, css);
    assert.match(res.content[0].text, /refuses anything that fetches/);
    assert.equal(calls.insertCSS.length, 0);
  }
});

test("the new write tools are refused with act mode off without touching the page", async () => {
  for (const [name, args] of [
    ["katashiro.fill_form", { fields: [{ selector: "#a", value: "x" }] }],
    ["katashiro.upload_file", { selector: "#f", files: [{ name: "a", text: "x" }] }],
    ["katashiro.inject_css", { css: "a{color:red}" }]
  ]) {
    const { deps: d, calls } = deps({ actMode: false });
    const res = await BrowserMcp.handleMcpMessage("tools/call", { name, arguments: args }, d);
    assert.match(res.content[0].text, /act mode is off/);
    assert.equal(calls.executeScript.length + calls.insertCSS.length, 0, name);
  }
});

// --- tool-call details for the UI: masking, summary, duration ----------------------
//
// The side panel's pill tooltip / expander render what `onToolCall` hands them, so every
// assertion here is made against those events, driven through the same tunnel path the
// gateway uses (mcp/connect → mcp/message tools/call → handleServerRequest).

async function callViaTunnel(name, args, opts = {}) {
  const bag = deps(opts);
  const events = [];
  bag.deps.onToolCall = (e) => events.push(e);
  const state = {};
  await BrowserMcp.handleServerRequest({ id: 1, method: "mcp/connect", params: { acpId: null } }, bag.deps, state);
  const connectionId = bag.sent[0].result.connectionId;
  await BrowserMcp.handleServerRequest(
    { id: 2, method: "mcp/message", params: { connectionId, method: "tools/call", params: { name, arguments: args } } },
    bag.deps,
    state
  );
  return { ...bag, events, reply: bag.sent[1] };
}

test("every registered tool declares a redact hook (no tool can skip masking)", () => {
  for (const [name, def] of Object.entries(BrowserMcp.TOOLS)) {
    assert.equal(typeof def.redact, "function", `${name} needs a redact(args) hook`);
    // and it must tolerate empty / missing arguments
    assert.doesNotThrow(() => def.redact({}), name);
  }
});

test("fill_form: onToolCall never receives field values, only refs/selectors", async () => {
  const secret = "hunter2-very-secret";
  const { events, reply } = await callViaTunnel(
    "katashiro.fill_form",
    { snapshotId: 9, fields: [{ ref: "e1", value: secret }, { selector: "#pin", value: "4321" }, { ref: "e3", checked: true }] },
    { scriptResult: { ok: true, tree: "- x" } }
  );
  assert.equal(reply.result.isError, undefined);
  assert.deepEqual(events.map((e) => e.phase), ["start", "done"]);
  assert.deepEqual(events[0].args, {
    snapshotId: 9,
    fields: [{ ref: "e1", value: "‹redacted›" }, { selector: "#pin", value: "‹redacted›" }, { ref: "e3", value: "‹redacted›" }]
  });
  const wire = JSON.stringify(events);
  assert.ok(!wire.includes(secret), "password value leaked to the UI");
  assert.ok(!wire.includes("4321"), "pin value leaked to the UI");
});

test("fill_form: a value echoed back in an error is scrubbed from the summary/preview", async () => {
  const secret = "card-4111111111111111";
  const { events } = await callViaTunnel(
    "katashiro.fill_form",
    { fields: [{ selector: "#cc", value: secret }] },
    { scriptResult: { ok: false, error: `field 0 (#cc): no option matching ${JSON.stringify(secret)}` } }
  );
  assert.equal(events[1].phase, "error");
  assert.ok(!JSON.stringify(events).includes(secret));
  assert.match(events[1].summary, /no option matching ‹redacted›/);
});

test("upload_file: onToolCall gets name/MIME/size, never the base64 or text content", async () => {
  const b64 = Buffer.from("PRIVATE-BINARY-PAYLOAD-0123456789").toString("base64");
  const text = "TOP SECRET FILE BODY";
  const { events } = await callViaTunnel(
    "katashiro.upload_file",
    { selector: "#f", files: [{ name: "a.bin", mimeType: "application/x-thing", base64: b64 }, { name: "n.txt", text }] },
    { scriptResult: { ok: true, how: "selector #f", tree: "- x" } }
  );
  assert.deepEqual(events.map((e) => e.phase), ["start", "done"]);
  assert.deepEqual(events[0].args, {
    selector: "#f",
    files: [
      { name: "a.bin", mimeType: "application/x-thing", size: 33 },
      { name: "n.txt", mimeType: "application/octet-stream", size: 20 }
    ]
  });
  const wire = JSON.stringify(events);
  assert.ok(!wire.includes(b64), "base64 content leaked to the UI");
  assert.ok(!wire.includes(text), "text content leaked to the UI");
});

test("type / type_text: the UI sees only the typed text's length (it may be a password)", async () => {
  for (const [name, args] of [
    ["katashiro.type", { selector: "#q", text: "pw!" }],
    ["katashiro.type_text", { description: "the box", text: "pw!" }]
  ]) {
    const { events } = await callViaTunnel(name, args, { scriptResult: { ok: true, how: "selector #q" } });
    assert.equal(events[0].args.text, "‹3 chars›", name);
  }
});

test("inject_css: long strings are clipped at 80 chars in the UI args", async () => {
  const long = "x".repeat(200);
  for (const [name, args, key] of [
    ["katashiro.inject_css", { css: `a{content:"${long}"}` }, "css"]
  ]) {
    const { events } = await callViaTunnel(name, args, { scriptResult: { ok: true, how: "selector #q" } });
    const shown = events[0].args[key];
    assert.ok(shown.startsWith(args[key].slice(0, 80)), name);
    assert.ok(shown.length < args[key].length, `${name} ${key} not clipped`);
    assert.match(shown, /… \(\+\d+ chars\)$/, name);
    assert.ok(!JSON.stringify(events).includes(args[key]), `${name} full ${key} leaked`);
  }
});

// Leak regressions from the #40 review (Mira / Jellyfish): each case reproduced a secret
// reaching the summary/preview through an error message that echoed it.
async function fillFormError(fields, error) {
  const { events } = await callViaTunnel("katashiro.fill_form", { snapshotId: 1, fields }, { scriptResult: { ok: false, error } });
  assert.equal(events[1].phase, "error");
  assert.doesNotMatch(events[1].summary, /snapshotId|needs/); // reached the page echo, not an arg check
  return events;
}

test("fill_form leak: a secret containing another is redacted whole (longest first)", async () => {
  const events = await fillFormError(
    [{ ref: "e1", value: "brett" }, { ref: "e2", value: "brett-pw!" }],
    'no option matching "brett-pw!" / brett-pw!'
  );
  const wire = JSON.stringify(events);
  assert.ok(!wire.includes("-pw!"), wire);
  assert.ok(!wire.includes("brett"), wire);
});

test("fill_form leak: a value that also appears in a selector is still hidden", async () => {
  const events = await fillFormError([{ selector: "#pin", value: "pin" }], 'bad "pin" and pin');
  assert.match(events[1].summary, /^bad ‹redacted› and ‹redacted›/);
});

test("fill_form leak: a numeric value is hidden like a string", async () => {
  const events = await fillFormError([{ ref: "e1", value: 1234 }], "no option matching 1234");
  assert.ok(!JSON.stringify(events).includes("1234"));
});

test("fill_form leak: a short value is redacted bare too, but only as a whole token", async () => {
  const events = await fillFormError([{ ref: "e1", value: "42" }], 'got 42 and "42", not 1425 or e42');
  assert.match(events[1].summary, /^got ‹redacted› and ‹redacted›, not 1425 or e42/);
});

test("fill_form: a <select> miss does not echo the value in its error", () => {
  const src = BrowserMcp.TOOLS["katashiro.fill_form"].call.toString();
  assert.match(src, /no option matching the given value/);
  assert.doesNotMatch(src, /no option matching " \+ JSON\.stringify\(f\.value\)/);
});

test("navigate / new_tab: the URL's query and fragment never reach the UI", async () => {
  const url = "https://example.com/cb?token=sk-live-abc#frag";
  const { events } = await callViaTunnel("katashiro.navigate", { url });
  assert.equal(events[0].args.url, "https://example.com/cb?‹redacted›");
  const wire = JSON.stringify(events);
  assert.ok(!wire.includes("sk-live-abc"), wire);
  assert.ok(!wire.includes("#frag"), wire);
  assert.equal(BrowserMcp.TOOLS["katashiro.new_tab"].redact({ url }).url, "https://example.com/cb?‹redacted›");
  assert.equal(BrowserMcp.TOOLS["katashiro.navigate"].redact({ url: "https://a/b" }).url, "https://a/b");
});

test("navigate: each query parameter value is a secret on its own, raw and decoded", () => {
  const secrets = BrowserMcp.TOOLS["katashiro.navigate"].secrets({ url: "https://a/b?token=abc123&q=a%20b#frag" });
  for (const v of ["token=abc123&q=a%20b#frag", "abc123", "a%20b", "a b", "frag"]) assert.ok(secrets.includes(v), v);
});

test("navigate: short parameter values (page=2, lang=en) are not secrets on their own", async () => {
  const secrets = BrowserMcp.TOOLS["katashiro.navigate"].secrets({ url: "https://a/list?page=2&lang=en" });
  assert.deepEqual(secrets, ["page=2&lang=en"]);
  const { events } = await callViaTunnel(
    "katashiro.navigate",
    { url: "https://a/list?page=2&lang=en" },
    { scriptResult: { ok: true, tree: "- text \"page 2 of 9 (en)\"" } }
  );
  assert.match(events[1].preview, /page 2 of 9 \(en\)/);
});

test("navigate: a page that echoes one parameter value alone does not leak it", async () => {
  const { events } = await callViaTunnel(
    "katashiro.navigate",
    { url: "https://example.com/cb?token=sk-live-abc&x=1" },
    { scriptResult: { ok: true, tree: "- heading \"welcome sk-live-abc\"" } }
  );
  assert.ok(!JSON.stringify(events).includes("sk-live-abc"), JSON.stringify(events));
});

test("result previews show any URL only up to its path (tabs lists every open tab)", async () => {
  const { events } = await callViaTunnel("katashiro.tabs", {}, {
    tabsList: [{ id: 42, windowId: 7, url: "https://mail.example/inbox?auth=sk-tab-secret#m1", title: "Inbox" }]
  });
  const wire = JSON.stringify(events);
  assert.ok(!wire.includes("sk-tab-secret"), wire);
  assert.ok(!wire.includes("#m1"), wire);
  assert.match(events[1].preview, /https:\/\/mail\.example\/inbox\?‹redacted›/);
});

test("fail-closed (no redact hook): short values are scrubbed bare too", async () => {
  const tools = {
    "x.leaky": {
      description: "custom registry tool without a redact hook",
      inputSchema: { type: "object", properties: {} },
      sessionScope: true,
      async call() { return { content: [{ type: "text", text: "pin 42 accepted, not 1425" }] }; }
    }
  };
  const s = BrowserMcp.createServer({ id: "srv-x", name: "x", tools });
  const { deps: d } = deps();
  const events = [];
  d.onToolCall = (e) => events.push(e);
  await s.handleMcpMessage("tools/call", { name: "x.leaky", arguments: { pin: "42" } }, d);
  assert.equal(events[1].summary, "pin ‹redacted› accepted, not 1425");
});

test("short, non-sensitive args pass through the default redact unchanged", async () => {
  const { events } = await callViaTunnel(
    "katashiro.click",
    { ref: "e12", snapshotId: 3, button: "right" },
    { scriptResult: { ok: true, how: "ref e12", tree: "- x" } }
  );
  assert.deepEqual(events[0].args, { ref: "e12", snapshotId: 3, button: "right" });
});

test("settle events carry a one-line summary, a ≤300-char preview, and ms", async () => {
  const body = "line one of the page\n" + "y".repeat(5000);
  const { events } = await callViaTunnel("katashiro.get_text", {}, { scriptResult: { ok: true, text: body } });
  const done = events[1];
  assert.equal(done.phase, "done");
  assert.equal(typeof done.ms, "number");
  assert.ok(done.ms >= 0);
  assert.equal(done.summary, "line one of the page");
  assert.ok(done.preview.startsWith("line one of the page\ny"));
  assert.ok(done.summary.length <= 140);
  assert.ok(done.preview.length <= 330, `preview is bounded (${done.preview.length})`);
  assert.equal("ms" in events[0], false, "start carries no duration");
});

test("a refused write reports the refusal as the error summary", async () => {
  const { events } = await callViaTunnel("katashiro.click", { selector: "#a" }, { actMode: false });
  assert.equal(events[1].phase, "error");
  assert.match(events[1].summary, /act mode is off/);
  assert.equal(typeof events[1].ms, "number");
});

test("a restricted page reports the origin refusal as the error summary", async () => {
  const { events } = await callViaTunnel("katashiro.get_text", {}, { tabUrl: "chrome://settings/" });
  assert.equal(events[1].phase, "error");
  assert.match(events[1].summary, /no grantable web origin/);
});

test("a tool without a redact hook fails closed: its args never reach the UI", async () => {
  const tools = {
    "x.leaky": {
      description: "custom registry tool without a redact hook",
      inputSchema: { type: "object", properties: {} },
      sessionScope: true,
      async call() { return { content: [{ type: "text", text: "ok" }] }; }
    }
  };
  const s = BrowserMcp.createServer({ id: "srv-x", name: "x", tools });
  const { deps: d } = deps();
  const events = [];
  d.onToolCall = (e) => events.push(e);
  await s.handleMcpMessage("tools/call", { name: "x.leaky", arguments: { token: "sk-live-abc" } }, d);
  assert.deepEqual(events.map((e) => e.phase), ["start", "done"]);
  assert.equal(events[0].args, null);
  assert.ok(!JSON.stringify(events).includes("sk-live-abc"));
});

test("an image result summarizes as MIME + size, not the base64", async () => {
  const { events } = await callViaTunnel("katashiro.screenshot", {}, { dataUrl: "data:image/jpeg;base64,QUJDREVG" });
  assert.match(events[1].summary, /^image\/jpeg \(\d+ KB\) — imageId: img_[0-9a-f]{16}/);
  assert.ok(!JSON.stringify(events).includes("QUJDREVG"));
});

// --- tab management: tabs filters, tab_update, reopen_tab, tab groups -------------------------

const call = (d, name, args = {}) => BrowserMcp.handleMcpMessage("tools/call", { name, arguments: args }, d);
const TABS3 = [
  { id: 41, windowId: 7, url: "https://a.example/", title: "A", active: true, groupId: -1 },
  { id: 42, windowId: 7, url: "https://mail.google.com/", title: "Mail", pinned: true, groupId: 300 },
  { id: 55, windowId: 8, url: "https://b.example/x", title: "B", audible: true, mutedInfo: { muted: true }, groupId: -1 }
];
// TABS3 plus a second tab in window 8, so moving tab [2] out of window 8 does not empty it.
const TABS4 = [...TABS3, { id: 56, windowId: 8, url: "https://c.example/", title: "C", groupId: -1 }];
const GROUP300 = { id: 300, title: "work", color: "blue", collapsed: false, windowId: 7 };

test("tabs: each line carries window / pinned / audible / muted / group tags", async () => {
  const { deps: d } = deps({ tabsList: TABS3, groups: [GROUP300] });
  const text = (await call(d, "katashiro.tabs")).content[0].text;
  assert.match(text, /^\* \[0\] A — https:\/\/a\.example\/  \(window 7\)$/m);
  assert.match(text, /^  \[1\] Mail — https:\/\/mail\.google\.com\/  \(window 7 · pinned · group 300 "work" blue\)$/m);
  assert.match(text, /^  \[2\] B — https:\/\/b\.example\/x  \(window 8 · audible · muted\)$/m);
});

test("tabs: a filtered list keeps the global index (never renumbers)", async () => {
  const { deps: d } = deps({ tabsList: TABS3, groups: [GROUP300] });
  const byWindow = (await call(d, "katashiro.tabs", { windowId: 8 })).content[0].text;
  assert.match(byWindow, /\[2\] B/);
  assert.doesNotMatch(byWindow, /\[0\]|\[1\]/);
  const byUrl = (await call(d, "katashiro.tabs", { url: "mail.google" })).content[0].text;
  assert.match(byUrl, /^  \[1\] Mail/);
  const none = (await call(d, "katashiro.tabs", { url: "nope" })).content[0].text;
  assert.match(none, /no tabs match the filter — 3 open in total/);
});

test("tabs: a non-integer windowId is an error, not a silent full listing", async () => {
  const { deps: d } = deps({ tabsList: TABS3 });
  for (const windowId of ["7", 7.5]) {
    const res = await call(d, "katashiro.tabs", { windowId });
    assert.equal(res.isError, true, String(windowId));
    assert.match(res.content[0].text, /windowId/);
  }
});

test("tab_update on the active tab: an active tab missing from the list is an error, never [-1]", async () => {
  // The mock's active-tab lookup returns id 42; this list does not contain it.
  const { deps: d, calls } = deps({ tabsList: [{ id: 41, windowId: 7, url: "https://a/" }] });
  const res = await call(d, "katashiro.tab_update", { pinned: true });
  assert.equal(res.isError, true);
  assert.doesNotMatch(res.content[0].text, /\[-1\]/);
  assert.equal(calls.tabsUpdate.length, 0);
});

test("tabs: works without the tabGroups API (group shown by id)", async () => {
  const { deps: d } = deps({ tabsList: TABS3, noTabGroups: true });
  const text = (await call(d, "katashiro.tabs")).content[0].text;
  assert.match(text, /\[1\] Mail — .*\(window 7 · pinned · group 300\)$/m);
});

test("tab_update: pin + mute by url, one tabs.update call", async () => {
  const { deps: d, calls } = deps({ tabsList: TABS3 });
  const res = await call(d, "katashiro.tab_update", { url: "b.example", pinned: true, muted: false });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 55, upd: { pinned: true, muted: false } }]);
  assert.match(res.content[0].text, /tab \[2\] — B: pinned, unmuted/);
});

test("tab_update: moveTo and duplicate on the active tab", async () => {
  const { deps: d, calls } = deps({ tabsList: TABS3 });
  // no index/url → the active tab (mock active lookup returns id 42)
  const res = await call(d, "katashiro.tab_update", { moveTo: -1, duplicate: true });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.tabsMove, [{ tabId: 42, o: { index: -1 } }]);
  assert.deepEqual(calls.tabsDuplicate, [42]);
  assert.match(res.content[0].text, /moved to the end of its window, duplicated/);
  assert.match(res.content[0].text, /indexes have shifted/);
});

test("tab_update: rejects empty or malformed changes before touching the browser", async () => {
  const { deps: d, calls } = deps({ tabsList: TABS3 });
  for (const args of [{}, { url: "a.example" }, { pinned: "yes" }, { moveTo: -2 }, { moveTo: 1.5 }, { duplicate: false }]) {
    const res = await call(d, "katashiro.tab_update", args);
    assert.equal(res.isError, true, JSON.stringify(args));
  }
  const bad = await call(d, "katashiro.tab_update", { index: 9, pinned: true });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /out of range/);
  assert.equal(calls.tabsUpdate.length + calls.tabsMove.length + calls.tabsDuplicate.length, 0);
});

test("reopen_tab: restores the most recent closed TAB (skipping closed windows) and reports its index", async () => {
  const recentlyClosed = [
    { window: { sessionId: "w1", tabs: [{}, {}, {}] } },       // a whole window — never restored
    { tab: { sessionId: "s-r", url: "https://r/" } },
    { tab: { sessionId: "s-old", url: "https://old/" } }
  ];
  const { deps: d, calls } = deps({ tabsList: [...TABS3, { id: 88, windowId: 7, url: "https://r/", title: "R" }], recentlyClosed });
  const res = await call(d, "katashiro.reopen_tab");
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.sessionsRestore, ["s-r"]);
  assert.match(res.content[0].text, /reopened tab \[3\] — R — https:\/\/r\//);
});

test("reopen_tab: url picks that closed tab's session; no match is a clean error", async () => {
  const recentlyClosed = [
    { window: { sessionId: "w1", tabs: [] } },
    { tab: { sessionId: "s-old", url: "https://docs.example/" } },
    { tab: { sessionId: "s-mail", url: "https://mail.google.com/" } }
  ];
  const { deps: d, calls } = deps({ tabsList: TABS3, recentlyClosed });
  const ok = await call(d, "katashiro.reopen_tab", { url: "mail.google" });
  assert.equal(ok.isError, undefined);
  assert.deepEqual(calls.sessionsRestore, ["s-mail"]);
  const miss = await call(d, "katashiro.reopen_tab", { url: "nope" });
  assert.equal(miss.isError, true);
  assert.equal(calls.sessionsRestore.length, 1);
});

test("reopen_tab: nothing to restore / no sessions API are clean errors", async () => {
  const thrown = await call(deps({ recentlyClosed: [{ tab: { sessionId: "s" } }], restoreThrows: "There are no sessions to restore." }).deps, "katashiro.reopen_tab");
  assert.equal(thrown.isError, true);
  assert.match(thrown.content[0].text, /nothing to reopen/);
  const onlyWindows = deps({ recentlyClosed: [{ window: { sessionId: "w1", tabs: [] } }] });
  const nothing = await call(onlyWindows.deps, "katashiro.reopen_tab");
  assert.equal(nothing.isError, true);
  assert.match(nothing.content[0].text, /no recently closed tab to reopen/);
  assert.equal(onlyWindows.calls.sessionsRestore.length, 0);
  const none = await call(deps({ noSessions: true }).deps, "katashiro.reopen_tab");
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /sessions permission/);
  assert.match(none.content[0].text, /Katashiro settings/);   // tells the agent how the user turns it on
  // Revoked in Settings: chrome.sessions may linger, but the live grant says no → same hint, no restore.
  const revoked = deps({ sessionsGranted: false, recentlyClosed: [{ tab: { sessionId: "s" } }] });
  const r = await call(revoked.deps, "katashiro.reopen_tab");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Katashiro settings/);
  assert.equal(revoked.calls.sessionsRestore.length, 0);
  const granted = deps({ sessionsGranted: true, recentlyClosed: [{ tab: { sessionId: "s" } }] });
  assert.equal((await call(granted.deps, "katashiro.reopen_tab")).isError, undefined);
});

test("tab_groups: lists groups with their member tab indexes", async () => {
  const groups = [GROUP300, { id: 301, title: "", color: "red", collapsed: true, windowId: 8 }];
  const { deps: d } = deps({ tabsList: TABS3, groups });
  const text = (await call(d, "katashiro.tab_groups")).content[0].text;
  assert.match(text, /^group 300 "work" blue — window 7 — tabs \[1\]$/m);
  assert.match(text, /^group 301 "" red \(collapsed\) — window 8 — tabs \[\]$/m);
  assert.match((await call(deps({ groups: [] }).deps, "katashiro.tab_groups")).content[0].text, /no tab groups/);
  const off = await call(deps({ noTabGroups: true }).deps, "katashiro.tab_groups");
  assert.equal(off.isError, true);
  assert.match(off.content[0].text, /tabGroups permission/);
});

test("group_tabs: new group from index + url, then title/color applied", async () => {
  const { deps: d, calls } = deps({ tabsList: TABS4, anyGroup: true });
  const res = await call(d, "katashiro.group_tabs", { tabs: [{ index: 0 }, { url: "b.example" }, { index: 0 }], title: "research", color: "green" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.tabsGroup, [{ tabIds: [41, 55] }]);                // deduped
  assert.deepEqual(calls.groupsUpdate, [{ id: 501, upd: { title: "research", color: "green" } }]);
  assert.match(res.content[0].text, /grouped tabs \[0, 2\] into group 501 "research" \(green\)/);
});

test("group_tabs: add to an existing group without styling it", async () => {
  const { deps: d, calls } = deps({ tabsList: TABS4, groups: [GROUP300] });
  const res = await call(d, "katashiro.group_tabs", { tabs: [{ index: 2 }], groupId: 300 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.tabsGroup, [{ tabIds: [55], groupId: 300 }]);
  assert.equal(calls.groupsUpdate.length, 0);
  assert.match(res.content[0].text, /added tabs \[2\] to group 300/);
});

test("group_tabs: refuses to empty another window (it would close, side panel and all)", async () => {
  // Window 8 holds only tab [2]. Moving it into the current window 7 (new group) or into group 300
  // (window 7) empties window 8 → refused, nothing grouped.
  const { deps: d, calls } = deps({ tabsList: TABS3, groups: [GROUP300] });
  for (const args of [{ tabs: [{ index: 0 }, { index: 2 }] }, { tabs: [{ url: "b.example" }], groupId: 300 }]) {
    const res = await call(d, "katashiro.group_tabs", args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.content[0].text, /move every tab out of window 8/);
  }
  assert.equal(calls.tabsGroup.length, 0);
  // Grouping window 8's only tab into a new group IN window 8 moves nothing out — allowed.
  const same = deps({ tabsList: TABS3, currentWindowId: 8 });
  assert.equal((await call(same.deps, "katashiro.group_tabs", { tabs: [{ index: 2 }] })).isError, undefined);
  assert.deepEqual(same.calls.tabsGroup, [{ tabIds: [55] }]);
  // Grouping ALL of window 7's tabs inside window 7 is fine too (they stay put).
  const own = deps({ tabsList: TABS3 });
  assert.equal((await call(own.deps, "katashiro.group_tabs", { tabs: [{ index: 0 }, { index: 1 }] })).isError, undefined);
});

test("group_tabs: one bad reference groups nothing; bad color / groupId refused", async () => {
  const { deps: d, calls } = deps({ tabsList: TABS3 });
  for (const args of [
    { tabs: [{ index: 0 }, { url: "missing" }] },
    { tabs: [] },
    { tabs: [{}] },
    { tabs: [{ index: 0 }], color: "black" },
    { tabs: [{ index: 0 }], groupId: "300" },
    { tabs: Array.from({ length: 51 }, () => ({ index: 0 })) }
  ]) {
    const res = await call(d, "katashiro.group_tabs", args);
    assert.equal(res.isError, true, JSON.stringify(args).slice(0, 80));
  }
  assert.equal(calls.tabsGroup.length, 0);
});

test("group_tabs: a Chrome error surfaces; styling without the tabGroups API is refused", async () => {
  const thrown = await call(deps({ tabsList: TABS3, groupThrows: "Tabs cannot be grouped." }).deps, "katashiro.group_tabs", { tabs: [{ index: 0 }] });
  assert.equal(thrown.isError, true);
  assert.match(thrown.content[0].text, /could not group the tabs: Tabs cannot be grouped/);
  const { deps: d, calls } = deps({ tabsList: TABS3, noTabGroups: true });
  const res = await call(d, "katashiro.group_tabs", { tabs: [{ index: 0 }], title: "x" });
  assert.equal(res.isError, true);
  assert.equal(calls.tabsGroup.length, 0);
  // grouping itself only needs chrome.tabs — still works without tabGroups
  assert.equal((await call(d, "katashiro.group_tabs", { tabs: [{ index: 0 }] })).isError, undefined);
});

test("ungroup_tabs: only grouped tabs are passed to tabs.ungroup", async () => {
  const { deps: d, calls } = deps({ tabsList: TABS3 });
  const res = await call(d, "katashiro.ungroup_tabs", { tabs: [{ index: 0 }, { url: "mail.google" }] });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.tabsUngroup, [[42]]);
  assert.match(res.content[0].text, /removed tabs \[1\] from their groups/);
  const noop = await call(d, "katashiro.ungroup_tabs", { tabs: [{ index: 2 }] });
  assert.match(noop.content[0].text, /nothing to do/);
  assert.equal(calls.tabsUngroup.length, 1);
});

test("update_tab_group: rename / recolor / collapse; unknown id and empty change are errors", async () => {
  const { deps: d, calls } = deps({ groups: [GROUP300] });
  const res = await call(d, "katashiro.update_tab_group", { groupId: 300, title: "done", collapsed: true });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.groupsUpdate, [{ id: 300, upd: { title: "done", collapsed: true } }]);
  assert.match(res.content[0].text, /updated group 300 "done" blue \(collapsed\)/);
  assert.equal((await call(d, "katashiro.update_tab_group", { groupId: 999, title: "x" })).isError, true);
  assert.equal((await call(d, "katashiro.update_tab_group", { groupId: 300 })).isError, true);
  assert.equal((await call(d, "katashiro.update_tab_group", { groupId: 300, color: "black" })).isError, true);
  assert.equal((await call(d, "katashiro.update_tab_group", { groupId: 300, collapsed: "no" })).isError, true);
  const off = await call(deps({ noTabGroups: true }).deps, "katashiro.update_tab_group", { groupId: 300, title: "x" });
  assert.equal(off.isError, true);
});

test("every new tab write tool is refused when act mode is off", async () => {
  const { deps: d, calls } = deps({ actMode: false, tabsList: TABS3, groups: [GROUP300] });
  for (const [name, args] of [
    ["katashiro.tab_update", { index: 0, pinned: true }],
    ["katashiro.reopen_tab", {}],
    ["katashiro.group_tabs", { tabs: [{ index: 0 }] }],
    ["katashiro.ungroup_tabs", { tabs: [{ index: 1 }] }],
    ["katashiro.update_tab_group", { groupId: 300, title: "x" }]
  ]) {
    const res = await call(d, name, args);
    assert.equal(res.isError, true, name);
    assert.match(res.content[0].text, /act mode is off/, name);
  }
  assert.equal(calls.tabsUpdate.length + calls.tabsGroup.length + calls.tabsUngroup.length + calls.groupsUpdate.length + calls.sessionsRestore.length, 0);
});

// --- Split View: split_tabs / unsplit_tabs / tabs tag -------------------------------------------

// window 7: [0] A(idx0) [1] B(idx1) [2] C(idx2, pinned) ; window 8: [3] D
const splitTabs = () => [
  { id: 1, windowId: 7, index: 0, url: "https://a/", title: "A", active: true, groupId: -1, splitViewId: -1 },
  { id: 2, windowId: 7, index: 1, url: "https://b/", title: "B", groupId: -1, splitViewId: -1 },
  { id: 3, windowId: 7, index: 2, url: "https://c/", title: "C", groupId: -1, splitViewId: -1 },
  { id: 4, windowId: 7, index: 3, url: "https://p/", title: "P", pinned: true, groupId: -1, splitViewId: -1 },
  { id: 5, windowId: 8, index: 0, url: "https://d/", title: "D", groupId: -1, splitViewId: -1 }
];

test("tabs: a tab in a Split View carries a split <id> tag", async () => {
  const list = splitTabs();
  list[0].splitViewId = 31; list[1].splitViewId = 31;
  const text = (await call(deps({ tabsList: list }).deps, "katashiro.tabs")).content[0].text;
  assert.match(text, /\[0\] A — .*\(window 7 · split 31\)$/m);
  assert.match(text, /\[1\] B — .*\(window 7 · split 31\)$/m);
  assert.match(text, /\[2\] C — .*\(window 7\)$/m);
});

test("split_tabs: two adjacent tabs split in place, no move", async () => {
  const { deps: d, calls } = deps({ tabsList: splitTabs() });
  const res = await call(d, "katashiro.split_tabs", { tabs: [{ index: 0 }, { url: "https://b/" }] });
  assert.equal(res.isError, undefined);
  assert.equal(calls.tabsMove.length, 0);
  assert.deepEqual(calls.createSplit, [[1, 2]]);
  assert.match(res.content[0].text, /split tabs \[0, 1\] side by side \(split 900\)/);
  assert.match(res.content[0].text, /act on the active pane/);
  // the second tab right before the first is adjacent too (CanvasTabs.adjacentIndex, #90)
  const left = deps({ tabsList: splitTabs() });
  await call(left.deps, "katashiro.split_tabs", { tabs: [{ index: 1 }, { index: 0 }] });
  assert.equal(left.calls.tabsMove.length, 0);
  assert.deepEqual(left.calls.createSplit, [[2, 1]]);
});

test("split_tabs: a non-adjacent second tab is moved right after the first", async () => {
  const after = deps({ tabsList: splitTabs() });                          // C (idx 2) after A (idx 0)
  await call(after.deps, "katashiro.split_tabs", { tabs: [{ index: 0 }, { index: 2 }] });
  assert.deepEqual(after.calls.tabsMove, [{ tabId: 3, o: { index: 1 } }]);
  assert.deepEqual(after.calls.createSplit, [[1, 3]]);
  const before = deps({ tabsList: splitTabs() });                         // A (idx 0) before C (idx 2)
  await call(before.deps, "katashiro.split_tabs", { tabs: [{ index: 2 }, { index: 0 }] });
  // lifting A out shifts C to 1, so "right after C" is final index 2
  assert.deepEqual(before.calls.tabsMove, [{ tabId: 1, o: { index: 2 } }]);
});

test("split_tabs: openUrl opens a new tab split with the given one, right by default, left on request", async () => {
  const right = deps({ tabsList: splitTabs(), createdTab: { id: 60, splitViewId: 900 } });
  const r = await call(right.deps, "katashiro.split_tabs", { tabs: [{ index: 1 }], openUrl: "https://docs.example/x" });
  assert.equal(r.isError, undefined);
  assert.deepEqual(right.calls.tabsCreate, [{ url: "https://docs.example/x", splitWithTabId: 2, windowId: 7 }]);
  const left = deps({ tabsList: splitTabs(), createdTab: { id: 61, splitViewId: 900 } });
  await call(left.deps, "katashiro.split_tabs", { tabs: [{ index: 1 }], openUrl: "https://e/", side: "left" });
  assert.deepEqual(left.calls.tabsCreate, [{ url: "https://e/", splitWithTabId: 2, windowId: 7, index: 1 }]);
  // no tab given → the active tab (mock active lookup returns id 42, which must be in the list)
  const list = splitTabs(); list[0].id = 42;
  const act = deps({ tabsList: list, createdTab: { id: 62, splitViewId: 900 } });
  assert.equal((await call(act.deps, "katashiro.split_tabs", { openUrl: "https://f/" })).isError, undefined);
  assert.equal(act.calls.tabsCreate[0].splitWithTabId, 42);
});

test("split_tabs: refuses mismatched window / pinned, an already-split tab, and bad shapes", async () => {
  const { deps: d, calls } = deps({ tabsList: (() => { const l = splitTabs(); l[1].splitViewId = 7; return l; })() });
  const cases = [
    [{ tabs: [{ index: 0 }, { index: 4 }] }, /differ in window/],
    [{ tabs: [{ index: 2 }, { index: 3 }] }, /differ in pinned state/],
    [{ tabs: [{ index: 0 }, { index: 1 }] }, /already in split 7/],
    [{ tabs: [{ index: 0 }, { index: 0 }] }, /two different tabs/],
    [{ tabs: [{ index: 0 }] }, /pass two tabs/],
    [{ tabs: [{ index: 0 }, { index: 2 }, { index: 3 }] }, /pass two tabs/],
    [{ tabs: [{ index: 0 }, { index: 1 }], openUrl: "https://x/" }, /pass two tabs/],
    [{ tabs: [{ index: 0 }, { index: 2 }], side: "left" }, /only applies with `openUrl`/],
    [{ tabs: [{ index: 0 }], openUrl: "https://x/", side: "up" }, /must be "left" or "right"/],
    [{ tabs: [{ index: 9 }, { index: 0 }] }, /out of range/]
  ];
  for (const [args, re] of cases) {
    const res = await call(d, "katashiro.split_tabs", args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.content[0].text, re, JSON.stringify(args));
  }
  assert.equal(calls.createSplit.length + calls.tabsMove.length + calls.tabsCreate.length, 0);
});

test("split_tabs: Chrome errors surface; no Split View API is a clean error", async () => {
  const thrown = await call(deps({ tabsList: splitTabs(), splitThrows: "Tabs must be adjacent." }).deps,
    "katashiro.split_tabs", { tabs: [{ index: 0 }, { index: 1 }] });
  assert.equal(thrown.isError, true);
  assert.match(thrown.content[0].text, /could not create the split: Tabs must be adjacent/);
  const old = deps({ tabsList: splitTabs(), noSplit: true });
  const res = await call(old.deps, "katashiro.split_tabs", { tabs: [{ index: 0 }, { index: 1 }] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Chrome 155\+/);
  assert.equal((await call(old.deps, "katashiro.unsplit_tabs", { index: 0 })).isError, true);
});

test("split_tabs: a new tab not yet tagged (splitViewId -1) does not list every unsplit tab", async () => {
  const d = deps({ tabsList: splitTabs(), createdTab: { id: 63, splitViewId: -1 } });
  const res = await call(d.deps, "katashiro.split_tabs", { tabs: [{ index: 1 }], openUrl: "https://g/" });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, /^split the tabs side by side\n/);
  assert.doesNotMatch(res.content[0].text, /split -1|\[0, /);
});

test("split_tabs: a move that went through is reported when createSplit then fails", async () => {
  const d = deps({ tabsList: splitTabs(), splitThrows: "boom" });
  const res = await call(d.deps, "katashiro.split_tabs", { tabs: [{ index: 0 }, { index: 2 }] });
  assert.equal(res.isError, true);
  assert.equal(d.calls.tabsMove.length, 1);
  assert.match(res.content[0].text, /could not create the split: boom \(tab \[2\] was already moved next to tab \[0\]/);
});

test("split_tabs: openUrl is masked like navigate's url in the UI details", () => {
  const masked = BrowserMcp.TOOLS["katashiro.split_tabs"].redact({ openUrl: "https://x/cb?token=abcdef123", tabs: [{ index: 0 }] });
  assert.equal(masked.openUrl, "https://x/cb?‹redacted›");
  assert.deepEqual(masked.tabs, [{ index: 0 }]);
  assert.ok(BrowserMcp.TOOLS["katashiro.split_tabs"].secrets({ openUrl: "https://x/cb?token=abcdef123" }).includes("abcdef123"));
});

test("unsplit_tabs: by splitViewId, by a member tab, by the active tab; errors when not split", async () => {
  const list = splitTabs(); list[1].splitViewId = 31; list[2].splitViewId = 31; list[0].id = 42;
  const { deps: d, calls } = deps({ tabsList: list });
  const byId = await call(d, "katashiro.unsplit_tabs", { splitViewId: 31 });
  assert.equal(byId.isError, undefined);
  assert.match(byId.content[0].text, /unsplit split 31 — tabs \[1, 2\] are independent again/);
  await call(d, "katashiro.unsplit_tabs", { url: "https://c/" });
  assert.deepEqual(calls.unsplit, [31, 31]);
  const notSplit = await call(d, "katashiro.unsplit_tabs", {});            // active tab (id 42) is not split
  assert.equal(notSplit.isError, true);
  assert.match(notSplit.content[0].text, /not in a Split View/);
  for (const args of [{ splitViewId: 99 }, { splitViewId: -1 }, { splitViewId: "31" }]) {
    assert.equal((await call(d, "katashiro.unsplit_tabs", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(calls.unsplit.length, 2);
});

test("split_tabs / unsplit_tabs are refused when act mode is off", async () => {
  const { deps: d, calls } = deps({ actMode: false, tabsList: splitTabs() });
  for (const [name, args] of [["katashiro.split_tabs", { tabs: [{ index: 0 }, { index: 1 }] }], ["katashiro.unsplit_tabs", { splitViewId: 31 }]]) {
    const res = await call(d, name, args);
    assert.equal(res.isError, true, name);
    assert.match(res.content[0].text, /act mode is off/, name);
  }
  assert.equal(calls.createSplit.length + calls.unsplit.length, 0);
});

// --- screenshot → paste_image / upload_file (imageId) ------------------------------------------

const IMG_ID = /^img_[0-9a-f]{16}$/;
const shoot = async (d) => {
  const res = await call(d, "katashiro.screenshot");
  // the imageId note is a text block — the 2nd after the image, or the 1st when the image was too big to show
  const note = res.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const id = /imageId: (img[-_][0-9a-f]{16})/.exec(note)[1];
  return { res, id };
};
const pasteInj = (calls) => calls.executeScript.find((x) => Array.isArray(x.args) && x.args.length === 5);

test("screenshot returns the image plus a random, never-reused imageId", async () => {
  const { deps: d } = deps({ dataUrl: "data:image/jpeg;base64,QUJD" });
  const { res, id } = await shoot(d);
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].data, "QUJD");
  assert.equal(res.content[1].type, "text");
  assert.match(id, IMG_ID);
  const ids = new Set([id]);
  for (let i = 0; i < 20; i++) ids.add((await shoot(d)).id);
  assert.equal(ids.size, 21);                                          // no counter: nothing to guess, nothing to collide
});

test("each server instance has its own image store; clearImages empties it", async () => {
  const a = BrowserMcp.createServer({ id: "srv-a", name: "katashiro" });
  const b = BrowserMcp.createServer({ id: "srv-b", name: "katashiro" });
  const bag = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "x", handled: true } });
  const callOn = (s, name, args) => s.handleMcpMessage("tools/call", { name, arguments: args || {} }, bag.deps);
  const id = /imageId: (\S+)/.exec((await callOn(a, "katashiro.screenshot")).content[1].text)[1];
  assert.equal((await callOn(a, "katashiro.paste_image", { imageId: id, selector: "#x" })).isError, undefined);
  const other = await callOn(b, "katashiro.paste_image", { imageId: id, selector: "#x" });   // another agent's Conn
  assert.equal(other.isError, true);
  assert.match(other.content[0].text, /no captured image/);
  a.clearImages();                                                     // the Conn was torn down
  assert.equal((await callOn(a, "katashiro.paste_image", { imageId: id, selector: "#x" })).isError, true);
});

test("paste_image pastes the stored screenshot into a ref'd editor (bytes stay in the extension)", async () => {
  const { deps: d, calls } = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "ref e5", handled: true } });
  const { id } = await shoot(d);
  const res = await call(d, "katashiro.paste_image", { imageId: id, ref: "e5", snapshotId: 1 });
  assert.equal(res.isError, undefined);
  assert.match(res.content[0].text, new RegExp(`pasted screenshot-${id}\\.jpg \\(3 bytes\\) on ref e5 — a page handler processed the event \\(defaultPrevented\\) — confirm in the snapshot`));
  assert.deepEqual(pasteInj(calls).args, ["e5", 1, null, { base64: "QUJD", name: `screenshot-${id}.jpg`, type: "image/jpeg" }, "paste"]);
});

test("paste_image: an un-cancelled event is NOT confirmed — not an error, and it hands back the snapshot to check first", async () => {
  const ok = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "selector .drop", handled: true } });
  const a = await shoot(ok.deps);
  const res = await call(ok.deps, "katashiro.paste_image", { imageId: a.id, selector: ".drop", mode: "drop", name: "chart.jpg" });
  assert.match(res.content[0].text, /dropped chart\.jpg/);
  assert.equal(pasteInj(ok.calls).args[4], "drop");

  const no = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "the focused element", handled: false } });
  const b = await shoot(no.deps);
  const miss = await call(no.deps, "katashiro.paste_image", { imageId: b.id });
  assert.equal(miss.isError, undefined);                               // a document-level handler may have taken it async
  assert.match(miss.content[0].text, new RegExp(`NOT confirmed.*Check the snapshot first: if the image is not there, try mode "drop".*upload_file with files: \\[\\{ imageId: "${b.id}" \\}\\]`));
  assert.match(miss.content[0].text, /# snapshot/);
});

test("paste_image: unknown imageId, bad mode, ref without snapshotId are refused before the page", async () => {
  const { deps: d, calls } = deps({ dataUrl: "data:image/jpeg;base64,QUJD" });
  const { id } = await shoot(d);
  const before = calls.executeScript.length;
  for (const [args, re] of [
    [{ imageId: "img_0000000000000000" }, /no captured image "img_0000000000000000" — it expired/],
    [{ imageId: id, mode: "copy" }, /must be "paste" or "drop"/],
    [{ imageId: id, ref: "e1" }, /snapshotId/]
  ]) {
    const res = await call(d, "katashiro.paste_image", args);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.content[0].text, re);
  }
  assert.equal(calls.executeScript.length, before);
});

test("paste_image is refused when act mode is off", async () => {
  const { deps: d, calls } = deps({ actMode: false, dataUrl: "data:image/jpeg;base64,QUJD" });
  const { id } = await shoot(d);                                       // screenshot is a read
  const res = await call(d, "katashiro.paste_image", { imageId: id, selector: "#x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /act mode is off/);
  assert.equal(pasteInj(calls), undefined);
});

// The in-page half, run against a minimal DOM stand-in (the suite has no DOM dependency).
function fakePage({ rect = { left: 100, top: 40, width: 200, height: 80 }, prevent = true } = {}) {
  const seen = [];
  class Ev { constructor(type, init) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; } }
  const node = (tagName, extra = {}) => {
    const n = {
      tagName, isContentEditable: false, children: [], focused: 0,
      focus() { n.focused++; page.document.activeElement = n; },
      contains(o) { return o === n || n.children.some((c) => c.contains(o)); },
      querySelector() { return n.children.find((c) => c.isContentEditable || c.tagName === "TEXTAREA") || null; },
      getBoundingClientRect: () => rect,
      dispatchEvent(e) { seen.push({ on: n, e }); if (prevent && e.type !== "dragenter") e.defaultPrevented = true; return true; },
      ...extra
    };
    return n;
  };
  const page = {
    seen, node,
    document: { activeElement: null, body: {}, querySelector: () => null },
    window: {},
    DataTransfer: class { constructor() { this.files = []; this.items = { add: (f) => this.files.push(f) }; } },
    File: class { constructor(parts, name, opts) { this.name = name; this.type = opts.type; this.size = parts[0].length; } },
    DragEvent: class extends Ev {},
    ClipboardEvent: class extends Ev {}
  };
  return page;
}
async function runPasteInPage(page, args) {
  const keys = ["document", "window", "DataTransfer", "File", "DragEvent", "ClipboardEvent"];
  const saved = keys.map((k) => Object.getOwnPropertyDescriptor(globalThis, k));
  keys.forEach((k) => Object.defineProperty(globalThis, k, { value: page[k], configurable: true, writable: true }));
  try {
    const { deps: d, calls } = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "x", handled: true } });
    const { id } = await shoot(d);
    await call(d, "katashiro.paste_image", { imageId: id, ...args });
    const inj = pasteInj(calls);
    return inj.func(...inj.args);
  } finally {
    keys.forEach((k, i) => (saved[i] ? Object.defineProperty(globalThis, k, saved[i]) : delete globalThis[k]));
  }
}

test("paste_image drop carries the target's on-screen centre, not 0,0", async () => {
  const page = fakePage();
  const zone = page.node("DIV");
  page.document.querySelector = () => zone;
  const r = await runPasteInPage(page, { selector: ".zone", mode: "drop" });
  assert.deepEqual(r, { ok: true, how: "selector .zone", handled: true });
  assert.deepEqual(page.seen.map((s) => s.e.type), ["dragenter", "dragover", "drop"]);
  for (const { e } of page.seen) assert.deepEqual([e.clientX, e.clientY], [200, 80]);
  assert.equal(page.seen[2].e.dataTransfer.files[0].type, "image/jpeg");
});

test("paste_image aims at the editable inside a wrapper ref, and reports handled from defaultPrevented", async () => {
  const page = fakePage({ prevent: false });
  const editable = page.node("DIV", { isContentEditable: true });
  const wrapper = page.node("DIV");
  wrapper.children.push(editable);
  page.window.__katashiroResolve = () => ({ ok: true, el: wrapper });
  const r = await runPasteInPage(page, { ref: "e7", snapshotId: 3 });
  assert.equal(r.handled, false);
  assert.equal(page.seen.length, 1);
  assert.equal(page.seen[0].on, editable);                            // not the wrapper ProseMirror would ignore
  assert.equal(page.seen[0].e.type, "paste");
  assert.equal(page.seen[0].e.clipboardData.files[0].name.endsWith(".jpg"), true);
  assert.ok(editable.focused > 0);
});

test("paste_image refuses a focused iframe instead of dispatching into nothing", async () => {
  const page = fakePage();
  page.document.activeElement = page.node("IFRAME");
  const r = await runPasteInPage(page, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /iframe — take a snapshot and pass the editor's ref/);
  assert.equal(page.seen.length, 0);
});

test("upload_file accepts a screenshot imageId (name + MIME always from the capture)", async () => {
  const { deps: d, calls } = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "selector input[type=file]" } });
  const { id } = await shoot(d);
  const res = await call(d, "katashiro.upload_file", { selector: "input[type=file]", files: [{ imageId: id, mimeType: "image/png" }] });
  assert.equal(res.isError, undefined);
  const inj = calls.executeScript.find((x) => Array.isArray(x.args) && x.args.length === 4 && Array.isArray(x.args[3]));
  assert.deepEqual(inj.args[3], [{ name: `screenshot-${id}.jpg`, type: "image/jpeg", text: null, base64: "QUJD" }]);   // JPEG bytes stay labelled JPEG
  // mixing sources in one file, or an unknown id, is refused
  assert.equal((await call(d, "katashiro.upload_file", { selector: "x", files: [{ imageId: id, base64: "QUJD" }] })).isError, true);
  const gone = await call(d, "katashiro.upload_file", { selector: "x", files: [{ imageId: "img_0" }] });
  assert.match(gone.content[0].text, /no captured image "img_0"/);
  // the UI details show the imageId, never content
  const masked = BrowserMcp.TOOLS["katashiro.upload_file"].redact({ selector: "x", files: [{ imageId: id }] });
  assert.equal(masked.files[0].imageId, id);
});

test("the image store keeps only the newest captures", async () => {
  const { deps: d } = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "x", handled: true } });
  const first = (await shoot(d)).id;
  for (let i = 0; i < 10; i++) await shoot(d);                         // storeMax (default 10) newer ones
  const res = await call(d, "katashiro.paste_image", { imageId: first, selector: "#x" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /pushed out by newer ones/);
});

test("normalizeScreenshotConfig clamps to the Settings limits, defaults on junk", () => {
  const n = BrowserMcp.normalizeScreenshotConfig;
  assert.deepEqual(n(null), { maxKB: 500, storeMax: 10 });
  assert.deepEqual(n({ maxKB: "800", storeMax: 3 }), { maxKB: 800, storeMax: 3 });
  assert.deepEqual(n({ maxKB: 10, storeMax: 0 }), { maxKB: 50, storeMax: 1 });
  assert.deepEqual(n({ maxKB: 99999, storeMax: 999 }), { maxKB: 4096, storeMax: 50 });
  assert.deepEqual(n({ maxKB: "abc", storeMax: 2.6 }), { maxKB: 500, storeMax: 3 });
});

test("screenshot over the Settings size cap is shrunk via deps.reencodeImage", async () => {
  const big = "A".repeat(4 * 1024 * 200);                              // ~600 KB decoded
  const { deps: d } = deps({ dataUrl: `data:image/jpeg;base64,${big}` });
  d.screenshot = { maxKB: 100, storeMax: 10 };
  const steps = [];
  d.reencodeImage = async (b64, step) => { if (step.maxEdge) return null; steps.push(step); return "B".repeat(steps.length === 1 ? 4 * 1024 * 30 : 8); };          // 90 KB decoded; maxEdge = the agent-view pass
  const res = await call(d, "katashiro.screenshot");
  assert.equal(steps.length, 1);                                       // first step already fits
  assert.ok(steps[0].scale < 1 && steps[0].quality === 0.7);
  assert.equal(res.content[0].data.length, 4 * 1024 * 30);
  assert.match(res.content[1].text, /shrunk from 600 KB to fit the 100 KB limit/);
});

test("screenshot: still over the cap after every step says so; under the cap is untouched", async () => {
  const big = "A".repeat(4 * 1024 * 200);
  const over = deps({ dataUrl: `data:image/jpeg;base64,${big}` });
  over.deps.screenshot = { maxKB: 100, storeMax: 10 };
  let n = 0;
  over.deps.reencodeImage = async (b64, step) => { if (step.maxEdge) return null; n++; return "C".repeat(4 * 1024 * 150); };
  const res = await call(over.deps, "katashiro.screenshot");
  assert.equal(n, 3);
  assert.match(res.content[1].text, /still 450 KB — over the 100 KB limit/);
  const small = deps({ dataUrl: "data:image/jpeg;base64,QUJD" });
  let called = false;
  small.deps.reencodeImage = async (b64, step) => { if (!step.maxEdge) called = true; return null; };
  const ok = await call(small.deps, "katashiro.screenshot");
  assert.equal(called, false);
  assert.equal(ok.content[0].data, "QUJD");
});

test("Settings storeMax controls how many captures stay pasteable", async () => {
  const { deps: d } = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "x", handled: true } });
  d.screenshot = { maxKB: 500, storeMax: 2 };
  const a = (await shoot(d)).id;
  const b = (await shoot(d)).id;
  const c = (await shoot(d)).id;
  assert.equal((await call(d, "katashiro.paste_image", { imageId: a, selector: "#x" })).isError, true);   // evicted
  assert.equal((await call(d, "katashiro.paste_image", { imageId: b, selector: "#x" })).isError, undefined);
  assert.equal((await call(d, "katashiro.paste_image", { imageId: c, selector: "#x" })).isError, undefined);
  d.screenshot = { maxKB: 500, storeMax: 10 };                         // restore the default for later tests
  await shoot(d);
});

test("screenshot: the agent sees a ≤1568 px copy, the stored (pasteable) copy keeps its size", async () => {
  const stored = "S".repeat(4 * 1024 * 400);                          // ~1.2 MB decoded, under a 4096 KB cap
  const { deps: d, calls } = deps({ dataUrl: `data:image/jpeg;base64,${stored}`, scriptResult: { ok: true, how: "x", handled: true } });
  d.screenshot = { maxKB: 4096, storeMax: 10 };
  const seen = [];
  d.reencodeImage = async (b64, step) => { seen.push(step); return step.maxEdge ? "V".repeat(4 * 1024 * 60) : null; };
  const res = await call(d, "katashiro.screenshot");
  assert.deepEqual(seen, [{ scale: 1, quality: 0.7, maxEdge: 1568 }]);     // under the cap: only the agent-view pass
  assert.equal(res.content[0].data.length, 4 * 1024 * 60);              // agent got the small copy
  assert.match(res.content[1].text, /stored 1200 KB/);
  const id = /imageId: (img[-_][0-9a-f]{16})/.exec(res.content[1].text)[1];
  await call(d, "katashiro.paste_image", { imageId: id, selector: "#x" });
  const inj = calls.executeScript.find((x) => Array.isArray(x.args) && x.args.length === 5);
  assert.equal(inj.args[3].base64.length, stored.length);               // paste uses the full stored copy
  d.screenshot = { maxKB: 500, storeMax: 10 };
});

test("screenshot: an agent view still over 1 MB is not sent over the tunnel — text + imageId only", async () => {
  const big = "Z".repeat(4 * 1024 * 500);                             // 1.5 MB decoded, no reencode hook
  const { deps: d } = deps({ dataUrl: `data:image/jpeg;base64,${big}` });
  d.screenshot = { maxKB: 4096, storeMax: 10 };
  const res = await call(d, "katashiro.screenshot");
  assert.equal(res.isError, undefined);
  assert.equal(res.content.some((b) => b.type === "image"), false);   // no image block at all
  assert.match(res.content[0].text, /imageId: img[-_][0-9a-f]{16}.*\n\(the image is 1500 KB — too large to show you/s);
  d.screenshot = { maxKB: 500, storeMax: 10 };
});

test("screenshot: the agent-view cap is on base64 length (gateway 1 MiB frame), not decoded bytes", async () => {
  // 983,040 base64 chars = 720 KB decoded: under "1 MB of bytes" but over the frame budget.
  const view = "W".repeat(4 * 1024 * 240);
  const { deps: d } = deps({ dataUrl: `data:image/jpeg;base64,${view}` });
  d.screenshot = { maxKB: 4096, storeMax: 10 };
  const res = await call(d, "katashiro.screenshot");
  assert.equal(res.content.some((b) => b.type === "image"), false);
  assert.match(res.content[0].text, /too large to show you over the connection/);
  // just under the budget is still shown
  const ok = deps({ dataUrl: `data:image/jpeg;base64,${"W".repeat(900 * 1024 - 4)}` });
  ok.deps.screenshot = { maxKB: 4096, storeMax: 10 };
  assert.equal((await call(ok.deps, "katashiro.screenshot")).content[0].type, "image");
  d.screenshot = { maxKB: 500, storeMax: 10 };
});

test("upload_file: imageId captures have their own 20 MB total; agent base64 keeps the 5 MB cap", async () => {
  const big = "Q".repeat(4 * 1024 * 1024);                            // 3 MB decoded each
  const { deps: d, calls } = deps({ dataUrl: `data:image/jpeg;base64,${big}`, scriptResult: { ok: true, how: "selector input" } });
  d.screenshot = { maxKB: 4096, storeMax: 10 };
  const a = (await shoot(d)).id;
  const b = (await shoot(d)).id;
  const res = await call(d, "katashiro.upload_file", { selector: "input", files: [{ imageId: a }, { imageId: b }] });
  assert.equal(res.isError, undefined);                               // 6 MB of captures: allowed
  assert.match(res.content[0].text, /\(6291456 bytes\)/);
  const tooBig = await call(d, "katashiro.upload_file", { selector: "input", files: [{ name: "x.bin", base64: "A".repeat(8 * 1024 * 1024) }] });
  assert.equal(tooBig.isError, true);                                 // 6 MB from the agent: refused
  assert.match(tooBig.content[0].text, /capped at 5242880 bytes/);
  assert.ok(calls.executeScript.length > 0);
  d.screenshot = { maxKB: 500, storeMax: 10 };
});

// --- live-test follow-ups (2026-10-09) ---------------------------------------

test("a tab still loading (pendingUrl only) is found by url — switch_tab / close_tab / tabs", async () => {
  const LOADING = [...TABS3, { id: 60, windowId: 7, url: "", pendingUrl: "https://new.example/page", title: "", groupId: -1 }];
  const sw = deps({ tabsList: LOADING });
  assert.equal((await call(sw.deps, "katashiro.switch_tab", { url: "new.example" })).isError, undefined);
  assert.equal(sw.calls.tabsUpdate.at(-1).tabId, 60);
  const cl = deps({ tabsList: LOADING });
  assert.equal((await call(cl.deps, "katashiro.close_tab", { url: "new.example" })).isError, undefined);
  assert.deepEqual(cl.calls.tabsRemove, [60]);
  const text = (await call(deps({ tabsList: LOADING }).deps, "katashiro.tabs", { url: "new.example" })).content[0].text;
  assert.match(text, /^  \[3\] \(untitled\) — https:\/\/new\.example\/page  \(window 7 · loading\)$/m);
});

test("click focuses the clicked element's nearest focusable ancestor, as a real mousedown would", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, how: "selector .ql-editor" } });
  await call(d, "katashiro.click", { selector: ".ql-editor p" });
  const inj = calls.executeScript.find((c) => Array.isArray(c.args) && c.args[3] === "single");
  let asked = null;
  const editor = { focused: 0, focus(o) { this.focused++; this.opts = o; } };
  const el = {
    checkVisibility: () => true, getAttribute: () => null, scrollIntoView() {}, clicked: 0, click() { this.clicked++; },
    closest(sel) { asked = sel; return editor; }
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: { querySelector: () => el, activeElement: null }, configurable: true, writable: true });
  try {
    assert.deepEqual(inj.func(...inj.args), { ok: true, how: "selector .ql-editor p" });
  } finally {
    saved ? Object.defineProperty(globalThis, "document", saved) : delete globalThis.document;
  }
  assert.match(asked, /\[contenteditable\]:not\(\[contenteditable="false"\]\)/);
  assert.equal(editor.focused, 1);
  assert.deepEqual(editor.opts, { preventScroll: true });
  assert.equal(el.clicked, 1);
});

test("click leaves focus alone on non-editable targets (toolbar button, listbox option)", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, how: "selector .toolbar button.bold" } });
  await call(d, "katashiro.click", { selector: ".toolbar button.bold" });
  const inj = calls.executeScript.find((c) => Array.isArray(c.args) && c.args[3] === "single");
  // closest() honours the selector list: the button sits in a [tabindex="-1"] listbox-ish wrapper.
  const button = { focused: 0, focus() { this.focused++; } };
  const wrapper = { focused: 0, focus() { this.focused++; } };
  const el = {
    checkVisibility: () => true, getAttribute: () => null, scrollIntoView() {}, clicked: 0, click() { this.clicked++; },
    closest(sel) {
      const parts = sel.split(",").map((p) => p.trim());
      if (parts.includes("button")) return button;
      if (parts.includes("[tabindex]")) return wrapper;
      return null;
    }
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: { querySelector: () => el, activeElement: null }, configurable: true, writable: true });
  try {
    assert.deepEqual(inj.func(...inj.args), { ok: true, how: "selector .toolbar button.bold" });
  } finally {
    saved ? Object.defineProperty(globalThis, "document", saved) : delete globalThis.document;
  }
  assert.equal(button.focused, 0);
  assert.equal(wrapper.focused, 0);
  assert.equal(el.clicked, 1);
});

test("paste_image's wrapper lookup also finds contenteditable=plaintext-only", async () => {
  const page = fakePage({ prevent: false });
  const editable = page.node("DIV", { isContentEditable: true });
  const wrapper = page.node("DIV");
  let sel = null;
  wrapper.querySelector = (s) => { sel = s; return editable; };
  page.window.__katashiroResolve = () => ({ ok: true, el: wrapper });
  await runPasteInPage(page, { ref: "e7", snapshotId: 3 });
  assert.match(sel, /\[contenteditable="plaintext-only"\]/);
  assert.equal(page.seen[0].on, editable);
});

test("setImageStoreMax trims an instance's held screenshots immediately (newest kept)", async () => {
  const s = BrowserMcp.createServer({ id: "srv", name: "katashiro" });
  const bag = deps({ dataUrl: "data:image/jpeg;base64,QUJD", scriptResult: { ok: true, how: "x", handled: true } });
  const callOn = (name, args) => s.handleMcpMessage("tools/call", { name, arguments: args || {} }, bag.deps);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push(/imageId: (\S+)/.exec((await callOn("katashiro.screenshot")).content[1].text)[1]);
  s.setImageStoreMax(1);
  const gone = await callOn("katashiro.paste_image", { imageId: ids[0], selector: "#x" });
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /no captured image/);
  assert.equal((await callOn("katashiro.paste_image", { imageId: ids[1], selector: "#x" })).isError, true);
  assert.equal((await callOn("katashiro.paste_image", { imageId: ids[2], selector: "#x" })).isError, undefined);
});

// --- chat_history / notify --------------------------------------------------

function callTool(d, name, args) {
  return BrowserMcp.handleMcpMessage("tools/call", { name, arguments: args || {} }, d);
}

const HISTORY = [
  { kind: "sent", senderId: "me", senderName: "Brett", text: "is the build done?", timestamp: Date.UTC(2026, 9, 10, 7, 0, 0) },
  { kind: "received", senderId: "a1", senderName: "Orca", text: "x".repeat(50), timestamp: Date.UTC(2026, 9, 10, 7, 1, 0) },
  { kind: "error", senderName: "Orca", text: "turn failed", timestamp: Date.UTC(2026, 9, 10, 7, 2, 0) }
];

test("katashiro.chat_history returns the transcript oldest first, numbered, with roles", async () => {
  const { deps: d } = deps({ actMode: false });                 // read-only: works with act mode off
  d.chatHistory = () => HISTORY;
  const res = await callTool(d, "katashiro.chat_history");
  assert.equal(res.isError, undefined);
  const text = res.content[0].text;
  assert.match(text, /^3 of 3 messages, oldest first\. Each starts with a \[time sender\] line/);
  const L = (i) => BrowserMcp.localStamp(HISTORY[i].timestamp);
  assert.ok(text.includes(`[${L(0)} user]\nis the build done?`));
  assert.ok(text.includes(`[${L(1)} Orca]\n${"x".repeat(50)}`));
  assert.ok(text.includes(`[${L(2)} Orca error]\nturn failed`));
  assert.ok(text.includes("\n\n["));                                  // messages separated by a blank line
  assert.ok(text.indexOf(L(0)) < text.indexOf(L(2)));
  assert.doesNotMatch(text, /#\d+ /);                          // no #N counters (they read like PR numbers)
});

test("katashiro.chat_history: a reply to a 💬 selection shows what was selected", async () => {
  const { deps: d } = deps();
  const quoted = { id: "c:1", senderName: "Orca", timestamp: HISTORY[1].timestamp, text: "xxx" };
  d.chatHistory = () => [HISTORY[1],
    { kind: "sent", senderName: "Brett", text: "why?", timestamp: Date.UTC(2026, 9, 10, 7, 3, 0), replyTo: { ...quoted, selection: "pool max 10" } },
    { kind: "sent", senderName: "Brett", text: "ok", timestamp: Date.UTC(2026, 9, 10, 7, 4, 0), replyTo: quoted }];
  const text = (await callTool(d, "katashiro.chat_history")).content[0].text;
  const L = (ts) => BrowserMcp.localStamp(ts);
  assert.ok(text.includes(`[${L(Date.UTC(2026, 9, 10, 7, 3, 0))} user ↩ ${L(quoted.timestamp)} Orca, selected「pool max 10」]\nwhy?`));
  assert.ok(text.includes(`[${L(Date.UTC(2026, 9, 10, 7, 4, 0))} user ↩ ${L(quoted.timestamp)} Orca]\nok`));
});

test("katashiro.chat_history: limit keeps the most recent N, maxChars truncates per message", async () => {
  const { deps: d } = deps();
  d.chatHistory = () => HISTORY;
  const res = await callTool(d, "katashiro.chat_history", { limit: 2, maxChars: 10 });
  const text = res.content[0].text;
  assert.match(text, /^2 of 3 messages/);
  assert.ok(!text.includes("is the build done"));               // the oldest one is left out
  assert.match(text, / Orca\]\nx{10}… \[40 more chars\]/);
  assert.match(text, / Orca error\]\nturn faile… \[1 more chars\]/);
});

test("katashiro.chat_history works with a chrome:// active tab (sessionScope)", async () => {
  const { deps: d } = deps({ tabUrl: "chrome://newtab/" });
  d.chatHistory = () => HISTORY;
  const res = await callTool(d, "katashiro.chat_history");
  assert.equal(res.isError, undefined);
});

test("katashiro.chat_history: empty, missing host, and bad args are clean results", async () => {
  const { deps: d } = deps();
  d.chatHistory = () => [];
  assert.match((await callTool(d, "katashiro.chat_history")).content[0].text, /no chat history/);
  for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { maxChars: 0 }, { maxChars: 20001 }]) {
    const res = await callTool(d, "katashiro.chat_history", bad);
    assert.equal(res.isError, true, JSON.stringify(bad));
  }
  delete d.chatHistory;
  const res = await callTool(d, "katashiro.chat_history");
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not available/);
});

function withNotifications(d) {
  const created = [];
  d.chrome.notifications = { create: async (id, o) => { created.push({ id, o }); return id; } };
  return created;
}

test("katashiro.notify creates a basic notification tagged with the panel's window", async () => {
  const { deps: d } = deps({ actMode: false });                 // not a page write: no act-mode gate
  const created = withNotifications(d);
  d.windowId = 7;
  const res = await callTool(d, "katashiro.notify", { title: "Build", message: "images ready" });
  assert.equal(res.isError, undefined);
  assert.equal(created.length, 1);
  assert.ok(created[0].id.startsWith(`${BrowserMcp.NOTIFY_ID_PREFIX}7:`));
  assert.deepEqual(created[0].o, { type: "basic", iconUrl: "icon128.png", title: "Build", message: "images ready" });
  assert.match(res.content[0].text, /notification sent: Build — images ready/);
});

test("katashiro.notify defaults the title and validates its inputs", async () => {
  const { deps: d } = deps();
  const created = withNotifications(d);
  d.windowId = 60;                                               // module-level budget: own window
  // Bad calls first: each is refused by validation (not the limiter) and spends no budget.
  for (const bad of [{}, { message: "  " }, { message: "m".repeat(301) }, { message: "ok", title: "t".repeat(81) }]) {
    const res = await callTool(d, "katashiro.notify", bad);
    assert.equal(res.isError, true, JSON.stringify(bad));
    assert.match(res.content[0].text, /non-empty|capped at/, JSON.stringify(bad));
  }
  assert.equal((await callTool(d, "katashiro.notify", { message: "hi" })).isError, undefined);
  assert.equal(created[0].o.title, "Katashiro");
  assert.equal(created.length, 1);
});

test("katashiro.notify without the notifications API is a clean error", async () => {
  const { deps: d } = deps();
  const res = await callTool(d, "katashiro.notify", { message: "hi" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /notifications/);
});

test("katashiro.notify: per-window cooldown, dedupe of identical content, distinct ids", async () => {
  const { deps: d } = deps();
  const created = withNotifications(d);
  let t = 1_000_000;
  d.now = () => t;
  d.windowId = 41;
  assert.equal((await callTool(d, "katashiro.notify", { message: "a" })).isError, undefined);
  t += 3_000;
  const limited = await callTool(d, "katashiro.notify", { message: "b" });
  assert.equal(limited.isError, true);
  assert.match(limited.content[0].text, /rate limited.*retry in 7s/);
  d.windowId = 42;                                               // another window has its own budget
  assert.equal((await callTool(d, "katashiro.notify", { message: "b" })).isError, undefined);
  d.windowId = 41;
  t += 10_000;                                                   // cooldown over, but same content
  const dup = await callTool(d, "katashiro.notify", { message: "a" });
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /same notification/);
  assert.equal((await callTool(d, "katashiro.notify", { message: "a", title: "T" })).isError, undefined);
  t += 60_000;
  assert.equal((await callTool(d, "katashiro.notify", { message: "a", title: "T" })).isError, undefined);
  assert.equal(created.length, 4);
  assert.equal(new Set(created.map((c) => c.id)).size, 4);
  assert.ok(created.every((c) => /:\d+-\d+$/.test(c.id)));
});

test("katashiro.notify: parallel calls cannot slip past the cooldown", async () => {
  const { deps: d } = deps();
  const created = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  d.chrome.notifications = { create: async (id, o) => { await gate; created.push({ id, o }); return id; } };
  d.windowId = 50;
  const pending = Promise.all([
    callTool(d, "katashiro.notify", { message: "a" }),
    callTool(d, "katashiro.notify", { message: "b" })
  ]);
  release();
  const results = await pending;
  assert.equal(results.filter((r) => r.isError === undefined).length, 1);
  assert.match(results.find((r) => r.isError).content[0].text, /rate limited/);
  assert.equal(created.length, 1);
});

test("katashiro.notify: a failed create gives the slot back", async () => {
  const { deps: d } = deps();
  let fail = true;
  const created = [];
  d.chrome.notifications = { create: async (id, o) => { if (fail) throw new Error("boom"); created.push({ id, o }); return id; } };
  const t = 1_000_000;
  d.now = () => t;
  d.windowId = 51;                                               // module-level budget: own window
  const first = await callTool(d, "katashiro.notify", { message: "a" });
  assert.equal(first.isError, true);
  fail = false;
  assert.equal((await callTool(d, "katashiro.notify", { message: "a" })).isError, undefined);
  assert.equal(created.length, 1);
});

test("katashiro.notify: a clock stepped backwards does not freeze the limits", async () => {
  const { deps: d } = deps();
  const created = withNotifications(d);
  let t = 1_000_000;
  d.now = () => t;
  d.windowId = 52;
  assert.equal((await callTool(d, "katashiro.notify", { message: "a" })).isError, undefined);
  t -= 3_600_000;
  assert.equal((await callTool(d, "katashiro.notify", { message: "b" })).isError, undefined);
  assert.equal(created.length, 2);
});

test("katashiro.chat_history declares integer limit/maxChars", () => {
  const props = BrowserMcp.TOOLS["katashiro.chat_history"].inputSchema.properties;
  assert.equal(props.limit.type, "integer");
  assert.equal(props.maxChars.type, "integer");
});

// --- client_info ---------------------------------------------------------------

test("katashiro.client_info reports build, install, browser, window, act mode, optional permissions", async () => {
  const { deps: d } = deps({ tabUrl: "chrome://newtab/", actMode: false });   // sessionScope, read-only
  d.clientInfo = async () => ({
    version: "2.6.1", build: "v2.6.1", sha: "8d98205", builtAt: "2026-10-10T07:35:10Z",
    installType: "normal", extensionId: "abc", browser: "Chrome 155.0.1.2",
    windowId: 7, actMode: false, optionalPermissions: { sessions: false }
  });
  const res = await callTool(d, "katashiro.client_info");
  assert.equal(res.isError, undefined);
  const text = res.content[0].text;
  assert.match(text, /^Katashiro 2\.6\.1 \(build: v2\.6\.1, sha 8d98205, built 2026-10-10T07:35:10Z\)/);
  assert.match(text, /install: normal; extension id abc/);
  assert.match(text, /browser: Chrome 155\.0\.1\.2/);
  assert.match(text, /panel window: 7$/m);
  assert.match(text, /act mode: off/);
  assert.match(text, /optional permissions: sessions not granted/);
});

test("katashiro.client_info appends the recent disconnects, one line each (tunnel-liveness §9.3)", async () => {
  const { deps: d } = deps();
  d.clientInfo = async () => ({ version: "2.6.1", build: "dev", actMode: false, optionalPermissions: {}, recentDisconnects: ["L2 newest", "L1"] });
  let text = (await callTool(d, "katashiro.client_info")).content[0].text;
  assert.match(text, /optional permissions: none\nrecent disconnects \(newest first\):\n- L2 newest\n- L1$/);
  d.clientInfo = async () => ({ version: "2.6.1", recentDisconnects: [] });
  text = (await callTool(d, "katashiro.client_info")).content[0].text;
  assert.match(text, /\nrecent disconnects: none recorded since the browser started$/);
  d.clientInfo = async () => ({ version: "2.6.1" });                  // a host that does not record them
  assert.doesNotMatch((await callTool(d, "katashiro.client_info")).content[0].text, /disconnects/);
});

test("katashiro.client_info: dev build without sha, and a host without the provider", async () => {
  const { deps: d } = deps();
  d.clientInfo = async () => ({ version: "2.6.1", build: "dev", sha: null, actMode: true, optionalPermissions: {} });
  const text = (await callTool(d, "katashiro.client_info")).content[0].text;
  assert.match(text, /^Katashiro 2\.6\.1 \(build: dev\)$/m);
  assert.match(text, /act mode: on/);
  assert.match(text, /optional permissions: none/);
  delete d.clientInfo;
  const res = await callTool(d, "katashiro.client_info");
  assert.equal(res.isError, true);
});

// --- show_image ------------------------------------------------------------------

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function withShowImage(d, impl) {
  const shown = [];
  d.showImage = async (img) => { shown.push(img); return impl ? impl(img) : { width: 1, height: 1 }; };
  return shown;
}

test("katashiro.show_image: base64 data is shown with its caption; the pill never sees the bytes", async () => {
  const { deps: d } = deps({ actMode: false, tabUrl: "chrome://newtab/" });   // not act-gated, sessionScope
  const shown = withShowImage(d);
  const res = await callTool(d, "katashiro.show_image", { data: PNG_1PX, mimeType: "image/png", caption: "chart" });
  assert.equal(res.isError, undefined, JSON.stringify(res));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].dataUrl, `data:image/png;base64,${PNG_1PX}`);
  assert.equal(shown[0].caption, "chart");
  assert.match(res.content[0].text, /shown to the user: 1×1 image\/png .* — "chart"/);
});

test("katashiro.show_image redact replaces the base64 with its decoded size", () => {
  const r = BrowserMcp.TOOLS["katashiro.show_image"].redact({ data: PNG_1PX, mimeType: "image/png", caption: "x".repeat(90) });
  assert.doesNotMatch(JSON.stringify(r), /iVBOR/);
  assert.match(r.data, /^<\d+ bytes>$/);
  assert.equal(r.caption.length, 81);
  assert.equal(BrowserMcp.TOOLS["katashiro.show_image"].redact({ data: `data:image/png;base64,${PNG_1PX}` }).data, r.data);
});

test("katashiro.show_image accepts a data: URL and infers the type", async () => {
  const { deps: d } = deps();
  const shown = withShowImage(d);
  const res = await callTool(d, "katashiro.show_image", { data: `data:image/png;base64,${PNG_1PX}` });
  assert.equal(res.isError, undefined);
  assert.equal(shown[0].dataUrl, `data:image/png;base64,${PNG_1PX}`);
  const clash = await callTool(d, "katashiro.show_image", { data: `data:image/png;base64,${PNG_1PX}`, mimeType: "image/jpeg" });
  assert.equal(clash.isError, true);
});

test("katashiro.show_image shows a stored screenshot by imageId", async () => {
  const s = BrowserMcp.createServer({ id: "srv", name: "katashiro" });
  const bag = deps({ dataUrl: "data:image/jpeg;base64,QUJD" });
  const shown = withShowImage(bag.deps);
  const callOn = (name, args) => s.handleMcpMessage("tools/call", { name, arguments: args || {} }, bag.deps);
  const imageId = /imageId: (\S+)/.exec((await callOn("katashiro.screenshot")).content[1].text)[1];
  const res = await callOn("katashiro.show_image", { imageId });
  assert.equal(res.isError, undefined, JSON.stringify(res));
  assert.equal(shown[0].dataUrl, "data:image/jpeg;base64,QUJD");
  const gone = await callOn("katashiro.show_image", { imageId: "img_nope" });
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /no captured image/);
});

test("katashiro.show_image validates its inputs and reports undecodable images", async () => {
  const { deps: d } = deps();
  const shown = withShowImage(d);
  const big = "A".repeat(Math.ceil((5 * 1024 * 1024 + 10) * 4 / 3));
  for (const bad of [
    {},                                                             // no source
    { imageId: "x", data: PNG_1PX, mimeType: "image/png" },          // both
    { data: PNG_1PX },                                              // raw base64 without mimeType
    { data: PNG_1PX, mimeType: "image/bmp" },                       // not an allowed type
    { data: "not base64!!", mimeType: "image/png" },
    { data: big, mimeType: "image/png" },                            // over 5 MB
    { data: PNG_1PX, mimeType: "image/png", caption: "c".repeat(201) }
  ]) {
    const res = await callTool(d, "katashiro.show_image", bad);
    assert.equal(res.isError, true, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(shown.length, 0);
  d.showImage = async () => { throw new Error("decode"); };
  const res = await callTool(d, "katashiro.show_image", { data: "QUJD", mimeType: "image/png" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /does not decode/);
  delete d.showImage;
  assert.match((await callTool(d, "katashiro.show_image", { data: PNG_1PX, mimeType: "image/png" })).content[0].text, /not available/);
});

test("katashiro.show_image accepts SVG (the panel rasterizes it)", async () => {
  const { deps: d } = deps();
  const shown = withShowImage(d);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>').toString("base64");
  const res = await callTool(d, "katashiro.show_image", { data: svg, mimeType: "image/svg+xml" });
  assert.equal(res.isError, undefined, JSON.stringify(res));
  assert.equal(shown[0].dataUrl, `data:image/svg+xml;base64,${svg}`);
});

test("localStamp: local date-time with milliseconds and the UTC offset — the prompt header's form", () => {
  const ts = new Date(2026, 9, 10, 16, 5, 12).getTime() + 34;
  assert.match(BrowserMcp.localStamp(ts), /^2026-10-10T16:05:12\.034[+-]\d{2}:\d{2}$/);
  assert.equal(Date.parse(BrowserMcp.localStamp(ts)), ts);
  assert.equal(BrowserMcp.localStamp(ts), require("../room-core.js").msgTime(ts));
});

test("katashiro.chat_history marks a reply with the time and sender it answers", async () => {
  const { deps: d } = deps();
  const orig = new Date(2026, 9, 10, 16, 5, 40).getTime();
  d.chatHistory = () => [
    { kind: "received", senderName: "orca", text: "沒辦法直接知道", timestamp: orig },
    { kind: "sent", senderName: "You", text: "所以要加 sha", timestamp: orig + 110000,
      replyTo: { id: "c_x:" + orig, senderName: "orca", timestamp: orig, text: "沒辦法直接知道" } }
  ];
  const text = (await callTool(d, "katashiro.chat_history")).content[0].text;
  assert.ok(text.includes(`[${BrowserMcp.localStamp(orig + 110000)} user ↩ ${BrowserMcp.localStamp(orig)} orca]\n所以要加 sha`), text);
});

// --- canvas (ADR docs/adr/canvas.md, MVP) -------------------------------------------

const CanvasStore = require("../canvas-store.js");

function withCanvas(d, opts = {}) {
  const data = {};
  const storage = {
    async get(keys) { const out = {}; for (const k of keys == null ? Object.keys(data) : [].concat(keys)) if (k in data) out[k] = structuredClone(data[k]); return out; },
    async set(items) { for (const [k, v] of Object.entries(items)) data[k] = structuredClone(v); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
  let n = 0;
  const writes = [];
  d.canvas = {
    store: CanvasStore.createCanvasStore({ storage, lock: (_n, fn) => fn(), randomHex: () => (++n).toString(16).padStart(12, "0"), budgetBytes: opts.budgetBytes }),
    conversationId: () => opts.conversationId || "c_test",
    onWrite: async (res) => { writes.push(res); return opts.note || ""; },
  };
  return { writes, data };
}

test("katashiro.canvas_open creates, then updates with baseVersion; not act-gated, no tab needed", async () => {
  const { deps: d } = deps({ actMode: false, tabUrl: "chrome://newtab/" });
  const { writes } = withCanvas(d, { note: "opened in a background tab" });
  const r1 = await callTool(d, "katashiro.canvas_open", { title: "Plan", content: "# Plan" });
  assert.equal(r1.isError, undefined, JSON.stringify(r1));
  assert.match(r1.content[0].text, /^created canvas "Plan" — id cv_000000000001, version 1 \(opened in a background tab\)/);
  assert.equal(writes[0].created, true);
  const r2 = await callTool(d, "katashiro.canvas_open", { id: "cv_000000000001", baseVersion: 1, title: "Plan", content: "# Plan v2" });
  assert.match(r2.content[0].text, /^updated canvas "Plan" — id cv_000000000001, version 2/);
  const r3 = await callTool(d, "katashiro.canvas_read", { id: "cv_000000000001" });
  assert.match(r3.content[0].text, /"version":2/);
  assert.match(r3.content[0].text, /\n\n# Plan v2$/);
  const r4 = await callTool(d, "katashiro.canvas_list", {});
  assert.match(r4.content[0].text, /^cv_000000000001  v2  markdown  \d+ B  .*  Plan$/);
});

test("katashiro.canvas_open beside:\"current\" reaches the panel; any other value is refused before writing", async () => {
  const { deps: d } = deps({ actMode: false });
  const { writes } = withCanvas(d);
  const opts = [];
  d.canvas.onWrite = async (res, o) => { writes.push(res); opts.push(o); return o && o.beside ? "shown beside \"Docs\" in Split View" : ""; };
  const r1 = await callTool(d, "katashiro.canvas_open", { title: "Plan", content: "# Plan", beside: "current" });
  assert.match(r1.content[0].text, /^created canvas "Plan" — id cv_000000000001, version 1 \(shown beside "Docs" in Split View\)/);
  assert.deepEqual(opts[0], { beside: "current" });
  await callTool(d, "katashiro.canvas_open", { id: "cv_000000000001", baseVersion: 1, title: "Plan", content: "# v2" });
  assert.deepEqual(opts[1], { beside: null });
  const bad = await callTool(d, "katashiro.canvas_open", { title: "X", content: "x", beside: "left" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /`beside` must be "current"/);
  assert.equal(writes.length, 2);
  const schema = BrowserMcp.TOOLS["katashiro.canvas_open"].inputSchema.properties.beside;
  assert.deepEqual(schema.enum, ["current"]);
  assert.deepEqual(BrowserMcp.TOOLS["katashiro.canvas_open"].redact({ title: "P", beside: "current" }), { title: "P", beside: "current" });
});

test("katashiro.canvas_open: a stale write returns a structured JSON error", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "T", content: "a" });
  await callTool(d, "katashiro.canvas_open", { id: "cv_000000000001", baseVersion: 1, title: "T", content: "b" });
  const r = await callTool(d, "katashiro.canvas_open", { id: "cv_000000000001", baseVersion: 1, title: "T", content: "c" });
  assert.equal(r.isError, true);
  const e = JSON.parse(r.content[0].text);
  assert.equal(e.error, "stale");
  assert.equal(e.currentVersion, 2);
});

test("canvas tools without a panel (no ctx.canvas) fail cleanly", async () => {
  const { deps: d } = deps({ actMode: false });
  for (const name of ["katashiro.canvas_open", "katashiro.canvas_read", "katashiro.canvas_list"]) {
    const r = await callTool(d, name, { title: "T", content: "x", id: "cv_000000000001" });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not available in this host/);
  }
});

test("katashiro.canvas_open redact shows the title and size, never the document", () => {
  const masked = BrowserMcp.TOOLS["katashiro.canvas_open"].redact({ title: "Plan", content: "secret body".repeat(10), id: "cv_1", baseVersion: 2 });
  assert.deepEqual(masked, { id: "cv_1", baseVersion: 2, title: "Plan", content: "<110 bytes>" });
});

test("canvas tools are session-scoped and not write tools (ADR §3.4: not gated by act mode)", () => {
  for (const name of ["katashiro.canvas_open", "katashiro.canvas_read", "katashiro.canvas_patch", "katashiro.canvas_list", "katashiro.canvas_view", "katashiro.canvas_gallery"]) {
    assert.equal(BrowserMcp.TOOLS[name].sessionScope, true);
    assert.ok(!BrowserMcp.TOOLS[name].write);
  }
});

// --- screenshot of Katashiro's own canvas tab ---------------------------------------

test("katashiro.screenshot may capture Katashiro's own canvas tab and gallery; other extension pages stay refused", async () => {
  const base = "chrome-extension://kata/canvas.html";
  const gallery = "chrome-extension://kata/canvas-gallery.html";
  for (const [url, allowed] of [
    [`${base}?id=cv_000000000001`, true],
    [base, true],
    [gallery, true],                                    // §3.11: the agent opens it with canvas_gallery
    [`${gallery}#q=plan`, true],
    [`${gallery}?x=1`, true],
    [`${gallery}x`, false],
    ["chrome-extension://other/canvas-gallery.html", false],
    ["chrome-extension://kata/canvas-frame.html", false],
    ["chrome-extension://kata/sidepanel.html", false],
    ["chrome-extension://other/canvas.html?id=x", false],
    [`${base}x?id=1`, false],
    ["chrome://settings", false],
  ]) {
    const { deps: d, calls } = deps({ dataUrl: "data:image/jpeg;base64,QUJD", tabUrl: url });
    d.chrome.runtime = { getURL: (p) => `chrome-extension://kata/${p}` };
    const res = await callTool(d, "katashiro.screenshot", {});
    assert.equal(calls.captureVisibleTab.length, allowed ? 1 : 0, url);
    assert.equal(!!res.isError, !allowed, url);
  }
});

test("DOM tools stay refused on the canvas and gallery tabs (only screenshot is ownCanvas)", async () => {
  for (const url of ["chrome-extension://kata/canvas.html?id=cv_000000000001", "chrome-extension://kata/canvas-gallery.html"]) {
    const { deps: d } = deps({ tabUrl: url });
    d.chrome.runtime = { getURL: (p) => `chrome-extension://kata/${p}` };
    for (const tool of ["katashiro.snapshot", "katashiro.click"]) {
      const res = await callTool(d, tool, tool === "katashiro.click" ? { selector: "button" } : {});
      assert.equal(res.isError, true, `${tool} on ${url}`);
      assert.match(res.content[0].text, /Katashiro's own canvas .*canvas_read.*screenshot.*canvas_highlight.*canvas_inject_css/);
      assert.doesNotMatch(res.content[0].text, /no grantable web origin/);
    }
  }
  assert.deepEqual(Object.entries(BrowserMcp.TOOLS).filter(([, t]) => t.ownCanvas).map(([n]) => n), ["katashiro.screenshot"]);
});

test("katashiro.canvas_open: over budget with no room returns a quota JSON error", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d, { budgetBytes: 3 });
  const r = await callTool(d, "katashiro.canvas_open", { title: "T", content: "four" });
  assert.equal(r.isError, true);
  assert.equal(JSON.parse(r.content[0].text).error, "quota");
});

test("katashiro.show_image: a panel memory cap is reported as such, not as a decode failure (#60)", async () => {
  const { deps: d } = deps({ actMode: false });
  withShowImage(d, () => { throw Object.assign(new Error("at most 10 images per reply"), { code: "cap" }); });
  const res = await callTool(d, "katashiro.show_image", { data: PNG_1PX, mimeType: "image/png" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^show_image refused: at most 10 images per reply/);
});

// --- ask_user (ADR docs/adr/ask-user.md) -------------------------------------------

test("katashiro.ask_user returns at once with { asked } and tells the agent to end its turn", async () => {
  const { deps: d } = deps({ actMode: false, tabUrl: "chrome://newtab/" });   // not act-gated, sessionScope
  const asked = [];
  d.askUser = (args) => { asked.push(args); return { id: "ask_0a1b2c3d" }; };
  const args = { question: "Which?", options: ["A", "B"], multi: true, timeoutSec: 60 };
  const res = await callTool(d, "katashiro.ask_user", args);
  assert.equal(res.isError, undefined, JSON.stringify(res));
  assert.deepEqual(asked, [args]);                       // the panel validates; the raw args go through
  const [first, ...rest] = res.content[0].text.split("\n");
  assert.deepEqual(JSON.parse(first), { asked: "ask_0a1b2c3d" });
  assert.match(rest.join("\n"), /End your turn now/);
  assert.match(rest.join("\n"), /↩ 回答 ask_0a1b2c3d：/);
});

test("katashiro.ask_user reports a refusal from the panel as a tool error", async () => {
  const { deps: d } = deps({ actMode: false });
  d.askUser = () => { throw Object.assign(new Error("3 questions are already open"), { code: "cap" }); };
  const res = await callTool(d, "katashiro.ask_user", { question: "Q", options: ["a", "b"] });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /^ask_user: 3 questions are already open/);
  delete d.askUser;
  const none = await callTool(d, "katashiro.ask_user", { question: "Q", options: ["a", "b"] });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /not available/);
});

test("katashiro.ask_user declares 2–8 options and is neither a write nor page-scoped", () => {
  const def = BrowserMcp.TOOLS["katashiro.ask_user"];
  assert.equal(def.write, undefined);
  assert.equal(def.sessionScope, true);
  assert.deepEqual(def.inputSchema.required, ["question", "options"]);
  assert.equal(def.inputSchema.properties.options.minItems, 2);
  assert.equal(def.inputSchema.properties.options.maxItems, 8);
});

test("katashiro.notify: a failed create gives the slot back only if no later call took it (#57)", async () => {
  const { deps: d } = deps({ actMode: false });
  let clock = 1_000_000;
  d.now = () => clock;
  d.windowId = 4242;                                   // its own window key: lastNotify is module-level
  let releaseA;
  const created = [];
  d.chrome.notifications = {
    create: (id) => {
      created.push(id);
      if (created.length === 1) return new Promise((_r, rej) => { releaseA = () => rej(new Error("A failed")); });
      return Promise.resolve(id);
    },
  };
  const a = callTool(d, "katashiro.notify", { message: "A" });          // claims the slot, then hangs
  await new Promise((r) => setTimeout(r, 0));
  clock += 11_000;                                                       // past the 10 s cooldown
  const c = await callTool(d, "katashiro.notify", { message: "C" });    // claims the slot, succeeds
  assert.equal(c.isError, undefined, JSON.stringify(c));
  releaseA();
  const ra = await a;
  assert.equal(ra.isError, true);
  clock += 1_000;                                                        // C was 1 s ago
  const repeat = await callTool(d, "katashiro.notify", { message: "C" });
  assert.match(repeat.content[0].text, /same notification as the previous one/);   // C's slot survived A's rollback
});

test("katashiro.canvas_open kind:slides and kind:image (data, data: URL, imageId); bytes never in the pill", async () => {
  const { deps: d } = deps({ actMode: false, dataUrl: "data:image/jpeg;base64,QUJD" });
  withCanvas(d);
  const shot = await callTool(d, "katashiro.screenshot", {});
  const imgId = /imageId: (\S+)/.exec(shot.content.find((c) => c.type === "text" && /imageId/.test(c.text)).text)[1];
  const sl = await callTool(d, "katashiro.canvas_open", { title: "Deck", kind: "slides", content: "# A\n---\n# B" });
  assert.equal(sl.isError, undefined, JSON.stringify(sl));
  const im = await callTool(d, "katashiro.canvas_open", { title: "Px", kind: "image", data: PNG_1PX, mimeType: "image/png", caption: "c" });
  assert.equal(im.isError, undefined, JSON.stringify(im));
  const du = await callTool(d, "katashiro.canvas_open", { title: "Px2", kind: "image", data: `data:image/png;base64,${PNG_1PX}` });
  assert.equal(du.isError, undefined, JSON.stringify(du));
  const id = await callTool(d, "katashiro.canvas_open", { title: "Shot", kind: "image", imageId: imgId });
  assert.equal(id.isError, undefined, JSON.stringify(id));
  const both = await callTool(d, "katashiro.canvas_open", { title: "X", kind: "image", imageId: imgId, data: PNG_1PX, mimeType: "image/png" });
  assert.match(both.content[0].text, /exactly one of/);
  const gone = await callTool(d, "katashiro.canvas_open", { title: "X", kind: "image", imageId: "img_404" });
  assert.match(gone.content[0].text, /no captured image/);
  const read = await callTool(d, "katashiro.canvas_read", { id: "cv_000000000002" });
  assert.match(read.content[0].text, /"kind":"image"/);
  assert.doesNotMatch(read.content[0].text, new RegExp(PNG_1PX.slice(0, 20)));   // the agent never gets the bytes back
  const masked = BrowserMcp.TOOLS["katashiro.canvas_open"].redact({ title: "Px", kind: "image", data: PNG_1PX, mimeType: "image/png" });
  assert.match(masked.data, /^<\d+ bytes>$/);
});

test("canvas_open: normalizedDiff after the editor reformats markdown; a note when no tab normalized it (§3.5)", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  d.canvas.waitNormalized = async (_id, _v, raw) => ({ diff: CanvasStore.unifiedDiff(raw, raw.replace("* ", "- ")) });
  const r = await callTool(d, "katashiro.canvas_open", { title: "T", content: "* a" });
  assert.match(r.content[0].text, /normalizedDiff[\s\S]*-\* a\n\+- a/);
  d.canvas.waitNormalized = async () => null;
  const r2 = await callTool(d, "katashiro.canvas_open", { title: "U", content: "x" });
  assert.match(r2.content[0].text, /not normalized yet/);
  d.canvas.waitNormalized = async () => ({ diff: "" });
  const r3 = await callTool(d, "katashiro.canvas_open", { title: "V", kind: "slides", content: "x" });
  assert.doesNotMatch(r3.content[0].text, /normaliz/);                 // slides are stored as sent
});

test("canvas_open stale after a user edit returns diffFromBase; canvas_read records agentSeenVersion", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "T", content: "a\nb" });
  await d.canvas.store.userSave({ id: "cv_000000000001", baseVersion: 1, content: "a\nB" });
  const r = await callTool(d, "katashiro.canvas_open", { id: "cv_000000000001", baseVersion: 1, title: "T", content: "a\nb\nc" });
  const e = JSON.parse(r.content[0].text);
  assert.equal(e.error, "stale");
  assert.equal(e.author, "user");
  assert.match(e.diffFromBase, /-b\n\+B/);
  await callTool(d, "katashiro.canvas_read", { id: "cv_000000000001" });
  assert.equal((await d.canvas.store.read({ id: "cv_000000000001" })).agentSeenVersion, 2);
});

test("katashiro.canvas_delete asks the user; yes deletes, no keeps (any canvas, Brett)", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "Keep", content: "a" });
  await d.canvas.store.userSave({ id: "cv_000000000001", baseVersion: 1, content: "user edit" });
  const asked = [];
  d.canvas.confirmDelete = async (info) => { asked.push(info); return false; };
  const no = await callTool(d, "katashiro.canvas_delete", { id: "cv_000000000001" });
  assert.match(no.content[0].text, /^declined/);
  assert.equal(asked[0].author, "user");                       // a user-edited canvas is allowed too, if confirmed
  assert.equal((await d.canvas.store.list({ conversationId: "c_test" })).length, 1);
  d.canvas.confirmDelete = async () => true;
  const yes = await callTool(d, "katashiro.canvas_delete", { id: "cv_000000000001" });
  assert.match(yes.content[0].text, /^deleted canvas "Keep"/);
  assert.equal((await d.canvas.store.list({ conversationId: "c_test" })).length, 0);
  const gone = await callTool(d, "katashiro.canvas_delete", { id: "cv_000000000001" });
  assert.equal(gone.isError, true);
  delete d.canvas.confirmDelete;
  await callTool(d, "katashiro.canvas_open", { title: "X", content: "b" });
  const noAsk = await callTool(d, "katashiro.canvas_delete", { id: "cv_000000000002" });
  assert.match(noAsk.content[0].text, /no way to ask the user/);   // never deletes without asking
});

test("katashiro.canvas_delete: a canvas that changed (or went) while asking is not deleted (#80)", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "Doc", content: "a" });
  // The user saves while the card waits, then says yes: v2 is not the v1 they were asked about.
  d.canvas.confirmDelete = async ({ id, version }) => {
    assert.equal(version, 1);
    await d.canvas.store.userSave({ id, baseVersion: 1, content: "user edit" });
    return true;
  };
  const r = await callTool(d, "katashiro.canvas_delete", { id: "cv_000000000001" });
  assert.match(r.content[0].text, /^changed while asking, not deleted: .* is now v2 \(the user was asked about v1\)/);
  assert.equal((await d.canvas.store.read({ id: "cv_000000000001" })).content, "user edit");
  // Deleted elsewhere (canvas tab 🗑) while asking: nothing to do, and the agent is told so.
  d.canvas.confirmDelete = async ({ id }) => { await d.canvas.store.remove({ id }); return true; };
  const g = await callTool(d, "katashiro.canvas_delete", { id: "cv_000000000001" });
  assert.match(g.content[0].text, /^not deleted: .* already deleted while asking/);
});

test("katashiro.canvas_delete: an { ok, state } answer says why it declined (#80 follow-up)", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "Doc", content: "a" });
  const del = () => callTool(d, "katashiro.canvas_delete", { id: "cv_000000000001" });
  d.canvas.confirmDelete = async () => ({ ok: false, state: "skipped" });   // turn over before asking
  assert.match((await del()).content[0].text, /^declined: the turn ended before the user was asked; canvas "Doc" .* was not deleted/);
  d.canvas.confirmDelete = async () => ({ ok: false, state: "ended" });     // turn over while the card was up
  assert.match((await del()).content[0].text, /^declined: the turn ended before the user answered/);
  d.canvas.confirmDelete = async () => ({ ok: false, state: "timeout" });
  assert.match((await del()).content[0].text, /^declined: the user kept canvas "Doc"/);
  d.canvas.confirmDelete = async () => ({ ok: "yes", state: "allowed" });  // only ok === true counts
  assert.match((await del()).content[0].text, /^declined/);
  assert.equal((await d.canvas.store.list({ conversationId: "c_test" })).length, 1);
  d.canvas.confirmDelete = async () => ({ ok: true, state: "allowed" });
  assert.match((await del()).content[0].text, /^deleted canvas "Doc"/);
});

test("katashiro.canvas_goto: slides only, positive slide, reports what is shown", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "Deck", kind: "slides", content: "a\n---\nb" });
  await callTool(d, "katashiro.canvas_open", { title: "Doc", content: "x" });
  const calls = [];
  d.canvas.gotoSlide = async (id, slide) => { calls.push([id, slide]); return { ok: true, index: Math.min(slide, 2), total: 2 }; };
  const ok = await callTool(d, "katashiro.canvas_goto", { id: "cv_000000000001", slide: 2 });
  assert.equal(ok.content[0].text, 'showing slide 2 of 2 of "Deck"');
  const clamped = await callTool(d, "katashiro.canvas_goto", { id: "cv_000000000001", slide: 9 });
  assert.match(clamped.content[0].text, /asked for 9; the deck has 2/);
  const doc = await callTool(d, "katashiro.canvas_goto", { id: "cv_000000000002", slide: 1 });
  assert.match(doc.content[0].text, /is markdown, not slides/);
  const zero = await callTool(d, "katashiro.canvas_goto", { id: "cv_000000000001", slide: 0 });
  assert.match(zero.content[0].text, /positive integer/);
  d.canvas.gotoSlide = async () => ({ ok: false, error: "the user is editing this canvas" });
  const busy = await callTool(d, "katashiro.canvas_goto", { id: "cv_000000000001", slide: 1 });
  assert.match(busy.content[0].text, /editing/);
  assert.deepEqual(calls, [["cv_000000000001", 2], ["cv_000000000001", 9]]);
});

test("katashiro.canvas_highlight: one text anchor, bounded label and duration, markdown/slides only", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d, { conversationId: "c_hl" });
  let t = 1_000_000;
  d.now = () => t;
  await callTool(d, "katashiro.canvas_open", { title: "Doc", content: "# A\n\ntext" });
  await callTool(d, "katashiro.canvas_open", { title: "Pic", kind: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
  const calls = [];
  d.canvas.highlight = async (id, req) => { calls.push([id, req]); return { ok: true, tag: "h1", text: "A" }; };
  const ok = await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000001", heading: "A", label: "start here", durationMs: 60000 });
  assert.equal(ok.content[0].text, 'highlighted h1 "A" in "Doc" for 10s with the note "start here"');
  assert.deepEqual(calls[0], ["cv_000000000001", { label: "start here", durationMs: 10000, heading: "A" }]);   // capped at 10 s
  for (const [args, re] of [
    [{ id: "cv_000000000001" }, /exactly one of/],
    [{ id: "cv_000000000001", find: "a", heading: "A" }, /exactly one of/],
    [{ id: "cv_000000000001", find: "  " }, /is empty/],
    [{ id: "cv_000000000001", find: "x".repeat(501) }, /at most 500/],
    [{ id: "cv_000000000001", find: "text", label: "l".repeat(81) }, /keep it to 80/],
    [{ id: "cv_000000000002", find: "x" }, /is image; only markdown and slides/],
    [{ id: "cv_000000000009", find: "x" }, /cv_000000000009/],
  ]) {
    t += 10_000;
    const r = await callTool(d, "katashiro.canvas_highlight", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  }
  assert.equal(calls.length, 1);                                // none of those reached the canvas tab
  // Rate limit per canvas; a call that showed nothing gives its slot back.
  t += 10_000;
  await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000001", find: "text" });
  t += 500;
  const fast = await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000001", find: "text" });
  assert.match(fast.content[0].text, /rate limited/);
  t += 2000;
  d.canvas.highlight = async () => ({ ok: false, error: '2 blocks match "text"; give a longer `find`' });
  const many = await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000001", find: "text" });
  assert.match(many.content[0].text, /^canvas_highlight: 2 blocks match/);
  d.canvas.highlight = async () => ({ ok: true, deferred: true, tag: "p", text: "text" });
  const later = await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000001", find: "text" });
  assert.match(later.content[0].text, /^not shown yet: the user is editing "Doc"; .*Agent wants to show you a section.* p "text"/);
  t += 2000;
  d.canvas.highlight = async () => ({ ok: true, tag: "li", text: "x".repeat(300), slide: 2 });
  const long = await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000001", find: "x" });
  assert.match(long.content[0].text, /^highlighted li on slide 2 "x{120}" in "Doc" for 4s$/);
  t += 2000;
  delete d.canvas.highlight;
  assert.match((await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000001", find: "x" })).content[0].text, /not available/);
});

test("katashiro.canvas_inject_css: inject_css's sheet rules, any canvas kind, clear needs no css", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d, { conversationId: "c_css" });
  await callTool(d, "katashiro.canvas_open", { title: "Doc", content: "# A\n\ntext" });
  const calls = [];
  d.canvas.injectCss = async (id, req) => { calls.push([id, req]); return { ok: true, sheets: req.clear ? 0 : calls.length, tabId: 77 }; };
  const used = [];
  d.onTabUsed = (id) => used.push(id);
  const ok = await callTool(d, "katashiro.canvas_inject_css", { id: "cv_000000000001", css: "h1 { color: red !important }" });
  assert.equal(ok.isError, undefined, JSON.stringify(ok));
  assert.match(ok.content[0].text, /^injected 28 chars of CSS into "Doc" \(1 sheet now; /);
  assert.deepEqual(calls[0], ["cv_000000000001", { css: "h1 { color: red !important }" }]);
  assert.deepEqual(used, [77]);                                  // the tab it put in front is the working tab
  for (const [args, re] of [
    [{ id: "cv_000000000001" }, /needs `css`/],
    [{ id: "cv_000000000001", css: "  " }, /needs `css`/],
    [{ id: "cv_000000000001", css: "x".repeat(20001) }, /20001 chars; capped at 20000/],
    [{ id: "cv_000000000001", css: "td { background: url(https://x/?a) }" }, /"url\(" — refused/],
    [{ id: "cv_000000000001", css: "@import 'x';" }, /"@import"/],
    [{ id: "cv_000000000001", css: "p { content: '\\75' }" }, /refused/],
    [{ id: "cv_000000000009", css: "p {}" }, /cv_000000000009/],
  ]) {
    const r = await callTool(d, "katashiro.canvas_inject_css", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  }
  assert.equal(calls.length, 1);                                 // none of those reached the canvas tab
  const cleared = await callTool(d, "katashiro.canvas_inject_css", { id: "cv_000000000001", clear: true });
  assert.equal(cleared.content[0].text, 'removed the injected stylesheets from "Doc"');
  assert.deepEqual(calls[1], ["cv_000000000001", { clear: true }]);
  d.canvas.injectCss = async () => ({ ok: false, error: "the user is editing this canvas; try again when they are done" });
  assert.match((await callTool(d, "katashiro.canvas_inject_css", { id: "cv_000000000001", css: "p {}" })).content[0].text, /^canvas_inject_css: the user is editing/);
  delete d.canvas.injectCss;
  assert.match((await callTool(d, "katashiro.canvas_inject_css", { id: "cv_000000000001", css: "p {}" })).content[0].text, /not available/);
});

// --- canvas_patch (§3.5) -------------------------------------------------------------------------

test("katashiro.canvas_patch applies find/replace edits as an agent write: card, version, normalization wait", async () => {
  const { deps: d } = deps({ actMode: false, tabUrl: "chrome://newtab/" });
  const { writes } = withCanvas(d);
  const waited = [];
  d.canvas.waitNormalized = async (id, v, raw) => { waited.push({ id, v, raw }); return { diff: "" }; };
  await callTool(d, "katashiro.canvas_open", { title: "Doc", content: "# T\n\nalpha\n\nbeta" });
  const r = await callTool(d, "katashiro.canvas_patch", { id: "cv_000000000001", baseVersion: 1, edits: [{ find: "alpha", replace: "ALPHA" }, { find: "beta", replace: "" }] });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.match(r.content[0].text, /^patched canvas "Doc" — id cv_000000000001, version 2 \(2 edits\)$/);
  assert.equal(writes.length, 2);
  assert.deepEqual([writes[1].id, writes[1].version, writes[1].created], ["cv_000000000001", 2, false]);
  assert.deepEqual(waited[1], { id: "cv_000000000001", v: 2, raw: "# T\n\nALPHA\n\n" });
  const read = await callTool(d, "katashiro.canvas_read", { id: "cv_000000000001" });
  assert.match(read.content[0].text, /"version":2,"author":"agent"/);
  // A patch on top of a user edit says rebasedOver.
  await d.canvas.store.userSave({ id: "cv_000000000001", baseVersion: 2, content: "# T\n\nUSER\n\n" });
  const r2 = await callTool(d, "katashiro.canvas_patch", { id: "cv_000000000001", baseVersion: 2, edits: [{ find: "# T", replace: "# Title" }] });
  assert.match(r2.content[0].text, /version 4 \(1 edit\)\nrebasedOver: \{"version":3,"author":"user"\}/);
  assert.match(r2.content[0].text, /\ndiffFromBase \(what changed between your baseVersion v2 and v3, before your edits\):\n[^]*-ALPHA\n\+USER/);
  assert.equal((await d.canvas.store.read({ id: "cv_000000000001" })).content, "# Title\n\nUSER\n\n");
});

test("katashiro.canvas_patch errors are structured JSON: stale (+failedEdit, diffFromBase) and patch (edit index, count)", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "T", content: "a\nb\nc" });
  await d.canvas.store.userSave({ id: "cv_000000000001", baseVersion: 1, content: "a\nB\nc" });
  const st = await callTool(d, "katashiro.canvas_patch", { id: "cv_000000000001", baseVersion: 1, edits: [{ find: "b", replace: "x" }] });
  assert.equal(st.isError, true);
  const e = JSON.parse(st.content[0].text);
  assert.equal(e.error, "stale");
  assert.equal(e.currentVersion, 2);
  assert.equal(e.author, "user");
  assert.match(e.diffFromBase, /-b\n\+B/);
  assert.deepEqual([e.failedEdit.index, e.failedEdit.count], [0, 0]);
  const two = JSON.parse((await callTool(d, "katashiro.canvas_patch", { id: "cv_000000000001", baseVersion: 2, edits: [{ find: "a", replace: "A" }, { find: "\n", replace: "" }] })).content[0].text);
  assert.deepEqual([two.error, two.edit, two.count], ["patch", 1, 2]);
  assert.match(two.message, /^nothing applied: edits\[1\]\.find matches 2 places/);
  const ov = JSON.parse((await callTool(d, "katashiro.canvas_patch", { id: "cv_000000000001", baseVersion: 2, edits: [{ find: "a\nB", replace: "1" }, { find: "B\nc", replace: "2" }] })).content[0].text);
  assert.deepEqual([ov.error, ov.edit, ov.overlaps], ["patch", 1, 0]);
  assert.equal((await d.canvas.store.read({ id: "cv_000000000001" })).version, 2);       // nothing applied
  const bad = await callTool(d, "katashiro.canvas_patch", { id: "cv_000000000001", baseVersion: 2, edits: "a→b" });
  assert.match(bad.content[0].text, /^canvas_patch: `edits` must be a non-empty array/);
});

test("katashiro.canvas_patch refuses image canvases; redact never shows the text", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "Px", kind: "image", data: PNG_1PX, mimeType: "image/png" });
  const r = await callTool(d, "katashiro.canvas_patch", { id: "cv_000000000001", baseVersion: 1, edits: [{ find: "image", replace: "x" }] });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /only markdown, slides and mermaid canvases can be patched/);
  const masked = BrowserMcp.TOOLS["katashiro.canvas_patch"].redact({ id: "cv_1", baseVersion: 3, edits: [{ find: "secret", replace: "token é" }] });
  assert.deepEqual(masked, { id: "cv_1", baseVersion: 3, edits: "<1 edit, 14 bytes>" });
  assert.equal(BrowserMcp.TOOLS["katashiro.canvas_patch"].inputSchema.properties.edits.maxItems, CanvasStore.PATCH_EDITS_MAX);
  const none = { ...d, canvas: undefined };
  assert.match((await callTool(none, "katashiro.canvas_patch", { id: "cv_1", baseVersion: 1, edits: [] })).content[0].text, /not available in this host/);
});

test("canvas_open kind:mermaid (Brett 2026-10-11): stored as sent, not normalized; the description teaches fences and the kind", async () => {
  const def = BrowserMcp.TOOLS["katashiro.canvas_open"];
  assert.ok(def.inputSchema.properties.kind.enum.includes("mermaid"));
  assert.match(def.description, /```mermaid fence/);
  assert.match(def.description, /`mermaid` \(the whole canvas is one diagram/);
  assert.match(BrowserMcp.TOOLS["katashiro.canvas_patch"].description, /markdown, slides or mermaid CANVAS/);
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  let waited = 0;
  d.canvas.waitNormalized = async () => { waited += 1; return { diff: "" }; };
  const r = await callTool(d, "katashiro.canvas_open", { title: "Flow", kind: "mermaid", content: "flowchart LR\n  A --> B" });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  assert.doesNotMatch(r.content[0].text, /normaliz/);
  assert.equal(waited, 0);
  const read = await callTool(d, "katashiro.canvas_read", { id: "cv_000000000001" });
  assert.match(read.content[0].text, /"kind":"mermaid"[\s\S]*\n\nflowchart LR\n {2}A --> B$/);
  const p = await callTool(d, "katashiro.canvas_patch", { id: "cv_000000000001", baseVersion: 1, edits: [{ find: "A --> B", replace: "A --> C" }] });
  assert.equal(p.isError, undefined, JSON.stringify(p));
});

// --- canvas_view / canvas_gallery (ADR canvas §3.11) ---------------------------------------------

test("katashiro.canvas_view: showChanges is the global switch; compare needs an id and a text canvas", async () => {
  const { deps: d } = deps({ actMode: false, tabUrl: "chrome://newtab/" });    // not act-gated, sessionScope
  withCanvas(d);
  await callTool(d, "katashiro.canvas_open", { title: "Doc", content: "x" });
  await callTool(d, "katashiro.canvas_open", { title: "Pic", kind: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
  let show = false;
  const calls = [];
  d.canvas.setShowChanges = async (on) => { calls.push(["show", on]); const was = show; show = on; return { was }; };
  d.canvas.compare = async (id, on) => { calls.push(["compare", id, on]); return on ? { ok: true } : { ok: true, closed: 1 }; };
  const on = await callTool(d, "katashiro.canvas_view", { showChanges: true });
  assert.equal(on.isError, undefined, JSON.stringify(on));
  assert.match(on.content[0].text, /^顯示變更 is now on for every canvas tab \(a global switch/);
  assert.match((await callTool(d, "katashiro.canvas_view", { showChanges: true })).content[0].text, /is already on/);
  const both = await callTool(d, "katashiro.canvas_view", { id: "cv_000000000001", showChanges: false, compare: true });
  assert.match(both.content[0].text, /^顯示變更 is now off .*\ncomparing "Doc" with your last write \(v1\) in Split View/);
  const end = await callTool(d, "katashiro.canvas_view", { id: "cv_000000000001", compare: false });
  assert.equal(end.content[0].text, 'ended the compare of "Doc" (closed its compare tab)');
  assert.deepEqual(calls, [["show", true], ["show", true], ["show", false], ["compare", "cv_000000000001", true], ["compare", "cv_000000000001", false]]);
  calls.length = 0;
  for (const [args, re] of [
    [{}, /give `showChanges` and\/or `compare`/],
    [{ showChanges: "on" }, /must be true or false/],
    [{ compare: 1, id: "cv_000000000001" }, /must be true or false/],
    [{ compare: true }, /needs the canvas `id`/],
    [{ id: "cv_000000000009", compare: true }, /cv_000000000009/],
    [{ id: "cv_000000000002", compare: true }, /"Pic" is image; only markdown, slides and mermaid/],
  ]) {
    const r = await callTool(d, "katashiro.canvas_view", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  }
  assert.deepEqual(calls, []);                                  // none of those reached the panel
  // The panel / canvas tab's refusal (the button's rule) comes back as the reason.
  d.canvas.compare = async (_id, on) => (on ? { ok: false, error: "the latest version is the agent's last write: nothing to compare" } : { ok: true, closed: 0 });
  const no = await callTool(d, "katashiro.canvas_view", { id: "cv_000000000001", compare: true });
  assert.equal(no.isError, true);
  assert.match(no.content[0].text, /^canvas_view: cannot compare "Doc": the latest version is the agent's last write/);
  assert.equal((await callTool(d, "katashiro.canvas_view", { id: "cv_000000000001", compare: false })).content[0].text, 'no compare of "Doc" was open');
  delete d.canvas.compare;
  assert.match((await callTool(d, "katashiro.canvas_view", { id: "cv_000000000001", compare: true })).content[0].text, /not available/);
});

test("katashiro.canvas_gallery: opens the gallery, query trimmed and capped", async () => {
  const { deps: d } = deps({ actMode: false, tabUrl: "chrome://newtab/" });
  assert.match((await callTool(d, "katashiro.canvas_gallery", {})).content[0].text, /not available/);
  withCanvas(d);
  const asked = [];
  d.canvas.openGallery = async (q) => { asked.push(q); };
  assert.equal((await callTool(d, "katashiro.canvas_gallery", {})).content[0].text, "opened the canvas gallery tab");
  assert.equal((await callTool(d, "katashiro.canvas_gallery", { query: "  設計 ADR " })).content[0].text, 'opened the canvas gallery tab searching "設計 ADR"');
  assert.equal((await callTool(d, "katashiro.canvas_gallery", { query: "" })).content[0].text, "opened the canvas gallery tab with an empty search");
  const long = await callTool(d, "katashiro.canvas_gallery", { query: "x".repeat(201) });
  assert.equal(long.isError, true);
  assert.match(long.content[0].text, /201 chars; at most 200/);
  assert.equal((await callTool(d, "katashiro.canvas_gallery", { query: 5 })).isError, true);
  assert.deepEqual(asked, [undefined, "設計 ADR", ""]);
});

// --- multi-conversation P1b (ADR §4.3, §4.6): working tab hooks, switch_tab working, set_title ------

test("P1b: the tab a page tool acts on, new_tab's tab (opened) and switch_tab's target reach onTabUsed", async () => {
  const used = [];
  const { deps: d } = deps({ createdTab: { id: 99, windowId: 7, url: "https://bg/" }, tabsList: [{ id: 42, windowId: 7, url: "https://a/" }, { id: 55, windowId: 7, url: "https://b/" }] });
  d.onTabUsed = (id, o) => used.push([id, o || null]);
  await call(d, "katashiro.read_dom", {});
  await call(d, "katashiro.new_tab", { url: "https://bg/", active: false });
  await call(d, "katashiro.switch_tab", { index: 1 });
  assert.deepEqual(used, [[42, null], [99, { opened: true }], [55, null]]);
  // a throwing host hook never fails the tool
  d.onTabUsed = () => { throw new Error("boom"); };
  assert.equal((await call(d, "katashiro.new_tab", { url: "https://bg/", active: false })).isError, undefined);
});

test("P1b: a canvas tool that puts a canvas tab in front reports it to onTabUsed; a background write does not", async () => {
  const used = [];
  const { deps: d } = deps({ actMode: false, tabUrl: "chrome://newtab/" });
  withCanvas(d);
  d.onTabUsed = (id, o) => used.push([id, o || null]);
  let t = 1_000_000;
  d.now = () => t;
  await callTool(d, "katashiro.canvas_open", { title: "Deck", kind: "slides", content: "# A\n---\nb" });
  await callTool(d, "katashiro.canvas_open", { title: "Doc", content: "# A\n\ntext" });
  assert.deepEqual(used, []);                                   // created in a background tab: not the working tab
  // beside: the host answers { note, tabId } when it showed the canvas; the note still reaches the result.
  d.canvas.onWrite = async (_res, o) => (o.beside ? { note: "shown beside \"P\" in Split View", tabId: 70 } : "its open tab updated");
  const beside = await callTool(d, "katashiro.canvas_open", { id: "cv_000000000002", baseVersion: 1, title: "Doc", content: "# A\n\ntext 2", beside: "current" });
  assert.match(beside.content[0].text, /version 2 \(shown beside "P" in Split View\)/);
  await callTool(d, "katashiro.canvas_open", { id: "cv_000000000002", baseVersion: 2, title: "Doc", content: "# A\n\ntext 3" });
  d.canvas.gotoSlide = async () => ({ ok: true, index: 1, total: 2, tabId: 71 });
  await callTool(d, "katashiro.canvas_goto", { id: "cv_000000000001", slide: 1 });
  d.canvas.highlight = async () => ({ ok: true, tag: "h1", text: "A", tabId: 72 });
  await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000002", heading: "A" });
  t += 10_000;
  d.canvas.highlight = async () => ({ ok: true, deferred: true, tag: "h1", text: "A" });   // the user is editing: stays put
  await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000002", heading: "A" });
  d.canvas.compare = async (_id, on) => (on ? { ok: true, tabId: 73 } : { ok: true, closed: 1 });
  await callTool(d, "katashiro.canvas_view", { id: "cv_000000000002", compare: true });
  await callTool(d, "katashiro.canvas_view", { id: "cv_000000000002", compare: false });
  assert.deepEqual(used, [[70, null], [71, null], [72, null], [73, null]]);   // never { opened }: already grouped
  // a throwing host hook never fails the tool
  d.onTabUsed = () => { throw new Error("boom"); };
  t += 10_000;
  d.canvas.highlight = async () => ({ ok: true, tag: "h1", text: "A", tabId: 72 });
  assert.equal((await callTool(d, "katashiro.canvas_highlight", { id: "cv_000000000002", heading: "A" })).isError, undefined);
});

test("P1b: switch_tab({tab: \"working\"}) activates the host's working tab, or says there is none", async () => {
  const { deps: d, calls } = deps({ tabsList: [{ id: 42, windowId: 7, url: "https://a/", title: "A" }, { id: 55, windowId: 8, url: "chrome://newtab/", title: "B" }] });
  d.workingTab = async () => 55;
  const res = await call(d, "katashiro.switch_tab", { tab: "working" });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 55, upd: { active: true } }]);
  assert.match(res.content[0].text, /switched to tab \[1\] — B/);
  d.workingTab = async () => null;
  assert.match((await call(d, "katashiro.switch_tab", { tab: "working" })).content[0].text, /no working tab yet/);
  d.workingTab = async () => 1234;                      // closed meanwhile
  assert.match((await call(d, "katashiro.switch_tab", { tab: "working" })).content[0].text, /no working tab yet/);
  assert.match((await call(d, "katashiro.switch_tab", { tab: "first" })).content[0].text, /takes only "working"/);
  delete d.workingTab;
  assert.match((await call(d, "katashiro.switch_tab", { tab: "working" })).content[0].text, /no working tab yet/);
});

test("P1b: set_title goes to the host and reports its verdict; not gated by act mode", async () => {
  const { deps: d } = deps({ actMode: false });
  const seen = [];
  d.setTitle = async (t) => { seen.push(t); return t === "mine" ? { ok: false, error: "the user named this conversation" } : { ok: true, title: t.trim() }; };
  const ok = await call(d, "katashiro.set_title", { title: " Market research " });
  assert.equal(ok.isError, undefined);
  assert.match(ok.content[0].text, /renamed to "Market research"/);
  const no = await call(d, "katashiro.set_title", { title: "mine" });
  assert.equal(no.isError, true);
  assert.match(no.content[0].text, /not renamed: the user named this conversation/);
  assert.match((await call(d, "katashiro.set_title", { title: 3 })).content[0].text, /needs a `title` string/);
  delete d.setTitle;
  assert.match((await call(d, "katashiro.set_title", { title: "x" })).content[0].text, /not available in this host/);
  assert.deepEqual(seen, [" Market research ", "mine"]);
});

// --- multi-conversation P2 §5: a conversation not on screen ----------------------------------------

test("backgroundRefusal (Q8): page tools allowed except screenshot; only the listed tab/canvas tools; nothing that shows", () => {
  for (const n of BrowserMcp.BACKGROUND_SESSION_TOOLS) assert.ok(BrowserMcp.TOOLS[n] && BrowserMcp.TOOLS[n].sessionScope, `${n} is a real session-scope tool`);
  // Page tools (they run on the conversation's working tab, checked by the host).
  for (const n of ["katashiro.read_dom", "katashiro.snapshot", "katashiro.click", "katashiro.type", "katashiro.navigate", "katashiro.get_text", "katashiro.highlight"]) {
    assert.equal(BrowserMcp.backgroundRefusal(n, {}), null, n);
  }
  // Session tools that touch nothing the user sees, and the background forms of the tab tools.
  for (const n of ["katashiro.chat_history", "katashiro.canvas_read", "katashiro.canvas_patch", "katashiro.ask_user", "katashiro.notify",
    "katashiro.tabs", "katashiro.tab_groups", "katashiro.new_tab", "katashiro.switch_tab", "katashiro.close_tab"]) {
    assert.equal(BrowserMcp.backgroundRefusal(n, {}), null, n);
  }
  assert.equal(BrowserMcp.backgroundRefusal("katashiro.canvas_open", { title: "x" }), null);
  // Refused: screenshot (Chrome captures only the tab in front), tab moves, canvas tools that show.
  for (const n of ["katashiro.screenshot", "katashiro.reopen_tab", "katashiro.tab_update", "katashiro.group_tabs", "katashiro.split_tabs",
    "katashiro.canvas_goto", "katashiro.canvas_highlight", "katashiro.canvas_inject_css", "katashiro.canvas_view", "katashiro.canvas_gallery"]) {
    assert.match(BrowserMcp.backgroundRefusal(n, {}), /in the background in Katashiro/, n);
  }
  assert.match(BrowserMcp.backgroundRefusal("katashiro.canvas_open", { beside: "current" }), /in the background/);
  assert.match(BrowserMcp.backgroundRefusal("katashiro.screenshot", {}), /new_tab.*switch_tab/);
  assert.equal(BrowserMcp.backgroundRefusal("katashiro.no_such_tool", {}), null, "unknown tools fail later with their own error");
});

test("Q8: a page tool from a background conversation runs on the host's tab, never the active one, and activates nothing", async () => {
  const { chrome, calls } = mockChrome({ scriptResult: { ok: true, text: "hi" } });
  const asked = [];
  const d = { chrome, crypto: mockCrypto(), actMode: true,
    backgroundTab: async (o) => { asked.push(o); return { tab: { id: 314, windowId: 7, url: "https://mine/", groupId: 5 } }; } };
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.get_text", arguments: { selector: "#x" } }, d);
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.equal(calls.executeScript[0].target.tabId, 314);
  assert.ok(!calls.query.some((q) => q.active), "the active tab was never looked up");
  assert.equal(calls.tabsUpdate.length, 0);
  assert.deepEqual(asked, [{ write: false }]);
  // A write asks with write: true, and the host's refusal reaches the agent as an error.
  const d2 = { ...d, backgroundTab: async (o) => (o.write ? { error: "the user is looking at one of your conversation's tabs right now" } : { tab: { id: 314, url: "https://mine/" } }) };
  const w = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.navigate", arguments: { url: "https://x/" } }, d2);
  assert.equal(w.isError, true);
  assert.match(w.content[0].text, /looking at one of your conversation/);
});

test("Q8: background new_tab opens in the background, awaits the host, and snapshots the new working tab", async () => {
  const { chrome, calls } = mockChrome({ tabsList: [{ id: 99, windowId: 7, url: "https://n/" }] });
  const used = [];
  let settled = false;
  const d = { chrome, crypto: mockCrypto(), actMode: true,
    backgroundTab: async () => ({ tab: { id: 99 } }),
    onTabUsed: (id, o) => new Promise((r) => setTimeout(() => { used.push([id, o]); settled = true; r(); }, 5)) };
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.new_tab", arguments: { url: "https://n/", active: true } }, d);
  assert.equal(calls.tabsCreate[0].active, false, "never active from the background, even when asked");
  assert.ok(settled, "the host bookkeeping finished before the tool returned");
  assert.deepEqual(used, [[99, { opened: true }]]);
  assert.match(res.content[0].text, /background — your conversation is not on screen; it is your working tab/);
});

test("Q8: background switch_tab selects (no activation, no focus); close_tab needs a name and the host's yes", async () => {
  const list = [{ id: 1, windowId: 7, url: "https://user/", title: "U" }, { id: 2, windowId: 7, url: "https://mine/", title: "M" }];
  const { chrome, calls } = mockChrome({ tabsList: list });
  const checks = [];
  const used = [];
  const d = { chrome, crypto: mockCrypto(), actMode: true, onTabUsed: async (id) => { used.push(id); },
    backgroundTab: async (o) => { checks.push(o); return o.tabId === 2 ? { tab: list[1] } : { error: "not in your tab group" }; } };
  let r = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.switch_tab", arguments: { url: "mine" } }, d);
  assert.notEqual(r.isError, true, JSON.stringify(r));
  assert.match(r.content[0].text, /selected tab \[1\] as your working tab \(not brought to the front/);
  assert.equal(calls.tabsUpdate.length, 0);
  assert.equal(calls.windowsUpdate.length, 0);
  assert.deepEqual(used, [2]);
  r = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.switch_tab", arguments: { url: "user" } }, d);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not in your tab group/);
  // close_tab: no identifier → refused; someone else's tab → refused; its own → closed.
  r = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.close_tab", arguments: {} }, d);
  assert.match(r.content[0].text, /name the tab to close/);
  r = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.close_tab", arguments: { index: 0 } }, d);
  assert.equal(r.isError, true);
  assert.deepEqual(calls.tabsRemove, []);
  r = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.close_tab", arguments: { index: 1 } }, d);
  assert.notEqual(r.isError, true, JSON.stringify(r));
  assert.deepEqual(calls.tabsRemove, [2]);
  assert.deepEqual(checks.filter((c) => c.write), [{ tabId: 1, write: true }, { tabId: 2, write: true }]);
});

test("tools/call: a refuse FUNCTION decides per tool (name, raw args); refused calls run nothing and show no pill", async () => {
  const seen = [];
  const pills = [];
  const { chrome } = mockChrome();
  const d = {
    chrome, crypto: mockCrypto(), actMode: true,
    refuse: (name, args) => { seen.push([name, args]); return name === "katashiro.tabs" ? null : "nope: background"; },
    onToolCall: (i) => pills.push(i),
  };
  const refused = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.get_text", arguments: { selector: "#x" } }, d);
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text, "nope: background");
  assert.deepEqual(seen[0], ["katashiro.get_text", { selector: "#x" }]);
  assert.equal(pills.length, 0);
  const ok = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.tabs", arguments: {} }, d);
  assert.notEqual(ok.isError, true);
  assert.ok(pills.length > 0, "an allowed call shows its pill as usual");
  // A string still refuses every call (unchanged).
  const all = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.tabs", arguments: {} }, { ...d, refuse: "closed" });
  assert.equal(all.content[0].text, "closed");
});

test("Q8: background new_tab that could not join the group says so and snapshots nothing (review #144)", async () => {
  const { chrome, calls } = mockChrome({ tabsList: [{ id: 99, windowId: 7, url: "https://n/" }] });
  const d = { chrome, crypto: mockCrypto(), actMode: true, backgroundTab: async () => ({ tab: { id: 99 } }), onTabUsed: async () => false };
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.new_tab", arguments: { url: "https://n/" } }, d);
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.match(res.content[0].text, /could not join your conversation's tab group, so page tools cannot act on it/);
  assert.doesNotMatch(res.content[0].text, /it is your working tab/);
  assert.equal(calls.executeScript.length, 0, "no snapshot of a tab it may not act on");
});

test("Q8: callBrowserTool refuses screenshot from the background even without refuse (second line, review #144)", async () => {
  const { chrome, calls } = mockChrome();
  let asked = 0;
  const d = { chrome, crypto: mockCrypto(), actMode: true, backgroundTab: async () => { asked++; return { tab: { id: 5, url: "https://mine/" } }; } };
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.screenshot", arguments: {} }, d);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /in the background in Katashiro/);
  assert.equal(asked, 0, "the host was not even asked for a tab");
  assert.equal((calls.captureVisibleTab || []).length, 0);
});

// waitForComplete (#147 follow-up): a tab that already finished loading before the onUpdated
// listener was attached must not cost the 8 s bound — it asks tabs.get once after attaching.
test("new_tab: a page that finished loading before the listener is not waited on for 8 s", async () => {
  const { chrome } = mockChrome({ tabsList: [{ id: 99, windowId: 7, url: "https://fast/" }], scriptResult: { ok: true, text: "snap" } });
  const listeners = new Set();
  chrome.tabs.onUpdated = { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) };
  chrome.tabs.get = async (id) => ({ id, status: "complete" });
  const t0 = Date.now();
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.new_tab", arguments: { url: "https://fast/" } }, { chrome, crypto: mockCrypto(), actMode: true });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(listeners.size, 0, "the listener is removed");
});

test("new_tab: still loading → waits for onUpdated status complete (not the 8 s bound)", async () => {
  const { chrome } = mockChrome({ tabsList: [{ id: 99, windowId: 7, url: "https://slow/" }], scriptResult: { ok: true, text: "snap" } });
  const listeners = new Set();
  chrome.tabs.onUpdated = { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) };
  chrome.tabs.get = async (id) => ({ id, status: "loading" });
  setTimeout(() => { for (const f of [...listeners]) f(99, { status: "complete" }); }, 100);
  const t0 = Date.now();
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.new_tab", arguments: { url: "https://slow/" } }, { chrome, crypto: mockCrypto(), actMode: true });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  const ms = Date.now() - t0;
  assert.ok(ms >= 90 && ms < 2000, `took ${ms} ms`);
  assert.equal(listeners.size, 0);
});

// A tab still reporting the previous page's "complete" while a navigation is pending must not end
// the wait early (navigate / reload / history call waitForComplete after the update resolves).
test("new_tab: complete but with a pendingUrl → still waits for onUpdated", async () => {
  const { chrome } = mockChrome({ tabsList: [{ id: 99, windowId: 7, url: "https://next/" }], scriptResult: { ok: true, text: "snap" } });
  const listeners = new Set();
  chrome.tabs.onUpdated = { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) };
  chrome.tabs.get = async (id) => ({ id, status: "complete", pendingUrl: "https://next/" });
  setTimeout(() => { for (const f of [...listeners]) f(99, { status: "complete" }); }, 100);
  const t0 = Date.now();
  const res = await BrowserMcp.handleMcpMessage("tools/call", { name: "katashiro.new_tab", arguments: { url: "https://next/" } }, { chrome, crypto: mockCrypto(), actMode: true });
  assert.notEqual(res.isError, true, JSON.stringify(res));
  const ms = Date.now() - t0;
  assert.ok(ms >= 90 && ms < 2000, `took ${ms} ms`);
  assert.equal(listeners.size, 0);
});

// multi-conversation §7.3 (Brett 2026-10-19 18:55 TPE): canvas_move pushes and pulls, with a confirm every time.
function withConversations(d, data) {
  d.canvas.conversations = async (q) => [{ id: "c_000000000002", title: "Other", archived: false, lastMessageAt: null, canvases: [], q }];
  d.canvas.conversationInfo = (id) => ({ c_000000000002: { title: "Other", gone: null }, c_000000000003: { title: "Third", gone: null }, c_000000000009: { title: "Gone", gone: "deleted" } })[id] || null;
  return data;
}

test("katashiro.conversation_list: the panel's list as JSON (metadata only), query passed through", async () => {
  const { deps: d } = deps({ actMode: false });
  withCanvas(d);
  withConversations(d);
  const r = await callTool(d, "katashiro.conversation_list", { query: "oth" });
  const j = JSON.parse(r.content[0].text);
  assert.equal(j.conversations[0].id, "c_000000000002");
  assert.equal(j.conversations[0].q, "oth");
  delete d.canvas.conversations;
  assert.equal((await callTool(d, "katashiro.conversation_list", {})).isError, true);
});

test("katashiro.canvas_move: push asks, then moves (the mover's conversation gets no note); decline moves nothing", async () => {
  const { deps: d } = deps({ actMode: false });
  const { data } = withCanvas(d);
  withConversations(d);
  await callTool(d, "katashiro.canvas_open", { title: "Notes", content: "a" });
  const asked = [];
  d.canvas.confirmMove = async (info) => { asked.push(info); return { ok: false, state: "declined" }; };
  let r = await callTool(d, "katashiro.canvas_move", { id: "cv_000000000001", to: "c_000000000002" });
  assert.match(r.content[0].text, /^declined: the user did not move/);
  assert.deepEqual(asked[0], { id: "cv_000000000001", title: "Notes", version: 1, push: true, otherTitle: "Other" });
  assert.equal(data[CanvasStore.metaKey("cv_000000000001")].conversationId, "c_test");
  d.canvas.confirmMove = async () => ({ ok: false, state: "ended" });
  assert.match((await callTool(d, "katashiro.canvas_move", { id: "cv_000000000001", to: "c_000000000002" })).content[0].text, /turn ended before the user answered/);
  d.canvas.confirmMove = async () => true;
  r = await callTool(d, "katashiro.canvas_move", { id: "cv_000000000001", to: "c_000000000002" });
  assert.match(r.content[0].text, /^moved canvas "Notes" \(cv_000000000001\) to conversation "Other"/);
  assert.equal(data[CanvasStore.metaKey("cv_000000000001")].conversationId, "c_000000000002");
  assert.equal(data[CanvasStore.movedKey("c_test")], undefined);                  // the mover knows
  assert.equal(data[CanvasStore.movedKey("c_000000000002")][0].dir, "in");       // the other agent is told
  assert.equal((await callTool(d, "katashiro.canvas_read", { id: "cv_000000000001" })).isError, true);
});

test("katashiro.canvas_move: pull another conversation's canvas in; refusals", async () => {
  const { deps: d } = deps({ actMode: false });
  const { data } = withCanvas(d);
  withConversations(d);
  await d.canvas.store.agentWrite({ conversationId: "c_000000000002", title: "Theirs", content: "t" });   // cv_…1
  await callTool(d, "katashiro.canvas_open", { title: "Mine", content: "m" });                            // cv_…2
  const asked = [];
  d.canvas.confirmMove = async (info) => { asked.push(info); return { ok: true }; };
  let r = await callTool(d, "katashiro.canvas_move", { id: "cv_000000000001" });
  assert.match(r.content[0].text, /^moved canvas "Theirs" \(cv_000000000001, v1\) into this conversation from "Other"; canvas_read it/);
  assert.equal(asked[0].push, false);
  assert.equal(data[CanvasStore.movedKey("c_000000000002")][0].dir, "out");
  assert.equal(data[CanvasStore.movedKey("c_test")], undefined);
  assert.equal((await callTool(d, "katashiro.canvas_read", { id: "cv_000000000001" })).isError, undefined);
  asked.length = 0;
  // Refused without asking: already here, between two other conversations, unknown / deleted target, no canvas.
  assert.match((await callTool(d, "katashiro.canvas_move", { id: "cv_000000000002" })).content[0].text, /already in this conversation/);
  await d.canvas.store.agentWrite({ conversationId: "c_000000000002", title: "Far", content: "f" });      // cv_…3
  assert.match((await callTool(d, "katashiro.canvas_move", { id: "cv_000000000003", to: "c_000000000003" })).content[0].text, /only a canvas of this conversation/);
  assert.match((await callTool(d, "katashiro.canvas_move", { id: "cv_000000000002", to: "c_000000000009" })).content[0].text, /no conversation "c_000000000009" \(deleted\)/);
  assert.match((await callTool(d, "katashiro.canvas_move", { id: "cv_000000000002", to: "c_nope" })).content[0].text, /no conversation "c_nope"/);
  assert.match((await callTool(d, "katashiro.canvas_move", { id: "cv_000000000099" })).content[0].text, /no canvas "cv_000000000099"/);
  assert.equal(asked.length, 0);
  // The target deleted while the card waited: asked, then refused, nothing moved.
  const info = d.canvas.conversationInfo;
  d.canvas.confirmMove = async () => { d.canvas.conversationInfo = async (id) => (id === "c_000000000002" ? { title: "Other", gone: "deleted" } : info(id)); return { ok: true }; };
  assert.match((await callTool(d, "katashiro.canvas_move", { id: "cv_000000000002", to: "c_000000000002" })).content[0].text, /conversation "c_000000000002" is gone \(deleted\).*was not moved/);
  d.canvas.conversationInfo = info;
  delete d.canvas.confirmMove;
  assert.match((await callTool(d, "katashiro.canvas_move", { id: "cv_000000000002", to: "c_000000000002" })).content[0].text, /no way to ask the user/);
  assert.equal(data[CanvasStore.metaKey("cv_000000000002")].conversationId, "c_test");
});
