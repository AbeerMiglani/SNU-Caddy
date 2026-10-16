// Demo / pitch mode: virtual caddies drive real SNU roads with no backend.
//
// Each virtual caddy acts like a driver phone (Phase 3):
//   1. It makes a GPS fix every second (true position + small noise).
//   2. Now and then the fix is blurry (> 20 m) and the accuracy filter drops it.
//   3. The ping gate sends the fix only if it moved 5 m, or 30 s passed.
// So the student map gets the same kind of data it will get from Firebase.

import { DEMO } from './config.js';
import { DEMO_PARKED, DEMO_ROUTES } from './data/demo-routes.js';
import { bearingDeg, distanceM, lerpLatLng, offsetM } from './lib/geo.js';
import { createPingGate } from './lib/ping-gate.js';

const CRUISE_MS = DEMO.cruiseKmh / 3.6; // m/s
const ACCEL = 0.8; // m/s^2
const BRAKE = 1.0; // m/s^2
const TURN_SPEED = 2.5; // m/s through sharp corners
const SUBSTEPS = 4;

/** Small fast seeded random generator, so every pitch looks the same. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Normal-distributed noise (Box-Muller). */
function gaussian(rand) {
  const u = Math.max(rand(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** Pre-computed loop: points, distance at each point, turn sharpness at each point. */
function prepareRoute(route) {
  const pts = route.path.map(([lat, lng]) => ({ lat, lng }));
  const n = pts.length;
  const cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + distanceM(pts[i - 1], pts[i % n]));
  const turn = pts.map((p, i) => {
    const a = bearingDeg(pts[(i - 1 + n) % n], p);
    const b = bearingDeg(p, pts[(i + 1) % n]);
    return Math.abs(((((b - a) % 360) + 540) % 360) - 180);
  });
  return {
    pts,
    cum,
    turn,
    length: cum[n],
    stops: route.stops.map((s) => ({ at: cum[s.index], name: s.name })),
  };
}

/** Position and heading at distance `s` along the loop. */
function pointAt(r, s) {
  s = ((s % r.length) + r.length) % r.length;
  let lo = 0;
  let hi = r.pts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (r.cum[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  const a = r.pts[lo];
  const b = r.pts[(lo + 1) % r.pts.length];
  const segLen = r.cum[lo + 1] - r.cum[lo];
  const t = segLen > 0 ? (s - r.cum[lo]) / segLen : 0;
  return { pos: lerpLatLng(a, b, t), heading: bearingDeg(a, b), index: lo };
}

/** Distance ahead (along the loop) from s to target. */
function ahead(r, s, target) {
  return (((target - s) % r.length) + r.length) % r.length;
}

class VirtualCaddy {
  constructor(route, startFraction, status, rand) {
    this.id = route.id;
    this.name = route.name;
    this.line = route.line;
    this.route = prepareRoute(route);
    this.status = status;
    this.rand = rand;
    this.s = this.route.length * startFraction;
    this.v = 0;
    this.dwellLeft = 0;
    this.nextStop = this.findNextStop();
    this.gate = createPingGate();
    this.lastSent = null;
  }

  findNextStop() {
    let best = 0;
    let bestD = Infinity;
    this.route.stops.forEach((stop, i) => {
      const d = ahead(this.route, this.s, stop.at);
      if (d > 1 && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    return best;
  }

  /** Speed limit for the next part of the road (corners and the next stop). */
  targetSpeed(distToStop) {
    let limit = Math.min(CRUISE_MS, Math.sqrt(2 * BRAKE * Math.max(0, distToStop)));
    const r = this.route;
    const { index } = pointAt(r, this.s);
    for (let k = 1; k <= 4; k++) {
      const i = (index + k) % r.pts.length;
      const d = ahead(r, this.s, r.cum[i]);
      if (d > 15) break;
      if (r.turn[i] > 50) limit = Math.min(limit, TURN_SPEED + d * 0.25);
    }
    return limit;
  }

  /** Advance the physics by dt seconds. Returns a status change, if any. */
  step(dt) {
    let changed = false;
    if (this.dwellLeft > 0) {
      this.dwellLeft -= dt * 1000;
      if (this.dwellLeft <= 0) this.nextStop = (this.nextStop + 1) % this.route.stops.length;
      return changed;
    }
    const stop = this.route.stops[this.nextStop];
    const dist = ahead(this.route, this.s, stop.at);
    const vTarget = this.targetSpeed(dist);
    this.v =
      this.v < vTarget
        ? Math.min(vTarget, this.v + ACCEL * dt)
        : Math.max(vTarget, this.v - BRAKE * 2 * dt);
    const move = Math.max(this.v, 0.4) * dt; // Never stall before the stop.
    if (move >= dist) {
      this.s = stop.at;
      this.v = 0;
      const [min, max] = DEMO.dwellMs;
      this.dwellLeft = min + this.rand() * (max - min);
      if (this.rand() < DEMO.flipChance) {
        this.status = this.status === 'open' ? 'full' : 'open';
        changed = true;
      }
    } else {
      this.s += move;
    }
    return changed;
  }

  /** What the driver phone's GPS would report now. */
  gpsFix(now) {
    const { pos, heading } = pointAt(this.route, this.s);
    const blurry = this.rand() < DEMO.badFixChance;
    const spread = blurry ? 25 : DEMO.gpsNoiseM;
    const p = offsetM(pos, gaussian(this.rand) * spread, gaussian(this.rand) * spread);
    return {
      lat: p.lat,
      lng: p.lng,
      accuracy: blurry ? 30 + this.rand() * 30 : 3 + this.rand() * 6,
      heading: this.v > 0.5 ? heading : null,
      speed: this.v,
      t: now,
    };
  }

  record(fix) {
    return {
      id: this.id,
      name: this.name,
      line: this.line,
      status: this.status,
      lat: fix.lat,
      lng: fix.lng,
      heading: fix.heading,
      speed: fix.speed,
      ts: fix.t,
    };
  }
}

export class DemoSimulator {
  /**
   * @param {{ onUpdate: (record: object) => void, onRemove: (id: string) => void, speed?: number }} opts
   */
  constructor({ onUpdate, onRemove, speed = 1 }) {
    this.onUpdate = onUpdate;
    this.onRemove = onRemove;
    this.speed = Math.min(5, Math.max(0.5, Number(speed) || 1));
    this.caddies = [];
    this.timer = 0;
    this.running = false;
    this.stats = { fixes: 0, sent: 0, dropped: { inaccurate: 0, deadband: 0 } };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const rand = mulberry32(DEMO.seed);
    const starts = [0.12, 0.55, 0.3];
    const statuses = ['open', 'full', 'open'];
    this.caddies = DEMO_ROUTES.map(
      (route, i) =>
        new VirtualCaddy(route, starts[i % starts.length], statuses[i % statuses.length], rand),
    );

    const now = Date.now();
    // Caddy 04: parked at Parking 1, off shift for a while.
    this.onUpdate({
      id: DEMO_PARKED.id,
      name: DEMO_PARKED.name,
      status: 'offline',
      lat: DEMO_PARKED.position[0],
      lng: DEMO_PARKED.position[1],
      heading: 90,
      speed: 0,
      ts: now - DEMO.parkedMinutesAgo * 60_000,
    });
    for (const c of this.caddies) this.emitFix(c, now);
    this.resume();
  }

  stop() {
    if (!this.running) return;
    this.pause();
    this.running = false;
    for (const c of this.caddies) this.onRemove(c.id);
    this.onRemove(DEMO_PARKED.id);
    this.caddies = [];
  }

  /** Page hidden: stop the clock completely (no timers, no work). */
  pause() {
    clearInterval(this.timer);
    this.timer = 0;
  }

  resume() {
    if (!this.running || this.timer) return;
    this.timer = setInterval(() => this.tick(), DEMO.gpsTickMs);
  }

  tick() {
    const dt = (DEMO.gpsTickMs / 1000) * this.speed;
    const now = Date.now();
    for (const c of this.caddies) {
      let statusChanged = false;
      for (let i = 0; i < SUBSTEPS; i++) statusChanged = c.step(dt / SUBSTEPS) || statusChanged;
      // A status tap (Seats open / Full) is sent at once with the last sent position.
      if (statusChanged && c.lastSent) this.onUpdate(c.record(c.lastSent));
      this.emitFix(c, now);
    }
  }

  emitFix(c, now) {
    const fix = c.gpsFix(now);
    this.stats.fixes++;
    const verdict = c.gate.check(fix);
    if (!verdict.send) {
      this.stats.dropped[verdict.reason]++;
      return;
    }
    this.stats.sent++;
    c.lastSent = fix;
    this.onUpdate(c.record(fix));
  }
}
