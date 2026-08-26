#!/usr/bin/env bash
# Kör ESKIL:s testsvit. Inga beroenden — Nodes inbyggda testrunner.
#
#   scripts/test.sh          allt (kräver igång-varande emulator)
#   scripts/test.sh logic    bara den rena logiken (ingen emulator behövs)
#                            — logic + mcp + mcp-transport + mcp-klienter + laget + boot + markup
#   scripts/test.sh rules    bara säkerhetsreglerna
#
# Emulatorn startas separat:
#   npx -y firebase-tools@13.35.1 emulators:start --project demo-eskil \
#     --only hosting,firestore,auth,functions
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-all}" in
  logic) exec node --test test/logic.test.js test/mcp.test.js test/mcp-transport.test.js test/mcp-klienter.test.js test/laget.test.js test/boot.test.js test/markup.test.js ;;
  rules) FILES=(test/rules.test.js) ;;
  all)   FILES=(test/*.test.js) ;;
  *) echo "Okänt argument: $1 (använd: all | logic | rules)"; exit 2 ;;
esac

if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:8080/"; then
  echo "✗ Firestore-emulatorn svarar inte på 127.0.0.1:8080."
  echo "  Starta den i ett annat fönster:"
  echo "  npx -y firebase-tools@13.35.1 emulators:start --project demo-eskil --only hosting,firestore,auth,functions"
  exit 1
fi

exec node --test "${FILES[@]}"
