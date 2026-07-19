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
  const calls = { query: [], executeScript: [], tabsUpdate: [], captureVisibleTab: [] };
  const chrome = {
    tabs: {
      query: async (q) => {
        calls.query.push(q);
        return opts.noTab ? [] : [{ id: 42, windowId: 7 }];
      },
      update: async (tabId, upd) => {
        calls.tabsUpdate.push({ tabId, upd });
      },
      captureVisibleTab: async (windowId, o) => {
        calls.captureVisibleTab.push({ windowId, o });
        return opts.dataUrl || "data:image/png;base64,QUJD"; // "ABC"
      }
    },
    scripting: {
      executeScript: async (inj) => {
        calls.executeScript.push(inj);
        // Simulate the in-page func's return (the func itself needs a DOM; not run here).
        return [{ result: opts.scriptResult ?? { ok: true } }];
      }
    }
  };
  return { chrome, calls };
}

const mockCrypto = (uuid = "conn-abc") => ({ randomUUID: () => uuid });

// Collects frames written by the module's `send`.
function mockSend() {
  const sent = [];
  return { send: (obj) => sent.push(obj), sent };
}

// Build the deps bag the module expects, plus expose the recorders.
function deps(opts = {}) {
  const { chrome, calls } = mockChrome(opts);
  const { send, sent } = mockSend();
  const statuses = []; // records onStatus(attached) transitions
  return {
    deps: { chrome, crypto: mockCrypto(opts.uuid), send, onStatus: (a) => statuses.push(a) },
    calls,
    sent,
    statuses
  };
}

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

test("tools/list returns the 5 DOM-semantic browser tools", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/list", {}, d);
  const names = res.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "browser.click",
    "browser.read_dom",
    "browser.navigate",
    "browser.type",
    "browser.screenshot"
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

test("browser.read_dom injects a script and returns the DOM as text", async () => {
  const { deps: d, calls } = deps({ scriptResult: { ok: true, html: "<body>hi</body>" } });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "browser.read_dom", arguments: { selector: "#main" } },
    d
  );
  assert.equal(calls.executeScript.length, 1);
  assert.equal(calls.executeScript[0].target.tabId, 42);
  assert.deepEqual(calls.executeScript[0].args, ["#main"]);
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].text, "<body>hi</body>");
});

test("browser.click on a missing element yields an isError result", async () => {
  const { deps: d } = deps({ scriptResult: { ok: false, error: "no element for selector: #gone" } });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "browser.click", arguments: { selector: "#gone" } },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no element/);
});

test("browser.navigate drives chrome.tabs.update", async () => {
  const { deps: d, calls } = deps();
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "browser.navigate", arguments: { url: "https://example.com" } },
    d
  );
  assert.deepEqual(calls.tabsUpdate, [{ tabId: 42, upd: { url: "https://example.com" } }]);
  assert.match(res.content[0].text, /example\.com/);
});

test("browser.type injects a script with selector + text args", async () => {
  const { deps: d, calls } = deps();
  await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "browser.type", arguments: { selector: "#q", text: "hello" } },
    d
  );
  assert.deepEqual(calls.executeScript[0].args, ["#q", "hello"]);
});

test("browser.screenshot captures the tab and returns base64 image content", async () => {
  const { deps: d, calls } = deps({ dataUrl: "data:image/png;base64,QUJD" });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "browser.screenshot", arguments: {} },
    d
  );
  assert.equal(calls.captureVisibleTab.length, 1);
  assert.equal(calls.captureVisibleTab[0].windowId, 7);
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].mimeType, "image/png");
  assert.equal(res.content[0].data, "QUJD"); // data: prefix stripped
});

test("tools/call with no active tab returns an isError result (not a throw)", async () => {
  const { deps: d } = deps({ noTab: true });
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "browser.read_dom", arguments: {} },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /no active browser tab/);
});

test("tools/call for an unknown tool returns an isError result", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "browser.teleport", arguments: {} },
    d
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /unknown tool/);
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

test("mcp/message initialize replies on the outer ACP id", async () => {
  const { deps: d, sent } = deps();
  const state = { mcpConnectionId: "c" };
  await BrowserMcp.handleServerRequest(
    { id: 9, method: "mcp/message", params: { method: "initialize", params: {} } },
    d,
    state
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 9);
  assert.equal(sent[0].result.serverInfo.name, "katashiro-browser");
});

test("mcp/message notifications/initialized sends NO response frame", async () => {
  const { deps: d, sent } = deps();
  const state = { mcpConnectionId: "c" };
  await BrowserMcp.handleServerRequest(
    { id: 10, method: "mcp/message", params: { method: "notifications/initialized" } },
    d,
    state
  );
  assert.equal(sent.length, 0);
});

test("mcp/message tools/call read_dom: full tunnel round-trip", async () => {
  const { deps: d, sent, calls } = deps({ scriptResult: { ok: true, html: "<h1>ok</h1>" } });
  const state = { mcpConnectionId: "c" };
  await BrowserMcp.handleServerRequest(
    {
      id: 11,
      method: "mcp/message",
      params: { method: "tools/call", params: { name: "browser.read_dom", arguments: {} } }
    },
    d,
    state
  );
  assert.equal(calls.executeScript.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 11);
  assert.equal(sent[0].result.content[0].text, "<h1>ok</h1>");
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
