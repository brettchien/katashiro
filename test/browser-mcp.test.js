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

test("tools/list returns the 35 DOM-semantic browser tools", async () => {
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
    "katashiro.get_selection",
    "katashiro.select_option",
    "katashiro.fill_form",
    "katashiro.upload_file",
    "katashiro.paste_image",
    "katashiro.reload",
    "katashiro.inject_css"
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
  assert.match(res.content[0].text, /needs an `index`.*or a `url`/);
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
