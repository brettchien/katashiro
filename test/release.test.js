// release.test.js — the release zip must ship every file the extension loads.
//
// release.yml packages an explicit file list (runtime files only). A script added to
// sidepanel.html but not to that list works from a git checkout and breaks only in the
// release zip — which is how v2.4.0 shipped without jev-grounding.js.
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
  // A directory entry (e.g. `page`, `vendor`) covers everything beneath it.
  return entries.some((e) => file === e || file.startsWith(e + "/"));
}

test("release zip includes every script sidepanel.html loads", () => {
  const entries = zipEntries();
  const scripts = [...read("sidepanel.html").matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0);
  for (const s of scripts) assert.ok(shipped(entries, s), `${s} is loaded by sidepanel.html but missing from the release zip`);
});

test("release zip includes the manifest's entry points and icons", () => {
  const entries = zipEntries();
  const manifest = JSON.parse(read("manifest.json"));
  const files = [
    "manifest.json",
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const f of files) assert.ok(shipped(entries, f), `${f} is referenced by manifest.json but missing from the release zip`);
});

test("release zip includes the canvas pages and everything they load (ADR canvas)", () => {
  const entries = zipEntries();
  const manifest = JSON.parse(read("manifest.json"));
  for (const page of ["canvas.html", ...((manifest.sandbox && manifest.sandbox.pages) || [])]) {
    assert.ok(shipped(entries, page), `${page} is missing from the release zip`);
    const html = read(page);
    const refs = [...html.matchAll(/<(?:script src|link rel="stylesheet" href)="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, `${page} loads nothing?`);
    for (const r of refs) assert.ok(shipped(entries, r), `${r} is loaded by ${page} but missing from the release zip`);
  }
});
