// Loads the Firebase SDK (Auth + Realtime Database) only when it is needed.
// The map and the demo work without it, so first paint stays fast.
//
// Plain web APIs only: Google sign-in is standard web OAuth in the browser,
// and the database uses a WebSocket. Nothing needs Google Play Services, so
// GrapheneOS, LineageOS and CalyxOS phones work.

import { FIREBASE_CONFIG } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

/** Local emulator mode: only on localhost, and only with ?emulator=1 in the URL. */
const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
export const USE_EMULATOR = isLocalhost && new URLSearchParams(location.search).has('emulator');

const EMULATOR_CONFIG = {
  apiKey: 'demo-key',
  authDomain: 'localhost',
  projectId: 'demo-snu-caddy',
  databaseURL: 'http://127.0.0.1:9000/?ns=demo-snu-caddy',
  appId: 'demo-app',
};

/** True when there is a Firebase project (or the local emulator) to talk to. */
export const FIREBASE_ON = USE_EMULATOR || FIREBASE_CONFIG !== null;

let loading = null;

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
    ]);
    const app = appSdk.initializeApp(USE_EMULATOR ? EMULATOR_CONFIG : FIREBASE_CONFIG);
    const auth = A.getAuth(app); // Session is kept in IndexedDB: signed in until sign-out.
    const db = D.getDatabase(app);
    if (USE_EMULATOR) {
      A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      D.connectDatabaseEmulator(db, '127.0.0.1', 9000);
    }
    return { auth, db, A, D };
  })().catch((err) => {
    loading = null; // Allow a retry (for example after a network drop).
    throw err;
  });
  return loading;
}

/** Read a value once, also for local paths such as .info/serverTimeOffset. */
export function readOnce(fb, path) {
  return new Promise((resolve, reject) => {
    fb.D.onValue(fb.D.ref(fb.db, path), resolve, reject, { onlyOnce: true });
  });
}
