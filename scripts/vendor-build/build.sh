#!/bin/sh
# Rebuilds the chat-markdown vendor bundles from the pinned inputs here. See vendor/BUILD.md.
set -eu
cd "$(dirname "$0")"
npm ci --silent
for e in md:markdown-it dp:dompurify hljs:highlight; do
  npx esbuild "entry-${e%%:*}.js" --bundle --format=iife --minify --legal-comments=none \
    --outfile="../../vendor/${e#*:}.iife.js" --log-level=warning
done
# Milkdown crepe (canvas editing, ADR canvas §3.5): JS as an IIFE (global KatashiroMilkdown), CSS
# without latex.css (KaTeX font url()s; the Latex feature is disabled).
mkdir -p ../../vendor/milkdown
npx esbuild entry-crepe.js --bundle --format=iife --minify --legal-comments=none \
  --outfile=../../vendor/milkdown/crepe.iife.js --log-level=warning
npx esbuild entry-crepe.css --bundle --minify --outfile=../../vendor/milkdown/crepe.css --log-level=warning
# reveal.js ships a prebuilt UMD (global `Reveal`, eval-free) and CSS: copied as-is. The dracula theme
# is the one with no @import / url() (system fonts), so the sandbox CSP loads it with no violations.
mkdir -p ../../vendor/reveal
cp node_modules/reveal.js/dist/reveal.js node_modules/reveal.js/dist/reveal.css ../../vendor/reveal/
cp node_modules/reveal.js/dist/theme/dracula.css ../../vendor/reveal/theme-dracula.css
cd ../../vendor && sha256sum markdown-it.iife.js dompurify.iife.js highlight.iife.js \
  reveal/reveal.js reveal/reveal.css reveal/theme-dracula.css milkdown/crepe.iife.js milkdown/crepe.css
