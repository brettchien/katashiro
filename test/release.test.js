// release.test.js — the release zip must ship every file the extension loads.
//
// release.yml packages runtime files only: manifest.json, the root *.html pages and the src/,
// vendor/ and icons/ directories. A script loaded from anywhere else works from a git checkout
// and breaks only in the release zip — which is how v2.4.0 shipped without jev-grounding.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// Entries of the `zip -r ... \` continuation block in release.yml.
function zipEntries() {
  const m = read(".github/workflows/release.yml").match(/zip -r "[^"]+" \\\n((?:.*\\\n)*.*\n)/);
  assert.ok(m, "zip command not found in release.yml");
  return m[1].replace(/\\\n/g, " ").trim().split(/\s+/);
}

// Every .js file under src/ (the scripts that name other files at runtime).
function srcScripts(dir = "src") {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const p = path.posix.join(dir, d.name);
    return d.isDirectory() ? srcScripts(p) : d.name.endsWith(".js") ? [p] : [];
  });
}

// build-info.json is written by release.yml at package time (gitignored), so it is not in the repo.
const GENERATED = new Set(["build-info.json"]);

// The file exists in the repo and the release zip packs it. A moved file whose old path is still
// referenced somewhere passes a deepEqual on the literal and fails only at runtime (#184).
function assertShipped(entries, file, who) {
  assert.ok(GENERATED.has(file) || fs.existsSync(path.join(root, file)), `${file} is ${who} but not in the repo`);
  assert.ok(shipped(entries, file), `${file} is ${who} but missing from the release zip`);
  assert.ok(!file.endsWith(".md"), `${file} is ${who} but release.yml excludes *.md from the zip`);
}

function shipped(entries, file) {
  // A directory entry (e.g. `src`, `vendor`) covers everything beneath it; a root glob like
  // `*.html` (the shell expands it in the repo root) covers the matching top-level files.
  return entries.some((e) => file === e || file.startsWith(e + "/") ||
    (e.startsWith("*.") && !file.includes("/") && file.endsWith(e.slice(1))));
}

test("release zip includes every script sidepanel.html loads", () => {
  const entries = zipEntries();
  const scripts = [...read("sidepanel.html").matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  const refs = [...read("sidepanel.html").matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  for (const s of [...scripts, ...refs]) assertShipped(entries, s, "loaded by sidepanel.html");
});

test("release zip includes the manifest's entry points, content scripts and icons", () => {
  const entries = zipEntries();
  const manifest = JSON.parse(read("manifest.json"));
  const files = [
    "manifest.json",
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap((c) => c.js || []),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of files) assertShipped(entries, f, "referenced by manifest.json");
});

test("release zip includes the canvas pages and everything they load (ADR canvas)", () => {
  const entries = zipEntries();
  const manifest = JSON.parse(read("manifest.json"));
  for (const page of ["canvas.html", "canvas-gallery.html", ...((manifest.sandbox && manifest.sandbox.pages) || [])]) {
    assertShipped(entries, page, "a canvas page");
    const html = read(page);
    const refs = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, `${page} loads nothing?`);
    for (const r of refs) assertShipped(entries, r, `loaded by ${page}`);
  }
});

test("release zip includes the vendor files canvas-frame.js loads on demand (Milkdown, mermaid)", () => {
  const entries = zipEntries();
  const refs = [...read("src/canvas/canvas-frame.js").matchAll(/"(vendor\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.includes("vendor/mermaid/mermaid.tiny.js"), "canvas-frame.js no longer loads mermaid?");
  for (const r of refs) {
    assert.ok(fs.existsSync(path.join(root, r)), `${r} is loaded by canvas-frame.js but not in the repo`);
    assert.ok(shipped(entries, r), `${r} is loaded by canvas-frame.js but missing from the release zip`);
  }
});

test("release zip includes every script the service worker importScripts (conv-core.js, …)", () => {
  const entries = zipEntries();
  // importScripts resolves against the worker's own URL (src/background.js), not the extension root.
  const worker = JSON.parse(read("manifest.json")).background.service_worker;
  const calls = [...read(worker).matchAll(/importScripts\(([^)]*)\)/g)];
  const files = calls.flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((x) => path.posix.join(path.posix.dirname(worker), x[1])));
  assert.ok(files.includes("src/core/conv-core.js"), "background.js no longer loads conv-core.js?");
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is imported by background.js but not in the repo`);
    assert.ok(shipped(entries, f), `${f} is imported by background.js but missing from the release zip`);
  }
});

test("release zip includes every file src/**/*.js names at runtime (files: [...], WALKER_FILES, iconUrl, getURL)", () => {
  const entries = zipEntries();
  // All of these resolve against the extension root: executeScript `files`, chrome.runtime.getURL,
  // script/style src set from canvas-frame.html, and leading-slash paths compared with a page or
  // sender URL pathname ("/sidepanel.html", "/src/background.js"). `iconUrl` is relative to the
  // calling page — assumed to be called only from root pages (sidepanel.html), so root-relative too.
  // Only double-quoted literals are scanned (the repo style); a single-quoted or template-literal
  // path is not seen by this test.
  const PATH = /^\/?[\w.-][\w./-]*\.(?:js|css|html|json|png|svg)$/;
  const strings = (text) => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((x) => PATH.test(x));
  const found = new Map();   // file -> first src script naming it
  // "/x" and "x" name the same file in the extension root.
  const note = (f, who) => { f = f.replace(/^\//, ""); if (!found.has(f)) found.set(f, who); };
  for (const js of srcScripts()) {
    const text = read(js);
    for (const m of text.matchAll(/\bfiles:\s*\[([^\]]*)\]/g)) strings(m[1]).forEach((f) => note(f, js));
    for (const m of text.matchAll(/\bWALKER_FILES\s*=\s*\[([^\]]*)\]/g)) strings(m[1]).forEach((f) => note(f, js));
    for (const m of text.matchAll(/\biconUrl:\s*"([^"]+)"/g)) note(m[1], js);
    for (const m of text.matchAll(/\bgetURL\(\s*"([^"]+)"\s*\)/g)) note(m[1], js);
    // Catch-all: any path literal into the shipped directories, with or without a leading slash
    // (canvas-frame.js setting s.src = "vendor/mermaid/mermaid.tiny.js"; page-ask-core.js checking
    // a sender pathname against "/src/background.js"), and any root-level "/<name>.html|js|css|json"
    // (sidepanel.js fromOwnPage(sender, "/sidepanel.html")). The root name may contain dots
    // ("/canvas.v2.html"). The release zip packs only manifest.json, build-info.json and *.html at
    // the root, so a "/x.js" / "/x.css" / "/x.json" hit is a real bug: it fails below with a
    // message saying so. A root path without the leading slash ("x.js") is not caught here — it
    // is indistinguishable from an ordinary string; the files:/getURL/iconUrl scans above cover
    // the APIs that take one.
    for (const m of text.matchAll(/"\/?((?:src|vendor|icons)\/[\w./-]+)"/g)) if (PATH.test(m[1])) note(m[1], js);
    for (const m of text.matchAll(/"\/([\w-][\w.-]*\.(?:html|js|css|json))"/g)) note(m[1], js);
  }
  for (const [f, js] of found) {
    // Root level: only manifest.json, build-info.json and *.html are packed (release.yml).
    if (!f.includes("/")) {
      assert.ok(f.endsWith(".html") || f === "manifest.json" || GENERATED.has(f),
        `${f} is named by ${js} as a root-level file, but the release zip packs only manifest.json, build-info.json and *.html at the root — move it under src/ (or fix the path)`);
    }
    assertShipped(entries, f, `named by ${js}`);
  }
  // Sanity: the scanner still sees the references this test was written for.
  for (const f of ["src/core/page-ask-core.js", "src/page/a11y-walker.js", "vendor/dom-accessibility-api.iife.js", "icons/icon128.png", "canvas.html", "vendor/mermaid/mermaid.tiny.js",
    "src/background.js", "sidepanel.html", "canvas-gallery.html"]) {
    assert.ok(found.has(f), `scanner no longer finds ${f} in src/**/*.js?`);
  }
});

test("release zip ships the license and the third-party notices", () => {
  const yml = read(".github/workflows/release.yml");
  const m = yml.match(/^\s*zip "[^"]+" (.+)$/m);
  assert.ok(m, "no zip step adds the license files");
  const files = m[1].trim().split(/\s+/);
  for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(files.includes(f), `${f} is missing from the release zip`);
    assert.ok(fs.existsSync(path.join(root, f)), `${f} is not in the repo`);
  }
});
