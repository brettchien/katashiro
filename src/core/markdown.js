// markdown.js — the single sanitized path from remote/user markdown text to HTML.
//
// Agent replies (and the user's own messages) arrive as markdown. Rendering them means an
// `innerHTML` sink, and that text is remote-controlled (a compromised/MITM ACP server, or a
// page the agent read, can inject a string), so an unsanitized sink here is a remote-XSS that
// could exfiltrate the side panel's chrome.storage tokens (see ADR
// `docs/adr/chat-markdown-rendering.md` §1.2). `renderMarkdown` is therefore the ONLY sanctioned
// route from remote text to innerHTML: `md.render` → `DOMPurify.sanitize` (mandatory).
//
// Depends on the vendored globals `markdownit` (with `markdownitContainer`, `markdownitGithubAlerts`,
// `markdownitFootnote`, `markdownitMark`, `markdownitIns` and `markdownitDeflist`, bundled in the same
// file), `DOMPurify`, and `hljs` (loaded before this file).
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

  // The ::: containers buildMd registers (see there). Exported for the test against
  // CanvasCore.CONTAINER_NAMES (the normalizer's list).
  const CONTAINER_NAMES = ["cards", "stats", "matrix", "bars"];
  // canvas_patch's range marks (CanvasCore.MARK_OPEN / MARK_CLOSE / MARK_POINT; a unit test checks the
  // two agree): a detached copy carries them in its text, so a cell is read without them.
  const RANGE_MARKS = /[᨞᨟᪨]/g;

  // html:false ⇒ any raw HTML in the message is ESCAPED to text before it ever reaches the
  // sanitizer (double defense); linkify auto-links bare URLs. GFM-style pipe tables are on in
  // markdown-it's default preset — the readability fix this ADR is motivated by (§1.1).
  // `extra` only ever adds `breaks` (the user's own messages, below); every rule is the same.
  // briefing: the canvas's own transforms of the briefing blocks (ADR canvas-themes §2.4: accent hues,
  // the title row, own-number detection, matrix / bars). The chat parsers recognise the containers
  // but leave their content plain — the side panel has no styles for them (canvas-themes Q5).
  function buildMd(extra, { briefing = false } = {}) {
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

    // Containers (markdown-it-container, vendored in the markdown-it bundle): `::: cards` (ADR canvas §3.3
    // "Cards and callouts") and the briefing blocks of ADR canvas-themes §2.4 — `::: stats`, `::: matrix`,
    // `::: bars`. Only these names are registered, so any other `::: foo` stays plain text. Each gets one
    // CONSTANT class, its name; the info string after the name is never copied into the markup — the
    // only word read from it is `accent` after `cards` (§2.4 a), which adds a second constant class.
    // markdown-it-container's own default render would also only use the name; ours spells it out so that
    // stays true whatever the plugin does. CanvasCore.CONTAINER_NAMES (the normalizer's marker padding,
    // canvas §3.5) must list the same names — a unit test checks it.
    if (global.markdownitContainer) {
      for (const name of CONTAINER_NAMES) {
        md.use(global.markdownitContainer, name, {
          validate: (params) => params.trim().split(/\s+/, 1)[0] === name,
          render: (tokens, idx, options, env, slf) => {
            if (tokens[idx].nesting === 1) {
              tokens[idx].attrJoin("class", name);
              if (tokens[idx].meta && tokens[idx].meta.accent) tokens[idx].attrJoin("class", "cards-accent");   // set by the cards rule
            }
            return slf.renderToken(tokens, idx, options);
          },
        });
      }
    }
    // The accent order (ADR canvas-themes §2.3): accent cards, matrix mark columns and bar rows take their
    // hue in it, as the constant class ks-hue-<name> (canvas-frame.css sets the --ks-hue* variables).
    const ACCENT = ["orange", "blue", "purple", "green", "yellow", "pink", "teal", "sand", "slate"];
    const hueClass = (i) => `ks-hue-${ACCENT[i % ACCENT.length]}`;

    // Numbered sections (§2.4 c) are CSS on the light theme. A document that numbers its own top-level
    // `##` would show both numbers: when at least two of them, and at least half, start with a section
    // number, every top-level h2 gets the constant class ks-own-number, which the CSS leaves unnumbered.
    // A section number is followed by a separator, never just a space, so `2024 review`, `3 大趨勢`,
    // `3-day plan` and `CLI usage` are not one:
    //   1. 2) 3、 4： 5 — (also full-width digits) · (1) （一） · ① · 一、 壹、 · 第一章 · IV. ii) A. ·
    //   Step 1 / Part 2 / Chapter 3 / Section 4 · §1 — bold, or as a link's text, too.
    const OWN_NUMBER = new RegExp("^\\s*(?:\\*\\*|\\[)?\\s*(?:" + [
      "[0-9０-９]+\\s*(?:[.)、．:：]|\\s[—–])",
      "[(（](?:[0-9０-９]+|[一二三四五六七八九十]+)[)）]",
      "[\\u2460-\\u2473]",
      "[一二三四五六七八九十百]+[、．.]",
      "[壹貳參叁肆伍陸柒捌玖拾]+[、．.]",
      "第[一二三四五六七八九十百0-9０-９]+[章節节部篇]",
      "[IVX]+[.)]", "[ivx]+[.)]", "[A-Z][.)]\\s",
      "(?:Step|Part|Chapter|Section)\\s+[0-9]+",
      "§\\s*[0-9]+",
    ].join("|") + ")");
    if (briefing) md.core.ruler.after("inline", "own_section_numbers", (state) => {
      const t = state.tokens;
      const h2 = [];
      for (let i = 0; i < t.length; i++) if (t[i].type === "heading_open" && t[i].tag === "h2" && t[i].level === 0) h2.push(i);
      const own = h2.filter((i) => t[i + 1] && OWN_NUMBER.test(t[i + 1].content.replace(RANGE_MARKS, ""))).length;
      if (own < 2 || own * 2 < h2.length) return;
      for (const i of h2) t[i].attrJoin("class", "ks-own-number");
    });

    // `::: matrix` and `::: bars` (§2.4 d, e) around a table: constant classes and two token kinds only.
    const DOTS = { "●": "ks-dot-full", "○": "ks-dot-ring", "◐": "ks-dot-half" };
    const BAR = /^(\d{1,4})\s*\/\s*(\d{1,4})$/;
    const BAR_HEAD = /\/\s*(\d{1,4})\s*$/;          // the column header states N: `提及場次 / 18`
    const TOTAL_NUM = /^(?:\*\*)?(\d+)(?:\*\*)?(?:\s*([(（].+[)）]))?$/;   // 5, **5**, 5 (4●), 5（4●）
    // A <meter> (a measurement, n of N — not a task's progress), named for screen readers; the cell's
    // own text says n. Integers only, checked when the token was made.
    md.renderer.rules.ks_bar = (tokens, idx) => {
      const { n, N } = tokens[idx].meta;
      return `<meter class="ks-bar-track" min="0" max="${N}" value="${n}" aria-label="${n} / ${N}"></meter> `;
    };
    md.renderer.rules.ks_sub_open = () => '<span class="ks-sub">';
    md.renderer.rules.ks_sub_close = () => "</span>";
    const cellText = (c) => (c && c.inline && c.inline.type === "inline" ? c.inline.content.replace(RANGE_MARKS, "").trim() : "");
    const unbold = (x) => x.replace(/^\*\*(.*)\*\*$/, "$1").trim();   // `**12/18**` is still a bar value
    // markdown-it puts an empty text token before a leading **: the first child that carries something.
    const ledByBold = (c) => {
      const lead = c && (c.inline.children || []).find((ch) => !(ch.type === "text" && ch.content === ""));
      return !!lead && lead.type === "strong_open";
    };
    /** The table's rows: { head: [row], body: [row] }, a row = { tr, cells: [{ open, inline }] }. */
    function tableRows(t, from, to) {
      const head = [], body = [];
      let section = null;
      for (let k = from; k < to; k++) {
        const x = t[k];
        if (x.type === "thead_open") section = head;
        else if (x.type === "tbody_open") section = body;
        else if (x.type === "tr_open" && section) section.push({ tr: x, cells: [] });
        else if ((x.type === "th_open" || x.type === "td_open") && section && section.length) section[section.length - 1].cells.push({ open: x, inline: t[k + 1] });
      }
      return { head, body };
    }
    /** matrix: the totals row — the last body row led by bold text (`**合計**`), when no row above it is:
     *  bold row labels everywhere are labels, not a total. */
    function totalsRow(body) {
      const lead = (r) => r.cells.find((c) => cellText(c) !== "");
      const last = body[body.length - 1];
      if (!last || body.length < 2 || !ledByBold(lead(last))) return null;
      // An emphasised data row (dots or a bar value in it) is not a total.
      if (last.cells.some((c) => DOTS[cellText(c)] || BAR.test(unbold(cellText(c))))) return null;
      return body.slice(0, -1).some((r) => ledByBold(lead(r))) ? null : last;
    }
    /** matrix: mark columns (body cells only dots or empty, at least one dot; a number or nothing in the
     *  totals row) get .ks-mark + a hue, their dot cells .ks-dot-*; a header cell never becomes a dot. */
    function markColumns(head, data, total) {
      const cols = Math.max(0, ...[...head, ...data].map((r) => r.cells.length));
      let marks = 0;
      for (let c = 0; c < cols; c++) {
        const cells = data.map((r) => r.cells[c]);
        const isMark = cells.length > 0 && cells.every((x) => cellText(x) === "" || DOTS[cellText(x)]) && cells.some((x) => DOTS[cellText(x)])
          && (!total || !DOTS[cellText(total.cells[c])]);   // the total cell: anything (5, 5 (4●), —, 4.5)
        if (!isMark) continue;
        const hue = hueClass(marks++);
        for (const r of head) if (r.cells[c]) r.cells[c].open.attrJoin("class", `ks-mark ${hue}`);
        for (const r of [...data, ...(total ? [total] : [])]) {
          const x = r.cells[c];
          if (!x) continue;
          x.open.attrJoin("class", `ks-mark ${hue}`);
          if (DOTS[cellText(x)]) x.open.attrJoin("class", `ks-dot ${DOTS[cellText(x)]}`);
        }
      }
    }
    /** matrix totals row: `5 (4●)` → 5 and the bracket as .ks-sub — the text split where the bracket
     *  starts, so its spacing and any range marks stay as written. */
    function totalsSubs(state, total) {
      for (const x of total.cells) {
        const m = TOTAL_NUM.exec(cellText(x));
        const ch = x.inline && x.inline.children;
        if (!m || !m[2] || !ch) continue;
        // The bracket is in the last text child (after a **bold** number, too).
        const k = ch.length - 1;
        const at = k >= 0 && ch[k].type === "text" ? ch[k].content.search(/[(（]/) : -1;
        if (at < 0) continue;
        const a = new state.Token("text", "", 0); a.content = ch[k].content.slice(0, at);
        const o = new state.Token("ks_sub_open", "span", 1);
        const b = new state.Token("text", "", 0); b.content = ch[k].content.slice(at);
        const cl = new state.Token("ks_sub_close", "span", -1);
        x.inline.children = [...ch.slice(0, k), a, o, b, cl];
      }
    }
    /** matrix and bars: a BAR column — its header ends in `/ N` and every filled body cell is `n/N` with
     *  that N (0 ≤ n ≤ N ≤ 1000; spaces and **bold** allowed) — gets a <meter> and n per cell; the rows with a bar take a hue. A
     *  date `11/12` in another column stays text. */
    function barColumns(state, head, data) {
      const cols = Math.max(0, ...head.map((r) => r.cells.length));
      const barCols = [];
      for (let c = 0; c < cols; c++) {
        const hm = head.length && BAR_HEAD.exec(cellText(head[head.length - 1].cells[c]));
        const N = hm ? Number(hm[1]) : 0;
        if (!(N > 0 && N <= 1000)) continue;
        const filled = data.map((r) => cellText(r.cells[c])).filter((x) => x !== "");
        if (filled.length && filled.every((x) => { const m = BAR.exec(unbold(x)); return m && Number(m[2]) === N && Number(m[1]) <= N; })) barCols.push(c);
      }
      let barRows = 0;
      for (const r of data) {
        let any = false;
        for (const c of barCols) {
          const x = r.cells[c];
          const m = BAR.exec(unbold(cellText(x)));
          if (!m) continue;
          const bar = new state.Token("ks_bar", "meter", 0);
          bar.meta = { n: Number(m[1]), N: Number(m[2]) };
          // n as written, range marks included (the part before "/"), so a patch's exact range survives.
          const ch = x.inline.children;
          const raw = ch && ch.length === 1 && ch[0].type === "text" ? ch[0].content : m[1];
          const slash = raw.indexOf("/");
          // n as written plus any range mark that stood after N (a patch of the whole `n/N`).
          const own = slash < 0 ? raw : raw.slice(0, slash).trim() + (raw.slice(slash).match(RANGE_MARKS) || []).join("");
          const num = new state.Token("text", "", 0); num.content = own;
          x.inline.children = [bar, num];
          x.open.attrJoin("class", "ks-bar");
          any = true;
        }
        if (any) r.tr.attrJoin("class", hueClass(barRows++));
      }
    }
    function shapeTable(state, t, from, to, kind) {
      const { head, body } = tableRows(t, from, to);
      const total = kind === "matrix" ? totalsRow(body) : null;
      const data = total ? body.slice(0, -1) : body;
      if (total) {
        total.tr.attrJoin("class", "ks-total");
        totalsSubs(state, total);
      }
      if (kind === "matrix") markColumns(head, data, total);
      barColumns(state, head, data);
    }
    if (briefing) md.core.ruler.after("inline", "matrix_bars", (state) => {
      const t = state.tokens;
      if (!t.some((x) => x.type === "container_matrix_open" || x.type === "container_bars_open")) return;
      const stack = [];
      for (let i = 0; i < t.length; i++) {
        const x = t[i];
        if (x.type === "container_matrix_open" || x.type === "container_bars_open") stack.push(x.type === "container_matrix_open" ? "matrix" : "bars");
        else if (x.type === "container_matrix_close" || x.type === "container_bars_close") stack.pop();
        else if (x.type === "table_open" && stack.length) {
          let end = i + 1;
          while (end < t.length && t[end].type !== "table_close") end++;
          shapeTable(state, t, i, end, stack[stack.length - 1]);
          i = end;
        }
      }
    });

    // Each card: every DIRECT-child `###` of a cards container starts one; blocks before the first
    // `###` (if any) are a card of their own. Direct child = one level below the container's token,
    // so an h3 inside a list, quote, alert or nested container never splits the outer row (a nested
    // cards container gets its own cards; the outer one needs the longer fence, `::::`, or the inner
    // `:::` closes it). The card tokens are plain `div`s with a constant class
    // (rendered by markdown-it's renderToken, no rule needed); their source lines run from their
    // first block to the next card (or the closing `:::`), so the canvas's Ask agent can name them. In a
    // `::: cards accent` block each ### card also takes the next hue class (the order restarts per block;
    // a preamble card before the first ### takes none, so the first ### is always the first hue).
    md.core.ruler.after("block", "cards", (state) => {
      if (!state.tokens.some((t) => t.type === "container_cards_open")) return;
      const out = [];
      const stack = [];                   // open cards containers: { open, orig level, card, accent, n }
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
            if (briefing && top.accent && h3) c.attrJoin("class", hueClass(top.n++));   // a preamble card takes no hue
            if (t.map) c.map = [t.map[0], t.map[1]];
            out.push(c);
            top.card = c;
          }
        }
        t.level = orig + stack.length;    // everything inside a container now sits inside a card
        out.push(t);
        if (t.type === "container_cards_open") {
          const accent = t.info.trim().split(/\s+/).slice(1).includes("accent");   // `::: cards accent`
          if (accent && briefing) t.meta = { ...(t.meta || {}), accent: true };
          stack.push({ open: t, level: orig, card: null, accent, n: 0 });
        }
      }
      state.tokens = out;
    });
    // `::: stats` (§2.4 b): a row of KPI tiles — each list item `- **3** 天`, the bold run the number, the
    // rest the label (canvas-frame.css). Right after the document's first `# Title`, the two are wrapped in
    // a constant .ks-title-row so the tiles sit right of the title on a wide tab (below on a narrow one).
    // Runs after the cards rule, which reads token levels: this one shifts them.
    if (briefing) md.core.ruler.after("cards", "stats_title_row", (state) => {
      const t = state.tokens;
      const h = t.findIndex((x) => x.type === "heading_open" && x.tag === "h1" && x.level === 0);
      if (h < 0 || !t[h + 3] || t[h + 3].type !== "container_stats_open") return;
      let end = h + 3, depth = 0;
      for (; end < t.length; end++) {
        if (t[end].type === "container_stats_open") depth++;
        else if (t[end].type === "container_stats_close" && --depth === 0) break;
      }
      if (end >= t.length) return;
      for (let k = h; k <= end; k++) t[k].level++;   // they now sit inside the row
      const open = new state.Token("title_row_open", "div", 1);
      open.block = true;
      open.attrSet("class", "ks-title-row");
      if (t[h].map && t[h + 3].map) open.map = [t[h].map[0], t[h + 3].map[1]];
      const close = new state.Token("title_row_close", "div", -1);
      close.block = true;
      t.splice(end + 1, 0, close);
      t.splice(h, 0, open);
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

    // Footnotes `[^1]`, ==highlight== (<mark>), ++underline++ (<ins>) and definition lists (ADR canvas
    // §3.3 "Footnotes, highlight, underline, definition lists"; markdown-it's own plugins, vendored with
    // it). Chosen because Milkdown normalization (§3.5) writes each of them back unchanged (checked
    // with the vendored crepe 7.22.3; ~sub~, *[abbr] and [[toc]] did not survive and are left out).
    // Their markup is plain HTML the html profile keeps. A footnote's `#fn1` / `#fnref1` links lose
    // their href to the link hook below (http(s)/mailto only), so a reference is a plain superscript
    // number and the ↩ back-links are hidden by the stylesheets: no fragment navigation in the frame.
    for (const name of ["markdownitFootnote", "markdownitMark", "markdownitIns", "markdownitDeflist"]) {
      if (global[name]) md.use(global[name]);
    }
    // `==` inside words is code more often than a highlight: markdown-it-mark would turn
    // `x==1 or y==2` into x<mark>1 or y</mark>2 and drop both `==`. As GFM does for an intraword `_`,
    // a pair whose opener follows a letter/digit AND whose closer is followed by one goes back to
    // plain `==` text. ASCII only, so CJK text (no spaces between words) still highlights.
    const ASCII_ALNUM = /[A-Za-z0-9]/;
    const revertMark = (tok) => { tok.type = "text"; tok.tag = ""; tok.nesting = 0; tok.content = tok.markup; };
    md.core.ruler.after("inline", "intraword_mark", (state) => {
      for (const blk of state.tokens) {
        if (blk.type !== "inline" || !blk.children) continue;
        const ch = blk.children, open = [];
        for (let i = 0; i < ch.length; i++) {
          if (ch[i].type === "mark_open") open.push(i);
          else if (ch[i].type === "mark_close" && open.length) {
            const o = open.pop(), before = ch[o - 1], after = ch[i + 1];
            if (before && before.type === "text" && ASCII_ALNUM.test(before.content.slice(-1)) &&
                after && after.type === "text" && ASCII_ALNUM.test(after.content[0] || "")) {
              revertMark(ch[o]);
              revertMark(ch[i]);
            }
          }
        }
      }
    });

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

  // Agent replies: a single newline is a soft break, rendered as a space — the CommonMark default,
  // left as is on purpose (agent text is wrapped markdown).
  const md = buildMd({});
  // The canvas (renderMarkdown{canvas:true}): the same, plus the briefing blocks' transforms.
  const mdCanvas = buildMd({}, { briefing: true });
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
    const parser = opts && opts.userText === true ? mdUser : opts && opts.canvas === true ? mdCanvas : md;
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
    module.exports = { renderMarkdown, renderMarkdownInto, md, mdUser, mdCanvas, DP_CONFIG, CONTAINER_NAMES, RANGE_MARKS };
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
