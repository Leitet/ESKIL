# ESKIL — Scouttävlingssystem

Digitalt stödsystem för scouttävlingar (Älghornsjakten, DM, ...) i sydöstra Sverige.
Byggt som en statisk SPA på Firebase (Hosting + Firestore + Auth) så att det går
att köra gratis på Spark-planen.

## Funktioner

- **Flera tävlingar** med egna administratörer — en tävlingsadministratör för
  Älghornsjakten 2026 kan bjuda in tävlingsadministratören för Älghornsjakten 2027.
- **Patruller** — nummer, namn, antal, avdelning (Spårare, Upptäckare,
  Äventyrare, Utmanare, Rover, Ledare), kår, notering.
- **Kontroller** — nummer, namn, max/min/extra poäng, position (lat/lng),
  information, notering, öppen/stängd.
- **Poängtabell** — sortering Overall, per avdelning, per kår.
- **Kontrollens rapportsida** (`/k/<cid>/<ctrlId>`) — ingen inloggning, hemlig
  URL, mobiloptimerad, **nattläge**.
- **PDF + QR-kod** — varje kontroll kan skrivas ut med info och en skanbar QR
  som öppnar rapportsidan.
- **Magic-link-inloggning** med långa sessioner (Firebase Auth `browserLocalPersistence`).
- **Publik startsida** (`/`) — promotar ESKIL och listar tävlingar öppna för
  anmälan, pågående/kommande, demospåret och avslutade tävlingar med resultat,
  plus inloggning.
- **Anmälan** (`/a/<cid>`) — publik anmälningssida (kårvis eller patrullvis) med
  fyra prismodeller, betalningssteg (Swish-QR med låst belopp/referens, bankgiro,
  faktura), egna fritextfält (per anmälan eller per patrull, t.ex. "Allergier"),
  hemlig ändringslänk via e-post, mellanskillnadsbetalning vid utökning,
  avanmälan under perioden och förhinderanmälan efteråt. Adminflik med
  betalningsavprickning per referens och import till patrullistan. När en
  betalning prickas av mailas anmälningsansvarig automatiskt (länken går till
  anmälningssidan där kvittot laddas ner som PDF, genererat i klienten), och
  när anmälan är fullbetald importeras dess patruller automatiskt till
  patrullistan (dubbletter hoppas över).
- **Avdelningar per tävling** — under Inställningar → Grund väljs vilka
  avdelningar som deltar; endast valda visas i anmälan, patrullformulär och
  poängtabellens filter (`competitions/{cid}.avdelningar`, saknas = alla).
- **Läget** (flik på tävlingen) — sekretariatets tävlingsdagsvy. Live-KPI:er
  (ej startade / ute i skogen / i mål / varningar), karta och tabell med
  **kötryck per kontroll**: kö nu (patruller på väg från föregående kontroll),
  median-mellantid med trendpil när tiderna stiger, och heat-färg
  (grönt/gult/rött — kö ≥ 4 eller kö + 45 min utan rapport = flaskhals).
  Patruller som varit tysta ≥ 60 min flaggas. Kön beräknas ur
  rapporteringsordningen (antagande: patrullerna går bana i nummerordning
  start → 1 → 2 → …).
- **Start/Mål-station** (`/m/<cid>/<stationId>`) — hemlig länk/QR (skapas från
  Läget) för funktionärerna vid start och mål: checka ut patruller vid start
  och in vid målgång med ett tryck, ångra med bekräftelse. Ingen inloggning.
  In-/utcheckningarna ger Läget dess start-/måldata.
- **Spårdragning** (flik "Spår") — rita spåret mellan kontrollerna på en stor
  karta (växla karta/satellit, fullskärmsläge). Bensekvensen härleds ur
  kontrollernas nummerordning (start → 1 → 2 → … → mål när start/mål är
  konfigurerat); klick i kartan lägger punkter på det aktiva benet, punkterna
  dras för att justera och tas bort med dubbelklick. Panelen visar längd och
  gångtid per ben samt total spårlängd och beräknad vandringstid med valbart
  promenadtempo (3/4/5 km/h), exklusive och inklusive kontrolltid
  (5 min/kontroll). Ben utan ritade punkter räknas som fågelväg (streckad).
  Finns ett ritat spår används det alltid på alla kartor: offentliga sidan,
  startkortets översiktskarta (med chip "Spår X km · ca Y min gång") och
  Läget-kartan (dämpad bakgrundslinje). Delade hjälpare i `js/course.js`.
- **Tävlingsområde** — per-tävlingsinställning (Inställningar → Regler & info:
  "Visa kontrollplatser på publika sidan"). Avbockad visar publika kartan ett
  skuggat konvext "Tävlingsområde" (buffrat ~120 m) i stället för kontroller
  och spår — start/mål och parkering syns fortfarande. Startkort, rapportsidor
  och inloggade ser alltid allt; togglas den släpps banan live på öppna
  publika sidor. UI-nivå, som poängpubliceringen (`publicControls`, saknas =
  visas).

## Teknik

- Statiska filer i `public/` — inga byggsteg.
- Firebase v10 SDK via CDN (ESM).
- `jsPDF` + `qrcodejs` via CDN för PDF/QR (laddas först när användaren klickar "Ladda ner PDF").
- Firestore-säkerhetsregler i `firestore.rules`.

## Komma igång lokalt (emulator, **inget riktigt Firebase-projekt behövs**)

Förutsättningar: Node 18+ och Java (för Firestore-emulatorn; `java -version`
för att kolla).

```bash
npm i -g firebase-tools                     # en gång
cd /path/to/ESKIL
firebase emulators:start --project demo-eskil
```

Öppna sedan:

- **Appen:** http://localhost:5050
- **Emulator-UI:** http://localhost:4000 (se Firestore-data, inloggningslänkar)

> macOS: port 5000 är ofta upptagen av AirPlay Receiver, så vi kör hosting
> på 5050 i stället.

Klient-koden i `public/js/firebase.js` känner av att sidan serveras från
`localhost` och kopplar automatiskt Auth + Firestore till emulatorerna
(`127.0.0.1:9099` resp. `127.0.0.1:8080`).

### Magic-link-inloggning i emulator

Auth-emulatorn skickar inga riktiga mejl — istället visas den genererade
länken i emulator-UI:t under fliken **Authentication → Email templates /
Sign-in links**, eller i Firebase-emulatorns terminalloggar. Kopiera länken
till webbläsaren för att slutföra inloggningen.

Superadministratörens e-post är konfigurerad i `public/js/store.js`
(`SUPER_ADMIN_EMAIL`) och måste matcha motsvarande literal i
`firestore.rules`. Den användaren får automatiskt `super-admin`-rollen
första gången hen loggar in.

### Köra mot ett riktigt Firebase-projekt i stället

Ersätt värdena i `public/firebase-config.json` med dina riktiga klientnycklar
(eller låt Firebase Hosting leverera `/__/firebase/init.json` — sker
automatiskt vid `firebase deploy`).

## Driftsättning

### Firebase-projekt (engångs-setup)

1. Skapa projekt på [Firebase Console](https://console.firebase.google.com/).
   Spark-planen räcker.
2. Aktivera **Firestore** (native mode).
3. Aktivera **Authentication → Sign-in method → Email link (passwordless)**.
4. **Authentication → Settings → Authorized domains** — lägg till ditt
   hostingdomän (`<project>.web.app` och ev. egen domän).
5. Uppdatera `.firebaserc` med ditt projekt-ID (`default`).

### Manuell deploy

```bash
firebase deploy --only hosting,firestore:rules,firestore:indexes
```

### Automatisk deploy via GitHub Actions

Workflow: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) —
deploy på varje push till `main` (och manuellt via "Run workflow").

**Engångs-setup:**

1. **Skapa tjänstekonto för CI** i Firebase Console:
   - Project settings → Service accounts → *Generate new private key*.
   - Detta laddar ner en JSON-fil. **Committa ALDRIG** filen.
2. **GCP IAM** → ge service-kontot rollerna:
   - `Firebase Hosting Admin`
   - `Cloud Datastore Index Admin`
   - `Firebase Rules Admin`
   - (Alternativt bara `Firebase Admin` — bredare men enklare.)
3. **GitHub → Settings → Secrets and variables → Actions**:
   - **Secret** `FIREBASE_SERVICE_ACCOUNT` = hela innehållet i JSON-filen.
   - **Variable** `FIREBASE_PROJECT_ID` = ditt Firebase-projekt-ID
     (samma som i `.firebaserc`).
4. Pusha till `main` — workflowen deployar.

## Super-admin

Det konto vars e-post matchar `SUPER_ADMIN_EMAIL` i
`public/js/store.js` (och motsvarande literal i `firestore.rules`) blir
automatiskt super-admin via `ensureUser()` första gången det loggar in.
Super-admin kan läsa/skriva allt och administrera alla tävlingar.

> Byt båda literal-värdena om du tar över driften av en instans — de
> MÅSTE vara identiska för att bootstrap ska gå igenom både klienten
> och reglerna.

## Rättighetsmodell (per tävling)

Alla rättigheter är **e-postbaserade** — personer kan bjudas in innan de
loggat in första gången (magisk länk ger verifierad e-post i auth-token, som
reglerna matchar mot). Tre nivåer:

- **Administratörer** (`adminEmails`, äldre `admins`-uid-lista stöds också) —
  full åtkomst. Tävlingsledningsroller med e-post kan bjudas in som admin
  direkt via en kryssruta i Tävlingslednings-formuläret.
- **Användare** (`users: [{email, name?}]` + platt `userEmails`-spegel för
  reglerna) — läsåtkomst till admin-vyerna.
- **Kontrollansvariga** (`ansvariga`/`ansvarigaEmails` på respektive kontroll,
  0–flera per kontroll, e-post + namn) — kan redigera och öppna/stänga SIN
  kontroll (inte radera den eller ändra vilka som är ansvariga; reglerna
  blockerar eskalering via `affectedKeys`). Speglas automatiskt in i
  användarlistan för läsåtkomst till resten, och visas samlat under
  Inställningar → Användare.

**Avsluta tävling** (Inställningar → Grund): raderar samtliga användare och
kontrollansvariga inklusive namn samt kontrollernas telefonnummer (endast
administratörer ligger kvar), stänger
alla kontroller och gör tävlingen skrivskyddad (`closed: true`). Kan
återöppnas, men de borttagna personerna återställs inte.

## Kataloglayout

```
public/
  index.html            # SPA-ingång (login + admin-UI)
  k.html                # Kontrollens rapportsida (ingen auth)
  s.html                # Patrullens startkort (ingen auth)
  t.html                # Publik tävlingssida (ingen auth)
  a.html                # Publik anmälningssida (ingen auth)
  m.html                # Start/Mål-stationen (ingen auth, hemlig URL)
  assets/
    tokens.css          # Scouterna Design System tokens
    app.css             # Adminsida-styles
    report.css          # Kontrollsida, inkl. nattläge
    public.css          # Publika tävlingssidan
    anmalan.css         # Anmälningssidan (mobile-first)
    station.css         # Start/Mål-stationen
  js/
    app.js              # SPA-bootstrap, route-tabell, topbar
    auth.js             # Magic-link-inloggning
    firebase.js         # SDK-init
    router.js           # Enkel path-baserad router
    store.js            # Firestore-åtkomst
    pdf.js              # PDF + QR-generering (lazy-loaded CDN-libar)
    qr.js               # QR-kodslib (lazy-loaded CDN), används av anmälans Swish-QR
    report.js           # Kontrollsida (k.html) logik
    start.js            # Startkort (s.html) logik
    public.js           # Publik tävlingssida (t.html) logik
    anmalan.js          # Anmälningssida (a.html) logik
    station.js          # Start/Mål-stationen (m.html) logik
    course.js           # Delad spårlogik (bensekvens, distans/tid, kartritning)
    utils.js            # Hjälpare (inkl. prisberäkning + Swish-QR-payload)
    views/              # En fil per vy (login, home, competition, patrols, ...)

functions/              # Cloud Functions — transaktionsmail via Trigger Email
  index.js              # Firestore-triggers som köar mail i `mail`-collectionen
  receipt-pdf.js        # Node-port av kvitto-PDF:n (bilaga i kvittomail)
firestore.rules         # Säkerhetsregler
firestore.indexes.json  # Index
firebase.json           # Hosting + Firestore + Functions-config
.firebaserc             # Projekt-alias (uppdatera till eget projekt-id)
```

## Datamodell (Firestore)

```
users/{uid}                      { email, role: "super-admin" | "user" }
competitions/{cid}               { name, shortName, year, date, location,
                                   organizer, description, closed,
                                   admins: [uid], adminEmails: [email],
                                   users: [{email, name}], userEmails: [email],
                                   createdBy, createdAt }
  patrols/{pid}                  { number, name, antal, avdelning, kar,
                                   notering }
  controls/{ctrlId}              { nummer, name, maxPoang, minPoang,
                                   extraPoang, lat, lng, information,
                                   notering, open, telefon,
                                   ansvariga: [{email, name}],
                                   ansvarigaEmails: [email] }
    scores/{patrolId}            { patrolId, poang, extraPoang, note,
                                   reportedAt, reporter }
  registrations/{regId}          { kar, contact: {name,email,phone},
                                   patrols: [{name,avdelning,antal}],
                                   mode, totalAmount, cancelled,
                                   payments: [{id,amount,reference,paid,paidAt}],
                                   forhinder: [{patrol,message,at}],
                                   createdAt, updatedAt }
  stations/{stationId}           { createdAt }   # doc-id = hemlig stations-URL
    passages/{patrolId}          { patrolId, startAt?, finishAt? }
  track/main                     { speedKmh, legs: { "<från>__<till>":
                                   [{lat,lng},…] }, updatedAt }
```

Stationens passager: doc-id = patrullens id så om-checkning skriver över.
Anonyma klienter får bara skriva fälten `patrolId`/`startAt`/`finishAt`
(reglerna diffar `affectedKeys`), och stationslistan kan inte räknas upp utan
inloggning — själva stations-id:t är hemligheten, som för kontrollernas
rapportsidor.

Tävlingens anmälningsinställningar ligger i `competitions/{cid}.registration`
(enabled, mode kår/patrull, opensAt/closesAt, prismodell, betalningssätt).
Anmälans dokument-ID är hemligheten i ändringslänken `/a/<cid>/<regId>` — samma
förtroendemodell som kontrollernas rapportsida. Länken mailas till
anmälningsansvarig via Firebase Auths e-postlänksmekanism (fungerar på
Spark-planen; ingen egen mailserver behövs). Periodgränserna upprätthålls i
UI:t.

Kontrollens dokument-ID är det som står i URL:en på rapportsidan — det är
"säkerheten" för kontrollerna (security by obscurity, så som specat). Poäng
kan rapporteras anonymt **endast** när `control.open == true`, annars blockerar
Firestore-reglerna skrivningen.

## E-post (Blaze + Trigger Email)

Transaktionsmail (anmälningsbekräftelse med ändringslänk, kvitto med
PDF-bilaga, förhinder-/avanmälningsnotiser till tävlingsledningen, samt
välkomstmail till nyutsedda kontrollansvariga med kontrollänk och
rapportsidans QR-kod) skickas av
Cloud Functions i `functions/` som skriver dokument till Firestore-collectionen
`mail`; **Trigger Email-extensionen** (`firebase/firestore-send-email`,
konfigurerad med Brevo-SMTP, avsändare `noreply@eskilscout.se`) levererar dem.
Klienter kan aldrig skriva i `mail` (ingen rules-match = deny) — det är därför
de anonyma sidorna är säkra trots mailutskick.

Kräver **Blaze-planen** (inom fria kvoter ≈ 0 kr/mån — sätt budgetlarm).
Extension-parametrar: collection `mail`, default FROM
`ESKIL <noreply@eskilscout.se>`, SMTP via Brevo.

Deploy av functions (ingår inte i CI-workflowen):

```bash
cd functions && npm install && cd ..
npx firebase-tools deploy --only functions
```

## Noteringar / avvägningar

- **Cloud Functions används enbart för mail** (`functions/`) — all övrig logik
  är fortsatt klient + Firestore-regler. Inbjudan sker genom att en befintlig
  användare läggs till i tävlingens `admins`/`users`-array efter att de
  loggat in en gång.
- **PDF-genereringen sker i klienten** — jsPDF + qrcodejs laddas lazily från
  CDN första gången användaren klickar.
- **Nattläge** på rapportsidan använder en djupröd palett som bevarar
  mörkerseendet när man rapporterar ute i skogen mitt i natten.
- Klientens UI är på **svenska**. Kod, kommentarer och denna README är på
  engelska/svenska blandat där det är tydligast.
