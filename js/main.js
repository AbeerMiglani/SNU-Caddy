// Student app: wires the theme, map, caddy icons, bottom sheet, demo mode,
// the SNU login + campus geofence gate, live data, and driver-phone setup.

import { CaddyLayer } from './caddy-layer.js';
import { createCaddyList } from './caddy-list.js';
import { caddyState } from './caddy-state.js';
import { LIVE } from './config.js';
import { DemoSimulator } from './demo.js';
import { FIREBASE_ON } from './firebase.js';
import { onFiveTaps } from './lib/five-taps.js';
import { createLive } from './live.js';
import { createMap } from './map.js';
import { createSheet } from './sheet.js';
import { createStudentGate } from './student-gate.js';
import { bindThemePill, createTheme } from './theme.js';

const $ = (sel) => document.querySelector(sel);
const LABEL_REFRESH_MS = 5_000;
const RENDER_DELAY_MS = 400;

// --- Theme + map --------------------------------------------------------------
let mapApi = null;
const theme = createTheme({ onChange: (resolved) => mapApi?.setTheme(resolved) });
mapApi = createMap($('#map'), theme.resolved);
bindThemePill(theme, $('#theme-btn'), $('#theme-label'));

// --- Caddy state ----------------------------------------------------------------
/** Every caddy we know about: id -> record (from Firebase, or from the demo). */
const caddies = new Map();
let selectedId = null;
/** @type {'off'|'connecting'|'live'|'reconnecting'|'denied'} */
let liveStatus = 'off';
let idlePaused = false;

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
function renderNow() {
  clearTimeout(renderTimer);
  renderTimer = 0;
  // Connecting, paused or refused: no "No caddies online right now" card.
  const noCard = liveStatus === 'connecting' || liveStatus === 'denied' || idlePaused;
  $('#sheet').classList.toggle('is-loading', noCard && !demo.running);
  if (list.render(caddies, selectedId, summaryNote())) sheet.refresh();
}

/** A sheet summary that replaces the caddy count, or null. */
function summaryNote() {
  // While the location card shows, no live data is loaded.
  if ($('#sheet').classList.contains('is-gated')) return 'Live tracking paused';
  if (demo.running) return null;
  if (idlePaused) return 'Paused to save battery · tap to resume';
  return (
    {
      connecting: 'Connecting…',
      reconnecting: 'Reconnecting…',
      denied: 'Can’t load caddies. Sign out, then sign in again.',
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
$('#recenter-btn').addEventListener('click', () => mapApi.fitCampus(sheet.cover()));

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
        loginError: $('#login-error'),
        card: $('#gate'),
        cardTitle: $('#gate-title'),
        cardText: $('#gate-text'),
        cardAction: $('#gate-action'),
        account: $('#account'),
        accountEmail: $('#account-email'),
        signOut: $('#sign-out'),
        behindLogin: [$('#map'), $('.topbar'), $('#sheet')],
      },
      {
        // Live data runs only while the gate allows it (see student-gate.js).
        onLive: (on, { fb }) => {
          document.documentElement.dataset.live = String(on);
          if (on) live.attach(fb);
          else live.detach();
        },
        onChange: () => {
          $('#sheet').classList.toggle('is-gated', !$('#gate').hidden);
          sheet.refresh();
          renderNow();
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
  $('#demo-banner').hidden = !on;
  gate?.setDemo(on);
  renderNow();
}

demoSwitch.addEventListener('click', () => setDemo(!demo.running));
$('#empty-demo').addEventListener('click', () => {
  setDemo(true);
  demoSwitch.focus(); // The focused button just disappeared; keep keyboard focus nearby.
});
$('#login-demo').addEventListener('click', () => setDemo(true));

// Hidden driver-phone setup, loaded only when used: 5 quick taps on a logo, or a
// #enroll= link from the admin QR. A new driver phone is signed out, so the logo
// on the sign-in screen works too.
const enrollLink = /[#&]enroll=/.test(location.hash) ? location.hash : null;
if (enrollLink) history.replaceState(null, '', location.pathname + location.search); // no code in the URL bar
const openSetup = (link = null) =>
  import('./enroll-ui.js').then((m) => m.openEnrollment($('#enroll'), link));
for (const logo of [$('#brand'), $('.login__logo')]) onFiveTaps(logo, () => openSetup());
if (enrollLink) openSetup(enrollLink);

// --- Battery: do nothing while the app is not on screen -------------------------
let labelTimer = 0;
function startLabelTimer() {
  if (!labelTimer) {
    labelTimer = setInterval(() => {
      refreshStates();
      checkIdle();
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
    startLabelTimer();
    renderNow();
  }
});

// --- Start ----------------------------------------------------------------------
renderNow();
mapApi.fitCampus(sheet.cover(), { animate: false });
if (!document.hidden) startLabelTimer();
if (params.has('demo') && params.get('demo') !== '0') setDemo(true);

// Offline app shell (sw.js): the app opens in a dead zone, too. It is not
// needed for the first paint, so it registers after the page has loaded.
if ('serviceWorker' in navigator) {
  const register = () => navigator.serviceWorker.register('sw.js').catch(() => {});
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
