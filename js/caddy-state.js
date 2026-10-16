// What a caddy's state means on the student map. Used for live data and the demo.
//
//   Moving       online, fresh data, it really moved in the last 60 s
//   Parked       online, fresh data, no real move for 60 s or more
//   Signal lost  online, but no new data for 90 s (dead zone, phone in a pocket)
//   Offline      the driver went offline, or the phone lost its connection

import { LIVE } from './config.js';

export const STATE_TEXT = {
  moving: 'Moving',
  parked: 'Parked',
  lost: 'Signal lost',
  offline: 'Offline',
};

/** List order: the caddies a student can catch first. */
export const STATE_ORDER = { moving: 0, parked: 1, lost: 2, offline: 3 };

/**
 * @param {{ online: boolean, ts: number, movedAt?: number|null }} c
 *   `ts` (last data) and `movedAt` (last real move) on this phone's clock.
 * @param {number} now
 * @returns {'moving'|'parked'|'lost'|'offline'}
 */
export function caddyState(c, now) {
  if (!c.online) return 'offline';
  if (now - c.ts > LIVE.signalLostMs) return 'lost';
  return Number.isFinite(c.movedAt) && now - c.movedAt < LIVE.parkedAfterMs ? 'moving' : 'parked';
}
