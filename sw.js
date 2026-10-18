// SNU Caddy service worker: the app opens even in a campus dead zone, and a
// weak signal never stalls it for more than 4 s.
//
//  - Pages (same origin): NETWORK FIRST, so a new version is used at once.
//    The saved copy is used only when the network fails or is too slow; the
//    files of such a page then come from the same saved copy.
//  - Other app files: network first, the saved copy only when the network fails.
//  - Versioned libraries (Leaflet, Firebase SDK, QR tools): CACHE FIRST. Their
//    URLs contain the version, so a saved copy never goes out of date.
//  - Everything else is not touched: live caddy data, sign-in, map tiles and
//    Firebase's own /__/ pages always go to the network. Live data must never
//    come from a cache.

const CACHE = 'snu-caddy-v7'; // bump in every release that changes a SHELL file
const SLOW_MS = 4000; // weak signal: open the saved page after this long

/**
 * Pages (client ids) that opened from the saved copy. Their modules come from
 * the same copy, so one page never mixes an old and a new version after a
 * deploy. (The set is lost when the browser stops this worker; then a late,
 * lazy module of such a page comes from the network, which is still fine.)
 */
const savedPages = new Set();

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
    event.respondWith(req.mode === 'navigate' ? openPage(event, url) : appFile(event));
  } else if (LIB_PREFIXES.some((p) => req.url.startsWith(p))) {
    event.respondWith(cacheFirst(event));
  }
  // Anything else (tiles, database, sign-in): the browser handles it normally.
});

/** A page: the network, unless it fails or is slower than SLOW_MS and a saved copy exists. */
async function openPage(event, url) {
  const cache = await caches.open(CACHE);
  // One saved copy per page: ?demo=1, ?emulator=1 and #enroll= links share it.
  const key = url.origin + url.pathname;
  const fromNetwork = fetch(event.request).then((res) => {
    if (res.ok && res.type === 'basic') {
      event.waitUntil(cache.put(key, res.clone()).catch(() => {}));
    }
    return res;
  });
  event.waitUntil(
    fromNetwork.then(
      () => {},
      () => {},
    ),
  );
  const saved = async () => {
    const copy = await cache.match(key);
    if (copy) {
      savedPages.add(event.resultingClientId);
      forgetClosedPages();
    }
    return copy;
  };
  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(resolve, SLOW_MS);
  }).then(saved);
  try {
    // The network wins, unless it is slow and a saved copy exists.
    return await Promise.race([fromNetwork, slow.then((copy) => copy ?? fromNetwork)]);
  } catch (err) {
    const copy = await saved();
    if (copy) return copy;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A file of a page: from the saved copy for a saved page, else network first. */
async function appFile(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  if (savedPages.has(event.clientId)) {
    const copy = await cache.match(req);
    if (copy) return copy;
  }
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      // A failed save (for example storage full) must not fail a good answer.
      event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
    }
    return res;
  } catch (err) {
    const copy = await cache.match(req);
    if (copy) return copy;
    throw err;
  }
}

async function cacheFirst(event) {
  const req = event.request;
  const cache = await caches.open(CACHE);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  // Only real CORS answers: subresource integrity (SRI) must be able to check them.
  if (res.ok && res.type === 'cors') {
    event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
  }
  return res;
}

async function forgetClosedPages() {
  for (const id of savedPages) if (!(await self.clients.get(id))) savedPages.delete(id);
}
