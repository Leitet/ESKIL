# ESKIL — Notes for AI assistants

## What this is

ESKIL is a scout competition admin system. It is built **static** — no build
step, no bundler. All JS is ES modules served from `public/`, Firebase SDK
loaded from CDN. Runs on Firebase Spark (free) plan.

## Architectural invariants

- **No build step.** Don't introduce one. If you need a dependency, load it
  from a CDN (see `public/js/pdf.js` for the pattern).
- **UI is Swedish.** All user-facing strings must be in Swedish. Code,
  comments, identifiers stay English where it reads naturally.
- **The control ID is the secret.** `/k/<cid>/<ctrlId>` is the reporter URL.
  Firestore rules allow anonymous score writes only when the control document
  has `open == true`.
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

## Firestore rules model

- `users/{uid}` — a user's own doc.
- `competitions/{cid}` — meta. `admins[]` and `users[]` arrays of uids.
- `.../patrols/{pid}` — publicly readable (for the reporter page).
- `.../controls/{ctrlId}` — publicly readable; writable by competition admins.
- `.../controls/{ctrlId}/scores/{patrolId}` — one doc per patrol×control; the
  doc id IS the patrolId so re-reporting overwrites.

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
- Don't introduce Cloud Functions without a clear plan — this breaks the
  free-plan constraint.

## Running locally

```
firebase emulators:start
```

Emulator UI at http://127.0.0.1:4000. Hosting at http://127.0.0.1:5000.
