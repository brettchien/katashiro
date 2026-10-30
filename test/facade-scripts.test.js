// The facade client block shared by skills/katashiro-canvas-file/scripts/canvas-file.sh and
// skills/katashiro-show-image/scripts/show-image.sh (#211 review): kept identical in both (each skill
// installs on its own, so it is copied, not sourced), and every way the facade can answer badly
// ends in one "error: …" line and exit 1 — never a jq parse error, never a silent success.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const CANVAS_FILE = path.join(ROOT, "skills", "katashiro-canvas-file", "scripts", "canvas-file.sh");
const SHOW_IMAGE = path.join(ROOT, "skills", "katashiro-show-image", "scripts", "show-image.sh");
const haveTools = ["bash", "curl", "jq", "base64"].every((t) => { try { execFileSync("which", [t]); return true; } catch (_) { return false; } });

const BEGIN = "# --- facade client:";
const END = "# --- end facade client ---";
function block(file) {
  const s = fs.readFileSync(file, "utf8");
  const a = s.indexOf(BEGIN), b = s.indexOf(END);
  assert.ok(a >= 0 && b > a, `${path.basename(file)} has the facade client block`);
  return s.slice(a, b + END.length);
}

test("facade client block: identical in canvas-file.sh and show-image.sh", () => {
  assert.equal(block(CANVAS_FILE), block(SHOW_IMAGE));
});

// A facade whose answer to one method is scripted: { status, type, body }.
function facade(answers) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      const a = answers[msg.method];
      if (a) { res.statusCode = a.status; if (a.type) res.setHeader("Content-Type", a.type); res.end(a.body); return; }
      if (msg.method === "initialize") { res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })); return; }
      if (msg.method === "notifications/initialized") { res.statusCode = 202; res.end(); return; }
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "done" }] } })}\n\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}
function run(script, args, env) {
  return new Promise((resolve) => {
    execFile("bash", [script, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const tmpFile = (name, content) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fs-")); const p = path.join(d, name); fs.writeFileSync(p, content); return p; };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const SCRIPTS = [
  ["canvas-file.sh", CANVAS_FILE, () => [tmpFile("p.md", "# hi\n"), "--kind", "markdown", "--title", "T"]],
  ["show-image.sh", SHOW_IMAGE, () => [tmpFile("dot.png", PNG)]],
];
const CASES = [
  ["tools/call: 400 + JSON-RPC error", { "tools/call": { status: 400, type: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: 2, error: { code: -32600, message: "Bad Request: No valid session" } }) } },
    /^error: the OpenAB facade answered HTTP 400: Bad Request: No valid session\n$/],
  ["tools/call: 400 + plain text", { "tools/call": { status: 400, type: "text/plain", body: "Bad Request: missing\nMcp-Session-Id header" } },
    /^error: the OpenAB facade answered HTTP 400: Bad Request: missing Mcp-Session-Id header\n$/],
  ["tools/call: 404 + empty body", { "tools/call": { status: 404, body: "" } },
    /^error: the OpenAB facade answered HTTP 404: \(empty body\)\n$/],
  ["notifications/initialized: 401", { "notifications/initialized": { status: 401, type: "text/plain", body: "unauthorized" } },
    /^error: the OpenAB facade answered HTTP 401: unauthorized\n$/],
  ["initialize: 500", { initialize: { status: 500, body: "boom" } },
    /^error: the OpenAB facade answered HTTP 500: boom\n$/],
  ["tools/call: 200 + not JSON", { "tools/call": { status: 200, type: "text/html", body: "<html>proxy login</html>" } },
    /^error: the OpenAB facade's answer is not a JSON-RPC response: <html>proxy login<\/html>\n$/],
  ["tools/call: 200 + empty body", { "tools/call": { status: 200, body: "" } },
    /^error: the OpenAB facade's answer is not a JSON-RPC response: \(empty body\)\n$/],
];
for (const [name, script, args] of SCRIPTS) {
  for (const [what, answers, stderr] of CASES) {
    test(`${name}: ${what} → one error line, exit 1`, { skip: !haveTools }, async () => {
      const f = await facade(answers);
      try {
        const r = await run(script, args(), { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
        assert.equal(r.code, 1, r.stderr);
        assert.equal(r.stdout, "");
        assert.match(r.stderr, stderr);
      } finally { f.server.close(); }
    });
  }
  test(`${name}: no facade listening → "cannot reach", exit 1`, { skip: !haveTools }, async () => {
    const f = await facade({});
    const url = f.url;
    await new Promise((r) => f.server.close(r));
    const r = await run(script, args(), { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: url });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /error: cannot reach the OpenAB facade at http:\/\/127\.0\.0\.1:\d+\/mcp\n$/);
  });
}
