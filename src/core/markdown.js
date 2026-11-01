// markdown.js — the single sanitized path from remote/user markdown text to HTML.
//
// Agent replies (and the user's own messages) arrive as markdown. Rendering them means an
// `innerHTML` sink, and that text is remote-controlled (a compromised/MITM ACP server, or a
// page the agent read, can inject a string), so an unsanitized sink here is a remote-XSS that
// could exfiltrate the side panel's chrome.storage tokens (see ADR
// `docs/adr/chat-markdown-rendering.md` §1.2). `renderMarkdown` is therefore the ONLY sanctioned
// route from remote text to innerHTML: `md.render` → `DOMPurify.sanitize` (mandatory).
//
// Depends on the vendored globals `markdownit` (with `markdownitContainer` and `markdownitGithubAlerts`,
// bundled in the same file), `DOMPurify`, and `hljs` (loaded before this file).
(function (global) {
  "use strict";

  const hljs = global.hljs;

  // Highlight a fenced block inside markdown-it's `highlight` hook (§3.4); the whole rendered
  // output is DOMPurify-sanitized once afterward (§2 convention). Unknown/omitted languages fall
  // back to escaped plain code. Always returns a full <pre><code> so markdown-it does not re-wrap.
  function highlightFence(str, lang) {
    const name = (lang || "").toLowerCase().trim(); // normalize: "JS " / "Python" → registered id
    if (name && hljs && hljs.getLanguage(name)) {
      try {
        const out = hljs.highlight(str, { language: name, ignoreIllegals: true }).value;
        // escape the (already-validated) name too, so a future language id can never inject markup
        return '<pre class="hljs"><code class="language-' + md.utils.escapeHtml(name) + '">' + out + "</code></pre>\n";
      } catch (_) { /* fall through to plain */ }
    }
    // Mermaid stays code here (the chat shows it as code); the class lets the canvas frame find the
    // fences it renders as diagrams (ADR canvas §3.3). A constant class, never the info string.
    if (name === "mermaid") return '<pre class="hljs"><code class="language-mermaid">' + md.utils.escapeHtml(str) + "</code></pre>\n";
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + "</code></pre>\n";
  }

  // html:false ⇒ any raw HTML in the message is ESCAPED to text before it ever reaches the
  // sanitizer (double defense); linkify auto-links bare URLs. GFM-style pipe tables are on in
  // markdown-it's default preset — the readability fix this ADR is motivated by (§1.1).
  // `extra` only ever adds `breaks` (the user's own messages, below); every rule is the same.
  function buildMd(extra) {
    const md = global.markdownit(Object.assign({ html: false, linkify: true, highlight: highlightFence }, extra));

    // GFM task lists: a list item starting "[ ] " or "[x] " gets a read-only checkbox. A small core
    // rule instead of a plugin dependency. The checkbox markup is a CONSTANT string (never built from
    // message text) and still passes through DOMPurify, which keeps <input type=checkbox disabled>.
    const TASK_RE = /^\[([ xX])\][ \u00a0]/;
    const TASK_BOX = '<input type="checkbox" class="task-list-item-checkbox" disabled> ';
    const TASK_BOX_CHECKED = '<input type="checkbox" class="task-list-item-checkbox" checked disabled> ';
    md.core.ruler.after("inline", "task_lists", (state) => {
      const t = state.tokens;
      for (let i = 2; i < t.length; i++) {
        if (t[i].type !== "inline" || t[i - 1].type !== "paragraph_open" || t[i - 2].type !== "list_item_open") continue;
        const first = t[i].children && t[i].children[0];
        const m = first && first.type === "text" ? TASK_RE.exec(first.content) : null;
        if (!m) continue;
        first.content = first.content.slice(m[0].length);
        const box = new state.Token("html_inline", "", 0);
        box.content = m[1] === " " ? TASK_BOX : TASK_BOX_CHECKED;
        t[i].children.unshift(box);
        t[i - 2].attrJoin("class", "task-list-item");
      }
    });

    // Cards (ADR canvas §3.3, "Cards and callouts"): a `::: cards` … `:::` block (markdown-it-container,
    // vendored in the markdown-it bundle) is a row of cards. Only the name `cards` is registered, so any
    // other `::: foo` stays plain text. The class is a CONSTANT string: the info string after `cards`
    // is ignored, never copied into the markup. markdown-it-container's own default render would also
    // only use the name; ours spells it out so that stays true whatever the plugin does.
    if (global.markdownitContainer) {
      md.use(global.markdownitContainer, "cards", {
        validate: (params) => params.trim().split(/\s+/, 1)[0] === "cards",
        render: (tokens, idx, options, env, slf) => {
          if (tokens[idx].nesting === 1) tokens[idx].attrJoin("class", "cards");
          return slf.renderToken(tokens, idx, options);
        },
      });
    }
    // Each card: every DIRECT-child `###` of a cards container starts one; blocks before the first
    // `###` (if any) are a card of their own. Direct child = one level below the container's token,
    // so an h3 inside a list, quote, alert or nested container never splits the outer row (a nested
    // cards container gets its own cards; the outer one needs the longer fence, `::::`, or the inner
    // `:::` closes it). The card tokens are plain `div`s with a constant class
    // (rendered by markdown-it's renderToken, no rule needed); their source lines run from their
    // first block to the next card (or the closing `:::`), so the canvas's Ask agent can name them.
    md.core.ruler.after("block", "cards", (state) => {
      if (!state.tokens.some((t) => t.type === "container_cards_open")) return;
      const out = [];
      const stack = [];                   // open cards containers: { open, orig level, card }
      const closeCard = (top, end) => {
        if (!top.card) return;
        if (top.card.map && end != null) top.card.map[1] = end;
        const c = new state.Token("card_close", "div", -1);
        c.block = true;
        c.level = top.open.level + 1;
        out.push(c);
        top.card = null;
      };
      for (const t of state.tokens) {
        const orig = t.level;
        let top = stack[stack.length - 1];
        if (t.type === "container_cards_close" && top && orig === top.level) {
          closeCard(top, top.open.map && top.open.map[1]);
          stack.pop();
          t.level = orig + stack.length;
          out.push(t);
          continue;
        }
        if (top && orig === top.level + 1 && t.nesting !== -1) {
          const h3 = t.type === "heading_open" && t.tag === "h3";
          if (!top.card || h3) {
            closeCard(top, t.map && t.map[0]);
            const c = new state.Token("card_open", "div", 1);
            c.block = true;
            c.level = top.open.level + 1;
            c.attrSet("class", "card");
            if (t.map) c.map = [t.map[0], t.map[1]];
            out.push(c);
            top.card = c;
          }
        }
        t.level = orig + stack.length;    // everything inside a container now sits inside a card
        out.push(t);
        if (t.type === "container_cards_open") stack.push({ open: t, level: orig, card: null });
      }
      state.tokens = out;
    });

    // Callouts (ADR canvas §3.3): GitHub alerts `> [!NOTE]` / TIP / IMPORTANT / WARNING / CAUTION
    // (markdown-it-github-alerts, vendored with markdown-it). Its rule also accepts the escaped
    // `> \[!NOTE]`, which is how Milkdown normalization (ADR canvas §3.5) writes the marker back, so a
    // normalized canvas keeps its alerts. Our own alert_open replaces the plugin's: no SVG icon (the
    // sink is html-profile only and DP_CONFIG stays pinned, so an <svg> would be stripped anyway),
    // classes only from a constant table keyed by the matched marker, and the optional custom title
    // (`> [!NOTE] Heads up`) ESCAPED — the plugin pastes it into its HTML raw, which would undo the
    // html:false double defense.
    const ALERT_CLASS = {
      note: "markdown-alert markdown-alert-note", tip: "markdown-alert markdown-alert-tip",
      important: "markdown-alert markdown-alert-important", warning: "markdown-alert markdown-alert-warning",
      caution: "markdown-alert markdown-alert-caution",
    };
    if (global.markdownitGithubAlerts) {
      md.use(global.markdownitGithubAlerts, { icons: {}, markers: ["TIP", "NOTE", "IMPORTANT", "WARNING", "CAUTION"] });
      md.renderer.rules.alert_open = (tokens, idx, options, env, slf) => {
        const meta = tokens[idx].meta || {};
        const cls = Object.prototype.hasOwnProperty.call(ALERT_CLASS, meta.type) ? ALERT_CLASS[meta.type] : ALERT_CLASS.note;
        // renderAttrs: only the source-line data-* the source_lines rule set (numbers, see below)
        return `<div class="${cls}"${slf.renderAttrs(tokens[idx])}><p class="markdown-alert-title">` +
          md.utils.escapeHtml(String(meta.title || "")) + "</p>\n";
      };
    }
    // Emoji callouts (as in Claude's docs): a plain quote whose first paragraph starts with ℹ️ / ✅ /
    // ⚠️ (with or without U+FE0F) gets the same constant alert classes (note / tip / warning) plus
    // `markdown-alert-emoji` (no title row: the emoji, kept in the text, is the marker). Runs after
    // the GitHub-alerts rule, which has already turned `[!…]` quotes into alert_open.
    const EMOJI_ALERT = [[/^ℹ️?/, "note"], [/^✅️?/, "tip"], [/^⚠️?/, "warning"]];
    md.core.ruler.after(global.markdownitGithubAlerts ? "github-alerts" : "block", "emoji_alerts", (state) => {
      const t = state.tokens;
      for (let i = 0; i + 2 < t.length; i++) {
        if (t[i].type !== "blockquote_open" || t[i + 1].type !== "paragraph_open" || t[i + 2].type !== "inline") continue;
        const hit = EMOJI_ALERT.find(([re]) => re.test(t[i + 2].content));
        if (hit) t[i].attrJoin("class", ALERT_CLASS[hit[1]] + " markdown-alert-emoji");
      }
    });

    // Tables (ADR canvas §3.3 "Tables"): every <table> sits in a `<div class="table-wrap">` (a
    // CONSTANT class), so the table itself can be width 100% while a wide one scrolls sideways in
    // the wrapper instead of being made `display: block` (which left its border and rules at the
    // content's width). The table keeps its own attributes (source lines below).
    md.renderer.rules.table_open = (tokens, idx, options, env, slf) =>
      '<div class="table-wrap">\n' + slf.renderToken(tokens, idx, options);
    md.renderer.rules.table_close = (tokens, idx, options, env, slf) =>
      slf.renderToken(tokens, idx, options) + "</div>\n";

    // Source lines (canvas Ask agent, ADR canvas §3.7): with env.sourceLines, every block element
    // markdown-it maps to source lines carries them as data-line-start / data-line-end (its
    // token.map: 0-based, end exclusive), so the canvas frame can say which lines a selection is in.
    // Numbers only, from the parser — never from the text. Off for the chat (no env). DOMPurify keeps
    // data-* attributes by default (ALLOW_DATA_ATTR), so DP_CONFIG needs no change for them.
    const lineAttrs = (map) => [["data-line-start", String(map[0])], ["data-line-end", String(map[1])]];
    md.core.ruler.push("source_lines", (state) => {
      if (!state.env || state.env.sourceLines !== true) return;
      for (const t of state.tokens) {
        if (!t.block || !t.map || t.nesting === -1 || t.type === "inline") continue;
        for (const [k, v] of lineAttrs(t.map)) t.attrSet(k, v);
      }
    });
    // highlightFence returns a whole <pre>, which markdown-it emits as is (without the token's
    // attributes): put them on that <pre> here.
    const fenceRule = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, idx, options, env, slf) => {
      const out = fenceRule(tokens, idx, options, env, slf);
      const t = tokens[idx];
      if (!env || env.sourceLines !== true || !t.map || !out.startsWith("<pre")) return out;
      return `<pre data-line-start="${t.map[0]}" data-line-end="${t.map[1]}"${out.slice(4)}`;
    };
    return md;
  }

  // Agent replies (and the canvas): a single newline is a soft break, rendered as a space — the
  // CommonMark default, left as is on purpose (agent text is wrapped markdown).
  const md = buildMd({});
  // The user's own messages: what they typed with Shift+Enter keeps its line breaks (soft break →
  // <br>). Block structure is unaffected by `breaks`: only a soft break inside inline text
  // (a paragraph, list item or quote) becomes <br>; fenced/indented code is untouched.
  const mdUser = buildMd({ breaks: true });

  // Pinned, no-relax sanitizer config (ADR §3.2). This is where the defense is most easily
  // broken, so relaxing any of it is forbidden:
  //   - HTML profile only — no `svg`/`mathMl` profile.
  //   - SANITIZE_DOM blocks DOM-clobbering (e.g. `<form id="document">` shadowing globals).
  //   - The ONLY permitted ADD_ATTR is `target` (DOMPurify strips it by default, so the
  //     `target="_blank"` link hook — §3.5 — is a silent no-op without it).
  // Do NOT add ALLOW_UNKNOWN_PROTOCOLS, loosen ALLOWED_URI_REGEXP, or ADD_TAGS / style / event
  // handlers.
  const DP_CONFIG = {
    USE_PROFILES: { html: true },
    SANITIZE_DOM: true,
    ADD_ATTR: ["target"],
  };

  // Link + media hardening (§3.5), registered ONCE (idempotency guard — re-eval / re-require must
  // not stack the hook and run it N times). Runs per element after DOMPurify sanitizes its
  // attributes — defense in depth behind markdown-it's validateLink and DOMPurify's own URI filter:
  //  - anchors: drop any href whose scheme isn't http(s)/mailto; on the survivors force
  //    target="_blank" + rel="noopener noreferrer" (needs ADD_ATTR:['target'], §3.2) so an opened
  //    link can't reach back via window.opener.
  //  - media (`src`): drop any scheme that isn't http(s)/data: (data: images are allowed by the
  //    §3.7 CSP img-src; remote-image beaconing is separately blocked there). `srcset` carries its
  //    own URL list the `src` check doesn't cover; markdown never emits it, so strip it outright.
  const ANCHOR_SCHEMES = /^(https?:|mailto:)/i;
  const MEDIA_SCHEMES = /^(https?:|data:)/i;
  if (global.DOMPurify && global.DOMPurify.addHook && !global.__katashiroMarkdownHooked) {
    global.__katashiroMarkdownHooked = true;
    global.DOMPurify.addHook("afterSanitizeAttributes", (node) => {
      if (node.getAttribute && node.hasAttribute && node.hasAttribute("srcset")) {
        node.removeAttribute("srcset");
      }
      if (node.nodeName === "A") {
        const href = (node.getAttribute("href") || "").trim();
        if (href && !ANCHOR_SCHEMES.test(href)) {
          node.removeAttribute("href");
        } else if (href) {
          node.setAttribute("target", "_blank");
          node.setAttribute("rel", "noopener noreferrer");
        }
      } else if (node.getAttribute && node.getAttribute("src")) {
        if (!MEDIA_SCHEMES.test(node.getAttribute("src").trim())) node.removeAttribute("src");
      }
    });
  }

  // The only path remote text may take to reach innerHTML. A lint/grep rule bans any other
  // `innerHTML =` of remote text (streaming stays textContent; system notices stay textContent).

  // opts.sourceLines: tag block elements with their source lines (the canvas frame only).
  // opts.userText: the user's own message — single newlines stay line breaks (mdUser).
  function renderMarkdown(text, opts) {
    const env = opts && opts.sourceLines === true ? { sourceLines: true } : {};
    const parser = opts && opts.userText === true ? mdUser : md;
    const html = parser.render(text == null ? "" : String(text), env);
    return global.DOMPurify.sanitize(html, DP_CONFIG);
  }

  // Add a copy button to each code block. Built with createElement AFTER sanitize, reading the
  // code via textContent — NEVER concatenated into the markdown HTML string before sanitizing
  // (§3.4). The button lives in <pre> (not <code>), so it is excluded from the copied text.
  // `copyText(text) → Promise` defaults to the Clipboard API; the sandboxed canvas frame (opaque
  // origin, no clipboard access) passes one that asks its host page to copy instead.
  function addCopyButtons(root, copyText) {
    const copy = copyText || ((t) => global.navigator.clipboard.writeText(t));
    if (!root.querySelectorAll) return;
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return;
      const btn = global.document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "copy";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code");
        let text;
        if (code) {
          text = code.textContent;
        } else {
          // no <code> — copy the <pre> text but exclude this button's own "copy" label
          const clone = pre.cloneNode(true);
          const b = clone.querySelector(".copy-btn");
          if (b) b.remove();
          text = clone.textContent;
        }
        const flash = (label) => {
          btn.textContent = label;
          global.setTimeout(() => (btn.textContent = "copy"), 1200);
        };
        Promise.resolve().then(() => copy(text)).then(() => flash("copied"), () => flash("failed"));
      });
      pre.appendChild(btn);
    });
  }

  // The sanctioned way to place rendered markdown in the DOM: sanitized innerHTML, then enhance.
  function renderMarkdownInto(el, text, opts) {
    el.innerHTML = renderMarkdown(text, opts);
    addCopyButtons(el, opts && opts.copyText);
  }

  global.renderMarkdown = renderMarkdown;
  global.renderMarkdownInto = renderMarkdownInto;
  // node (test) — jsdom supplies window for DOMPurify.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderMarkdown, renderMarkdownInto, md, mdUser, DP_CONFIG };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
