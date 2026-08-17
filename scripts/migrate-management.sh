#!/usr/bin/env bash
# Engångsflytt: tävlingsledningens INTERNA kontaktuppgifter bort från det
# världsläsbara tävlingsdokumentet.
#
# BAKGRUND: comp.management låg på competitions/{cid}, som har
# `allow read: if true`. Kryssrutan "intern" filtrerade bara i UI:t, så varje
# besökare på tävlingssidan fick sekretariatets och banläggarens namn och
# telefonnummer i svaret. Efter flytten ligger de i private/ledning
# (medlemsläsbar) med en härledd spegel per kontroll i faltinfo/{threadToken},
# som rapportsidan når via sin hemliga fältlänk.
#
# ORDNINGEN ÄR OMVÄND MOT INTUITIONEN — driftsätt FÖRST, migrera SEDAN:
#   1. npx firebase-tools deploy --only functions   (görs för hand, INTE av CI)
#   2. push → CI skickar hosting + rules
#   3. det här skriptet
# Ny klient mot omigrerad data fungerar (mergeManagement utan internPii ger
# rollerna orörda). Migrerad data mot GAMMAL klient gör det inte — den gamla
# internalManagement skulle tappa de interna rollerna helt.
#
# IDEMPOTENT: en tävling vars interna roller redan saknar uppgifter på det
# publika dokumentet skrivs inte om. Kör gärna två gånger och kontrollera att
# andra körningen rapporterar 0 ändrade.
#
# Bruk:
#   scripts/migrate-management.sh                 # torrkörning, ändrar inget
#   scripts/migrate-management.sh --skarpt        # skriver
#   PROJEKT=demo-eskil EMULATOR=1 scripts/migrate-management.sh --skarpt
set -euo pipefail

PROJEKT="${PROJEKT:-eskil-scout}"
SKARPT=0
[ "${1:-}" = "--skarpt" ] && SKARPT=1

if [ "${EMULATOR:-0}" = "1" ]; then
  BAS="http://127.0.0.1:8080/v1/projects/$PROJEKT/databases/(default)/documents"
  AUTH="Bearer owner"
else
  BAS="https://firestore.googleapis.com/v1/projects/$PROJEKT/databases/(default)/documents"
  # Admin-token förbi reglerna. Samma mönster som seed-skripten.
  AUTH="Bearer $(gcloud auth print-access-token)"
fi

echo "Projekt: $PROJEKT"
[ "$SKARPT" = "1" ] && echo "LÄGE: SKARPT — skriver." || echo "LÄGE: torrkörning — ändrar inget."
echo

# Hela migreringen görs i Python: den behöver dela upp arrayer, och det är inte
# något jq eller bash gör läsbart.
BAS="$BAS" AUTH="$AUTH" SKARPT="$SKARPT" python3 - <<'PY'
import json, os, urllib.request, urllib.parse, sys

BAS, AUTH, SKARPT = os.environ['BAS'], os.environ['AUTH'], os.environ['SKARPT'] == '1'
STRUKTUR = ('id', 'label', 'visibility', 'ekonomi')
PII = ('name', 'phone', 'email')

def anrop(sokvag, metod='GET', kropp=None):
    url = sokvag if sokvag.startswith('http') else BAS + sokvag
    data = json.dumps(kropp).encode() if kropp is not None else None
    r = urllib.request.Request(url, data=data, method=metod,
                               headers={'Authorization': AUTH, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r) as sv:
            return json.loads(sv.read() or b'{}')
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        raise SystemExit(f'FEL {e.code} på {metod} {url}: {e.read()[:300].decode(errors="replace")}')

def ut(v):
    if v is None: return {'nullValue': None}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [ut(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: ut(x) for k, x in v.items()}}}
    return {'stringValue': str(v)}

def inn(v):
    if not isinstance(v, dict): return v
    for k in ('stringValue', 'booleanValue', 'timestampValue', 'doubleValue'):
        if k in v: return v[k]
    if 'integerValue' in v: return int(v['integerValue'])
    if 'nullValue' in v: return None
    if 'arrayValue' in v: return [inn(x) for x in v['arrayValue'].get('values', [])]
    if 'mapValue' in v: return {k: inn(x) for k, x in v['mapValue'].get('fields', {}).items()}
    return v

def dela(roller):
    publikt, intern = [], {}
    for r in roller:
        bas = {k: (r.get(k) is True if k == 'ekonomi' else (r.get(k) or '')) for k in STRUKTUR}
        bas['visibility'] = 'internal' if r.get('visibility') == 'internal' else 'public'
        if bas['visibility'] == 'internal':
            pii = {k: (r.get(k) or '').strip() for k in PII}
            if any(pii.values()) and bas['id']:
                intern[bas['id']] = pii
        else:
            for k in PII: bas[k] = r.get(k) or ''
        publikt.append(bas)
    return publikt, intern

tavlingar = anrop('/competitions?pageSize=300') or {}
docs = tavlingar.get('documents', [])
print(f'{len(docs)} tävlingar\n')
andrade = orord = 0

for d in docs:
    cid = d['name'].split('/')[-1]
    roller = inn(d.get('fields', {}).get('management')) or []
    if not isinstance(roller, list) or not roller:
        print(f'  {cid:26} ingen management — hoppar'); orord += 1; continue

    publikt, intern = dela(roller)
    if not intern:
        print(f'  {cid:26} inga interna uppgifter kvar — redan migrerad'); orord += 1; continue

    namn = ', '.join(sorted(intern))
    print(f'  {cid:26} flyttar {len(intern)} intern(a) roll(er): {namn}')
    andrade += 1
    if not SKARPT: continue

    # 1. publika halvan tillbaka på tävlingsdokumentet
    anrop(f'/competitions/{cid}?updateMask.fieldPaths=management', 'PATCH',
          {'fields': {'management': ut(publikt)}})
    # 2. mastern
    anrop(f'/competitions/{cid}/private/ledning', 'PATCH', {'fields': {'internPii': ut(intern)}})
    # 3. speglar för varje kontroll som HAR en token. Kontroller utan token har
    #    ingen fältlänk att skydda, och får sin spegel när någon öppnar
    #    kontrollistan (ensureThreadToken myntar båda i samma batch).
    ctrls = anrop(f'/competitions/{cid}/controls?pageSize=300') or {}
    speglar = 0
    for c in ctrls.get('documents', []):
        ctrl_id = c['name'].split('/')[-1]
        meta = anrop(f'/competitions/{cid}/controls/{urllib.parse.quote(ctrl_id)}/private/meta')
        tok = inn((meta or {}).get('fields', {}).get('threadToken'))
        if not tok: continue
        anrop(f'/competitions/{cid}/faltinfo/{urllib.parse.quote(tok)}', 'PATCH',
              {'fields': {'internPii': ut(intern), 'uppdaterad': ut('migrering')}})
        speglar += 1
    print(f'  {"":26} → {speglar} spegel/speglar skrivna')

print(f'\n{andrade} ändrade, {orord} orörda.')
if not SKARPT and andrade:
    print('Torrkörning. Kör om med --skarpt för att skriva.')
PY
