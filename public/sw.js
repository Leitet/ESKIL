// ESKIL service worker — offline hardening for the field pages.
//
// The reporter page (/k/…), startkort (/s/…) and start/mål-station (/m/…)
// must be OPENABLE with no network at all: a kontrollant who loses the tab in
// the woods can reopen the link and keep reporting (the offline queue and
// Firestore's persistent IndexedDB cache handle the data side).
//
// Strategy:
//   • navigations to /k, /s, /m  → network-first, cache fallback (per shell)
//   • same-origin static assets (/js, /assets, *.html) and the CDN libs
//     (gstatic Firebase, jsdelivr, unpkg, OSM/Esri tiles are NOT cached)
//     → stale-while-revalidate
//   • everything else (Firestore, auth, functions, tiles) → untouched
//
// Bump VERSION whenever cached-asset behavior must be reset.

const VERSION = 'eskil-sw-v3';
const RUNTIME = `${VERSION}-runtime`;

const FIELD_SHELLS = { '/k/': '/k.html', '/s/': '/s.html', '/m/': '/m.html' };

const PRECACHE_URLS = [
  '/k.html', '/s.html', '/m.html',
  '/assets/tokens.css', '/assets/report.css', '/assets/station.css',
  '/js/mode-boot.js', '/js/sw-register.js'
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

async function staleWhileRevalidate(request) {
  const cache = await caches.open(RUNTIME);
  const cached = await cache.match(request);
  const refresh = fetch(request)
    .then(resp => {
      if (resp && resp.ok) cache.put(request, resp.clone());
      return resp;
    })
    .catch(() => null);
  return cached || refresh.then(r => r || Response.error());
}

async function navigateFieldPage(request, shell) {
  const cache = await caches.open(RUNTIME);
  try {
    const resp = await fetch(request);
    if (resp && resp.ok) cache.put(shell, resp.clone());
    return resp;
  } catch {
    const cached = await cache.match(shell);
    return cached || Response.error();
  }
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
    event.respondWith(staleWhileRevalidate(req));
  }
});
