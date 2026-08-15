// ESKIL service worker — offline hardening for the field pages.
//
// The reporter page (/k/…), startkort (/s/…) and start/mål-station (/m/…)
// must be OPENABLE with no network at all: a kontrollant who loses the tab in
// the woods can reopen the link and keep reporting (the offline queue and
// Firestore's persistent IndexedDB cache handle the data side).
//
// Strategy:
//   • navigations to /k, /s, /m  → network-first, cache fallback (per shell)
//   • same-origin static assets (/js, /assets, *.html) → NETWORK-FIRST with
//     forced revalidation, cache fallback when offline/slow. The previous
//     stale-while-revalidate served the OLD module set on the first load
//     after every deploy — with several deploys the same day a phone could
//     run a MIXED module graph where an import was missing, and the page
//     died silently on the static "Laddar…" screen.
//   • everything else (Firestore, auth, functions, tiles, CDN) → untouched
//
// Bump VERSION whenever cached-asset behavior must be reset.

const VERSION = 'eskil-sw-v5';
const RUNTIME = `${VERSION}-runtime`;

const FIELD_SHELLS = { '/k/': '/k.html', '/s/': '/s.html', '/m/': '/m.html' };

const PRECACHE_URLS = [
  '/k.html', '/s.html', '/m.html',
  '/assets/tokens.css', '/assets/report.css', '/assets/start.css', '/assets/station.css',
  '/js/mode-boot.js', '/js/sw-register.js', '/js/field-watchdog.js'
];

// Cross-origin CDN scripts are deliberately NOT cached: caching them opaquely
// (without CORS) collides with Subresource Integrity — an opaque cached copy
// can't be integrity-verified and the browser refuses to run it. They always
// go to the network (with CORS), so SRI works. Offline field pages rely on
// the cached same-origin shell + modules + Firestore's own IndexedDB cache;
// map tiles and PDF generation need the network regardless.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(RUNTIME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function shellFor(pathname) {
  for (const [prefix, shell] of Object.entries(FIELD_SHELLS)) {
    if (pathname.startsWith(prefix)) return shell;
  }
  return null;
}

// Network-first with a deadline: fresh assets whenever the network answers
// (cache: 'no-cache' bypasses the 1h HTTP cache and revalidates via ETag —
// a 304 is cheap), the cached copy when offline or slower than the deadline.
// Every fetched response refreshes the cache for the next offline open.
const NETWORK_DEADLINE_MS = 4000;

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME);
  const fromNetwork = fetch(request, { cache: 'no-cache' })
    .then(resp => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    });
  const deadline = new Promise(resolve => setTimeout(() => resolve(null), NETWORK_DEADLINE_MS));
  const winner = await Promise.race([fromNetwork, deadline.then(async () => (await cache.match(request)) || fromNetwork)])
    .catch(async () => (await cache.match(request)) || null);
  if (winner) return winner;
  const cached = await cache.match(request);
  return cached || fromNetwork.catch(() => Response.error());
}

async function navigateFieldPage(request, shell) {
  const cache = await caches.open(RUNTIME);
  // Samma deadline-kapplöpning som networkFirst — utan den hängde en
  // fältsidenavigering på ett långsamt-men-levande skogsnät på webbläsarens
  // socket-timeout (tiotals sekunder) i stället för att öppna det precachade
  // skalet direkt. catch-grenen fångar bara ÄKTA offline (fetch rejectar);
  // det trögflytande fallet (fetch varken resolvar eller rejectar) klaras nu
  // av deadlinen. `no-cache` revaliderar via ETag så en deploy syns direkt.
  const fromNetwork = fetch(request, { cache: 'no-cache' })
    .then(resp => { if (resp && resp.ok) cache.put(shell, resp.clone()); return resp; });
  const deadline = new Promise(resolve => setTimeout(() => resolve(null), NETWORK_DEADLINE_MS));
  const winner = await Promise.race([
    fromNetwork,
    deadline.then(async () => (await cache.match(shell)) || fromNetwork)
  ]).catch(async () => (await cache.match(shell)) || null);
  if (winner) return winner;
  const cached = await cache.match(shell);
  return cached || fromNetwork.catch(() => Response.error());
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Field-page navigations: network first, cached shell offline.
  if (req.mode === 'navigate') {
    const shell = shellFor(url.pathname);
    if (shell && url.origin === self.location.origin) {
      event.respondWith(navigateFieldPage(req, shell));
    }
    return; // other navigations (admin SPA, public pages) untouched
  }

  // Only handle SAME-ORIGIN static assets. Cross-origin (CDN scripts, Firestore/
  // auth/functions, map tiles) is left entirely to the network.
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin) return;
  if (url.pathname.startsWith('/__/')) return; // firebase init/auth helpers

  const isStatic = url.pathname.startsWith('/js/')
    || url.pathname.startsWith('/assets/')
    || url.pathname.endsWith('.html')
    || url.pathname === '/firebase-config.json';
  if (isStatic) {
    event.respondWith(networkFirst(req));
  }
});

// Notisklick (meddelanden från tävlingsledningen): fokusera en öppen
// ESKIL-flik i stället för att öppna en ny — funktionären är redan inne på
// sin rapportsida/station och ska landa där banern och klockan finns.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Föredra en fältsida (/k, /s, /m) — det är där banern och klockan
      // finns; annars första öppna ESKIL-fönstret. Notiser skickas bara till
      // öppna sidor (ingen server-push ännu), så listan är sällan tom.
      const field = list.find((w) => /\/(k|s|m)\//.test(w.url) && 'focus' in w);
      const open = field || list.find((w) => 'focus' in w);
      return open ? open.focus() : self.clients.openWindow('/');
    })
  );
});
