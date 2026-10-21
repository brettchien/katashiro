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
  for (const s of scripts) assert.ok(shipped(entries, s), `${s} is loaded by sidepanel.html but missing from the release zip`);
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
  for (const f of files) assert.ok(shipped(entries, f), `${f} is referenced by manifest.json but missing from the release zip`);
});

test("release zip includes the canvas pages and everything they load (ADR canvas)", () => {
  const entries = zipEntries();
  const manifest = JSON.parse(read("manifest.json"));
  for (const page of ["canvas.html", "canvas-gallery.html", ...((manifest.sandbox && manifest.sandbox.pages) || [])]) {
    assert.ok(shipped(entries, page), `${page} is missing from the release zip`);
    const html = read(page);
    const refs = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, `${page} loads nothing?`);
    for (const r of refs) assert.ok(shipped(entries, r), `${r} is loaded by ${page} but missing from the release zip`);
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
