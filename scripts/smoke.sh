#!/usr/bin/env bash
# Smoke test: initialize + tools/list over stdio.
# Requires: dist/index.js (npm run build first).
# No live Bridge needed — we only exercise the MCP protocol surface.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f dist/index.js ]]; then
  echo "dist/index.js missing — run: npm run build" >&2
  exit 1
fi

output=$(
  (
    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
    sleep 0.3
    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
    sleep 0.3
    printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
    sleep 0.8
  ) | PROTON_BRIDGE_USER=smoke@proton.me \
      PROTON_BRIDGE_PASS=x \
      PROTON_MAIL_FROM=smoke@proton.me \
      MCP_TRANSPORT=stdio \
      LOG_LEVEL=error \
      node dist/index.js 2>/dev/null
)

if ! grep -q '"protocolVersion":"2025-06-18"' <<< "$output"; then
  echo "[smoke] initialize response missing protocolVersion 2025-06-18" >&2
  echo "$output" | head -3 >&2
  exit 1
fi

tool_count=$(grep -o '"name":"proton_' <<< "$output" | wc -l)
if [[ "$tool_count" -ne 13 ]]; then
  echo "[smoke] expected 13 tools, found $tool_count" >&2
  exit 1
fi

echo "[smoke] OK · initialize + 13 tools listed"
