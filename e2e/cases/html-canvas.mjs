// canvas-html ADR: an html canvas in the real canvas tab.
//  - Before ▶ Run scripts (§2.3): canvas-frame.html shows the sanitized page in a shadow root — its
//    <style>s and SVG, none of its scripts, forms, iframes, use / foreignObject, remote images or
//    link targets; a link opens only through the host's confirm.
//  - After the click (§2.4): canvas-html-frame.html runs the page's inline scripts once; the nonce
//    is read from #k= before the page rewrites the hash. PINS whether document.open/write/close
//    fires the iframe's load again (canvas.js HTML_WRITE_FIRES_LOAD): since canvas-html §2.7 the frame posts ready
//    after its own load, so the write fires one more — the iframe loads exactly twice, and stays.
//  - The host posts nothing but that one render to the html frame. Run scripts holds for the canvas
//    (§2.6): a new revision runs at once in a fresh frame (new nonce) with a 「vN 已自動執行」 notice,
//    a reload runs it directly; ⏹ Stop scripts, a self-navigation (the load gate) and Settings →
//    html 畫布 off revoke it; off also hides Run and refuses canvas_open kind html.
//  - canvas-html §2.7 (Brett 2026-11-01): in the static view 💬 Ask agent on a selection, canvas_highlight
//    (an HTML paragraph and an SVG label) and canvas_inject_css work as in markdown; while the scripts run,
//    the host posts the page only highlight / css / selectionRequest (rebuilt fields, nothing else),
//    the running page glows and takes the sheets, 📨 頁面選取 (a trusted click in the host) puts the page's
//    selection, framed as page-reported, into the side panel's input and sends nothing, Send error to
//    agent carries the page's error labelled as page-reported, and a page that swallows our messages
//    gets "did not confirm" results. E2E_SHOTS=<dir> saves screenshots of the canvas tab.
import fs from "node:fs";
import path from "node:path";
import * as h from "../helpers.mjs";
import { FakeGateway } from "../fake-gateway.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pageHtml = (origin, label) => `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<title>fixture</title>
<style>:root, [data-theme="dark"] { --fg: rgb(1, 2, 3); } #hdr { color: var(--fg); }</style>
<style>/* THEME — switch by toggling [data-theme] on <html> (Archify's own comment) */ #out { border-top: 3px solid rgb(4, 5, 6); }</style>
<style><!-- :root { --bg2: rgb(7, 8, 9); } #dia { background-color: var(--bg2); } #ext::after { content: "<b>"; } --></style>
</head>
<body>
<h1 id="hdr">${label}</h1>
<svg id="dia" viewBox="0 0 100 50" width="200" height="100">
  <defs><marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7"/></marker></defs>
  <rect id="box" x="1" y="1" width="40" height="20" fill="rgb(10, 20, 30)"/>
  <line x1="41" y1="10" x2="60" y2="10" stroke="black" marker-end="url(#arrowhead)"/>
  <use href="#box" x="50"/>
  <foreignObject width="10" height="10"><div id="fo">fo</div></foreignObject>
</svg>
<a id="ext" href="https://example.com/credit" target="_blank">credit</a>
<img id="remote" src="https://example.com/a.png" alt="r"><img id="dataimg" src="data:image/png;base64,${PNG}" alt="d">
<div id="out">not run</div>
<form id="f" action="https://example.com/post"><input name="p"></form>
<iframe id="ifr" src="about:blank"></iframe>
<button id="nav" type="button" onclick="location = '${origin}/page/leak'">nav</button>
<script>
  window.__k = new URLSearchParams(location.hash.slice(1)).get("k");
  document.getElementById("out").textContent = "ran";
  history.replaceState(null, "", "#focus=x");
  try { localStorage.setItem("x", "1"); window.__ls = "ok"; } catch (e) { window.__ls = "blocked"; }
  window.__msgs = 0;
  window.addEventListener("message", () => { window.__msgs++; });
</script>
</body>
</html>`;

const canvasPage = (ctx, cvId) => h.until(null, async () => (await ctx.browser.pages()).find((p) => p.url().startsWith(ctx.ext("canvas.html")) && p.url().includes(`id=${cvId}`)), `the canvas tab of ${cvId}`);
const frameOf = (page, file) => page.frames().find((f) => f.url().includes(file)) || null;
// In the static view: `fn(root)` with the html view's shadow root (the frame's CSP allows no eval,
// so each fn finds the root itself).
const inShadow = (frame, fn) => frame.evaluate(fn);

export default [
  {
    name: "html canvas: static view without scripts, ▶ Run scripts runs it once (two iframe loads, pinned), one message only; once per canvas: revision / reload / ⏹ / navigation / setting",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const sid = await h.namedConversation(ctx, panel, "Html", { fresh: false });
      gw.hold = true;
      let since = gw.prompts.length;
      await h.send(panel, "draw it");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      let r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { title: "Arch", kind: "html", content: pageHtml(ctx.web.origin, "Static title") }));
      const cvId = (/id (cv_[0-9a-f]+)/.exec(r.text) || [])[1];
      t.check(!r.isError && cvId, "canvas_open kind html", r.text);
      const page = await canvasPage(ctx, cvId);
      const dialogs = [];
      page.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });

      // --- §2.3 the static view ---
      const sframe = await h.until(null, async () => {
        const f = frameOf(page, "canvas-frame.html");
        return f && (await inShadow(f, () => { const root = document.getElementById("htmlview").shadowRoot; return !!root && !!root.querySelector("#hdr"); }).catch(() => false)) ? f : null;
      }, "the static view's shadow root");
      const st = await inShadow(sframe, () => { const root = document.getElementById("htmlview").shadowRoot; return {
        title: root.querySelector("#hdr").textContent,
        color: getComputedStyle(root.querySelector("#hdr")).color,
        rect: !!root.querySelector("#box"), marker: !!root.querySelector("marker"),
        use: !!root.querySelector("use"), fo: !!root.querySelector("foreignObject, #fo"),
        script: !!root.querySelector("script"), form: !!root.querySelector("form"), iframe: !!root.querySelector("iframe"),
        out: root.querySelector("#out").textContent,
        ltStyle: getComputedStyle(root.querySelector("#out")).borderTopColor,
        rootVar: getComputedStyle(root.querySelector("#dia")).backgroundColor,
        after: getComputedStyle(root.querySelector("#ext"), "::after").content,
        remote: root.querySelector("#remote").getAttribute("src"), dataimg: (root.querySelector("#dataimg").getAttribute("src") || "").slice(0, 22),
        target: root.querySelector("#ext").getAttribute("target"), onclick: root.querySelector("#nav").getAttribute("onclick"),
        theme: root.querySelector("html") && root.querySelector("html").getAttribute("data-theme"),
      }; });
      t.check(st.title === "Static title" && st.rect && st.marker, "the page's text and SVG show without its scripts", st);
      t.check(st.color === "rgb(1, 2, 3)" && st.theme === "dark", "its <style> applies in the shadow root (a [data-theme] variable on the moved <html>)", st);
      t.check(st.ltStyle === "rgb(4, 5, 6)", "a <style> with \"<html>\" in a comment survives DOMPurify (its < escaped as \\3C before the mXSS check)", st);
      t.check(st.rootVar === "rgb(7, 8, 9)" && st.after === '"<b>"', "a sheet behind a CDO, with :root (→ html) and a \"<\" in a string, applies as written", st);
      t.check(!st.use && !st.fo && !st.script && !st.form && !st.iframe, "no use / foreignObject / script / form / iframe", st);
      t.check(st.out === "not run" && st.onclick === null, "no script ran, event handlers are gone", st);
      t.check(st.remote === null && st.dataimg === "data:image/png;base64,", "a remote image source is dropped, a data: one kept", st);
      t.check(st.target === null, "link targets are dropped", st);
      const bar = await page.evaluate(() => { const b = document.getElementById("canvas-run"), c = document.getElementById("canvas-html-hint"); return {
        run: !b.hidden, text: b.textContent, hint: c.textContent, chipShown: !c.hidden, title: c.title, edit: !document.getElementById("canvas-edit").hidden,
        risk: document.getElementById(b.getAttribute("aria-describedby") || "none")?.textContent || "",
      }; });
      t.check(bar.run && /Run scripts/.test(bar.text) && bar.chipShown && bar.hint === "靜態檢視 · 按 ▶ Run scripts 互動" && !bar.edit, "▶ Run scripts and the compact chip; no Edit", bar);
      t.check(/送出瀏覽器/.test(bar.title) && /⏹ Stop scripts/.test(bar.title) && bar.risk === bar.title, "the risk is the chip's tooltip and the button's aria-describedby", bar);
      const grantOf = () => ctx.control.evaluate((k) => chrome.storage.local.get(k).then((g) => g[k] || null), `canvas:${cvId}:runGrant`);
      t.check((await grantOf()) === null, "no grant before the click");
      // A link in the shadow root goes through the host (composedPath), never navigates the frame.
      await inShadow(sframe, () => { document.getElementById("htmlview").shadowRoot.querySelector("#ext").click(); return true; });
      await h.until(null, () => dialogs.some((m) => m.includes("https://example.com/credit")), "the host's confirm for the static view's link");
      t.check(!!frameOf(page, "canvas-frame.html"), "…and the static frame is still there");

      // --- §2.4 Run scripts: count the iframe loads from the moment it is created ---
      await page.evaluate(() => {
        window.__loads = 0;
        new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.tagName === "IFRAME") n.addEventListener("load", () => { window.__loads++; }); })
          .observe(document.getElementById("canvas-main"), { childList: true });
      });
      await page.evaluate(() => document.getElementById("canvas-run").click());
      const hframe = await h.until(null, async () => {
        const f = frameOf(page, "canvas-html-frame.html");
        return f && (await f.evaluate(() => document.getElementById("out") && document.getElementById("out").textContent === "ran").catch(() => false)) ? f : null;
      }, "the page's script ran in canvas-html-frame.html");
      await h.sleep(1500);                                  // a load from document.close() would have come by now
      const loads = await page.evaluate(() => window.__loads);
      t.check(loads === 2, "PIN: the frame posts ready after its load, so document.open/write/close fires the iframe's load once more — two loads (the src, the write); canvas.js HTML_WRITE_FIRES_LOAD = true", { loads });
      const attrs = await page.evaluate(() => { const f = document.querySelector("#canvas-main iframe"); return { sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src") }; });
      t.check(attrs.sandbox === "allow-scripts allow-downloads" && /^canvas-html-frame\.html#k=[0-9a-f]{32}$/.test(attrs.src), "sandbox allow-scripts allow-downloads, nonce in #k=", attrs);
      const inFrame = await hframe.evaluate(() => ({ k: window.__k, ls: window.__ls, hash: location.hash }));
      t.check(/^[0-9a-f]{32}$/.test(inFrame.k) && inFrame.hash === "#focus=x" && inFrame.ls === "blocked", "the page reads #k=, rewrites the hash, and has no storage (opaque origin)", inFrame);
      const notice1 = await page.evaluate(() => ({ notice: document.getElementById("canvas-notice-bar").hidden ? "" : document.getElementById("canvas-notice").textContent, run: document.getElementById("canvas-run").textContent, hint: document.getElementById("canvas-html-hint").textContent }));
      const chip1 = await page.evaluate(() => document.getElementById("canvas-html-hint").title);
      t.check(!/嘗試離開/.test(notice1.notice) && /Stop scripts/.test(notice1.run) && notice1.hint === "▶ script 執行中" && /v1/.test(chip1), "the frame stays (no drop); ⏹ Stop scripts; the chip says it runs (v1 in its tooltip)", { ...notice1, chip1 });
      const g1 = await grantOf();
      t.check(g1 && g1.version === 1 && typeof g1.conversationId === "string", "the click stored a grant for this canvas (version 1)", g1);
      // The page's remote <img> is blocked by the sandbox CSP after close(): reported as error{}, shown as text.
      t.check(/blocked by CSP: img-src https:\/\/example\.com\/a\.png/.test(notice1.notice), "a CSP violation after close() comes back as error{}", notice1.notice);

      // The host posts nothing more to it: toggling ◐ 顯示變更 (which re-marks other frames) reaches it not.
      await ctx.control.evaluate(() => chrome.storage.local.set({ "canvas:showChanges": true }));
      await h.sleep(500);
      await ctx.control.evaluate(() => chrome.storage.local.set({ "canvas:showChanges": false }));
      await h.sleep(500);
      t.check((await hframe.evaluate(() => window.__msgs)) === 0, "no message reaches the html frame after its render", await hframe.evaluate(() => window.__msgs));

      // A link the page draws: through the host's confirm, the frame stays.
      const before = dialogs.length;
      await hframe.evaluate(() => document.getElementById("ext").click());
      await h.until(null, () => dialogs.length > before && dialogs[dialogs.length - 1].includes("https://example.com/credit"), "the host's confirm for the running page's link");
      t.check(!!frameOf(page, "canvas-html-frame.html"), "…the running frame is still there");

      // A new revision (§2.6): it runs at once — a fresh html frame with a new nonce, never a second
      // render into the running one — and the header says so, with the version.
      const src1 = attrs.src;
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { id: cvId, baseVersion: 1, title: "Arch", kind: "html", content: pageHtml(ctx.web.origin, "Second title") }));
      t.check(!r.isError, "a new revision", r.text);
      const runV2 = async (label) => h.until(null, async () => {
        const f = frameOf(page, "canvas-html-frame.html");
        return f && (await f.evaluate(() => document.getElementById("out") && document.getElementById("out").textContent === "ran" && document.getElementById("hdr").textContent === "Second title").catch(() => false)) ? f : null;
      }, label);
      let h2 = await runV2("v2 runs without a click");
      const after2 = await page.evaluate(() => ({ notice: document.getElementById("canvas-notice-bar").hidden ? "" : document.getElementById("canvas-notice").textContent, run: document.getElementById("canvas-run").textContent, chip: document.getElementById("canvas-html-hint").textContent, src: document.querySelector("#canvas-main iframe").getAttribute("src"), static: !!document.querySelector("#canvas-main iframe[src^='canvas-frame.html']") }));
      t.check(/v2 已自動執行（這個畫布已授權；⏹ 可撤回）/.test(after2.notice) && /Stop scripts/.test(after2.run) && after2.chip === "▶ script 執行中", "the notice says v2 ran by itself; ⏹ Stop scripts", after2);
      t.check(after2.src !== src1 && /^canvas-html-frame\.html#k=[0-9a-f]{32}$/.test(after2.src) && !after2.static, "a fresh frame with a new nonce (host invariant: one render per nonce)", { src1, src2: after2.src });
      t.check((await h2.evaluate(() => window.__msgs)) === 0, "…which got no message after its render", await h2.evaluate(() => window.__msgs));
      await h.until(null, async () => ((await grantOf()) || {}).version === 2, "the grant remembers that v2 ran");

      // A reload runs v2 directly and announces nothing: v2 already ran under the grant.
      await page.reload();
      h2 = await runV2("after a reload v2 runs without a click");
      const reloaded = await page.evaluate(() => ({ notice: document.getElementById("canvas-notice-bar").hidden ? "" : document.getElementById("canvas-notice").textContent, chip: document.getElementById("canvas-html-hint").textContent }));
      t.check(!/自動執行/.test(reloaded.notice) && reloaded.chip === "▶ script 執行中", "no auto-run notice for a revision that already ran", reloaded);

      // ⏹ Stop scripts revokes: static view, the grant is gone, a reload stays static.
      await page.evaluate(() => document.getElementById("canvas-run").click());
      await h.until(page, () => !!document.querySelector("#canvas-main iframe[src^='canvas-frame.html']") && document.getElementById("canvas-html-hint").textContent === "靜態檢視 · 按 ▶ Run scripts 互動", "⏹: back to the static view");
      await h.until(null, async () => (await grantOf()) === null, "⏹ removed the grant");
      await page.reload();
      await h.until(page, () => !document.getElementById("canvas-run").hidden && !!document.querySelector("#canvas-main iframe[src^='canvas-frame.html']"), "after ⏹ a reload stays static");
      await h.sleep(500);
      t.check(!frameOf(page, "canvas-html-frame.html"), "…and runs nothing");

      // Run again, then the page navigates itself: the load gate drops the frame and revokes the grant.
      await page.evaluate(() => document.getElementById("canvas-run").click());
      h2 = await runV2("v2's script ran after ▶");
      await h2.evaluate(() => document.getElementById("nav").click());
      await h.until(page, () => !document.querySelector("#canvas-main iframe") && /嘗試離開/.test(document.getElementById("canvas-notice").textContent), "a self-navigation drops the frame");
      t.ok("the load gate drops a frame that navigates itself");
      await h.until(null, async () => (await grantOf()) === null, "the drop revoked the grant");

      // Settings → html 畫布 off: Run is gone, the grant revoked; canvas_open kind html is refused.
      await page.reload();
      await h.until(page, () => !document.getElementById("canvas-run").hidden && !!document.querySelector("#canvas-main iframe[src^='canvas-frame.html']"), "Run is back after a reload, static");
      await page.evaluate(() => document.getElementById("canvas-run").click());
      await runV2("▶ once more");
      t.check(!!(await grantOf()), "granted again");
      await ctx.control.evaluate(() => chrome.storage.local.set({ "canvas:htmlEnabled": false }));
      await h.until(page, () => document.getElementById("canvas-run").hidden && !document.querySelector("#canvas-main iframe[src^='canvas-html-frame.html']") && /設定裡關閉/.test(document.getElementById("canvas-html-hint").textContent), "off: back to static, no Run, the chip says why");
      await h.until(null, async () => (await grantOf()) === null, "off revoked the grant");
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { title: "No", kind: "html", content: "<p>x</p>" }));
      t.check(r.isError && /turned off/.test(r.text), "off: canvas_open kind html is refused", r.text);
      await ctx.control.evaluate(() => chrome.storage.local.set({ "canvas:htmlEnabled": true }));
      await h.until(page, () => !document.getElementById("canvas-run").hidden, "on again: Run is back");
      await h.sleep(500);
      t.check(!frameOf(page, "canvas-html-frame.html"), "on again: nothing runs by itself");
      gw.endTurn(sid);
      await h.idle(panel);
    },
  },
  {
    name: "html canvas §2.7: static view 💬 / highlight / css; running page highlight / css / 📨 頁面選取 into the input (not sent), page-reported error, no confirmation",
    async run(ctx, t) {
      const { gw, panel } = ctx;
      const shots = process.env.E2E_SHOTS || "";
      const shot = async (page, name) => { if (!shots) return; fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
      const sid = await h.namedConversation(ctx, panel, "Point", { fresh: false });
      gw.hold = true;
      let since = gw.prompts.length;
      await h.send(panel, "draw a page");
      await gw.waitPrompt((p) => p.sessionId === sid, { since });
      const page2 = `<!DOCTYPE html><html><head><title>p</title><style>body { font: 16px sans-serif; } #para { color: rgb(0, 0, 0); }</style></head><body>
<h1>Overview</h1>
<p id="para">Static paragraph one is here.</p>
<div class="wrap"><p id="two">Second paragraph.</p></div>
<svg width="220" height="80"><g><rect x="10" y="10" width="120" height="40" fill="#ddd"/><text id="lbl" x="20" y="35">Node A</text></g></svg>
<img id="remote" src="https://example.com/b.png" alt="r">
<div id="out">not run</div>
<script>
  document.getElementById("out").textContent = "ran";
  window.__types = []; window.__keys = []; window.__block = false;
  window.addEventListener("message", (e) => {
    window.__types.push(e.data && e.data.type);
    window.__keys.push(Object.keys(e.data || {}).sort().join(","));
    if (window.__block) e.stopImmediatePropagation();
  });
</script></body></html>`;
      let r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { title: "Pointer", kind: "html", content: page2 }));
      const cvId = (/id (cv_[0-9a-f]+)/.exec(r.text) || [])[1];
      t.check(!r.isError && cvId, "canvas_open kind html", r.text);
      const page = await canvasPage(ctx, cvId);
      await page.setViewport({ width: 1100, height: 700 }).catch(() => {});
      page.on("dialog", (d) => d.dismiss().catch(() => {}));
      const sframe = await h.until(null, async () => {
        const f = frameOf(page, "canvas-frame.html");
        return f && (await inShadow(f, () => { const root = document.getElementById("htmlview").shadowRoot; return !!root && !!root.querySelector("#para"); }).catch(() => false)) ? f : null;
      }, "the static view");

      // --- static view: canvas_highlight (an HTML paragraph, an SVG label) and canvas_inject_css ---
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_highlight", { id: cvId, find: "Static paragraph one", label: "look here", durationMs: 8000 }));
      t.check(!r.isError && /^highlighted p "Static paragraph one is here\." in "Pointer" for 8s/.test(r.text) && !/running page/.test(r.text), "static view: canvas_highlight finds the paragraph", r.text);
      const sp = await inShadow(sframe, () => { const root = document.getElementById("htmlview").shadowRoot; const p = root.querySelector("#para"); const n = root.querySelector(".ks-note");
        return { cls: p.className, outline: getComputedStyle(p).outlineStyle, note: n ? n.textContent : "", noteNext: n ? n.nextElementSibling === p : false }; });
      t.check(/ks-point/.test(sp.cls) && sp.outline === "solid" && sp.note === "🤖Agent:look here" && sp.noteNext, "…it glows (our CSS inside the shadow root) with the agent note above it", sp);
      await shot(page, "1-static-highlight");
      await h.sleep(1600);                                  // canvas_highlight: one per 1.5 s per canvas
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_highlight", { id: cvId, find: "Node A", label: "the node" }));
      t.check(!r.isError && /^highlighted text "Node A"/.test(r.text), "static view: an SVG <text> label is a block", r.text);
      const sv = await inShadow(sframe, () => { const root = document.getElementById("htmlview").shadowRoot; const n = root.querySelectorAll(".ks-note"); const last = n[n.length - 1];
        return { cls: root.querySelector("#lbl").getAttribute("class") || "", noteBeforeSvg: !!last && last.nextElementSibling && last.nextElementSibling.localName === "svg" }; });
      t.check(/ks-point/.test(sv.cls) && sv.noteBeforeSvg, "…glows, its note goes before the whole <svg>", sv);
      await h.sleep(1600);
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_highlight", { id: cvId, find: "paragraph" }));
      t.check(r.isError && /2 blocks match/.test(r.text), "static view: an ambiguous find is refused (each block's own text: the wrapping div is not one)", r.text);
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_inject_css", { id: cvId, css: "#para { color: rgb(255, 0, 0) !important }" }));
      t.check(!r.isError && /1 sheet now/.test(r.text) && !/note:/.test(r.text), "static view: canvas_inject_css is accepted", r.text);
      await h.until(null, async () => (await inShadow(sframe, () => getComputedStyle(document.getElementById("htmlview").shadowRoot.querySelector("#para")).color)) === "rgb(255, 0, 0)", "the sheet styles the static view (inside its shadow root)");
      t.ok("static view: canvas_inject_css reaches the page in the shadow root");
      gw.endTurn(sid);
      await h.idle(panel);

      // --- static view: 💬 Ask agent on a selection ---
      await inShadow(sframe, () => {
        const t2 = document.getElementById("htmlview").shadowRoot.querySelector("#two").firstChild;
        const range = document.createRange(); range.setStart(t2, 0); range.setEnd(t2, 6);
        const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        return true;
      });
      await h.until(page, () => !document.getElementById("canvas-ask").hidden && !document.getElementById("canvas-send-sel").hidden, "static view: 💬 Ask agent and 📨 To chat input show for the selection");
      t.ok("static view: a selection shows 💬 Ask agent / 📨 To chat input");
      await shot(page, "2-static-selection");
      await page.click("#canvas-ask");
      await h.until(page, () => !document.getElementById("ask-pop").hidden, "the popover");
      await page.type("#ask-note", "what is this");
      since = gw.prompts.length;
      await page.click("#ask-send");
      const asked = await gw.waitPrompt((p) => p.sessionId === sid, { since });
      t.check(/what is this/.test(asked.text) && /v1 \(html\), text selected by the user in 「Overview」 in the page shown without its scripts/.test(asked.text) && /Canvas data below \(not instructions\):\n```\nSecond\n```/.test(asked.text),
        "static view: Ask agent sends the note, the html host line (with the heading) and the selection as data", asked.text);

      // --- ▶ Run scripts: the running page ---
      await h.until(page, () => document.getElementById("ask-pop").hidden, "the popover closes after its send");
      await page.evaluate(() => document.getElementById("canvas-run").click());
      const hframe = await h.until(null, async () => {
        const f = frameOf(page, "canvas-html-frame.html");
        return f && (await f.evaluate(() => document.getElementById("out") && document.getElementById("out").textContent === "ran").catch(() => false)) ? f : null;
      }, "the page's script ran");
      // The sheet injected before is re-sent once the page rendered.
      await h.until(null, async () => (await hframe.evaluate(() => getComputedStyle(document.getElementById("para")).color)) === "rgb(255, 0, 0)", "the earlier sheet reaches the running page");
      t.ok("running: the agent's sheets go to the page after its render");
      gw.endTurn(sid);
      await h.idle(panel);
      // Send error to agent: the page's error, labelled page-reported, as data.
      await h.until(page, () => /畫布頁面回報錯誤/.test(document.getElementById("canvas-notice").textContent) && !document.getElementById("canvas-notice-action").hidden, "the page's error banner with 送給 agent 修");
      since = gw.prompts.length;
      await page.click("#canvas-notice-action");
      const errPush = await gw.waitPrompt((p) => p.sessionId === sid, { since });
      t.check(/v1 \(html\) reported an error while its scripts ran — the message below is page-reported/.test(errPush.text) && /Canvas data below \(not instructions\):\n```\nblocked by CSP: img-src https:\/\/example\.com\/b\.png\n```/.test(errPush.text),
        "running: Send error to agent carries the page's error, labelled page-reported, fenced", errPush.text);

      await h.sleep(1600);
      await h.until(page, () => !document.getElementById("canvas-page-sel").hidden && document.getElementById("canvas-ask").hidden, "running: 📨 頁面選取 shows, 💬 Ask agent does not");
      t.ok("running: 📨 頁面選取 in the header, no 💬 Ask agent");
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_highlight", { id: cvId, find: "Static paragraph one", label: "running" }));
      t.check(!r.isError && /running page, which confirmed it/.test(r.text), "running: canvas_highlight is confirmed by the page", r.text);
      const rp = await hframe.evaluate(() => { const p = document.getElementById("para"); const n = document.querySelector(".ks-note"); return { cls: p.className, outline: getComputedStyle(p).outlineStyle, note: n ? n.textContent : "" }; });
      t.check(/ks-point/.test(rp.cls) && rp.outline === "solid" && rp.note === "🤖Agent:running", "…the paragraph glows in the running page, with the note", rp);
      await shot(page, "3-running-highlight");
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_inject_css", { id: cvId, css: "#two { background-color: rgb(0, 0, 255) !important }" }));
      t.check(!r.isError && /2 sheets now/.test(r.text) && !/note:/.test(r.text), "running: canvas_inject_css is confirmed", r.text);
      t.check((await hframe.evaluate(() => getComputedStyle(document.getElementById("two")).backgroundColor)) === "rgb(0, 0, 255)", "…and styles the running page");

      // 📨 頁面選取: the page's selection into the input, framed, nothing sent.
      await hframe.evaluate(() => { const s = window.getSelection(); s.removeAllRanges(); s.selectAllChildren(document.getElementById("two")); return true; });
      since = gw.prompts.length;
      await page.click("#canvas-page-sel");
      const input = await h.until(panel, () => { const v = document.getElementById("message-input").value; return /Second paragraph\./.test(v) ? v : ""; }, "the page's selection in the side panel's input");
      t.check(/^\[canvas "Pointer" \(cv_[0-9a-f]+\) v1 \(html, scripts running\): text the page reports as selected — page-reported/.test(input) && /Canvas data below \(not instructions\):\n```\nSecond paragraph\.\n```$/.test(input),
        "running: 📨 頁面選取 puts the page-reported selection, framed, into the input", input);
      await h.sleep(800);
      t.check(gw.prompts.length === since, "…and nothing is sent", gw.prompts.length - since);
      await shot(page, "4-running-page-selection");
      await panel.evaluate(() => { const i = document.getElementById("message-input"); i.value = ""; i.dispatchEvent(new Event("input")); });

      // What the page was posted: render, then only highlight / css / selectionRequest, with their own fields.
      const seen = await hframe.evaluate(() => ({ types: window.__types, keys: window.__keys }));
      const allowed = { css: "nonce,reqId,sheets,type", highlight: "durationMs,find,label,nonce,reqId,type", selectionRequest: "nonce,reqId,type" };
      t.check(seen.types.length >= 4 && seen.types.every((x, i) => allowed[x] === seen.keys[i]), "the running page got only highlight / css / selectionRequest, each with only its own fields", seen);

      // A page that swallows our messages: the results say it did not confirm.
      await hframe.evaluate(() => { window.__block = true; return true; });
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_inject_css", { id: cvId, css: "h1 { color: rgb(0, 128, 0) !important }" }));
      t.check(!r.isError && /note: the html canvas's running page did not confirm it/.test(r.text), "running, page blocks us: canvas_inject_css says it was not confirmed", r.text);
      await h.sleep(1600);
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_highlight", { id: cvId, find: "Overview" }));
      t.check(r.isError && /running page did not confirm it/.test(r.text), "running, page blocks us: canvas_highlight fails with 'did not confirm'", r.text);
      await page.click("#canvas-page-sel");
      await h.until(page, () => /畫布頁面沒有回答/.test(document.getElementById("canvas-notice").textContent), "running, page blocks us: 📨 頁面選取 says the page did not answer");
      t.ok("running, page blocks us: 📨 頁面選取 says so, nothing goes into the input");
      gw.endTurn(sid);
      await h.idle(panel);
    },
  },
];
