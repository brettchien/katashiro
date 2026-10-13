#!/usr/bin/env node
// run-smokes.mjs — run every puppeteer smoke (scripts/smoke-*.mjs) one after another, print a
// summary, exit non-zero if any failed. `npm run smoke`; `npm run smoke -- mermaid ask-popover` runs
// only the named ones. Setup and the CHROME / PUPPETEER_CORE overrides: scripts/lib/smoke-env.mjs.
//
// Naming rule: every scripts/smoke-<name>.mjs IS a smoke and runs here. Code the smokes share
// (helpers, setup) goes in scripts/lib/, never as scripts/smoke-*.mjs.
//
// Sequential on purpose: each smoke starts its own Chrome, and several timing-sensitive checks (a
// tool call answered within its bound, a Web Lock held across pages) are what we test, so a loaded
// machine running them side by side would only add noise. All of them take about a minute.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const all = fs.readdirSync(DIR)
  .filter((f) => /^smoke-.+\.mjs$/.test(f))
  .sort();
const wanted = process.argv.slice(2).map((a) => a.replace(/^smoke-/, "").replace(/\.mjs$/, ""));
const unknown = wanted.filter((w) => !all.includes(`smoke-${w}.mjs`));
if (unknown.length) {
  console.error(`unknown smoke(s): ${unknown.join(", ")} — have: ${all.map((f) => f.slice(6, -4)).join(", ")}`);
  process.exit(2);
}
const smokes = wanted.length ? wanted.map((w) => `smoke-${w}.mjs`) : all;

const run = (file) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(DIR, file)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const take = (stream, sink) => stream.on("data", (b) => { out += b; sink.write(b); });
  take(child.stdout, process.stdout);
  take(child.stderr, process.stderr);
  child.on("close", (code, signal) => resolve({
    file, code: code ?? 1, signal, secs: (Date.now() - started) / 1000,
    fails: out.split("\n").filter((l) => l.startsWith("FAIL ")),
  }));
});

const results = [];
for (const file of smokes) {
  console.log(`\n=== ${file}`);
  results.push(await run(file));
}

console.log("\n=== summary");
for (const r of results) {
  const status = r.code === 0 ? "ok  " : "FAIL";
  const why = r.code === 0 ? "" : r.fails.length ? ` — ${r.fails.length} failed check(s)` : r.signal ? ` — killed by ${r.signal}` : ` — exit ${r.code}`;
  console.log(`${status} ${r.file.padEnd(32)} ${r.secs.toFixed(1).padStart(6)} s${why}`);
}
const bad = results.filter((r) => r.code !== 0);
for (const r of bad) for (const f of r.fails) console.log(`  ${r.file}: ${f}`);
console.log(bad.length ? `\n${bad.length} of ${results.length} smoke(s) failed` : `\nall ${results.length} smokes ok`);
process.exit(bad.length ? 1 : 0);
