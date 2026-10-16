// Student access gate: SNU Google login first, then the campus geofence.
// Live caddy data runs only when ALL of these are true:
//   signed in with a verified @snu.edu.in account
//   AND the phone is on campus
//   AND the app is on screen
//   AND demo mode is off (the demo has its own fake data).

import { isSnuUser, rejectAccount, signInErrorText, signInWithSnu } from './auth.js';
import { GEOFENCE } from './config.js';
import { loadFirebase } from './firebase.js';
import { checkCampus, locationPermission } from './geofence.js';

const ASKED_KEY = 'snucaddy.locationAsked';

const CARDS = {
  checking: {
    title: 'Checking you are on campus…',
    text: 'This takes a few seconds.',
  },
  ask: {
    title: 'Live caddies are for students on campus',
    text: 'SNU Caddy checks your location once to confirm that you are on campus. Your location stays on this phone.',
    action: 'Allow location',
  },
  outside: {
    title: 'You’re outside campus',
    text: 'Live tracking activates on campus grounds.',
    action: 'Check again',
  },
  uncertain: {
    title: 'We could not confirm you are on campus',
    text: 'Your location is not precise enough. Move to an open area and check again.',
    action: 'Check again',
  },
  denied: {
    title: 'Location is off for SNU Caddy',
    text: 'Live caddies show only on campus, so the app needs your location once. It stays on this phone. Allow location for this site in your browser settings, then try again.',
    action: 'Try again',
  },
  unavailable: {
    title: 'Can’t find your location',
    text: 'Turn on location (GPS) on your phone, then try again.',
    action: 'Try again',
  },
  unsupported: {
    title: 'Location is not available',
    text: 'This browser cannot share location. Try Chrome, Firefox or Safari.',
  },
  insecure: {
    title: 'Open the secure address',
    text: 'Location works only on the https:// address of SNU Caddy.',
  },
};

function remember(key) {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* not critical */
  }
}

function recall(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   login: HTMLElement, loginButton: HTMLButtonElement, loginError: HTMLElement,
 *   card: HTMLElement, cardTitle: HTMLElement, cardText: HTMLElement, cardAction: HTMLButtonElement,
 *   account: HTMLElement, accountEmail: HTMLElement, signOut: HTMLButtonElement,
 * }} els
 * @param {{
 *   onLive: (on: boolean, ctx: { fb: any, user: any }) => void,
 *   onChange?: () => void,
 * }} hooks
 */
export function createStudentGate(els, { onLive, onChange }) {
  let fb = null;
  let authKnown = false;
  let user = null;
  /** @type {{ kind: string, uncertain?: boolean } | null} */
  let fence = null;
  let fenceAt = 0;
  let demo = false;
  let live = false;
  let checking = false;
  let recheckTimer = 0;

  const signedIn = () => isSnuUser(user);

  function updateLive() {
    const on = !demo && !document.hidden && signedIn() && fence?.kind === 'inside';
    if (on === live) return;
    live = on;
    onLive(on, { fb, user });
  }

  function cardKey() {
    if (!fence || fence.kind === 'inside') return null;
    if (fence.kind === 'outside' && fence.uncertain) return 'uncertain';
    return fence.kind;
  }

  function render() {
    // Until Firebase knows the session, the login screen is a plain splash (no flash of
    // the sign-in button for students who are already signed in).
    els.login.hidden = demo || (authKnown && signedIn());
    els.login.dataset.state = authKnown ? 'ready' : 'loading';
    els.account.hidden = demo || !signedIn();
    if (signedIn()) els.accountEmail.textContent = user.email;

    const key = demo || !signedIn() ? null : cardKey();
    els.card.hidden = !key;
    if (key) {
      const card = CARDS[key];
      els.card.dataset.kind = key;
      els.cardTitle.textContent = card.title;
      els.cardText.textContent = card.text;
      els.cardAction.hidden = !card.action;
      els.cardAction.textContent = card.action ?? '';
      els.cardAction.disabled = checking;
    }
    updateLive();
    onChange?.();
  }

  function showLoginError(text) {
    els.loginError.textContent = text;
  }

  // --- Geofence ---------------------------------------------------------------
  async function checkFence({ userAction = false } = {}) {
    if (checking || !signedIn()) return;
    clearTimeout(recheckTimer);
    const permission = await locationPermission();
    // Explain first, then let the browser ask (a bare system prompt gets denied more often).
    if (!userAction && permission !== 'granted' && permission !== 'denied' && !recall(ASKED_KEY)) {
      fence = { kind: 'ask' };
      render();
      return;
    }
    checking = true;
    if (!fence || fence.kind !== 'inside') fence = { kind: 'checking' };
    render();
    const result = await checkCampus();
    checking = false;
    if (result.kind === 'inside' || result.kind === 'outside') remember(ASKED_KEY);
    fence = result;
    fenceAt = Date.now();
    render();
    scheduleRecheck();
  }

  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    if (document.hidden || !signedIn() || demo) return;
    if (fence?.kind === 'inside' || fence?.kind === 'outside') {
      recheckTimer = setTimeout(() => checkFence(), GEOFENCE.recheckMs);
    }
  }

  els.cardAction.addEventListener('click', () => checkFence({ userAction: true }));

  // Battery: no timers and no live data while the app is not on screen.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(recheckTimer);
      updateLive();
      return;
    }
    if (signedIn() && !demo && Date.now() - fenceAt > GEOFENCE.recheckMs) checkFence();
    else scheduleRecheck();
    updateLive();
  });

  // --- Sign-in --------------------------------------------------------------------
  els.loginButton.addEventListener('click', async () => {
    showLoginError('');
    els.loginButton.disabled = true;
    try {
      await signInWithSnu(fb ?? (await start()));
    } catch (err) {
      showLoginError(signInErrorText(err) || '');
    } finally {
      els.loginButton.disabled = false;
    }
  });

  els.signOut.addEventListener('click', () => fb && fb.A.signOut(fb.auth));

  /** Load Firebase and follow the session, once. Safe to call again after an offline start. */
  let starting = null;
  function start() {
    starting ??= follow().catch((err) => {
      starting = null;
      throw err;
    });
    return starting;
  }

  async function follow() {
    try {
      fb = await loadFirebase();
    } catch (err) {
      authKnown = true;
      showLoginError('Can’t reach SNU Caddy. Check your internet, then tap Continue.');
      render();
      throw err;
    }
    fb.A.getRedirectResult(fb.auth).catch((err) => showLoginError(signInErrorText(err)));
    fb.A.onAuthStateChanged(fb.auth, async (u) => {
      authKnown = true;
      if (u && !u.isAnonymous && !isSnuUser(u)) {
        showLoginError(
          `${u.email ?? 'That account'} is not an SNU account. Use your @snu.edu.in Google account.`,
        );
        await rejectAccount(fb, u);
        return;
      }
      user = u && !u.isAnonymous ? u : null;
      fence = null;
      fenceAt = 0;
      clearTimeout(recheckTimer);
      render();
      if (signedIn() && !demo) checkFence();
    });
    return fb;
  }

  start().catch(() => {});
  render();

  return {
    /** Demo mode hides the gate; turning it off restores the gate. */
    setDemo(on) {
      demo = on;
      if (!on && signedIn() && !fence) checkFence();
      else scheduleRecheck();
      render();
    },
    get live() {
      return live;
    },
  };
}
