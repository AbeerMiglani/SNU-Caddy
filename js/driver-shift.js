// Driver shift engine: GPS -> filters -> database, for one caddy.
//
//   GO            wake lock on, GPS watch on (high accuracy, maximumAge 0)
//   each fix      drop if blurry (> 20 m) or off campus; send if it is the
//                 first fix, the caddy moved >= 5 m, or 30 s passed (heartbeat)
//   connection    no writes while offline; on reconnect, send the newest fix
//                 at once and register onDisconnect again (dead-zone recovery)
//   Go offline    online:false, GPS and wake lock off
//
// The engine knows nothing about the page: the GPS, the database, the wake
// lock and storage are passed in. tests/driver-shift.test.mjs drives it with
// fakes and fake timers.

import { DRIVER, GPS_RULES } from './config.js';
import { bearingDeg, distanceM } from './lib/geo.js';
import { createPingGate } from './lib/ping-gate.js';

/**
 * @typedef {'open'|'full'} SeatStatus
 * @typedef {object} Store  The caddy's database node, as the engine needs it.
 * @property {(f: { lat: number, lng: number, accuracy: number, bearing?: number, status: SeatStatus }) => Promise<void>} sendPosition
 *   One update with online:true and lastUpdated = server time.
 * @property {(f: object) => Promise<void>} setFields   A plain update ({ status } or { online: false }).
 * @property {() => Promise<void>} armDisconnect        onDisconnect: online:false.
 * @property {() => Promise<void>} cancelDisconnect
 * @property {(cb: (connected: boolean) => void) => () => void} onConnection
 *
 * @typedef {object} ShiftState
 * @property {'idle'|'on'} mode
 * @property {SeatStatus} status
 * @property {boolean} connected
 * @property {'waiting'|'ok'|'weak'|'lost'|'outside'|'unavailable'} gps
 * @property {number|null} accuracy   metres, newest fix (also a blurry one)
 * @property {number|null} sentAt     phone time of the last confirmed position write
 * @property {boolean} refused        the server refused several writes in a row
 * @property {number|null} since      shift start (phone time)
 * @property {null|'driver'|'paused'|'denied'|'revoked'} ended   why the last shift ended
 */

const round = (x, digits) => Number(x.toFixed(digits));

/**
 * @param {object} deps
 * @param {Store} deps.store
 * @param {Pick<Geolocation, 'watchPosition'|'clearWatch'|'getCurrentPosition'>} deps.geo
 * @param {{ acquire(): void, release(): void }} deps.wake
 * @param {(lat: number, lng: number) => boolean} deps.onCampus
 * @param {{ save(v: object): void, clear(): void }} deps.persist
 * @param {(s: ShiftState) => void} deps.onChange
 * @param {Document | EventTarget & { visibilityState: string }} [deps.doc]
 */
export function createShift({ store, geo, wake, onCampus, persist, onChange, doc = document }) {
  const now = () => Date.now();
  const gate = createPingGate(GPS_RULES);

  /** @type {ShiftState} */
  const state = {
    mode: 'idle',
    status: 'open',
    connected: false,
    gps: 'waiting',
    accuracy: null,
    sentAt: null,
    refused: false,
    since: null,
    ended: null,
  };

  let gen = 0; // shift number: late GPS or database callbacks from an old shift are ignored
  let watchId = null;
  let tickTimer = null;
  let pumpTimer = null;
  let oneShotAt = 0; // a getCurrentPosition() call is running since then (0 = none)
  let lastFixAt = 0; // any fix, also a blurry one
  let good = null; // newest sharp, on-campus fix
  let sent = null; // last fix the server confirmed
  let bearing = null; // last known direction of travel
  let want = null; // why the next position write is needed; null = nothing to send
  let inFlight = false;
  let writeStartedAt = -Infinity;
  let ackAt = -Infinity;
  let failures = 0;
  let holdUntil = 0; // back-off after refused writes
  let armed = false; // onDisconnect is registered on the current connection
  let wrote = false; // this shift's data is in the database
  let offCampusMarked = false;
  let hiddenAt = null;

  const emit = () => onChange?.({ ...state });
  const save = () => persist.save({ status: state.status, since: state.since, aliveAt: now() });

  // --- Connection (also while idle, so the screen can show it) --------------
  const offConnection = store.onConnection((up) => {
    if (up === state.connected) return;
    state.connected = up;
    // A new connection has no onDisconnect yet. (The server runs the old one
    // when it notices that the old connection is gone.)
    armed = false;
    if (up && state.mode === 'on' && state.gps !== 'outside') {
      want ??= 'reconnect'; // dead-zone recovery: the newest fix goes out at once
      pump();
    }
    emit();
  });

  // --- Sending ----------------------------------------------------------------
  /** Send the newest fix when the rate limits allow it. Never more than one write in flight. */
  function pump() {
    clearTimeout(pumpTimer);
    pumpTimer = null;
    if (state.mode !== 'on' || !want || inFlight || !state.connected) return;
    if (!good || now() - good.t > DRIVER.fixFreshMs) return; // the next fresh fix calls pump()
    const at = Math.max(writeStartedAt + DRIVER.minWriteGapMs, ackAt + DRIVER.ackGapMs, holdUntil);
    if (now() < at) {
      pumpTimer = setTimeout(pump, at - now());
      return;
    }
    send(good);
  }

  function directionTo(fix) {
    const hasHeading = typeof fix.heading === 'number' && Number.isFinite(fix.heading);
    const slow = typeof fix.speed === 'number' && fix.speed <= 0.5;
    if (hasHeading && !slow) bearing = fix.heading;
    else if (!hasHeading && sent && distanceM(sent, fix) >= GPS_RULES.minMoveM) {
      bearing = bearingDeg(sent, fix);
    }
    // 359.6 rounds to 360, which the rules reject: wrap it to 0.
    return bearing === null ? null : Math.round(bearing) % 360;
  }

  function send(fix) {
    const myGen = gen;
    const reason = want;
    want = null;
    inFlight = true;
    writeStartedAt = now();
    const fields = {
      lat: round(fix.lat, 6), // 6 decimals = 0.1 m
      lng: round(fix.lng, 6),
      accuracy: round(fix.accuracy, 1),
      status: state.status,
    };
    const dir = directionTo(fix);
    if (dir !== null) fields.bearing = dir;

    store.sendPosition(fields).then(
      () => {
        inFlight = false;
        ackAt = now();
        failures = 0;
        holdUntil = 0;
        if (myGen !== gen) return;
        sent = fix;
        wrote = true;
        offCampusMarked = false;
        state.sentAt = ackAt;
        state.refused = false;
        save();
        if (!armed && state.connected) {
          // Registered only now: the rules accept onDisconnect's online:false
          // only for a caddy node that already exists.
          armed = true;
          store.armDisconnect().catch(() => {
            armed = false;
          });
        }
        emit();
        pump();
      },
      () => {
        // Refused (too fast after a reconnect, campus box, or revoked: the
        // revoke itself arrives through the drivers/{uid} listener).
        inFlight = false;
        ackAt = now();
        failures += 1;
        holdUntil = now() + Math.min(30_000, 1000 * 2 ** failures);
        if (myGen !== gen) return;
        want ??= reason;
        state.refused = failures >= DRIVER.refusedAfter;
        emit();
        pump();
      },
    );
  }

  // --- GPS ----------------------------------------------------------------------
  function onFix(pos, myGen) {
    if (myGen !== gen || state.mode !== 'on') return;
    const c = pos.coords;
    const t = now();
    lastFixAt = t;
    state.accuracy = Number.isFinite(c.accuracy) ? Math.round(c.accuracy) : null;
    const fix = {
      lat: c.latitude,
      lng: c.longitude,
      accuracy: c.accuracy,
      heading: c.heading,
      speed: c.speed,
      t, // phone receive time: some phones put GPS time with an offset in pos.timestamp
    };

    if (!(typeof c.accuracy === 'number' && c.accuracy <= GPS_RULES.maxAccuracyM)) {
      state.gps = 'weak'; // students keep the last good position
      emit();
      return;
    }
    if (!onCampus(fix.lat, fix.lng)) {
      state.gps = 'outside';
      good = null;
      want = null;
      markOffCampus();
      emit();
      return;
    }

    state.gps = 'ok';
    good = fix;
    if (offCampusMarked) want ??= 'back';
    const verdict = gate.check(fix);
    if (verdict.send) want ??= verdict.reason;
    emit();
    pump();
  }

  /** Off campus: the location is not shared, and students see the caddy as offline. */
  function markOffCampus() {
    if (offCampusMarked || !wrote) return;
    offCampusMarked = true;
    store.setFields({ online: false }).catch(() => {
      offCampusMarked = false;
    });
  }

  function onGpsError(err, myGen) {
    if (myGen !== gen || state.mode !== 'on') return;
    if (err?.code === 1) {
      stop('denied'); // PERMISSION_DENIED: nothing works without location
      return;
    }
    // POSITION_UNAVAILABLE (location off, no signal) or TIMEOUT. The watch goes on.
    if (err?.code === 2) state.gps = 'unavailable';
    emit();
  }

  /** Some browsers report only changes. A parked caddy then needs a fresh fix for its heartbeat. */
  function askOneFix() {
    if (!geo.getCurrentPosition) return;
    if (oneShotAt && now() - oneShotAt < 40_000) return; // one is running (stuck after 40 s)
    oneShotAt = now();
    const myGen = gen;
    geo.getCurrentPosition(
      (pos) => {
        oneShotAt = 0;
        onFix(pos, myGen);
      },
      (err) => {
        oneShotAt = 0;
        onGpsError(err, myGen);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }

  function tick() {
    if (state.mode !== 'on') return;
    const t = now();
    if (lastFixAt && t - lastFixAt > DRIVER.gpsLostMs && state.gps !== 'lost') {
      state.gps = 'lost';
      emit();
    }
    if (state.sentAt === null || state.gps === 'outside') return;
    if (t - state.sentAt < GPS_RULES.heartbeatMs) return;
    // Heartbeat due: resend the newest fix if it is fresh, else ask the GPS.
    if (good && t - good.t <= DRIVER.fixFreshMs) {
      const verdict = gate.check({ ...good, t });
      if (verdict.send) want ??= verdict.reason;
      pump();
    } else {
      askOneFix();
    }
  }

  // --- Page visibility --------------------------------------------------------------
  // In the background the browser stops the GPS and the timers. Students then
  // see "Signal lost" after 90 s, and "Offline" when the connection closes.
  function onVisibility() {
    if (doc.visibilityState === 'hidden') {
      hiddenAt = now();
      if (state.mode === 'on') save();
      return;
    }
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (state.mode !== 'on') return;
    if (away >= DRIVER.resumeWithinMs) {
      stop('paused'); // the driver probably forgot the phone: no ghost caddy
      return;
    }
    askOneFix(); // the watch may need a moment to wake up
    tick();
  }
  doc.addEventListener('visibilitychange', onVisibility);

  // --- Shift ------------------------------------------------------------------
  /**
   * Start a shift. `resume` continues a shift after a reload, with its seat
   * status and start time.
   * @param {{ status?: SeatStatus, since?: number }} [resume]
   */
  function go(resume) {
    if (state.mode === 'on') return;
    gen += 1;
    const myGen = gen;
    Object.assign(state, {
      mode: 'on',
      status: resume?.status === 'full' ? 'full' : 'open',
      gps: 'waiting',
      accuracy: null,
      sentAt: null,
      refused: false,
      since: resume?.since ?? now(),
      ended: null,
    });
    gate.reset();
    good = null;
    sent = null;
    bearing = null;
    want = 'start';
    failures = 0;
    holdUntil = 0;
    wrote = false;
    offCampusMarked = false;
    lastFixAt = 0;
    oneShotAt = 0;
    hiddenAt = null;

    wake.acquire();
    watchId = geo.watchPosition(
      (pos) => onFix(pos, myGen),
      (err) => onGpsError(err, myGen),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
    tickTimer = setInterval(tick, DRIVER.tickMs);
    save();
    emit();
  }

  /** @param {'driver'|'paused'|'denied'|'revoked'} reason */
  function stop(reason) {
    if (state.mode !== 'on') return;
    gen += 1;
    if (watchId !== null) geo.clearWatch(watchId);
    watchId = null;
    clearInterval(tickTimer);
    clearTimeout(pumpTimer);
    tickTimer = pumpTimer = null;
    want = null;
    wake.release();
    // A revoked phone may not write any more (the admin page set online:false).
    if (wrote && reason !== 'revoked') {
      // Students first, then remove the server-side hook. Offline, the SDK
      // sends both when the phone reconnects (the server ran onDisconnect anyway).
      store.setFields({ online: false }).catch(() => {});
      store.cancelDisconnect().catch(() => {});
    }
    armed = false;
    Object.assign(state, {
      mode: 'idle',
      gps: 'waiting',
      accuracy: null,
      refused: false,
      ended: reason,
    });
    persist.clear();
    emit();
  }

  /** @param {SeatStatus} status */
  function setStatus(status) {
    if (status !== 'open' && status !== 'full') return;
    if (state.mode !== 'on' || status === state.status) return;
    state.status = status;
    save();
    // Every position write carries the status too, so a lost tap heals itself.
    if (wrote && !offCampusMarked) store.setFields({ status }).catch(() => {});
    emit();
  }

  /** Stop listening for good (the page is going away or the phone was unlinked). */
  function dispose(reason = 'revoked') {
    stop(reason);
    offConnection();
    doc.removeEventListener('visibilitychange', onVisibility);
  }

  emit();
  return {
    go,
    stop,
    setStatus,
    dispose,
    get state() {
      return { ...state };
    },
  };
}
