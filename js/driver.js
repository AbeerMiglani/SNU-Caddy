// Driver phone: the OLED-black driver screen.
//
// Phase 2: check that this phone is still linked, and react at once when an
// admin revokes it. Phase 3 adds GO / Seats open / Full / Go offline, GPS
// throttling, Screen Wake Lock and onDisconnect.

import { loadFirebase } from './firebase.js';

const KEY = 'snucaddy.driver';
const CADDY_ID_RE = /^caddy_\d{2}$/;

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

/**
 * @param {{ name: HTMLElement, status: HTMLElement }} els
 * @param {() => void} onUnlinked  called after the phone lost its link
 */
export async function verifyLink(binding, els, onUnlinked) {
  els.name.textContent = binding.name || binding.caddyId;
  els.status.textContent = 'Checking link…';
  els.status.dataset.state = 'checking';

  const unlink = async (fb, message) => {
    clearBinding();
    els.status.textContent = message;
    els.status.dataset.state = 'error';
    await fb?.A.signOut(fb.auth).catch(() => {});
    setTimeout(onUnlinked, 2500);
  };

  let fb;
  try {
    fb = await loadFirebase();
  } catch {
    // No network on boot: stay a driver phone; Phase 3 retries in its loop.
    els.status.textContent = 'No connection. This phone stays linked.';
    els.status.dataset.state = 'offline';
    return;
  }

  await fb.auth.authStateReady(); // The saved session is restored from IndexedDB (works offline).
  const user = fb.auth.currentUser;
  if (!user || !user.isAnonymous || user.uid !== binding.uid) {
    await unlink(fb, 'This phone is no longer linked. Ask an admin for a new setup code.');
    return;
  }

  // Live: an admin's "Revoke" reaches this phone within a second.
  fb.D.onValue(
    fb.D.ref(fb.db, `drivers/${user.uid}`),
    async (snap) => {
      if (!snap.exists()) {
        await unlink(fb, 'An admin unlinked this phone.');
        return;
      }
      const { caddyId } = snap.val();
      const name = (await fb.D.get(fb.D.ref(fb.db, `fleet/${caddyId}/name`))).val() ?? caddyId;
      if (caddyId !== binding.caddyId || name !== binding.name) {
        saveBinding({ ...binding, caddyId, name });
      }
      els.name.textContent = name;
      els.status.textContent = 'Linked. Driver controls arrive in Phase 3.';
      els.status.dataset.state = 'ok';
    },
    () => {
      els.status.textContent = 'Could not check the link. Retrying when online.';
      els.status.dataset.state = 'offline';
    },
  );
}
