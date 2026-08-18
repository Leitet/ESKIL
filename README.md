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
- **Poängtabell** — sortering Overall, per avdelning, per kår. Placeringar
  avgörs av totalpoäng → extrapoäng → flest maxade kontroller →
  **utslagsfråga** → delad placering.
- **Utslagskontroll** — en kontroll kan markeras som utslagskontroll med en
  fråga (t.ex. "Hur många knopar är det i burken?"). Kontrollanten rapporterar
  patrullens svar på rapportsidan; vid i övrigt lika resultat vinner den som
  ligger närmast rätt svar (ett svar slår inget svar). Utslaget räknas först
  när tävlingsledningen angett facit på kontrollen — då visas facit och alla
  gissningar sorterade på närhet på både admin- och publika poängtabellen
  (publikt endast när poängen är publicerade).
- **Kontrollens rapportsida** (`/k/<cid>/<ctrlId>`) — ingen inloggning, hemlig
  URL, mobiloptimerad, **nattläge**.
- **Kontrollens PDF** — hela paketet som lämnas över till kontrollanten:
  placering med karta och skanbar QR till rapportsidan, instruktioner, nödinfo
  med kontrollens egna koordinater och telefonnummer till ledning och
  grannkontroller, samt ett reservprotokoll att fylla i för hand.
  **Fältpaketet** (knapp i kontrollistan) är samtliga kontrollers paket i en
  fil: skriv ut dubbelsidigt och riv isär till kontrollernas pärmar. Varje
  kontroll börjar på en ny framsida — blanka sidor skjuts in där det behövs.
- **Magic-link-inloggning** med långa sessioner (Firebase Auth `browserLocalPersistence`).
- **Publik startsida** (`/`) — promotar ESKIL och listar tävlingar öppna för
  anmälan, pågående/kommande och avslutade tävlingar med resultat, plus
  inloggning. Sektionen "Testa ESKIL" har tre kort in i demospåret:
  tävlingssidan, **administratörsvyn utan konto** (ett skrivskyddat demoläge —
  guard() släpper in på demotävlingars adminvyer utan inloggning; alla dessa
  vyer läser bara publik data och reglerna blockerar ändå skrivningar) och
  startskärmen.
- **Tävlingens publika sida** (`/t/<cid>`) — tävlingens egen "reklamsida" som
  kan skickas till kårerna innan tävlingen: hero med beskrivning och
  anmälnings-CTA när perioden är öppen ("Anmälan öppnar X" innan dess),
  KPI:er (fjärde kortet växlar: öppna kontroller under tävling → dagar kvar →
  spårlängd), alla valda avdelningar, tävlingsledning, karta med spår eller
  tävlingsområde, samt **Startlistan** — en skrollbar live-lista på
  tävlingsdagen över ALLA starter: genomförda nedtonade ("startade"),
  kommande med nedräkning (sekundprecision sista 10 min, pulserande "GÅR NU"
  i startögonblicket), liveklocka, autoskroll till nästa start och länk till
  respektive startkort (startkorten nås även från patrullmodalen).
  Besökarens skrollposition bevaras över live-uppdateringar. Allt på sidan
  uppdateras live via snapshots + tickar.
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
- **Frågor från fältet** (Meddelanden-fliken) — kontroller och patruller kan
  skriva till tävlingsledningen direkt från sina egna sidor, med foton åt båda
  håll: kontrollanten fotar lappen som inte stämmer, ledningen svarar med en
  bild som förtydligar. Nya frågor hamnar överst under Meddelanden med notis,
  och svaret dyker upp direkt hos avsändaren. Läsmarkeringen delas av hela
  sekretariatet. Påslaget som standard, går att stänga av under Regler & info.
  Bilder skalas ner i klienten och lagras i meddelandet — hela samtalet
  raderas när tävlingen avslutas.
  På fältsidorna ligger allt bakom **en meddelandeikon**: driftmeddelandena
  från ledningen och det egna samtalet i samma tidslinje, i den ordning det
  kom. Kritiska meddelanden visas fortfarande som banner utan att man behöver
  öppna något.
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
- **Startkortet** (`/s/<cid>/<patrolId>`) — patrullens egen sida: karta,
  kontroller, poäng och ETA, live-uppdaterad. Med **"Patrullerna bekräftar
  start själva"** (Inställningar → Regler & info) blir kortet ett förlopp i
  tre lägen: före start visas bara tävlingsinformation, tävlingsledningens
  kontaktuppgifter och vägen till starten — knappen "Bekräfta start" finns men
  är släckt tills patrullens starttid passerats och tänds då grön. Först efter
  bekräftelsen öppnas kartan och kontrollerna, och maxtiden börjar räknas ned
  från den verkliga starten. Bekräftelsen syns i Läget och på stationssidan
  som en utcheckning (märkt "själv"; bara admin kan ångra den). Målgången kan
  komma från tre håll: funktionärens incheckning på stationen, patrullens egen
  knapp "Vi är i mål" (dyker upp när alla kontroller är rapporterade,
  inställningen "Patrullerna markerar sig i mål själva"), eller automatiskt
  vid sista kontrollrapporten ("Registrera målgång automatiskt" — slå bara på
  den när sista kontrollen ÄR målet). En funktionärs avprickning väger alltid
  tyngst, sedan patrullens egen, sist den automatiska; Läget märker ut de två
  senare med "själv" respektive "auto". När banan är
  avklarad byter kortet till en summering med positiva höjdpunkter — "Topp 3
  på 4 kontroller!", full pott, extrapoäng, tid på banan. Jämförelser mot
  andra patruller visas bara när poängen är publicerade, och en dålig
  placering skrivs aldrig ut (`js/highlights.js`).
- **Manuella startkort** (Patruller-fliken, och per patrull i startkorts-
  dialogen) — pappersstartkort i PDF för patruller utan mobil. A4 liggande som
  viks på mitten till A5: hela ena sidan är bankartan (zoomen väljs efter
  banan, och kartan läggs på högkant när banan är avlång så den fyller
  papperet), andra sidan har information på ena halvan och ett ifyllbart
  poängkort på den andra. Skrivs banan ut med anonyma kontroller får
  poängkortet skrivrader i stället för kontrollnamn. Kartsidan har kompass och
  skalstock för den som navigerar. Två varianter:
  **tomma reservkort** (utan namn och starttid — sekretariatet fyller i för
  hand; normalfallet när tävlingen kör digitalt och bara enstaka patruller
  saknar mobil) eller **ett kort per patrull** med allt ifyllt. Båda i en fil,
  och kartan ritas en enda gång.
- **Spårdragning** (flik "Spår") — rita spåret mellan kontrollerna på en stor
  karta (växla karta/satellit, fullskärmsläge). Bensekvensen härleds ur
  kontrollernas nummerordning (start → 1 → 2 → … → mål när start/mål är
  konfigurerat); klick i kartan lägger punkter på den aktiva sträckan, punkterna
  dras för att justera och tas bort med dubbelklick. Panelen visar längd och
  gångtid per sträcka samt total spårlängd och beräknad vandringstid med valbart
  promenadtempo (3/4/5 km/h), exklusive och inklusive kontrolltid
  (5 min/kontroll). Ben utan ritade punkter räknas som fågelväg (streckad).
  Finns ett ritat spår används det alltid på alla kartor: offentliga sidan,
  startkortets översiktskarta (med chip "Spår X km · ca Y min gång") och
  Läget-kartan (dämpad bakgrundslinje). Delade hjälpare i `js/course.js`.
- **Start och mål** sätts i kontrollistan, tillsammans med resten av banan —
  de är banans ändpunkter (ETA:n räknar sträckor från dem, spåret hänger på dem).
  Normalt samma plats; "Målet ligger någon annanstans" ger ett eget mål med
  eget slutben.
- **Platser** (Inställningar → Platser) — allt annat som ska pekas ut på
  kartan: parkering, sekretariat, toaletter, vatten, första hjälpen, matplats,
  eldplats, samling … eller helt egna punkter. Varje plats får en färgad nål
  med sin symbol (Lucide) och visas på tävlingssidan, startkorten och i Läget.
  Sorten sätter symbol och färg automatiskt; båda går att välja fritt.
  Noteringen visas publikt. Äldre tävlingars parkering följer med automatiskt.
  En plats kan också **ingå i spåret** — kryssa i det och välj vilken kontroll
  den passeras efter, så vävs den in i banan (Start → 1 → 2 → 3 → Matplats →
  4) och spårdragningen får en sträcka dit. Ange gärna hur länge patrullen står
  still där; tiden räknas in i banans totaltid och i ETA:n. Banplatser ger
  inga poäng och räknas aldrig som avklarade kontroller.
- **Tävlingsområde** — per-tävlingsinställning (Inställningar → Regler & info:
  "Visa kontrollplatser på publika sidan"). Avbockad visar publika kartan ett
  skuggat konvext "Tävlingsområde" (buffrat ~120 m) i stället för kontroller
  och spår — start/mål och parkering syns fortfarande. Startkort, rapportsidor
  och inloggade ser alltid allt; togglas den släpps banan live på öppna
  publika sidor. UI-nivå, som poängpubliceringen (`publicControls`, saknas =
  visas). Med "Släpp banan automatiskt 5 min före första start"
  (`autoReleaseControls`) släpper öppna publika sidor banan av sig själva
  5 min före första patrullens starttid på tävlingsdatumet (kräver datum +
  starttider); kartans bildtext visar när.

- **Officiell resultatexport** (Poängtabell-fliken, admin) — "Resultat
  (PDF)": officiella resultat i ESKIL-design (overall med topp-3-markering,
  per avdelning, per kår, utslagsfrågor med facit och svar) plus
  tävlingsarkiv/post mortem (tävlingen i siffror, kontrollstatistik med
  snittpoäng, tävlingsfakta, ledning, placeringsregler). "CSV": semikolon +
  BOM för svensk Excel, en rad per patrull med per-kontroll-kolumner för
  arkiv/förbund. Delad kod i `js/results-export.js`.
- **Betalningspåminnelse** (Anmälan-fliken) — kassören skickar manuell
  påminnelse per obetald anmälan eller "Påminn alla obetalda": mail med
  obetalda belopp + referenser och länk till anmälningssidans
  betalningsinstruktioner. Knappen visar när senaste påminnelsen gick ut
  (`reminderRequestedAt` stämplas av UI:t, funktionen mailar och skriver
  `reminderSentAt` tillbaka).
- **Skicka PM** (Anmälan-fliken) — massutskick till alla aktiva anmälningars
  kontaktpersoner: ämne + text (med färdiga mallar: PM inför tävlingen,
  ändrade starttider, ändrad samlingsplats, inställd tävling — {luckor} i
  hakparenteser fylls i, med varning om de glöms). Admin skapar ett doc i
  `competitions/{cid}/utskick`; Cloud Function `onUtskickCreated` skickar ett
  mail per anmälan (avanmälda hoppas över) med mottagarens ändringslänk och
  reply-to till tävlingsledningen, och stämplar tillbaka sentAt + antal
  mottagare (historik visas i dialogen).
- **Kopiera tävling till nästa år** (Inställningar → Grund) — skapar nästa
  års tävling från årets: kontroller (instruktioner, positioner,
  utslagsfrågor — nya hemliga rapportlänkar, facit/telefon/ansvariga
  nollställda, allt stängt), spåret (sträck-nycklarna mappas om till de nya
  kontroll-id:na), inställningar, prismodell (anmälan avstängd med rensad
  period) och tävlingsledning. Patruller, poäng, anmälningar och användare
  kopieras inte; skaparen blir ensam admin.
- **Super-admin systemhubb** (`/app/admin/system`, via Inställningar) —
  referenskonsol för super-admin: länkar till alla dashboards (Firebase,
  Google Cloud, Brevo, reCAPTCHA, GitHub), en "var administreras vad"-karta,
  systemstatus, och Firestore-backad config (`config/system`) för mail-
  kvoterna som Cloud Functions läser — justerbara utan deploy.
- **Prisutdelningsläge** (`/app/c/<cid>/ceremony`, knapp på Poängtabellen) —
  storbildsläge för ceremonin: välj avdelning eller Overall, avslöja pallen
  med dramatik (trea… tvåa… ETTAN i guld) styrt med mellanslag/klick/pil,
  delade placeringar visas tillsammans, avklarade kategorier bockas av.
  Fungerar ihop med dolda publika poäng: mörkt på webben, avslöjas på scen.
- **Poänghistorik & justeringslogg** — när en poäng skrivs över (kontrollant
  omrapporterar eller sekretariatet justerar) bevaras det gamla värdet i
  score-docens `history` (max 10, med rapportör och tid; följer med genom
  offlinekön). Sekretariatet justerar från kontrollsidan med **obligatorisk
  motivering** (`adjustNote`/`adjustedBy`; anonyma rapportörer kan inte
  skriva de fälten — reglerna begränsar dem till history). Poängtabellen
  (admin) visar justeringsloggen: gammalt → nytt, vem, när, motivering.
- **Backup, export & import** (Inställningar → Grund) — Backup = komplett
  JSON-dump (tävling + alla subcollections, timestamps serialiserade) som
  "Importera backup" läser tillbaka och återskapar som en NY tävling med
  bevarade dokument-id:n (rapport-/startkorts-/stationslänkar fungerar).
  Import triggar aldrig mail (`imported: true` på registrations/kontroller
  som mail-funktionerna respekterar; utskickshistorik återimporteras inte).
  Export = zip (JSZip via CDN) med backup.json + CSV:er för resultat,
  patruller, kontroller, anmälningar + README. Admin får numera alltid
  skriva poäng i reglerna (justeringar/restore).
- **Offline-hårdning (PWA)** — en service worker (`public/sw.js`) gör
  rapportsidan, startkortet och stationssidan öppningsbara helt utan nät:
  network-first med cachat skal som fallback för /k, /s, /m, stale-while-
  revalidate för egna assets + Firebase/CDN-libbar (Firestore/auth/karttiles
  rörs aldrig). Firestore kör persistent IndexedDB-cache (multi-tab) så
  datat finns kvar offline. Tillsammans med offlinekön: tappar kontrollanten
  sidan i skogen kan den öppnas igen och rapporteringen fortsätta.
- **GDPR & cookies** — ESKIL använder inga cookies (ingen banner behövs):
  inloggning via IndexedDB, övrig lokal lagring är strikt nödvändig
  (nattläge, offlinekö, pseudonymt rapportörs-id). Integritetspolicy på
  `/integritet` (statisk sida, länkad från startsidan, publika sidor,
  anmälan och inloggningen). Att avsluta en tävling GDPR-gallrar användare,
  kontrollansvariga, kontrolltelefoner samt anmälningarnas kontaktuppgifter,
  fritextsvar (t.ex. allergier) och förhinder — patrullnamn, resultat och
  betalningsbelopp/referenser bevaras. Inloggningen förklarar vad som sparas
  och när det raderas.

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
    app.js              # SPA-bootstrap, route-tabell, topbar, footer
    nav.js              # Delad navigation: tävlingsflikar, brödsmulor, dokumenttitel
    auth.js             # Magic-link-inloggning
    firebase.js         # SDK-init
    router.js           # Enkel path-baserad router
    store.js            # Firestore-åtkomst
    pdf.js              # PDF + QR-generering (lazy-loaded CDN-libar)
    qr.js               # QR-kodslib (lazy-loaded CDN), används av anmälans Swish-QR
    report.js           # Kontrollsida (k.html) logik
    share-card.js       # Delningsbilden — ritar resultatkortet i canvas
    views/kontakt.js    # Publikt kontaktformulär (/kontakt)
    views/admin-feedback.js # Super-admins inkorg för de meddelandena
    share-sheet.js      # "Dela ert resultat" — bladet med design, format och innehåll
    start.js            # Startkort (s.html) logik
    public.js           # Publik tävlingssida (t.html) logik
    anmalan.js          # Anmälningssida (a.html) logik
    station.js          # Start/Mål-stationen (m.html) logik
    course.js           # Delad spårlogik (bensekvens, distans/tid, kartritning)
    districts.js        # Scouternas 26 distrikt + "annat" (gruppering av tävlingar)
    highlights.js       # Positiva höjdpunkter på startkortet efter målgång
    places.js           # Intressepunkter (sort, symbol, färg) + kartritning
    place-modal.js      # Delad redigeringsdialog för en plats på kartan
    seo.js              # Metadata per rutt (canonical, description, OG, noindex)
    mcp-klienter.js     # Katalog: hur varje LLM-klient kopplar in MCP-servern
    utils.js            # Hjälpare (inkl. prisberäkning + Swish-QR-payload)
    views/              # En fil per vy (login, home, competition, patrols, ...)

functions/              # Cloud Functions — transaktionsmail via Trigger Email
  index.js              # Firestore-triggers som köar mail i `mail`-collectionen
  receipt-pdf.js        # Node-port av kvitto-PDF:n (bilaga i kvittomail)
  mcp/                  # MCP-servern — det andra undantaget från "bara mail"
    transport.js        # Streamable HTTP för hand (tillståndslös, legacy-eran)
    auth.js             # /mcp/<cid>/<nyckel> — nyckeln lagras bara som sha256
    verktyg.js          # Verktygsytan: allowlistor, validering, bekräftelsetoken
    redact.js           # Redaktionen — vad modellen får läsa, med default-deny
    ledning.js          # CJS-dubblett av splitManagement (testad mot ESM-versionen)
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
                                   slug,  // fast kortadress: /t/<slug>, /a/<slug>
                                          // + prefix i betalningsreferenser
                                   broadcast: { text, level: info|varning|kritisk,
                                                at, target: { kontroller: true|[id]|false,
                                                              patruller: true|[id]|false } },
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

### Avsändarautentisering (DNS) — annars fastnar mailen i skräpfiltren

Domänen `eskilscout.se` måste auktorisera **både** Firebase och Brevo. Det finns
bara EN SPF-post per domän, så includerna måste stå i samma rad:

```
eskilscout.se.  TXT  "v=spf1 include:_spf.firebasemail.com include:spf.brevo.com ~all"
```

Saknas `spf.brevo.com` skickar Brevo från IP:n som domänen inte pekar ut, och
strikta mottagare avvisar med `554 5.7.1 Spam message rejected` — mailet ser
levererat ut i extension-loggen ("accepted: 1") men studsar hos mottagaren.
Kontrollera i Brevo (Statistics → Email) om ett mail bounce:at.

Övriga poster som ska finnas: DKIM (`brevo1._domainkey` och `brevo2._domainkey`
som CNAME till Brevos nycklar), verifieringsposten `brevo-code:…` och en
DMARC-post på `_dmarc.eskilscout.se`.

Snabbkoll:

```bash
dig +short TXT eskilscout.se
```

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
