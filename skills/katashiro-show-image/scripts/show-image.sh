#!/usr/bin/env bash
# show-image.sh — show an image file to the user in their Katashiro side panel.
#
#   show-image.sh <file.png|jpg|jpeg|gif|webp|svg> [caption]
#
# Calls katashiro.show_image through the OpenAB MCP facade with this session's
# $OPENAB_SESSION_TOKEN, so the bytes go shell → facade → ACP tunnel → Katashiro and never pass
# through the model. Prints one result line on success; "error: …" on stderr and exit ≠ 0 otherwise.
#
# Works only in an agent session whose chat has a Katashiro tunnel attached (a Katashiro/ACP
# chat) — not in Discord/Slack-thread or cron turns. Never prints the token.
#
# Env: OPENAB_SESSION_TOKEN (set by OpenAB), OAB_FACADE_URL (default http://127.0.0.1:8848/mcp).
# Needs: bash, curl, jq, base64. Portable to macOS (bash 3.2, BSD base64/stat).
set -euo pipefail

file="${1:-}"
caption="${2:-}"
[ -n "$file" ] || { echo "usage: show-image.sh <image file> [caption]" >&2; exit 2; }
FACADE="${OAB_FACADE_URL:-http://127.0.0.1:8848/mcp}"
MAX_BYTES=$((5 * 1024 * 1024))          # katashiro.show_image cap (decoded)

[ -n "${OPENAB_SESSION_TOKEN:-}" ] || { echo "error: OPENAB_SESSION_TOKEN is not set — not running under OpenAB" >&2; exit 2; }
[ -f "$file" ] || { echo "error: no such file: $file" >&2; exit 2; }
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 2; }

lower=$(printf '%s' "$file" | tr '[:upper:]' '[:lower:]')
case "$lower" in
  *.png) mime=image/png ;;
  *.jpg|*.jpeg) mime=image/jpeg ;;
  *.gif) mime=image/gif ;;
  *.webp) mime=image/webp ;;
  *.svg) mime=image/svg+xml ;;
  *) echo "error: unsupported type (png/jpg/jpeg/gif/webp/svg): $file" >&2; exit 2 ;;
esac

size=$(wc -c < "$file" | tr -d ' ')
[ "$size" -le "$MAX_BYTES" ] || { echo "error: $file is $size bytes; show_image is capped at $MAX_BYTES — shrink it first" >&2; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

post() {  # post <body-file> [mcp-session-id] → response body on stdout, headers in $tmp/headers
  if [ -n "${2:-}" ]; then
    curl -sS -m 60 "$FACADE" -X POST \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -H "Authorization: Bearer ${OPENAB_SESSION_TOKEN}" -H "Mcp-Session-Id: $2" \
      -D "$tmp/headers" --data-binary @"$1"
  else
    curl -sS -m 60 "$FACADE" -X POST \
      -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
      -H "Authorization: Bearer ${OPENAB_SESSION_TOKEN}" \
      -D "$tmp/headers" --data-binary @"$1"
  fi
}

# 1) MCP handshake → session id
jq -n '{jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"katashiro-show-image",version:"1"}}}' > "$tmp/init.json"
post "$tmp/init.json" >/dev/null || { echo "error: cannot reach the OpenAB facade at $FACADE" >&2; exit 1; }
sid=$(grep -i '^mcp-session-id:' "$tmp/headers" | sed 's/^[^:]*: *//' | tr -d '\r')
[ -n "$sid" ] || { echo "error: facade handshake failed (no Mcp-Session-Id)" >&2; exit 1; }
echo '{"jsonrpc":"2.0","method":"notifications/initialized"}' > "$tmp/inited.json"
post "$tmp/inited.json" "$sid" >/dev/null

# 2) katashiro.show_image — the base64 goes file → jq → body file, never onto a command line
base64 < "$file" | tr -d '\n' > "$tmp/b64"
jq -n --rawfile data "$tmp/b64" --arg mime "$mime" --arg caption "$caption" '
  {jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"execute_capability",arguments:{
    name:"katashiro.show_image",
    arguments:({data:$data, mimeType:$mime} + (if $caption == "" then {} else {caption:$caption} end))}}}' > "$tmp/call.json"
post "$tmp/call.json" "$sid" > "$tmp/resp"

# 3) Result: the SSE "data:" line (or plain JSON) → JSON-RPC → the capability's text
grep '^data:' "$tmp/resp" | sed 's/^data: *//' | grep -v '^$' | tail -n 1 > "$tmp/rpc.json" || true
[ -s "$tmp/rpc.json" ] || cp "$tmp/resp" "$tmp/rpc.json"
if jq -e '.error' "$tmp/rpc.json" >/dev/null 2>&1; then
  echo "error: $(jq -r '.error.message' "$tmp/rpc.json")" >&2; exit 1
fi
text=$(jq -r '.result.content[0].text // empty' "$tmp/rpc.json")
# execute_capability may wrap the provider's result as JSON text; unwrap one level when it does.
inner=$(printf '%s' "$text" | jq -r '.content[0].text // empty' 2>/dev/null || true)
wrapped_err=$(printf '%s' "$text" | jq -r '.isError // false' 2>/dev/null || echo false)
out="${inner:-$text}"
if [ "$wrapped_err" = "true" ] || [ "$(jq -r '.result.isError // false' "$tmp/rpc.json")" = "true" ]; then
  echo "error: $out" >&2; exit 1
fi
echo "$out"
