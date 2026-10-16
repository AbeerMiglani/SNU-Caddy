// Decides which GPS fixes are worth sending to the database.
// The demo uses it now; the driver screen (Phase 3) uses the same rules.

import { GPS_RULES } from '../config.js';
import { distanceM } from './geo.js';

/**
 * @typedef {{ lat: number, lng: number, accuracy: number, t: number }} Fix
 *   `accuracy` is the error radius in metres; `t` is the fix time in ms.
 * @typedef {{ send: boolean, reason: 'inaccurate'|'first'|'moved'|'heartbeat'|'deadband' }} GateResult
 */

/**
 * Create a gate with its own memory of the last fix that was sent.
 * Rules (in this order):
 *  1. Drop blurry fixes (error radius above `maxAccuracyM`).
 *  2. Send the first good fix.
 *  3. Send if the caddy moved at least `minMoveM` from the last SENT fix.
 *  4. Send a heartbeat if `heartbeatMs` passed since the last sent fix.
 *  5. Otherwise drop it (deadband): a parked caddy stays quiet.
 */
export function createPingGate({ maxAccuracyM, minMoveM, heartbeatMs } = GPS_RULES) {
  /** @type {Fix | null} */
  let lastSent = null;

  return {
    /** @param {Fix} fix @returns {GateResult} */
    check(fix) {
      // Reject missing, null, NaN and string accuracy values too.
      if (!(typeof fix.accuracy === 'number' && fix.accuracy <= maxAccuracyM)) {
        return { send: false, reason: 'inaccurate' };
      }

      let reason = null;
      if (!lastSent) reason = 'first';
      else if (distanceM(lastSent, fix) >= minMoveM) reason = 'moved';
      else if (fix.t - lastSent.t >= heartbeatMs) reason = 'heartbeat';

      if (!reason) return { send: false, reason: 'deadband' };
      lastSent = fix;
      return { send: true, reason };
    },

    /** Forget the last sent fix (for example when a shift starts again). */
    reset() {
      lastSent = null;
    },
  };
}
