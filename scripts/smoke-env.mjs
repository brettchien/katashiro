// smoke-env.mjs — where the puppeteer smokes (scripts/smoke-*.mjs) get puppeteer-core and Chrome.
//
//   npm ci && npm run chrome     # puppeteer-core into node_modules/, the pinned headless shell into .cache/chrome
//   node scripts/smoke-x.mjs     # or `npm run smoke` for all of them
//
// Overrides, for a puppeteer-core or a Chrome you already have:
//   PUPPETEER_CORE=/path/to/node_modules/puppeteer-core
//   CHROME=/path/to/chrome-headless-shell
//
// The Chrome version is pinned once, in package.json's config.chromeVersion (`npm run chrome`
// installs that one); the smokes never pick up whatever other Chrome happens to be around.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
export const CHROME_VERSION = pkg.config.chromeVersion;
const CACHE_DIR = path.join(ROOT, ".cache", "chrome");

const die = (msg) => {
  console.error(`smoke-env: ${msg}`);
  process.exit(2);
};

async function loadPuppeteer() {
  const dir = process.env.PUPPETEER_CORE;
  if (dir) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return (await import(pathToFileURL(path.join(dir, p.exports["."].import)).href)).default;
  }
  try {
    return (await import("puppeteer-core")).default;
  } catch (e) {
    if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    return die("puppeteer-core is not installed. Run `npm ci` in the repo root (or set PUPPETEER_CORE=/path/to/node_modules/puppeteer-core).");
  }
}

async function chromePath() {
  if (process.env.CHROME) {
    if (!fs.existsSync(process.env.CHROME)) die(`CHROME=${process.env.CHROME} does not exist.`);
    return process.env.CHROME;
  }
  let browsers;
  try {
    browsers = await import("@puppeteer/browsers");
  } catch (e) {
    if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    return die("@puppeteer/browsers is not installed. Run `npm ci` in the repo root (or set CHROME=/path/to/chrome-headless-shell).");
  }
  const exe = browsers.computeExecutablePath({
    browser: browsers.Browser.CHROMEHEADLESSSHELL,
    buildId: CHROME_VERSION,
    cacheDir: CACHE_DIR,
  });
  if (!fs.existsSync(exe)) {
    die(`chrome-headless-shell ${CHROME_VERSION} is not installed (looked for ${path.relative(ROOT, exe)}). ` +
      "Run `npm run chrome` in the repo root (or set CHROME=/path/to/chrome-headless-shell).");
  }
  return exe;
}

export const puppeteer = await loadPuppeteer();
export const CHROME = await chromePath();

// Every smoke launches the same way.
export const launch = () => puppeteer.launch({ executablePath: CHROME, headless: "shell", args: ["--no-sandbox"] });
