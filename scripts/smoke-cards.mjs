#!/usr/bin/env node
// smoke-cards.mjs — cards and callouts (ADR docs/adr/canvas.md §3.3 "Cards and callouts") in the real
// canvas frame, under the real sandbox CSP, through Milkdown normalization (§3.5). Needs a Chrome, so
// it is not part of `node --test`:
//
//   npm ci && npm run chrome     # once
//   node scripts/smoke-cards.mjs [screenshot.png]      # or `npm run smoke` for all of them
//
// (CHROME / PUPPETEER_CORE override the Chrome and puppeteer-core it uses: see scripts/lib/smoke-env.mjs.)
//
// Same harness as smoke-editor-undo.mjs, with a second frame for the deck (a frame shows one kind). Checks:
//   - a markdown canvas whose cards end with a table, a quote, a list, an alert and a code fence (the
//     cases crepe folds an unpadded closing `:::` into) renders the expected `.card`s and
//     `.markdown-alert`s, with the classes kept by the real DOMPurify and no <svg>;
//   - render{normalizeText} (the agent-write path, as smoke-mermaid step 4): the normalized text has
//     no `| ::: |` row, `> :::` or indented `:::`, renders the same cards and alerts, keeps the
//     escaped `\[!NOTE]` an alert, and normalizing it again changes nothing;
//   - the editor round trip: edit{} with the unpadded text, then a save, renders the same again;
//   - layout: cards side by side on a wide frame, stacked on a narrow one; print keeps a card whole;
//   - a slides canvas with cards renders them; no CSP violation.
// Screenshots (default /tmp/ks-shots/cards.png): the document, and -slides.png beside it.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./lib/smoke-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOT = process.argv[2] || "/tmp/ks-shots/cards.png";
fs.mkdirSync(path.dirname(SHOT), { recursive: true });

// Unpadded on purpose: every closing `:::` sits right after the block that would swallow it.
const FIXTURE = `# Cards and callouts

::: cards
A preamble card: text before the first heading.
### Table at the end
| plan | price |
|---|---|
| spot | $1 |
:::

::: cards
### Quote at the end
Some text.
> quoted last line
### List at the end
- one
- two
### Alert at the end
> [!TIP]
> Tip inside a card.
### Code at the end
\`\`\`js
const x = 1;
\`\`\`
:::

::: cards
### Headings in a quote stay
> ### not a card
:::

> [!NOTE]
> Useful information.

> [!IMPORTANT] Custom title
> Crucial.

> [!WARNING]
> Careful.

> [!CAUTION]
> Dangerous.

> \\[!NOTE]
> Escaped, as Milkdown writes it.

> ⚠️ Watch out: this *breaks*.

> ℹ️ Info line.

> ✅ Done.

## Inline extras

A ==highlighted== word, an ++underlined++ one, and a footnote[^1].

Term
: Its definition.

[^1]: The footnote text.

::: foo
not a container
:::
`;
const WANT = { containers: 3, cards: 7, alerts: 9, emoji: 3, titles: 6 };

const SLIDES = `# Deck

---

## Options

::: cards
### Spot
Cheap, can be reclaimed.
### On-demand
Steady.
### Savings plan
Committed.
:::

> [!WARNING]
> Spot has no graceful stop.

---

## Prices

| plan | price |
|---|--:|
| spot | $1 |
| on-demand | $3 |
`;

const sandboxCsp = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).content_security_policy.sandbox;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const HOST = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<iframe id="f" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce0" style="width:1100px;height:900px;border:0;display:block"></iframe>
<iframe id="s" sandbox="allow-scripts allow-modals" src="/canvas-frame.html#nonce1" style="width:1100px;height:700px;border:0;display:block"></iframe>
<script>
  window.__msgs = [];
  addEventListener("message", (e) => { if (e.data && /^nonce[01]$/.test(e.data.nonce)) __msgs.push(e.data); });
  window.__send = (msg, id = "f") => document.getElementById(id).contentWindow.postMessage({ ...msg, nonce: id === "f" ? "nonce0" : "nonce1" }, "*");
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__host.html") { res.writeHead(200, { "content-type": "text/html" }); res.end(HOST); return; }
  const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const headers = { "content-type": TYPES[path.extname(file)] || "application/octet-stream" };
  if (url.pathname === "/canvas-frame.html") headers["content-security-policy"] = sandboxCsp;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await launch();
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok   ${msg}`);
const check = (cond, msg, got) => (cond ? ok(msg) : fail(`${msg}: ${JSON.stringify(got)}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  await page.evaluateOnNewDocument(() => {
    window.__ksViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__ksViolations.push({ directive: e.effectiveDirective || e.violatedDirective, blockedURI: e.blockedURI, sourceFile: e.sourceFile, sample: e.sample });
    });
  });
  page.on("pageerror", (e) => fail(`page error: ${e.message}`));
  await page.goto(`${origin}/__host.html`, { waitUntil: "load" });
  const msgs = () => page.evaluate(() => window.__msgs);
  const waitFor = async (pred, what, ms = 30000) => {
    const end = Date.now() + ms;
    for (;;) {
      const found = (await msgs()).find(pred);
      if (found) return found;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };
  const send = (m, id = "f") => page.evaluate((x, i) => __send(x, i), m, id);
  await waitFor((m) => m.type === "ready" && m.nonce === "nonce0", "ready");
  await waitFor((m) => m.type === "ready" && m.nonce === "nonce1", "slides frame ready");
  const frame = page.frames().find((f) => f.url().endsWith("#nonce0"));
  const slidesFrame = page.frames().find((f) => f.url().endsWith("#nonce1"));
  const shape = (root = "#doc", fr = frame) => fr.evaluate((r) => {
    const el = document.querySelector(r);
    return {
      containers: el.querySelectorAll(".cards").length,
      cards: el.querySelectorAll(".cards > .card").length,
      alerts: el.querySelectorAll(".markdown-alert").length,
      emoji: el.querySelectorAll("blockquote.markdown-alert.markdown-alert-emoji").length,
      titles: el.querySelectorAll(".markdown-alert > p.markdown-alert-title").length,
      kinds: Array.from(el.querySelectorAll(".markdown-alert"), (a) => a.className.replace(/markdown-alert(?!-)|markdown-alert-emoji/g, "").trim()),
      svgs: el.querySelectorAll("svg").length,
      strayMarkers: Array.from(el.querySelectorAll("td, li, blockquote p, .card p"), (n) => n.textContent.trim()).filter((t) => t === ":::").length,
      foo: el.textContent.includes("::: foo"),
      cardsHtml: el.querySelectorAll(".card h3").length,
    };
  }, root);
  const same = (s, what) => {
    const got = { containers: s.containers, cards: s.cards, alerts: s.alerts, emoji: s.emoji, titles: s.titles };
    check(JSON.stringify(got) === JSON.stringify(WANT), `${what}: ${WANT.containers} card rows, ${WANT.cards} cards, ${WANT.alerts} callouts (${WANT.emoji} emoji, ${WANT.titles} titled)`, got);
    check(s.svgs === 0 && s.strayMarkers === 0 && s.foo, `${what}: no <svg>, no stray ":::" cell / paragraph, "::: foo" stays text`, s);
  };

  // 1. The agent's text as written.
  await send({ type: "render", kind: "markdown", version: 1, seq: 1, content: FIXTURE });
  await waitFor((m) => m.nonce === "nonce0" && m.type === "rendered" && m.seq === 1, "render 1");
  const s1 = await shape();
  same(s1, "as written");
  check(JSON.stringify(s1.kinds) === JSON.stringify(["markdown-alert-tip", "markdown-alert-note", "markdown-alert-important", "markdown-alert-warning", "markdown-alert-caution", "markdown-alert-note", "markdown-alert-warning", "markdown-alert-note", "markdown-alert-tip"]), "callout kinds in order", s1.kinds);
  const title = await frame.evaluate(() => document.querySelector(".markdown-alert-important .markdown-alert-title").textContent);
  check(title === "Custom title", "a custom alert title is its text", title);
  const wrap = await frame.evaluate(() => { const t = document.querySelector("#doc table"); return t && t.parentElement.className; });
  check(wrap === "table-wrap", "a table sits in its .table-wrap after the real DOMPurify", wrap);

  // Layout: side by side when wide, stacked when narrow.
  const tops = () => frame.evaluate(() => Array.from(document.querySelectorAll("#doc .cards")[1].children, (c) => Math.round(c.getBoundingClientRect().top)));
  const wide = await tops();
  check(wide.length === 4 && wide[0] === wide[1] && wide[1] === wide[2], "wide frame: the cards sit side by side", wide);
  const grid = await frame.evaluate(() => getComputedStyle(document.querySelector("#doc .cards")).display);
  check(grid === "grid", ".cards is a grid", grid);
  // The whole document in one shot: the frame as tall as its content, then back.
  const fullH = await frame.evaluate(() => document.documentElement.scrollHeight);
  await page.evaluate((h) => { document.getElementById("f").style.height = h + "px"; }, fullH);
  await sleep(300);
  await (await page.$("#f")).screenshot({ path: SHOT });
  await page.evaluate(() => { document.getElementById("f").style.height = "900px"; });
  ok(`screenshot ${SHOT}`);
  await page.evaluate(() => { document.getElementById("f").style.width = "360px"; });
  await sleep(300);
  const narrow = await tops();
  check(new Set(narrow).size === narrow.length, "narrow frame: the cards stack", narrow);
  await page.evaluate(() => { document.getElementById("f").style.width = "1100px"; });
  await page.emulateMediaType("print");
  const brk = await frame.evaluate(() => [getComputedStyle(document.querySelector("#doc .card")).breakInside, getComputedStyle(document.querySelector("#doc .markdown-alert")).breakInside]);
  check(brk[0] === "avoid" && brk[1] === "avoid", "print: cards and callouts are not split across pages", brk);
  await page.emulateMediaType(null);

  // Footnotes, ==mark==, ++ins++, definition lists (§3.3): rendered, the footnote links inert.
  const extras = () => frame.evaluate(() => {
    const d = document.querySelector("#doc");
    const ref = d.querySelector("sup.footnote-ref a");
    const back = d.querySelector(".footnote-backref");
    return { mark: d.querySelectorAll("mark").length, ins: d.querySelectorAll("ins").length, dl: d.querySelectorAll("dl dt + dd").length,
      notes: d.querySelectorAll("section.footnotes li").length, refHref: ref ? ref.getAttribute("href") : "missing",
      backShown: back ? getComputedStyle(back).display !== "none" : false };
  });
  const EXTRAS = { mark: 1, ins: 1, dl: 1, notes: 1, refHref: null, backShown: false };
  check(JSON.stringify(await extras()) === JSON.stringify(EXTRAS), "footnote / mark / ins / deflist render; footnote links have no href, back-links hidden", await extras());

  // 2. Normalization (the agent-write path).
  await send({ type: "render", kind: "markdown", version: 2, seq: 2, content: FIXTURE, normalizeText: FIXTURE });
  const n = await waitFor((m) => m.nonce === "nonce0" && m.type === "rendered" && m.seq === 2, "normalized render", 60000);
  const norm = n.normalized;
  if (typeof norm !== "string") fail("no normalized text came back");
  else {
    check(!/^\|\s*:::|^>\s*:::|^ +:::/m.test(norm), "normalized text: no ':::' folded into a table row, quote or list", norm);
    check(/^> \\?\[!NOTE\]/m.test(norm), "normalized text keeps the alert markers", norm);
    await send({ type: "render", kind: "markdown", version: 3, seq: 3, content: norm, normalizeText: norm });
    const n2 = await waitFor((m) => m.nonce === "nonce0" && m.type === "rendered" && m.seq === 3, "renormalized render", 60000);
    same(await shape(), "after normalization");
    check(/==highlighted==/.test(norm) && /\+\+underlined\+\+/.test(norm) && /footnote\[\^1\]/.test(norm) && /^: Its definition\./m.test(norm), "normalized text keeps ==, ++, [^1] and the definition list", norm);
    check(JSON.stringify(await extras()) === JSON.stringify(EXTRAS), "footnote / mark / ins / deflist after normalization", await extras());
    check(n2.normalized === norm, "normalization is idempotent", n2.normalized);
  }

  // 3. The editor: load the unpadded text, save, render the saved text.
  await send({ type: "edit", version: 3, content: FIXTURE });
  await frame.waitForSelector("#editor .ProseMirror", { timeout: 20000 });
  await sleep(200);
  await send({ type: "requestSave" });
  const sv = await waitFor((m) => m.type === "save", "save");
  await send({ type: "leaveEdit" });
  await send({ type: "render", kind: "markdown", version: 4, seq: 4, content: sv.content });
  await waitFor((m) => m.nonce === "nonce0" && m.type === "rendered" && m.seq === 4, "render saved");
  same(await shape(), "after an editor load + save");
  if (typeof norm === "string") check(sv.content === norm, "the editor saves the normalized text (opening it changes nothing)", sv.content);

  // 4. Slides.
  await send({ type: "render", kind: "slides", version: 1, seq: 5, content: SLIDES }, "s");
  await waitFor((m) => m.nonce === "nonce1" && m.type === "rendered" && m.seq === 5, "slides");
  await send({ type: "goto", slide: 2 }, "s");
  await waitFor((m) => m.type === "slide", "slide 2");
  await sleep(600);
  const sl = await shape("#deck", slidesFrame);
  check(sl.cards === 3 && sl.alerts === 1 && sl.svgs === 0, "slides: 3 cards and a callout on slide 2", sl);
  const slideTops = await slidesFrame.evaluate(() => Array.from(document.querySelectorAll("#deck .card"), (c) => Math.round(c.getBoundingClientRect().top)));
  check(new Set(slideTops).size === 1, "slides: the three cards side by side", slideTops);
  await (await page.$("#s")).screenshot({ path: SHOT.replace(/\.png$/, "-slides.png") });
  ok(`screenshot ${SHOT.replace(/\.png$/, "-slides.png")}`);
  // The editorial table style beats the dracula theme's `.reveal table th/td` (ADR §3.3 "Tables").
  await send({ type: "goto", slide: 3 }, "s");
  await waitFor((m) => m.type === "slide" && m.index === 3, "slide 3");
  await sleep(600);
  const cell = await slidesFrame.evaluate(() => {
    const st = (q) => getComputedStyle(document.querySelector(q));
    const th = st("#deck table th"), td = st("#deck table td"), last = st("#deck table tbody tr:last-child td");
    return { wrap: document.querySelector("#deck table").parentElement.className, th: [th.borderBottomWidth, th.borderBottomColor, th.fontWeight, th.paddingLeft], td: [td.borderBottomWidth, td.borderBottomColor], last: last.borderBottomStyle };
  });
  check(cell.wrap === "table-wrap" && JSON.stringify(cell.th) === JSON.stringify(["2px", "rgb(203, 213, 225)", "600", "0px"]) && JSON.stringify(cell.td) === JSON.stringify(["1px", "rgba(255, 255, 255, 0.12)"]) && cell.last === "none", "slides: the table has the editorial rules, not the theme's", cell);

  let violations = [];
  for (const fr of page.frames()) violations = violations.concat(await fr.evaluate(() => window.__ksViolations || []));
  check(violations.length === 0, "no CSP violation", violations);
  const errors = (await msgs()).filter((m) => m.type === "error" || m.type === "editFailed");
  check(errors.length === 0, "no frame error{}", errors);
  await page.close();
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : "\ncards smoke test passed");
process.exit(failures.length ? 1 : 0);
