// Student map: wires the theme, map, caddy icons, bottom sheet and demo mode.

import { CaddyLayer } from './caddy-layer.js';
import { createCaddyList } from './caddy-list.js';
import { DemoSimulator } from './demo.js';
import { createMap } from './map.js';
import { createSheet } from './sheet.js';
import { bindThemeMenu, createTheme } from './theme.js';

const $ = (sel) => document.querySelector(sel);
const LABEL_REFRESH_MS = 5_000;
const RENDER_DELAY_MS = 400;

// --- Theme + map --------------------------------------------------------------
let mapApi = null;
const theme = createTheme({ onChange: (resolved) => mapApi?.setTheme(resolved) });
mapApi = createMap($('#map'), theme.resolved);
bindThemeMenu(theme, $('#theme-btn'), $('#theme-menu'));

// --- Caddy state ----------------------------------------------------------------
/** Every caddy we know about: id -> record. Phase 4 fills this from Firebase. */
const caddies = new Map();
let selectedId = null;

const layer = new CaddyLayer(mapApi.map, { onSelect: select });
const sheet = createSheet($('#sheet'));
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

function select(id) {
  selectedId = id;
  layer.select(id);
  if (sheet.snap === 'full') sheet.setSnap('half'); // Show some map around the caddy.
  const at = layer.shownLatLng(id);
  if (at) mapApi.focus(at, sheet.cover());
  renderNow();
}

function clearSelection() {
  if (!selectedId) return;
  selectedId = null;
  layer.select(null);
  renderNow();
}

mapApi.map.on('click', clearSelection);
$('#recenter-btn').addEventListener('click', () => mapApi.fitCampus(sheet.cover()));

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
  renderNow();
}

demoSwitch.addEventListener('click', () => setDemo(!demo.running));
$('#empty-demo').addEventListener('click', () => setDemo(true));

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
