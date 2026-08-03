// browser-mcp.js — MCP-over-ACP browser-tool logic for katashiro.
//
// Katashiro is the browser MCP *server* over the ACP tunnel: the gateway opens a
// tunnel to our declared `type:acp` server (server-initiated `mcp/connect`) and drives
// MCP over `mcp/message` (inner method/params flattened in, outer ACP id correlates).
// See docs/mcp-over-acp-tunnel-contract.md in the openab repo.
//
// This module is also the reference example of "an MCP server served over reverse
// MCP-over-ACP" — see the README section of the same name. A client that wants to serve
// its own tools this way needs exactly three things: declare `{type:"acp", id, name}` in
// `session/new`, answer `tools/list`, and answer `tools/call`. Everything below is those
// three things plus the browser-specific tool bodies.
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

  /**
   * An MCP `CallToolResult`. `isError` marks a *tool* failure — the agent sees it and can
   * adapt; protocol failures are thrown instead.
   * @typedef {{ content: Array<object>, isError?: boolean }} CallToolResult
   */

  /**
   * What a tool body gets to work with. The active tab is resolved once, before dispatch,
   * so no tool has to re-query it.
   * @typedef {object} ToolContext
   * @property {object} chrome  injected chrome API (real in the extension, mocked in tests)
   * @property {object} tab     the active tab (`{ id, windowId, ... }`)
   */

  /**
   * One entry of the tool registry.
   * @typedef {object} ToolDef
   * @property {string} description  human-readable, shown to the agent
   * @property {object} inputSchema  JSON Schema for the `arguments` object
   * @property {boolean} [write]     mutates the page — refused unless act mode is on
   * @property {(args: object, ctx: ToolContext) => Promise<CallToolResult>} call
   */

  const okText = (t) => ({ content: [{ type: "text", text: t }] });
  const errText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

  // The vendored a11y engine + the walker, injected into the tab's isolated world. Idempotent: the
  // walker keeps any existing per-frame registry and re-defines its globals, so injecting on every
  // snapshot/ref-resolving call is safe and self-heals after a page reload.
  const WALKER_FILES = ["vendor/dom-accessibility-api.iife.js", "page/a11y-walker.js"];

  // One snapshot generation per snapshot call, shared across all frames of the page so a ref's
  // snapshotId is comparable regardless of which frame it lives in. Seeded from the clock so a
  // service-worker restart (which resets module state) cannot re-issue an earlier generation number
  // and let a stale ref alias a fresh snapshot (Orca F2b).
  let snapshotSeq = Date.now();

  async function injectWalker(chrome, target) {
    await chrome.scripting.executeScript({ target, files: WALKER_FILES });
  }

  // A ref is `eN` in the top frame or `f<frameId>:eN` in a child frame (ADR §3.1). Parse it back to
  // the owning frame + the bare in-frame ref.
  function parseRef(ref) {
    const m = /^f(\d+):(.+)$/.exec(ref || "");
    return m ? { frameId: Number(m[1]), bare: m[2] } : { frameId: 0, bare: ref };
  }

  // Merge per-frame snapshot results into one tree. The top frame (frameId 0) is the trunk; each
  // other frame is appended as a labeled section with its refs namespaced `f<frameId>:eN`, so the
  // agent can address and act on elements inside (incl. cross-origin) iframes.
  function mergeFrames(results, id) {
    const frames = (results || []).filter((r) => r && r.result && r.result.ok);
    const top = frames.find((r) => r.frameId === 0) || frames[0];
    const t = top ? top.result : { title: "", url: "", tree: "(no content)", truncated: false };
    let out = `# snapshot ${id}${t.truncated ? " (truncated)" : ""} — ${t.title}\n# ${t.url}\n${t.tree}`;
    for (const r of frames) {
      if (r === top) continue;
      const tree = r.result.tree;
      if (!tree || tree.startsWith("(no ")) continue;
      const prefixed = tree.replace(/\[ref=e/g, `[ref=f${r.frameId}:e`);
      out += `\n\n--- frame f${r.frameId} (${r.result.url}) ---\n${prefixed}`;
    }
    return out;
  }

  // Snapshot every frame under one shared snapshotId. `after` runs the settle-then-snapshot form
  // (post-action). Returns the merged, ref-namespaced text.
  async function fullSnapshot(chrome, tabId, after) {
    const id = ++snapshotSeq;
    await injectWalker(chrome, { tabId, allFrames: true });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (sid, aft) => (aft ? window.__katashiroSnapshotAfter(sid) : window.__katashiroSnapshot(sid)),
      args: [id, !!after]
    });
    return mergeFrames(results, id);
  }

  // The post-action view returned by click/type/navigate, so the agent never needs a follow-up
  // snapshot/screenshot (ADR §3.3). If the action triggered a navigation, the in-page snapshot can
  // throw (frame torn down mid-flight); catch it, wait for load, and snapshot the new page
  // (Mira/Falcon nav-during-click race).
  async function snapshotAfter(chrome, tabId) {
    try {
      return await fullSnapshot(chrome, tabId, true);
    } catch {
      await waitForComplete(chrome, tabId);
      try { return await fullSnapshot(chrome, tabId, false); }
      catch { return "(post-action snapshot unavailable — the page may still be loading; call snapshot)"; }
    }
  }

  // Resolve once the tab finishes loading (for navigate's post-action snapshot). Falls through
  // immediately where chrome.tabs.onUpdated is absent (e.g. tests).
  function waitForComplete(chrome, tabId, timeoutMs = 8000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { chrome.tabs.onUpdated.removeListener(onUpd); } catch { /* absent */ }
        resolve();
      };
      const onUpd = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
      try { chrome.tabs.onUpdated.addListener(onUpd); } catch { return finish(); }
      setTimeout(finish, timeoutMs);
    });
  }

  // Written for the agent to act on: it says what was refused, that only the human can lift
  // it, and where — so the model asks instead of retrying the same call.
  const ACT_MODE_OFF =
    "act mode is off — katashiro is read-only right now, so page writes (click / type / " +
    "navigate) are refused. Reading (read_dom, screenshot) still works. Only the user can " +
    "change this, in the katashiro side panel under Settings → 瀏覽器寫入. Ask them to turn " +
    "it on rather than retrying.";

  /**
   * The single source of truth for the tools we serve: schema and implementation live in
   * the same entry, so `tools/list` and `tools/call` cannot drift apart — no advertising a
   * tool nobody implements, no implementing one nobody can discover. Adding an entry here
   * is the whole of adding a tool.
   *
   * DOM-semantic and model-agnostic: the names describe page actions, not any particular
   * agent's vocabulary. Prefixed `katashiro.` so they never collide with a co-installed
   * Playwright MCP's `browser_*` tools.
   *
   * `write: true` marks a tool that changes the page. Those are refused unless the user has
   * turned act mode on (`deps.actMode`) — the extension inherits the user's logged-in session,
   * so an ungated click or type carries their full authority on whatever site is open. The
   * flag lives in the registry for the same reason the schema does: one entry per tool, so a
   * write cannot be added without declaring itself one.
   *
   * @type {Record<string, ToolDef>}
   */
  const TOOLS = {
    "katashiro.click": {
      description:
        "Click an element in the active tab. Prefer `ref` from the most recent snapshot (pass its " +
        "`snapshotId` too); `selector` is a fallback. Returns the updated snapshot — do not " +
        "screenshot afterward.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "element ref from a snapshot, e.g. e5" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector fallback" }
        }
      },
      /** @param {{ ref?: string, snapshotId?: number, selector?: string }} args */
      async call(args, ctx) {
        if (!args.ref && !args.selector) return errText("click needs a ref (preferred) or a selector");
        if (args.ref && args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-clicked");
        const { frameId, bare } = parseRef(args.ref);
        const target = { tabId: ctx.tab.id, frameIds: [frameId] };
        await injectWalker(ctx.chrome, target);
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target,
          func: (ref, snapshotId, sel) => {
            let el, how;
            if (ref) {
              const r = window.__katashiroResolve(ref, snapshotId);
              if (!r.ok) return { ok: false, error: r.error };
              el = r.el; how = "ref " + ref;
            } else {
              el = document.querySelector(sel);
              if (!el) return { ok: false, error: "no element for selector: " + sel };
              how = "selector " + sel;
            }
            // Actionability subset (P0): visible + enabled (ADR §3.4).
            const vis = typeof el.checkVisibility === "function"
              ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              : el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            if (!vis) return { ok: false, error: how + " is not visible" };
            if (el.disabled || el.getAttribute("aria-disabled") === "true") return { ok: false, error: how + " is disabled" };
            el.scrollIntoView({ block: "center" });
            el.click();
            return { ok: true, how };
          },
          args: [args.ref ? bare : null, args.snapshotId ?? null, args.selector || null]
        });
        if (!result.ok) return errText(result.error);
        return okText(`clicked ${args.ref ? "ref " + args.ref : result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.read_dom": {
      description:
        "Return the raw HTML of an element (default: whole body) in the active tab. For perceiving " +
        "the page or finding what to act on, use `snapshot` instead — far cheaper and it gives refs. " +
        "Use read_dom only when you need the literal markup of a specific element.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "optional CSS selector to scope the snapshot" }
        }
      },
      /** @param {{ selector?: string }} args */
      async call(args, ctx) {
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target: { tabId: ctx.tab.id },
          func: (sel) => {
            const el = sel ? document.querySelector(sel) : document.body;
            if (!el) return { ok: false, error: "no element for selector: " + sel };
            return { ok: true, html: el.outerHTML.slice(0, 100000) };
          },
          args: [args.selector || null]
        });
        return result.ok ? okText(result.html) : errText(result.error);
      }
    },

    "katashiro.navigate": {
      description: "Navigate the active browser tab to a URL.",
      write: true,
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "absolute URL" } },
        required: ["url"]
      },
      /** @param {{ url: string }} args */
      async call(args, ctx) {
        await ctx.chrome.tabs.update(ctx.tab.id, { url: args.url });
        await waitForComplete(ctx.chrome, ctx.tab.id);
        return okText(`navigated to ${args.url}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.type": {
      description:
        "Type text into an element in the active tab. Prefer `ref` from the most recent snapshot; " +
        "`selector` is a fallback. Returns the updated snapshot.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "element ref from a snapshot, e.g. e5" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector fallback" },
          text: { type: "string" }
        },
        required: ["text"]
      },
      /** @param {{ ref?: string, snapshotId?: number, selector?: string, text: string }} args */
      async call(args, ctx) {
        if (!args.ref && !args.selector) return errText("type needs a ref (preferred) or a selector");
        if (args.ref && args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-typed");
        const { frameId, bare } = parseRef(args.ref);
        const target = { tabId: ctx.tab.id, frameIds: [frameId] };
        await injectWalker(ctx.chrome, target);
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target,
          func: (ref, snapshotId, sel, text) => {
            let el, how;
            if (ref) {
              const r = window.__katashiroResolve(ref, snapshotId);
              if (!r.ok) return { ok: false, error: r.error };
              el = r.el; how = "ref " + ref;
            } else {
              el = document.querySelector(sel);
              if (!el) return { ok: false, error: "no element for selector: " + sel };
              how = "selector " + sel;
            }
            // Actionability subset (P0), aligned with click: visible + enabled (Falcon).
            const vis = typeof el.checkVisibility === "function"
              ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              : el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            if (!vis) return { ok: false, error: how + " is not visible" };
            if (el.disabled || el.getAttribute("aria-disabled") === "true") return { ok: false, error: how + " is disabled" };
            el.focus();
            // React 18+ controlled inputs ignore a plain `el.value = …`; drive the native prototype
            // setter so React's onChange sees it (ADR §3.2). contenteditable / others fall back.
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                        : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
            const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
            if (desc && desc.set) desc.set.call(el, text);
            else if (el.isContentEditable) el.textContent = text;
            else if ("value" in el) el.value = text;
            else el.textContent = text;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, how };
          },
          args: [args.ref ? bare : null, args.snapshotId ?? null, args.selector || null, args.text]
        });
        if (!result.ok) return errText(result.error);
        return okText(`typed into ${args.ref ? "ref " + args.ref : result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.screenshot": {
      description:
        "Capture a screenshot (image) of the active tab. EXPENSIVE and slow to reason over — use " +
        "only when a text `snapshot` cannot answer: visual layout, images/charts/canvas. Never to " +
        "read text or to confirm an action succeeded (action tools already return the new snapshot).",
      inputSchema: { type: "object", properties: {} },
      /** @param {object} _args (none) */
      async call(_args, ctx) {
        // JPEG, not PNG: a full-page PNG base64 runs several MB and blows past the ACP tunnel's
        // per-frame size cap, dropping the WebSocket ("connection closed before response").
        // JPEG q70 keeps a typical screen well under ~500KB while staying readable for the agent.
        const dataUrl = await ctx.chrome.tabs.captureVisibleTab(ctx.tab.windowId, {
          format: "jpeg",
          quality: 70
        });
        const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        return { content: [{ type: "image", data: base64, mimeType: "image/jpeg" }] };
      }
    },

    "katashiro.snapshot": {
      description:
        "PRIMARY way to see the page: an accessibility-tree snapshot of the active tab as compact " +
        "text, with a stable `ref` on each interactive element. Prefer this over screenshot for " +
        "reading and for finding what to act on — it is far cheaper and gives refs. Returns a " +
        "snapshotId; pass a ref (and the snapshotId) to click/type. Screenshot only when a text " +
        "snapshot cannot answer (visual layout, images/canvas).",
      inputSchema: { type: "object", properties: {} },
      /** @param {object} _args (none) */
      async call(_args, ctx) {
        return okText(await fullSnapshot(ctx.chrome, ctx.tab.id, false));
      }
    },

    "katashiro.wait_for": {
      description:
        "Wait until a condition holds in the active tab's top frame, then return the fresh snapshot. " +
        "Give one of `selector` (element present) or `text` (text appears). Never sleeps a fixed time. " +
        "Use after an action that loads content before acting on it.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "wait until this CSS selector matches" },
          text: { type: "string", description: "wait until this text appears on the page" },
          timeout: { type: "number", description: "ms, default 5000" }
        }
      },
      /** @param {{ selector?: string, text?: string, timeout?: number }} args */
      async call(args, ctx) {
        if (!args.selector && !args.text) return errText("wait_for needs a selector or text");
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target: { tabId: ctx.tab.id },
          func: async (sel, text, timeout) => {
            const deadline = Date.now() + (timeout || 5000);
            const hit = () => (sel ? !!document.querySelector(sel)
                                   : (document.body && document.body.innerText.includes(text)));
            while (Date.now() < deadline) {
              if (hit()) return { ok: true };
              await new Promise((r) => setTimeout(r, 100)); // poll in-page, not a fixed sleep
            }
            return { ok: false, error: "timed out waiting for " + (sel ? "selector " + sel : "text " + JSON.stringify(text)) };
          },
          args: [args.selector || null, args.text || null, args.timeout ?? null]
        });
        if (!result.ok) return errText(result.error);
        return okText(await snapshotAfter(ctx.chrome, ctx.tab.id));
      }
    }
  };

  // The wire form of the registry — exactly what `tools/list` returns. Derived from TOOLS,
  // never hand-maintained, so the advertised set is the implemented set by construction.
  const BROWSER_TOOLS = Object.freeze(
    Object.entries(TOOLS).map(([name, t]) =>
      Object.freeze({ name, description: t.description, inputSchema: t.inputSchema })
    )
  );

  // The currently active tab (the shikigami acts here).
  async function activeTab(chrome) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error("no active browser tab");
    return tab;
  }

  // Execute a tool in the active tab via chrome.scripting/tabs. Returns an MCP
  // CallToolResult ({ content, isError? }). DOM actions run injected in the page context.
  // `deps.chrome` is the injected chrome API (real in the extension, mocked in tests).
  // `deps.actMode` is the user's write consent, read fresh per call so a toggle takes effect
  // immediately. `tools` is the serving instance's registry — defaults to the browser one.
  async function callBrowserTool(name, args, deps, tools) {
    const registry = tools || TOOLS;
    const chrome = deps.chrome;
    const tool = registry[name];
    if (!tool) {
      const err = new Error(`unknown tool: ${name}`);
      err.code = -32602;
      throw err;
    }
    // Consent before environment: a refused write should say it was refused, not report
    // whatever tab trouble it would have hit had it been allowed to run.
    if (tool.write && !deps.actMode) return errText(ACT_MODE_OFF);
    // Then the tab — every surviving tool needs it, and resolving it up front keeps the
    // "no active browser tab" diagnosis ahead of any per-tool failure.
    const tab = await activeTab(chrome);
    return tool.call(args, { chrome, tab });
  }

  /**
   * One client-side MCP server instance.
   *
   * The module is instantiable so a second client-side server can sit alongside `katashiro`
   * in the same ACP session: the gateway `mcp/connect`s once per declared server and then
   * addresses each by its own `connectionId`, so each needs its own name and registry.
   *
   * @param {object}  opts
   * @param {string}  opts.id          the declared `id` — minted per connection by the caller
   * @param {string}  opts.name        the declared `name` — stable, and what the operator allowlists
   * @param {Record<string, ToolDef>} [opts.tools]  this instance's registry (default: the browser tools)
   * @param {string}  [opts.serverName]  MCP `serverInfo.name` (default: the declared name)
   * @param {string}  [opts.version]     MCP `serverInfo.version`
   */
  function createServer(opts) {
    const tools = opts.tools || TOOLS;
    const serverName = opts.serverName || opts.name;
    const version = opts.version || "1.0.0";
    // Derived once per instance, same rule as the module-level BROWSER_TOOLS.
    const listing = Object.freeze(
      Object.entries(tools).map(([name, t]) =>
        Object.freeze({ name, description: t.description, inputSchema: t.inputSchema })
      )
    );

    return {
      id: opts.id,
      name: opts.name,
      tools,

      /** The `session/new` entry that declares this server to the gateway. */
      declaration() {
        return { type: "acp", id: this.id, name: this.name };
      },

      // The MCP server surface this instance exposes over the tunnel (we are the MCP server,
      // the agent is the client). Returns the inner MCP result; `undefined` for notifications.
      async handleMcpMessage(method, params, deps) {
        switch (method) {
          case "initialize":
            return {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: serverName, version }
            };
          case "notifications/initialized":
            return undefined; // notification — no response
          case "tools/list":
            // The write tools stay listed even with act mode off. OpenAB fetches discovery
            // once per connection and caches it, so hiding them would freeze whatever the
            // toggle happened to be at connect time and leave the agent unable to learn the
            // capability exists. Refusing at call time is the honest place to enforce it.
            return { tools: listing };
          case "tools/call":
            // Tool-execution failures (no active tab, restricted page like chrome://, missing
            // host permission, injected-script error) become MCP isError results — not protocol
            // errors — so the agent sees the failure and can adapt.
            try {
              return await callBrowserTool(params.name, params.arguments || {}, deps, tools);
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
    };
  }

  // The browser server every katashiro side panel serves. `id` is assigned by the caller when
  // it declares us (see sidepanel.js); until then routing falls back to this instance, which
  // is what makes the single-server case need no wiring at all.
  const defaultServer = createServer({
    id: null,
    name: "katashiro",
    serverName: "katashiro-browser"
  });

  // Module-level convenience for the single-server case: serve as the default instance.
  async function handleMcpMessage(method, params, deps) {
    return defaultServer.handleMcpMessage(method, params, deps);
  }

  // Which instance a frame belongs to. The gateway addresses a declared server by `acpId` on
  // `mcp/connect` only; every later frame carries the `connectionId` we handed back, so the
  // connect step is where the mapping is established.
  //
  // `acpId` may fall back: a side panel declaring only the browser server needs no
  // `state.servers` wiring at all. `connectionId` may NOT — a handle we never minted names no
  // server, and quietly serving it the browser tools would hand browser control to a caller
  // that was never granted a tunnel. Unknown connections are refused, not guessed at.
  function serverForAcpId(state, acpId) {
    const declared = state.servers || [];
    return declared.find((s) => s.id === acpId) || declared[0] || defaultServer;
  }

  function serverForConnection(state, connectionId) {
    return state.connections ? state.connections[connectionId] : undefined;
  }

  // Handle a server-initiated request from the gateway (tunnel control + MCP-over-ACP).
  // `deps` = { chrome, crypto, send, onStatus? }; `send(obj)` writes a JSON-RPC frame to the
  // socket; optional `onStatus(attached: bool)` fires on the first tunnel opening and the last
  // one closing, so the UI can surface whether the agent can currently reach this browser.
  // `state` is owned by the caller (e.g. to reset on reconnect) and carries:
  //   `servers`        — optional declared instances; absent means "just the browser server"
  //   `connections`    — connectionId → instance, built here
  //   `mcpConnectionId`— the most recent connection, kept for the single-server UI path
  async function handleServerRequest(msg, deps, state) {
    const send = deps.send;
    if (!state.connections) state.connections = {};
    const openCount = () => Object.keys(state.connections).length;

    switch (msg.method) {
      case "mcp/connect": {
        // The gateway opens one tunnel per declared server, naming it by the `acpId` we
        // declared; we mint the connection handle it will address us by from here on.
        const server = serverForAcpId(state, msg.params && msg.params.acpId);
        const connectionId = deps.crypto.randomUUID();
        const wasIdle = openCount() === 0;
        state.connections[connectionId] = server;
        state.mcpConnectionId = connectionId;
        send({ jsonrpc: "2.0", id: msg.id, result: { connectionId } });
        // Only the transition into "attached" is a UI event; a second server opening its own
        // tunnel does not re-announce a browser the user already knows is reachable.
        if (wasIdle && deps.onStatus) deps.onStatus(true);
        return;
      }
      case "mcp/message": {
        // Inner MCP is flattened into params (method/params); the outer ACP id correlates.
        // `connectionId` selects which of our servers is being addressed.
        const inner = msg.params || {};
        const server = serverForConnection(state, inner.connectionId);
        if (!server) {
          send({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32602, message: `unknown connection: ${inner.connectionId}` }
          });
          return;
        }
        try {
          const result = await server.handleMcpMessage(inner.method, inner.params || {}, deps);
          // A notification (undefined result) gets no response frame.
          if (result !== undefined) send({ jsonrpc: "2.0", id: msg.id, result });
        } catch (e) {
          send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code || -32603, message: e.message || String(e) } });
        }
        return;
      }
      case "mcp/disconnect": {
        const connectionId = msg.params && msg.params.connectionId;
        if (connectionId && !state.connections[connectionId]) {
          // A handle we never minted. Ack it, but touch nothing: closing "some connection we
          // don't know about" must never take this session's live tunnels down with it.
          send({ jsonrpc: "2.0", id: msg.id, result: {} });
          return;
        }
        if (connectionId) delete state.connections[connectionId];
        else state.connections = {}; // no id given: the whole tunnel set is gone
        if (state.mcpConnectionId === connectionId || openCount() === 0) {
          state.mcpConnectionId = null;
        }
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
        // Detached only once the LAST tunnel closes — one agent hanging up does not mean the
        // browser stopped being reachable for the others.
        if (openCount() === 0 && deps.onStatus) deps.onStatus(false);
        return;
      }
      default:
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }

  return { TOOLS, BROWSER_TOOLS, createServer, callBrowserTool, handleMcpMessage, handleServerRequest };
});
