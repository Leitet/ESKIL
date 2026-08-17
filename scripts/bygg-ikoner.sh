#!/usr/bin/env bash
# Bygger om ikonuppsättningen ur SVG-källorna i designbiblioteket.
#
# Kör detta efter VARJE ändring i eskil-favicon.svg eller eskil-appicon.svg —
# PNG:erna och .ico:n är genererade, inte handgjorda.
#
# Varje storlek renderas FÖR SIG ur vektorn. Låt aldrig ett verktyg skala ner
# en stor PNG till 16 och 32 px: nedskalning av den detaljrika symbolen är
# precis det som gav grå gröt och hela skälet till att favicon:en är en egen
# teckning. Bibliotekets README.txt har detaljerna.
#
# Granska resultatet efteråt genom att titta på en pixelförstoring
# (image-rendering: pixelated) i 16 px — en utjämnad uppskalning döljer det
# som går sönder.
set -euo pipefail

ROT="$(cd "$(dirname "$0")/.." && pwd)"
BIB="$ROT/public/assets/eskil_design_library"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -x "$CHROME" ] || { echo "Hittar inte Chrome på $CHROME — sätt CHROME=..." >&2; exit 1; }

rendera () {  # $1 svg-sökväg  $2 storlek  $3 utfil  $4 bakgrund (rrggbbaa)
  printf '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:%dpx;height:%dpx}</style><img src="file://%s">' \
    "$2" "$2" "$1" > "$TMP/sida.html"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --default-background-color="$4" --window-size="$2","$2" \
    --screenshot="$3" "file://$TMP/sida.html" 2>/dev/null
  # Chrome misslyckas INTE på en saknad fil — den renderar en tom sida. Utan
  # den här kontrollen skriver skriptet tysta, tomma ikoner.
  [ -s "$3" ] || { echo "TOM rendering: $3" >&2; exit 1; }
}

for S in 16 32 48; do rendera "$BIB/svg/eskil-favicon.svg" "$S" "$TMP/fav-$S.png" 00000000; done
python3 "$ROT/scripts/packa-ico.py" "$ROT/public/favicon.ico" "$TMP/fav-16.png" "$TMP/fav-32.png" "$TMP/fav-48.png"
cp "$TMP/fav-32.png" "$BIB/png/eskil-favicon-32.png"
rendera "$BIB/svg/eskil-favicon.svg" 512 "$BIB/png/eskil-favicon-512.png" 00000000
# Hemskärmsikonen är OPAK — iOS lägger transparens på vitt, vilket ger tillbaka
# den vita ram vi tog bort.
rendera "$BIB/svg/eskil-appicon.svg" 180 "$BIB/png/eskil-appicon-180.png" 003660ff

echo "Klart: favicon.ico (16/32/48), eskil-favicon-32/512.png, eskil-appicon-180.png"
