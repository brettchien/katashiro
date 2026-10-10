#!/bin/sh
# Rebuilds the chat-markdown vendor bundles from the pinned inputs here. See vendor/BUILD.md.
set -eu
cd "$(dirname "$0")"
npm ci --silent
for e in md:markdown-it dp:dompurify hljs:highlight; do
  npx esbuild "entry-${e%%:*}.js" --bundle --format=iife --minify --legal-comments=none \
    --outfile="../../vendor/${e#*:}.iife.js" --log-level=warning
done
cd ../../vendor && sha256sum markdown-it.iife.js dompurify.iife.js highlight.iife.js
