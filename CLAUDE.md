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

## Directory map

See `README.md` for the layout — every file there is load-bearing.

## Entry points

- `public/index.html` — admin SPA. All `/app/*` routes served via
  hosting rewrites to `/index.html`.
- `public/k.html` — reporter page. All `/k/*` routes rewritten to
  `/k.html`.
- `public/m.html` — start/finish station (`/m/<cid>/<stationId>`), anonymous
  like the reporter page; the station id is the secret.

## Firestore rules model

- `users/{uid}` — a user's own doc.
- `competitions/{cid}` — meta. Permissions are EMAIL-based (checked against
  the verified `request.auth.token.email`, always lowercase): `adminEmails[]`,
  `userEmails[]` (flat mirror of `users: [{email, name}]` — write both via
  store.setCompetitionUsers). Legacy uid `admins[]` still honored. Controls
  carry `ansvariga: [{email, name}]` + flat `ansvarigaEmails[]`; ansvariga may
  update their control but never the ansvariga fields themselves. A `closed`
  competition is read-only for everyone but admins, and closing wipes
  users + ansvariga + each control's `telefon` (GDPR cleanup) — admins remain.
- `.../patrols/{pid}` — publicly readable (for the reporter page).
- `.../controls/{ctrlId}` — publicly readable; writable by competition admins.
- `.../controls/{ctrlId}/scores/{patrolId}` — one doc per patrol×control; the
  doc id IS the patrolId so re-reporting overwrites. May carry
  `utslagGissning` (the patrol's tiebreaker guess) when the control has
  `utslag: true` + `utslagFraga`/`utslagSvar`; ranking uses it only once
  `utslagSvar` is set. Beware `Number(null) === 0` — use utils.isNumSet.
- `.../track/main` — the drawn course ("Spår" tab): waypoints per leg keyed
  `<fromKey>__<toKey>` plus `speedKmh`. The leg sequence itself is derived
  from control number order at render time, never stored. Publicly readable
  (controls already expose all positions); admin-only writes.
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
  to registration documents and queue mail docs in the `mail` collection,
  which the Trigger Email extension (Brevo SMTP) delivers. Never add a rules
  match for `/mail/**` — clients must not be able to write mail docs. Keep all
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
