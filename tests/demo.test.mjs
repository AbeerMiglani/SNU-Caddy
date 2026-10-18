// Demo mode (js/demo.js): the fixtures it plays and what it sends.
// No browser: the simulator only needs a `document.hidden` flag.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { caddyState } from '../js/caddy-state.js';
import { DEMO, GPS_RULES } from '../js/config.js';
import { LANDMARKS } from '../js/data/campus.js';
import { DEMO_CHARGING, DEMO_PARKED, DEMO_ROUTES } from '../js/data/demo-routes.js';
import { DemoSimulator } from '../js/demo.js';
import { distanceM } from '../js/lib/geo.js';

const NOW = 1_800_000_000_000;
const point = ([lat, lng]) => ({ lat, lng });

/** Run `fn` with a fake page (hidden or not) and a fixed clock, then clean up. */
function withDemo({ hidden = false } = {}, fn) {
  const realNow = Date.now;
  let clock = NOW;
  Date.now = () => clock;
  globalThis.document = { hidden };
  const seen = [];
  const removed = [];
  const sim = new DemoSimulator({
    onUpdate: (r) => seen.push(r),
    onRemove: (id) => removed.push(id),
  });
  try {
    fn({ sim, seen, removed, setClock: (t) => (clock = t) });
  } finally {
    sim.stop();
    Date.now = realNow;
    delete globalThis.document;
  }
}
const count = (seen, id) => seen.filter((r) => r.id === id).length;

/** Metres from `p` to the segment a-b (flat map around p, like tools/build_campus_data.py). */
function segmentDistanceM(p, a, b) {
  const mPerDeg = (Math.PI / 180) * 6_371_000;
  const k = Math.cos((p.lat * Math.PI) / 180);
  const xy = (q) => [(q.lng - p.lng) * k * mPerDeg, (q.lat - p.lat) * mPerDeg]; // east, north of p
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
const demoIds = [...DEMO_ROUTES.map((r) => r.id), DEMO_PARKED.id, DEMO_CHARGING.id];

test('the charging caddy sits on a landmark, off every route and away from the parked caddy', () => {
  const landmark = LANDMARKS.find((l) => l.name === DEMO_CHARGING.near);
  assert.ok(
    landmark,
    `${DEMO_CHARGING.near} is not a landmark: rebuild with tools/build_campus_data.py`,
  );
  assert.deepEqual(DEMO_CHARGING.position, [landmark.lat, landmark.lng]);
  const stops = DEMO_ROUTES.flatMap((r) => r.stops.map((s) => s.name));
  assert.ok(
    !stops.includes(DEMO_CHARGING.near),
    'a route stop would put a moving caddy on top of it',
  );
  // Same rule as DEMO_CHARGING_MIN_M in tools/build_campus_data.py: caddies drive along
  // the lines between the path points (and from the last point back to the first).
  const at = point(DEMO_CHARGING.position);
  for (const route of DEMO_ROUTES) {
    route.path.forEach((p, i) => {
      const next = route.path[(i + 1) % route.path.length];
      assert.ok(
        segmentDistanceM(at, point(p), point(next)) >= 80,
        `${route.id} passes within 80 m of the charging caddy`,
      );
    });
  }
  assert.ok(distanceM(at, point(DEMO_PARKED.position)) >= 80);
});

test('start: every demo caddy is sent once, in a shown page and in a hidden tab', () => {
  for (const hidden of [false, true]) {
    withDemo({ hidden }, ({ sim, seen }) => {
      sim.start();
      for (const id of demoIds) assert.equal(count(seen, id), 1, `${id} (hidden: ${hidden})`);
      assert.equal(sim.timer !== 0, !hidden, 'the clock runs only in a shown page');
    });
  }
});

test('a hidden start sends the charging caddy again when the page is shown', () => {
  withDemo({ hidden: true }, ({ sim, seen }) => {
    sim.start();
    seen.length = 0;
    globalThis.document.hidden = false;
    sim.resume();
    assert.equal(count(seen, DEMO_CHARGING.id), 1);
    assert.ok(sim.timer, 'the clock runs now');
  });
});

test('resume after a pause sends a fresh charging update, and pause stops the clock', () => {
  withDemo({}, ({ sim, seen }) => {
    sim.start();
    sim.pause();
    assert.equal(sim.timer, 0);
    seen.length = 0;
    sim.resume();
    assert.equal(count(seen, DEMO_CHARGING.id), 1);
    sim.resume(); // already running: nothing more is sent
    assert.equal(count(seen, DEMO_CHARGING.id), 1);
  });
});

test('the charging caddy shows Charging: online, plugged in, moved a while ago', () => {
  withDemo({}, ({ sim, seen }) => {
    sim.start();
    const rec = seen.find((r) => r.id === DEMO_CHARGING.id);
    assert.equal(rec.name, DEMO_CHARGING.name);
    assert.equal(rec.online, true);
    assert.equal(rec.charging, true);
    assert.deepEqual([rec.lat, rec.lng], DEMO_CHARGING.position);
    assert.equal(rec.movedAt, NOW - DEMO.chargingMovedMinutesAgo * 60_000);
    assert.equal(caddyState(rec, NOW), 'charging');
  });
});

test('the charging caddy repeats its heartbeat, so it never turns Signal lost', () => {
  withDemo({}, ({ sim, seen, setClock }) => {
    sim.start();
    seen.length = 0;
    setClock(NOW + GPS_RULES.heartbeatMs - 1_000);
    sim.tick();
    assert.equal(count(seen, DEMO_CHARGING.id), 0);
    setClock(NOW + GPS_RULES.heartbeatMs);
    sim.tick();
    assert.equal(count(seen, DEMO_CHARGING.id), 1);
  });
});

test('stop removes every demo caddy', () => {
  withDemo({}, ({ sim, removed }) => {
    sim.start();
    sim.stop();
    assert.deepEqual([...removed].sort(), [...demoIds].sort());
  });
});
