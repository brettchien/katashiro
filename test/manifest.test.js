// manifest.test.js — guards the pinned extension ID and the optional sessions permission.
//
// manifest.json's `key` fixes the extension ID regardless of the folder an unpacked copy is
// loaded from; chrome.storage.sync is keyed by that ID, so changing the key silently orphans
// every user's synced config. The ID is sha256(DER public key), first 32 hex digits mapped 0-f → a-p.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const manifest = require("../manifest.json");

const PINNED_ID = "hgilgjleemnjgehpgikeonbijpjgapmf";

function extensionIdFromKey(b64) {
  const hex = crypto.createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");
  return hex.slice(0, 32).replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

test("manifest key pins the extension ID (storage.sync is keyed by it)", () => {
  assert.equal(typeof manifest.key, "string");
  assert.equal(extensionIdFromKey(manifest.key), PINNED_ID);
});

test("manifest key is a public key only", () => {
  // Parses as an SPKI public key; a private key must never be committed.
  const k = crypto.createPublicKey({ key: Buffer.from(manifest.key, "base64"), format: "der", type: "spki" });
  assert.equal(k.type, "public");
  assert.equal(k.asymmetricKeyType, "rsa");
});

test("sessions is an optional permission (reopen_tab), never a required one", () => {
  // sessions + tabs also reads other signed-in devices' history — granted only from Settings.
  assert.ok(!manifest.permissions.includes("sessions"));
  assert.ok((manifest.optional_permissions || []).includes("sessions"));
});

test("incognito is not allowed (#109): what reaches the agent cannot be forgotten", () => {
  assert.equal(manifest.incognito, "not_allowed");
});

test("notifications is a required permission (katashiro.notify)", () => {
  assert.ok(manifest.permissions.includes("notifications"));
});

test("canvas: the frames are sandbox pages with a no-network CSP; nothing is web-accessible", () => {
  // canvas-html-frame.html: an html canvas after Run scripts (canvas-html §2.4).
  assert.deepEqual(manifest.sandbox.pages, ["canvas-frame.html", "canvas-html-frame.html"]);
  const csp = manifest.content_security_policy.sandbox;
  // allow-modals: print() for PDF export (§3.8); allow-downloads: an html canvas's own exports after
  // Run scripts (canvas-html §6 Q2). The CSP is one policy for every sandbox page, so it is the loosest
  // any frame needs; the iframe's sandbox attribute narrows each (both apply): canvas-frame.html never
  // gets allow-downloads, canvas-html-frame.html never allow-modals.
  assert.match(csp, /^sandbox allow-scripts allow-modals allow-downloads;/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-popups|allow-forms|allow-top-navigation/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  // 'unsafe-inline' scripts reach only canvas-html-frame.html: canvas-frame.html narrows itself with
  // a meta CSP script-src 'self' (canvas §3.2).
  assert.match(csp, /script-src 'self' 'unsafe-inline';/);
  const frameHtml = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "canvas-frame.html"), "utf8");
  assert.match(frameHtml, /<meta http-equiv="Content-Security-Policy" content="script-src 'self'">/);
  for (const d of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "frame-src 'none'",
    "worker-src 'none'", "form-action 'none'", "base-uri 'none'", "img-src data: blob:"]) {
    assert.ok(csp.includes(d), `sandbox CSP lacks ${d}`);
  }
  // ADR §3.2: canvas pages (canvas.html, the canvas-gallery.html of §3.7) must never be
  // web_accessible_resources (no framing by web pages), and the gallery is no sandbox page.
  assert.equal(manifest.web_accessible_resources, undefined);
  // canvas.html (an extension page) may frame only our own pages.
  assert.match(manifest.content_security_policy.extension_pages, /frame-src 'self';/);
});

test("unlimitedStorage is required (canvases outgrow the 10 MB storage.local quota)", () => {
  assert.ok(manifest.permissions.includes("unlimitedStorage"));
});
