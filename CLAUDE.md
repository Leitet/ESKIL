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
- **Logotypen är EN fil, aldrig symbol + handsatt text.** Låsningen i
  `public/assets/eskil_design_library/svg/eskil-logo-*.svg` bär symbolen,
  ordbilden ESKIL och taglinen "Där spåret börjar". Använd `-inverted` på blå
  ytor (`.pub-logo` i public.css, `.splash-logo` i app.css) och `-primary` på
  vita (`.brand-logo`, tävlingarnas topbar). Sätt ALDRIG ett eget
  `<span>ESKIL</span>` bredvid — då står namnet två gånger, och det gjorde det
  i sidhuvudet, båda sidfötterna och på /t innan låsningen ersatte dem.
  **Höjden får inte understiga ~48 px** där taglinen ska gå att läsa: den är
  98/418 av höjden, alltså 11 px vid 48 och 7,5 px vid 32. Topbaren kör 40 px
  och mobilen 32 — där är taglinen medvetet dekor, inte text man läser.
  Typsnittet ligger INBAKAT i SVG:n (Arimo, OFL, metriskt lika Arial). En SVG
  som visas via `<img>` når varken sidans CSS eller en webbfont, så utan
  inbakningen renderades ordbilden i vad enheten råkade ha och logotypen bytte
  form efter besökare. Detaljerna och de tre reglerna för att röra filerna
  står i bibliotekets `README.txt`. Ändras namnet eller taglinen måste
  teckendelmängden hämtas om — nya tecken finns inte i den.
- **Webbläsarikonen är en EGEN teckning** (`eskil-favicon.svg`), aldrig
  symbolen nedskalad: originalets bas är en ellips plus två streck som är
  6/240 av höjden, alltså 0,4 px vid 16 px, och nedskalad blir den grå gröt.
  Den har en platta i Scoutblå med liljan i vitt (12,38:1) — inte en
  temaväxlande mark, för Safari ignorerar `prefers-color-scheme` i favicons i
  ALLA versioner och en sådan mark hade visat sin kompromissfärg för varje
  Apple-användare. Lyftet till `#17456B` i mörkt läge är en förbättring ovanpå
  en fungerande grund, aldrig mekanismen. `eskil-appicon.svg` är hemskärmens
  variant: raka hörn, ingen media-fråga, större marginal. Alla sju HTML-filer
  länkar SVG först, `/favicon.ico` (16/32/48) som reserv för Safari före 16.4,
  och apple-touch-icon. Rör du geometrin: rendera i 16 px och titta på en
  pixelförstoring — en utjämnad uppskalning döljer precis det som går sönder.
  Skälen till varje val står i bibliotekets `README.txt`.
- **Sökmotorer och upptäckbarhet.** `public/robots.txt` och
  `public/sitemap.xml` är RIKTIGA filer (statiska filer serveras före
  rewrites). Förut svarade båda 200 med SPA:ns HTML, och eftersom den råa
  HTML:en inte innehåller ett enda `<a>` — navigationen byggs av JS — hade en
  robot som inte renderar noll URL:er att följa. Sitemapen ÄR alltså
  ersättningen för länkgrafen. **Lägg ALDRIG en Disallow för `/k`, `/s`, `/m`
  eller `/a` i robots.txt**: sökvägen är hemligheten och filen är offentlig, så
  raden publicerar precis det mönster den skulle skydda — de sidorna bär
  noindex i två lager i stället, vilket dessutom tar bort en sida ur indexet i
  stället för att bara hindra hämtning. Av samma skäl står ingen tävlingssida i
  sitemapen: de renderar inte för robotar (App Check) och bär patrullnamn.
  Regressionstestat, mutationsverifierat.
- **Catch-all-rewriten är BORTTAGEN.** `"**" → /index.html` gjorde varje
  påhittad adress till ett 200-svar med startsidans titel och description —
  obegränsat många indexerbara sidor. SPA:n har bara fyra toppsegment (`/`,
  `/om`, `/kontakt`, `/app`), så de har explicita rewrites och allt annat får
  ett ÄKTA 404 via `public/404.html`. **Priset: en ny rutt i app.js MÅSTE få en
  rad i firebase.json**, annars fungerar den lokalt i klientroutern men 404:ar
  i produktion. Ett test i `test/logic.test.js` läser `route()`-anropen och
  kontrollerar att var och en fångas — mutationsverifierat. `/` behöver ingen
  rewrite; den serveras som indexfil.
- **Metadatan per rutt bor i `public/js/seo.js`** (`setSeo` / `resetSeo`) —
  canonical, description, Open Graph och noindex. `ORIGIN` är HÅRDKODAD till
  `https://eskilscout.se` med flit: fyra värdnamn svarar 200 med identiskt
  innehåll (även `www.`, `eskil-scout.web.app` och `.firebaseapp.com`), Firebase
  kan inte omdirigera per värdnamn, och `location.origin` hade gjort varje
  dubblett självrefererande. `resetSeo()` anropas i app.js route-change-hook
  där titeln redan nollställs — `<head>` töms aldrig (layout() byter bara
  `<main>`), så utan den läcker en vys description och noindex till nästa sida.
  Robots-taggen märks `data-seo` och bara en märkt tagg tas bort igen; annars
  hade återställningen kunnat riva en STATISK noindex.
  **På /t byggs sökvägen ur `comp.slug || realCid`, aldrig ur
  `parsePath()`-segmentet** — kommer besökaren in via doc-id ska canonical och
  dela-länken ändå peka på kortadressen. Verifierat i emulatorn: in via
  `/t/alg2026`, ut med `https://eskilscout.se/t/ah26test`.
  **`index.html` har varken statisk canonical eller `og:url`**, och det är inte
  en glömska: filen levereras på `/`, `/om`, `/kontakt` OCH `/app/**`, så vilken
  sökväg en fast tagg än pekade på vore den fel för tre av dem. Förut var
  `og:url` låst till `/`, och den som delade `/kontakt` fick ett kort som utgav
  sig för att vara startsidan. `integritet.html` har dem statiskt — den har en
  enda adress.
- **`/t` kan aldrig indexeras, och det är avsiktligt.** App Check kräver en
  attesterad klient och reCAPTCHA v3 fullbordas aldrig i en automatiserad
  webbläsare, så sidan hänger på "Laddar tävling…" (mätt: 45 s ger två ord).
  Öppna INTE publika läsningar för oattesterade klienter för att fixa det.
  Det som ändå går är `t.html`:s STATISKA og-taggar: OG-skrapor i WhatsApp,
  Facebook och iMessage kör ingen JS och bryr sig inte om attestering, och /t
  är exakt den URL kårerna klistrar in i sina grupper. Den texten måste vara
  GENERISK — skalet delas av varje /t-URL, så en tävlingsspecifik text där vore
  både fel för de andra och en läcka.
- **Night mode** on the reporter page is a red palette. Don't swap it for a
  gray dark mode — preserving night vision is the requirement.
- **Banans delar heter STRÄCKA i all svensk text** — aldrig "ben". Ordet är en
  översättning av `leg`, och identifierarna (`courseLegs`, `legIn`, `legOut`,
  `track/main`-nycklarna) förblir engelska; det är prosan som är svensk.
  Obs genus: en sträcka, sträckan, två sträckor — "ett ben" blir "en sträcka",
  inte "ett sträcka". Där längden avses heter det längd eller avstånd, så att
  samma ord inte betyder två saker i samma mening.
- **The ETA engine lives in `public/js/course.js`.** `courseEta` (model:
  walking time + fixed stationstid), `courseEtaCalibrated` (the median of
  patrols' REAL leg times from score data replaces a leg's model estimate at
  ≥3 samples — queues get baked in automatically; demo competitions always
  run the pure model) and `patrolFinishEtaMs` (a patrol's finish estimate
  anchored in its latest report). Every ETA surface (/k, control PDF,
  station, startkort, /t, Läget) must go through these — never hand-roll an
  ETA in a view. Passage time is `clientReportedAt`, NOT `reportedAt` (see
  the scores bullet below).
- **De OFFICIELLA sidorna delar huvud via `public/js/publik-nav.js`** — start,
  Om ESKIL, kontakt och integritet. `publikHeader({aktiv, titel, ingress})` ger
  varumärke, meny, brödsmulor och rubrik; `publikFooter({extra})` sidfoten.
  Samma skäl som nav.js finns: förut nåddes sidorna bara via en rad i sidfoten
  och byggde var sitt huvud, så Integritet blev en återvändsgränd utan väg
  vidare. Integritet.html är STATISK (den ska gå att läsa utan att SPA:n
  startar) och injicerar huvudet via `js/integritet-nav.js` — en egen fil, för
  CSP:n tillåter inga inline-skript. `data-link` sätts bara på det routern kan
  rendera; /integritet ligger utanför den.
  **`.page` bor i tokens.css**, inte app.css. Integritet.html laddar inte
  app.css, och när sidbredden bodde där låg hjältens innehåll klistrat i
  vänsterkanten medan brödtexten var centrerad.
- **Navigation lives in `public/js/nav.js`.** Competition tab bar
  (`compTabs`), breadcrumbs (`crumbs`/`compCrumbs`) and browser-tab titles
  (`setDocTitle`) are shared — never hand-roll a `.tabs` bar in a view.
  **Tävlingssidor bygger HELA huvudet med `compHeader()`** — smulor, flikar och
  sidrubrik i ETT anrop. Ordningen är smulor → flikar → rubrik, och den är inte
  kosmetisk: förut låg smulorna inuti `page-head` med flikarna efter, och
  eftersom page-head varierar i höjd (Anmälan har underrubrik och två knappar,
  Spår bara en rubrik) hamnade flikraden på olika y och menyn hoppade när man
  bytte flik. Mätt efteråt: flikraden ligger på 145 px på samtliga tio flikar.
  **`layout()` ÅTERANVÄNDER topbar och sidfot** mellan vyer och byter bara
  `<main class="page">`. Förut tömdes hela `#app` vid varje vybyte och
  topbaren byggdes om inklusive logotypbilden — hela sidan blinkade fast bara
  innehållet ändrats. Topbaren byggs om bara när identiteten ändras (då ändras
  dess innehåll); `renderTopbar()` kopplar sina egna lyssnare, så
  återanvändningen kan aldrig dubbelkoppla dem. `#topbar-comp` töms vid varje
  layout — annars står föregående tävlings namn kvar på t.ex. kontosidan.
  Ingångsanimationen körs ENDAST när dokumentet är synligt: den börjar på
  opacitet 0, och webbläsaren fryser animationstidslinjen i en dold flik —
  navigerar man med fliken i bakgrunden fastnar sidan osynlig (mätt:
  playState "running", currentTime 0, opacitet 0). Vilotillståndet måste alltid
  vara synligt.
  Rubrik och underrubrik ESCAPAS (`title`/`subtitle`); de få sidor som bär
  badges skickar `titleHtml`/`subtitleHtml` och ansvarar då själva för
  escapningen. `compCrumbs` tar numera både `{ label }` och en ren sträng — en
  sträng gav förut `label: undefined`, vilket renderade en avslutande "›" med
  ingenting efter, helt tyst.
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
- `.../threads/{tid}/messages/{msgId}` — **samtal fält ↔ ledning**
  (`comp.fieldMessaging`, PÅ som standard, så regeln läser
  `.get('fieldMessaging', true)`).
  **Tråd-id:t finns i TVÅ former, och skillnaden ÄR säkerhetsmodellen.**
  Den HÄRLEDDA (`kontroll-<ctrlId>` / `patrull-<patrolId>`) antogs en gång vara
  hemlig — den är den inte: kontroller och patruller är världsläsbara och
  listbara, så id:t går att räkna fram. Med `allow get: if true` kunde vem som
  helst läsa fältets samtal, inklusive nödropens GPS-position och bilderna
  från skogen (reproducerat anonymt mot skarpa regler). TOKENformen är en
  slumpad sträng som ledningen mintar (`ensureThreadToken`) och som ligger i
  fältlänkens fjärde segment: `/k/<cid>/<ctrlId>/<token>`,
  `/s/<cid|slug>/<patrolId>/<token>`.
  **LÄSNING kräver token; SKRIVNING gör det aldrig.** Nödropet på startkortet
  har EN kanal, och tävlingssidan länkar publikt till startkorten — de flesta
  patruller står alltså utan token, och krävdes token för att skriva vore
  nödropet dött för dem. Samma sak för en kontroll med en äldre tryckt QR:
  den kan rapportera och nå ledningen, men ser inga svar (chat.js säger det
  rakt ut i stället för att se ut som att ledningen tiger).
  Fältet får bara SKAPA den härledda tråden — kunde det skapa valfritt id vore
  tokenformen värdelös. Tokentrådens huvud skapas av ledningen vid mintningen,
  och regeln kräver att huvudet finns innan fältet får skriva i den.
  Token bor i `controls/{id}/private/meta.threadToken` respektive
  `patrols/{id}/private/meta.threadToken`, är **klient-immutabel** (som
  `welcomed` — en kontrollansvarig som skrev om den hade dödat en tryckt QR
  tyst), och följer ALDRIG med i `dumpCompetition`: backupfilen mailas runt,
  och en token där vore en fungerande fältlänk in i ett pågående samtal.
  Mintningen är LAT och sker där länken byggs (control-detail, kontrollistan,
  utskriftscentralen, startskärmen, välkomstmailet) — kontroller och patruller
  skapas på fyra ställen till (årgångskopiering, backupimport, papperskorgen,
  massimport från anmälan), och en mint i `createControl` hade missat alla.
  Ledningens inkorg SLÅR IHOP en referens två trådar till ett samtal och
  svarar alltid i tokentråden; svarar man i den härledda kan fältet inte läsa
  det, hur ny länk kontrollanten än har.
  `list` är member-only så varken kontroll-id:n eller tokens kan räknas upp.
  Tre fällor som slog till när token infördes, alla mätta:
  1. **Nödropet måste kvittera EXPLICIT.** Koden lutade sig mot att "se sitt
     eget rop i tidslinjen ÄR kvittensen" — men utan token prenumererar bladet
     inte på tråden, så bladet stod tomt och patrullen trodde att ropet inte
     gick fram. Ropet HAR alltid gått fram; skrivning kräver aldrig token.
  2. **`renderWindow` i startscreen.js ligger på MODULNIVÅ** och ser inte
     `renderStartScreen`:s lokala variabler. En token-uppslagning som läste dem
     kastade ReferenceError före `.catch`-grenen — enda synliga effekten var en
     tom QR-ruta på storbildsskärmen på tävlingsmorgonen.
  3. **`onControlMetaWritten` lyssnar på SITT EGET dokument.** Skriver den
     token i en separat `set()` återtriggas den medan `welcomed` är ostämplad
     och välkomstmailet går ut TVÅ gånger. Token skrivs därför tillsammans med
     welcomed-stämpeln. Anonymt får `from` bara vara `'falt'` — ett falskt "från ledningen"
  skulle kunna få en kontrollant att göra fel på riktigt. Fältet får heller
  inte röra `ledningReadAt` (då kunde en inkommen fråga gömmas). Allt tre är
  mutationsverifierat.
  **Bilder ligger i meddelandet som data-URL**, inte i Cloud Storage:
  projektet har ingen bucket, och en bild från skogen kan visa scouters
  ansikten — i Firestore följer den tävlingens gallring. `public/js/photo.js`
  skalar ner till ≤ 400 000 tecken och reglerna vaktar samma tak; håll de två
  i synk. `closeCompetition` och `deleteCompetition` raderar trådarna HELT.
  **Meddelandet och trådhuvudet skrivs i SAMMA `writeBatch`.** Förut väntade
  koden ut `addDoc` innan huvudet skrevs — och offline resolvar den väntan
  aldrig. Stängde kontrollanten fliken innan täckningen kom tillbaka synkades
  meddelandet, men huvudet hade aldrig ens köats: frågan från skogen landade i
  en tråd ledningens inkorg inte kunde se. Av samma skäl har fältets
  skicka-knapp ett `withTimeout` — utan det stod den grå utan kvittens.
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
- **Systemnotiser går ALLTID via service workern** (`showSystemNotification`
  i broadcast.js, som äger notisplumbingen). Android Chrome KASTAR på
  `new Notification()` — där finns bara `registration.showNotification()`. /t:s
  favoritnotiser hade en egen konstruktor och nådde därför aldrig en enda
  förälder på Android; t.html laddar nu också `sw-register.js`, annars finns
  ingen registration att fråga. Notiser seedas dessutom på första SERVER-
  snapshoten (`snap.metadata.fromCache`), inte första snapshoten: den första
  kommer ur den lokala cachen och kan vara tom, och då levererades hela dagens
  avprickningar som "nya".
- **Fritext från fältet renderas med `linkifyText()`** (utils.js, testad), inte
  `escapeHtml()`. Nödropet bär en kartlänk till patrullens position, och i
  ledningens inkorg stod den som text man fick markera och klistra in för hand
  — precis när minuterna räknas. Escapningen görs styckvis så att `&` i URL:en
  inte förvanskas, och regexen tar bara http/https (aldrig `javascript:`).
  Behållaren måste ha `white-space: pre-wrap` — nödropet är tre rader.
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

- **P1-tilläggen (aug 2026, natt-listan):** `startklar.js` (rena förkontroller,
  visas på översikten), `sol.js` (NOAA-solnedgång för Lägets tidslinje/mörker-
  larm — teckenfelet +ha ger SOLUPPGÅNGEN, regressionstestat),
  `controls/{id}/beacon/status` (anonymt hjärtslag från /k var 5:e min:
  klient-tid/batteri/kö; läsning MEMBER-only, formen mutationsverifierad),
  hjälp-knappen på /s (GPS via befintlig fälttråd — ingen ny kanal),
  `confirmHardDelete` i utils (backup + namnbekräftelse före hård radering av
  tävling/kontroll), betalningsunderlags-PDF (aldrig den hemliga länken),
  patrullsök + wake lock på /k, favoritnotiser på /t (första snapshoten per
  kontroll seedas TYST — annars notisstorm vid sidladdning).
  **Nyp-zoom får inte blockeras** på fältsidorna (WCAG 1.4.4): dblclick-
  guarden får finnas (oavsiktlig zoom), men gesture*/multi-touch-blockare och
  user-scalable=no är borttagna med flit — återinför dem inte.
  **--r-accent-text** är accenten SOM TEXT (AA-kontrast i båda lägena);
  --r-accent är ytor/linjer. Nattens --r-fg-muted är beräknad till ≥4,5:1 —
  ögonmåtta inte om den.

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
  **`parsePath()` ger det RÅA segmentet — aldrig det upplösta id:t.** Nås en
  sida via kortadressen (`/s/ah26/<patrolId>` är NORMALVÄGEN från
  tävlingssidan) är segmentet slugen. Sidor som löser upp den måste hålla det
  upplösta id:t i EN variabel som skrivvägarna läser (`start.js` har `cid` på
  modulnivå); räknar en render-funktion om `parsePath().cid` skriver den på
  slugen. Verifierat i emulatorn: en sådan skrivning NEKAS inte — den skapar
  ett föräldralöst dokumentträd under en tävling som inte finns, och avsändaren
  får "skickat". Ett nödrop försvann så. Endast VISNINGSlänkar (`/t/<slug>`)
  ska använda det råa segmentet.

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

## Meddelanden till ESKIL (kontaktformuläret)

`/kontakt` är publik och öppen för vem som helst. Meddelandet skrivs INTE
direkt till Firestore — det går via den anropbara funktionen `sendFeedback`,
som stryper per adress (`feedbackRequests/{email}`, 1/min och 10/dygn) och mot
`caps/mail` innan admin-SDK:n skriver. Rules kan inte räkna anrop, och en
anonymt skrivbar toppnivåkollektion vore en öppen kran rakt in i databasen.
Lägg därför ALDRIG till en rules-match som tillåter klient-create på
`feedback/**` eller `feedbackRequests/**`.

**Id:t är hemligheten** även här: avsändaren får `/kontakt/<fbId>` i
svarsmailet och kan läsa tråden och svara i den, precis som anmälningarnas
ändringslänk. Därför är `get` öppen men `list` super-admin-only — `read`
täcker båda, och med `read: true` gick hela kollektionen att räkna upp
anonymt (fångat av ett test).

Regler kan inte dölja ENSKILDA FÄLT, så uppdelningen ÄR skyddet: trådhuvudet
och `messages/` innehåller bara sådant avsändaren själv skrivit plus svarens
text, medan allt internt — vilken super-admin som svarat (`authors`), som
hanterat, och om avsändaren var inloggad — ligger i `feedback/{id}/private/meta`,
som bara super-admin når. Lägg ALDRIG tillbaka en super-admins adress i ett
dokument som länken kan läsa; hela poängen med att svara i ESKIL är att den
adressen inte lämnar systemet.

Notismailet till super-admins bär meddelandet men har INGET Reply-To — svaret
skrivs i `/app/admin/feedback`, och `onFeedbackMessageCreated` mailar det till
avsändaren FRÅN ESKIL med länken till tråden. Samma funktion notifierar åt
andra hållet när avsändaren svarar. Ett **avslutat** ärende tar inte emot fler
meddelanden från länken: det stänger både tjatet och möjligheten att använda
en läckt länk för att mata ut notismail. Ett skickat meddelande går varken att
ändra eller radera — det ligger redan i någons inkorg. Alla sju guards är
mutationsverifierade i `test/rules.test.js`.

- **Genrepspatrullen (`patrols/{id}.genrep === true`) är en RIKTIG patrull.**
  Det är hela poängen: den går genom exakt samma kod, regler och vyer som en
  skarp, så ett genrep som fungerar bevisar något. `/s/<cid>/test` är något
  annat — en syntetisk förhandsvisning som inte finns i databasen och därför
  inte går att rapportera på.
  Priset är städningen: `rensaGenrep` sveper patrullen, dess poäng på VARJE
  kontroll, dess avprickningar på varje station, dess selfPassages och dess
  private/meta. Lägger du till ett ställe där en patrull kan lämna spår: lägg
  till det där också. Förkontrollen (`startklar.js`) varnar om en
  genrepspatrull ligger kvar — den skulle annars stå i resultatlistan och
  prisutdelningen.

## Väder, dagskopia och utskrifter (P2)

- **Sekretariatets logg (`.../logg/{id}`)** skrivs från ADMIN-VYERNA, aldrig
  inifrån store.js-mutationerna. Det är frestande att lägga anropet i t.ex.
  `deleteScore` så det aldrig glöms — men den anropas ANONYMT från
  rapportsidan, och en anonym klient kan inte skriva till en member-only logg;
  skrivningen hade kastat och tagit borttagningen med sig. `loggHandelse`
  sväljer dessutom fel: en logg som inte kunde skrivas får aldrig hindra det
  den skulle beskriva.
  `list` är member-only (loggen namnger patruller); `read` hade täckt både get
  och list och gjort kollektionen uppräkningsbar. Append-only via
  `allow update: if false` men med `delete` för admin — hade den varit
  `update, delete: if false` kunde varken closeCompetition eller
  deleteCompetition sopa den, och loggen överlevt tävlingen den handlar om.
  Båda mutationsverifierade. `closeCompetition` raderar den HELT (den bär
  funktionärernas adresser och namnger patruller), `deleteCompetition` sveper
  den med övriga subkollektioner.
  UI:t säger uttryckligen VILKA åtgärder som loggas — en logg man tror är
  komplett är värre än ingen, för då drar man slutsatser av det som inte står
  där.

- **`vader.js` använder Open-Meteo, inte SMHI.** SMHI:s `pmp3g` — som
  förbättringslistan pekade på — svarar 404 på varje sökväg inklusive API-roten
  (verifierat 2026-08-16). MET Norway kräver en identifierande User-Agent, som
  en webbläsare inte får sätta. Open-Meteo är nyckelfri och CORS-öppen; värden
  är vitlistad i `firebase.json` (connect-src). Anropet ber uttryckligen om
  **m/s** — standarden är km/h, och 44 km/h är en normal bris, inte halv storm.
  Svaret bär LOKAL tid utan zonsuffix när `timezone` anges. `hamtaVader`
  returnerar null vid ALLA fel och kortet uteblir då helt: en tävlingsdag får
  aldrig hänga på en utomstående tjänst. Prognosen hämtas EN gång per
  sidladdning, aldrig från `renderStats` (som kör var 30:e sekund).
- **`dagskopia.js` är INTE en backup** och får aldrig kallas så i UI:t. Den
  byggs ur de snapshots Läget redan har (noll extra läsningar) och saknar
  därför anmälningar, utskick, överlämningsdokument och kontrollernas telefon.
  Den stämplar ALDRIG `comp.lastBackupAt` — då skulle raderingsskyddet tro att
  en riktig backup finns. Nyckeln har MINUTupplösning: poängen droppar in en
  kontroll i taget och varje berikning sparar, så med sekundupplösning fylldes
  hela det rullande fönstret på nio sekunder. Kopian sparas först när
  `controls` finns — lyssnarna svarar i olika ordning och en kopia utan
  kontroller är oanvändbar.
- **Utskriftscentralen (`views/utskrifter.js`) genererar ingenting eget.** Varje
  knapp anropar samma funktion som den ursprungliga fliken, så det finns en
  implementation per dokument. Vyn bygger i ett eget element och lämnar över
  till `layout()` — skriver man rakt i `app.innerHTML` försvinner topbar,
  sidmarginaler och sidfot.
- **`confirmDialog(meddelande, { okLabel, danger })`** tar en STRÄNG först, inte
  ett optionsobjekt. Fel form ger "[object Object]" i dialogrutan.
  `.modal-body` har `white-space: pre-wrap` så citerad meddelandetext behåller
  sina radbrytningar.

## Komplettering per patrull (P3)

`.../kompletteringar/{token}` — kårledaren har anmälningslänken och kan ändra
ALLT i anmälan, så den kan hen inte skicka vidare till varje patrulledare.
Kompletteringen ger varje patrull en EGEN hemlighet: doc-id:t är en slumpad
token och `/a/<cid>/k/<token>` öppnar exakt den patrullens rad — inte anmälan,
inte de andra patrullerna, inte betalningarna.

**Dokumentet bär ALDRIG `regId`.** Doc-id:t är öppet läsbart, så ett regId där
hade gjort kompletteringslänken utbytbar mot hela anmälningslänken:
patrulledaren kunde läsa ut det ur svaret och öppna `/a/<cid>/<regId>` med läs-
OCH skrivrätt till kårens alla patruller, kontaktuppgifter och betalningar.
Kopplingen ligger i stället som `kompletteringar[{token, patrol}]` PÅ anmälan,
som bara den med anmälningslänken når. Mutationsverifierat.

**Ingen list-operation i klientvägen.** `list` är member-only och kårledaren är
ANONYM — ett `getDocs` här kastade permission-denied och tog hela funktionen
med sig, tyst. Läs per token ur anmälans egen lista (`kompletteringarForAnmalan`).
`read` hade dessutom täckt både get och list och gjort varje token — alltså
varje patrulls allergier — uppräkningsbar.
`regId` och `patrol` går inte att skriva om: kunde de det skulle
kompletteringen peka på fel anmälan eller döpas om till en patrull som inte
finns.

**Kårledaren skapar länkarna, inte admin** — hen är den som delar ut dem, och
hen är anonym. Create tillåter därför anonym skrivning, men bara av en TOM rad
(patrullnamn plus tomma fält) och utan regId. `deleteCompetition`,
`closeCompetition` och `deleteRegistration` måste alla svepa kollektionen.

**Testa anonyma sidor UTLOGGAD.** Första versionen av den här funktionen
"verifierades" i en flik där jag var inloggad som super-admin — då var
`isCompMember` sant och den list-operation som nekar en riktig kårledare gick
igenom. Funktionen var död i produktion och testet visade grönt.

## Papperskorgen FLYTTAR, den flaggar inte

`deletePatrol`/`deleteControl` gick förut rakt på `deleteDoc`. Nu flyttar
`flyttaTillPapperskorg` hela dokumentet plus dess poäng till
`.../papperskorg/{id}` och raderar originalet. Att FLYTTA i stället för att
sätta `deleted: true` är ett medvetet val:

1. **Ingen filtrering.** En flagga hade krävt `!deleted` på ~30 ställen som
   listar patruller och kontroller — köer, ETA, larm, PDF:er, exporten. En
   missad yta betyder att en "raderad" patrull dyker upp i en kö.
2. **Den hemliga länken dör direkt.** Kontrollens anonyma poängväg vaktas av
   `open == true`, inte av någon deleted-flagga: en flaggad kontroll hade
   fortsatt ta emot rapporter från sin QR-kod. Regressionstestat — en poäng
   till en kontroll som inte finns NEKAS.
3. **Ingen `.get()`-fälla.** En direktläsning av ett saknat `deleted` i
   reglerna är ett evalueringsfel som tyst nekar skrivningen.

Priset är att poängen bärs med i korgposten. Timestamps kan inte ligga nästlade
i en array — de blir tysta null — så de görs om till ISO-strängar och tillbaka
vid återställning (`toPlainish`). Rundturstestat: 10 poäng ut, 10 tillbaka,
tidsstämpeln bevarad.

Återställning skriver tillbaka med SAMMA doc-id: tryckta QR-koder och
startkortslänkar pekar på id:t. Korgen är admin-only (den bär namn, kår,
noteringar, telefonnummer) och töms av `closeCompetition` och
`deleteCompetition`. `deleteControl` sveper dessutom numera sina poäng — förut
lämnade den dem föräldralösa.

## Backup och radering hänger ihop

Raderingsskyddet KRÄVER en färsk backup, så backupen avgör vad som går att få
tillbaka — allt `deleteCompetition` sveper måste finnas i `dumpCompetition`.
BACKUP_VERSION 3 bär `selfPassages` och överlämningsdokumentet; importen
skriver tillbaka båda med samma doc-id (rundturstestat). `deleteCompetition`
sveper varje subkollektion appen skriver, inklusive tävlingens EGNA
`private/`-dokument — `private/access` bär adminEmails/userEmails/
ekonomiEmails, och personuppgift kvar efter "radera tävlingen" är precis det
raderingen ska göra slut på. Lägger du till en subkollektion: lägg till den på
BÅDA ställena.

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
  **`andringar[]`** är strukturerade ändringsförfrågningar efter stängd
  anmälan (sort + patrull + fritext), samma append-mönster som `forhinder`:
  läs om anmälan FÄRSKT före append, annars skriver en förlegad ögonblicksbild
  över ledningens hanterad-markering eller en ändring från en annan flik.
  Reglerna kan inte tvinga append-only på en array — courtesyn är
  klientsidig och det är ett medvetet val, inte en glömska.
  **`paidRefs` är FACIT, `paymentClaims` är PÅSTÅENDE.** Anmälaren (den som har
  länken) får skriva `paymentClaims` — "vi har betalat" — men aldrig `paidRefs`.
  Uppdelningen ÄR skyddet: `paidRefs` står medvetet inte i anmälarens
  hasOnly-lista, och lägger man dit den kan vem som helst med länken skriva sig
  betald. `isPaymentPaid()` är den enda sanningen för Betald; `isPaymentClaimed()`
  läggs bredvid, aldrig i stället. Reglerna läser fältet med `.get('paymentClaims', [])`
  — en direktläsning på en anmälan som saknar det (alla befintliga) hade tyst
  nekat HELA redigeringen. Alla tre mutationsverifierade.
  They are appointed via Tävlingsledning roles flagged `ekonomi: true` — the
  management save path syncs the mirror. A `closed`
  competition is read-only for everyone but admins, and closing wipes
  users + ansvariga + ekonomi + each control's `telefon` (GDPR cleanup) —
  admins remain.
- `.../patrols/{pid}` — publicly readable (for the reporter page). May carry
  `utgatt: {at}` (DNF, set/undone from Läget): excluded from queues, alarms and
  rest-lists everywhere; the flag remains as history.
  **Anteckningen ligger i `patrols/{pid}/private/meta.utgattNote`, ALDRIG på
  patrulldokumentet.** Dialogen lovar ordagrant att den "syns bara för
  ledningen", och patrols är världsläsbar — den som i god tro skrev "Elsa
  svimmade, hämtad med ambulans" publicerade en hälsouppgift om ett barn för
  hela internet. Läget läser den via `attachPatrolMeta` (member-only) och
  visar den i badgens `title`; `closeCompetition` nollar den i metan OCH i den
  gamla publika grenen (tävlingar skrivna före flytten).
- `.../controls/{ctrlId}` — publicly readable; writable by competition admins.
- `.../controls/{ctrlId}/scores/{patrolId}` — one doc per patrol×control; the
  doc id IS the patrolId so re-reporting overwrites. May carry
  `utslagGissning` (the patrol's tiebreaker guess) when the control has
  `utslag: true` + `utslagFraga`/`utslagSvar`; ranking uses it only once
  `utslagSvar` is set. Beware `Number(null) === 0` — use utils.isNumSet.
  **Anonym borttagning är TILLÅTEN** medan kontrollen är öppen (samma
  hemlighet som styr rapporteringen), utom på demo och utom när dokumentet bär
  admin-`history` — rättelsespåret får inte sopas bort anonymt. Utan den
  grenen var "Ta bort rapport" på /k död: online ett kryptiskt rättighetsfel,
  och OFFLINE tog Firestore bort dokumentet lokalt, sa "Borttagen" och rullade
  tillbaka det vid synk — poängen kom tillbaka utan att någon fick veta det.
  Båda vakterna är mutationsverifierade.
  Score docs carry BOTH `reportedAt` (serverTimestamp = sync moment, audit)
  and `clientReportedAt` (client time = when the button was pressed; the
  offline queue passes its queuedAt). Anything reasoning about WHEN a patrol
  passed (ETA engine, Läget) must prefer `clientReportedAt` — offline batch
  syncs make `reportedAt` lie by hours. adjustScore deliberately preserves
  the original times: a correction is not a passage.
  **Offline-kön (`offline-queue.js`)**: `flushQueue` läser om varje kö-post ur
  localStorage och matchar på `(patrolId, queuedAt)` PRECIS före sändning —
  ta inte bort det. Utan omläsningen kan en förlegad snapshot-post skickas
  EFTER en färsk direktsparning och (ovillkorlig setDoc) skriva över
  rättelsen; `syncInFlight` serialiserar bara flush mot flush, inte mot
  direktsparningen. Rapportsidans spara/offline/borttag-bekräftelse måste
  toasta EFTER `close()` (aldrig före): rtoast lämnar över till bladets
  notisrad så länge bladet är öppet, och den försvinner med bladet — en
  kontrollant i skogen får då ingen kvittens. Borttagning wrappas i
  `withTimeout` precis som spara (offline resolvar aldrig).
- `.../messages/{msgId}` — driftmeddelanden v2 (the Meddelanden tab):
  `{text, level: info|varning|kritisk, at, target: {kontroller, patruller},
  requireAck, active}`. Publicly readable (field pages are anonymous — the
  composer warns against personal data), admin-written.
  **`target.publikt` är en TREDJE mottagarkanal** — den publika anslagstavlan
  på /t. Uttryckligt opt-in i composern; "Alla" betyder alla i FÄLTET och
  sätter den aldrig (anhöriga är inte en mottagare man får på köpet).
  `publicNotices()` (utils.js, testad) filtrerar på `=== true`, ALDRIG
  `!== false`: ett fältmeddelande saknar fältet helt, och den slappa
  jämförelsen hade lagt det på en sida vem som helst kan läsa. Den VITLISTAR
  dessutom id/text/level/at i stället för att sprida dokumentet — `target` bär
  kontroll- och patrull-id:n, och ett id ÄR den hemliga länken. Båda
  mutationsverifierade. /t prenumererar på det UPPLÖSTA cid:t (se
  slug-bulleten) och anropar ALDRIG `updateBroadcast()` — bannerstacken är
  fältchrome, och dess `if (!t || !ctx) return true` skulle visa gamla
  mållösa meddelanden för anhöriga. Multiple messages
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
  `__mal`-noderna ur den, ETA räknar första och sista sträckan från dem och
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
  plats DELAR en sträcka — waypoints ritade på den gamla sträckan blir föräldralösa
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
- `.../controls/{ctrlId}/beacon/{enhetsId}` — **kontrollens livstecken**, EN
  doc per telefon (id:t slumpas till localStorage `eskil-enhet`). Delad
  `status`-doc gick inte: en kontroll bemannas ofta av två telefoner och den
  friska skrev över den döende, så Läget lyste grönt medan batteriet som
  faktiskt rapporterade gick mot noll. `mergeBeacons()` (utils.js, testad)
  slår ihop dem: senaste `at` vinner, men batteriet är det LÄGSTA bland
  enheter hörda senaste kvarten, och kön den största. `at` är klient-tid men
  TIDSBUNDEN i reglerna (−12 h…+2 min) — annars kunde den som har den hemliga
  länken skriva ett `at` långt fram och få kontrollen att se vaken ut för
  alltid. Skrivningen är strypt till 1/min (utan strypning: 200 väckningar ×
  30 kontroller ≈ 44 % av dygnskvoten bara för hjärtslag) och `pagehide`/
  `pageshow` är ett PAR — utan andra halvan dog intervallet vid första
  app-växlingen. I Läget är TYSTNAD dämpad, inte röd: en låst telefon är
  normalt, och en kolumn som är rosa för varje kontroll slutar man läsa.
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

## Demospåret är produktens skyltfönster

`scripts/seed-demo.sh` seedar tävlingen `demospar` (slug `demo`), som ligger i
produktion och nås KONTOFRITT: `guard()` i app.js installerar en
`DEMO_VIEWER` så fort routen bär ett cid vars tävling har `demo: true`.
Två regler styr allt arbete med den:

1. **Ingen yta får svara med ett rättighetsfel.** Reglerna nekar VARJE skrivning
   på en demotävling (poäng, fältmeddelanden, beacon, station, anmälan,
   selfPassages, genrep). Varje knapp som leder dit måste därför kortslutas i
   KLIENTEN med en demotext — mönstret finns i `report.js`, `station.js`,
   `chat.js` (`demo`-flaggan), `start.js` (nödknappen) och `utskrifter.js`
   (genrepskortet göms). Ett demo som svarar "PERMISSION_DENIED" är värre än
   inget demo.
2. **Läsning är däremot öppen, men BARA för demo.** Fem member-only ytor har en
   uttrycklig `compIsDemo(cid)`-gren i reglerna så att demot kan VISA dem:
   kontrollens `private/meta` (telefon + samtalsnyckel), `beacon`
   (livstecken), `threads` get/list, trådens `messages`, och `registrations`
   list. Grenarna hänger på flaggan, ALDRIG på ett tävlings-id, och varje gren
   har ett testpar i `test/rules.test.js`: demo får läsa, en riktig tävling
   nekas. Mutationsverifierat.

Seedad data måste ankras i MINUTER före seedögonblicket (`iso_min`), aldrig mot
ett fast datum — Läget pinnar sin demoklocka till senaste tidsstämpeln, så
ögonblicksbilden håller sig färsk för alltid. `comp.date` sätts till IDAG.
Två fältformer är ISO-STRÄNGAR och inte timestamps: `messages/{id}.at` och
`registrations/{id}.createdAt` (vyn kör `.localeCompare` på den senare) — ett
timestampValue ger "Invalid Date" respektive ett kraschat renderingsanrop.
Seeda ALDRIG `comp.lastBackupAt` (raderingsskyddet skulle tro att en backup
finns), aldrig en patrull med `genrep: true`, och aldrig `selfStart`/
`selfFinish` (knapparna renderas då men skrivningen nekas).

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
