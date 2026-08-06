#!/usr/bin/env bash
# Stamp build-info.json for a local unpacked dev load (ADR build-provenance-and-version-display).
#
# The connection screen reads build-info.json to show `vX.Y.Z · <sha>` so you can confirm which
# build actually loaded after a chrome://extensions Update + panel reopen — the short sha tells
# same-version feature branches apart. build-info.json is gitignored; run this before loading (or
# wire it as a git post-checkout / post-commit hook) to keep the sha current. If you never run it,
# the panel just shows `dev`.
set -euo pipefail
cd "$(dirname "$0")/.."

sha="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
# Mark a dirty working tree so a stamp built from uncommitted edits is not mistaken for the commit.
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  sha="${sha}-dirty"
fi
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat > build-info.json <<EOF
{"tag":null,"sha":"${sha}","builtAt":"${built_at}"}
EOF

echo "stamped build-info.json: sha=${sha} builtAt=${built_at}"
