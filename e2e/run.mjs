#!/usr/bin/env node
// run.mjs — run the T2 E2E cases (e2e/cases/*.mjs) one scenario after another, each in a fresh
// Chrome profile with the real extension and its own fake gateway; print a summary; exit non-zero
// if any scenario failed. `npm run e2e`; `npm run e2e -- p2-background` runs the scenarios whose
// file or name contains one of the words given. Setup: e2e/README.md.
//
// A scenario may be marked `xfail: "<reason>"` with `xfailChecks: [/regex/, …]`: a known product
// bug (an open issue). When it fails exactly there — every failed check matches one of the
// regexes, nothing threw — it is reported as "xfail" and does not fail the run. Any other failure
// (a harness error, a timeout, another check) is a real FAIL. If it passes it is reported as
// "XPASS" (not a failure either — the fix landed: drop the mark).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startSession, checker } from "./helpers.mjs";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "cases");
const SCENARIO_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 90000;

const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".mjs")).sort();
const scenarios = [];
for (const f of files) {
  const mod = await import(pathToFileURL(path.join(DIR, f)).href);
  for (const s of mod.default) scenarios.push({ ...s, file: f });
}
const wanted = process.argv.slice(2);
const picked = wanted.length ? scenarios.filter((s) => wanted.some((w) => s.file.includes(w) || s.name.includes(w))) : scenarios;
if (!picked.length) {
  console.error(`no scenario matches ${wanted.join(", ")} — have:\n${scenarios.map((s) => `  ${s.file}: ${s.name}`).join("\n")}`);
  process.exit(2);
}

const results = [];
const started = Date.now();
for (const s of picked) {
  console.log(`\n=== ${s.file} — ${s.name}${s.xfail ? `  [xfail: ${s.xfail}]` : ""}`);
  const t0 = Date.now();
  const log = (line) => console.log(`  ${line}`);
  const t = checker(log);
  let ctx = null;
  let timer;
  try {
    ctx = await startSession({ log });
    await Promise.race([
      s.run(ctx, t),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`scenario timed out after ${SCENARIO_TIMEOUT_MS / 1000} s`)), SCENARIO_TIMEOUT_MS); }),
    ]);
    for (const p of ctx.panels) for (const e of p.__errors || []) t.fail(`page error in the side panel: ${e}`);
  } catch (e) {
    t.fail(`threw: ${(e && e.stack) || e}`);
  } finally {
    clearTimeout(timer);
    if (ctx) await ctx.close();
  }
  const secs = (Date.now() - t0) / 1000;
  const failed = t.failures.length > 0;
  const expected = s.xfail && failed && t.failures.every((m) => (s.xfailChecks || []).some((re) => re.test(m)));
  const status = !failed ? (s.xfail ? "XPASS" : "ok") : expected ? "xfail" : "FAIL";
  results.push({ ...s, status, secs, failures: t.failures });
  console.log(`--- ${status} (${secs.toFixed(1)} s)`);
}

console.log("\n=== summary");
for (const r of results) {
  const why = r.status === "FAIL" ? ` — ${r.failures.length} failed check(s)` : r.status === "xfail" ? ` — expected: ${r.xfail}` : r.status === "XPASS" ? " — passed although marked xfail: remove the mark" : "";
  console.log(`${r.status.padEnd(5)} ${`${r.file}: ${r.name}`.padEnd(72)} ${r.secs.toFixed(1).padStart(6)} s${why}`);
}
const bad = results.filter((r) => r.status === "FAIL");
for (const r of bad) for (const f of r.failures) console.log(`  ${r.file} / ${r.name}: ${f.split("\n")[0]}`);
const n = (st) => results.filter((r) => r.status === st).length;
console.log(`\n${n("ok")} ok, ${n("FAIL")} failed, ${n("xfail")} xfail, ${n("XPASS")} xpass — ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(bad.length ? 1 : 0);
