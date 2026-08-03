// markdown.js — the single sanitized path from remote/user markdown text to HTML.
//
// Agent replies (and the user's own messages) arrive as markdown. Rendering them means an
// `innerHTML` sink, and that text is remote-controlled (a compromised/MITM ACP server, or a
// page the agent read, can inject a string), so an unsanitized sink here is a remote-XSS that
// could exfiltrate the side panel's chrome.storage tokens (see ADR
// `docs/adr/chat-markdown-rendering.md` §1.2). `renderMarkdown` is therefore the ONLY sanctioned
// route from remote text to innerHTML: `md.render` → `DOMPurify.sanitize` (mandatory).
//
// Depends on the vendored globals `markdownit`, `DOMPurify`, and `hljs` (loaded before this file).
(function (global) {
  "use strict";

  const hljs = global.hljs;

  // Highlight a fenced block inside markdown-it's `highlight` hook (§3.4); the whole rendered
  // output is DOMPurify-sanitized once afterward (§2 convention). Unknown/omitted languages fall
  // back to escaped plain code. Always returns a full <pre><code> so markdown-it does not re-wrap.
  function highlightFence(str, lang) {
    if (lang && hljs && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        return '<pre class="hljs"><code class="language-' + lang + '">' + out + "</code></pre>\n";
      } catch (_) { /* fall through to plain */ }
    }
    return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + "</code></pre>\n";
  }

  // html:false ⇒ any raw HTML in the message is ESCAPED to text before it ever reaches the
  // sanitizer (double defense); linkify auto-links bare URLs. GFM-style pipe tables are on in
  // markdown-it's default preset — the readability fix this ADR is motivated by (§1.1).
  const md = global.markdownit({ html: false, linkify: true, highlight: highlightFence });

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

  // The only path remote text may take to reach innerHTML. A lint/grep rule bans any other
  // `innerHTML =` of remote text (streaming stays textContent; system notices stay textContent).
  function renderMarkdown(text) {
    const html = md.render(text == null ? "" : String(text));
    return global.DOMPurify.sanitize(html, DP_CONFIG);
  }

  // Add a copy button to each code block. Built with createElement AFTER sanitize, reading the
  // code via textContent — NEVER concatenated into the markdown HTML string before sanitizing
  // (§3.4). The button lives in <pre> (not <code>), so it is excluded from the copied text.
  function addCopyButtons(root) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll("pre").forEach((pre) => {
      if (pre.querySelector(".copy-btn")) return;
      const btn = global.document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "copy";
      btn.addEventListener("click", () => {
        const code = pre.querySelector("code");
        const flash = (label) => {
          btn.textContent = label;
          global.setTimeout(() => (btn.textContent = "copy"), 1200);
        };
        global.navigator.clipboard
          .writeText(code ? code.textContent : pre.textContent)
          .then(() => flash("copied"), () => flash("failed"));
      });
      pre.appendChild(btn);
    });
  }

  // The sanctioned way to place rendered markdown in the DOM: sanitized innerHTML, then enhance.
  function renderMarkdownInto(el, text) {
    el.innerHTML = renderMarkdown(text);
    addCopyButtons(el);
  }

  global.renderMarkdown = renderMarkdown;
  global.renderMarkdownInto = renderMarkdownInto;
  // node (test) — jsdom supplies window for DOMPurify.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { renderMarkdown, renderMarkdownInto, md, DP_CONFIG };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
