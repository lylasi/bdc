#!/usr/bin/env bash
set -euo pipefail

URL="${1:-https://tts1.141455.xyz/voices}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_FILE="$OUT_DIR/voices.json"
OUT_MIN="$OUT_DIR/voices.min.json"

echo "Downloading voices from: $URL"
curl -fsSL "$URL" -o "$OUT_FILE.tmp"
mv "$OUT_FILE.tmp" "$OUT_FILE"
bytes=$(wc -c < "$OUT_FILE" | tr -d ' ')
echo "Saved $OUT_FILE ($bytes bytes)"

# Build compact voices (en-US, en-GB, zh-CN, zh-HK/yue-*) for frontend
if command -v node >/dev/null 2>&1; then
  node "$OUT_DIR/scripts/compact-voices.mjs" "$OUT_FILE" "$OUT_MIN"
  mbytes=$(wc -c < "$OUT_MIN" | tr -d ' ')
  echo "Saved $OUT_MIN ($mbytes bytes)"
else
  echo "[warn] Node.js not found, skip building compact voices."
fi
