// Loads the Firebase SDK (Auth + Realtime Database) only when it is needed.
// The map and the demo work without it, so first paint stays fast.
//
// Plain web APIs only: Google sign-in is standard web OAuth in the browser,
// and the database uses a WebSocket. Nothing needs Google Play Services, so
// GrapheneOS, LineageOS and CalyxOS phones work.

import { FIREBASE_CONFIG } from './firebase-config.js';

/** Firebase JS SDK (ES modules). The service worker caches these files too. */
export const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

/** Local emulator mode: only on localhost, and only with ?emulator=1 in the URL. */
const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
export const USE_EMULATOR = isLocalhost && new URLSearchParams(location.search).has('emulator');

const EMULATOR_CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'localhost',
  projectId: 'demo-snu-caddy',
  // `firebase emulators:start` loads database.rules.json into this namespace.
  databaseURL: 'http://127.0.0.1:9000/?ns=demo-snu-caddy-default-rtdb',
  appId: 'demo-app',
};

/** True when there is a Firebase project (or the local emulator) to talk to. */
export const FIREBASE_ON = USE_EMULATOR || FIREBASE_CONFIG !== null;

let loading = null;
let failed = false;

/**
 * True after the SDK failed to DOWNLOAD (no network). Browsers remember a
 * failed module import for the rest of the page's life, so only a page reload
 * can retry. False for a setup error (bad config): loadFirebase() rejects too.
 */
export const firebaseLoadFailed = () => failed;

/**
 * @returns {Promise<{ auth: any, db: any, A: any, D: any }>}
 *   `A` = firebase/auth functions, `D` = firebase/database functions.
 */
export function loadFirebase() {
  if (!FIREBASE_ON) return Promise.reject(new Error('Firebase is not configured'));
  loading ??= (async () => {
    const [appSdk, A, D] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-auth.js`),
      import(`${SDK}/firebase-database.js`),
    ]).catch((err) => {
      failed = true; // See firebaseLoadFailed(): only a reload can retry.
      throw err;
    });
    // From here on, an error is a setup problem (for example a bad value in
    // js/firebase-config.js), not a missing network: firebaseLoadFailed() stays false.
    const app = appSdk.initializeApp(USE_EMULATOR ? EMULATOR_CONFIG : FIREBASE_CONFIG);
    // The session is kept in IndexedDB: signed in until sign-out. No popup /
    // redirect helper here: on phones the default one loads Google scripts and
    // a hidden iframe on EVERY launch. auth.js passes it only to the sign-in calls.
    const auth = A.initializeAuth(app, {
      persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence],
    });
    const db = D.getDatabase(app);
    if (USE_EMULATOR) {
      A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      D.connectDatabaseEmulator(db, '127.0.0.1', 9000);
    }
    return { auth, db, A, D };
  })();
  return loading;
}

/** Resolve when the database connection is up; reject after `ms` (offline). */
export function waitConnected(fb, ms = 10_000) {
  // The student map closes the connection while live data is off (js/live.js).
  fb.D.goOnline(fb.db);
  return new Promise((resolve, reject) => {
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      reject(new Error('offline'));
    }, ms);
    off = fb.D.onValue(fb.D.ref(fb.db, '.info/connected'), (snap) => {
      if (snap.val() !== true) return;
      clearTimeout(timer);
      queueMicrotask(() => off());
      resolve();
    });
  });
}

/** Read a value once, also for local paths such as .info/serverTimeOffset. */
export function readOnce(fb, path) {
  return new Promise((resolve, reject) => {
    fb.D.onValue(fb.D.ref(fb.db, path), resolve, reject, { onlyOnce: true });
  });
}
