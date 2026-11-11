// Student-side helpers that need no browser: the short texts for times and
// distances, and the campus check that also gives the student's own position.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GEOFENCE } from '../js/config.js';
import { checkCampus, classify } from '../js/geofence.js';
import { distanceText, timeAgo } from '../js/lib/format.js';

const LIBRARY = { latitude: 28.5245, longitude: 77.5745 }; // on campus
const DELHI = { latitude: 28.6, longitude: 77.4 }; // far away

/** A fake Geolocation: answers each request from `answers`, and records the options. */
function fakeGeo(...answers) {
  const asked = [];
  const geolocation = {
    getCurrentPosition(ok, fail, options) {
      asked.push(options);
      const a = answers[Math.min(asked.length - 1, answers.length - 1)];
      queueMicrotask(() => (a.code ? fail(a) : ok({ coords: a })));
    },
  };
  globalThis.window = { isSecureContext: true };
  Object.defineProperty(globalThis, 'navigator', { value: { geolocation }, configurable: true });
  return asked;
}

test('timeAgo: steps of 5 s, then minutes, hours and days', () => {
  const now = 1_000_000_000;
  const ago = (ms) => timeAgo(now - ms, now);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(4_400), 'just now');
  assert.equal(ago(7_000), '5 s ago');
  assert.equal(ago(59_000), '55 s ago');
  assert.equal(ago(60_000), '1 min ago');
  assert.equal(ago(14 * 60_000), '14 min ago');
  assert.equal(ago(3 * 3_600_000), '3 h ago');
  assert.equal(ago(5 * 24 * 3_600_000), '5 days ago');
  assert.equal(timeAgo(now + 5_000, now), 'just now', 'a clock that is ahead shows no negative age');
});

test('distanceText: "Here", steps of 10 m, then kilometres', () => {
  assert.equal(distanceText(0), 'Here');
  assert.equal(distanceText(24), 'Here');
  assert.equal(distanceText(26), '30 m');
  assert.equal(distanceText(254), '250 m');
  assert.equal(distanceText(994), '990 m');
  assert.equal(distanceText(996), '1.0 km');
  assert.equal(distanceText(1_240), '1.2 km');
  assert.equal(distanceText(NaN), '', 'no distance, no text');
  assert.equal(distanceText(undefined), '');
});

test('classify: inside up to the margin, uncertain when the error circle reaches campus', () => {
  assert.equal(classify(LIBRARY.latitude, LIBRARY.longitude, 10).kind, 'inside');
  assert.equal(classify(DELHI.latitude, DELHI.longitude, 10).kind, 'outside');
  assert.equal(classify(DELHI.latitude, DELHI.longitude, 50_000).kind, 'uncertain');
});

test('campus check: a fix on campus is "inside" and gives the position for the map', async () => {
  const asked = fakeGeo({ ...LIBRARY, accuracy: 12 });
  const before = Date.now();
  const r = await checkCampus();
  assert.equal(r.kind, 'inside');
  assert.equal(r.position.lat, LIBRARY.latitude);
  assert.equal(r.position.lng, LIBRARY.longitude);
  assert.equal(r.position.accuracy, 12);
  assert.ok(r.position.at >= before && r.position.at <= Date.now());
  // One cheap request: no GPS, and a fix from the last seconds will do.
  assert.equal(asked.length, 1);
  assert.equal(asked[0].enableHighAccuracy, false);
  assert.equal(asked[0].maximumAge, GEOFENCE.maxAgeMs);
});

test('campus check: a tap and the location button take a new fix', async () => {
  let asked = fakeGeo({ ...LIBRARY, accuracy: 12 });
  await checkCampus({ fresh: true });
  assert.equal(asked[0].maximumAge, 0);
  assert.equal(asked[0].enableHighAccuracy, false);

  asked = fakeGeo({ ...LIBRARY, accuracy: 5 });
  const r = await checkCampus({ highAccuracy: true });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].enableHighAccuracy, true);
  assert.equal(asked[0].maximumAge, 0);
  assert.equal(r.position.accuracy, 5);
});

test('campus check: a rough fix outside asks the GPS once, then says "uncertain"', async () => {
  const rough = { ...DELHI, accuracy: 50_000 };
  let asked = fakeGeo(rough);
  let r = await checkCampus();
  assert.equal(asked.length, 2, 'low accuracy first, then one GPS request');
  assert.equal(asked[1].enableHighAccuracy, true);
  assert.deepEqual([r.kind, r.uncertain], ['outside', true]);

  // The GPS answer settles it.
  asked = fakeGeo(rough, { ...LIBRARY, accuracy: 8 });
  r = await checkCampus();
  assert.equal(r.kind, 'inside');
  assert.equal(r.position.accuracy, 8);
});

test('campus check: blocked or missing location gives no position', async () => {
  fakeGeo({ code: 1 });
  assert.deepEqual(await checkCampus(), { kind: 'denied' });
  fakeGeo({ code: 2 });
  assert.deepEqual(await checkCampus(), { kind: 'unavailable' });
  fakeGeo({ code: 3 });
  assert.deepEqual(await checkCampus(), { kind: 'unavailable' });
  globalThis.window = { isSecureContext: false };
  assert.deepEqual(await checkCampus(), { kind: 'insecure' });
});
