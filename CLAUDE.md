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
