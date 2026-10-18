// What the student map shows for a caddy (js/caddy-state.js), and how a
// database object becomes a map record (js/live.js toRecord).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STATE_ORDER, STATE_TEXT, caddyState } from '../js/caddy-state.js';
import { LIVE } from '../js/config.js';
import { toRecord } from '../js/live.js';

const NOW = 1_800_000_000_000;
const caddy = (o = {}) => ({ online: true, ts: NOW - 5_000, movedAt: null, ...o });

test('charging: shown for a live, online caddy, whether or not it moved lately', () => {
  assert.equal(caddyState(caddy({ charging: true }), NOW), 'charging');
  assert.equal(caddyState(caddy({ charging: true, movedAt: NOW - 10_000 }), NOW), 'charging');
  assert.equal(caddyState(caddy({ charging: false, movedAt: NOW - 10_000 }), NOW), 'moving');
  assert.equal(caddyState(caddy({ charging: false }), NOW), 'parked');
  assert.equal(caddyState(caddy(), NOW), 'parked', 'no charging field: older data still works');
});

test('charging: Signal lost and Offline win', () => {
  const stale = NOW - LIVE.signalLostMs - 1_000;
  assert.equal(caddyState(caddy({ charging: true, ts: stale }), NOW), 'lost');
  assert.equal(caddyState(caddy({ charging: true, online: false }), NOW), 'offline');
  assert.equal(caddyState(caddy({ charging: true, online: false, ts: stale }), NOW), 'offline');
});

test('every state has a word and a list position; Charging sits after Parked', () => {
  const states = ['moving', 'parked', 'charging', 'lost', 'offline'];
  for (const s of states) assert.equal(typeof STATE_TEXT[s], 'string');
  assert.deepEqual(
    [...states].sort((a, b) => STATE_ORDER[a] - STATE_ORDER[b]),
    states,
  );
  assert.equal(STATE_TEXT.charging, 'Charging');
});

test('toRecord: charging is true only for a real boolean true', () => {
  const v = { lat: 28.5245, lng: 77.5745, lastUpdated: NOW, online: true };
  assert.equal(toRecord('caddy_01', { ...v, charging: true }, 'Caddy 01', 0).charging, true);
  assert.equal(toRecord('caddy_01', { ...v, charging: false }, 'Caddy 01', 0).charging, false);
  assert.equal(toRecord('caddy_01', v, 'Caddy 01', 0).charging, false);
  assert.equal(toRecord('caddy_01', { ...v, charging: 'yes' }, 'Caddy 01', 0).charging, false);
});
