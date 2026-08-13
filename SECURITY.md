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

## Manuella konsolsteg som återstår (kräver Firebase/GCP-konsolen)

Dessa kan inte göras från koden och är den **egentliga** fixen för de
oautentiserade skriv-/kvot-vektorerna (kodnivå-taken ovan är bara en broms):

1. **Firebase App Check** (reCAPTCHA Enterprise/v3): aktivera och *enforce*
   på **Firestore** och **Cloud Functions**. Detta stoppar skriptade
   anonyma skrivningar (anmälnings-spam, poäng-DoS) och skyddar callable
   `requestLoginLink`. OBS: testa noga i staging först — felkonfigurerad
   App Check blockerar de anonyma fältsidorna (/k, /s, /m, /a).
2. **Brevo:** sätt ett larm på onormal mailvolym (kompletterar dagskvoterna
   i functions).
3. **GCP Budget & Alerts** på projektet + överväg en spend-cap, som skydd
   mot kostnads-DoS via obegränsade anonyma läsningar.

## Planerad uppföljning — kräver övervakad driftsättning

Följande är **medvetet inte driftsatt autonomt** eftersom de rör
autentiseringens läsväg, mail-triggers och backup/restore samtidigt, med
fellägen (admin-utelåsning, trasig mail, dataförlust) som bör verifieras med
en människa närvarande vid prod-cutovern. Super-admin (konfigurerad e-post)
kan aldrig låsas ute — status kommer från `users/{uid}.role`, opåverkat av
nedan — så blast radius vid ett fel är begränsad till enskilda
tävlingsadministratörer tills super-admin rättar.

Detta är samma klass av "UI-nivå-skydd vs regel-nivå-skydd" som redan är känd
och accepterad för `publicScores`/`publicControls`.

### Exponerad PII (världsläsbar i Firestore idag)

| Data | Var | Not |
|------|-----|-----|
| `adminEmails`, `userEmails`, `users[]` (namn) | `competitions/{cid}` | Alla tävlingars admin/användar-kontakter kan enumereras |
| `management` interna roller (namn/tel/e-post) | `competitions/{cid}` | Publika roller är avsiktligt publika; interna borde inte vara det |
| kontroll `telefon`, `ansvariga`, `ansvarigaEmails` | `controls/{ctrlId}` | Integritetspolicyn säger "telefon visas aldrig publikt" |
| patrull `notering` (intern) | `patrols/{pid}` | Internt admin-fält |

### Föreslagen lösning

Flytta känsliga fält till medlemsskyddade subdokument:

- `competitions/{cid}/private/access` — `adminEmails`, `userEmails`, `admins`,
  full `management`. Läsning `if isCompMember`, skrivning `if isCompAdmin`.
  Publika doc:et får en denormaliserad `publicManagement` (bara publika
  roller) för /t-sidan och startkort.
- `controls/{ctrlId}/private/meta` — `telefon`, `ansvariga`,
  `ansvarigaEmails`, `notering`.
- `patrols/{pid}/private/meta` — `notering`.

Regel-helprarna `isCompAdmin`/`isCompMember`/kontrollansvarig-checken läser
`private/access`/`private/meta` i stället (med fallback till gamla platsen
under migreringen så inget låser sig). Berörda ställen som måste uppdateras
samtidigt: `utils.isCompAdminUser`, `store.setCompetitionUsers` /
`listCompetitionsForUser` / `createCompetition` / `copyCompetition`,
`backup.js` (dump/restore/delete måste inkludera subdokumenten — annars
dataförlust), `functions.managementEmails`, samt en engångsmigrering av
befintliga tävlingar. Testas uttömmande i emulatorn (admin skriver,
medlem läser, icke-medlem nekas, kontrollansvarig redigerar, super-admin,
landningssidans medlemsfilter, inloggning) före prod-cutover.
