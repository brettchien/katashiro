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
