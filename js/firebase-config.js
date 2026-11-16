// Firebase web app settings for the SNU Caddy project (snu-caddy-45q9r).
// Fetched from Firebase; to use another project, see docs/FIREBASE_SETUP.md, step 5.
//
// These values are NOT secret. Every Firebase web app sends them to the
// browser. The data is protected by database.rules.json, not by hiding this.

/** The app's own address (a custom domain on Firebase Hosting). '' = none. */
export const CUSTOM_DOMAIN = 'snu-caddy.abeermiglani.com';

const FIREBASE_DOMAIN = 'snu-caddy-45q9r.firebaseapp.com';

/**
 * Where Google sign-in runs (its /__/auth/handler page; Firebase Hosting
 * serves it on every address of the site). Sign-in must run on the address
 * the app was opened on: Safari, Firefox and newer Chrome block the storage
 * that a sign-in on another site needs, so the installed app's full-page
 * sign-in would fail. The two Firebase addresses use firebaseapp.com, which
 * Google allows by default; the custom address needs its handler URL listed
 * in the Google Cloud console (docs/LAUNCH_CHECKLIST.md).
 */
export function authDomainFor(hostname) {
  return CUSTOM_DOMAIN && hostname === CUSTOM_DOMAIN ? CUSTOM_DOMAIN : FIREBASE_DOMAIN;
}

// Set this to null to run without login (map + demo only).
export const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyCPU13ASt1UbqBEKR_s86iuE6Sol4IHXMc',
  authDomain: authDomainFor(globalThis.location?.hostname),
  // Realtime Database in Singapore (asia-southeast1), the closest region to Greater Noida.
  databaseURL: 'https://snu-caddy-45q9r-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'snu-caddy-45q9r',
  appId: '1:144223591967:web:1e409cb16b851673de7f2a',
};
