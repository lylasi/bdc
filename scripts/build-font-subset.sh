#!/usr/bin/env bash
set -euo pipefail

# Build a subset of NotoSansTC-Regular using modules/fonts/subset-chars.txt
# Output files:
#  - modules/fonts/NotoSansTC-Subset.ttf
#  - modules/fonts/NotoSansTC-Subset.base64.txt
#  - modules/fonts/NotoSansTC-Subset.loader.js (kept static in repo)

FONT_IN=${1:-Noto_Sans_TC/static/NotoSansTC-Regular.ttf}
CHARS_FILE=${2:-modules/fonts/subset-chars.txt}
OUT_TTF=modules/fonts/NotoSansTC-Subset.ttf
OUT_B64=modules/fonts/NotoSansTC-Subset.base64.txt

if [[ ! -f "$FONT_IN" ]]; then
  echo "Input font not found: $FONT_IN" >&2
  exit 1
fi
if [[ ! -f "$CHARS_FILE" ]]; then
  echo "Chars file not found: $CHARS_FILE" >&2
  exit 1
fi

if [[ ! -x .venv/bin/pyftsubset ]]; then
  echo "pyftsubset not found. Creating venv and installing fonttools..." >&2
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/pip install fonttools >/dev/null
fi

echo "Subsetting $FONT_IN using $CHARS_FILE ..."
.venv/bin/pyftsubset "$FONT_IN" \
  --text-file="$CHARS_FILE" \
  --output-file="$OUT_TTF" \
  --layout-features='*' \
  --no-hinting \
  --no-glyph-names \
  --symbol-cmap \
  --legacy-cmap \
  --notdef-outline \
  --drop-tables+=GSUB,GPOS,GDEF,BASE,JSTF,DSIG,FFTM \
  --name-IDs='*' \
  --name-legacy \
  --name-languages='*'

ls -lh "$OUT_TTF"
base64 -i "$OUT_TTF" > "$OUT_B64"
echo "Base64 size: $(wc -c < "$OUT_B64") bytes -> $OUT_B64"
echo "Done. Ensure index.html includes NotoSansTC-Subset.loader.js (already wired)."

