// skills/katashiro-show-image/scripts/show-image.sh against a fake OpenAB facade: the MCP handshake
// with and without an Mcp-Session-Id (a stateless facade sends none), and the show_image arguments.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "skills", "katashiro-show-image", "scripts", "show-image.sh");
const haveTools = ["bash", "curl", "jq", "base64"].every((t) => { try { execFileSync("which", [t]); return true; } catch (_) { return false; } });

function fakeFacade({ sessionId }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      calls.push({ msg, auth: req.headers.authorization, sid: req.headers["mcp-session-id"] });
      if (msg.method === "initialize") { if (sessionId) res.setHeader("Mcp-Session-Id", sessionId); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })); return; }
      if (msg.method === "notifications/initialized") { res.statusCode = 202; res.end(); return; }
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "shown image (image/png, 1 KB)" }] } })}\n\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}
function run(args, env) {
  return new Promise((resolve) => {
    execFile("bash", [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const pngFile = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "si-")); const p = path.join(d, "dot.png"); fs.writeFileSync(p, PNG); return p; };

for (const sessionId of ["s-9", null]) {
  test(`show-image.sh: ${sessionId ? "a facade with an Mcp-Session-Id" : "a stateless facade (no Mcp-Session-Id)"}`, { skip: !haveTools }, async () => {
    const f = await fakeFacade({ sessionId });
    try {
      const r = await run([pngFile(), "a dot"], { OPENAB_SESSION_TOKEN: "tok-2", OAB_FACADE_URL: f.url });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "shown image (image/png, 1 KB)\n");
      assert.deepEqual(f.calls.map((c) => c.msg.method), ["initialize", "notifications/initialized", "tools/call"]);
      const call = f.calls[2];
      assert.deepEqual(call.msg.params, { name: "execute_capability", arguments: { name: "katashiro.show_image", arguments: { data: PNG.toString("base64"), mimeType: "image/png", caption: "a dot" } } });
      assert.equal(call.auth, "Bearer tok-2");
      for (const c of f.calls.slice(1)) assert.equal(c.sid, sessionId || undefined);
    } finally { f.server.close(); }
  });
}
