# ESKIL — Notes for AI assistants

## What this is

ESKIL is a scout competition admin system. It is built **static** — no build
step, no bundler. All JS is ES modules served from `public/`, Firebase SDK
loaded from CDN. Runs on Firebase Blaze plan (within the free quotas) — the
paid plan exists ONLY for transactional email (Cloud Functions + the Trigger
Email extension). Production domain: https://eskilscout.se.

## Architectural invariants

- **No build step.** Don't introduce one. If you need a dependency, load it
  from a CDN (see `public/js/pdf.js` for the pattern).
- **UI is Swedish.** All user-facing strings must be in Swedish. Code,
  comments, identifiers stay English where it reads naturally.
- **The control ID is the secret.** `/k/<cid>/<ctrlId>` is the reporter URL.
  Firestore rules allow anonymous score writes only when the control document
  has `open == true`.
- **App Check is ENFORCED in production** (reCAPTCHA v3, on Firestore and
  Cloud Functions since 2026-08-13; initialised in `firebase.js`, skipped on
  localhost since the emulators sit outside it). Anonymous ≠ unattested:
  every prod read/write needs a token, so curl/bot traffic is rejected before
  the rules run. Never remove the init or drop `www.google.com` from the CSP.
  Details and the un-enforce escape hatch: SECURITY.md.
- **The registration ID is the secret too.** `/a/<cid>/<regId>` is the manage
  link for a registration (Anmälan). Anonymous create/update is allowed while
  `competition.registration.enabled == true`; the open/close period is
  enforced in the UI only. The manage link is emailed via Firebase Auth's
  email-link mechanism — the only free email channel on Spark.
- **Sessions are long-lived.** `browserLocalPersistence` is set explicitly —
  users stay signed in until they log out manually.
- **Design system is `public/assets/tokens.css`.** Do not redefine tokens;
  extend via semantic class names in `app.css` or `report.css`.
- **Night mode** on the reporter page is a red palette. Don't swap it for a
  gray dark mode — preserving night vision is the requirement.
- **The ETA engine lives in `public/js/course.js`.** `courseEta` (model:
  walking time + fixed stationstid), `courseEtaCalibrated` (the median of
  patrols' REAL leg times from score data replaces a leg's model estimate at
  ≥3 samples — queues get baked in automatically; demo competitions always
  run the pure model) and `patrolFinishEtaMs` (a patrol's finish estimate
  anchored in its latest report). Every ETA surface (/k, control PDF,
  station, startkort, /t, Läget) must go through these — never hand-roll an
  ETA in a view. Passage time is `clientReportedAt`, NOT `reportedAt` (see
  the scores bullet below).
- **Navigation lives in `public/js/nav.js`.** Competition tab bar
  (`compTabs`), breadcrumbs (`crumbs`/`compCrumbs`) and browser-tab titles
  (`setDocTitle`) are shared — never hand-roll a `.tabs` bar in a view.
  Every page must have a route back to the competition start page and to a
  start page (`/app` or `/`); anonymous pages may link to `/t/<cid>` (public)
  but must never link to, or leak, secret URLs. The router fires its
  route-change hook BEFORE the view handler (title reset depends on this).

- **Kontrollens PDF är hela paketet.** `generateControlPdf` ger placering
  (karta + QR), instruktioner, nödinfo (kontrollens EGNA koordinater + telefon
  till ledning och grannkontroller) och reservprotokoll. `generateFieldPackPdf`
  är bara alla kontrollers sådana paket i en fil — den har ingen egen layout
  längre. Varje kontroll MÅSTE börja på en udda sida (`behöverUtfyllnad` +
  `drawBlankFillerPage`): bunten skrivs ut dubbelsidigt och rivs isär till
  kontrollernas pärmar, och utan utfyllnaden hamnar en kontrolls första sida
  på baksidan av föregående. Verifierat genom att leta upp sidfoten
  "Sida 1 · Placering" per sida i den färdiga filen — och mutationsverifierat
  (utan utfyllnad blir startsidorna 1, 6, 11, 16).
- `.../threads/{kind-refId}/messages/{msgId}` — **samtal fält ↔ ledning**
  (`comp.fieldMessaging`, PÅ som standard, så regeln läser
  `.get('fieldMessaging', true)`). Tråd-id:t är deterministiskt
  (`kontroll-<ctrlId>` / `patrull-<patrolId>`), så att känna till det ÄR att
  hålla den hemliga fältlänken; `list` är member-only så id:n inte kan räknas
  upp. Anonymt får `from` bara vara `'falt'` — ett falskt "från ledningen"
  skulle kunna få en kontrollant att göra fel på riktigt. Fältet får heller
  inte röra `ledningReadAt` (då kunde en inkommen fråga gömmas). Allt tre är
  mutationsverifierat.
  **Bilder ligger i meddelandet som data-URL**, inte i Cloud Storage:
  projektet har ingen bucket, och en bild från skogen kan visa scouters
  ansikten — i Firestore följer den tävlingens gallring. `public/js/photo.js`
  skalar ner till ≤ 400 000 tecken och reglerna vaktar samma tak; håll de två
  i synk. `closeCompetition` och `deleteCompetition` raderar trådarna HELT.
  UI: `public/js/chat.js` (`mountMessages`) äger EN ikon och EN modal på /k
  och /s, och flätar in `broadcast.js`-driftmeddelandena i SAMMA tidslinje som
  samtalet — för den som står i skogen är det ett flöde av saker ledningen
  sagt. Klockan (`#eskil-bell`) finns inte längre; broadcast.js exponerar i
  stället `broadcastFeed()` / `broadcastPendingAcks()` / `ackBroadcast()` /
  `onBroadcastChange()` och behåller bara bannerstacken och larmen — ett
  kritiskt meddelande ska synas utan att någon öppnar en modal. Panelen ärver
  report.css-variablerna så nattläget håller. Ledningens sida: inkorgen i
  `views/meddelanden.js`.
- **Fältsidornas UI-mönster** (gäller /s och /k; /m följer efter):
  en FAST header (`.field-bar` i s.html och k.html) med informations-,
  meddelande- och nattlägesknapp högerjusterade och reserverad höjd, samt
  `public/js/sheet.js` (`openSheet`) som ETT sätt att visa allt som poppar
  upp — kontrollblad, poängblad, information, meddelanden. Bladet har
  draghandtag, svep ner, klick utanför och Esc. Bygg inte en egen overlay
  till nästa yta; det finns ingen fallback kvar för handrullade blad.
  `backdropClose: false` för blad där ett tapp bredvid skulle slänga arbete
  (poängbladet). Rapportsidans gamla flip-kort är borta — samma innehåll
  ligger i informationsbladet bakom (i)-knappen.
  Bannern och headern delar toppen: broadcast.js sätter `--field-bar-offset`
  och räknar in headern i body-paddingen, annars hamnar headern bakom bannern.
  `--field-top` (report.css) är summan av båda — sticky-remsor och
  `scroll-padding-top` måste utgå från den, annars hamnar det de scrollar
  fram under headern.
- **Återkoppling: toast eller notis i bladet.** `toast()` (utils.js, admin +
  publika sidor) skapar sin egen `.toast-wrap` om sidan saknar `#toasts` —
  utan wrapen blir toasten ett statiskt block sist i dokumentet och syns
  aldrig på en lång sida. Fältsidornas `rtoast` (report.js) lämnar i stället
  över till `sheetNotice()` i sheet.js när ett blad är öppet: en toast i
  nederkanten hamnar bakom bladet, och även med rätt z-index landar den
  ovanpå knappen man just tryckte. Notisen står mellan innehållet och
  knapparna — svaret på "varför hände inget?" där blicken redan är.
  Mutationsverifierat: med gamla `z-index: 60` blockeras toasten av `.r-btn`.
- **`[hidden]` är en global regel** (`display: none !important`) i report.css
  och app.css. Ett element med eget `display` vinner annars över attributet,
  och den fällan har slagit till flera gånger (notisbadgen visade "0",
  avståndschipen låg som en tom vit pill över kartan). Lägg inte till
  `.nånting[hidden]`-regler — den globala täcker dem.
- **Patrullens etikett är `patrolLabel()` i utils.js**: `Rävarna (Lindsdals
  Scoutkår)`. Används där patrullen visas som EN etikett — Läget,
  stationssidan, reservprotokollet, delade placeringar — eftersom flera kårer
  döper sina patruller likadant och de vyerna saknar kårkolumn. Används INTE
  där kåren redan står i en egen kolumn eller underrad (admin-patrullistan,
  /t, prisutdelningen, startskärmen); där blir den bara dubblerad.
- **Manuella startkort (`generateManualStartPdf` i `pdf.js`)** — pappersvarianten
  för patruller utan mobil. A4 LIGGANDE, vikt på mitten till A5: sida 1 hela
  kartan, sida 2 halv information + halvt poängkort. Kartan kommer från
  `courseMapDataUrl`. Ramningen (`fitView`, testad) gör två saker: den
  **roterar bilden 90°** när banan är avlång, och den skalar bilden till exakt
  passning i stället för att snäppa till hela zoomsteg — annars kan halva
  sidan bli tom, eftersom varje zoomsteg är en fördubbling. Marginalen är i
  PIXLAR (`MAP_MARGIN_PX`), inte procent: en procentsats blir enorm på en
  tryckstor bild och var hela orsaken till de tomma fälten runt banan.
  Zoomnivån väljs så att skalan hamnar närmast 1 — antalet kartrutor växer med
  kvadraten på 1/skalan, och att alltid skala ner kostade 140 rutor och 6 s
  mot 48 rutor och 0,2 s utan synlig skillnad på papperet. `MAX_UPSCALE`
  hindrar att en kort bana blåses upp till oläslighet.
  Kompass och skalstock ritas i `drawMapChrome` — EFTER en eventuell rotation,
  och nålens `northDeg` är 90 när bilden roterats. Norr är inte uppåt på en
  roterad karta, och en kompass som pekar fel är värre än ingen. Verifierat
  genom att mäta var en känd nordpunkt hamnar i den färdiga bilden.
  Roterar du canvasen: `save()`/`restore()`, annars ligger transformen kvar
  och kompassen hamnar roterad i fel hörn. Kartan renderas EN gång
  per massutskrift; 30 patruller ska inte bli 30 tile-omgångar.
  `patrol = null` ger ett TOMT reservkort: namn, kår och starttid blir
  skrivrader. `downloadManualStartPdf` tar ett TAL i patrols-argumentet för
  att göra N sådana.
  Poängkortet MÅSTE respektera `anonymousControls`: är den på skrivs inga
  kontrollnamn ut, bara nummer och en skrivrad. Kortet bärs hela dagen.
  Radhöjden har medvetet INGET golv — ett golv gör att rader ritas utanför
  sidan och försvinner tyst när banan har många kontroller.

## Directory map

See `README.md` for the layout — every file there is load-bearing.

## Entry points

- `public/index.html` — admin SPA. All `/app/*` routes served via
  hosting rewrites to `/index.html`.
- `public/k.html` — reporter page. All `/k/*` routes rewritten to
  `/k.html`.
- `public/m.html` — start/finish station (`/m/<cid>/<stationId>`), anonymous
  like the reporter page; the station id is the secret.
- **Slug (kortadress):** `competition.slug` is a FIXED human short-id set at
  creation (e.g. `ah26`), lockable once for pre-slug competitions via
  settings → Grund. `/t/<slug>`, `/a/<slug>` and `/s/<slug>/<patrolId>`
  resolve it (store.getCompetitionBySlug); payment references use it as
  prefix (utils.refPrefix). Uniqueness is checked client-side at creation
  (store.isSlugTaken — also against existing doc ids, which shadow slugs).
  Never change a slug after creation — printed QR codes and references
  depend on it.

## Who may create a competition

Not everyone. A signed-in user CANNOT create a competition directly — the
rules allow `competitions` create only for super-admins, plus one exception:
årgångskopiering, where `copiedFrom` must point at a competition the creator
already administers. Everyone else files a request in `competitionRequests`
(name, date, description, message; `status: vantar|godkand|nekad`, only
super-admins may set the decision). Approving from `/app/admin/requests`
CREATES the competition with the requester as admin (uid + email) and stamps
the request; denying creates nothing. Cloud Functions mail super-admins on a
new request and the requester on the decision.

## Firestore rules model

- `users/{uid}` — a user's own doc.
- `competitions/{cid}` — meta. Permissions are EMAIL-based (checked against
  the verified `request.auth.token.email`, always lowercase): `adminEmails[]`,
  `userEmails[]` (flat mirror of `users: [{email, name}]` — write both via
  store.setCompetitionUsers). Legacy uid `admins[]` still honored. Controls
  carry `ansvariga: [{email, name}]` + flat `ansvarigaEmails[]` (in the
  control's private/meta subdoc); ansvariga may update their control and
  INVITE co-ansvariga (append-only — rules require the new ansvarigaEmails
  to be a superset via hasAll) but never remove anyone (admin-only) and
  never touch `welcomed`.
  `ekonomiEmails[]` (mirror of `ekonomi: [{email, name}]`, in private/access
  only — write via store.setCompetitionEkonomi) marks ekonomiansvariga/
  kassörer: member-level read + may update ONLY `paidRefs` on registrations.
  They are appointed via Tävlingsledning roles flagged `ekonomi: true` — the
  management save path syncs the mirror. A `closed`
  competition is read-only for everyone but admins, and closing wipes
  users + ansvariga + ekonomi + each control's `telefon` (GDPR cleanup) —
  admins remain.
- `.../patrols/{pid}` — publicly readable (for the reporter page). May carry
  `utgatt: {at, note}` (DNF, set/undone from Läget): excluded from queues,
  alarms and rest-lists everywhere; the note (can be sensitive) is wiped by
  closeCompetition, the flag itself remains as history.
- `.../controls/{ctrlId}` — publicly readable; writable by competition admins.
- `.../controls/{ctrlId}/scores/{patrolId}` — one doc per patrol×control; the
  doc id IS the patrolId so re-reporting overwrites. May carry
  `utslagGissning` (the patrol's tiebreaker guess) when the control has
  `utslag: true` + `utslagFraga`/`utslagSvar`; ranking uses it only once
  `utslagSvar` is set. Beware `Number(null) === 0` — use utils.isNumSet.
  Score docs carry BOTH `reportedAt` (serverTimestamp = sync moment, audit)
  and `clientReportedAt` (client time = when the button was pressed; the
  offline queue passes its queuedAt). Anything reasoning about WHEN a patrol
  passed (ETA engine, Läget) must prefer `clientReportedAt` — offline batch
  syncs make `reportedAt` lie by hours. adjustScore deliberately preserves
  the original times: a correction is not a passage.
- `.../messages/{msgId}` — driftmeddelanden v2 (the Meddelanden tab):
  `{text, level: info|varning|kritisk, at, target: {kontroller, patruller},
  requireAck, active}`. Publicly readable (field pages are anonymous — the
  composer warns against personal data), admin-written. Multiple messages
  stack on clients via `public/js/broadcast.js` (which also owns the 🔔
  bell, localStorage history and the Notification-API plumbing; kritisk
  alarms with sound/vibration). `messages/{id}/acks/{kind-refId}` holds
  receipts (`seenAt` auto-stamped on display, `ackAt` on the Bekräfta
  button): anonymously writable with a hard shape guard, but readable ONLY
  by members — ack docs contain station ids, which are secret. The legacy
  comp-doc `broadcast` field still renders in the stack until cleared.
- Comp-doc extras added over time: legacy `broadcast` (see above);
  `copiedFrom` (årgångskedjan — /t links to the previous year);
  `lastBackupAt` (stamped on every backup/export download);
  `etaDwellMinutes` (ETA station time override, default 15);
  `startTimes.maxTimeMinutes` (maxtid countdown on the startkort);
  `district` (scoutdistrikt — see below).
- **Platser och banans ändpunkter är två olika saker.**
  `comp.startFinish` (start/mål) är BANDATA: `courseLegs` bygger `__start`/
  `__mal`-noderna ur den, ETA räknar första och sista benet från dem och
  stationssidan checkar av mot dem. Den redigeras därför i KONTROLLISTAN
  (`views/controls.js` → `openStartFinishModal`), inte i inställningarna, och
  har en fast gul look på alla kartor.
  `comp.places[]` (`public/js/places.js`) är ren utmärkning: parkering,
  sekretariat, toaletter, egna punkter — var och en med sort, Lucide-symbol
  och en färg ur `PALETTE`. Redigeras under Inställningar → Platser. Läs dem
  ALLTID via `compPlaces(comp)`: den normaliserar okända värden i stället för
  att låta nålen tyst försvinna, och tar med den gamla `comp.parking` som en
  plats så äldre tävlingar behåller sin parkering (`parkingPoint` i utils.js
  är kvar bara för backupfiler). Rita dem via `drawPlaces()` — fyra kartor
  ritar dem och de ska se likadana ut på alla.
  Symbolnamnen måste finnas i `icons.js`; det testas (`hasIcon`), för en
  symbol som saknas renderar tomt och upptäcks annars först i skogen.
  En plats kan dessutom INGÅ I BANAN (`inCourse` + `courseAfter` =
  kontrollnumret den följer, 0 = efter start, + `dwellMinutes`). `courseLegs`
  väver då in den som en nod med `kind: 'place'` och nyckeln `place:<id>` —
  Start → 1 → 2 → Matplats → 3. Sådana noder har inga poäng, ingen
  rapportsida, kalibreras aldrig (de rapporterar inget) men kostar sin
  `dwellMin` i ETA:n. En plats som pekar på ett kontrollnummer som inte finns
  hamnar sist före mål i stället för att tyst falla ur banan. Att lägga in en
  plats DELAR ett ben — waypoints ritade på det gamla benet blir föräldralösa
  (hjälptexten säger det).
- **Scoutdistrikt.** `public/js/districts.js` holds Scouterna's 26 districts
  plus `annat`. Every competition carries a `district` id: it is REQUIRED in
  the request form, settable in the super-admin create modal, and editable
  afterwards under settings → Grund. Always write it through
  `normDistrict()` — an unknown or empty id must land on `annat`, otherwise
  the competition silently drops out of the grouping on /app. Districts have
  no official colours (Scouterna's palette belongs to the age groups); the
  dot next to a district name is a scanability aid derived from the id.
- `.../private/handover` — överlämningsdokument for next year's ledning
  (free text; members read/admins write via the existing private/{doc}
  rule). copyCompetition carries it over to the new year.
- `.../track/main` — the drawn course ("Spår" tab): waypoints per leg keyed
  `<fromKey>__<toKey>` plus `speedKmh`. The leg sequence itself is derived
  from control number order at render time, never stored. Publicly readable
  (controls already expose all positions); admin-only writes.
  The editor has an explicit **no-leg-selected** state (`activeIdx === -1`,
  and it is the default): the map is then inert and renders clean for
  screenshots. Where a new point lands in the sequence is decided by
  `waypointInsertIndex` in `course.js` — near the line refines there, farther
  away extends from the end. Don't put it back to plain nearest-segment: on a
  curved leg the nearest segment ties on the bend and points landed BEFORE
  the previous one. Regression-tested in `test/logic.test.js`.
- `.../selfPassages/{patrolId}` — **patrullens egna avprickningar**
  (`startAt`/`finishAt`). With `comp.selfStart` / `comp.selfFinish` the patrol
  presses "Bekräfta start" / "Vi är i mål" on its own startkort instead of
  being checked in by a marshal. Own collection because the startkort does NOT
  know the station id (secret — whoever has it can check anyone in or out).
  Each stamp is written **once and never changed**: a time that can be
  rewritten is no record for the secretariat; undo is admin-only (buttons in
  Läget; the station page says so instead of failing a dialog silently).
  Rules also require the patrol to exist and each timestamp to sit within
  −12 h…+2 min of `request.time`; that start can't be confirmed before the
  patrol's start time, and finish not before the last control, is UI-level —
  rules can compute neither startOrder × interval nor read every score doc.
- **Målgång har tre källor**, merged in Läget (`mergePassages`, called from
  `renderStats` because the derived one depends on score data):
  1. the start/finish station's check-in (`passages`),
  2. the patrol's own `selfPassages.finishAt`,
  3. `comp.autoFinish` — **derived**, not stored: all controls reported →
     the latest `clientReportedAt`. Nothing is written; the time already
     lives in the score data.
  Precedence is always marshal > patrol > derived, everywhere. Läget labels
  the last two "· själv" / "· auto" — a derived finish claims a patrol is home
  without anyone having seen them, and that list is what the secretariat uses
  to know who is still out. `station.js` deliberately does NOT count the
  derived one: the station shows who physically passed.
  The startkort has three phases (`cardPhase()` in `start.js`): `info` before
  confirmation (competition info + how to reach the start, NO course — see
  `positionsVisible()`), `tavling`, and `summering` once the course is done.
  Summering renders `patrolHighlights()` from `public/js/highlights.js`:
  positive only, by design — a last place is never printed, and comparisons
  are gated on `publicScores`. Logic tested in `test/logic.test.js`.
- **Dela ert resultat** ligger i summeringen: `share-card.js` ritar bilden,
  `share-sheet.js` är bladet, båda laddas med `import()` först vid tryck så
  en patrull mitt på banan aldrig betalar för dem. Bilden ritas i canvas och
  lämnar ALDRIG telefonen av sig själv — ingen uppladdning, inget
  tredjepartsanrop, och därför inga kartrutor: en patrull i mål står ofta
  utan täckning, och en publicerad bankarta vore ett problem så länge andra
  är kvar ute. Bilden får aldrig bära startkortets hemliga länk, bara
  `/t/<slug>`. Placeringen erbjuds bara när `publicScores` tillåter det OCH
  när den passerar `rankWorthShowing()` i highlights.js — samma grind som
  höjdpunkterna. Utan den skickade `shareData()` in `totalRank` rakt av och
  kortet tryckte "12:a av 12" stort i en ring; till skillnad från startkortet
  ligger den bilden kvar i ett offentligt flöde. Mutationsverifierat.
  Av samma skäl finns `hjälte()`: kortets stora tal är placering → poäng →
  antal klarade kontroller, så en patrull med noll på allt får "10
  kontroller" i stället för en enorm nolla. Ringarnas grundring är i
  accentfärg, inte grå — annars blev en poänglös patrull tio bleka cirklar.
  `shareData()` anropar `patrolHighlights` UTAN start/slut: kortet äger
  tidsraden själv via kryssrutan, annars stod den två gånger.
  Kortet följer inte nattläget — en delad bild ska se likadan ut oavsett hur
  telefonen stod inställd.
  Layouten MÄTS innan den ritas (`stapla()`): block med känd höjd staplas,
  kapas och centreras. Ett fast y per block såg rätt ut i ett format och
  ritade över etiketten i nästa; kapningen växer dessutom tillbaka när något
  annat krympt, annars stod en liten ring mitt i ett halvtomt kort.
  Textfärgen mot avdelningsfärgen väljs som *bäst av vit och svart*, inte mot
  en 4,5-gräns — äventyrarorange (#E95F13) klarar ingen av dem, och all text
  på kortet är stor (WCAG-kravet är då 3:1). Regressionstestat per
  avdelningsfärg i `test/logic.test.js`.
- `.../stations/{stationId}/passages/{patrolId}` — start/finish check-outs
  (`startAt`/`finishAt` timestamps), doc id IS the patrolId. Anonymous clients
  may only touch `patrolId`/`startAt`/`finishAt` (affectedKeys guard); station
  `list` requires membership so secret ids can't be enumerated (except demo
  competitions, where the account-free demo mode shows the station card and
  check-ins are blocked anyway). The "Läget"
  dashboard derives queue pressure per control from these + score `reportedAt`
  order, assuming patrols run the course in control-number order.

Anonymous score writes only when the enclosing control has `open == true`.

## Bootstrapping super-admin

The super-admin email is configured as `SUPER_ADMIN_EMAIL` in
`public/js/store.js` and MUST match the literal in `firestore.rules`.
`store.ensureUser()` creates that user with `role: "super-admin"` on
first sign-in. Other users get `role: "user"`.

## Things to avoid

- Don't add a framework (React/Vue/Next). This project is intentionally
  plain ES modules.
- Don't write to Firestore from the reporter page in ways that require auth —
  the page is fully anonymous.
- Don't bake Firebase client config into JS. Prod uses
  `/__/firebase/init.json` (auto-provisioned); local dev uses
  `public/firebase-config.json` (gitignored).
- Cloud Functions (`functions/`) exist ONLY for transactional mail: they react
  to registration/utskick/control documents and queue mail docs in the `mail` collection,
  which the Trigger Email extension (Brevo SMTP) delivers. Two callables exist
  on top: `requestLoginLink` (branded magic-link login mail) and
  `resendManageLink` (self-service re-send of a registration's manage link —
  ALWAYS answers a neutral ok so registrations can't be enumerated; throttled
  per address via `resendRequests/{email}` and the global `caps/` mail lanes).
  A third callable, `deleteMyAccount`, does GDPR account erasure: it MUST be
  server-side because a user may neither delete their own `users/{uid}` doc
  nor edit competitions they only belong to, and ansvariga lists are
  append-only. Called with no args it is a DRY RUN returning where the account
  appears (that is what the confirm modal renders); with `confirm: true` it
  strips the email from every access doc, control meta, `management` (PII
  blanked, role kept) and the uid from `admins`, deletes the user's
  competitionRequests, the users doc and the Auth account. Sole admin of a
  competition must supply a replacement admin per competition, and the last
  super-admin is refused outright.
  Never add rules matches for `/mail/**`, `/caps/**`, `/loginRequests/**` or
  `/resendRequests/**` — only the admin SDK may touch them. Keep all
  other logic client-side + rules. Functions deploy manually:
  `npx firebase-tools deploy --only functions` (not part of CI).
- In firestore.rules, always read optional competition fields with
  `.get('field', default)` — reading a missing property is an evaluation
  ERROR that silently denies anonymous writes (this broke score reporting on
  competitions without the `demo` field).

## Running locally

```
firebase emulators:start
```

Emulator UI at http://127.0.0.1:4000. Hosting at http://127.0.0.1:5000.

## Tests

```
scripts/test.sh          # allt (kräver igång-varande emulator)
scripts/test.sh logic     # ren logik — ingen emulator behövs
scripts/test.sh rules     # bara säkerhetsreglerna
```

Node's built-in runner, ZERO dependencies — no package.json, no framework, in
keeping with the no-build-step rule. `test/logic.test.js` imports the ES
modules directly (ETA engine, start-time anchoring, slug/reference rules).
`test/rules.test.js` drives the Firestore emulator's REST API with self-minted
unsigned JWTs (`test/helpers.js`), which is how every identity — anonymous,
user, super-admin — can be exercised against the real rules file.

RUN THE RULES SUITE AFTER EVERY `firestore.rules` EDIT. Rules fail silently
and in production: the `.get('field', default)` trap (reading a missing
property is an evaluation ERROR that denies the write) has shipped twice, once
killing all score reporting and once all competition creation. Both are now
regression-tested — verified by mutation, i.e. re-introducing each bug makes a
test fail.
