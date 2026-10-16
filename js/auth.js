// Student and admin sign-in: Google accounts on the @snu.edu.in domain.
//
// The domain check here is for a clear message only. The real lock is in
// database.rules.json: without a verified @snu.edu.in email, the database
// returns nothing.

import { AUTH } from './config.js';

const DOMAIN_RE = new RegExp(`@${AUTH.domain.replace(/\./g, '\\.')}$`, 'i');

/** A verified Google account on the university domain. */
export function isSnuUser(user) {
  return Boolean(
    user && !user.isAnonymous && user.emailVerified && DOMAIN_RE.test(user.email ?? ''),
  );
}

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** Open Google sign-in. Popup in a browser tab, full-page redirect in an installed app. */
export async function signInWithSnu(fb) {
  const { A, auth } = fb;
  const provider = new A.GoogleAuthProvider();
  // `hd` makes Google show only university accounts; `prompt` lets people pick one.
  provider.setCustomParameters({ hd: AUTH.domain, prompt: 'select_account' });
  const resolver = A.browserPopupRedirectResolver; // loaded only for an actual sign-in
  if (standalone()) return A.signInWithRedirect(auth, provider, resolver);
  try {
    return await A.signInWithPopup(auth, provider, resolver);
  } catch (err) {
    if (
      err?.code === 'auth/popup-blocked' ||
      err?.code === 'auth/operation-not-supported-in-this-environment'
    ) {
      return A.signInWithRedirect(auth, provider, resolver);
    }
    throw err;
  }
}

/** Finish a sign-in that came back by full-page redirect (cheap when there was none). */
export function finishRedirect(fb) {
  return fb.A.getRedirectResult(fb.auth, fb.A.browserPopupRedirectResolver);
}

/**
 * Someone signed in with a non-SNU Google account. Remove that account again
 * (it was just created, so delete() is allowed) and sign out.
 */
export async function rejectAccount(fb, user) {
  try {
    await user.delete();
  } catch {
    await fb.A.signOut(fb.auth);
  }
}

/** Short, plain-language messages for sign-in errors. Empty string = say nothing. */
export function signInErrorText(err) {
  switch (err?.code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return '';
    case 'auth/network-request-failed':
      return 'No connection. Check your internet and try again.';
    case 'auth/too-many-requests':
      // Firebase allows 100 new accounts per hour per IP. On campus Wi-Fi,
      // many students share one IP, so this can happen on launch day.
      return 'Too many sign-ins from this network right now. Wait a few minutes, or use mobile data.';
    case 'auth/unauthorized-domain':
      return 'This web address is not allowed to sign in yet. (Admin: add it under Firebase Authentication → Settings → Authorized domains.)';
    case 'auth/web-storage-unsupported':
      return 'Your browser blocks storage for this site. Allow cookies and site data, then try again.';
    default:
      return 'Sign-in did not work. Please try again.';
  }
}
