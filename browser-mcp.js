// browser-mcp.js — MCP-over-ACP browser-tool logic for katashiro.
//
// Katashiro is the browser MCP *server* over the ACP tunnel: the gateway opens a
// tunnel to our declared `type:acp` server (server-initiated `mcp/connect`) and drives
// MCP over `mcp/message` (inner method/params flattened in, outer ACP id correlates).
// See docs/mcp-over-acp-tunnel-contract.md in the openab repo.
//
// This module holds the pure protocol + tool logic with ALL environment deps injected
// (`chrome`, `crypto`, and a `send` callback) so it runs unchanged in the extension
// (real chrome/crypto/ws) and under node --test (mocked). No DOM / WebSocket / global
// state lives here — the caller owns the connection state object.
//
// Dual target: loaded as a classic <script> in sidepanel.html (exposes globalThis.BrowserMcp)
// and require()'d by the node test suite (module.exports). No bundler, no MIME concerns.
(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = mod; // node (test)
  else root.BrowserMcp = mod; // extension global
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // The browser tools we serve (advertised via tools/list; DOM-semantic, model-agnostic).
  const BROWSER_TOOLS = [
    {
      name: "browser.click",
      description: "Click the element matching a CSS selector in the active browser tab.",
      inputSchema: { type: "object", properties: { selector: { type: "string", description: "CSS selector" } }, required: ["selector"] }
    },
    {
      name: "browser.read_dom",
      description: "Read a snapshot of the active tab's DOM (optionally scoped to a selector).",
      inputSchema: { type: "object", properties: { selector: { type: "string", description: "optional CSS selector to scope the snapshot" } } }
    },
    {
      name: "browser.navigate",
      description: "Navigate the active browser tab to a URL.",
      inputSchema: { type: "object", properties: { url: { type: "string", description: "absolute URL" } }, required: ["url"] }
    },
    {
      name: "browser.type",
      description: "Type text into the element matching a CSS selector in the active tab.",
      inputSchema: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" } }, required: ["selector", "text"] }
    },
    {
      name: "browser.screenshot",
      description: "Capture a screenshot of the active browser tab.",
      inputSchema: { type: "object", properties: {} }
    }
  ];

  const okText = (t) => ({ content: [{ type: "text", text: t }] });
  const errText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

  // The currently active tab (the shikigami acts here).
  async function activeTab(chrome) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error("no active browser tab");
    return tab;
  }

  // Execute a browser tool in the active tab via chrome.scripting/tabs. Returns an MCP
  // CallToolResult ({ content, isError? }). DOM actions run injected in the page context.
  // `deps.chrome` is the injected chrome API (real in the extension, mocked in tests).
  async function callBrowserTool(name, args, deps) {
    const chrome = deps.chrome;
    const tab = await activeTab(chrome);
    switch (name) {
      case "browser.click": {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: "no element for selector: " + sel };
            el.click();
            return { ok: true };
          },
          args: [args.selector]
        });
        return result.ok ? okText(`clicked ${args.selector}`) : errText(result.error);
      }
      case "browser.read_dom": {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel) => {
            const el = sel ? document.querySelector(sel) : document.body;
            if (!el) return { ok: false, error: "no element for selector: " + sel };
            return { ok: true, html: el.outerHTML.slice(0, 100000) };
          },
          args: [args.selector || null]
        });
        return result.ok ? okText(result.html) : errText(result.error);
      }
      case "browser.navigate": {
        await chrome.tabs.update(tab.id, { url: args.url });
        return okText(`navigating to ${args.url}`);
      }
      case "browser.type": {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, text) => {
            const el = document.querySelector(sel);
            if (!el) return { ok: false, error: "no element for selector: " + sel };
            el.focus();
            if ("value" in el) el.value = text;
            else el.textContent = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          },
          args: [args.selector, args.text]
        });
        return result.ok ? okText(`typed into ${args.selector}`) : errText(result.error);
      }
      case "browser.screenshot": {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
        return { content: [{ type: "image", data: base64, mimeType: "image/png" }] };
      }
      default: {
        const err = new Error(`unknown tool: ${name}`);
        err.code = -32602;
        throw err;
      }
    }
  }

  // The MCP server surface we expose over the tunnel (we are the MCP server, the agent is the
  // client). Returns the inner MCP result; `undefined` for notifications (no reply).
  async function handleMcpMessage(method, params, deps) {
    switch (method) {
      case "initialize":
        return {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "katashiro-browser", version: "1.0.0" }
        };
      case "notifications/initialized":
        return undefined; // notification — no response
      case "tools/list":
        return { tools: BROWSER_TOOLS };
      case "tools/call":
        // Tool-execution failures (no active tab, restricted page like chrome://, missing host
        // permission, injected-script error) become MCP isError results — not protocol errors —
        // so the agent sees the failure and can adapt.
        try {
          return await callBrowserTool(params.name, params.arguments || {}, deps);
        } catch (e) {
          return { content: [{ type: "text", text: `tool error: ${(e && e.message) || e}` }], isError: true };
        }
      default: {
        const err = new Error(`method not found: ${method}`);
        err.code = -32601;
        throw err;
      }
    }
  }

  // Handle a server-initiated request from the gateway (tunnel control + MCP-over-ACP).
  // `deps` = { chrome, crypto, send }; `send(obj)` writes a JSON-RPC frame to the socket.
  // `state` carries the connection id (caller owns it, e.g. to reset on reconnect).
  async function handleServerRequest(msg, deps, state) {
    const send = deps.send;
    switch (msg.method) {
      case "mcp/connect": {
        // The gateway opens the tunnel to our declared server; we name the connection.
        state.mcpConnectionId = deps.crypto.randomUUID();
        send({ jsonrpc: "2.0", id: msg.id, result: { connectionId: state.mcpConnectionId } });
        return;
      }
      case "mcp/message": {
        // Inner MCP is flattened into params (method/params); the outer ACP id correlates.
        const inner = msg.params || {};
        try {
          const result = await handleMcpMessage(inner.method, inner.params || {}, deps);
          // A notification (undefined result) gets no response frame.
          if (result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
        } catch (e) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: e.message || String(e) } });
        }
        return;
      }
      case "mcp/disconnect": {
        state.mcpConnectionId = null;
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
        return;
      }
      default:
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }

  return { BROWSER_TOOLS, callBrowserTool, handleMcpMessage, handleServerRequest };
});
