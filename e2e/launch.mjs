// launch.mjs — where the T2 E2E cases get puppeteer-core and Chrome, and how they start it.
//
//   npm ci && npm run chrome:full     # puppeteer-core into node_modules/, Chrome for Testing into .cache/chrome
//   npm run e2e                       # every case (e2e/run.mjs)
//
// Overrides, for a puppeteer-core or a Chrome you already have:
//   PUPPETEER_CORE=/path/to/node_modules/puppeteer-core
//   CHROME_FULL=/path/to/chrome           (full Chrome for Testing, NOT chrome-headless-shell)
//
// Full Chrome, not the headless shell the smokes use: the shell cannot load an extension. The
// version is the one pinned in package.json (config.chromeVersion), shared with the smokes.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
export const CHROME_VERSION = pkg.config.chromeVersion;
const CACHE_DIR = path.join(ROOT, ".cache", "chrome");

const die = (msg) => {
  console.error(`e2e: ${msg}`);
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
  if (process.env.CHROME_FULL) {
    if (!fs.existsSync(process.env.CHROME_FULL)) die(`CHROME_FULL=${process.env.CHROME_FULL} does not exist.`);
    return process.env.CHROME_FULL;
  }
  let browsers;
  try {
    browsers = await import("@puppeteer/browsers");
  } catch (e) {
    if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    return die("@puppeteer/browsers is not installed. Run `npm ci` in the repo root (or set CHROME_FULL=/path/to/chrome).");
  }
  const exe = browsers.computeExecutablePath({ browser: browsers.Browser.CHROME, buildId: CHROME_VERSION, cacheDir: CACHE_DIR });
  if (!fs.existsSync(exe)) {
    die(`Chrome for Testing ${CHROME_VERSION} is not installed (looked for ${path.relative(ROOT, exe)}). ` +
      "Run `npm run chrome:full` in the repo root (or set CHROME_FULL=/path/to/chrome).");
  }
  return exe;
}

export const puppeteer = await loadPuppeteer();
export const CHROME = await chromePath();

// A fresh profile per launch (puppeteer's temporary user-data-dir), the repo loaded unpacked.
// headless: true is Chrome's "new" headless — the full browser, so extensions, the side panel,
// tab groups and notifications are the real ones. pipe: true is required by enableExtensions.
export const launch = () => puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.E2E_HEADFUL ? false : true,
  pipe: true,
  enableExtensions: [ROOT],
  args: ["--no-sandbox", "--window-size=1280,900"],
  defaultViewport: null,
});
