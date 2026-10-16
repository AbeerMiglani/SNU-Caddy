// The driver-phone binding stored on the phone (written by the 5-tap setup).
// The driver screen itself is js/driver-screen.js.

const KEY = 'snucaddy.driver';
export const CADDY_ID_RE = /^caddy_\d{2}$/;

/**
 * The local hint that this phone is a driver phone. It only decides which
 * screen opens. The real permission is drivers/{uid} in the database.
 * @returns {{ caddyId: string, name: string, uid: string } | null}
 */
export function readBinding() {
  try {
    const b = JSON.parse(localStorage.getItem(KEY));
    return b && CADDY_ID_RE.test(b.caddyId) && typeof b.uid === 'string' ? b : null;
  } catch {
    return null;
  }
}

export function saveBinding(binding) {
  localStorage.setItem(KEY, JSON.stringify({ ...binding, boundAt: Date.now() }));
}

export function clearBinding() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
