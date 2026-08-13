# Säkerhet — ESKIL

Sammanfattning av säkerhetsgranskningen (aug 2026) och dess åtgärder. Delas i
tre: **åtgärdat & driftsatt**, **manuella konsolsteg som återstår** och
**planerad uppföljning som kräver övervakad driftsättning**.

## Åtgärdat och driftsatt

- **Säkerhetsheaders (CSP, X-Frame-Options, nosniff, Referrer-Policy,
  Permissions-Policy)** i `firebase.json`. `script-src` är låst till self +
  gstatic/jsdelivr/unpkg/cdnjs; inga inline-script (läge-boot och
  SW-registrering ligger i `/js/mode-boot.js` respektive `/js/sw-register.js`).
  `frame-ancestors 'none'` skyddar mot clickjacking.
- **X-Robots-Tag noindex** på `/k`, `/s`, `/m`, `/a` (hemliga länkar
  indexeras aldrig).
- **Firestore-regler, fälthärdning:**
  - Scores: doc-id måste vara patrolId, poäng inom kontrollens `[min,max]`,
    typkontroll på create+update, `history` kan bara skrivas av admin
    (justeringsloggen kan inte förfalskas eller raderas anonymt).
  - Passages: patrolId == doc-id, tider måste vara `timestamp`.
  - Registrations: anonyma skrivningar begränsade till deltagarfält;
    betalstatus ligger i admin-only `paidRefs` (kan inte förfalskas).
  - Users: läsning begränsad till egen doc + super-admin.
  - Invites: admin-only.
- **Cloud Functions:** dagskvots-lås (`caps/{lane}`) på bekräftelse- och
  inloggningsmail, mottagartak på PM-utskick, `imported`-guard så
  backup-återställda anmälningar aldrig mailar sina gamla kontakter.
- **CSV-formelinjektion** neutraliserad i alla exporter.
- **Subresource Integrity (SRI)** på alla CDN-bibliotek; service workern
  cachar inte längre CDN-skript (opak cache krockar med SRI).
- **GDPR:** `closeCompetition` gallrar nu även tävlingsledningens
  personuppgifter i `management` (namn/telefon/e-post), utöver de tidigare
  fälten.

## Konsolsteg — ÅTGÄRDADE (App Check, budget)

De var den **egentliga** fixen för de oautentiserade skriv-/kvot-vektorerna
(kodnivå-taken är nu en andra försvarslinje bakom dem):

1. **Firebase App Check** (reCAPTCHA v3) — ✅ AKTIVERAD OCH FRAMTVINGAD på
   **Firestore** och **Cloud Functions** (2026-08-13). Webbappen "ESKIL webb"
   registrerad; klienten initierar App Check i `firebase.js` (prod-only,
   guardad på appId) och CSP:n släpper in `www.google.com`. Verifierat i prod
   efter framtvingande: publik sida, /k, /s, /m, /a och inloggningen
   (`requestLoginLink` loggar `app: VALID`) fungerar; overifierad trafik
   (bottar/direkta REST-anrop) blockeras. Site key är publik; secret key i
   Firebase-konsolen. Vid problem: App Check → APIs → un-enforce.
2. **GCP Budget & Alerts** — ✅ satt (2026-08-13), larm mot kostnads-DoS.
3. **Brevo:** dagsvolym övervakas i dashboarden; functions-dagskvoterna
   (`reserveMail`) är det primära skyddet.

## PII till medlemsskyddade subdokument — ÅTGÄRDAT (Fas 1–3)

Genomfört som en övervakad, staged migrering (Johan närvarande vid varje
prod-cutover). Super-admin kan aldrig låsas ute (status från `users/{uid}.role`),
och under migreringen läste reglerna en union av gammal + ny plats så inget
kunde bryta.

- **Fas 1** — kontroll `telefon`/`notering` och patrull `notering` flyttade till
  `controls/{id}/private/meta` respektive `patrols/{id}/private/meta`
  (medlem/kontrollansvarig läser). Kontrolltelefonen är nu genuint regel-skyddad,
  i linje med integritetspolicyn.
- **Fas 2** — ledningskontakter (management) är publika-som-default med en tydlig
  "Publik"-kryssruta per kontakt. De visas AVSIKTLIGT för besökare (/t) och
  funktionärer (/k, sekretariatskontakt) och förblir därför läsbara — beslut
  taget medvetet, inte en läcka.
- **Fas 3** — `adminEmails`/`userEmails`/`users` och kontrollernas
  `ansvariga`/`ansvarigaEmails` flyttade till `competitions/{cid}/private/access`
  respektive kontrollens `private/meta` (medlem läser, admin skriver; `admins`
  = uids stannar publikt, ej PII). Regel-helprarna läser de skyddade dokumenten;
  välkomstmailets trigger flyttad till `onControlMetaWritten` med en
  `welcomed`-lista så migreringen aldrig återmailar; backup/restore bevarar allt
  utan att läcka. Kontrollansvariga kan inte självescalera (regel-guard).

Verifierat med full behörighetsmatris i emulatorn (riktiga auth-tokens) och på
prod efter varje cutover.

Kvarstår som känt & accepterat (UI-nivå): `publicScores`/`publicControls` döljer
bara i UI:t — controls/scores är världsläsbara för de anonyma sidorna. Se
minnet `ui-level-privacy-debt`. Registreringars fritextsvar (ev. allergier)
skyddas av det hemliga `regId` + strikt Referrer-Policy (art. 9 — övervägs).
