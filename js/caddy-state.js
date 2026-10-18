// What a caddy's state means on the student map. Used for live data and the demo.
//
//   Moving       online, fresh data, it really moved in the last 60 s
//   Parked       online, fresh data, no real move for 60 s or more
//   Charging     online, fresh data, and the driver marked it as charging
//   Signal lost  online, but no new data for 90 s (dead zone, phone in a pocket)
//   Offline      the driver went offline, or the phone lost its connection
//
// Offline and Signal lost win over Charging: a charging phone that
// disconnects shows Offline.

import { LIVE } from './config.js';

export const STATE_TEXT = {
  moving: 'Moving',
  parked: 'Parked',
  charging: 'Charging',
  lost: 'Signal lost',
  offline: 'Offline',
};

/** List order: the caddies a student can catch first. */
export const STATE_ORDER = { moving: 0, parked: 1, charging: 2, lost: 3, offline: 4 };

/**
 * @param {{ online: boolean, ts: number, movedAt?: number|null, charging?: boolean }} c
 *   `ts` (last data) and `movedAt` (last real move) on this phone's clock.
 * @param {number} now
 * @returns {'moving'|'parked'|'charging'|'lost'|'offline'}
 */
export function caddyState(c, now) {
  if (!c.online) return 'offline';
  if (now - c.ts > LIVE.signalLostMs) return 'lost';
  if (c.charging === true) return 'charging';
  return Number.isFinite(c.movedAt) && now - c.movedAt < LIVE.parkedAfterMs ? 'moving' : 'parked';
}
