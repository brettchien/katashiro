// sidepanel-load-order.test.js — the split side panel files hold declarations only (plan B).
//
// sidepanel.html loads conn.js → conversations.js → composer-ui.js → canvas-glue.js → cards.js →
// sidepanel.js as classic scripts sharing one global scope. A top-level statement in a split file
// that runs at load and touches a name declared in sidepanel.js or a later file (DOM refs, room
// state, …) is a TDZ ReferenceError that only shows up in real Chrome. So, statically: the top level
// of each split file may only be function / class / const / let / var declarations, and the
// initializers may not call anything at load except the cases listed below. Function bodies, arrow
// bodies and methods are skipped: they only run once every script has loaded.
//
// No JS parser in devDependencies, so this uses a small tokenizer (strings, templates, regex
// literals, comments) plus bracket matching. It is self-tested against the patterns it must catch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "src", "sidepanel");
const SPLIT_FILES = ["conn.js", "conversations.js", "composer-ui.js", "canvas-glue.js", "cards.js"];

// Load-time calls allowed in any initializer: built-ins that run no code of ours.
const BUILTIN_CALLS = new Set(["new Map", "new Set", "Promise.resolve"]);

// Load-time calls allowed for one binding only. Each one runs at load, so each must stay pure:
// it may call into src/core/ (loaded before every split file) but must not run anything that
// reads a name from sidepanel.js or a later file. Keep the reason next to each entry.
const ALLOWED = [
  // The executor runs synchronously, but only stores the resolver (markPanelReady, declared just above).
  { file: "conversations.js", name: "panelReady", callee: "new Promise" },
  // src/core/conv-core.js factory: destructures storage / lock and returns closures; the
  // `canvases` getter reads canvasStore (canvas-glue.js) at call time only.
  { file: "conversations.js", name: "convStore", callee: "ConvCore.createConvStore" },
  // src/core/canvas-store.js factory: closures only; isOpen / confirmEvict run at call time.
  { file: "canvas-glue.js", name: "canvasStore", callee: "CanvasStore.createCanvasStore" },
  // src/core/canvas-mirror.js factories: closures only; their callbacks run at call time.
  { file: "canvas-glue.js", name: "canvasNormalizeHold", callee: "CanvasMirror.createNormalizeHold" },
  { file: "canvas-glue.js", name: "canvasMirror", callee: "CanvasMirror.createCanvasMirror" },
  { file: "canvas-glue.js", name: "canvasTitleSettle", callee: "CanvasMirror.createTitleSettle" },
];

const KEYWORDS = new Set(("break case catch class const continue debugger default delete do else export extends " +
  "finally for function if import in instanceof let new return super switch this throw try typeof var void " +
  "while with yield await of async static get set").split(" "));
// After these names a `/` starts a regex literal, not a division.
const REGEX_AFTER = new Set("return typeof case in of new delete void throw else do yield await instanceof".split(" "));

// tokens: { t: "name" | "num" | "str" | "regex" | "punct" | "tmpl" | "tmplEnd", v, pos }
// A template literal is "tmpl" … "tmplEnd"; each ${ … } inside is tokenized normally between
// punct "${" and punct "}" so calls in it are seen.
function tokenize(src) {
  const toks = [];
  const braces = [];            // "{" or "${" — which one a "}" closes
  let i = 0;
  const push = (t, v, pos) => toks.push({ t, v, pos });
  const prevSig = () => toks[toks.length - 1];
  const regexAllowed = () => {
    const p = prevSig();
    if (!p) return true;
    if (p.t === "name") return REGEX_AFTER.has(p.v);
    if (p.t === "punct") return !(p.v === ")" || p.v === "]");
    return false;
  };
  function scanTemplate(start) {   // i is just after ` or after the } closing a ${
    while (i < src.length) {
      const c = src[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; push("tmplEnd", "`", i - 1); return; }
      if (c === "$" && src[i + 1] === "{") { push("punct", "${", i); i += 2; braces.push("${"); return; }
      i++;
    }
    throw new Error(`unterminated template at ${start}`);
  }
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) throw new Error("unterminated comment"); i = e + 2; continue; }
    if (c === "\"" || c === "'") {
      const s = i++;
      while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; if (src[i] === "\n") throw new Error(`newline in string at ${s}`); i++; }
      i++; push("str", src.slice(s, i), s); continue;
    }
    if (c === "`") { push("tmpl", "`", i); i++; scanTemplate(i - 1); continue; }
    if (c === "/" && regexAllowed()) {
      const s = i++;
      let inClass = false;
      while (i < src.length) {
        const d = src[i];
        if (d === "\\") { i += 2; continue; }
        if (d === "\n") throw new Error(`newline in regex at ${s}`);
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        i++;
      }
      i++;
      while (/[a-z]/i.test(src[i] || "")) i++;
      push("regex", src.slice(s, i), s); continue;
    }
    if (/[A-Za-z_$\u00a0-\uffff]/.test(c)) {
      const s = i;
      while (i < src.length && /[\w$\u00a0-\uffff]/.test(src[i])) i++;
      push("name", src.slice(s, i), s); continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1]))) {
      const s = i;
      while (i < src.length && /[\w.]/.test(src[i])) i++;
      push("num", src.slice(s, i), s); continue;
    }
    if (c === "{") { braces.push("{"); push("punct", "{", i); i++; continue; }
    if (c === "}") {
      const open = braces.pop();
      push("punct", "}", i); i++;
      if (open === "${") scanTemplate(i);
      continue;
    }
    const three = src.slice(i, i + 3), two = src.slice(i, i + 2);
    if (["...", "===", "!==", "**=", "<<=", ">>=", "&&=", "||=", "??="].includes(three)) { push("punct", three, i); i += 3; continue; }
    if (["=>", "?.", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--", "+=", "-=", "*=", "/=", "**"].includes(two)) { push("punct", two, i); i += 2; continue; }
    push("punct", c, i); i++;
  }
  return toks;
}

function matchBrackets(toks) {
  const match = new Array(toks.length).fill(-1);
  const stack = [];
  toks.forEach((tk, k) => {
    const v = tk.t === "tmpl" ? "`" : tk.t === "tmplEnd" ? "`end" : tk.t === "punct" ? tk.v : null;
    if (v === "(" || v === "[" || v === "{" || v === "${" || v === "`") stack.push(k);
    else if (v === ")" || v === "]" || v === "}" || v === "`end") {
      const o = stack.pop();
      if (o === undefined) throw new Error(`unbalanced ${v} at ${tk.pos}`);
      match[o] = k; match[k] = o;
    }
  });
  if (stack.length) throw new Error(`unclosed bracket at ${toks[stack[0]].pos}`);
  return match;
}

const isCallee = (p) => p && ((p.t === "name" && !KEYWORDS.has(p.v)) || (p.t === "punct" && (p.v === ")" || p.v === "]")) || p.t === "tmplEnd");

// Load-time calls in toks[from, to): everything outside function / arrow / method bodies.
function loadTimeCalls(toks, match, from, to) {
  const calls = [];
  const calleeText = (k) => {            // the member chain ending just before toks[k]
    let j = k - 1;
    const parts = [];
    while (j >= from && (toks[j].t === "name" || (toks[j].t === "punct" && (toks[j].v === "." || toks[j].v === "?.")))) parts.unshift(toks[j--].v);
    if (!parts.length) return toks[k - 1].v === ")" ? "(…)" : toks[k - 1].v;
    return parts.join("");
  };
  let k = from;
  while (k < to) {
    const tk = toks[k];
    const prev = toks[k - 1];
    // function expression: skip name, params and body
    if (tk.t === "name" && tk.v === "function") {
      let j = k + 1;
      while (toks[j].t !== "punct" || toks[j].v !== "(") j++;
      k = match[match[j] + 1] + 1;          // past the body's "}"
      continue;
    }
    // arrow: skip the body (block or expression)
    if (tk.t === "punct" && tk.v === "=>") {
      const n = toks[k + 1];
      if (n.t === "punct" && n.v === "{") { k = match[k + 1] + 1; continue; }
      let j = k + 1;
      while (j < to) {
        const u = toks[j];
        if (u.t === "punct" && (u.v === "," || u.v === ";")) break;
        if ((u.t === "punct" && (u.v === ")" || u.v === "]" || u.v === "}")) || u.t === "tmplEnd") break;   // closes an outer bracket
        if (match[j] > j) { j = match[j] + 1; continue; }
        j++;
      }
      k = j; continue;
    }
    // method / getter / setter in an object literal or class body: `name(…) {` — skip params + body
    if (tk.t === "punct" && tk.v === "(" && toks[match[k] + 1] && toks[match[k] + 1].t === "punct" && toks[match[k] + 1].v === "{" ) {
      k = match[match[k] + 1] + 1; continue;
    }
    if (tk.t === "name" && tk.v === "new") {
      let j = k + 1;
      const parts = [];
      while (toks[j].t === "name" || (toks[j].t === "punct" && toks[j].v === ".")) parts.push(toks[j++].v);
      calls.push({ callee: `new ${parts.join("")}`, pos: tk.pos });
      k = toks[j].t === "punct" && toks[j].v === "(" ? j + 1 : j;   // its arguments are still scanned
      continue;
    }
    if (tk.t === "punct" && tk.v === "(") {
      const after = toks[match[k] + 1];
      // arrow parameters (defaults included) only run when the arrow is called
      if (after && after.t === "punct" && after.v === "=>") { k = match[k] + 1; continue; }
      if (isCallee(prev)) calls.push({ callee: calleeText(k), pos: tk.pos });
    }
    if (tk.t === "tmpl" && isCallee(prev)) calls.push({ callee: `${calleeText(k)}\`…\``, pos: tk.pos });   // tagged template
    k++;
  }
  return calls;
}

// → [{ kind, name?, calls, pos }] for each top-level statement, or throws on anything that is not
// a declaration.
function topLevel(src) {
  const toks = tokenize(src);
  const match = matchBrackets(toks);
  const out = [];
  const line = (pos) => src.slice(0, pos).split("\n").length;
  const fail = (k, why) => { throw new Error(`line ${line(toks[k].pos)}: ${why}: ${src.slice(toks[k].pos, src.indexOf("\n", toks[k].pos))}`); };
  let k = 0;
  while (k < toks.length) {
    const tk = toks[k];
    if (tk.t === "punct" && tk.v === ";") { k++; continue; }
    let j = k;
    if (tk.t === "name" && tk.v === "async" && toks[k + 1] && toks[k + 1].v === "function") j = k + 1;
    if (toks[j].t === "name" && toks[j].v === "function") {
      let p = j + 1;
      while (!(toks[p].t === "punct" && toks[p].v === "(")) p++;
      const body = match[p] + 1;
      if (!(toks[body].t === "punct" && toks[body].v === "{")) fail(k, "function without a body");
      out.push({ kind: "function", name: toks[p - 1].v, calls: [], pos: tk.pos });
      k = match[body] + 1; continue;
    }
    if (tk.t === "name" && tk.v === "class") {
      const name = toks[k + 1].v;
      if (toks[k + 2].v !== "{") fail(k, "class with extends / no body (extends runs at load)");
      const open = k + 2, close = match[open];
      // A class body runs nothing at load except static members and computed keys.
      for (let m = open + 1; m < close; m++) {
        if (toks[m].t === "punct" && toks[m].v === "{" ) { m = match[m]; continue; }
        if (toks[m].t === "punct" && toks[m].v === "(") { m = match[m]; continue; }
        if (toks[m].t === "name" && toks[m].v === "static") fail(m, "static class member (runs at load)");
        if (toks[m].t === "punct" && toks[m].v === "[") fail(m, "computed class key (runs at load)");
      }
      out.push({ kind: "class", name, calls: [], pos: tk.pos });
      k = close + 1; continue;
    }
    if (tk.t === "name" && (tk.v === "const" || tk.v === "let" || tk.v === "var")) {
      let end = k + 1;
      while (end < toks.length && !(toks[end].t === "punct" && toks[end].v === ";")) end = match[end] > end ? match[end] + 1 : end + 1;
      if (end >= toks.length) fail(k, "declaration without a terminating ;");
      // one declaration per statement here; `name =` or `name;` (destructuring is not used at top level)
      if (toks[k + 1].t !== "name") fail(k, "destructuring declaration");
      out.push({ kind: tk.v, name: toks[k + 1].v, calls: loadTimeCalls(toks, match, k + 1, end), pos: tk.pos });
      k = end + 1; continue;
    }
    fail(k, "top-level statement that is not a declaration (runs at load)");
  }
  return out;
}

// --- self-test: the checker catches what it must, and does not flag closures ------------------
test("checker: flags executable top-level statements", () => {
  for (const src of [
    "foo();",
    "chrome.storage.onChanged.addListener(() => {});",
    "x = 1;",
    "if (a) { b(); }",
    "(() => { b(); })();",
    "class A { static x = f(); }",
    "class A { [f()]() {} }",
    "class A extends f() {}",
  ]) assert.throws(() => topLevel(src), /line 1:/, src);
});

test("checker: reports load-time calls in initializers", () => {
  const calls = (src) => topLevel(src).flatMap((s) => s.calls.map((c) => c.callee));
  assert.deepEqual(calls("const a = b();"), ["b"]);
  assert.deepEqual(calls("const a = X.y.z(1);"), ["X.y.z"]);
  assert.deepEqual(calls("const a = (() => 1)();"), ["(…)"]);
  assert.deepEqual(calls("const a = `x ${f()} y`;"), ["f"]);
  assert.deepEqual(calls("const a = new Foo(g());"), ["new Foo", "g"]);
  assert.deepEqual(calls("const a = { b: c() };"), ["c"]);
  assert.deepEqual(calls("let a = tag`x`;"), ["tag`…`"]);
  assert.deepEqual(calls("const a = async (x) => !!(await f(x)), b = g();"), ["g"]);
});

test("checker: closures, methods and literals are not load-time calls", () => {
  const calls = (src) => topLevel(src).flatMap((s) => s.calls.map((c) => c.callee));
  assert.deepEqual(calls("const a = () => f();"), []);
  assert.deepEqual(calls("const a = (x = g()) => { f(x); };"), []);
  assert.deepEqual(calls("const a = function (x) { return f(x); };"), []);
  assert.deepEqual(calls("const o = { m(a) { f(a); }, get g() { return h(); }, k: (x) => f(x) };"), []);
  assert.deepEqual(calls("const re = /^a(b)c\\/(d)$/g;"), []);
  assert.deepEqual(calls("const s = \"f()\" + 'g()' + `h()`;"), []);
  assert.deepEqual(calls("let a; // f()\n/* g() */ const b = 20 * 1024;"), []);
  assert.deepEqual(topLevel("async function f() { await g(); }\nclass C { m() { h(); } get x() { return 1; } }")
    .map((s) => s.kind), ["function", "class"]);
});

// --- the real files ---------------------------------------------------------------------------
for (const file of SPLIT_FILES) {
  test(`${file}: top level is declarations only, no load-time calls outside the allowlist`, () => {
    const src = fs.readFileSync(path.join(DIR, file), "utf8");
    const stmts = topLevel(src);
    assert.ok(stmts.length > 0);
    const bad = [];
    for (const s of stmts) {
      for (const c of s.calls) {
        if (BUILTIN_CALLS.has(c.callee)) continue;
        if (ALLOWED.some((a) => a.file === file && a.name === s.name && a.callee === c.callee)) continue;
        bad.push(`${s.name} = … ${c.callee}(…) (line ${src.slice(0, c.pos).split("\n").length})`);
      }
    }
    assert.deepEqual(bad, [], `${file} runs code at load — move it to sidepanel.js (or allowlist a pure core factory here)`);
  });
}

test("every allowlisted load-time call still exists (no stale entries)", () => {
  for (const a of ALLOWED) {
    const stmts = topLevel(fs.readFileSync(path.join(DIR, a.file), "utf8"));
    const s = stmts.find((x) => x.name === a.name);
    assert.ok(s && s.calls.some((c) => c.callee === a.callee), `${a.file}: ${a.name} = ${a.callee}(…) is gone — drop it from ALLOWED`);
  }
});

test("sidepanel.html loads the split files in order, before sidepanel.js", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "sidepanel.html"), "utf8");
  const order = [...html.matchAll(/<script src="src\/sidepanel\/([\w-]+\.js)"><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(order, [...SPLIT_FILES, "sidepanel.js"]);
});
