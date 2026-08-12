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
# Anchor firstStart 150 minutes before NOW: patrols 1–15 have officially
# started, 16–30 are upcoming, and the scores/passages below paint a
# mid-race snapshot around the seed moment. The Läget view pins its demo
# clock to the newest timestamp in the data (+5 min = the seed moment), so
# the snapshot never ages — re-seeding only refreshes the clock times shown.
FIRST_START=$(python3 -c '
from datetime import datetime, timedelta
t = datetime.now() - timedelta(minutes=150)
t = t.replace(minute=(t.minute // 5) * 5, second=0, microsecond=0)
print(t.strftime("%H:%M"))
')
echo "  firstStart: $FIRST_START (anchored 150 min before now, 10-min interval × 30 patruller)"

write() {
  local doc_path="$1"; local fields_json="$2"
  local payload
  payload=$(cat <<JSON
{"writes":[{"update":{"name":"$DBPATH/$doc_path","fields":$fields_json}}]}
JSON
)
  local resp status
  resp=$(curl -sS -w "\n__HTTP__:%{http_code}" -X POST "$HOST/v1/$DBPATH:commit" \
    -H "Authorization: ${AUTH:-Bearer owner}" -H 'Content-Type: application/json' \
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
  "description": {"stringValue":"Ett demospår att utforska ESKIL. Tio kontroller i en slinga genom Lindsdal."},
  "generalInfo": {"stringValue":"Detta är ett demospår. Poängrapportering är avstängd."},
  "demo":              {"booleanValue": true},
  "anonymousControls": {"booleanValue": true},
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
    "lng":     {"doubleValue": 16.27976},
    "note":    {"stringValue": "Tänk på att det kommer att vara många bilar på plats och ont om parkeringar så försök trycka ihop er."}
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
  ids=$(curl -sS -H "Authorization: ${AUTH:-Bearer owner}" \
    "$HOST/v1/$DBPATH/competitions/$CID/$subcol" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(x["name"].split("/")[-1]) for x in d.get("documents",[])]')
  for id in $ids; do
    curl -sS -X POST "$HOST/v1/$DBPATH:commit" \
      -H "Authorization: ${AUTH:-Bearer owner}" -H 'Content-Type: application/json' \
      -d "{\"writes\":[{\"delete\":\"$DBPATH/competitions/$CID/$subcol/$id\"}]}" > /dev/null
  done
}
purge_subcol patrols
for n in 01 02 03 04 05 06 07 08 09 10; do purge_subcol "controls/demo-c$n/scores"; done
purge_subcol "stations/demo-station/passages"

# --- Start/Mål-station (stable id so the Läget card + /m link survive re-seeds)
write "competitions/$CID/stations/demo-station" '{
  "createdAt": {"timestampValue":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}
}'

# --- Drawn track (Spår editor doc) -------------------------------------------
# One or two waypoints per leg, bulging gently outward from the loop so the
# course looks hand-drawn on every map (public page, startkort, Läget) and
# the Spår tab opens with a complete example.
TRACK_LEGS=$(python3 -c "
import json, math
S = ('__start', 56.73661, 16.27872)
C = [  # id, lat, lng — keep aligned with the ctrl() calls above
  ('demo-c01', 56.73875, 16.27459), ('demo-c02', 56.73996, 16.27753),
  ('demo-c03', 56.74128, 16.28258), ('demo-c04', 56.74389, 16.28039),
  ('demo-c05', 56.74575, 16.28114), ('demo-c06', 56.74748, 16.28354),
  ('demo-c07', 56.74842, 16.27635), ('demo-c08', 56.74534, 16.27277),
  ('demo-c09', 56.74308, 16.27285), ('demo-c10', 56.73960, 16.27191),
]
nodes = [S] + C + [('__mal', S[1], S[2])]
cx = sum(n[1] for n in nodes) / len(nodes)
cy = sum(n[2] for n in nodes) / len(nodes)
legs = {}
for a, b in zip(nodes, nodes[1:]):
    mlat, mlng = (a[1] + b[1]) / 2, (a[2] + b[2]) / 2
    # push the midpoint slightly away from the loop centre (lng scaled for lat)
    dlat, dlng = mlat - cx, (mlng - cy) * 0.55
    n = math.hypot(dlat, dlng) or 1
    legs[f'{a[0]}__{b[0]}'] = [{'lat': round(mlat + dlat / n * 0.0006, 6),
                                'lng': round(mlng + dlng / n * 0.0011, 6)}]
print(json.dumps({k: {'arrayValue': {'values': [
    {'mapValue': {'fields': {'lat': {'doubleValue': p['lat']},
                             'lng': {'doubleValue': p['lng']}}}} for p in v
]}} for k, v in legs.items()}))
")
write "competitions/$CID/track/main" '{
  "speedKmh": {"integerValue": "4"},
  "legs": {"mapValue": {"fields": '"$TRACK_LEGS"'}},
  "updatedAt": {"timestampValue":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}
}'

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

# --- Mid-race snapshot: scores + station passages ----------------------------
# One coherent race story anchored at the seed moment (minutes-ago offsets):
# patrols report controls in course order (prefix 1..k) with plausible leg
# times, so the Läget dashboard tells a story instead of noise:
#   · p01/p02 finished (I mål)
#   · p05–p08 stuck at position 5 → kö 4 mot kontroll 6 "Hinderbana" = RÖD
#   · p11/p13 heading to kontroll 3 → kö 2 = GUL (and c1: p09+p14 → GUL)
#   · leg times into kontroll 2 rising (12→22 min) → trendpil ↑
#   · p09 checked out but never reported → varning "Tyst i 70 min"
#   · p15–p30 not started yet
# The newest timestamp is -5 min; Läget's demo clock = newest + 5 min = the
# seed moment, so these relative numbers hold forever.
score() {
  local ctrl_id="$1" patrol_id="$2" poang="$3" extra="$4" ts="$5"
  write "competitions/$CID/controls/$ctrl_id/scores/$patrol_id" "{
    \"patrolId\":   {\"stringValue\":\"$patrol_id\"},
    \"poang\":      {\"integerValue\":\"$poang\"},
    \"extraPoang\": {\"integerValue\":\"$extra\"},
    \"note\":       {\"stringValue\":\"\"},
    \"reportedAt\": {\"timestampValue\":\"$ts\"},
    \"reporter\":   {\"stringValue\":\"demo\"}
  }"
}

# Lines: "score <ctrl> <patrol> <poang> <extra> <iso>" and
#        "passage <patrol> <startIso> [finishIso]"
# Points are deterministic (seed 42). p05/p06 are force-tied on total +
# extra + maxedCount so the demo shows "delad placering" (they queue side
# by side at Hinderbanan too).
RACE_MATRIX=$(python3 -c "
import random
from datetime import datetime, timezone, timedelta
random.seed(42)
now = datetime.now(timezone.utc)
iso = lambda m: (now - timedelta(minutes=m)).strftime('%Y-%m-%dT%H:%M:%SZ')

ctrl_max   = {1:10, 2:10, 3:15, 4:10, 5:15, 6:10, 7:10, 8:15, 9:10, 10:15}
ctrl_extra = {1:2,  2:0,  3:3,  4:2,  5:0,  6:0,  7:2,  8:5,  9:0,  10:5}

# patrol -> (checkout_min_ago, finish_min_ago | None, {ctrl: report_min_ago})
story = {
  1:  (150, 15, {1:138, 2:125, 3:112, 4:99, 5:87, 6:74, 7:61, 8:48, 9:34, 10:21}),
  2:  (140, 5,  {1:128, 2:116, 3:104, 4:91, 5:79, 6:66, 7:53, 8:40, 9:17, 10:10}),
  3:  (130, None, {1:118, 2:106, 3:93, 4:81, 5:68, 6:55, 7:35, 8:20}),
  4:  (120, None, {1:108, 2:96, 3:83, 4:70, 5:55, 6:30}),
  5:  (110, None, {1:98, 2:85, 3:72, 4:58, 5:35}),
  6:  (100, None, {1:88, 2:75, 3:62, 4:48, 5:28}),
  7:  (90,  None, {1:78, 2:59, 3:45, 4:34, 5:24}),
  8:  (80,  None, {1:70, 2:48, 3:38, 4:29, 5:21}),
  9:  (70,  None, {}),                      # checked out, then silence → varning
  10: (60,  None, {1:48, 2:28, 3:14}),
  11: (50,  None, {1:40, 2:21}),
  12: (40,  None, {1:28}),
  13: (30,  None, {1:17, 2:5}),
  14: (20,  None, {}),                      # fresh checkout, walking to c1
}

# Identical scores for the tied pair (delad placering): total 48, extra 1,
# maxed 1 (c2 hits its max 10).
TIE_PAIR = {5, 6}
TIE_POINTS = {1: (8, 1), 2: (10, 0), 3: (12, 0), 4: (7, 0), 5: (11, 0)}

for i, (out_ago, fin_ago, reports) in story.items():
    pid = f'demo-p{i:02d}'
    passage = f'passage {pid} {iso(out_ago)}'
    if fin_ago is not None:
        passage += f' {iso(fin_ago)}'
    print(passage)
    for c, ago in sorted(reports.items()):
        if i in TIE_PAIR:
            poang, extra = TIE_POINTS[c]
        else:
            mx = ctrl_max[c]
            floor = int(mx * (0.6 if i <= 4 else 0.45))
            poang = random.randint(floor, mx)
            extra = random.randint(0, ctrl_extra[c]) if ctrl_extra[c] and random.random() < 0.4 else 0
        print(f'score demo-c{c:02d} {pid} {poang} {extra} {iso(ago)}')
")

SCORE_COUNT=0
PASS_COUNT=0
while read -r kind a b c d e; do
  case "$kind" in
    score)
      score "$a" "$b" "$c" "$d" "$e"
      SCORE_COUNT=$((SCORE_COUNT + 1))
      ;;
    passage)
      FIELDS="\"patrolId\":{\"stringValue\":\"$a\"},\"startAt\":{\"timestampValue\":\"$b\"}"
      [ -n "$c" ] && FIELDS="$FIELDS,\"finishAt\":{\"timestampValue\":\"$c\"}"
      write "competitions/$CID/stations/demo-station/passages/$a" "{$FIELDS}"
      PASS_COUNT=$((PASS_COUNT + 1))
      ;;
  esac
done <<< "$RACE_MATRIX"

echo "✅ Demospår seedat ($CID) · 10 kontroller · 30 patruller · $SCORE_COUNT poängrapporter · $PASS_COUNT passager"
