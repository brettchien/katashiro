// canvas-html ADR: an html canvas in the real canvas tab.
//  - Before ▶ Run scripts (§2.3): canvas-frame.html shows the sanitized page in a shadow root — its
//    <style>s and SVG, none of its scripts, forms, iframes, use / foreignObject, remote images or
//    link targets; a link opens only through the host's confirm.
//  - After the click (§2.4): canvas-html-frame.html runs the page's inline scripts once; the nonce
//    is read from #k= before the page rewrites the hash. PINS whether document.open/write/close
//    fires the iframe's load again (canvas.js HTML_WRITE_FIRES_LOAD): the iframe loads exactly once.
//  - The host posts nothing but that one render to the html frame, a new revision goes back to the
//    view without scripts, a self-navigation drops the frame, and Settings → html 畫布 off hides Run
//    and refuses canvas_open kind html.
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
    name: "html canvas: static view without scripts, ▶ Run scripts runs it once (one iframe load), one message only, revision / navigation / setting",
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
      const bar = await page.evaluate(() => ({ run: !document.getElementById("canvas-run").hidden, text: document.getElementById("canvas-run").textContent, hint: document.getElementById("canvas-html-hint").textContent, edit: !document.getElementById("canvas-edit").hidden }));
      t.check(bar.run && /Run scripts/.test(bar.text) && /Shown without its scripts/.test(bar.hint) && !bar.edit, "▶ Run scripts and the line under the header; no Edit", bar);
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
      t.check(loads === 1, "PIN: document.open/write/close does not fire the iframe's load again — one load (the src); canvas.js HTML_WRITE_FIRES_LOAD = false", { loads });
      const attrs = await page.evaluate(() => { const f = document.querySelector("#canvas-main iframe"); return { sandbox: f.getAttribute("sandbox"), src: f.getAttribute("src") }; });
      t.check(attrs.sandbox === "allow-scripts allow-downloads" && /^canvas-html-frame\.html#k=[0-9a-f]{32}$/.test(attrs.src), "sandbox allow-scripts allow-downloads, nonce in #k=", attrs);
      const inFrame = await hframe.evaluate(() => ({ k: window.__k, ls: window.__ls, hash: location.hash }));
      t.check(/^[0-9a-f]{32}$/.test(inFrame.k) && inFrame.hash === "#focus=x" && inFrame.ls === "blocked", "the page reads #k=, rewrites the hash, and has no storage (opaque origin)", inFrame);
      const notice1 = await page.evaluate(() => ({ notice: document.getElementById("canvas-notice-bar").hidden ? "" : document.getElementById("canvas-notice").textContent, run: document.getElementById("canvas-run").textContent, hint: document.getElementById("canvas-html-hint").textContent }));
      t.check(!/嘗試離開/.test(notice1.notice) && /Stop scripts/.test(notice1.run) && /正在執行 v1/.test(notice1.hint), "the frame stays (no drop); ⏹ Stop scripts; the line says it runs v1", notice1);
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

      // A new revision: back to the view without scripts; Run again for the new one.
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { id: cvId, baseVersion: 1, title: "Arch", kind: "html", content: pageHtml(ctx.web.origin, "Second title") }));
      t.check(!r.isError, "a new revision", r.text);
      await h.until(null, async () => {
        const f = frameOf(page, "canvas-frame.html");
        return f && !frameOf(page, "canvas-html-frame.html") && (await inShadow(f, () => { const root = document.getElementById("htmlview").shadowRoot; return root && root.querySelector("#hdr") ? root.querySelector("#hdr").textContent : ""; }).catch(() => "")) === "Second title";
      }, "v2 shows without its scripts");
      const after2 = await page.evaluate(() => ({ notice: document.getElementById("canvas-notice").textContent, run: document.getElementById("canvas-run").textContent }));
      t.check(/v2/.test(after2.notice) && /再按 ▶ Run scripts/.test(after2.notice) && /Run scripts/.test(after2.run), "the notice says so and ▶ Run scripts is back", after2);

      // Run v2, then the page navigates itself: the load gate drops the frame.
      await page.evaluate(() => document.getElementById("canvas-run").click());
      const h2 = await h.until(null, async () => {
        const f = frameOf(page, "canvas-html-frame.html");
        return f && (await f.evaluate(() => document.getElementById("out") && document.getElementById("out").textContent === "ran").catch(() => false)) ? f : null;
      }, "v2's script ran");
      await h2.evaluate(() => document.getElementById("nav").click());
      await h.until(page, () => !document.querySelector("#canvas-main iframe") && /嘗試離開/.test(document.getElementById("canvas-notice").textContent), "a self-navigation drops the frame");
      t.ok("the load gate drops a frame that navigates itself");

      // Settings → html 畫布 off: Run is gone (after a reload of the view), canvas_open kind html is refused.
      await page.reload();
      await h.until(page, () => !document.getElementById("canvas-run").hidden, "Run is back after a reload");
      await ctx.control.evaluate(() => chrome.storage.local.set({ "canvas:htmlEnabled": false }));
      await h.until(page, () => document.getElementById("canvas-run").hidden && /已在側邊欄的設定裡關閉/.test(document.getElementById("canvas-html-hint").textContent), "off: no Run, the line says why");
      r = FakeGateway.text(await gw.callTool(sid, "katashiro.canvas_open", { title: "No", kind: "html", content: "<p>x</p>" }));
      t.check(r.isError && /turned off/.test(r.text), "off: canvas_open kind html is refused", r.text);
      await ctx.control.evaluate(() => chrome.storage.local.set({ "canvas:htmlEnabled": true }));
      await h.until(page, () => !document.getElementById("canvas-run").hidden, "on again: Run is back");
      gw.endTurn(sid);
      await h.idle(panel);
    },
  },
];
