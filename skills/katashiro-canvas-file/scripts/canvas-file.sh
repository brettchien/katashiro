#!/usr/bin/env bash
# canvas-file.sh — put a file into a Katashiro canvas without passing it through the model.
#
#   canvas-file.sh <file> --kind html|markdown|slides|mermaid|image --title "…" [--id <canvasId> [--base <version>]] [--caption "…"]
#
# Calls katashiro.canvas_open through the OpenAB MCP facade with this session's
# $OPENAB_SESSION_TOKEN, so the bytes go shell → facade → ACP tunnel → Katashiro, never through
# the model (canvas-html ADR §2.2: a 0.85 MB Archify page is ~250 K output tokens). Without --id it
# creates a canvas; with --id it writes a new revision of that canvas, on top of --base (the
# version you last wrote or read) — or, without --base, on top of the version canvas_read reports
# now. Prints one result line on success; "error: …" on stderr and exit ≠ 0 otherwise.
#
# Works only in an agent session whose chat has a Katashiro tunnel attached (a Katashiro/ACP
# chat) — not in Discord/Slack-thread or cron turns. Never prints the token.
#
# Env: OPENAB_SESSION_TOKEN (set by OpenAB), OAB_FACADE_URL (default http://127.0.0.1:8848/mcp).
# Needs: bash, curl, jq, base64 (image only). Portable to macOS (bash 3.2, BSD base64).
set -euo pipefail

usage() { echo 'usage: canvas-file.sh <file> --kind html|markdown|slides|mermaid|image --title "…" [--id <canvasId> [--base <version>]] [--caption "…"]' >&2; exit 2; }
file="" kind="" title="" id="" base="" caption=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kind) kind="${2:-}"; shift 2 ;;
    --title) title="${2:-}"; shift 2 ;;
    --id) id="${2:-}"; shift 2 ;;
    --base) base="${2:-}"; shift 2 ;;
    --caption) caption="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "error: unknown option $1" >&2; usage ;;
    *) [ -z "$file" ] || usage; file="$1"; shift ;;
  esac
done
[ -n "$file" ] && [ -n "$kind" ] && [ -n "$title" ] || usage
FACADE="${OAB_FACADE_URL:-http://127.0.0.1:8848/mcp}"

case "$kind" in
  html) MAX_BYTES=$((4 * 1024 * 1024)) ;;            # canvas-html §6 Q1
  markdown|slides|mermaid) MAX_BYTES=$((2 * 1024 * 1024)) ;;
  image) MAX_BYTES=$((5 * 1024 * 1024)) ;;
  *) echo "error: --kind must be html, markdown, slides, mermaid or image" >&2; exit 2 ;;
esac
case "$id" in ""|cv_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) echo "error: --id is not a canvas id: $id" >&2; exit 2 ;; esac
if [ -n "$base" ]; then case "$base" in *[!0-9]*) echo "error: --base must be a version number" >&2; exit 2 ;; esac; fi
[ -z "$base" ] || [ -n "$id" ] || { echo "error: --base needs --id" >&2; exit 2; }

[ -n "${OPENAB_SESSION_TOKEN:-}" ] || { echo "error: OPENAB_SESSION_TOKEN is not set — not running under OpenAB" >&2; exit 2; }
[ -f "$file" ] || { echo "error: no such file: $file" >&2; exit 2; }
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 2; }

mime=""
if [ "$kind" = image ]; then
  lower=$(printf '%s' "$file" | tr '[:upper:]' '[:lower:]')
  case "$lower" in
    *.png) mime=image/png ;;
    *.jpg|*.jpeg) mime=image/jpeg ;;
    *.gif) mime=image/gif ;;
    *.webp) mime=image/webp ;;
    *.svg) mime=image/svg+xml ;;
    *) echo "error: unsupported image type (png/jpg/jpeg/gif/webp/svg): $file" >&2; exit 2 ;;
  esac
fi

size=$(wc -c < "$file" | tr -d ' ')
[ "$size" -le "$MAX_BYTES" ] || { echo "error: $file is $size bytes; a $kind canvas is capped at $MAX_BYTES" >&2; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# The bearer token goes in a 0600 header file read by curl (-H @file, curl ≥ 7.55), never on the
# command line, where any process on the host could read it from ps.
( umask 077; printf 'Authorization: Bearer %s\n' "$OPENAB_SESSION_TOKEN" > "$tmp/auth" )

post() {  # post <body-file> [mcp-session-id] → response body on stdout, headers in $tmp/headers
  if [ -n "${2:-}" ]; then
    curl -sS -m 120 "$FACADE" -X POST \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -H @"$tmp/auth" -H "Mcp-Session-Id: $2" \
      -D "$tmp/headers" --data-binary @"$1"
  else
    curl -sS -m 120 "$FACADE" -X POST \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -H @"$tmp/auth" \
      -D "$tmp/headers" --data-binary @"$1"
  fi
}

# The capability's text from a response ($1), or "error: …" on stderr and exit 1.
result_text() {
  grep '^data:' "$1" | sed 's/^data: *//' | grep -v '^$' | tail -n 1 > "$tmp/rpc.json" || true
  [ -s "$tmp/rpc.json" ] || cp "$1" "$tmp/rpc.json"
  if jq -e '.error' "$tmp/rpc.json" >/dev/null 2>&1; then
    echo "error: $(jq -r '.error.message' "$tmp/rpc.json")" >&2; exit 1
  fi
  local text inner wrapped_err out
  text=$(jq -r '.result.content[0].text // empty' "$tmp/rpc.json")
  # execute_capability may wrap the provider's result as JSON text; unwrap one level when it does.
  inner=$(printf '%s' "$text" | jq -r '.content[0].text // empty' 2>/dev/null || true)
  wrapped_err=$(printf '%s' "$text" | jq -r '.isError // false' 2>/dev/null || echo false)
  out="${inner:-$text}"
  if [ "$wrapped_err" = "true" ] || [ "$(jq -r '.result.isError // false' "$tmp/rpc.json")" = "true" ]; then
    echo "error: $out" >&2; exit 1
  fi
  printf '%s' "$out"
}

# 1) MCP handshake → session id
jq -n '{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"katashiro-canvas-file",version:"1"}}}' > "$tmp/init.json"
post "$tmp/init.json" >/dev/null || { echo "error: cannot reach the OpenAB facade at $FACADE" >&2; exit 1; }
sid=$(grep -i '^mcp-session-id:' "$tmp/headers" | sed 's/^[^:]*: *//' | tr -d '\r')
[ -n "$sid" ] || { echo "error: facade handshake failed (no Mcp-Session-Id)" >&2; exit 1; }
echo '{"jsonrpc":"2.0","method":"notifications/initialized"}' > "$tmp/inited.json"
post "$tmp/inited.json" "$sid" >/dev/null || { echo "error: facade handshake failed (notifications/initialized)" >&2; exit 1; }

# 2) A new revision without --base: the version canvas_read reports now (its first line is JSON).
if [ -n "$id" ] && [ -z "$base" ]; then
  jq -n --arg id "$id" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"execute_capability",arguments:{name:"katashiro.canvas_read",arguments:{id:$id}}}}' > "$tmp/read.json"
  post "$tmp/read.json" "$sid" > "$tmp/read-resp" || { echo "error: the canvas_read call to the facade failed" >&2; exit 1; }
  base=$(result_text "$tmp/read-resp" | head -n 1 | jq -r '.version // empty' 2>/dev/null || true)
  case "$base" in ""|*[!0-9]*) echo "error: could not read the current version of $id" >&2; exit 1 ;; esac
fi

# 3) katashiro.canvas_open — the file goes file → jq → body file, never onto a command line
if [ "$kind" = image ]; then
  base64 < "$file" | tr -d '\n' > "$tmp/payload"
else
  cp "$file" "$tmp/payload"
fi
jq -n --rawfile payload "$tmp/payload" --arg kind "$kind" --arg title "$title" --arg id "$id" --arg base "$base" \
  --arg mime "$mime" --arg caption "$caption" '
  {jsonrpc:"2.0",id:3,method:"tools/call",params:{name:"execute_capability",arguments:{
    name:"katashiro.canvas_open",
    arguments:({kind:$kind, title:$title}
      + (if $kind == "image" then {data:$payload, mimeType:$mime} + (if $caption == "" then {} else {caption:$caption} end) else {content:$payload} end)
      + (if $id == "" then {} else {id:$id, baseVersion:($base|tonumber)} end))}}}' > "$tmp/call.json"
post "$tmp/call.json" "$sid" > "$tmp/resp" || { echo "error: the canvas_open call to the facade failed" >&2; exit 1; }
out=$(result_text "$tmp/resp")
echo "$out ($kind, $(( (size + 1023) / 1024 )) KB)"
