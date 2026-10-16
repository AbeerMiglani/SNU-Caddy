// Campus geofence for students.
//
// Low power: one quick, low-accuracy location check when the app opens (or
// comes back to the screen), and a slow re-check while it stays open. No
// continuous GPS on student phones.
//
// Privacy: the location is used only on the phone. It is never sent anywhere.
//
// Note for the IT team: this is a usage policy, not a security boundary. The
// data itself is protected by the database rules (SNU login).

import { GEOFENCE } from './config.js';
import { CAMPUS_POLYGON } from './data/campus.js';
import { distanceOutsideM } from './lib/polygon.js';

/**
 * @typedef {'inside'|'outside'|'denied'|'unavailable'|'unsupported'|'insecure'} FenceKind
 * @typedef {{ kind: FenceKind, uncertain?: boolean, distanceM?: number, accuracyM?: number }} FenceResult
 */

/** Decide from one position fix. 'uncertain' = the error circle reaches campus. */
export function classify(lat, lng, accuracyM) {
  const d = distanceOutsideM({ lat, lng }, CAMPUS_POLYGON);
  if (d <= GEOFENCE.marginM) return { kind: 'inside', distanceM: d };
  if (accuracyM > d) return { kind: 'uncertain', distanceM: d };
  return { kind: 'outside', distanceM: d };
}

/** 'granted' | 'prompt' | 'denied' | 'unknown' (Permissions API is optional). */
export async function locationPermission() {
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state;
  } catch {
    return 'unknown';
  }
}

function getPosition(options) {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, options),
  );
}

/** @returns {Promise<FenceResult>} */
export async function checkCampus({ highAccuracy = false } = {}) {
  if (!window.isSecureContext) return { kind: 'insecure' };
  if (!('geolocation' in navigator)) return { kind: 'unsupported' };
  try {
    const pos = await getPosition({
      enableHighAccuracy: highAccuracy,
      maximumAge: highAccuracy ? 0 : GEOFENCE.maxAgeMs,
      timeout: GEOFENCE.timeoutMs,
    });
    const { latitude, longitude, accuracy } = pos.coords;
    const result = classify(latitude, longitude, accuracy);
    if (result.kind !== 'uncertain') return { ...result, accuracyM: accuracy };
    // Wi-Fi/cell location was too rough to decide: ask GPS once.
    if (!highAccuracy) return checkCampus({ highAccuracy: true });
    return { kind: 'outside', uncertain: true, distanceM: result.distanceM, accuracyM: accuracy };
  } catch (err) {
    // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
    return { kind: err?.code === 1 ? 'denied' : 'unavailable' };
  }
}
