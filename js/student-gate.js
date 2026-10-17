// Student access gate: SNU Google login first, then the campus geofence.
// Live caddy data runs only when ALL of these are true:
//   signed in with a verified @snu.edu.in account
//   AND the phone is on campus
//   AND the app is on screen
//   AND demo mode is off (the demo has its own fake data)
//   AND the student touched the app in the last few minutes (idle pause).

import {
  finishRedirect,
  isSnuUser,
  rejectAccount,
  signInErrorText,
  signInWithSnu,
} from './auth.js';
import { GEOFENCE } from './config.js';
import { firebaseLoadFailed, loadFirebase } from './firebase.js';
import { checkCampus, locationPermission } from './geofence.js';

const ASKED_KEY = 'snucaddy.locationAsked';

const CARDS = {
  checking: {
    title: 'Checking you are on campus…',
    text: 'This takes a few seconds.',
    action: 'Checking…', // stays on screen (disabled) so keyboard focus is kept
  },
  ask: {
    title: 'Caddies show only on campus',
    text: 'SNU Caddy uses your location only to check that you are on campus. It stays on this phone.',
    action: 'Allow location',
  },
  outside: {
    title: 'You are outside campus',
    text: 'Caddies show here when you are on campus.',
    action: 'Check again',
  },
  uncertain: {
    title: 'Could not confirm that you are on campus',
    text: 'Your location is not precise enough. Move to an open area and check again.',
    action: 'Check again',
  },
  denied: {
    title: 'Location is blocked',
    text: 'Caddies show only on campus, so SNU Caddy needs your location. It stays on this phone. Allow location for this site in your browser settings, then tap Try again.',
    action: 'Try again',
  },
  unavailable: {
    title: 'Could not find your location',
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
 *   login: HTMLElement, loginButton: HTMLButtonElement, loginTitle: HTMLElement,
 *   loginError: HTMLElement,
 *   card: HTMLElement, cardTitle: HTMLElement, cardText: HTMLElement, cardAction: HTMLButtonElement,
 *   listTitle: HTMLElement, list: HTMLElement,
 *   account: HTMLElement, accountEmail: HTMLElement, signOut: HTMLButtonElement,
 *   behindLogin: HTMLElement[],
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
  let paused = false;
  let live = false;
  let checking = false;
  let recheckTimer = 0;
  let loginShown = false;

  const signedIn = () => isSnuUser(user);

  function updateLive() {
    const on = !demo && !paused && !document.hidden && signedIn() && fence?.kind === 'inside';
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
    const had = document.activeElement;
    const loginWasOpen = !els.login.hidden;
    const panelWasReady = loginShown; // the sign-in button was on screen, not the splash
    const cardWasOpen = !els.card.hidden;
    // Until Firebase knows the session, the login screen is a plain splash (no flash of
    // the sign-in button for students who are already signed in).
    els.login.hidden = demo || (authKnown && signedIn());
    els.login.dataset.state = authKnown ? 'ready' : 'loading';
    // The sign-in screen is modal: the map and its controls behind it are inert
    // (not focusable, not read by screen readers).
    for (const el of els.behindLogin) el.inert = !els.login.hidden;
    const showsButton = !els.login.hidden && authKnown;
    // Focus goes to the title, not the button: screen readers start in the
    // panel, and a phone does not show a focus ring on a button nobody touched.
    if (showsButton && !loginShown) els.loginTitle.focus({ preventScroll: true });
    loginShown = showsButton;
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
      // aria-disabled, not disabled: disabling the focused button would drop focus.
      els.cardAction.setAttribute('aria-disabled', String(checking));
    }
    // A control that disappears takes the focus with it (to <body>). Put it on the
    // next thing to read: the location card when it shows, else the caddy list.
    // (Not on a normal load: the splash before it had nothing to focus.)
    const lostLogin =
      loginWasOpen &&
      els.login.hidden &&
      (els.login.contains(had) || (had === document.body && panelWasReady));
    const lostCard = cardWasOpen && els.card.hidden && els.card.contains(had);
    if (lostLogin || lostCard) {
      (els.card.hidden ? els.listTitle : els.cardTitle).focus({ preventScroll: true });
    } else if (
      !cardWasOpen &&
      !els.card.hidden &&
      (had === els.listTitle || els.list.contains(had))
    ) {
      // The card appeared where the reader is (the list title right after sign-in,
      // or a caddy row that the card now hides): move to the card, so it is read.
      els.cardTitle.focus({ preventScroll: true });
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
    let result;
    try {
      result = await checkCampus({ fresh: userAction });
    } finally {
      checking = false;
    }
    if (result.kind === 'inside' || result.kind === 'outside') remember(ASKED_KEY);
    fence = result;
    fenceAt = Date.now();
    render();
    scheduleRecheck();
  }

  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    // Idle pause: no GPS checks for a phone that nobody looks at.
    if (document.hidden || !signedIn() || demo || paused) return;
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
    if (signedIn() && !demo && !paused && Date.now() - fenceAt > GEOFENCE.recheckMs) checkFence();
    else scheduleRecheck();
    updateLive();
  });

  // --- Sign-in --------------------------------------------------------------------
  els.loginButton.addEventListener('click', async () => {
    // A failed SDK download is remembered by the browser until the page reloads.
    if (firebaseLoadFailed()) {
      location.reload();
      return;
    }
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
      showLoginError(
        firebaseLoadFailed()
          ? 'No connection. Check your internet, then tap Continue with Google.'
          : 'SNU Caddy has a setup problem. Please tell the SNU IT team.',
      );
      render();
      throw err;
    }
    // Finish a redirect sign-in (installed app) before reading the session.
    await finishRedirect(fb).catch((err) => showLoginError(signInErrorText(err)));
    fb.A.onAuthStateChanged(fb.auth, async (u) => {
      authKnown = true;
      if (u && !u.isAnonymous && !isSnuUser(u)) {
        showLoginError(
          `${u.email ?? 'That account'} cannot sign in here. Use your @snu.edu.in account.`,
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
    /** Idle pause (main.js): no touch for a few minutes stops live data. */
    setPaused(on) {
      if (paused === on) return;
      paused = on;
      if (on) clearTimeout(recheckTimer);
      else if (signedIn() && !demo && Date.now() - fenceAt > GEOFENCE.recheckMs) checkFence();
      else scheduleRecheck();
      updateLive();
    },
    get live() {
      return live;
    },
    /** True when live data would run if the app were not paused. */
    get ready() {
      return !demo && signedIn() && fence?.kind === 'inside';
    },
  };
}
