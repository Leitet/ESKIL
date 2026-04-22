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

## Att bjuda in en användare

1. Användaren loggar in med magisk länk en gång (skapar `users/<uid>`).
2. En tävlingsadministratör går till **Inställningar** → anger användarens
   e-post och rollen (admin eller användare).
3. Användaren har nu åtkomst till tävlingen vid nästa inloggning.

## Kataloglayout

```
public/
  index.html            # SPA-ingång (login + admin-UI)
  k.html                # Kontrollens rapportsida (ingen auth)
  assets/
    tokens.css          # Scouterna Design System tokens
    app.css             # Adminsida-styles
    report.css          # Kontrollsida, inkl. nattläge
  js/
    app.js              # SPA-bootstrap, route-tabell, topbar
    auth.js             # Magic-link-inloggning
    firebase.js         # SDK-init
    router.js           # Enkel path-baserad router
    store.js            # Firestore-åtkomst
    pdf.js              # PDF + QR-generering (lazy-loaded CDN-libar)
    report.js           # Kontrollsida (k.html) logik
    utils.js            # Hjälpare
    views/              # En fil per vy (login, home, competition, patrols, ...)

firestore.rules         # Säkerhetsregler
firestore.indexes.json  # Index
firebase.json           # Hosting + Firestore-config
.firebaserc             # Projekt-alias (uppdatera till eget projekt-id)
```

## Datamodell (Firestore)

```
users/{uid}                      { email, role: "super-admin" | "user" }
competitions/{cid}               { name, shortName, year, date, location,
                                   organizer, description,
                                   admins: [uid], users: [uid],
                                   createdBy, createdAt }
  patrols/{pid}                  { number, name, antal, avdelning, kar,
                                   notering }
  controls/{ctrlId}              { nummer, name, maxPoang, minPoang,
                                   extraPoang, lat, lng, information,
                                   notering, open }
    scores/{patrolId}            { patrolId, poang, extraPoang, note,
                                   reportedAt, reporter }
```

Kontrollens dokument-ID är det som står i URL:en på rapportsidan — det är
"säkerheten" för kontrollerna (security by obscurity, så som specat). Poäng
kan rapporteras anonymt **endast** när `control.open == true`, annars blockerar
Firestore-reglerna skrivningen.

## Noteringar / avvägningar

- **Ingen Cloud Functions** används — passar Spark-planen utan att lämna
  gratiskvoter. Inbjudan sker genom att en befintlig användare läggs till i
  tävlingens `admins`/`users`-array efter att de loggat in en gång.
- **PDF-genereringen sker i klienten** — jsPDF + qrcodejs laddas lazily från
  CDN första gången användaren klickar.
- **Nattläge** på rapportsidan använder en djupröd palett som bevarar
  mörkerseendet när man rapporterar ute i skogen mitt i natten.
- Klientens UI är på **svenska**. Kod, kommentarer och denna README är på
  engelska/svenska blandat där det är tydligast.
