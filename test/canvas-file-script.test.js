// skills/katashiro-canvas-file/scripts/canvas-file.sh (canvas-html ADR §2.2) against a fake OpenAB
// facade: the MCP handshake, the canvas_open arguments it builds (the file's bytes as content, never
// on a command line), --id with and without --base (canvas_read for the version), caps and errors,
// and a stateless facade (no Mcp-Session-Id).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const SCRIPT = path.join(__dirname, "..", "skills", "katashiro-canvas-file", "scripts", "canvas-file.sh");
const haveIconv = (() => { try { require("node:child_process").execFileSync("which", ["iconv"]); return true; } catch (_) { return false; } })();
const haveTools = ["bash", "curl", "jq"].every((t) => { try { require("node:child_process").execFileSync("which", [t]); return true; } catch (_) { return false; } });

function fakeFacade({ onCall, sessionId = "s-1" }) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const msg = JSON.parse(body);
      calls.push({ msg, auth: req.headers.authorization, sid: req.headers["mcp-session-id"] });
      if (msg.method === "initialize") { if (sessionId) res.setHeader("Mcp-Session-Id", sessionId); res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })); return; }
      if (msg.method === "notifications/initialized") { res.statusCode = 202; res.end(); return; }
      const { text, isError } = onCall(msg.params.arguments);
      // SSE framing, as the facade answers
      res.setHeader("Content-Type", "text/event-stream");
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: !!isError } })}\n\n`);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}
function run(args, env) {
  return new Promise((resolve) => {
    execFile("bash", [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}
const tmpFile = (name, content) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "cf-")); const p = path.join(d, name); fs.writeFileSync(p, content); return p; };

test("canvas-file.sh: creates an html canvas from a file; the content is the file, the token only in the header", { skip: !haveTools }, async () => {
  const f = await fakeFacade({ onCall: (a) => ({ text: `created canvas "${a.arguments.title}" — id cv_00000000000a, version 1 (opened in a background tab)` }) });
  try {
    const page = `<!DOCTYPE html><html><body><script>let s = '$(rm -rf /)' + "\`x\`";</script>é</body></html>`;
    const file = tmpFile("arch.html", page);
    const r = await run([file, "--kind", "html", "--title", "Arch map"], { OPENAB_SESSION_TOKEN: "tok-1", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^created canvas "Arch map" — id cv_00000000000a, version 1 \(opened in a background tab\) \(html, 1 KB\)\n$/);
    const call = f.calls.find((c) => c.msg.method === "tools/call");
    assert.deepEqual(call.msg.params, { name: "execute_capability", arguments: { name: "katashiro.canvas_open", arguments: { kind: "html", title: "Arch map", content: page } } });
    assert.equal(call.auth, "Bearer tok-1");
    assert.equal(call.sid, "s-1");
  } finally { f.server.close(); }
});

test("canvas-file.sh: a stateless facade (no Mcp-Session-Id) still works; no request carries a session id", { skip: !haveTools }, async () => {
  const f = await fakeFacade({ sessionId: null, onCall: (a) => ({ text: `created canvas "${a.arguments.title}" — id cv_00000000000b, version 1 (opened in a background tab)` }) });
  try {
    const file = tmpFile("s.html", "<p>stateless</p>");
    const r = await run([file, "--kind", "html", "--title", "S"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^created canvas "S" — id cv_00000000000b/);
    assert.deepEqual(f.calls.map((c) => c.msg.method), ["initialize", "notifications/initialized", "tools/call"]);
    assert.ok(f.calls.every((c) => c.sid === undefined), "no Mcp-Session-Id header sent");
  } finally { f.server.close(); }
});

test("canvas-file.sh: --id without --base reads the current version first; with --base it does not", { skip: !haveTools }, async () => {
  const seen = [];
  const f = await fakeFacade({
    onCall: (a) => {
      seen.push(a);
      if (a.name === "katashiro.canvas_read") return { text: `{"id":"cv_00000000000a","kind":"html","version":3,"bytes":10}\n\n<p>old</p>` };
      return { text: `updated canvas "T" — id cv_00000000000a, version ${a.arguments.baseVersion + 1}` };
    },
  });
  try {
    const file = tmpFile("x.html", "<p>new</p>");
    let r = await run([file, "--kind", "html", "--title", "T", "--id", "cv_00000000000a"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen.map((a) => a.name), ["katashiro.canvas_read", "katashiro.canvas_open"]);
    assert.equal(seen[1].arguments.baseVersion, 3);
    assert.match(r.stdout, /version 4/);
    seen.length = 0;
    r = await run([file, "--kind", "html", "--title", "T", "--id", "cv_00000000000a", "--base", "7"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen.map((a) => a.name), ["katashiro.canvas_open"]);
    assert.equal(seen[0].arguments.baseVersion, 7);
  } finally { f.server.close(); }
});

test("canvas-file.sh: a refusal comes back as an error; bad arguments, caps and a missing token stop before any call", { skip: !haveTools }, async () => {
  const f = await fakeFacade({ onCall: () => ({ text: "canvas_open: html canvases are turned off in Katashiro's Settings", isError: true }) });
  try {
    const file = tmpFile("p.html", "<p>x</p>");
    let r = await run([file, "--kind", "html", "--title", "T"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^error: canvas_open: html canvases are turned off/);
    const before = f.calls.length;
    r = await run([file, "--kind", "pdf", "--title", "T"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 2); assert.match(r.stderr, /--kind must be/);
    r = await run([file, "--kind", "html"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 2); assert.match(r.stderr, /usage/);
    r = await run([file, "--kind", "html", "--title", "T", "--id", "../x"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 2); assert.match(r.stderr, /not a canvas id/);
    r = await run([file, "--kind", "html", "--title", "T", "--base", "2"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 2); assert.match(r.stderr, /--base needs --id/);
    r = await run([file, "--kind", "html", "--title", "T"], { OAB_FACADE_URL: f.url });
    assert.equal(r.code, 2); assert.match(r.stderr, /OPENAB_SESSION_TOKEN is not set/);
    const big = tmpFile("big.md", "x".repeat(2 * 1024 * 1024 + 1));
    r = await run([big, "--kind", "markdown", "--title", "T"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 2); assert.match(r.stderr, /capped at 2097152/);
    const bigHtml = tmpFile("big.html", "x".repeat(4 * 1024 * 1024 + 1));
    r = await run([bigHtml, "--kind", "html", "--title", "T"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
    assert.equal(r.code, 2); assert.match(r.stderr, /capped at 4194304/);
    if (haveIconv) {
      const latin1 = tmpFile("l1.html", Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]));   // "<p>é</p>" in Latin-1
      r = await run([latin1, "--kind", "html", "--title", "T"], { OPENAB_SESSION_TOKEN: "t", OAB_FACADE_URL: f.url });
      assert.equal(r.code, 2); assert.match(r.stderr, /not valid UTF-8/);
    }
    assert.equal(f.calls.length, before, "no facade call for any of these");
  } finally { f.server.close(); }
});
