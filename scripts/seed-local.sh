#!/usr/bin/env bash
# Seed demo data into the local Firestore emulator.
# Expects `firebase emulators:start --project demo-eskil` to be running.
# Safe to re-run — the commit endpoint upserts each document.

set -e
HOST="${FIRESTORE_HOST:-http://127.0.0.1:8080}"
PROJECT="${FIREBASE_PROJECT:-demo-eskil}"
CID="alg2026"
DBPATH="projects/$PROJECT/databases/(default)/documents"

echo "Waiting for Firestore emulator at $HOST…"
for i in {1..30}; do
  if curl -sS -o /dev/null -w '%{http_code}' "$HOST/" | grep -q 200; then break; fi
  sleep 1
done

# Always seed the Demospår (the production-safe demo competition).
"$(dirname "$0")/seed-demo.sh"

# Admin access: the Firestore emulator accepts `Authorization: Bearer owner`
# as a rules-bypassing credential for seeding/admin scripts.
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

# --- Competition ---
write "competitions/$CID" '{
  "name":        {"stringValue":"Älghornsjakten 2026"},
  "shortName":   {"stringValue":"Älghornsjakten"},
  "year":        {"integerValue":"2026"},
  "date":        {"stringValue":"2026-10-04"},
  "location":    {"stringValue":"Tinnerö eklandskap, Kalmar"},
  "organizer":   {"stringValue":"Lindsdals Scoutkår"},
  "description": {"stringValue":"Demo-tävling seedad för lokal emulator. 10 kontroller, patruller från flera avdelningar."},
  "generalInfo": {"stringValue":"Akut olycka: ring 112 först, sedan sekretariatet.\nKontrollant som lämnar sin kontroll — meddela sekretariatet innan."},
  "anonymousControls": {"booleanValue": true},
  "startTimes": {"mapValue":{"fields":{
    "enabled":         {"booleanValue": true},
    "firstStart":      {"stringValue": "09:00"},
    "intervalMinutes": {"integerValue": "5"}
  }}},
  "management": {"arrayValue":{"values":[
    {"mapValue":{"fields":{"id":{"stringValue":"leader"},       "label":{"stringValue":"Tävlingsledare"},"visibility":{"stringValue":"public"},  "name":{"stringValue":"Anna Andersson"},       "phone":{"stringValue":"070-000 00 01"},"email":{"stringValue":"tavlingsledare@example.com"}}}},
    {"mapValue":{"fields":{"id":{"stringValue":"registrations"},"label":{"stringValue":"Anmälningar"},   "visibility":{"stringValue":"public"},  "name":{"stringValue":"Anmälningar Lindsdal"}, "phone":{"stringValue":""},             "email":{"stringValue":"anmalan@example.com"}}}},
    {"mapValue":{"fields":{"id":{"stringValue":"secretariat"},  "label":{"stringValue":"Sekretariatet"}, "visibility":{"stringValue":"internal"},"name":{"stringValue":"Sekretariatet"},        "phone":{"stringValue":"070-000 00 02"},"email":{"stringValue":""}}}}
  ]}},
  "admins":      {"arrayValue":{"values":[]}},
  "users":       {"arrayValue":{"values":[]}}
}'

# --- Purge existing patrols so re-seeds don't accumulate stale short-IDs ---
purge_patrols() {
  local ids
  ids=$(curl -sS -H 'Authorization: Bearer owner' \
    "$HOST/v1/$DBPATH/competitions/$CID/patrols" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin); [print(x["name"].split("/")[-1]) for x in d.get("documents",[])]')
  for id in $ids; do
    curl -sS -X POST "$HOST/v1/$DBPATH:commit" \
      -H 'Authorization: Bearer owner' -H 'Content-Type: application/json' \
      -d "{\"writes\":[{\"delete\":\"$DBPATH/competitions/$CID/patrols/$id\"}]}" > /dev/null
  done
}
purge_patrols

# --- Patrols — IDs are GUIDs so startcard URLs are unguessable ---
PATROL_IDX=0
patrol() {
  local id; id=$(uuidgen | tr 'A-Z' 'a-z')
  local number="$1" name="$2" avd="$3" kar="$4" antal="$5"
  write "competitions/$CID/patrols/$id" "{
    \"number\":     {\"integerValue\":\"$number\"},
    \"name\":       {\"stringValue\":\"$name\"},
    \"antal\":      {\"integerValue\":\"$antal\"},
    \"avdelning\":  {\"stringValue\":\"$avd\"},
    \"kar\":        {\"stringValue\":\"$kar\"},
    \"notering\":   {\"stringValue\":\"\"},
    \"startOrder\": {\"integerValue\":\"$PATROL_IDX\"}
  }"
  PATROL_IDX=$((PATROL_IDX + 1))
}

patrol 1 "Björnarna"    "Spårare"    "Lindsdals Scoutkår"     6
patrol 2 "Rävarna"      "Spårare"    "Oskarshamns Scoutkår"   5
patrol 3 "Vargarna"     "Upptäckare" "Lindsdals Scoutkår"     7
patrol 4 "Falkarna"     "Upptäckare" "Nybro Scoutkår"         6
patrol 5 "Ugglorna"     "Äventyrare" "Lindsdals Scoutkår"     6
patrol 6 "Hjortarna"    "Äventyrare" "Oskarshamns Scoutkår"   8
patrol 7 "Lodjuren"     "Utmanare"   "Lindsdals Scoutkår"     4

# --- Purge any previous controls so stale IDs (short or old GUIDs) don't linger ---
purge_controls() {
  local ids
  ids=$(curl -sS -H 'Authorization: Bearer owner' \
    "$HOST/v1/$DBPATH/competitions/$CID/controls" \
    | python3 -c 'import json,sys;d=json.load(sys.stdin); [print(x["name"].split("/")[-1]) for x in d.get("documents",[])]')
  for id in $ids; do
    curl -sS -X POST "$HOST/v1/$DBPATH:commit" \
      -H 'Authorization: Bearer owner' -H 'Content-Type: application/json' \
      -d "{\"writes\":[{\"delete\":\"$DBPATH/competitions/$CID/controls/$id\"}]}" > /dev/null
  done
}
purge_controls

# --- Controls (10) — IDs are random GUIDs so the reporting URL is unguessable
# Each call takes: nummer, name, max, min, extra, lat, lng, placement, inst_json
#   inst_json = JSON array of { "avdelningar": [...], "text": "..." }
ctrl() {
  local id; id=$(uuidgen | tr 'A-Z' 'a-z')
  local nummer="$1" name="$2" max="$3" min="$4" extra="$5" lat="$6" lng="$7" placement="$8" inst_json="$9"
  # Build Firestore-typed instructions array
  local inst_fs
  inst_fs=$(python3 -c "
import json, sys
arr = json.loads('''$inst_json''')
vals = []
for g in arr:
    avd = [{'stringValue': a} for a in g.get('avdelningar', [])]
    vals.append({
      'mapValue': {'fields': {
        'avdelningar': {'arrayValue': {'values': avd}},
        'text': {'stringValue': g.get('text','')}
      }}
    })
print(json.dumps({'arrayValue': {'values': vals}}))
")
  write "competitions/$CID/controls/$id" "{
    \"nummer\":       {\"integerValue\":\"$nummer\"},
    \"name\":         {\"stringValue\":\"$name\"},
    \"maxPoang\":     {\"integerValue\":\"$max\"},
    \"minPoang\":     {\"integerValue\":\"$min\"},
    \"extraPoang\":   {\"integerValue\":\"$extra\"},
    \"lat\":          {\"doubleValue\":$lat},
    \"lng\":          {\"doubleValue\":$lng},
    \"placement\":    {\"stringValue\":\"$placement\"},
    \"instructions\": $inst_fs,
    \"notering\":     {\"stringValue\":\"\"},
    \"open\":         {\"booleanValue\":true}
  }"
}

ctrl 1 "Spårkoll" 10 0 2 58.3850 15.6305 \
  "Vid första gaffelvägen efter start-TP. Stolpen står 2 m in på vänster stig." \
  '[
    {"avdelningar":["Spårare","Upptäckare"],"text":"Spåret är markerat med röda band. Följ det 150 m till slutstolpen. Vi bedömer att ni håller spåret, talar lågt och hjälps åt. Max 10 min."},
    {"avdelningar":[],"text":"Spåret är 300 m och markerat med små reflexer. Följ det, räkna antalet markeringar ni ser och redovisa vid slutstolpen. Spårkänsla och tempo bedöms."}
  ]'

ctrl 2 "Knop och surrning" 10 0 0 58.3872 15.6330 \
  "På öppen gräsplan 40 m öster om stora eken. En kontrollant med repbag finns på plats." \
  '[
    {"avdelningar":["Spårare"],"text":"Visa råbandsknop och dubbelt halvslag. 2 p per korrekt knop, 2 p för ordning, 4 p för samarbete."},
    {"avdelningar":["Upptäckare"],"text":"Utför pålstek och råbandsknop. Dessutom en enkel bänk-surrning på två käppar."},
    {"avdelningar":["Äventyrare","Utmanare"],"text":"Pålstek, timmerstek, råbandsknop. Dessutom kryss-surrning som ska hålla vikten av en person."}
  ]'

ctrl 3 "Första hjälpen" 15 0 3 58.3894 15.6355 \
  "Under tallarna nära stigkorsningen. Markör: orangeblå reflexväst i trädet." \
  '[
    {"avdelningar":["Spårare","Upptäckare"],"text":"Scenario: kompis har skrapsår på knäet. Visa hur ni tröstar, rengör och täcker såret. Säkerhet före allt."},
    {"avdelningar":[],"text":"Scenario: vrickad fotled + lätt blödande hand. Patrullen triagerar, förbinder och planerar transport. Kontrollant ställer följdfrågor om kontaktväg (112)."}
  ]'

ctrl 4 "Eld & matlagning" 10 0 2 58.3915 15.6380 \
  "Anlagd eldstad i sänkan bakom klippan. Ved finns redan på plats — vatten tas från dunk." \
  '[
    {"avdelningar":[],"text":"Tänd eld med tändstickor + tändmaterial. Koka upp 0,5 l vatten. Säkerhet, val av ved och teknik bedöms. Max 15 min."}
  ]'

ctrl 5 "Kartan" 15 0 0 58.3931 15.6402 \
  "Stor sten vid gläntan. Kartan ligger i plastficka under stenen." \
  '[
    {"avdelningar":["Spårare"],"text":"Peka ut tre kända platser på kartan. Prata om vad symbolerna betyder."},
    {"avdelningar":["Upptäckare","Äventyrare"],"text":"Ange position, avstånd (ungefärligt) och azimut till tre utmärkta landmärken."},
    {"avdelningar":["Utmanare","Rover"],"text":"Teoriprov: välj tre kompasskurser mellan utsatta punkter. Räkna även höjdskillnad från höjdkurvor."}
  ]'

ctrl 6 "Hinderbana" 10 0 0 58.3948 15.6425 \
  "Öppen äng söder om stigen. Hela banan syns från kontrollanten." \
  '[
    {"avdelningar":[],"text":"Tidsbana med tre moment. Patrullen ska alltid vara samlad vid samma moment. Tid × samarbete bedöms."}
  ]'

ctrl 7 "Naturkännedom" 10 0 2 58.3966 15.6450 \
  "Liten glänta 25 m norr om bäcken. Bordet är dukat med fynd." \
  '[
    {"avdelningar":["Spårare","Upptäckare"],"text":"Namnge fem av trädens löv. Vad är skillnaden mellan gran och tall?"},
    {"avdelningar":[],"text":"Identifiera minst 8 av 12 natur-objekt på bordet: träd, svamp, spår, örter. Muntligt resonemang om bedömning."}
  ]'

ctrl 8 "Bygg en bro" 15 0 5 58.3985 15.6476 \
  "Tvärs över diket söder om stora stigen. Käppar och rep finns redan utlagda." \
  '[
    {"avdelningar":["Äventyrare","Utmanare","Rover"],"text":"Bygg en enkel kavelbro som ska bära en person över diket. Surrningar, stabilitet, samarbete bedöms. Max 20 min."},
    {"avdelningar":["Spårare","Upptäckare"],"text":"Bygg en mini-bro av käppar och snöre som ska bära en halvlitersflaska. Samarbete är viktigast."}
  ]'

ctrl 9 "Scoutlagen" 10 0 0 58.4002 15.6499 \
  "Vid lägereldsplatsen. Stock-bänk att sitta på." \
  '[
    {"avdelningar":[],"text":"Öppen fråga: välj tre punkter ur scoutlagen och berätta hur ni levt dem på tävlingen hittills. Kontrollanten lyssnar och ställer följdfrågor."}
  ]'

ctrl 10 "Mörkermoment" 15 0 5 58.4018 15.6520 \
  "Skogsstigen nordost om parkeringen. Kontrollanten bär röd pannlampa." \
  '[
    {"avdelningar":["Utmanare","Rover"],"text":"Genomförs efter solnedgång. Tyst förflyttning 100 m + signalering till kontrollant med lampa (morse eller enkla blink)."},
    {"avdelningar":["Äventyrare"],"text":"Tyst förflyttning 60 m utan att bli hörd. Lampa används endast när kontrollanten ger signal."},
    {"avdelningar":[],"text":"Moment saknas — denna kontroll är inte planerad för yngre avdelningar."}
  ]'

# --- Make the super-admin an admin on this competition so
# ---  it shows up immediately for them after sign-in. We look up the uid from
# ---  the Auth emulator; if no user with that email has signed in yet, the
# ---  admins list stays empty (super-admin role still sees everything).
find_uid() {
  local email="$1"
  curl -sS -X POST \
    'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:lookup?key=fake' \
    -H 'Authorization: Bearer owner' -H 'Content-Type: application/json' \
    -d "{\"email\":[\"$email\"]}" 2>/dev/null \
    | python3 -c "
import json, sys
try:
    data = json.load(sys.stdin)
    users = data.get('users', [])
    if users:
        print(users[0].get('localId', ''))
except Exception:
    pass
"
}

SUPER_ADMIN_EMAIL="${SUPER_ADMIN_EMAIL:-johan@leitet.se}"
SUPERUID=$(find_uid "$SUPER_ADMIN_EMAIL")
if [ -n "$SUPERUID" ]; then
  write "competitions/$CID" '{
    "name":        {"stringValue":"Älghornsjakten 2026"},
    "shortName":   {"stringValue":"Älghornsjakten"},
    "year":        {"integerValue":"2026"},
    "date":        {"stringValue":"2026-10-04"},
    "location":    {"stringValue":"Tinnerö eklandskap, Kalmar"},
    "organizer":   {"stringValue":"Lindsdals Scoutkår"},
    "description": {"stringValue":"Demo-tävling seedad för lokal emulator. 10 kontroller, patruller från flera avdelningar."},
    "generalInfo": {"stringValue":"Akut olycka: ring 112 först, sedan sekretariatet.\nKontrollant som lämnar sin kontroll — meddela sekretariatet innan."},
    "anonymousControls": {"booleanValue": true},
  "startTimes": {"mapValue":{"fields":{
    "enabled":         {"booleanValue": true},
    "firstStart":      {"stringValue": "09:00"},
    "intervalMinutes": {"integerValue": "5"}
  }}},
    "management": {"mapValue":{"fields":{
      "leader":       {"mapValue":{"fields":{"name":{"stringValue":"Anna Andersson"},"phone":{"stringValue":"070-000 00 01"},"email":{"stringValue":"tavlingsledare@example.com"}}}},
      "registrations":{"mapValue":{"fields":{"name":{"stringValue":"Anmälningar Lindsdal"},"phone":{"stringValue":""},"email":{"stringValue":"anmalan@example.com"}}}},
      "secretariat":  {"mapValue":{"fields":{"name":{"stringValue":"Sekretariatet"},"phone":{"stringValue":"070-000 00 02"},"email":{"stringValue":""}}}}
    }}},
    "admins":      {"arrayValue":{"values":[{"stringValue":"'"$SUPERUID"'"}]}},
    "users":       {"arrayValue":{"values":[]}}
  }'
  echo "   $SUPER_ADMIN_EMAIL (uid=$SUPERUID) tillagd som admin."
fi

FIRST_CTRL=$(curl -sS -H 'Authorization: Bearer owner' \
  "$HOST/v1/$DBPATH/competitions/$CID/controls" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("documents",[{}])[0].get("name","").split("/")[-1])' 2>/dev/null)
FIRST_PATROL=$(curl -sS -H 'Authorization: Bearer owner' \
  "$HOST/v1/$DBPATH/competitions/$CID/patrols" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("documents",[{}])[0].get("name","").split("/")[-1])' 2>/dev/null)

echo ""
echo "✅ Seedat: Älghornsjakten 2026 — 7 patruller, 10 kontroller."
echo "   App:           http://localhost:5050"
echo "   Adminvy:       http://localhost:5050/app/c/$CID"
echo "   Offentlig sida: http://localhost:5050/t/$CID"
[ -n "$FIRST_CTRL" ]   && echo "   Kontroll #1:    http://localhost:5050/k/$CID/$FIRST_CTRL"
[ -n "$FIRST_PATROL" ] && echo "   Startkort #1:   http://localhost:5050/s/$CID/$FIRST_PATROL"
