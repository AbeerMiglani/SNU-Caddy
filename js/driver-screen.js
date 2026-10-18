// The OLED-black driver screen: GO, then "Online" (or "Charging"), then Go offline.
//
// Pure black, no map, little lit text. The phone needs no login: it is the
// anonymous account that the one-time QR setup linked to one caddy. An admin's
// "Unlink" reaches the phone within a second and stops the shift.

import { DRIVER, GEOFENCE, LIVE } from './config.js';
import { CAMPUS_POLYGON } from './data/campus.js';
import { CADDY_ID_RE, clearBinding, readBinding, saveBinding } from './driver.js';
import { createShift } from './driver-shift.js';
import { FIREBASE_ON, SDK, firebaseLoadFailed, loadFirebase } from './firebase.js';
import { distanceOutsideM } from './lib/polygon.js';
import { createWakeLock } from './lib/wake-lock.js';

const SHIFT_KEY = 'snucaddy.shift';
const DIM_AFTER_MS = 20_000;
const CONFIRM_OFF_MS = 4000;
/** A warning must last this long before it lights a dimmed screen (no flicker). */
const WARN_WAKE_MS = 10_000;
const RETRY_MS = 20_000;
/** No confirmed write for this long: warn the driver before students see "Signal lost". */
const STALE_MS = LIVE.signalLostMs - 30_000;
const NOT_LINKED = [
  'Not linked',
  'This phone is no longer linked. Ask an admin for a new setup code.',
];

const $ = (id) => document.getElementById(id);
const els = {
  root: $('driver'),
  net: $('driver-net'),
  label: $('driver-label'),
  name: $('driver-name'),
  status: $('driver-status'),
  head: $('driver-head'),
  detail: $('driver-detail'),
  meta: $('driver-meta'),
  go: $('driver-go'),
  charge: $('driver-charge'),
  off: $('driver-off'),
  retry: $('driver-retry'),
};

/** Everything the screen shows comes from here (see render()). */
const ui = {
  /** Message before the shift engine exists: [headline, detail, tone]. */
  boot: ['Checking link…', '', 'dim'],
  /** Connection note before the shift engine exists ('wait' | 'bad' | null = hidden). */
  bootNet: 'wait',
  /** Set when the phone lost its link: [headline, detail]. The screen shows only this. */
  unlinked: null,
  /** The saved shift was too old to continue (the app was closed for a long time). */
  pausedHint: false,
  /** @type {'on'|'off'|'lost'|'unsupported'} */
  wake: 'off',
  /** @type {import('./driver-shift.js').ShiftState | null} */
  shift: null,
};

let shift = null;
const leave = () => location.replace('./' + location.search);

// --- Boot and link check ------------------------------------------------------------
async function boot(link) {
  els.name.textContent = link.name || link.caddyId;
  render();

  // Ask again on every start: Chrome grants persistent storage once the app is
  // installed, so a phone installed after linking is protected from then on.
  navigator.storage
    ?.persisted?.()
    .then((yes) => yes || navigator.storage.persist())
    .catch(() => {});

  if (!window.isSecureContext || !('geolocation' in navigator)) {
    setBoot(
      [
        'No location',
        'This browser cannot share the location. Open the app in Chrome over https.',
        'error',
      ],
      null,
    );
    return;
  }

  let fb;
  try {
    fb = await loadFirebase();
  } catch {
    // A failed SDK download can only be retried by a reload: reload by itself
    // when the network comes back. The phone stays linked.
    if (!FIREBASE_ON) {
      setBoot(['Not set up', 'Firebase is not set up yet (docs/FIREBASE_SETUP.md).', 'warn'], null);
      return;
    }
    if (firebaseLoadFailed()) {
      setBoot(['No internet', 'This phone stays linked. It tries again by itself.', 'warn'], 'bad');
      retryWhenOnline(RETRY_MS);
    } else {
      // A setup error (for example a bad web config). Keep retrying slowly, so
      // the phone recovers by itself when the fixed app is published.
      setBoot(['Setup problem', 'Tell an admin. This phone stays linked.', 'error'], null);
      retryWhenOnline(60_000);
    }
    return;
  }

  await fb.auth.authStateReady(); // The saved session comes from IndexedDB (works offline).
  const user = fb.auth.currentUser;
  if (!user || !user.isAnonymous || user.uid !== link.uid) {
    await unlink(fb, NOT_LINKED);
    return;
  }

  const persist = {
    save: (v) =>
      store(() => localStorage.setItem(SHIFT_KEY, JSON.stringify({ ...v, caddyId: link.caddyId }))),
    clear: () => store(() => localStorage.removeItem(SHIFT_KEY)),
  };
  shift = createShift({
    store: caddyStore(fb, link.caddyId),
    geo: navigator.geolocation,
    wake: createWakeLock((w) => {
      ui.wake = w;
      render();
    }),
    onCampus: (lat, lng) => distanceOutsideM({ lat, lng }, CAMPUS_POLYGON) <= GEOFENCE.marginM,
    persist,
    onChange: (s) => {
      ui.shift = s;
      render();
    },
  });

  render(); // createShift() reported its first state before `shift` was set: enable GO now.

  // A reload (or a crash) during a shift continues it. GO also works offline:
  // the phone starts sharing as soon as it is online.
  const saved = readSavedShift(link.caddyId);
  if (saved && Date.now() - saved.aliveAt < DRIVER.resumeWithinMs) {
    shift.go({ since: saved.since, charging: saved.charging === true });
  } else if (saved) {
    // Android often discards an app that stays in the background: say why GO is back.
    ui.pausedHint = true;
    persist.clear();
    render();
    // No ghost caddy: if that shift's connection dropped before onDisconnect
    // was registered, the caddy would stay "online". (A missing or already
    // offline caddy makes this a no-op; the rules refuse it quietly.)
    fb.D.update(fb.D.ref(fb.db, `caddies/${link.caddyId}`), { online: false }).catch(() => {});
  }

  watchLink(fb, user, link);
}

/**
 * Live link check: an admin's "Unlink" deletes drivers/{uid}. While the phone
 * is offline nothing fires and the phone simply stays linked.
 */
function watchLink(fb, user, link) {
  let stopListening = null;
  stopListening = fb.D.onValue(
    fb.D.ref(fb.db, `drivers/${user.uid}`),
    async (snap) => {
      if (!snap.exists()) {
        await unlink(fb, ['Unlinked', 'An admin unlinked this phone.'], stopListening);
        return;
      }
      const { caddyId } = snap.val();
      if (!CADDY_ID_RE.test(caddyId)) {
        await unlink(fb, NOT_LINKED, stopListening);
        return;
      }
      const name = await fb.D.get(fb.D.ref(fb.db, `fleet/${caddyId}/name`))
        .then((s) => s.val() ?? caddyId)
        .catch(() => link.name || caddyId);
      if (ui.unlinked) return;
      if (caddyId !== link.caddyId) {
        // The local hint was out of date: start again with the server's caddy.
        shift?.dispose('revoked');
        saveBinding({ ...link, caddyId, name });
        location.reload();
        return;
      }
      if (name !== link.name) {
        link.name = name;
        saveBinding(link);
      }
      els.name.textContent = name;
    },
    // A cancelled listener means the permission is gone (for example, the
    // phone's account was deleted). Firebase does not retry it.
    () => unlink(fb, NOT_LINKED, stopListening),
  );
}

async function unlink(fb, message, stopListening = null) {
  if (ui.unlinked) return;
  ui.unlinked = message;
  // Stop the listener first: signing out would cancel it with an error.
  stopListening?.();
  shift?.dispose('revoked');
  clearBinding();
  store(() => localStorage.removeItem(SHIFT_KEY));
  render();
  await fb?.A.signOut(fb.auth).catch(() => {});
  setTimeout(leave, 2500);
}

/** The caddy's node in the database, in the shape the shift engine needs. */
function caddyStore(fb, caddyId) {
  const { D, db } = fb;
  const node = D.ref(db, `caddies/${caddyId}`);
  return {
    sendPosition: (f, { moved, charging }) =>
      D.update(node, {
        ...f,
        ...(moved ? { movedAt: D.serverTimestamp() } : {}),
        online: true,
        charging,
        lastUpdated: D.serverTimestamp(),
      }),
    setFields: (f) => D.update(node, f),
    armDisconnect: () => D.onDisconnect(node).update({ online: false }),
    cancelDisconnect: () => D.onDisconnect(node).cancel(),
    onConnection: (cb) => D.onValue(D.ref(db, '.info/connected'), (s) => cb(s.val() === true)),
  };
}

function readSavedShift(caddyId) {
  try {
    const v = JSON.parse(localStorage.getItem(SHIFT_KEY));
    return v && v.caddyId === caddyId && typeof v.aliveAt === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** localStorage can throw (storage full, blocked). The shift must go on anyway. */
function store(fn) {
  try {
    fn();
  } catch {
    /* only the resume-after-reload hint is lost */
  }
}

function setBoot(line, net) {
  ui.boot = line;
  ui.bootNet = net;
  render();
}

/**
 * The Firebase SDK did not download. A failed module import can only be
 * retried with a reload, but a reload without a network could show the
 * browser's offline page. So: first check that the SDK can be reached, then
 * reload. The "online" event alone is not enough (a phone with mobile data
 * but no real connection counts as online all the time).
 */
function retryWhenOnline(everyMs) {
  els.retry.hidden = false;
  const probe = async () => {
    if (document.visibilityState !== 'visible') return;
    try {
      await fetch(`${SDK}/firebase-app.js`, { method: 'HEAD', mode: 'no-cors', cache: 'no-store' });
      location.reload();
    } catch {
      /* still no connection */
    }
  };
  setInterval(probe, everyMs);
  window.addEventListener('online', probe);
}

// --- Controls -------------------------------------------------------------------
els.go.addEventListener('click', () => {
  if (!shift || ui.unlinked) return;
  buzz();
  ui.pausedHint = false;
  shift.go(); // in the tap itself: the wake lock and the location prompt need it
});

// Charging toggles: one tap on, one tap off (a real move also ends it).
els.charge.addEventListener('click', () => {
  if (!shift || ui.unlinked || ui.shift?.mode !== 'on') return;
  buzz();
  shift.setCharging(!ui.shift.charging);
});

els.retry.addEventListener('click', () => location.reload());

// Go offline needs two taps, so a brush against the phone cannot end the shift.
let offTimer = null;
els.off.addEventListener('click', () => {
  if (els.off.dataset.confirm !== 'true') {
    els.off.dataset.confirm = 'true';
    els.off.textContent = 'Tap again to go offline';
    clearTimeout(offTimer);
    offTimer = setTimeout(resetOff, CONFIRM_OFF_MS);
    return;
  }
  resetOff();
  buzz();
  shift?.stop('driver');
});

function resetOff() {
  clearTimeout(offTimer);
  els.off.dataset.confirm = 'false';
  els.off.textContent = 'Go offline';
}

function buzz() {
  navigator.vibrate?.(35); // a short tick confirms the tap without looking
}

// --- OLED care: dim when nobody touches the screen, and move the content a
// few pixels every minute, so hours of a still picture cannot burn in. --------
let dimTimer = null;
function wakeScreen() {
  els.root.classList.remove('is-dim');
  clearTimeout(dimTimer);
  if (ui.shift?.mode === 'on') {
    dimTimer = setTimeout(() => els.root.classList.add('is-dim'), DIM_AFTER_MS);
  }
}
document.addEventListener('pointerdown', wakeScreen, { passive: true });
document.addEventListener('keydown', wakeScreen);

setInterval(() => {
  const nudge = () => `${Math.round(Math.random() * 8 - 4)}px`;
  els.root.style.setProperty('--nudge-x', nudge());
  els.root.style.setProperty('--nudge-y', nudge());
}, 60_000);

// "Updated 4 s ago" and the shift time count up.
setInterval(() => {
  if (ui.shift?.mode === 'on' && document.visibilityState === 'visible') render();
}, 1000);

// --- Render -----------------------------------------------------------------------
let lastMode = null;

function render() {
  const s = ui.shift;
  const on = s?.mode === 'on' && !ui.unlinked;
  const mode = ui.unlinked ? 'unlinked' : on ? 'on' : shift ? 'idle' : 'boot';
  els.root.dataset.mode = mode;
  if (mode !== lastMode) {
    lastMode = mode;
    resetOff();
    wakeScreen();
  }

  els.label.textContent = on ? `On shift · ${since(s.since)}` : 'Driver phone';

  const [head, detail, tone] = statusLine(s);

  // Connection note, top right: only for a problem the headline does not say
  // already. "Online" / "Offline" in the headline mean seen / not seen by students.
  const net = !shift ? ui.bootNet : s?.connected ? null : 'bad';
  els.net.hidden = Boolean(ui.unlinked) || !net || head === 'No internet';
  if (net) {
    els.net.dataset.state = net;
    els.net.textContent = { wait: 'Connecting…', bad: 'No internet' }[net];
  }

  // role=status: change the text only when it changes, so it is said once.
  if (els.head.textContent !== head) els.head.textContent = head;
  if (els.detail.textContent !== detail) els.detail.textContent = detail;
  lightUpFor(tone);
  els.status.dataset.tone = tone;
  els.root.dataset.tone = tone;
  els.meta.textContent = metaLine(s, on);

  // GO and Go offline replace each other: keep keyboard / TalkBack focus on
  // the one that is now on screen.
  const had = document.activeElement;
  els.go.hidden = on || Boolean(ui.unlinked);
  els.go.disabled = !shift;
  els.off.hidden = !on;
  els.charge.hidden = !on;
  els.charge.setAttribute('aria-pressed', String(Boolean(on && s.charging)));
  if (shift || ui.unlinked) els.retry.hidden = true;
  if (had === els.go && els.go.hidden && !els.off.hidden) els.off.focus();
  else if ((had === els.off || had === els.charge) && !on && !els.go.hidden) els.go.focus();
}

/** A problem lights a dimmed screen again: an error at once, a warning after 10 s. */
let warnSince = null;
let warnShown = false;
function lightUpFor(tone) {
  if (tone === 'error' && els.status.dataset.tone !== 'error') wakeScreen();
  if (tone !== 'warn') {
    warnSince = null;
    warnShown = false;
    return;
  }
  warnSince ??= Date.now();
  if (!warnShown && Date.now() - warnSince >= WARN_WAKE_MS) {
    warnShown = true;
    wakeScreen();
  }
}

/**
 * What the screen says: a short headline (large, in the tone colour) and one
 * plain sentence below it.
 * @returns {[string, string, 'dim'|'ok'|'charging'|'warn'|'error']}
 */
function statusLine(s) {
  if (ui.unlinked) return [...ui.unlinked, 'error'];
  if (!s) return ui.boot;
  if (s.mode === 'idle') {
    if (s.ended === 'denied') {
      return [
        'Location is blocked',
        'Allow it for this app: Chrome ⋮ → Settings → Site settings → Location. Then tap GO.',
        'error',
      ];
    }
    if (s.ended === 'paused' || ui.pausedHint) {
      return [
        'Shift ended',
        'The app was closed for over 10 minutes. Tap GO to start again.',
        'warn',
      ];
    }
    if (s.ended === 'driver') return ['Offline', 'Students no longer see this caddy.', 'dim'];
    return ['Offline', 'Tap GO to start your shift.', 'dim'];
  }
  if (s.refused) return ['Updates refused', 'Ask an admin to check this caddy.', 'error'];
  if (s.gps === 'outside') return ['Outside campus', 'Your location is not shared.', 'warn'];
  if (s.gps === 'unavailable') {
    return ['Location is off', 'Turn on Location in the phone settings.', 'error'];
  }
  if (s.gps === 'approximate') {
    return [
      'Location not precise',
      'Turn on “Precise location” for Chrome in the phone settings.',
      'error',
    ];
  }
  if (!s.connected) {
    return ['No internet', 'Your location is sent again when the signal is back.', 'warn'];
  }
  if (s.gps === 'waiting') {
    return Date.now() - s.gpsSince > DRIVER.gpsLostMs
      ? ['Still looking for GPS', 'Go to an open area.', 'warn']
      : ['Finding GPS…', 'This takes a few seconds.', 'dim'];
  }
  if (s.gps === 'lost') return ['No GPS signal', 'Go to an open area.', 'warn'];
  if (s.gps === 'weak') {
    // The error radius is in the meta line: the live status text stays still.
    return s.sentAt === null
      ? ['GPS is weak', 'Waiting for a better GPS signal.', 'warn']
      : ['GPS is weak', 'Students see your last good position.', 'warn'];
  }
  if (s.sentAt === null) {
    return ['Sending location…', 'Students see this caddy after the first update.', 'dim'];
  }
  // The connection looks up, but the server has not confirmed a write for a
  // while (a half-open connection in a weak-signal spot): say so before
  // students see "Signal lost".
  if (Date.now() - s.sentAt > STALE_MS) {
    return ['Not reaching the server', 'Your location is sent when the signal is back.', 'warn'];
  }
  if (s.charging) return ['Charging', 'Students see this caddy as charging.', 'charging'];
  return ['Online', 'Students can see this caddy.', 'ok'];
}

function metaLine(s, on) {
  if (ui.unlinked || !s) return '';
  if (!on) {
    return s.connected ? '' : 'You can start now. Sharing begins when the phone has internet.';
  }
  const parts = [];
  if (s.sentAt !== null) parts.push(`Updated ${ago(s.sentAt)}`);
  if (s.accuracy !== null && s.gps !== 'outside') parts.push(`GPS ±${s.accuracy} m`);
  if (ui.wake === 'lost') parts.push('Screen may turn off (battery saver)');
  if (ui.wake === 'unsupported') parts.push('Keep the screen on');
  return parts.join(' · ');
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now'; // the same words as the student list
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

function since(t) {
  const min = Math.floor((Date.now() - t) / 60_000);
  if (min < 1) return 'just started';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// Offline app shell (sw.js): the app opens in a dead zone, too. It is not
// needed for the first paint, so it registers after the page has loaded.
if ('serviceWorker' in navigator) {
  const register = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

// --- Start (last, so that everything above is defined) ---------------------------
const binding = readBinding();
if (!binding) {
  clearBinding(); // A broken binding would bounce between the two pages forever.
  leave();
} else {
  boot(binding);
}
