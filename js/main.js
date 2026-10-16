// Student app: wires the theme, map, caddy icons, bottom sheet, demo mode,
// and (Phase 2) the SNU login + campus geofence gate and driver-phone setup.

import { CaddyLayer } from './caddy-layer.js';
import { createCaddyList } from './caddy-list.js';
import { DemoSimulator } from './demo.js';
import { FIREBASE_ON } from './firebase.js';
import { onFiveTaps } from './lib/five-taps.js';
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
/** Every caddy we know about: id -> record. Phase 4 fills this from Firebase. */
const caddies = new Map();
let selectedId = null;

// A tap on a map icon also brings that caddy's row into view in the sheet.
const layer = new CaddyLayer(mapApi.map, { onSelect: (id) => select(id, { reveal: true }) });
const sheet = createSheet($('#sheet'), { onChange: (cover) => mapApi.setCover(cover) });
const list = createCaddyList({
  list: $('#caddy-list'),
  empty: $('#empty'),
  summary: $('#summary'),
  onSelect: select,
});

// The list redraws at most every 400 ms, however many pings arrive.
let renderTimer = 0;
function scheduleRender() {
  if (!renderTimer) renderTimer = setTimeout(renderNow, RENDER_DELAY_MS);
}
function renderNow() {
  clearTimeout(renderTimer);
  renderTimer = 0;
  if (list.render(caddies, selectedId)) sheet.refresh();
  // While the location card shows, no live data is loaded.
  if ($('#sheet').classList.contains('is-gated'))
    $('#summary').textContent = 'Live tracking paused';
}

function upsert(record) {
  const merged = { ...caddies.get(record.id), ...record };
  caddies.set(record.id, merged);
  layer.update(merged);
  scheduleRender();
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

// --- Phase 2: SNU login + campus geofence -----------------------------------------
// Without a Firebase project the app stays in Phase 1 mode (map + demo, no login).
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
        // Phase 4 attaches / detaches the live `caddies` listener here.
        onLive: (on) => {
          document.documentElement.dataset.live = String(on);
        },
        onChange: () => {
          $('#sheet').classList.toggle('is-gated', !$('#gate').hidden);
          sheet.refresh();
          renderNow();
        },
      },
    )
  : null;

// --- Demo / pitch mode ----------------------------------------------------------
const params = new URLSearchParams(location.search);
const demoSwitch = $('#demo-switch');
const demo = new DemoSimulator({
  onUpdate: upsert,
  onRemove: removeCaddy,
  speed: params.get('speed') ?? 1,
});

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
  if (!labelTimer) labelTimer = setInterval(scheduleRender, LABEL_REFRESH_MS);
}
function stopLabelTimer() {
  clearInterval(labelTimer);
  labelTimer = 0;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    demo.pause(); // Phase 4: database listeners detach here too.
    stopLabelTimer();
  } else {
    demo.resume();
    startLabelTimer();
    renderNow();
  }
});

// --- Start ----------------------------------------------------------------------
renderNow();
mapApi.fitCampus(sheet.cover(), { animate: false });
if (!document.hidden) startLabelTimer();
if (params.has('demo') && params.get('demo') !== '0') setDemo(true);
