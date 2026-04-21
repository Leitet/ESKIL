#!/usr/bin/env bash
# Seed the "Demospår" demo competition.
# Idempotent — uses stable doc IDs so re-runs upsert.
#
# This is the competition that ships with production installs so everyone
# can explore the app. Non-super-admins cannot write to it (Firestore rules
# enforce).
#
# Runs against the Firestore emulator by default; override via env:
#   FIRESTORE_HOST=https://firestore.googleapis.com scripts/seed-demo.sh
# (auth for prod writes is your concern — the emulator accepts Bearer owner.)

set -e
HOST="${FIRESTORE_HOST:-http://127.0.0.1:8080}"
PROJECT="${FIREBASE_PROJECT:-demo-eskil}"
CID="demospar"
DBPATH="projects/$PROJECT/databases/(default)/documents"

echo "Seeding Demospår → $HOST ($PROJECT)"

# --- Dynamic first-start time -------------------------------------------------
# Anchor firstStart roughly 40 minutes before NOW so there's always a mix of
# patrols that have already started and many still upcoming. Rounded down to
# the nearest 5-minute mark for tidy times. Re-running the seed late in the
# day keeps the demo fresh — you don't end up with 30 patruller that already
# started at 10:00 this morning.
FIRST_START=$(python3 -c '
from datetime import datetime, timedelta
t = datetime.now() - timedelta(minutes=40)
t = t.replace(minute=(t.minute // 5) * 5, second=0, microsecond=0)
print(t.strftime("%H:%M"))
')
echo "  firstStart: $FIRST_START (anchored ~40 min before now, 10-min interval × 30 patruller)"

write() {
  local doc_path="$1"; local fields_json="$2"
  local payload
  payload=$(cat <<JSON
{"writes":[{"update":{"name":"$DBPATH/$doc_path","fields":$fields_json}}]}
JSON
)
  local resp status
  resp=$(curl -sS -w "\n__HTTP__:%{http_code}" -X POST "$HOST/v1/$DBPATH:commit" \
    -H 'Authorization: Bearer owner' -H 'Content-Type: application/json' \
    --data "$payload")
  status=$(echo "$resp" | tail -n1 | sed 's/__HTTP__://')
  if [ "$status" != "200" ]; then
    echo "ERROR writing $doc_path: $(echo "$resp" | sed '$d')" >&2
    exit 1
  fi
}

# --- Competition document ---------------------------------------------------
write "competitions/$CID" '{
  "name":        {"stringValue":"Demospår"},
  "shortName":   {"stringValue":"Demospår"},
  "year":        {"integerValue":"2026"},
  "date":        {"stringValue":"2026-05-01"},
  "location":    {"stringValue":"Lindsdal, Kalmar"},
  "organizer":   {"stringValue":"Lindsdals Scoutkår"},
  "description": {"stringValue":"Ett demospår att utforska ESKIL. Tio kontroller i en slinga genom Lindsdal. Alla kan titta; bara superadministratören kan ändra."},
  "generalInfo": {"stringValue":"Detta är ett demospår. Poängrapportering är avstängd — ingen skrivning tillåten utom från superadmin."},
  "demo":              {"booleanValue": true},
  "anonymousControls": {"booleanValue": false},
  "startTimes":        {"mapValue":{"fields":{
    "enabled":         {"booleanValue": true},
    "firstStart":      {"stringValue": "'"$FIRST_START"'"},
    "intervalMinutes": {"integerValue": "10"}
  }}},
  "startFinish": {"mapValue":{"fields":{
    "enabled": {"booleanValue": true},
    "mode":    {"stringValue": "same"},
    "start":   {"mapValue":{"fields":{
      "name": {"stringValue": "Lindsdals scoutgård"},
      "lat":  {"doubleValue": 56.73661},
      "lng":  {"doubleValue": 16.27872}
    }}}
  }}},
  "parking": {"mapValue":{"fields":{
    "enabled": {"booleanValue": true},
    "name":    {"stringValue": "Grusparkeringen vid scoutgården"},
    "lat":     {"doubleValue": 56.73632},
    "lng":     {"doubleValue": 16.27976}
  }}},
  "management": {"arrayValue":{"values":[
    {"mapValue":{"fields":{"id":{"stringValue":"leader"},       "label":{"stringValue":"Tävlingsledare"},"visibility":{"stringValue":"public"},  "name":{"stringValue":"Tävlingsledare"},"phone":{"stringValue":"070-000 00 01"},"email":{"stringValue":""}}}},
    {"mapValue":{"fields":{"id":{"stringValue":"registrations"},"label":{"stringValue":"Anmälningar"},   "visibility":{"stringValue":"public"},  "name":{"stringValue":"Anmälningar"},   "phone":{"stringValue":""},                "email":{"stringValue":"anmalan@example.se"}}}},
    {"mapValue":{"fields":{"id":{"stringValue":"secretariat"},  "label":{"stringValue":"Sekretariat"},   "visibility":{"stringValue":"internal"},"name":{"stringValue":"Sekretariat"},   "phone":{"stringValue":"070-000 00 02"},"email":{"stringValue":""}}}},
    {"mapValue":{"fields":{"id":{"stringValue":"banlaggare"},   "label":{"stringValue":"Banläggare"},    "visibility":{"stringValue":"internal"},"name":{"stringValue":"Erik Eriksson"}, "phone":{"stringValue":"070-000 00 03"},"email":{"stringValue":""}}}}
  ]}},
  "admins": {"arrayValue":{"values":[]}},
  "users":  {"arrayValue":{"values":[]}}
}'

# --- Controls: 10 points on a loop around Lindsdal (center 56.7380, 16.3280)
# Precomputed for a circle of radius ~330m (lat 0.003, lng 0.0055) starting
# from north, going clockwise, evenly spaced at 36°. Stable control IDs so
# re-seeding overwrites.
ctrl() {
  local id="$1" nummer="$2" name="$3" max="$4" min="$5" extra="$6" lat="$7" lng="$8" placement="$9" inst_text="${10}"
  write "competitions/$CID/controls/$id" "{
    \"nummer\":       {\"integerValue\":\"$nummer\"},
    \"name\":         {\"stringValue\":\"$name\"},
    \"maxPoang\":     {\"integerValue\":\"$max\"},
    \"minPoang\":     {\"integerValue\":\"$min\"},
    \"extraPoang\":   {\"integerValue\":\"$extra\"},
    \"lat\":          {\"doubleValue\":$lat},
    \"lng\":          {\"doubleValue\":$lng},
    \"placement\":    {\"stringValue\":\"$placement\"},
    \"instructions\": {\"arrayValue\":{\"values\":[
      {\"mapValue\":{\"fields\":{\"avdelningar\":{\"arrayValue\":{}},\"text\":{\"stringValue\":\"$inst_text\"}}}}
    ]}},
    \"notering\":     {\"stringValue\":\"\"},
    \"open\":         {\"booleanValue\":true}
  }"
}

ctrl demo-c01  1 "Spårkoll"           10 0 2 56.73875 16.27459 "Vid stigkorsningen norr om gläntan, på stora stenen." "Patrullen följer ett markerat spår 200 m och redogör för vad de såg. Spårkänsla och samarbete bedöms."
ctrl demo-c02  2 "Knop och surrning"  10 0 0 56.73996 16.27753 "I skogsbrynet strax nordöst, på trädet med röd markering."    "Pålstek, råbandsknop och kryss-surrning. Snabbhet och teknik."
ctrl demo-c03  3 "Första hjälpen"     15 0 3 56.74128 16.28258 "Öppen gräsplan öster om parkeringen."                          "Scenario: vrickad fotled och lättare blödning. Hur agerar patrullen?"
ctrl demo-c04  4 "Eld & matlagning"   10 0 2 56.74389 16.28039 "Anlagd eldstad nära bäcken, sydöstra hörnet."                   "Tänd eld utan tändvätska. Koka upp 0,5 l vatten. Säkerhet bedöms."
ctrl demo-c05  5 "Kartan"             15 0 0 56.74575 16.28114 "Under ekarna sydöst om fotbollsplanen."                          "Orientera på karta. Ange position + azimut till tre landmärken."
ctrl demo-c06  6 "Hinderbana"         10 0 0 56.74748 16.28354 "Stor öppen yta söder om vägen."                                  "Tidsbana med tre moment. Patrullen ska alltid vara samlad."
ctrl demo-c07  7 "Naturkännedom"      10 0 2 56.74842 16.27635 "Glänta med bord sydväst."                                        "Identifiera träd, svampar och spår på bordet. Muntliga frågor."
ctrl demo-c08  8 "Bygg en bro"        15 0 5 56.74534 16.27277 "Över diket väster om stigen."                                    "Enkel kavelbro som ska bära en person. Surrningar, stabilitet."
ctrl demo-c09  9 "Scoutlagen"         10 0 0 56.74308 16.27285 "Vid lägerelden nordväst."                                        "Öppen fråga: välj tre punkter ur scoutlagen. Berätta hur ni levt dem."
ctrl demo-c10 10 "Mörkermoment"       15 0 5 56.73960 16.27191 "Skogsstigen nordväst om parkeringen."                            "Genomförs efter mörker. Tyst förflyttning + signalering med lampa."

# --- Purge old patruller + scores so a re-seed doesn't leave stale docs ---
purge_subcol() {
  local subcol="$1"   # e.g. "patrols" or "controls/demo-c01/scores"
  local ids
  ids=$(curl -sS -H 'Authorization: Bearer owner' \
    "$HOST/v1/$DBPATH/competitions/$CID/$subcol" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(x["name"].split("/")[-1]) for x in d.get("documents",[])]')
  for id in $ids; do
    curl -sS -X POST "$HOST/v1/$DBPATH:commit" \
      -H 'Authorization: Bearer owner' -H 'Content-Type: application/json' \
      -d "{\"writes\":[{\"delete\":\"$DBPATH/competitions/$CID/$subcol/$id\"}]}" > /dev/null
  done
}
purge_subcol patrols
for n in 01 02 03 04 05 06 07 08 09 10; do purge_subcol "controls/demo-c$n/scores"; done

# --- Patrols (30 patruller across all six avdelningar + six kårer) ----------
patrol() {
  local id="$1" order="$2" number="$3" name="$4" avd="$5" kar="$6" antal="$7"
  write "competitions/$CID/patrols/$id" "{
    \"number\":     {\"integerValue\":\"$number\"},
    \"name\":       {\"stringValue\":\"$name\"},
    \"antal\":      {\"integerValue\":\"$antal\"},
    \"avdelning\":  {\"stringValue\":\"$avd\"},
    \"kar\":        {\"stringValue\":\"$kar\"},
    \"notering\":   {\"stringValue\":\"\"},
    \"startOrder\": {\"integerValue\":\"$order\"}
  }"
}

# Spårare (8–10 år)
patrol demo-p01  0  1 "Ekorrarna"       "Spårare"    "Lindsdals Scoutkår"   6
patrol demo-p02  1  2 "Mössen"          "Spårare"    "Oskarshamns Scoutkår" 5
patrol demo-p03  2  3 "Igelkottarna"    "Spårare"    "Nybro Scoutkår"       7
patrol demo-p04  3  4 "Rödhakarna"      "Spårare"    "Lindsdals Scoutkår"   5
patrol demo-p05  4  5 "Bävrarna"        "Spårare"    "Kalmar Scoutkår"      6

# Upptäckare (10–12 år)
patrol demo-p06  5  6 "Vargarna"        "Upptäckare" "Lindsdals Scoutkår"   7
patrol demo-p07  6  7 "Lodjuren"        "Upptäckare" "Oskarshamns Scoutkår" 6
patrol demo-p08  7  8 "Falken"          "Upptäckare" "Lindsdals Scoutkår"   6
patrol demo-p09  8  9 "Ugglorna"        "Upptäckare" "Nybro Scoutkår"       8
patrol demo-p10  9 10 "Räven"           "Upptäckare" "Mönsterås Scoutkår"   5

# Äventyrare (12–15 år)
patrol demo-p11 10 11 "Björnarna"       "Äventyrare" "Lindsdals Scoutkår"   8
patrol demo-p12 11 12 "Örnarna"         "Äventyrare" "Oskarshamns Scoutkår" 7
patrol demo-p13 12 13 "Vildsvinen"      "Äventyrare" "Lindsdals Scoutkår"   6
patrol demo-p14 13 14 "Hjortarna"       "Äventyrare" "Kalmar Scoutkår"      8
patrol demo-p15 14 15 "Älgarna"         "Äventyrare" "Vimmerby Scoutkår"    7

# Utmanare (15–18 år)
patrol demo-p16 15 16 "Nordstjärnan"    "Utmanare"   "Lindsdals Scoutkår"   4
patrol demo-p17 16 17 "Polstjärnan"     "Utmanare"   "Oskarshamns Scoutkår" 5
patrol demo-p18 17 18 "Karlavagnen"     "Utmanare"   "Lindsdals Scoutkår"   5
patrol demo-p19 18 19 "Vintergatan"     "Utmanare"   "Nybro Scoutkår"       4
patrol demo-p20 19 20 "Södra korset"    "Utmanare"   "Kalmar Scoutkår"      6

# Rover (19–25 år)
patrol demo-p21 20 21 "Kompassrosen"    "Rover"      "Lindsdals Scoutkår"   4
patrol demo-p22 21 22 "Lilla björn"     "Rover"      "Oskarshamns Scoutkår" 3
patrol demo-p23 22 23 "Stora björn"     "Rover"      "Lindsdals Scoutkår"   5
patrol demo-p24 23 24 "Cassiopeia"      "Rover"      "Mönsterås Scoutkår"   4
patrol demo-p25 24 25 "Orion"           "Rover"      "Vimmerby Scoutkår"    3

# Ledare (18+)
patrol demo-p26 25 26 "Ledarstaben"     "Ledare"     "Lindsdals Scoutkår"   4
patrol demo-p27 26 27 "Kårstaben"       "Ledare"     "Oskarshamns Scoutkår" 3
patrol demo-p28 27 28 "Funktionärerna"  "Ledare"     "Nybro Scoutkår"       5
patrol demo-p29 28 29 "Reserv"          "Ledare"     "Kalmar Scoutkår"      3
patrol demo-p30 29 30 "Veteranerna"     "Ledare"     "Lindsdals Scoutkår"   4

# --- Pre-scored results — many, varied, so the scoreboard feels alive -------
score() {
  local ctrl_id="$1" patrol_id="$2" poang="$3" extra="$4"
  write "competitions/$CID/controls/$ctrl_id/scores/$patrol_id" "{
    \"patrolId\":   {\"stringValue\":\"$patrol_id\"},
    \"poang\":      {\"integerValue\":\"$poang\"},
    \"extraPoang\": {\"integerValue\":\"$extra\"},
    \"note\":       {\"stringValue\":\"\"},
    \"reportedAt\": {\"timestampValue\":\"2026-05-01T10:30:00Z\"},
    \"reporter\":   {\"stringValue\":\"demo\"}
  }"
}

# Generate a varied score matrix via Python: top patrols rapportera fler
# kontroller, lägre ranking rapporterar färre. Determinstic via seed so the
# demo looks the same every re-seed.
#
# Patrol 11 and 12 are force-tied on total + extra + maxedCount so the demo
# shows "delad placering" in action (tiebreaker 3 exhausted → shared rank).
SCORE_MATRIX=$(python3 -c "
import random
random.seed(42)
# Max poäng per control — align with the ctrl() calls above
ctrl_max   = {1:10, 2:10, 3:15, 4:10, 5:15, 6:10, 7:10, 8:15, 9:10, 10:15}
ctrl_extra = {1:2,  2:0,  3:3,  4:2,  5:0,  6:0,  7:2,  8:5,  9:0,  10:5}

# Identical score pattern for the force-tied pair. Lands around rank ~10.
# Total: 7+10+9+8+9+8 = 51, extra 1, maxed = 1 (c2 hits max).
TIE_PAIR = {11, 12}
TIE_SCORES = [
    (1,  7, 1),
    (2, 10, 0),   # maxed (max 10)
    (3,  9, 0),
    (5,  8, 0),
    (7,  9, 0),
    (9,  8, 0),
]

# 30 patruller. First 10 are the high-performers, middle 10 mid, last 10 just started.
for i in range(1, 31):
    if i in TIE_PAIR:
        for c, poang, extra in TIE_SCORES:
            print(f'demo-c{c:02d} demo-p{i:02d} {poang} {extra}')
        continue
    if i <= 10:     n = random.randint(7, 9)
    elif i <= 20:   n = random.randint(4, 6)
    else:           n = random.randint(1, 3)
    controls = random.sample(range(1, 11), n)
    for c in controls:
        mx = ctrl_max[c]
        # top-10 tend to score higher; bottom tend lower
        floor = int(mx * (0.6 if i <= 10 else 0.4 if i <= 20 else 0.2))
        poang = random.randint(floor, mx)
        extra = random.randint(0, ctrl_extra[c]) if ctrl_extra[c] and random.random() < 0.4 else 0
        print(f'demo-c{c:02d} demo-p{i:02d} {poang} {extra}')
")

SCORE_COUNT=0
while IFS=' ' read -r c p poang extra; do
  [ -z "$c" ] && continue
  score "$c" "$p" "$poang" "$extra"
  SCORE_COUNT=$((SCORE_COUNT + 1))
done <<< "$SCORE_MATRIX"

echo "✅ Demospår seedat ($CID) · 10 kontroller · 30 patruller · $SCORE_COUNT poängrapporter"
