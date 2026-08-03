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
  const calls = { query: [], executeScript: [], tabsUpdate: [], captureVisibleTab: [], goBack: [], goForward: [] };
  const chrome = {
    tabs: {
      query: async (q) => {
        calls.query.push(q);
        if (opts.noTab) return [];
        // active-tab lookup (activeTab()) vs list-all (katashiro.tabs): the latter can be seeded.
        if (!q.active && opts.tabsList) return opts.tabsList;
        return [{ id: 42, windowId: 7 }];
      },
      update: async (tabId, upd) => {
        calls.tabsUpdate.push({ tabId, upd });
      },
      goBack: async (tabId) => { calls.goBack.push(tabId); },
      goForward: async (tabId) => { calls.goForward.push(tabId); },
      captureVisibleTab: async (windowId, o) => {
        calls.captureVisibleTab.push({ windowId, o });
        return opts.dataUrl || "data:image/png;base64,QUJD"; // "ABC"
      }
    },
    scripting: {
      executeScript: async (inj) => {
        calls.executeScript.push(inj);
        // Simulate the in-page func's return (the func itself needs a DOM; not run here). frameId:0
        // is the top frame — the merge/all-frames path keys on it.
        return [{ frameId: 0, result: opts.scriptResult ?? { ok: true } }];
      }
    }
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

test("tools/list returns the 14 DOM-semantic browser tools", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/list", {}, d);
  const names = res.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "katashiro.click",
    "katashiro.read_dom",
    "katashiro.navigate",
    "katashiro.type",
    "katashiro.screenshot",
    "katashiro.snapshot",
    "katashiro.wait_for",
    "katashiro.get_text",
    "katashiro.scroll",
    "katashiro.tabs",
    "katashiro.history",
    "katashiro.press_key",
    "katashiro.hover",
    "katashiro.select_option"
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

// --- act mode: the write consent gate ---------------------------------------

// Which tools mutate the page is a registry fact, so assert it there rather than restating
// the list in every gate test below.
const WRITE_TOOLS = Object.entries(BrowserMcp.TOOLS)
  .filter(([, t]) => t.write)
  .map(([name]) => name);

test("exactly the page-mutating tools are marked write", () => {
  assert.deepEqual(WRITE_TOOLS.sort(), [
    "katashiro.click",
    "katashiro.history",
    "katashiro.navigate",
    "katashiro.press_key",
    "katashiro.select_option",
    "katashiro.type"
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
  assert.equal(tools.length, 14);
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
  assert.equal(k.result.tools.length, 14, "the surviving server still answers");
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
    tabs: { query: async () => [{ id: 42, windowId: 7 }] },
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
    tabs: { query: async () => [{ id: 42, windowId: 7 }] },
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
