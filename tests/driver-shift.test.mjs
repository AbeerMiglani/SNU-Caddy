// Unit tests for the driver shift engine (js/driver-shift.js) with a fake GPS,
// a fake database and fake timers. No emulator or browser needed.
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DRIVER, GEOFENCE } from '../js/config.js';
import { CAMPUS_POLYGON } from '../js/data/campus.js';
import { createShift } from '../js/driver-shift.js';
import { offsetM } from '../js/lib/geo.js';

const HOME = { lat: 28.5245, lng: 77.5745 }; // near the Library
const OFF_CAMPUS = { lat: 28.6139, lng: 77.209 }; // New Delhi
const flush = () => new Promise((r) => setImmediate(r));

let geo;
let db;
let wake;
let persist;
let doc;
let states;

function fakeGeo() {
  const g = {
    watches: new Map(),
    nextId: 1,
    oneShots: [],
    options: null,
    watchPosition(ok, err, options) {
      g.options = options;
      const id = g.nextId++;
      g.watches.set(id, { ok, err });
      return id;
    },
    clearWatch(id) {
      g.watches.delete(id);
    },
    getCurrentPosition(ok, err, options) {
      g.oneShots.push({ ok, err, options });
    },
    /** Deliver one fix to every watch. */
    fix(p, accuracy = 6, extra = {}) {
      const pos = {
        coords: {
          latitude: p.lat,
          longitude: p.lng,
          accuracy,
          heading: null,
          speed: null,
          ...extra,
        },
      };
      for (const w of g.watches.values()) w.ok(pos);
    },
    error(code) {
      for (const w of g.watches.values()) w.err({ code });
    },
  };
  return g;
}

function fakeDb() {
  const d = {
    connected: false,
    listeners: [],
    log: [], // every call, in order
    positions: [],
    refuse: false,
    hold: null, // set to an array to keep position writes pending (a dead socket)
    moved: [],
    sendPosition(f, { moved }) {
      d.log.push(['position', f]);
      d.positions.push(f);
      d.moved.push(moved);
      if (d.hold) return new Promise((resolve) => d.hold.push(resolve));
      return d.refuse ? Promise.reject(new Error('PERMISSION_DENIED')) : Promise.resolve();
    },
    setFields(f) {
      d.log.push(['fields', f]);
      return Promise.resolve();
    },
    armDisconnect() {
      d.log.push(['arm']);
      return Promise.resolve();
    },
    cancelDisconnect() {
      d.log.push(['cancel']);
      return Promise.resolve();
    },
    onConnection(cb) {
      d.listeners.push(cb);
      cb(d.connected);
      return () => {
        d.listeners = d.listeners.filter((x) => x !== cb);
      };
    },
    setConnected(up) {
      d.connected = up;
      for (const cb of d.listeners) cb(up);
    },
    calls: (kind) => d.log.filter(([k]) => k === kind),
  };
  return d;
}

function fakeDoc() {
  const t = new EventTarget();
  t.visibilityState = 'visible';
  t.setVisible = (v) => {
    t.visibilityState = v ? 'visible' : 'hidden';
    t.dispatchEvent(new Event('visibilitychange'));
  };
  return t;
}

function makeShift() {
  return createShift({
    store: db,
    geo,
    wake,
    onCampus: (lat, lng) => lat > 28.51 && lat < 28.54 && lng > 77.56 && lng < 77.59,
    persist,
    onChange: (s) => states.push(s),
    doc,
  });
}

const last = () => states.at(-1);

/** Advance the fake clock in small steps, so timers and promises interleave like real life. */
async function wait(ms, step = 100) {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(Math.min(step, ms - t));
    await flush();
  }
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  geo = fakeGeo();
  db = fakeDb();
  wake = { held: false, acquire: () => (wake.held = true), release: () => (wake.held = false) };
  persist = { saved: null, save: (v) => (persist.saved = v), clear: () => (persist.saved = null) };
  doc = fakeDoc();
  states = [];
  db.setConnected(true);
});

afterEach(() => mock.timers.reset());

test('GO: wake lock, high-accuracy GPS watch, first fix sent at once, then onDisconnect', async () => {
  const shift = makeShift();
  shift.go();
  assert.equal(wake.held, true);
  assert.deepEqual(geo.options, { enableHighAccuracy: true, maximumAge: 0 });
  assert.equal(last().mode, 'on');
  assert.equal(last().gps, 'waiting');

  geo.fix(HOME, 6);
  await flush();
  assert.equal(db.positions.length, 1);
  assert.deepEqual(db.positions[0], { lat: 28.5245, lng: 77.5745, accuracy: 6 });
  // onDisconnect is armed only after the node exists (the rules need that).
  assert.deepEqual(
    db.log.map(([k]) => k),
    ['position', 'arm'],
  );
  assert.equal(last().gps, 'ok');
  assert.notEqual(last().sentAt, null);
  assert.equal(typeof persist.saved.aliveAt, 'number');
});

test('blurry fixes (> 20 m) are not sent', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  await wait(6000);
  geo.fix(offsetM(HOME, 30, 0), 35);
  await flush();
  assert.equal(db.positions.length, 1);
  assert.equal(last().gps, 'weak');
  assert.equal(last().accuracy, 35);
});

test('5 m deadband, and never two position writes within the minimum gap', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  assert.equal(db.positions.length, 1);

  await wait(1000);
  geo.fix(offsetM(HOME, 3, 0)); // 3 m: deadband
  await flush();
  assert.equal(db.positions.length, 1);

  geo.fix(offsetM(HOME, 8, 0)); // 8 m north, but only 1 s after the last write
  await flush();
  assert.equal(db.positions.length, 1, 'held back by the minimum gap');
  await wait(1100);
  assert.equal(db.positions.length, 2, 'sent when the gap is over');
  assert.equal(db.positions[1].bearing, 0, 'moving north');

  // A fast caddy: a new fix every 500 ms, each one 6 m further east.
  let p = offsetM(HOME, 8, 0);
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) {
    p = offsetM(p, 0, 6);
    geo.fix(p);
    await wait(500);
  }
  const writes = db.positions.length - 2;
  const span = Date.now() - t0;
  assert.ok(writes <= Math.ceil(span / DRIVER.minWriteGapMs) + 1, `${writes} writes in ${span} ms`);
  assert.ok(writes >= 4);
  assert.equal(db.positions.at(-1).bearing, 90, 'moving east');
  // The newest fix wins: the last write is close to the newest fix.
  assert.ok(Math.abs(db.positions.at(-1).lng - p.lng) < 0.0002);
});

test('GPS heading is used when the caddy moves; a slow caddy keeps its last heading', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME, 5, { heading: 123.4, speed: 4 });
  await flush();
  assert.equal(db.positions[0].bearing, 123);
  await wait(2100);
  geo.fix(offsetM(HOME, 10, 0), 5, { heading: 0, speed: 0.2 });
  await flush();
  assert.equal(db.positions[1].bearing, 123);
  await wait(2100);
  geo.fix(offsetM(HOME, 20, 0), 5, { heading: 359.7, speed: 3 });
  await flush();
  assert.equal(db.positions[2].bearing, 0, '359.7 rounds to 360, which must wrap to 0');
});

test('parked caddy: one heartbeat every 30 s', async () => {
  const shift = makeShift();
  shift.go();
  for (let s = 0; s <= 95; s++) {
    geo.fix(HOME); // the phone reports the same place every second
    await wait(1000, 500);
  }
  assert.equal(db.positions.length, 4, 'first fix + heartbeats at about 30, 60 and 90 s');
});

test('parked caddy on a quiet GPS: the heartbeat asks for a fresh fix', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  await wait(31_000, 1000);
  assert.equal(db.positions.length, 1, 'the old fix is not resent as if it were new');
  assert.equal(geo.oneShots.length, 1);
  assert.deepEqual(geo.oneShots[0].options, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20_000,
  });
  geo.oneShots[0].ok({ coords: { latitude: HOME.lat, longitude: HOME.lng, accuracy: 7 } });
  await flush();
  assert.equal(db.positions.length, 2);
  assert.equal(db.positions[1].accuracy, 7);
});

test('no fix for 20 s: GPS lost', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await wait(26_000, 1000);
  assert.equal(last().gps, 'lost');
});

test('outside campus: location not shared, caddy marked offline once; back inside: online', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  await wait(2500);
  for (let i = 0; i < 40; i++) {
    geo.fix(OFF_CAMPUS);
    await wait(1000, 500);
  }
  assert.equal(last().gps, 'outside');
  assert.equal(db.positions.length, 1, 'no position from outside campus');
  assert.deepEqual(db.calls('fields'), [['fields', { online: false }]]);

  geo.fix(HOME);
  await flush();
  assert.equal(db.positions.length, 2, 'back on campus: sent at once');
  assert.equal(last().gps, 'ok');
});

test('first fix outside campus: nothing is written at all', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(OFF_CAMPUS);
  await wait(5000);
  assert.equal(db.log.length, 0);
  assert.equal(last().gps, 'outside');
});

test('dead zone: no writes while offline; on reconnect the newest fix goes at once, then onDisconnect again', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  assert.equal(db.calls('arm').length, 1);

  db.setConnected(false);
  let p = HOME;
  for (let i = 0; i < 30; i++) {
    p = offsetM(p, 0, 7);
    geo.fix(p);
    await wait(1000, 500);
  }
  assert.equal(db.positions.length, 1, 'nothing queued while offline');
  assert.equal(last().connected, false);

  db.setConnected(true);
  await flush();
  assert.equal(db.positions.length, 2, 'one write on reconnect');
  assert.ok(Math.abs(db.positions[1].lng - p.lng) < 1e-6, 'with the newest fix');
  assert.equal(db.calls('arm').length, 2, 'onDisconnect registered again');
});

test('GO while offline: sharing starts when the phone is online', async () => {
  db.setConnected(false);
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await wait(3000);
  assert.equal(db.positions.length, 0);
  geo.fix(HOME);
  db.setConnected(true);
  await flush();
  assert.equal(db.positions.length, 1);
});

test('Moving / Parked: movedAt only for real moves (GPS speed, or a clear distance)', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME, 6, { speed: 0 });
  await flush();
  assert.equal(db.moved[0], false, 'parked at the start');

  await wait(2100);
  geo.fix(offsetM(HOME, 8, 0), 6, { speed: 4 });
  await flush();
  assert.equal(db.moved[1], true, 'GPS speed says it drives');

  // Without speed: GPS noise of 6 m around one place is not a move ...
  await wait(2100);
  geo.fix(offsetM(HOME, 14, 0), 6);
  await flush();
  assert.equal(db.moved[2], false, '6 m from the last move: noise');
  // ... but 15 m beyond the error radius is.
  await wait(2100);
  geo.fix(offsetM(HOME, 30, 0), 6);
  await flush();
  assert.equal(db.moved[3], true);
});

test('Go offline while the first write is still pending: online:false still follows it', async () => {
  const shift = makeShift();
  db.hold = [];
  shift.go();
  geo.fix(HOME);
  await flush();
  assert.equal(db.positions.length, 1, 'first write sent, not confirmed (dead socket)');
  shift.stop('driver');
  assert.deepEqual(
    db.log.map(([k, f]) => (k === 'fields' ? f : k)),
    ['position', { online: false }, 'cancel'],
  );
  // The late confirmation of the old shift does not arm onDisconnect.
  db.hold.forEach((r) => r());
  await flush();
  assert.equal(db.calls('arm').length, 0);
});

test('outside campus while the first write is pending: online:false still follows it', async () => {
  const shift = makeShift();
  db.hold = [];
  shift.go();
  geo.fix(HOME);
  await flush();
  geo.fix(OFF_CAMPUS);
  assert.deepEqual(db.calls('fields'), [['fields', { online: false }]]);
});

test('GPS hovering around 20 m: no flicker between "ok" and "weak"', async () => {
  const shift = makeShift();
  shift.go();
  const seen = new Set();
  for (let i = 0; i < 20; i++) {
    geo.fix(HOME, i % 2 ? 23 : 18);
    seen.add(last().gps);
    await wait(1000, 500);
  }
  assert.deepEqual([...seen], ['ok']);
  for (let i = 0; i < 8; i++) {
    geo.fix(HOME, 25); // only blurry fixes now
    await wait(1000, 500);
  }
  assert.equal(last().gps, 'weak', 'weak after 5 s of blurry fixes only');
});

test('blurry fix after leaving campus: still "outside" (a blurry fix proves nothing)', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  geo.fix(OFF_CAMPUS);
  await wait(6000);
  geo.fix(OFF_CAMPUS, 40);
  assert.equal(last().gps, 'outside');
});

test('approximate location (precise location off): said clearly', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME, 1800);
  assert.equal(last().gps, 'approximate');
  assert.equal(db.positions.length, 0);
});

test('blurry fixes before any sharp one: still "waiting", with the error radius', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME, 45);
  assert.equal(last().gps, 'waiting');
  assert.equal(last().accuracy, 45);
  assert.equal(typeof last().gpsSince, 'number');
});

test('Go offline: online:false, then onDisconnect cancelled; GPS and wake lock off', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  shift.stop('driver');
  assert.deepEqual(db.log.slice(-2), [['fields', { online: false }], ['cancel']]);
  assert.equal(geo.watches.size, 0);
  assert.equal(wake.held, false);
  assert.equal(persist.saved, null);
  assert.equal(last().mode, 'idle');
  assert.equal(last().ended, 'driver');

  // Late fixes from the old watch do nothing.
  geo.fix(HOME);
  await wait(40_000, 1000);
  assert.equal(db.positions.length, 1);
});

test('Go offline before any write: nothing to clean up', async () => {
  const shift = makeShift();
  shift.go();
  shift.stop('driver');
  assert.equal(db.log.length, 0);
});

test('location permission denied: the shift ends and says why', async () => {
  const shift = makeShift();
  shift.go();
  geo.error(1);
  assert.equal(last().mode, 'idle');
  assert.equal(last().ended, 'denied');
  assert.equal(wake.held, false);
});

test('location off on the phone: shown, and the watch goes on', async () => {
  const shift = makeShift();
  shift.go();
  geo.error(2);
  assert.equal(last().gps, 'unavailable');
  assert.equal(last().mode, 'on');
  geo.fix(HOME);
  await flush();
  assert.equal(last().gps, 'ok');
});

test('refused writes: back off, and tell the driver after 3 in a row', async () => {
  const shift = makeShift();
  db.refuse = true;
  shift.go();
  let p = HOME;
  for (let i = 0; i < 40; i++) {
    p = offsetM(p, 6, 0);
    geo.fix(p);
    await wait(1000, 250);
  }
  // Back-off 2 s, 4 s, 8 s, 16 s ... instead of one write per fix.
  assert.ok(db.positions.length <= 6, `${db.positions.length} attempts`);
  assert.equal(last().refused, true);
  assert.equal(db.calls('arm').length, 0);

  db.refuse = false;
  await wait(35_000, 1000);
  geo.fix(p);
  await wait(1000);
  assert.equal(last().refused, false);
});

test('revoked: the shift stops without any write (the phone may not write any more)', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  const before = db.log.length;
  shift.dispose('revoked');
  assert.equal(db.log.length, before);
  assert.equal(last().ended, 'revoked');
  assert.equal(db.listeners.length, 0);
});

test('app in the background for over 10 minutes: the shift ends on return', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  doc.setVisible(false);
  await wait(DRIVER.resumeWithinMs + 1000, 60_000);
  doc.setVisible(true);
  assert.equal(last().mode, 'idle');
  assert.equal(last().ended, 'paused');
  assert.deepEqual(db.calls('fields').at(-1), ['fields', { online: false }]);
});

test('app in the background for a short time: the shift goes on and asks for a fresh fix', async () => {
  const shift = makeShift();
  shift.go();
  geo.fix(HOME);
  await flush();
  doc.setVisible(false);
  await wait(60_000, 10_000);
  doc.setVisible(true);
  assert.equal(last().mode, 'on');
  assert.ok(geo.oneShots.length >= 1);
});

test('resume after a reload keeps the shift start; the GPS search starts now', async () => {
  const shift = makeShift();
  const since = Date.now() - 3_600_000;
  shift.go({ since });
  assert.equal(last().since, since);
  assert.equal(last().gpsSince, Date.now());
  geo.fix(HOME);
  await flush();
  assert.equal(db.positions.length, 1);
});

test('the campus fence plus its margin lies inside the database rules box', () => {
  // The rules reject positions outside a lat/lng box. The phone stops sharing
  // at the fence + margin, so that line must be inside the box everywhere.
  const rules = fs.readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8');
  const box = (field) =>
    rules
      .match(
        new RegExp(
          `"${field}": \\{ ".validate": "newData.isNumber\\(\\) && newData.val\\(\\) >= ([\\d.]+) && newData.val\\(\\) <= ([\\d.]+)`,
        ),
      )
      .slice(1, 3)
      .map(Number);
  const [latMin, latMax] = box('lat');
  const [lngMin, lngMax] = box('lng');
  for (const [lat, lng] of CAMPUS_POLYGON) {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      const p = offsetM(
        { lat, lng },
        GEOFENCE.marginM * Math.cos(a),
        GEOFENCE.marginM * Math.sin(a),
      );
      assert.ok(
        p.lat > latMin && p.lat < latMax && p.lng > lngMin && p.lng < lngMax,
        JSON.stringify(p),
      );
    }
  }
});
