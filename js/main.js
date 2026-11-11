// Student app: wires the theme, map, caddy icons, bottom sheet, demo mode,
// the SNU login + campus geofence gate, live data, and driver-phone setup.

import { CaddyLayer } from './caddy-layer.js';
import { createCaddyList } from './caddy-list.js';
import { caddyState } from './caddy-state.js';
import { APP_VERSION, LIVE, ME, SUPPORT_EMAIL } from './config.js';
import { DemoSimulator } from './demo.js';
import { FIREBASE_ON } from './firebase.js';
import { onFiveTaps } from './lib/five-taps.js';
import { createLive } from './live.js';
import { createMap } from './map.js';
import { createSheet } from './sheet.js';
import { createStudentGate } from './student-gate.js';
import { bindThemeButton, createTheme } from './theme.js';

const $ = (sel) => document.querySelector(sel);
const LABEL_REFRESH_MS = 5_000;
const RENDER_DELAY_MS = 400;

// --- Theme + map --------------------------------------------------------------
let mapApi = null;
const theme = createTheme({ onChange: (resolved) => mapApi?.setTheme(resolved) });
mapApi = createMap($('#map'), theme.resolved);
bindThemeButton(theme, $('#theme-btn'), $('#theme-label'));

// --- Caddy state ----------------------------------------------------------------
/** Every caddy we know about: id -> record (from Firebase, or from the demo). */
const caddies = new Map();
let selectedId = null;
/** @type {'off'|'connecting'|'live'|'reconnecting'|'denied'} */
let liveStatus = 'off';
let idlePaused = false;
/**
 * The student's own position (from the campus check; it stays on this phone).
 * @type {import('./geofence.js').Position | null}
 */
let me = null;

// A tap on a map icon also brings that caddy's row into view in the sheet.
const layer = new CaddyLayer(mapApi.map, { onSelect: (id) => select(id, { reveal: true }) });
const sheet = createSheet($('#sheet'), { onChange: (cover) => mapApi.setCover(cover) });
const list = createCaddyList({
  list: $('#caddy-list'),
  empty: $('#empty'),
  summary: $('#summary'),
  summaryStatus: $('#summary-status'),
  onSelect: select,
});

// --- Demo / pitch mode ----------------------------------------------------------
const params = new URLSearchParams(location.search);
const demoSwitch = $('#demo-switch');
const demo = new DemoSimulator({
  onUpdate: upsert,
  onRemove: removeCaddy,
  speed: params.get('speed') ?? 1,
});

// The list redraws at most every 400 ms, however many pings arrive.
let renderTimer = 0;
function scheduleRender() {
  if (!renderTimer) renderTimer = setTimeout(renderNow, RENDER_DELAY_MS);
}
/** @param {boolean} [remeasure] measure the sheet even if the list kept its shape */
function renderNow(remeasure = false) {
  clearTimeout(renderTimer);
  renderTimer = 0;
  // "A caddy shows here when…" only when live data is really loaded (or there
  // is no Firebase project): not while signing in, connecting, paused or refused.
  // Idle pause and sign-out switch live data off ('off').
  const loading =
    FIREBASE_ON && !demo.running && liveStatus !== 'live' && liveStatus !== 'reconnecting';
  const sheetEl = $('#sheet');
  const changed = sheetEl.classList.contains('is-loading') !== loading;
  sheetEl.classList.toggle('is-loading', loading);
  // The sheet sees by itself when the header or the first row changes size (sheet.js);
  // it needs a call only when what it shows changes kind: list, empty text or card.
  const shape = list.render(caddies, selectedId, summaryNote(), distanceOrigin());
  if (shape || changed || remeasure) sheet.refresh();
}

// --- The student's own position ---------------------------------------------------
const meIsStale = () => Boolean(me) && Date.now() - me.at > ME.staleMs;

/** Distances are shown only from a position that is sharp and new enough. */
function distanceOrigin() {
  return me && me.accuracy <= ME.distanceWithinM && !meIsStale() ? me : null;
}

function showMe() {
  mapApi.setMe(me, { stale: meIsStale() });
  $('#locate-btn').hidden = !me;
}

function setMe(position) {
  me = position;
  showMe();
  scheduleRender();
}

/** A sheet summary that replaces the caddy count, or null. */
function summaryNote() {
  // The location card below says it all.
  if ($('#sheet').classList.contains('is-gated')) return '';
  if (demo.running) return null;
  if (idlePaused) return 'Paused'; // the bar at the top says how to resume
  return (
    {
      off: FIREBASE_ON ? 'Connecting…' : null,
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      denied: 'Could not load caddies. Sign out, then sign in again.',
    }[liveStatus] ?? null
  );
}

function upsert(record) {
  const merged = { ...caddies.get(record.id), ...record };
  merged.state = caddyState(merged, Date.now());
  caddies.set(record.id, merged);
  layer.update(merged);
  scheduleRender();
}

/** Time alone changes a state (Moving -> Parked after 60 s, Signal lost after 90 s). */
function refreshStates() {
  const now = Date.now();
  for (const c of caddies.values()) {
    const state = caddyState(c, now);
    if (state === c.state) continue;
    c.state = state;
    layer.update(c);
  }
}

function removeCaddy(id) {
  caddies.delete(id);
  layer.remove(id);
  if (selectedId === id) selectedId = null;
  scheduleRender();
}

function select(id, { reveal = false } = {}) {
  selectedId = id;
  layer.select(id);
  if (sheet.snap === 'full') sheet.setSnap('half'); // Show some map around the caddy.
  const at = layer.shownLatLng(id);
  if (at) mapApi.focus(at, sheet.cover());
  renderNow();
  if (reveal) list.reveal(id);
}

function clearSelection() {
  if (!selectedId) return;
  selectedId = null;
  layer.select(null);
  renderNow();
}

mapApi.map.on('click', clearSelection);

// Keyboard or pointer? Leaflet focuses the map on every tap, so the map's focus
// ring (app.css) shows only after Tab.
document.addEventListener(
  'keydown',
  (e) => e.key === 'Tab' && document.documentElement.classList.add('kbd'),
  true,
);
document.addEventListener(
  'pointerdown',
  () => document.documentElement.classList.remove('kbd'),
  true,
);
$('#recenter-btn').addEventListener('click', () => mapApi.fitCampus(sheet.cover()));

// "Show my location": a position from the last seconds is used as it is;
// otherwise the phone takes one precise fix (the button is busy meanwhile).
$('#locate-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  if (btn.getAttribute('aria-disabled') === 'true') return;
  let at = me && Date.now() - me.at <= ME.freshMs ? me : null;
  if (!at && gate) {
    btn.setAttribute('aria-disabled', 'true');
    try {
      at = await gate.locate();
    } finally {
      btn.setAttribute('aria-disabled', 'false');
    }
  }
  at ??= me; // no new fix: the last known place (null when the student left campus)
  if (at) mapApi.focus(at, sheet.cover());
});

// --- Live data from Firebase ------------------------------------------------------
const live = createLive({
  onUpdate: upsert,
  onRemove: removeCaddy,
  onStatus: (status) => {
    liveStatus = status;
    renderNow();
  },
});

// --- SNU login + campus geofence -----------------------------------------------
// Without a Firebase project the app runs without login (map + demo only).
// (Created after `live` and `demo`: its first render already reads them.)
const gate = FIREBASE_ON
  ? createStudentGate(
      {
        login: $('#login'),
        loginButton: $('#login-btn'),
        loginTitle: $('#login-title'),
        loginError: $('#login-error'),
        card: $('#gate'),
        cardTitle: $('#gate-title'),
        cardText: $('#gate-text'),
        cardAction: $('#gate-action'),
        listTitle: $('#sheet-title'),
        list: $('#caddy-list'),
        account: $('#account'),
        accountEmail: $('#account-email'),
        signOut: $('#sign-out'),
        // The top bar stays usable: theme, and 5 taps on the name for driver setup.
        behindLogin: [$('#map'), $('#recenter-btn'), $('#locate-btn'), $('#sheet')],
      },
      {
        // Live data runs only while the gate allows it (see student-gate.js).
        onLive: (on, { fb }) => {
          document.documentElement.dataset.live = String(on);
          if (on) live.attach(fb);
          else live.detach();
        },
        onPosition: setMe,
        onChange: () => {
          $('#sheet').classList.toggle('is-gated', !$('#gate').hidden);
          renderNow(true); // sets the summary ('' under a card) before the sheet is measured
        },
      },
    )
  : null;

// --- Idle pause -------------------------------------------------------------------
// A phone left open on a desk would hold a database connection (the free plan
// allows 100 at the same moment) and use battery. After a few minutes without
// a touch, live updates pause; the next touch resumes them.
let lastTouch = Date.now();
function setIdlePaused(on) {
  if (idlePaused === on) return;
  idlePaused = on;
  gate?.setPaused(on);
  const chip = $('#paused');
  // A hidden button loses keyboard / screen-reader focus: keep it in the sheet.
  if (!on && document.activeElement === chip) $('.sheet__grab').focus({ preventScroll: true });
  chip.hidden = !on;
  renderNow();
}
function markActive() {
  lastTouch = Date.now();
  setIdlePaused(false);
}
// 'click' too: screen readers activate controls without pointer events.
for (const type of ['pointerdown', 'keydown', 'wheel', 'click']) {
  document.addEventListener(type, markActive, { capture: true, passive: true });
}
function checkIdle() {
  if (gate?.live && Date.now() - lastTouch >= LIVE.idlePauseMs) setIdlePaused(true);
}

function setDemo(on) {
  if (on) demo.start();
  else demo.stop();
  demoSwitch.setAttribute('aria-checked', String(on));
  // With sign-in set up, students get real caddies: the switch is there only
  // to leave the demo. (Without a Firebase project, the demo is all there is.)
  const hadFocus = document.activeElement === demoSwitch;
  demoSwitch.hidden = FIREBASE_ON && !on;
  if (hadFocus && demoSwitch.hidden) $('#sheet-title').focus({ preventScroll: true });
  gate?.setDemo(on);
  renderNow();
}

demoSwitch.addEventListener('click', () => setDemo(!demo.running));
$('#login-demo').addEventListener('click', () => {
  setDemo(true);
  demoSwitch.focus(); // The focused button just disappeared; keep keyboard focus nearby.
});

// About: what the words mean, and what the app does with location.
const about = $('#about');
$('#about-version').textContent = `Version ${APP_VERSION}`;
if (SUPPORT_EMAIL) {
  const mail = $('#about-mail');
  mail.textContent = SUPPORT_EMAIL;
  mail.href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('SNU Caddy')}`;
  $('#about-help').hidden = false;
}
$('#about-btn').addEventListener('click', () => about.showModal());
// A tap on the dimmed page around the dialog closes it, like its Close button.
about.addEventListener('click', (e) => e.target === about && about.close());

// Hidden driver-phone setup, loaded only when used: 5 quick taps on the name, or a
// #enroll= link from the admin QR. The top bar stays usable on the sign-in screen,
// so a new (signed-out) driver phone can use the name too.
const enrollLink = /[#&]enroll=/.test(location.hash) ? location.hash : null;
if (enrollLink) history.replaceState(null, '', location.pathname + location.search); // no code in the URL bar
const openSetup = (link = null) =>
  import('./enroll-ui.js').then((m) => m.openEnrollment($('#enroll'), link));
onFiveTaps($('#brand'), () => openSetup());
if (enrollLink) openSetup(enrollLink);

// --- Battery: do nothing while the app is not on screen -------------------------
let labelTimer = 0;
function startLabelTimer() {
  if (!labelTimer) {
    labelTimer = setInterval(() => {
      refreshStates();
      checkIdle();
      showMe(); // an old position dims
      scheduleRender();
    }, LABEL_REFRESH_MS);
  }
}
function stopLabelTimer() {
  clearInterval(labelTimer);
  labelTimer = 0;
}

document.addEventListener('visibilitychange', () => {
  // The gate (student-gate.js) also sees this event and switches live data off / on.
  if (document.hidden) {
    demo.pause();
    stopLabelTimer();
  } else {
    markActive(); // opening the app again counts as a touch
    demo.resume();
    refreshStates();
    showMe();
    startLabelTimer();
    renderNow();
  }
});

// --- Start ----------------------------------------------------------------------
renderNow();
mapApi.fitCampus(sheet.cover(), { animate: false });
if (!document.hidden) startLabelTimer();
setDemo(params.has('demo') && params.get('demo') !== '0');

// Offline app shell (sw.js): the app opens in a dead zone, too. It is not
// needed for the first paint, so it registers after the page has loaded.
if ('serviceWorker' in navigator) {
  const register = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
