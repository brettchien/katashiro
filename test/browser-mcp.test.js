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

test("tools/list returns the 5 DOM-semantic browser tools", async () => {
  const { deps: d } = deps();
  const res = await BrowserMcp.handleMcpMessage("tools/list", {}, d);
  const names = res.tools.map((t) => t.name);
  assert.deepEqual(names, [
    "katashiro.click",
    "katashiro.read_dom",
    "katashiro.navigate",
    "katashiro.type",
    "katashiro.screenshot"
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

test("katashiro.type injects a script with selector + text args", async () => {
  const { deps: d, calls } = deps();
  await BrowserMcp.handleMcpMessage(
    "tools/call",
    { name: "katashiro.type", arguments: { selector: "#q", text: "hello" } },
    d
  );
  assert.deepEqual(calls.executeScript[0].args, ["#q", "hello"]);
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

// This is the frame OpenAB's discovery cache actually sends (one `tools/list` per declared
// server, result cached and reused across reconnects — ADR §6.3). It arrives with NO inner
// `params` key at all, because the gateway sends `None`; serving it is the whole of the
// katashiro side of pull-based discovery.
test("mcp/message tools/list: discovery round-trip with no inner params", async () => {
  const { deps: d, sent } = deps();
  const state = { mcpConnectionId: "c" };
  await BrowserMcp.handleServerRequest(
    { id: 12, method: "mcp/message", params: { method: "tools/list" } },
    d,
    state
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 12, "the reply correlates on the OUTER acp id");

  // The shape the gateway deserializes into its own Tool type: drop any of these three
  // fields and discovery silently caches nothing.
  const tools = sent[0].result.tools;
  assert.equal(tools.length, 5);
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
  const { deps: d, sent, calls } = deps({ scriptResult: { ok: true, html: "<h1>ok</h1>" } });
  const state = { mcpConnectionId: "c" };
  await BrowserMcp.handleServerRequest(
    {
      id: 11,
      method: "mcp/message",
      params: { method: "tools/call", params: { name: "katashiro.read_dom", arguments: {} } }
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
  assert.equal(k.result.tools.length, 5, "the surviving server still answers");
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
