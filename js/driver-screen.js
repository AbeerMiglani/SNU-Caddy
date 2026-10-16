// The OLED-black driver screen: GO, Seats open / Full, Go offline.
//
// Pure black, no map, little lit text. The phone needs no login: it is the
// anonymous account that the one-time QR setup linked to one caddy. An admin's
// "Revoke" reaches the phone within a second and stops the shift.

import { DRIVER, GEOFENCE } from './config.js';
import { CAMPUS_POLYGON } from './data/campus.js';
import { CADDY_ID_RE, clearBinding, readBinding, saveBinding } from './driver.js';
import { createShift } from './driver-shift.js';
import { FIREBASE_ON, loadFirebase } from './firebase.js';
import { distanceOutsideM } from './lib/polygon.js';
import { createWakeLock } from './lib/wake-lock.js';

const SHIFT_KEY = 'snucaddy.shift';
const DIM_AFTER_MS = 20_000;
const CONFIRM_OFF_MS = 4000;
const NOT_LINKED = 'This phone is no longer linked. Ask an admin for a new setup code.';

const $ = (id) => document.getElementById(id);
const els = {
  root: $('driver'),
  net: $('driver-net'),
  label: $('driver-label'),
  name: $('driver-name'),
  status: $('driver-status'),
  meta: $('driver-meta'),
  seats: $('driver-seats'),
  open: $('seat-open'),
  full: $('seat-full'),
  go: $('driver-go'),
  off: $('driver-off'),
};

/** Everything the screen shows comes from here (see render()). */
const ui = {
  /** Message before the shift engine exists: [text, tone]. */
  boot: ['Checking link…', 'dim'],
  /** Connection pill before the shift engine exists ('wait' | 'bad' | null = hidden). */
  bootNet: 'wait',
  /** Set when the phone lost its link: the screen shows only this. */
  unlinked: null,
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
      'This browser cannot share the location. Open the app in Chrome over https.',
      'error',
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
      setBoot('Firebase is not set up yet (docs/FIREBASE_SETUP.md).', 'warn', null);
      return;
    }
    setBoot(
      'No connection. This phone stays linked. The screen reloads when it is online.',
      'warn',
      'bad',
    );
    window.addEventListener('online', () => location.reload(), { once: true });
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

  // A reload (or a crash) during a shift continues it. GO also works offline:
  // the phone starts sharing as soon as it is online.
  const saved = readSavedShift(link.caddyId);
  if (saved && Date.now() - saved.aliveAt < DRIVER.resumeWithinMs) {
    shift.go({ status: saved.status, since: saved.since });
  } else {
    persist.clear();
  }

  watchLink(fb, user, link);
}

/**
 * Live link check: an admin's "Revoke" deletes drivers/{uid}. While the phone
 * is offline nothing fires and the phone simply stays linked.
 */
function watchLink(fb, user, link) {
  let stopListening = null;
  stopListening = fb.D.onValue(
    fb.D.ref(fb.db, `drivers/${user.uid}`),
    async (snap) => {
      if (!snap.exists()) {
        await unlink(fb, 'An admin unlinked this phone.', stopListening);
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
    sendPosition: (f) => D.update(node, { ...f, online: true, lastUpdated: D.serverTimestamp() }),
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

function setBoot(text, tone, net) {
  ui.boot = [text, tone];
  ui.bootNet = net;
  render();
}

// --- Controls -------------------------------------------------------------------
els.go.addEventListener('click', () => {
  if (!shift || ui.unlinked) return;
  buzz();
  shift.go(); // in the tap itself: the wake lock and the location prompt need it
});

for (const [btn, status] of [
  [els.open, 'open'],
  [els.full, 'full'],
]) {
  btn.addEventListener('click', () => {
    if (ui.shift?.status !== status) buzz();
    shift?.setStatus(status);
  });
}

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

  // Connection pill.
  const net = !shift ? ui.bootNet : s?.connected ? 'ok' : 'bad';
  els.net.hidden = Boolean(ui.unlinked) || !net;
  if (net) {
    els.net.dataset.state = net;
    els.net.textContent = { wait: 'Connecting…', ok: 'Online', bad: 'No connection' }[net];
  }

  els.label.textContent = on ? `On shift · ${since(s.since)}` : 'This phone drives';

  const [text, tone] = statusLine(s);
  if (els.status.textContent !== text) els.status.textContent = text; // role=status: say changes only
  // A new warning (no GPS, no internet, …) lights a dimmed screen up again.
  if (tone !== els.status.dataset.tone && (tone === 'warn' || tone === 'error')) wakeScreen();
  els.status.dataset.tone = tone;
  els.meta.textContent = metaLine(s, on);

  els.seats.hidden = !on;
  els.open.setAttribute('aria-pressed', String(s?.status === 'open'));
  els.full.setAttribute('aria-pressed', String(s?.status === 'full'));
  els.root.dataset.seat = s?.status ?? 'open';

  els.go.hidden = on || Boolean(ui.unlinked);
  els.go.disabled = !shift;
  els.off.hidden = !on;
}

/** @returns {[string, 'dim'|'ok'|'warn'|'error']} */
function statusLine(s) {
  if (ui.unlinked) return [ui.unlinked, 'error'];
  if (!s) return ui.boot;
  if (s.mode === 'idle') {
    if (s.ended === 'denied') {
      return [
        'Location is blocked. Allow it for this app: Chrome ⋮ → Settings → Site settings → Location. Then tap GO.',
        'error',
      ];
    }
    if (s.ended === 'paused') {
      return [
        'Your shift ended: the app was closed for over 10 minutes. Tap GO to start again.',
        'warn',
      ];
    }
    if (s.ended === 'driver') return ['You are offline. Students no longer see this caddy.', 'dim'];
    return ['Tap GO to start your shift.', 'dim'];
  }
  if (s.refused)
    return ['The server refuses the updates. Ask an admin to check this caddy.', 'error'];
  if (s.gps === 'outside') return ['Outside campus. Your location is not shared.', 'warn'];
  if (s.gps === 'unavailable')
    return ['Location is off. Turn on Location in the phone settings.', 'error'];
  if (!s.connected)
    return ['No internet. Your location is sent again when the signal is back.', 'warn'];
  if (s.gps === 'waiting') {
    const long = Date.now() - s.since > DRIVER.gpsLostMs;
    return [long ? 'Still looking for GPS. Go to an open area.' : 'Finding your location…', 'dim'];
  }
  if (s.gps === 'lost') return ['No GPS signal. Go to an open area.', 'warn'];
  if (s.gps === 'weak') {
    return [`GPS is weak (±${s.accuracy} m). Students see your last good location.`, 'warn'];
  }
  if (s.sentAt === null) return ['Sending your location…', 'dim'];
  return ['You are online. Students can see you.', 'ok'];
}

function metaLine(s, on) {
  if (ui.unlinked || !s) return '';
  if (!on) {
    return s.connected ? '' : 'You can start now. Sharing begins when the phone is online.';
  }
  const parts = [];
  if (s.sentAt !== null) parts.push(`Updated ${ago(s.sentAt)}`);
  if (s.accuracy !== null && s.gps !== 'outside') parts.push(`GPS ±${s.accuracy} m`);
  if (ui.wake === 'lost') parts.push('The screen can turn off (battery saver?)');
  if (ui.wake === 'unsupported') parts.push('Keep the screen on yourself');
  return parts.join(' · ');
}

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

function since(t) {
  const min = Math.floor((Date.now() - t) / 60_000);
  if (min < 1) return 'just started';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// --- Start (last, so that everything above is defined) ---------------------------
const binding = readBinding();
if (!binding) {
  clearBinding(); // A broken binding would bounce between the two pages forever.
  leave();
} else {
  boot(binding);
}
