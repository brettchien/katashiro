// page/a11y-walker.js — injected into the active tab's ISOLATED world via chrome.scripting.
//
// Builds an accessibility-tree snapshot with stable, snapshot-scoped element refs, and resolves a ref
// back to a live Element for click/type. Implements ADR docs/adr/a11y-snapshot-and-element-refs.md
// (§3.1 snapshot, §3.2 stale-ref assertion). Uses window.__katashiroA11y (vendored dom-accessibility-api)
// for name+role. The registry lives on the isolated-world window, so it survives across the separate
// executeScript calls for snapshot and click/type (until the frame reloads).
//
// Single-frame for now; frame merge (fN:eM) is a later step — `prefix` is the hook.
(() => {
  const A11Y = window.__katashiroA11y;
  if (!A11Y) return; // vendored lib must be injected first

  // Persistent per-frame registry. byRef resolves ref->Element; byEl re-issues a stable ref to the same
  // Element within one snapshot; snapshotId is the generation an action must match.
  const REG = (window.__katashiroReg ||= {
    snapshotId: 0,
    prefix: "",
    byRef: new Map(),   // refId -> Element (cleared each snapshot; strong ref, guarded by isConnected)
    byEl: new WeakMap() // Element -> refId (auto-drops detached nodes)
  });

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox",
    "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "option"
  ]);
  const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "OPTION"]);

  // Node budget: a huge page (e.g. an e-commerce home) has hundreds of interactive elements; an
  // unbounded tree floods the agent's context (ADR §Negative "walker cost / node budget"). Cap the
  // emitted lines and flag truncation so the agent scopes/scrolls instead of drowning.
  const MAX_LINES = 1000;

  // "Strong" = a deterministic, semantic control (tag / role / contenteditable / tabindex). Always
  // gets a ref, even nested — a real <input> inside a clickable card must stay reachable.
  function strongInteractive(el, role) {
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    if (el.isContentEditable) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && Number(ti) >= 0;
  }

  // "Weak" = cursor:pointer only. It inherits to children, so decorative spans/icons inside a
  // clickable element also report pointer. We honor it only when NOT already inside a ref'd
  // interactive element, to avoid redundant nested refs (ADR §3.1; confirmed noisy in live test).
  function weakInteractive(el) {
    try { return getComputedStyle(el).cursor === "pointer"; } catch { return false; }
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (typeof el.checkVisibility === "function") {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function stateOf(el, role) {
    const s = [];
    if (el.hasAttribute("required") || el.getAttribute("aria-required") === "true") s.push("required");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
    const checked = el.getAttribute("aria-checked") ?? (("checked" in el) ? String(!!el.checked) : null);
    if ((role === "checkbox" || role === "radio" || role === "switch") && checked && checked !== "false") s.push("checked");
    const exp = el.getAttribute("aria-expanded");
    if (exp === "true" || exp === "false") s.push(`expanded=${exp}`);
    return s.length ? ` {${s.join(", ")}}` : "";
  }

  function issueRef(el) {
    let ref = REG.byEl.get(el);
    if (!ref) {
      ref = REG.prefix + "e" + (++REG._counter || (REG._counter = 1));
      REG.byEl.set(el, ref);
    }
    REG.byRef.set(ref, el);
    return ref;
  }

  // Depth-first walk, descending into open shadow roots. Emits lines for a11y-meaningful or
  // heuristically-interactive elements; pure wrappers are skipped but still traversed.
  function walk(node, depth, out, inInteractive) {
    if (out.length >= MAX_LINES) return; // node budget reached — stop emitting
    const kids = [];
    if (node.shadowRoot) kids.push(...node.shadowRoot.children);       // open shadow only; closed is null
    if (node.children) kids.push(...node.children);
    for (const el of kids) {
      if (A11Y.isInaccessible(el)) continue;
      const role = A11Y.getRole(el);
      const name = A11Y.computeAccessibleName(el);
      // Strong controls always ref; weak (cursor:pointer) elements ref only with no ref'd ancestor,
      // so decorative descendants of a button/link no longer get redundant refs.
      const interactive = strongInteractive(el, role) || (!inInteractive && weakInteractive(el));
      const meaningful = !!(role || name) || interactive;
      let childDepth = depth;
      let childInside = inInteractive;
      if (meaningful && isVisible(el)) {
        const label = name ? ` "${name.replace(/\s+/g, " ").trim()}"` : "";
        const ref = interactive ? ` [ref=${issueRef(el)}]` : "";
        const level = el.getAttribute("aria-level") || (/^H[1-6]$/.test(el.tagName) ? el.tagName[1] : "");
        const lvl = level ? ` [level=${level}]` : "";
        out.push(`${"  ".repeat(depth)}- ${role || el.tagName.toLowerCase()}${label}${lvl}${ref}${stateOf(el, role)}`);
        childDepth = depth + 1;
        if (interactive) childInside = true;
      }
      walk(el, childDepth, out, childInside);
    }
  }

  // Public: build a fresh snapshot. Clears prior refs (snapshot-scoped) and bumps the generation.
  // forceId: the caller (the tool) assigns one generation across ALL frames of a page, so a
  // multi-frame snapshot shares one snapshotId. Without it, each frame would count independently.
  window.__katashiroSnapshot = function (forceId) {
    REG.snapshotId = (forceId != null) ? forceId : REG.snapshotId + 1;
    REG.byRef.clear();
    REG._counter = 0;
    const out = [];
    walk(document.body || document.documentElement, 0, out, false);
    const truncated = out.length >= MAX_LINES;
    if (truncated) {
      out.push(`- … truncated at ${MAX_LINES} nodes; scope with a selector, scroll, or act on what's shown`);
    }
    return {
      ok: true,
      snapshotId: REG.snapshotId,
      url: location.href,
      title: document.title,
      truncated,
      tree: out.join("\n") || "(no interactive or labeled elements found)"
    };
  };

  // Settle then snapshot: after an action that may navigate or re-render, wait for DOM mutations to
  // quiet (or a hard cap) before serializing, so the agent gets the resulting page, not a transitional
  // tree (ADR §3.3). Async — chrome.scripting awaits the returned promise.
  window.__katashiroSnapshotAfter = async function (forceId) {
    await new Promise((resolve) => {
      let hard = setTimeout(fin, 1500);   // hard cap
      let quiet = setTimeout(fin, 200);   // mutations quiet for 200ms
      const mo = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(fin, 200); });
      try { mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true }); } catch { /* no doc */ }
      function fin() { clearTimeout(hard); clearTimeout(quiet); mo.disconnect(); resolve(); }
    });
    return window.__katashiroSnapshot(forceId);
  };

  // Public: resolve a ref to a live Element, asserting it is current and attached (ADR §3.2).
  // Returns { ok, el } or { ok:false, stale:true, error } so callers raise StaleRefError.
  window.__katashiroResolve = function (ref, expectSnapshotId) {
    if (expectSnapshotId != null && expectSnapshotId !== REG.snapshotId) {
      return { ok: false, stale: true, error: `stale ref ${ref}: snapshot ${expectSnapshotId} superseded by ${REG.snapshotId}; call snapshot again` };
    }
    const el = REG.byRef.get(ref);
    if (!el) return { ok: false, stale: true, error: `unknown ref ${ref}; call snapshot again` };
    if (!el.isConnected) return { ok: false, stale: true, error: `stale ref ${ref}: element detached; call snapshot again` };
    return { ok: true, el };
  };
})();
