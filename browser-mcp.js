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
   * @property {boolean} [sessionScope]  acts on the browser (tabs/windows), not the active page's
   *   DOM — so it skips the active-tab resolution + origin pre-flight and resolves its own targets.
   *   Its ctx has no `tab`.
   * @property {(args: object) => object} redact  masks the arguments for the UI activity
   *   signal (pill tooltip / expander). Required on every built-in tool (enforced by a test);
   *   a tool without one has its arguments withheld from the UI entirely.
   * @property {(args: object) => Array<*>} [secrets]  argument values that must not appear in
   *   the UI's result summary/preview even as short bare tokens (passwords, typed text, URL
   *   queries). Hidden-by-masking values are scrubbed regardless; this adds the sensitive ones.
   * @property {(args: object, ctx: ToolContext) => Promise<CallToolResult>} call
   */

  const okText = (t) => ({ content: [{ type: "text", text: t }] });
  const errText = (t) => ({ content: [{ type: "text", text: t }], isError: true });

  // K2: append the active-tab context as a SEPARATE trailing content block, so the agent always
  // knows which page it's on and rarely needs a `tabs` call just to orient (24 orientation calls
  // observed in one session). Added as its own block, not merged into content[0], so a raw read
  // (read_dom / get_text) stays byte-for-byte what the agent asked for. Errors and image-only /
  // non-text results pass through untouched.
  function withTabContext(result, tab) {
    if (!result || result.isError || !Array.isArray(result.content)) return result;
    const first = result.content.find((c) => c && c.type === "text");
    if (!first || typeof first.text !== "string") return result;
    // Skip any result that already carries a snapshot (the pure `snapshot`, and click/type/navigate
    // which return `…\n\n# snapshot N — <title>`): the snapshot header already shows the CURRENT
    // title/url. Appending a tab line there would (a) duplicate it — ironic for a token-saving change
    // (Orca nit), and (b) LIE after a navigation, since `tab` is resolved pre-dispatch and would show
    // the OLD page while the snapshot shows the new one (Falcon stale-tab, review 2026-08-07). K2's
    // value is on the raw reads (read_dom / get_text / tabs), which carry no snapshot header.
    // Match on the `# snapshot <n>` prefix only — the header also has a ` (truncated)` variant
    // before the ` — ` (browser-mcp.js header build), and truncated snapshots are exactly the big,
    // token-expensive, most-likely-stale-after-nav case that must NOT slip past this skip (Orca).
    if (/(^|\n)# snapshot \d+/.test(first.text)) return result;
    const title = (tab && tab.title) ? String(tab.title).trim() : "";
    const url = (tab && tab.url) || "(unknown)";
    return {
      ...result,
      content: [...result.content, { type: "text", text: `— tab: ${title ? title + " — " : ""}${url}` }]
    };
  }

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
  async function fullSnapshot(chrome, tabId, after, rootSelector) {
    const id = ++snapshotSeq;
    await injectWalker(chrome, { tabId, allFrames: true });
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (sid, aft, sel) => (aft ? window.__katashiroSnapshotAfter(sid) : window.__katashiroSnapshot(sid, sel)),
      args: [id, !!after, rootSelector || null]
    });
    if (rootSelector) {
      // K3: a scoped snapshot that matches NO frame used to return an empty-but-ok tree — the agent
      // couldn't tell a typo'd/invalid selector from a genuinely empty region. Surface it explicitly
      // (review: Orca), so a bad selector earns a clear retry instead of a silent blank.
      const frames = results.map((r) => r && r.result).filter(Boolean);
      if (!frames.some((f) => f.ok && f.matched)) {
        const err = frames.map((f) => f && f.selectorError).find(Boolean);
        return err
          ? `(invalid selector ${JSON.stringify(rootSelector)}: ${err}. Call snapshot without a selector to see the whole page.)`
          : `(selector ${JSON.stringify(rootSelector)} matched no element on this page. Check it, or call snapshot without a selector to see the whole page.)`;
      }
    }
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

  // Supported-scheme check. katashiro declares <all_urls> host permissions and leaves enforcement
  // to Chrome: a page whose site access the user withheld simply fails the scripting call. We only
  // pre-reject pages with no scriptable web origin (chrome://, about:, the Web Store, file://, PDF
  // viewer) here, so those return a clear message instead of a raw Chrome error.
  function pageOrigin(url) {
    try {
      const u = new URL(url || "");
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.origin;
    } catch {
      return null;
    }
  }
  const ORIGIN_UNSUPPORTED =
    "this page has no grantable web origin (it's a chrome://, about:, Web Store, PDF, or file:// " +
    "page), so katashiro can neither read nor act on it. Ask the user to switch to a normal " +
    "http(s) web page.";

  // highlight: the caption is short by design (it labels, it does not explain), and the overlay
  // always expires so a forgotten highlight cannot linger over the user's page.
  const HIGHLIGHT_LABEL_MAX = 80;
  const HIGHLIGHT_DEFAULT_MS = 4000;
  const HIGHLIGHT_MAX_MS = 15000;
  const SELECTION_MAX = 20000;
  const FILL_FORM_MAX = 50;

  // upload_file: decoded bytes across all files. The payload already crossed the ACP tunnel as
  // base64 in the tool arguments, so this mostly keeps one call from wedging the page.
  const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

  // inject_css: anything that makes the stylesheet fetch is refused — `url()` / `image-set()` /
  // `@import` / `src()` can leak page state to a remote server through attribute selectors (CSS
  // exfiltration). Backslashes are refused outright because CSS escapes (`u\72l(`) would slip a
  // fetching function past a plain-text check.
  const CSS_MAX = 20000;
  const CSS_FORBIDDEN = /url\s*\(|src\s*\(|image\s*\(|image-set\s*\(|cross-fade\s*\(|element\s*\(|@import|@font-face|@namespace|\\/i;

  // Stylesheets inject_css has applied, per tab, so `clear` can remove exactly those. A sheet
  // does not survive a navigation anyway; removing an already-gone one is a harmless no-op.
  const injectedCss = new Map();

  // --- Tool-call details for the UI (pill tooltip + expander) -------------------------------
  //
  // The side panel shows what each tool call did. Arguments can carry secrets (a password in
  // fill_form, a whole file in upload_file), so every registry entry declares a `redact(args)`
  // hook next to its definition and ONLY the hook's output leaves this module — the UI never
  // receives raw arguments. A tool without a hook (e.g. a custom registry passed to
  // createServer) fails closed: its arguments are withheld entirely (see maskArgs).
  const DETAIL_STR_MAX = 80;     // per-string cap inside masked arguments
  const SUMMARY_MAX = 120;       // one-line result summary (tooltip)
  const PREVIEW_MAX = 300;       // result excerpt (expander)
  const DETAIL_ARRAY_MAX = 20;   // items kept per array in masked arguments
  const DETAIL_DEPTH_MAX = 4;
  const REDACTED = "‹redacted›";

  function clip(s, max) {
    const str = String(s);
    return str.length > max ? `${str.slice(0, max)}… (+${str.length - max} chars)` : str;
  }

  // Deep copy with every string clipped, arrays capped and nesting bounded — the shared
  // default for tools whose arguments are not sensitive, only potentially long.
  function truncateStrings(v, depth = 0) {
    if (typeof v === "string") return clip(v, DETAIL_STR_MAX);
    if (v == null || typeof v === "number" || typeof v === "boolean") return v;
    if (depth >= DETAIL_DEPTH_MAX) return "…";
    if (Array.isArray(v)) {
      const out = v.slice(0, DETAIL_ARRAY_MAX).map((x) => truncateStrings(x, depth + 1));
      if (v.length > DETAIL_ARRAY_MAX) out.push(`… (+${v.length - DETAIL_ARRAY_MAX} more)`);
      return out;
    }
    if (typeof v === "object") {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = truncateStrings(x, depth + 1);
      return out;
    }
    return undefined; // functions, symbols, bigint: not data
  }

  const redactDefault = (args) => truncateStrings(args || {});

  // fill_form: which fields, never what went into them (values and checked states alike).
  function redactFillForm(args) {
    const a = args || {};
    const fields = Array.isArray(a.fields) ? a.fields : [];
    return truncateStrings({
      snapshotId: a.snapshotId,
      fields: fields.map((f) => {
        const o = {};
        if (f && f.ref != null) o.ref = f.ref;
        if (f && f.selector != null) o.selector = f.selector;
        if (f && (f.value != null || f.checked != null)) o.value = REDACTED;
        return o;
      })
    });
  }

  // upload_file: file name, MIME type and size — never the content (text or base64).
  function redactUploadFile(args) {
    const a = args || {};
    const files = Array.isArray(a.files) ? a.files : [];
    const out = {};
    if (a.ref != null) out.ref = a.ref;
    if (a.snapshotId != null) out.snapshotId = a.snapshotId;
    if (a.selector != null) out.selector = a.selector;
    out.files = files.map((f) => {
      const o = { name: f && f.name, mimeType: (f && f.mimeType) || "application/octet-stream" };
      if (f && typeof f.base64 === "string") {
        const b = f.base64.replace(/\s+/g, "");
        o.size = Math.max(0, Math.floor((b.length * 3) / 4) - (b.endsWith("==") ? 2 : b.endsWith("=") ? 1 : 0));
      } else if (f && typeof f.text === "string") {
        o.size = new TextEncoder().encode(f.text).length;
      }
      return o;
    });
    return truncateStrings(out);
  }

  // The single gate between raw arguments and the UI. Missing or throwing hook ⇒ nothing.
  function maskArgs(tool, args) {
    if (!tool || typeof tool.redact !== "function") return null;
    try {
      // Re-clip whatever the hook returns, so a hook that forgets a long string stays bounded.
      return truncateStrings(tool.redact(args || {}));
    } catch (_) {
      return null;
    }
  }

  // String and number leaves of a value, stringified, depth-bounded. Booleans are left out: a
  // checked state is one bit, and scrubbing "true"/"false" would hide nothing but shred text.
  function scalarLeaves(v, out = [], depth = 0) {
    if (depth > 8 || v == null) return out;
    if (typeof v === "string" || typeof v === "number") out.push(String(v));
    else if (typeof v === "object") for (const x of Object.values(v)) scalarLeaves(x, out, depth + 1);
    return out;
  }

  // What the result path must not show. A tool's result or error text may echo an argument back
  // (navigate: `navigated to <url>`), so these are scrubbed from the summary/preview too — the
  // result path must not undo the arguments path. Two sources:
  //  - every raw scalar the masked args do not show *as an exact leaf value* (clipped, redacted,
  //    or cut by the depth cap). Exact, not substring: a value "pin" next to selector "#pin" is
  //    still hidden.
  //  - the tool's own `secrets(args)` declaration (fill_form values, typed text, URL queries…):
  //    these are scrubbed even as bare short tokens.
  // No redact hook / masked args withheld ⇒ every raw scalar is hidden.
  function secretsFor(tool, raw, masked) {
    const out = new Map();                                 // value → sensitive (bare at any length)
    const add = (s, sensitive) => { if (s) out.set(s, out.get(s) || sensitive); };
    const shown = new Set(masked == null ? [] : scalarLeaves(masked));
    for (const s of scalarLeaves(raw)) if (!shown.has(s)) add(s, false);
    if (masked != null && tool && typeof tool.secrets === "function") {
      try {
        for (const v of tool.secrets(raw || {}) || []) if (v != null) add(String(v), true);
      } catch (_) {
        for (const s of scalarLeaves(raw)) add(s, true);   // fail closed
      }
    }
    // Longest first: a secret that contains another must be replaced whole, not left as the
    // remainder around its already-redacted substring ("brett" inside "brett-pw!").
    return [...out].map(([s, sensitive]) => ({ s, sensitive })).sort((a, b) => b.s.length - a.s.length);
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  function scrub(text, secrets) {
    let t = String(text);
    for (const { s, sensitive } of secrets) {
      // Quoted form at any length (JSON.stringify echoes). Bare form: plain substring when long
      // enough not to shred unrelated words; a short declared secret (a 2–3 digit PIN) only as a
      // whole token, so "42" goes but "1425" / "e42" stay.
      t = t.split(JSON.stringify(s)).join(REDACTED);
      if (s.length >= 4) t = t.split(s).join(REDACTED);
      else if (sensitive) t = t.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(s)}(?![\\p{L}\\p{N}])`, "gu"), REDACTED);
    }
    return t;
  }

  // type / type_text: the text may be a password (the hook cannot see the target field's type,
  // and a clip at 80 chars hides no password), so only its length is shown.
  function redactTypedText(args) {
    const a = { ...(args || {}) };
    if (a.text != null) a.text = `‹${String(a.text).length} chars›`;
    return truncateStrings(a);
  }
  const secretTypedText = (args) => [args && args.text];

  // navigate / new_tab: scheme + host + path only — query and fragment often carry tokens.
  function stripUrlQuery(url) {
    const s = String(url);
    const i = s.search(/[?#]/);
    return i < 0 ? s : `${s.slice(0, i)}${s[i]}‹redacted›`;
  }
  function redactUrl(args) {
    const a = { ...(args || {}) };
    if (a.url != null) a.url = stripUrlQuery(a.url);
    return truncateStrings(a);
  }
  function secretUrl(args) {
    const s = String((args && args.url) || "");
    const i = s.search(/[?#]/);
    return i < 0 ? [] : [s.slice(i + 1)];
  }

  // One-line summary + bounded excerpt of a CallToolResult, for the UI.
  function describeResult(result, secrets) {
    const content = (result && Array.isArray(result.content)) ? result.content : [];
    const textBlock = content.find((b) => b && b.type === "text" && typeof b.text === "string");
    if (textBlock) {
      const text = scrub(textBlock.text, secrets);
      const line = (text.split("\n").find((l) => l.trim()) || "").trim();
      return { summary: clip(line, SUMMARY_MAX), preview: clip(text, PREVIEW_MAX) };
    }
    const img = content.find((b) => b && b.type === "image");
    if (img) {
      const kb = Math.round(((String(img.data || "").length * 3) / 4) / 1024);
      const s = `${img.mimeType || "image"} (${kb} KB)`;
      return { summary: s, preview: s };
    }
    return { summary: "", preview: "" };
  }

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
        "`snapshotId` too); `selector` is a fallback. Set `button: 'right'` to open the page's own " +
        "context menu, or `doubleClick: true` for a double-click (synthetic events — they fire page " +
        "handlers, not the browser's native menu). Returns the updated snapshot — this return is " +
        "current, so do not call `snapshot` or screenshot again right after.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "element ref from a snapshot, e.g. e5" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector fallback" },
          button: { type: "string", enum: ["left", "right"], description: "mouse button (default left); right fires contextmenu" },
          doubleClick: { type: "boolean", description: "double-click instead of a single click (left button only)" }
        }
      },
      redact: redactDefault,
      /** @param {{ ref?: string, snapshotId?: number, selector?: string, button?: string, doubleClick?: boolean }} args */
      async call(args, ctx) {
        if (!args.ref && !args.selector) return errText("click needs a ref (preferred) or a selector");
        if (args.ref && args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-clicked");
        const button = args.button || "left";
        if (button !== "left" && button !== "right") return errText("click `button` must be 'left' or 'right'");
        if (button === "right" && args.doubleClick) return errText("doubleClick is left-button only — drop `button: 'right'` or `doubleClick`");
        const mode = button === "right" ? "right" : args.doubleClick ? "double" : "single";
        const { frameId, bare } = parseRef(args.ref);
        const target = { tabId: ctx.tab.id, frameIds: [frameId] };
        await injectWalker(ctx.chrome, target);
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target,
          func: (ref, snapshotId, sel, mode) => {
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
            if (mode === "single") {
              el.click();
              return { ok: true, how };
            }
            // Synthetic sequences carry real coordinates (element centre) because menu / editor
            // handlers commonly position themselves off clientX/clientY.
            const box = el.getBoundingClientRect();
            const at = { bubbles: true, cancelable: true, view: window, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
            if (mode === "right") {
              const r = { ...at, button: 2, buttons: 2 };
              el.dispatchEvent(new PointerEvent("pointerdown", r));
              el.dispatchEvent(new MouseEvent("mousedown", r));
              el.dispatchEvent(new PointerEvent("pointerup", { ...r, buttons: 0 }));
              el.dispatchEvent(new MouseEvent("mouseup", { ...r, buttons: 0 }));
              el.dispatchEvent(new MouseEvent("contextmenu", r));
              return { ok: true, how };
            }
            // double: two full clicks (detail 1, 2) then dblclick, as a real double-click emits.
            for (const detail of [1, 2]) {
              el.dispatchEvent(new MouseEvent("mousedown", { ...at, detail }));
              el.dispatchEvent(new MouseEvent("mouseup", { ...at, detail }));
              el.dispatchEvent(new MouseEvent("click", { ...at, detail }));
            }
            el.dispatchEvent(new MouseEvent("dblclick", { ...at, detail: 2 }));
            return { ok: true, how };
          },
          args: [args.ref ? bare : null, args.snapshotId ?? null, args.selector || null, mode]
        });
        if (!result.ok) return errText(result.error);
        const verb = mode === "right" ? "right-clicked" : mode === "double" ? "double-clicked" : "clicked";
        return okText(`${verb} ${args.ref ? "ref " + args.ref : result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.click_text": {
      description:
        "Click the element that best matches a natural-language description — Jev disambiguates " +
        "against the current accessibility snapshot, so no ref is needed. Requires a Jev token " +
        "(Settings → Jev grounding); without one it is refused — use `click` with a ref instead. " +
        "Returns which element was chosen plus the post-action snapshot.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "what to click, in words, e.g. 'the login button' or 'the first search result'" }
        },
        required: ["description"]
      },
      redact: redactDefault,
      /** @param {{ description?: string }} args */
      async call(args, ctx) {
        const desc = ((args && args.description) || "").trim();
        if (!desc) return errText("click_text needs a `description` of the element to click");
        if (!ctx.jev || !ctx.jevToken) return errText("click_text needs a Jev token — set one in katashiro Settings (Jev grounding), or use `click` with a ref");
        // Snapshot now to get candidate refs + labels, then let Jev pick the matching one.
        const snap = await fullSnapshot(ctx.chrome, ctx.tab.id, false);
        const idMatch = snap.match(/# snapshot (\d+)/);
        const snapshotId = idMatch ? Number(idMatch[1]) : null;
        const criteria = extractRefCandidates(snap, desc);
        if (!Object.keys(criteria).length) return errText("no interactive elements with refs in the current snapshot — nothing to click");
        const answers = await ctx.jev.evaluate(
          snap,
          { pick: { type: "choice", instructions: `Which element should be clicked to: ${desc}?`, criteria } },
          { token: ctx.jevToken }
        );
        const ref = ctx.jev.choice(answers, "pick");
        if (!ref || !criteria[ref]) return errText(`Jev could not pick an element for "${desc}" (grounding unavailable or no match). Call snapshot and use click with a ref.`);
        // Reuse the click tool's actionability + post-action snapshot machinery.
        const clickRes = await TOOLS["katashiro.click"].call({ ref, snapshotId }, ctx);
        if (clickRes && clickRes.isError) return clickRes;
        return okText(`click_text "${desc}" → ${ref} (${criteria[ref]})\n\n${firstText(clickRes) || ""}`);
      }
    },

    "katashiro.type_text": {
      description:
        "Type text into the field that best matches a natural-language description — Jev disambiguates " +
        "against the current accessibility snapshot, so no ref is needed. Requires a Jev token " +
        "(Settings → Jev grounding); without one it is refused — use `type` with a ref instead. " +
        "Returns which field was chosen plus the post-action snapshot.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "which field to type into, in words, e.g. 'the search box' or 'the email field'" },
          text: { type: "string", description: "the text to type" }
        },
        required: ["description", "text"]
      },
      // UI detail: the typed text's length only — it may be a password.
      redact: redactTypedText,
      secrets: secretTypedText,
      /** @param {{ description?: string, text?: string }} args */
      async call(args, ctx) {
        const desc = ((args && args.description) || "").trim();
        if (!desc) return errText("type_text needs a `description` of the field to type into");
        if (args.text == null) return errText("type_text needs `text` to type");
        if (!ctx.jev || !ctx.jevToken) return errText("type_text needs a Jev token — set one in katashiro Settings (Jev grounding), or use `type` with a ref");
        const snap = await fullSnapshot(ctx.chrome, ctx.tab.id, false);
        const idMatch = snap.match(/# snapshot (\d+)/);
        const snapshotId = idMatch ? Number(idMatch[1]) : null;
        const criteria = extractRefCandidates(snap, desc);
        if (!Object.keys(criteria).length) return errText("no interactive elements with refs in the current snapshot — nothing to type into");
        const answers = await ctx.jev.evaluate(
          snap,
          { pick: { type: "choice", instructions: `Which element is the field to type into for: ${desc}?`, criteria } },
          { token: ctx.jevToken }
        );
        const ref = ctx.jev.choice(answers, "pick");
        if (!ref || !criteria[ref]) return errText(`Jev could not pick a field for "${desc}" (grounding unavailable or no match). Call snapshot and use type with a ref.`);
        const typeRes = await TOOLS["katashiro.type"].call({ ref, snapshotId, text: args.text }, ctx);
        if (typeRes && typeRes.isError) return typeRes;
        return okText(`type_text "${desc}" → ${ref} (${criteria[ref]})\n\n${firstText(typeRes) || ""}`);
      }
    },

    "katashiro.assert": {
      description:
        "Ask Jev a yes/no question about the CURRENT page state (e.g. 'is this a login wall?', 'did " +
        "the search results load?', 'is there a captcha?') and get back the probability the condition " +
        "holds, for the agent to branch on. Read-only — perceives, never acts. Requires a Jev token " +
        "(Settings → Jev grounding).",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "a yes/no question about the page, e.g. 'is the user logged in?'" }
        },
        required: ["question"]
      },
      redact: redactDefault,
      /** @param {{ question?: string }} args */
      async call(args, ctx) {
        const question = ((args && args.question) || "").trim();
        if (!question) return errText("assert needs a `question` about the page state");
        if (!ctx.jev || !ctx.jevToken) return errText("assert needs a Jev token — set one in katashiro Settings (Jev grounding)");
        const snap = await fullSnapshot(ctx.chrome, ctx.tab.id, false);
        const answers = await ctx.jev.evaluate(
          snap,
          { holds: { type: "noul", instructions: question } },
          { token: ctx.jevToken }
        );
        const p = ctx.jev.noul(answers, "holds");
        if (p == null) return errText(`Jev could not evaluate "${question}" (grounding unavailable).`);
        return okText(`assert "${question}" → ${p >= 0.5 ? "yes" : "no"} (${p.toFixed(2)})`);
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
      redact: redactDefault,
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
      description: "Navigate the active browser tab to a URL. Returns the updated snapshot — this return is current, do not call `snapshot` again right after.",
      write: true,
      inputSchema: {
        type: "object",
        properties: { url: { type: "string", description: "absolute URL" } },
        required: ["url"]
      },
      // UI detail: the URL without its query / fragment (tokens often ride there).
      redact: redactUrl,
      secrets: secretUrl,
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
        "`selector` is a fallback. Returns the updated snapshot — this return is current, do not call " +
        "`snapshot` again right after.",
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
      // UI detail: the typed text's length only — it may be a password.
      redact: redactTypedText,
      secrets: secretTypedText,
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
      redact: redactDefault,
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
        "snapshot cannot answer (visual layout, images/canvas). NOTE: click/type/navigate already " +
        "return the updated snapshot, so you rarely need to call this right after acting. To re-check " +
        "just one region cheaply, pass `selector` to scope the snapshot to that subtree.",
      inputSchema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "optional CSS selector to scope the snapshot to that element's subtree (cheaper than a full-page re-snapshot)" }
        }
      },
      redact: redactDefault,
      /** @param {{ selector?: string }} args */
      async call(args, ctx) {
        return okText(await fullSnapshot(ctx.chrome, ctx.tab.id, false, args && args.selector));
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
      redact: redactDefault,
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
    },

    "katashiro.get_text": {
      description:
        "Return the visible text (innerText) of an element (default: whole body) in the active tab. " +
        "Cheaper than read_dom's raw HTML when you only need the text; to find elements to act on, " +
        "prefer snapshot. Read-only.",
      inputSchema: {
        type: "object",
        properties: { selector: { type: "string", description: "optional CSS selector to scope" } }
      },
      redact: redactDefault,
      /** @param {{ selector?: string }} args */
      async call(args, ctx) {
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target: { tabId: ctx.tab.id },
          func: (sel) => {
            const el = sel ? document.querySelector(sel) : document.body;
            if (!el) return { ok: false, error: "no element for selector: " + sel };
            return { ok: true, text: (el.innerText || "").slice(0, 100000) };
          },
          args: [args.selector || null]
        });
        return result.ok ? okText(result.text) : errText(result.error);
      }
    },

    "katashiro.scroll": {
      description:
        "Scroll the active tab to reveal content (perception aid — works in read-only mode; may " +
        "trigger the page's lazy-loading). Give one of: `to` ('top'|'bottom'), `direction` " +
        "('up'|'down') with optional `amount` px (default one viewport), or a `ref`/`selector` to " +
        "bring that element into view. Returns the updated snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", enum: ["top", "bottom"], description: "scroll the page to the top or bottom" },
          direction: { type: "string", enum: ["up", "down"], description: "scroll one step up or down" },
          amount: { type: "number", description: "pixels for `direction` (default: one viewport height)" },
          ref: { type: "string", description: "element ref from a snapshot to scroll into view" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector to scroll into view (fallback)" }
        }
      },
      redact: redactDefault,
      /** @param {{ to?: string, direction?: string, amount?: number, ref?: string, snapshotId?: number, selector?: string }} args */
      async call(args, ctx) {
        if (!args.to && !args.direction && !args.ref && !args.selector) {
          return errText("scroll needs one of: to ('top'/'bottom'), direction ('up'/'down'), ref, or selector");
        }
        if (args.ref) {
          if (args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-scrolled");
          const { frameId, bare } = parseRef(args.ref);
          const target = { tabId: ctx.tab.id, frameIds: [frameId] };
          await injectWalker(ctx.chrome, target);
          const [{ result }] = await ctx.chrome.scripting.executeScript({
            target,
            func: (ref, snapshotId) => {
              const r = window.__katashiroResolve(ref, snapshotId);
              if (!r.ok) return { ok: false, error: r.error };
              r.el.scrollIntoView({ block: "center" });
              return { ok: true, how: "ref " + ref };
            },
            args: [bare, args.snapshotId]
          });
          if (!result.ok) return errText(result.error);
          return okText(`scrolled to ${result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
        }
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target: { tabId: ctx.tab.id },
          func: (to, direction, amount, sel) => {
            if (sel) {
              const el = document.querySelector(sel);
              if (!el) return { ok: false, error: "no element for selector: " + sel };
              el.scrollIntoView({ block: "center" });
              return { ok: true, how: "selector " + sel };
            }
            if (to === "top") { window.scrollTo({ top: 0 }); return { ok: true, how: "to top" }; }
            if (to === "bottom") { window.scrollTo({ top: document.body.scrollHeight }); return { ok: true, how: "to bottom" }; }
            const step = (amount || window.innerHeight) * (direction === "up" ? -1 : 1);
            window.scrollBy({ top: step });
            return { ok: true, how: (direction || "down") + " " + Math.abs(step) + "px" };
          },
          args: [args.to || null, args.direction || null, args.amount ?? null, args.selector || null]
        });
        if (!result.ok) return errText(result.error);
        return okText(`scrolled ${result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.tabs": {
      description:
        "List all open browser tabs across every window (index, title, URL, and which is active). " +
        "Read-only. katashiro's other tools act on the active tab; the `[index]` shown is a live " +
        "enumeration order (not a stable tab id) — pass it to `switch_tab` to change the active tab, " +
        "or use `new_tab` to open one.",
      // sessionScope: the browsing context is a browser-level fact, not the active page's — so this
      // still works when the active tab is a chrome:// / blank page with no scriptable origin.
      sessionScope: true,
      inputSchema: { type: "object", properties: {} },
      redact: redactDefault,
      /** @param {object} _args (none) */
      async call(_args, ctx) {
        // Deliberately lists ALL tabs (every window), not just the active one, so the agent can orient
        // across the browsing context. Wider exposure than every other tool (which touch only the
        // active tab): titles/URLs of unrelated tabs (mail, banking) reach the agent — accepted as
        // intentional because the agent is the user's own broker (review F1, decision b).
        const tabs = await ctx.chrome.tabs.query({});
        if (!tabs.length) return okText("(no tabs)");
        return okText(tabs.map((t, i) => `${t.active ? "*" : " "} [${i}] ${t.title || "(untitled)"} — ${t.url || ""}`).join("\n"));
      }
    },

    "katashiro.new_tab": {
      description:
        "Open a new browser tab and, by default, switch to it so subsequent tools act on it. Pass a " +
        "`url` to load a page; omit it for a blank New Tab page. Set `active: false` to open it in the " +
        "background without stealing focus. Returns the new tab's index plus — when it switched to a " +
        "scriptable http(s) page — the post-open snapshot. Gated by act mode.",
      write: true,
      sessionScope: true,
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "absolute URL to open; omit for a blank tab" },
          active: { type: "boolean", description: "switch to the new tab (default true)" }
        }
      },
      // UI detail: the URL without its query / fragment (tokens often ride there).
      redact: redactUrl,
      secrets: secretUrl,
      /** @param {{ url?: string, active?: boolean }} args */
      async call(args, ctx) {
        const makeActive = args.active !== false;               // default true
        const url = (args.url != null && String(args.url).trim() !== "") ? String(args.url).trim() : null;
        const created = { active: makeActive };
        if (url) created.url = url;
        const tab = await ctx.chrome.tabs.create(created);
        // Report the index in the same enumeration `tabs` / `switch_tab` use, so the three agree.
        const all = await ctx.chrome.tabs.query({});
        const index = all.findIndex((t) => t.id === tab.id);
        const label = `opened new tab [${index}]${makeActive ? " (now active)" : " (background)"} — ${url || "(new tab page)"}`;
        // Snapshot only when we actually switched to a scriptable page — that's where the agent's
        // next action lands. A background tab, blank tab, or chrome:// URL carries no snapshot.
        if (makeActive && url && pageOrigin(url)) {
          await waitForComplete(ctx.chrome, tab.id);
          return okText(`${label}\n\n${await snapshotAfter(ctx.chrome, tab.id)}`);
        }
        return okText(label);
      }
    },

    "katashiro.switch_tab": {
      description:
        "Switch to (activate) an already-open tab so subsequent tools act on it. Identify it by " +
        "`index` from a fresh `tabs` listing, or by `url` (the first tab whose URL contains this " +
        "substring — more stable than an index, which shifts as tabs open and close). Focuses the tab " +
        "and its window; returns the now-active tab plus, for a scriptable http(s) page, its snapshot. " +
        "Gated by act mode.",
      write: true,
      sessionScope: true,
      inputSchema: {
        type: "object",
        properties: {
          index: { type: "number", description: "tab index from a fresh `tabs` listing" },
          url: { type: "string", description: "substring of the target tab's URL (alternative to index)" }
        }
      },
      redact: redactDefault,
      /** @param {{ index?: number, url?: string }} args */
      async call(args, ctx) {
        const all = await ctx.chrome.tabs.query({});
        if (!all.length) return errText("no open tabs to switch to");
        let target = null;
        const needle = (args.url != null) ? String(args.url).trim() : "";
        if (needle) {
          target = all.find((t) => (t.url || "").includes(needle));
          if (!target) return errText(`no open tab whose URL contains "${needle}" — call tabs to see what's open`);
        } else if (Number.isInteger(args.index)) {
          if (args.index < 0 || args.index >= all.length) {
            return errText(`tab index ${args.index} is out of range (0..${all.length - 1}) — call tabs for the current list`);
          }
          target = all[args.index];
        } else {
          return errText("switch_tab needs an `index` (from tabs) or a `url` substring to identify the tab");
        }
        await ctx.chrome.tabs.update(target.id, { active: true });
        // The tab may live in a background window; focus that window too, else "active" is invisible.
        // chrome.windows is absent under `node --test`, so a missing API is not a failure.
        if (target.windowId != null && ctx.chrome.windows && ctx.chrome.windows.update) {
          try { await ctx.chrome.windows.update(target.windowId, { focused: true }); } catch { /* best-effort focus */ }
        }
        const idx = all.findIndex((t) => t.id === target.id);
        const label = `switched to tab [${idx}] — ${target.title || "(untitled)"} — ${target.url || ""}`;
        if (pageOrigin(target.url)) return okText(`${label}\n\n${await snapshotAfter(ctx.chrome, target.id)}`);
        return okText(label);
      }
    },

    "katashiro.history": {
      description: "Go back or forward in the active tab's navigation history. Returns the updated snapshot.",
      write: true,
      inputSchema: {
        type: "object",
        properties: { direction: { type: "string", enum: ["back", "forward"], description: "back or forward" } },
        required: ["direction"]
      },
      redact: redactDefault,
      /** @param {{ direction: string }} args */
      async call(args, ctx) {
        if (args.direction !== "back" && args.direction !== "forward") return errText("history needs direction 'back' or 'forward'");
        try {
          if (args.direction === "back") await ctx.chrome.tabs.goBack(ctx.tab.id);
          else await ctx.chrome.tabs.goForward(ctx.tab.id);
        } catch (e) {
          // goBack/goForward reject at the ends of the tab's history — a clean errText, not a throw.
          return errText(`no ${args.direction} history (${(e && e.message) || "at the end of the tab's history"})`);
        }
        await waitForComplete(ctx.chrome, ctx.tab.id);
        return okText(`went ${args.direction}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.press_key": {
      description:
        "Press a keyboard key (e.g. Enter, Escape, Tab, ArrowDown) in the active tab, targeting the " +
        "focused element or a `ref`/`selector`. Dispatches synthetic key events — this fires page key " +
        "handlers (Enter-to-submit, arrow nav, Escape) but not trusted native input; to insert text " +
        "use `type`. Returns the updated snapshot.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "key name, e.g. Enter, Escape, Tab, ArrowDown" },
          ref: { type: "string", description: "element ref from a snapshot to target" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector fallback" }
        },
        required: ["key"]
      },
      redact: redactDefault,
      /** @param {{ key: string, ref?: string, snapshotId?: number, selector?: string }} args */
      async call(args, ctx) {
        if (args.ref && args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-targeted");
        const { frameId, bare } = parseRef(args.ref);
        const target = { tabId: ctx.tab.id, frameIds: [frameId] };
        await injectWalker(ctx.chrome, target);
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target,
          func: (ref, snapshotId, sel, key) => {
            let el, how = "the focused element", targeted = false;
            if (ref) {
              const r = window.__katashiroResolve(ref, snapshotId);
              if (!r.ok) return { ok: false, error: r.error };
              el = r.el; how = "ref " + ref; targeted = true;
            } else if (sel) {
              el = document.querySelector(sel);
              if (!el) return { ok: false, error: "no element for selector: " + sel };
              how = "selector " + sel; targeted = true;
            } else {
              el = document.activeElement || document.body;
            }
            // Actionability when a specific element was named (skip for the implicit focused element):
            // a disabled/hidden target can't receive real keys, so refuse rather than fake success.
            if (targeted) {
              const vis = typeof el.checkVisibility === "function"
                ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                : el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
              if (!vis) return { ok: false, error: how + " is not visible" };
              if (el.disabled || el.getAttribute("aria-disabled") === "true") return { ok: false, error: how + " is disabled" };
              el.focus();
            }
            // Populate code/keyCode/which too — many real handlers key off e.code / e.keyCode, so a
            // bare `key` alone silently no-ops (false green on Enter etc.). keypress is deprecated and
            // only ever fired for printable keys, so skip it for named keys (Enter/Escape/arrows).
            const CODES = { Enter: "Enter", Escape: "Escape", Tab: "Tab", " ": "Space", Backspace: "Backspace", Delete: "Delete", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };
            const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, " ": 32, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
            let code = CODES[key], keyCode = KEYCODES[key];
            const printable = key.length === 1;
            if (!code && printable) {
              if (/[a-z]/i.test(key)) { code = "Key" + key.toUpperCase(); keyCode = key.toUpperCase().charCodeAt(0); }
              else if (/[0-9]/.test(key)) { code = "Digit" + key; keyCode = key.charCodeAt(0); }
            }
            const opts = { key, code: code || "", keyCode: keyCode || 0, which: keyCode || 0, bubbles: true, cancelable: true };
            el.dispatchEvent(new KeyboardEvent("keydown", opts));
            if (printable) el.dispatchEvent(new KeyboardEvent("keypress", opts));
            el.dispatchEvent(new KeyboardEvent("keyup", opts));
            return { ok: true, how };
          },
          args: [args.ref ? bare : null, args.snapshotId ?? null, args.selector || null, args.key]
        });
        if (!result.ok) return errText(result.error);
        return okText(`pressed ${args.key} on ${result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.hover": {
      description:
        "Hover the pointer over an element to reveal menus/tooltips (read-only perception aid). Prefer " +
        "`ref` from a snapshot; `selector` is a fallback. Returns the updated snapshot.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "element ref from a snapshot, e.g. e5" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector fallback" }
        }
      },
      redact: redactDefault,
      /** @param {{ ref?: string, snapshotId?: number, selector?: string }} args */
      async call(args, ctx) {
        if (!args.ref && !args.selector) return errText("hover needs a ref (preferred) or a selector");
        if (args.ref && args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-hovered");
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
            // Visible check only — hovering an invisible element is pointless, but hovering a
            // *disabled* (yet visible) control is legitimate (e.g. to read its explanatory tooltip).
            const vis = typeof el.checkVisibility === "function"
              ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              : el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            if (!vis) return { ok: false, error: how + " is not visible" };
            el.scrollIntoView({ block: "center" });
            for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter", "mousemove"]) {
              el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
            }
            return { ok: true, how };
          },
          args: [args.ref ? bare : null, args.snapshotId ?? null, args.selector || null]
        });
        if (!result.ok) return errText(result.error);
        return okText(`hovered ${result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.highlight": {
      description:
        "Point something out to the user: draw an outline (and optional short `label`) over an element " +
        "in the active tab for a few seconds, e.g. 'this is the button I mean' or before a write so the " +
        "user can see its target. Prefer `ref` from a snapshot; `selector` is a fallback. Pass " +
        "`clear: true` to remove all highlights. Read-only: the overlay lives in katashiro's own shadow " +
        "root, never touches the page's elements, ignores the pointer, and expires by itself.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "element ref from a snapshot, e.g. e5" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector fallback" },
          label: { type: "string", description: `short caption shown on the outline (max ${HIGHLIGHT_LABEL_MAX} chars)` },
          durationMs: { type: "number", description: `how long it stays, ms (default ${HIGHLIGHT_DEFAULT_MS}, max ${HIGHLIGHT_MAX_MS})` },
          clear: { type: "boolean", description: "remove every katashiro highlight instead of adding one" }
        }
      },
      redact: redactDefault,
      /** @param {{ ref?: string, snapshotId?: number, selector?: string, label?: string, durationMs?: number, clear?: boolean }} args */
      async call(args, ctx) {
        if (args.clear) {
          // Every frame: a ref highlight may live in a child frame the agent no longer remembers.
          await ctx.chrome.scripting.executeScript({
            target: { tabId: ctx.tab.id, allFrames: true },
            func: () => {
              const o = window.__katashiroOverlay;
              if (o) { for (const t of o.timers) clearTimeout(t); o.host.remove(); window.__katashiroOverlay = null; }
              return { ok: true };
            }
          });
          return okText("cleared highlights");
        }
        if (!args.ref && !args.selector) return errText("highlight needs a ref (preferred) or a selector, or `clear: true`");
        if (args.ref && args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-highlighted");
        const label = args.label == null ? "" : String(args.label).trim();
        if (label.length > HIGHLIGHT_LABEL_MAX) return errText(`highlight label is ${label.length} chars; keep it to ${HIGHLIGHT_LABEL_MAX} or fewer`);
        const ms = Math.min(Math.max(Number(args.durationMs) || HIGHLIGHT_DEFAULT_MS, 500), HIGHLIGHT_MAX_MS);
        const { frameId, bare } = parseRef(args.ref);
        const target = { tabId: ctx.tab.id, frameIds: [frameId] };
        await injectWalker(ctx.chrome, target);
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target,
          func: (ref, snapshotId, sel, label, ms) => {
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
            const vis = typeof el.checkVisibility === "function"
              ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              : el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            if (!vis) return { ok: false, error: how + " is not visible" };
            el.scrollIntoView({ block: "center" });
            // One host per frame, a closed shadow root inside it: page CSS cannot restyle the
            // overlay and page script cannot reach into it. Created here, never on the page's nodes.
            let o = window.__katashiroOverlay;
            if (!o || !o.host.isConnected) {
              const host = document.createElement("katashiro-overlay");
              host.style.cssText = "all: initial; position: absolute; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; pointer-events: none;";
              const root = host.attachShadow({ mode: "closed" });
              document.documentElement.appendChild(host);
              o = window.__katashiroOverlay = { host, root, timers: [] };
            }
            // Document coordinates, so the box scrolls with the element.
            const b = el.getBoundingClientRect();
            const box = document.createElement("div");
            box.style.cssText =
              `position: absolute; left: ${b.left + window.scrollX - 3}px; top: ${b.top + window.scrollY - 3}px; ` +
              `width: ${b.width + 6}px; height: ${b.height + 6}px; box-sizing: border-box; ` +
              "border: 3px solid #f59e0b; border-radius: 4px; pointer-events: none;";
            // The caption is attributed to katashiro so agent text can never pass as the site's own UI.
            const cap = document.createElement("div");
            cap.style.cssText =
              "position: absolute; left: -3px; bottom: 100%; margin-bottom: 4px; max-width: 320px; padding: 2px 8px; " +
              "background: #f59e0b; color: #111; font: 600 12px/1.5 system-ui, sans-serif; border-radius: 4px; " +
              "white-space: nowrap; overflow: hidden; text-overflow: ellipsis;";
            cap.textContent = "🤖 katashiro" + (label ? " · " + label : "");
            box.appendChild(cap);
            o.root.appendChild(box);
            o.timers.push(setTimeout(() => box.remove(), ms));
            return { ok: true, how };
          },
          args: [args.ref ? bare : null, args.snapshotId ?? null, args.selector || null, label, ms]
        });
        if (!result.ok) return errText(result.error);
        return okText(`highlighted ${result.how} for ${ms}ms${label ? ` — "${label}"` : ""}`);
      }
    },

    "katashiro.get_selection": {
      description:
        "Return the text the user has currently selected (highlighted) in the active tab — across " +
        "frames and inside text fields — plus the element it sits in. Use it when the user says 'this', " +
        "'the part I selected', 'explain / translate this'. Read-only. Empty when nothing is selected.",
      inputSchema: { type: "object", properties: {} },
      redact: redactDefault,
      /** @param {object} _args (none) */
      async call(_args, ctx) {
        const results = await ctx.chrome.scripting.executeScript({
          target: { tabId: ctx.tab.id, allFrames: true },
          func: (max) => {
            const describe = (n) => {
              const el = n && (n.nodeType === 1 ? n : n.parentElement);
              if (!el) return "";
              const name = el.getAttribute("aria-label") || el.getAttribute("name") || "";
              return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (name ? ` "${name}"` : "");
            };
            // window.getSelection() is blind to selections inside <input>/<textarea>; read those off
            // the focused field's selection range instead. Never out of a password field.
            const a = document.activeElement;
            if (a && (a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && a.type !== "password")) &&
                typeof a.selectionStart === "number" && a.selectionEnd > a.selectionStart) {
              return { text: a.value.slice(a.selectionStart, a.selectionEnd).slice(0, max), within: describe(a), url: location.href };
            }
            const s = window.getSelection();
            const text = s ? s.toString() : "";
            if (!text.trim()) return { text: "" };
            const range = s.rangeCount ? s.getRangeAt(0) : null;
            return { text: text.slice(0, max), within: describe(range && range.commonAncestorContainer), url: location.href };
          },
          args: [SELECTION_MAX]
        });
        const hits = (results || []).filter((r) => r && r.result && r.result.text);
        if (!hits.length) return okText("(nothing is selected — ask the user to highlight the text they mean)");
        return okText(hits.map((r) => {
          const where = r.frameId === 0 ? "" : ` [frame f${r.frameId}: ${r.result.url}]`;
          return `selection in ${r.result.within || "the page"}${where}:\n${r.result.text}`;
        }).join("\n\n"));
      }
    },

    "katashiro.select_option": {
      description:
        "Select an option in a <select> dropdown in the active tab. Match by `value` or visible " +
        "`label`. Prefer `ref` from a snapshot; `selector` is a fallback. Returns the updated snapshot.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "element ref from a snapshot, e.g. e5" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector fallback" },
          value: { type: "string", description: "option value to select" },
          label: { type: "string", description: "visible option text to select (if value unknown)" }
        }
      },
      redact: redactDefault,
      /** @param {{ ref?: string, snapshotId?: number, selector?: string, value?: string, label?: string }} args */
      async call(args, ctx) {
        if (!args.ref && !args.selector) return errText("select_option needs a ref (preferred) or a selector");
        if (args.ref && args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-selected");
        if (args.value == null && args.label == null) return errText("select_option needs a value or a label");
        const { frameId, bare } = parseRef(args.ref);
        const target = { tabId: ctx.tab.id, frameIds: [frameId] };
        await injectWalker(ctx.chrome, target);
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target,
          func: (ref, snapshotId, sel, value, label) => {
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
            if (!(el instanceof HTMLSelectElement)) return { ok: false, error: how + " is not a <select>" };
            // Actionability: a real user can't change a hidden or disabled select — refuse rather
            // than silently set its value (review: Mira / Falcon / Orca).
            const vis = typeof el.checkVisibility === "function"
              ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
              : el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
            if (!vis) return { ok: false, error: how + " is not visible" };
            if (el.disabled || el.getAttribute("aria-disabled") === "true") return { ok: false, error: how + " is disabled" };
            let opt = null;
            for (const o of el.options) {
              if (value != null && o.value === value) { opt = o; break; }
              if (label != null && (o.label === label || o.textContent.trim() === label)) { opt = o; break; }
            }
            if (!opt) return { ok: false, error: "no option matching " + (value != null ? "value " + JSON.stringify(value) : "label " + JSON.stringify(label)) };
            el.value = opt.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, how, selected: opt.value };
          },
          args: [args.ref ? bare : null, args.snapshotId ?? null, args.selector || null, args.value ?? null, args.label ?? null]
        });
        if (!result.ok) return errText(result.error);
        return okText(`selected ${result.selected} in ${result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.fill_form": {
      description:
        "Fill several form fields in one call instead of one `type` per field. Each entry names a field " +
        "by `ref` (all refs from the same snapshot, given once as `snapshotId`) or `selector`, and gives " +
        "`value` (text inputs, textareas, contenteditable, <select> by option value or label) or " +
        "`checked` (checkboxes, radios). All fields are checked first; if any is missing, hidden, " +
        "disabled or the wrong kind, NOTHING is filled. Does not submit. Returns the updated snapshot.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          snapshotId: { type: "number", description: "the snapshot the refs came from (stale check)" },
          fields: {
            type: "array",
            description: `fields to fill, in order (max ${FILL_FORM_MAX})`,
            items: {
              type: "object",
              properties: {
                ref: { type: "string", description: "element ref from the snapshot" },
                selector: { type: "string", description: "CSS selector fallback" },
                value: { type: "string", description: "text to set, or the option value/label for a <select>" },
                checked: { type: "boolean", description: "for a checkbox/radio: the state to leave it in" }
              }
            }
          }
        },
        required: ["fields"]
      },
      // UI detail: refs/selectors only — field values (passwords, PII) never leave this module.
      redact: redactFillForm,
      secrets: (args) => (Array.isArray(args.fields) ? args.fields : []).map((f) => f && f.value),
      /** @param {{ snapshotId?: number, fields: Array<{ ref?: string, selector?: string, value?: string, checked?: boolean }> }} args */
      async call(args, ctx) {
        const fields = Array.isArray(args.fields) ? args.fields : [];
        if (!fields.length) return errText("fill_form needs a non-empty `fields` array");
        if (fields.length > FILL_FORM_MAX) return errText(`fill_form takes at most ${FILL_FORM_MAX} fields per call`);
        for (let i = 0; i < fields.length; i++) {
          const f = fields[i] || {};
          if (!f.ref && !f.selector) return errText(`field ${i} needs a ref (preferred) or a selector`);
          if (f.value == null && typeof f.checked !== "boolean") return errText(`field ${i} needs a \`value\` or a boolean \`checked\``);
        }
        if (fields.some((f) => f.ref) && args.snapshotId == null) {
          return errText("refs must carry their snapshotId (from the snapshot they came from) so a stale ref is caught, not silently mis-filled");
        }
        // Refs can live in different frames; each frame gets one script run with its own fields.
        const byFrame = new Map();
        fields.forEach((f, i) => {
          const { frameId, bare } = parseRef(f.ref);
          const entry = { i, ref: f.ref ? bare : null, label: f.ref || f.selector, selector: f.ref ? null : f.selector,
                          value: f.value == null ? null : String(f.value), checked: typeof f.checked === "boolean" ? f.checked : null };
          if (!byFrame.has(frameId)) byFrame.set(frameId, []);
          byFrame.get(frameId).push(entry);
        });
        const run = async (apply) => {
          for (const [frameId, entries] of byFrame) {
            const target = { tabId: ctx.tab.id, frameIds: [frameId] };
            await injectWalker(ctx.chrome, target);
            const [{ result }] = await ctx.chrome.scripting.executeScript({
              target,
              func: (entries, snapshotId, apply) => {
                const plan = [];
                for (const f of entries) {
                  const how = `field ${f.i} (${f.label})`;
                  let el;
                  if (f.ref) {
                    const r = window.__katashiroResolve(f.ref, snapshotId);
                    if (!r.ok) return { ok: false, error: how + ": " + r.error };
                    el = r.el;
                  } else {
                    el = document.querySelector(f.selector);
                    if (!el) return { ok: false, error: how + ": no element for selector " + f.selector };
                  }
                  const vis = typeof el.checkVisibility === "function"
                    ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
                    : el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
                  if (!vis) return { ok: false, error: how + " is not visible" };
                  if (el.disabled || el.readOnly || el.getAttribute("aria-disabled") === "true") return { ok: false, error: how + " is disabled or read-only" };
                  const type = el instanceof HTMLInputElement ? el.type : "";
                  if (type === "checkbox" || type === "radio") {
                    if (f.checked == null) return { ok: false, error: how + " is a " + type + " — give `checked: true|false`, not a value" };
                    if (type === "radio" && f.checked === false && el.checked) return { ok: false, error: how + " is a checked radio — a radio is cleared by checking another in its group" };
                    plan.push({ el, kind: "toggle", want: f.checked });
                  } else if (type === "file") {
                    return { ok: false, error: how + " is a file input — use upload_file" };
                  } else if (el instanceof HTMLSelectElement) {
                    if (f.value == null) return { ok: false, error: how + " is a <select> — give `value` (option value or label)" };
                    const opt = Array.from(el.options).find((o) => o.value === f.value) ||
                                Array.from(el.options).find((o) => o.label === f.value || o.textContent.trim() === f.value);
                    // Never echo the value: fill_form values are treated as secrets end to end.
                    if (!opt) return { ok: false, error: how + ": no option matching the given value" };
                    plan.push({ el, kind: "select", opt });
                  } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) {
                    if (f.value == null) return { ok: false, error: how + " is a text field — give `value`" };
                    plan.push({ el, kind: "text", text: f.value });
                  } else {
                    return { ok: false, error: how + " is not a form field (" + el.tagName.toLowerCase() + ")" };
                  }
                }
                if (!apply) return { ok: true };
                for (const p of plan) {
                  if (p.kind === "toggle") {
                    // A real click, so the page's own handlers (and React's) run and see the change.
                    if (p.el.checked !== p.want) p.el.click();
                    continue;
                  }
                  if (p.kind === "select") p.el.value = p.opt.value;
                  else {
                    p.el.focus();
                    // Same React-safe native setter as `type`.
                    const proto = p.el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
                                : p.el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
                    const d = proto && Object.getOwnPropertyDescriptor(proto, "value");
                    if (d && d.set) d.set.call(p.el, p.text);
                    else p.el.textContent = p.text;
                  }
                  p.el.dispatchEvent(new Event("input", { bubbles: true }));
                  p.el.dispatchEvent(new Event("change", { bubbles: true }));
                }
                return { ok: true };
              },
              args: [entries, args.snapshotId ?? null, apply]
            });
            if (!result.ok) return result;
          }
          return { ok: true };
        };
        // Check every field in every frame before touching any, so a bad entry fills nothing.
        const checked = await run(false);
        if (!checked.ok) return errText(`${checked.error} — nothing was filled`);
        const filled = await run(true);
        if (!filled.ok) return errText(filled.error);
        return okText(`filled ${fields.length} field${fields.length === 1 ? "" : "s"}: ${fields.map((f) => f.ref || f.selector).join(", ")}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.upload_file": {
      description:
        "Attach file(s) to an <input type=file> in the active tab, with content you supply: each file " +
        "is a `name` plus either `text` (UTF-8) or `base64` (binary), and an optional `mimeType`. Works " +
        "on file inputs a site hides behind a styled button. Fires input+change; does not submit. " +
        `Total size max ${UPLOAD_MAX_BYTES / 1024 / 1024} MB. Returns the updated snapshot.`,
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "element ref from a snapshot, e.g. e5" },
          snapshotId: { type: "number", description: "the snapshot the ref came from (stale check)" },
          selector: { type: "string", description: "CSS selector fallback, e.g. input[type=file]" },
          files: {
            type: "array",
            description: "files to attach (more than one only if the input accepts multiple)",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "file name, e.g. report.csv" },
                mimeType: { type: "string", description: "e.g. text/csv, image/png (default application/octet-stream)" },
                text: { type: "string", description: "UTF-8 file content" },
                base64: { type: "string", description: "binary file content, base64-encoded" }
              },
              required: ["name"]
            }
          }
        },
        required: ["files"]
      },
      // UI detail: name / MIME / size only — file content (text or base64) never leaves this module.
      redact: redactUploadFile,
      secrets: (args) => (Array.isArray(args.files) ? args.files : []).flatMap((f) => (f ? [f.text, f.base64] : [])),
      /** @param {{ ref?: string, snapshotId?: number, selector?: string, files: Array<{ name: string, mimeType?: string, text?: string, base64?: string }> }} args */
      async call(args, ctx) {
        if (!args.ref && !args.selector) return errText("upload_file needs a ref (preferred) or a selector for the file input");
        if (args.ref && args.snapshotId == null) return errText("a ref must carry its snapshotId (from the snapshot it came from) so a stale ref is caught, not silently mis-targeted");
        const files = Array.isArray(args.files) ? args.files : [];
        if (!files.length) return errText("upload_file needs a non-empty `files` array");
        let total = 0;
        for (let i = 0; i < files.length; i++) {
          const f = files[i] || {};
          if (!f.name || !String(f.name).trim()) return errText(`file ${i} needs a \`name\``);
          if ((f.text == null) === (f.base64 == null)) return errText(`file ${i} needs exactly one of \`text\` or \`base64\``);
          if (f.base64 != null && !/^[A-Za-z0-9+/]*={0,2}$/.test(String(f.base64).replace(/\s+/g, ""))) return errText(`file ${i} \`base64\` is not valid base64`);
          total += f.text != null
            ? new TextEncoder().encode(String(f.text)).length
            : Math.floor(String(f.base64).replace(/\s+/g, "").replace(/=+$/, "").length * 3 / 4);
        }
        if (total > UPLOAD_MAX_BYTES) return errText(`files total ${total} bytes; upload_file is capped at ${UPLOAD_MAX_BYTES} bytes`);
        const payload = files.map((f) => ({
          name: String(f.name).trim(),
          type: f.mimeType || "application/octet-stream",
          text: f.text != null ? String(f.text) : null,
          base64: f.base64 != null ? String(f.base64).replace(/\s+/g, "") : null
        }));
        const { frameId, bare } = parseRef(args.ref);
        const target = { tabId: ctx.tab.id, frameIds: [frameId] };
        await injectWalker(ctx.chrome, target);
        const [{ result }] = await ctx.chrome.scripting.executeScript({
          target,
          func: (ref, snapshotId, sel, files) => {
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
            if (!(el instanceof HTMLInputElement) || el.type !== "file") return { ok: false, error: how + " is not an <input type=file>" };
            // No visibility check: sites routinely hide the real input behind a styled label.
            if (el.disabled) return { ok: false, error: how + " is disabled" };
            if (files.length > 1 && !el.multiple) return { ok: false, error: how + " accepts a single file; got " + files.length };
            const dt = new DataTransfer();
            for (const f of files) {
              const body = f.text != null ? f.text : Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
              dt.items.add(new File([body], f.name, { type: f.type }));
            }
            el.files = dt.files;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true, how };
          },
          args: [args.ref ? bare : null, args.snapshotId ?? null, args.selector || null, payload]
        });
        if (!result.ok) return errText(result.error);
        return okText(`attached ${payload.map((f) => f.name).join(", ")} (${total} bytes) to ${result.how}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.reload": {
      description:
        "Reload the active tab. Set `bypassCache` for a hard reload that ignores the HTTP cache. " +
        "Returns the updated snapshot.",
      write: true,
      inputSchema: {
        type: "object",
        properties: { bypassCache: { type: "boolean", description: "hard reload, ignoring the HTTP cache" } }
      },
      redact: redactDefault,
      /** @param {{ bypassCache?: boolean }} args */
      async call(args, ctx) {
        await ctx.chrome.tabs.reload(ctx.tab.id, { bypassCache: !!args.bypassCache });
        await waitForComplete(ctx.chrome, ctx.tab.id);
        return okText(`reloaded${args.bypassCache ? " (bypassing cache)" : ""}\n\n${await snapshotAfter(ctx.chrome, ctx.tab.id)}`);
      }
    },

    "katashiro.inject_css": {
      description:
        "Apply a CSS stylesheet to the active tab (all frames) — e.g. hide distracting banners, enlarge " +
        "text, make a layout readable. Use `!important` to win over the site's rules. Pass `clear: true` " +
        "to remove every stylesheet katashiro injected in this tab. Visual only and temporary: it " +
        "changes no page data and is gone on reload. Sheets that fetch anything (`url()`, `@import`, " +
        "`image-set()`, `@font-face`, …) and CSS escapes (`\\`) are refused.",
      write: true,
      inputSchema: {
        type: "object",
        properties: {
          css: { type: "string", description: `the stylesheet text (max ${CSS_MAX} chars)` },
          clear: { type: "boolean", description: "remove every stylesheet katashiro injected in this tab" }
        }
      },
      // UI detail: the stylesheet is clipped at DETAIL_STR_MAX by the default.
      redact: redactDefault,
      /** @param {{ css?: string, clear?: boolean }} args */
      async call(args, ctx) {
        const tabId = ctx.tab.id;
        if (args.clear) {
          const sheets = injectedCss.get(tabId) || [];
          for (const css of sheets) {
            try { await ctx.chrome.scripting.removeCSS({ target: { tabId, allFrames: true }, css }); }
            catch { /* the page navigated since; the sheet is already gone */ }
          }
          injectedCss.delete(tabId);
          return okText(`removed ${sheets.length} injected stylesheet${sheets.length === 1 ? "" : "s"}`);
        }
        const css = args.css == null ? "" : String(args.css);
        if (!css.trim()) return errText("inject_css needs `css` (or `clear: true`)");
        if (css.length > CSS_MAX) return errText(`css is ${css.length} chars; inject_css is capped at ${CSS_MAX}`);
        const bad = CSS_FORBIDDEN.exec(css);
        if (bad) return errText(`css contains ${JSON.stringify(bad[0])} — inject_css refuses anything that fetches (url/src/image/image-set/@import/@font-face) and CSS escapes, so a stylesheet cannot leak page data`);
        await ctx.chrome.scripting.insertCSS({ target: { tabId, allFrames: true }, css });
        if (!injectedCss.has(tabId)) injectedCss.set(tabId, []);
        injectedCss.get(tabId).push(css);
        return okText(`injected ${css.length} chars of CSS (call inject_css with clear: true to undo; snapshot to see what is now visible)`);
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
  // firstText / extractRefCandidates support click_text's Jev disambiguation.
  function firstText(result) {
    const c = result && result.content;
    if (!Array.isArray(c)) return null;
    const t = c.find((b) => b && b.type === "text" && typeof b.text === "string");
    return t ? t.text : null;
  }
  // JevGrounding is a sibling global in the extension; injectable as deps.jev for tests/node.
  function resolveJev(deps) {
    if (typeof JevGrounding !== "undefined") return JevGrounding;
    return (deps && deps.jev) || null;
  }
  // Very small stopword set so common words in a description ("the button to …") don't dominate
  // the relevance score. English function words + nothing for CJK (which we keep whole).
  const DESC_STOPWORDS = new Set(["the", "to", "of", "in", "on", "at", "an", "and", "or", "for", "a", "click", "button", "link"]);

  // Split a description into lowercased keyword tokens on non-letter/non-number boundaries, dropping
  // very short tokens and stopwords. `\p{L}` keeps every script — Latin, CJK, kana, hangul, Cyrillic,
  // … — so a non-English description isn't shredded into empty tokens; CJK is kept as whole runs (no
  // segmenter) and substring-matched against candidate labels.
  function descKeywords(description) {
    return String(description == null ? "" : description)
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length >= 2 && !DESC_STOPWORDS.has(t));
  }

  // How many of the description keywords appear in the (lowercased) candidate label.
  function overlapScore(label, keywords) {
    const l = String(label).toLowerCase();
    let s = 0;
    for (const k of keywords) if (l.includes(k)) s++;
    return s;
  }

  // Pull { ref: label } candidates from a snapshot's text tree, RANKED by relevance to
  // `description` before the cap is applied — so the target survives even on a busy page where it
  // sits deep in the DOM (the old first-N-in-document-order cut dropped it). Every interactive line
  // carries a [ref=eN] (or frame-prefixed [ref=f7:e3]) marker; the label is that line, marker
  // stripped (the a11y snapshot already puts role + accessible name there). Ties and the
  // no-keyword-match case fall back to document order, so behaviour is unchanged for short pages.
  function extractRefCandidates(snapText, description, cap) {
    const max = cap || 60;
    const lines = String(snapText == null ? "" : snapText).split("\n");
    const seen = new Set();
    const cands = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/\[ref=([^\]]+)\]/);
      if (!m) continue;
      const ref = m[1];
      if (seen.has(ref)) continue;
      seen.add(ref);
      const label = lines[i].replace(/\s*\[ref=[^\]]+\]\s*/, " ").replace(/^[\s\-*]+/, "").trim() || ref;
      cands.push({ ref: ref, label: label, order: i });
    }
    const keywords = descKeywords(description);
    if (keywords.length) {
      for (const c of cands) c.score = overlapScore(c.label, keywords);
      cands.sort((a, b) => (b.score - a.score) || (a.order - b.order));
    }
    const out = {};
    for (const c of cands.slice(0, max)) out[c.ref] = c.label;
    return out;
  }

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
    // Session-level tools (list / open / switch tabs) act on the browser, not a specific page's
    // DOM, so they neither need nor are constrained by the current active tab's origin — a
    // chrome:// or blank active tab must not block "open a new tab". They resolve their own targets.
    if (tool.sessionScope) {
      const ctx = { chrome, jev: resolveJev(deps), jevToken: deps.jevToken };
      return await tool.call(args, ctx);
    }
    // Then the tab — every surviving tool needs it, and resolving it up front keeps the
    // "no active browser tab" diagnosis ahead of any per-tool failure.
    const tab = await activeTab(chrome);
    // Supported-scheme check: chrome://, file://, etc. have no scriptable web origin. Host-permission
    // enforcement for real sites is left to Chrome (a withheld site fails the scripting call).
    if (!pageOrigin(tab.url)) return errText(ORIGIN_UNSUPPORTED);
    // Thread the Jev evaluator + token into ctx so semantic tools (e.g. click_text) can ground.
    const ctx = { chrome, tab, jev: resolveJev(deps), jevToken: deps.jevToken };
    return withTabContext(await tool.call(args, ctx), tab);
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
          case "tools/call": {
            // Tool-execution failures (no active tab, restricted page like chrome://, missing
            // host permission, injected-script error) become MCP isError results — not protocol
            // errors — so the agent sees the failure and can adapt.
            //
            // Surface an activity signal to the UI via `onToolCall`: name + phase, the MASKED
            // arguments (the tool's own `redact` hook — raw args never leave this module), and on
            // settle a one-line `summary`, a bounded `preview` of the result text, and `ms`.
            const callId = (deps.crypto && deps.crypto.randomUUID)
              ? deps.crypto.randomUUID()
              : `${Date.now()}-${params.name}`;
            const rawArgs = params.arguments || {};
            const tool = Object.prototype.hasOwnProperty.call(tools, params.name) ? tools[params.name] : null;
            const args = maskArgs(tool, rawArgs);
            const secrets = deps.onToolCall ? secretsFor(tool, rawArgs, args) : [];
            const started = Date.now();
            if (deps.onToolCall) deps.onToolCall({ callId, name: params.name, phase: "start", args });
            const settle = (phase, result) => {
              if (!deps.onToolCall) return;
              const { summary, preview } = describeResult(result, secrets);
              deps.onToolCall({ callId, name: params.name, phase, args, summary, preview, ms: Date.now() - started });
            };
            try {
              const result = await callBrowserTool(params.name, rawArgs, deps, tools);
              settle((result && result.isError) ? "error" : "done", result);
              return result;
            } catch (e) {
              const result = { content: [{ type: "text", text: `tool error: ${(e && e.message) || e}` }], isError: true };
              settle("error", result);
              return result;
            }
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

  return { TOOLS, BROWSER_TOOLS, createServer, callBrowserTool, handleMcpMessage, handleServerRequest, extractRefCandidates };
});
