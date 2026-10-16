// SNU Caddy service worker: the app opens even in a campus dead zone, and
// repeat visits load faster.
//
//  - App files (same origin): NETWORK FIRST, so a new version is used at once.
//    The saved copy is used only when the network fails or is too slow.
//  - Versioned libraries (Leaflet, Firebase SDK, QR tools): CACHE FIRST. Their
//    URLs contain the version, so a saved copy never goes out of date.
//  - Everything else is not touched: live caddy data, sign-in, map tiles and
//    Firebase's own /__/ pages always go to the network. Live data must never
//    come from a cache.

const CACHE = 'snu-caddy-v1';
const SLOW_MS = 4000; // weak signal: use the saved copy after this long

/** App shell. Keep in sync with the app's modules (tests/sw.test.mjs checks it). */
const SHELL = [
  './',
  'index.html',
  'driver.html',
  'manifest.webmanifest',
  'css/app.css',
  'css/driver.css',
  'assets/fonts/inter-latin-wght-normal.woff2',
  'assets/icon.svg',
  'assets/icon-192.png',
  'js/auth.js',
  'js/caddy-layer.js',
  'js/caddy-list.js',
  'js/caddy-state.js',
  'js/config.js',
  'js/data/campus.js',
  'js/data/demo-routes.js',
  'js/demo.js',
  'js/driver-screen.js',
  'js/driver-shift.js',
  'js/driver.js',
  'js/enroll-ui.js',
  'js/enroll.js',
  'js/firebase-config.js',
  'js/firebase.js',
  'js/geofence.js',
  'js/lib/five-taps.js',
  'js/lib/geo.js',
  'js/lib/ping-gate.js',
  'js/lib/polygon.js',
  'js/lib/wake-lock.js',
  'js/live.js',
  'js/main.js',
  'js/map.js',
  'js/sheet.js',
  'js/student-gate.js',
  'js/theme.js',
];

/** Versioned files from CDNs (the version is in the URL). */
const LIBS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js',
];
const LIB_PREFIXES = [
  'https://unpkg.com/leaflet@1.9.4/',
  'https://www.gstatic.com/firebasejs/12.19.0/',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/',
  'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // Libraries: best effort (a CDN that is down must not block the install).
      await Promise.all(LIBS.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/__/')) return; // Firebase sign-in pages and config
    event.respondWith(networkFirst(event, req));
  } else if (LIB_PREFIXES.some((p) => req.url.startsWith(p))) {
    event.respondWith(cacheFirst(req));
  }
  // Anything else (tiles, database, sign-in): the browser handles it normally.
});

async function networkFirst(event, req) {
  const cache = await caches.open(CACHE);
  const fromNetwork = fetch(req).then(async (res) => {
    if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
    return res;
  });
  // Keep the service worker alive until the saved copy is updated.
  event.waitUntil(fromNetwork.catch(() => {}));
  // The page URL may carry ?demo=1 or ?emulator=1: match the saved page without it.
  const saved = () => cache.match(req, { ignoreSearch: req.mode === 'navigate' });
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(async () => resolve(await saved()), SLOW_MS);
  });
  try {
    // The network wins, unless it is slow and a saved copy exists.
    const res = await Promise.race([fromNetwork, slow.then((s) => s ?? fromNetwork)]);
    return res;
  } catch {
    const copy = await saved();
    if (copy) return copy;
    throw new Error('offline and not saved');
  } finally {
    clearTimeout(timer);
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  // Only real CORS answers: subresource integrity (SRI) must be able to check them.
  if (res.ok && res.type === 'cors') await cache.put(req, res.clone());
  return res;
}
