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

- Source: `markdown-it@15.0.2` (MIT), `dompurify@3.4.16` (MPL-2.0 OR Apache-2.0), zero-`eval` both.
- Rebuild: `scripts/vendor-build/build.sh` (see [Reproducible rebuild](#reproducible-rebuild) below).
- Verified: eval-free (grep → 0); `renderMarkdown` renders GFM tables and strips
  `<script>` / `javascript:` / `onerror` (jsdom smoke test).

## `highlight.iife.js`

Syntax highlighting for fenced code blocks (ADR §3.4), run inside markdown-it's `highlight` hook.
Exposed as the global `hljs`. **Curated language subset** — ~a dozen common languages, not all ~190
— to keep the bundle small.

- Source: `highlight.js@11.12.0` (BSD-3-Clause), core + registered languages:
  `javascript, typescript, python, rust, go, bash, shell, json, yaml, xml, css, sql, diff`.
- Rebuild: `scripts/vendor-build/build.sh` — the language list is `scripts/vendor-build/entry-hljs.js`.
  (Token colors live in `sidepanel.css` — a self-hosted GitHub-dark-ish `.hljs-*` subset, no CDN.)
- Verified: eval-free (grep → 0); `hljs.listLanguages()` = the 13 registered above; `hljs.highlight`
  emits `<span class="hljs-…">` tokens.

## Reproducible rebuild

The markdown-it / DOMPurify / highlight.js bundles are built from pinned inputs in
`scripts/vendor-build/` (outside `vendor/`, so they don't ship in the release zip): the three entry
files, a `package.json` with exact versions (esbuild included), and a `package-lock.json` that also
pins the transitive deps (`entities`, `linkify-it`, `mdurl`, `punycode.js`, `uc.micro`).

```sh
scripts/vendor-build/build.sh   # npm ci + esbuild, then prints the sha256 of each bundle
```

The output should be byte-identical to what is committed:

```
d15f9d734865458b907a5b7307b145f00f810a7963b6e0ad89d9d0972a2c6fb6  markdown-it.iife.js
c087a84ef0542bc645e3bcac407ffb55ff6c08558c6798dcf1448739dc1fe406  dompurify.iife.js
add316e5136c3ed131ab6dbe99bdd05195f236462093f017426fc439eab64713  highlight.iife.js
```

To bump a version: edit `package.json`, run `npm i --package-lock-only` there, run `build.sh`, and update
the hashes above.

**Keep `"type": "module"`.** With `"type": "commonjs"` (which newer `npm init -y` writes), esbuild treats
the ESM entry files as needing lazy-init wrappers (`__esm`). The bundle still behaves the same, but it's
a few hundred bytes larger and its hash no longer matches.
