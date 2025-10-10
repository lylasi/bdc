#!/usr/bin/env bash
set -euo pipefail

URL="${1:-https://tts1.141455.xyz/voices}"
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_FILE="$OUT_DIR/voices.json"

echo "Downloading voices from: $URL"
curl -fsSL "$URL" -o "$OUT_FILE.tmp"
mv "$OUT_FILE.tmp" "$OUT_FILE"
bytes=$(wc -c < "$OUT_FILE" | tr -d ' ')
echo "Saved $OUT_FILE ($bytes bytes)"

