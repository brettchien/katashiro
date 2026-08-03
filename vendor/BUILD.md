# Vendored libraries

MV3 CSP is `script-src 'self'` (no CDN, no `eval`), so third-party libs are vendored as prebuilt,
eval-free IIFE bundles checked into the repo. This is a one-time offline packaging step, not a runtime
build system (see ADR `docs/adr/a11y-snapshot-and-element-refs.md` §3.7).

## `dom-accessibility-api.iife.js`

Accessible **name + role** computation (W3C AccName), the engine Testing Library uses. Exposed on the
isolated-world global `window.__katashiroA11y` = `{ computeAccessibleName, computeAccessibleDescription,
getRole, isInaccessible, isDisabled }`.

- Source: `dom-accessibility-api@0.7.1` (MIT, zero runtime deps) — https://github.com/eps1lon/dom-accessibility-api
- Rebuild:
  ```sh
  mkdir build && cd build && npm init -y && npm i dom-accessibility-api@0.7.1
  cat > entry.js <<'JS'
  import { computeAccessibleName, computeAccessibleDescription, getRole, isInaccessible, isDisabled } from "dom-accessibility-api";
  globalThis.__katashiroA11y = { computeAccessibleName, computeAccessibleDescription, getRole, isInaccessible, isDisabled };
  JS
  npx esbuild entry.js --bundle --format=iife --minify --legal-comments=none \
    --outfile=../vendor/dom-accessibility-api.iife.js
  ```
- Verified: eval-free (`grep -cE '\beval\(|new Function\('` → 0), `getRole`/`computeAccessibleName`
  callable at runtime.

## `markdown-it.iife.js` / `dompurify.iife.js`

The chat markdown pipeline (ADR `docs/adr/chat-markdown-rendering.md`): `markdownit` renders
message markdown → HTML, `DOMPurify` sanitizes it. Both exposed as browser globals (`markdownit`,
`DOMPurify`) and consumed by `markdown.js`'s `renderMarkdown` sink.

**DOMPurify is a *security* dependency** (ADR §3.1): mXSS bypasses are found and patched
periodically, so a frozen bundle accrues latent XSS. Pin exact versions, watch cure53 / GHSA
advisories, and rebuild — not "vendor once and forget".

- Source: `markdown-it@15.0.0` (MIT), `dompurify@3.4.12` (MPL-2.0 OR Apache-2.0), zero-`eval` both.
- Rebuild:
  ```sh
  mkdir build && cd build && npm init -y && npm i markdown-it@15 dompurify@3
  printf 'import m from "markdown-it";globalThis.markdownit=m;\n' > entry-md.js
  printf 'import d from "dompurify";globalThis.DOMPurify=d;\n'    > entry-dp.js
  npx esbuild entry-md.js --bundle --format=iife --minify --legal-comments=none \
    --outfile=../vendor/markdown-it.iife.js
  npx esbuild entry-dp.js --bundle --format=iife --minify --legal-comments=none \
    --outfile=../vendor/dompurify.iife.js
  ```
- Verified: eval-free (grep → 0); `renderMarkdown` renders GFM tables and strips
  `<script>` / `javascript:` / `onerror` (jsdom smoke test).
