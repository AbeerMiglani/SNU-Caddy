// One-time driver phone enrollment ("device binding").
//
// 1. An admin makes a setup code on admin.html. It is 120 random bits
//    (24 Crockford base32 characters), lives 10 minutes and works once.
//    It is shown as a QR code (a link to this app with #enroll=CODE) and as
//    typed text.
// 2. On the driver phone, 5 quick taps on the logo open the setup screen.
//    The admin scans the QR (or types the code), or simply scans the QR with
//    the phone's camera app, which opens the link.
// 3. The phone signs in anonymously. Its Firebase uid becomes the device
//    identity, and Firebase keeps that session on the phone.
// 4. In ONE atomic database update, the phone writes drivers/{uid} and marks
//    the code as used by itself. The security rules accept this only for a
//    real, unused, unexpired code. From then on, only this uid can write to
//    caddies/{caddyId}. An admin revokes the phone by deleting drivers/{uid}.

import { readOnce, waitConnected } from './firebase.js';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
export const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{24}$/;

const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const JSQR_SRI = 'sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx';

export class EnrollError extends Error {}

/** A new random 120-bit setup code (used by the admin page). */
export function newSetupCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(15));
  let out = '';
  let value = 0;
  let bits = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** "ABCD-EFGH-..." for people to read and type. */
export function formatCode(code) {
  return code.match(/.{1,4}/g).join('-');
}

/**
 * Accept a scanned setup link (…#enroll=CODE) or a typed code with dashes,
 * spaces or lower case. Common look-alikes are fixed (O -> 0, I/L -> 1).
 * @returns {string|null}
 */
export function normalizeCode(text) {
  let s = String(text ?? '').trim();
  const fromLink = s.match(/[#?&]enroll=([0-9A-Za-z-]+)/);
  if (fromLink) s = fromLink[1];
  s = s.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(s) ? s : null;
}

/** A short label so admins can tell phones apart (no personal data). */
function deviceLabel() {
  const ua = navigator.userAgent;
  const os = ua.match(/Android [\d.]+/)?.[0] ?? ua.match(/iPhone OS [\d_]+/)?.[0] ?? 'Phone';
  const browser = ua.match(/(Firefox|Chrome|Version)\/(\d+)/);
  return `${os}${browser ? ` · ${browser[1] === 'Version' ? 'Safari' : browser[1]} ${browser[2]}` : ''}`.slice(
    0,
    80,
  );
}

/**
 * Step 1: check the code with the session that is already on the phone (a
 * student's, or a new anonymous one). Nothing changes yet, so a typo or an
 * expired code does not sign a student out.
 * @returns {Promise<{ caddyId: string, expiresAt: number }>}
 */
export async function checkSetupCode(fb, code) {
  const { A, D, auth, db } = fb;
  await auth.authStateReady();
  if (!auth.currentUser) await A.signInAnonymously(auth);
  try {
    await waitConnected(fb);
  } catch {
    throw new EnrollError('No connection. Check the internet and try again.');
  }
  const snap = await D.get(D.ref(db, `enrollCodes/${code}`));
  if (!snap.exists()) {
    throw new EnrollError('This setup code does not exist. Check it, or make a new one.');
  }
  const info = snap.val();
  if (info.usedBy) {
    throw new EnrollError('This setup code was already used. Make a new one on the admin page.');
  }
  const offset = (await readOnce(fb, '.info/serverTimeOffset')).val() ?? 0;
  if (info.expiresAt <= Date.now() + offset) {
    throw new EnrollError('This setup code has expired. Make a new one on the admin page.');
  }
  return info;
}

/**
 * Step 2: become an anonymous driver phone and claim the code, in ONE atomic
 * update. The security rules accept it only for a valid, unused, unexpired code.
 * The caller confirms first if a student is signed in on this phone.
 * @returns {Promise<{ caddyId: string, name: string, uid: string }>}
 */
export async function claimSetupCode(fb, code, info) {
  const { A, D, auth, db } = fb;
  if (auth.currentUser && !auth.currentUser.isAnonymous) await A.signOut(auth);
  if (!auth.currentUser) await A.signInAnonymously(auth);
  const uid = auth.currentUser.uid;
  // Signing a live student out makes the student map close the database
  // connection (js/live.js detach -> goOffline). Open it again for the claim.
  D.goOnline(db);

  try {
    // Not raced against a timeout: a queued write would still reach the server
    // later and link the phone, while the phone thinks it failed.
    await D.update(D.ref(db), {
      [`drivers/${uid}`]: {
        caddyId: info.caddyId,
        code,
        enrolledAt: D.serverTimestamp(),
        device: deviceLabel(),
      },
      [`enrollCodes/${code}/usedBy`]: uid,
      [`enrollCodes/${code}/usedAt`]: D.serverTimestamp(),
    });
  } catch {
    // Someone used the code a moment earlier, or it expired just now.
    throw new EnrollError('The code was not accepted. Make a new one and try again.');
  }

  const name = await D.get(D.ref(db, `fleet/${info.caddyId}/name`))
    .then((s) => s.val() ?? info.caddyId)
    .catch(() => info.caddyId);
  // Ask the browser not to clear this site's storage under pressure, so the
  // phone stays linked. Chrome grants this to installed apps.
  navigator.storage?.persist?.().catch(() => {});
  return { caddyId: info.caddyId, name, uid };
}

// --- QR scanner ---------------------------------------------------------------

let jsQRLoading = null;
function loadJsQR() {
  jsQRLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSQR_URL;
    s.integrity = JSQR_SRI;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.jsQR);
    s.onerror = () => {
      jsQRLoading = null;
      reject(new Error('QR scanner could not load'));
    };
    document.head.append(s);
  });
  return jsQRLoading;
}

/**
 * Scan QR codes from the back camera until a valid setup code is found.
 * Uses the built-in BarcodeDetector when the browser has it; otherwise jsQR.
 * @returns {Promise<{ stop: () => void }>}
 */
export async function startScanner(video, onCode) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: 'environment' } },
    audio: false,
  });
  let detector = null;
  let jsQR = null;
  try {
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play();
    if ('BarcodeDetector' in window) {
      try {
        const formats = await window.BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) {
          detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        }
      } catch {
        detector = null;
      }
    }
    if (!detector) jsQR = await loadJsQR();
  } catch (err) {
    // Never leave the camera on after a failed start.
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
    throw err;
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  let stopped = false;
  let timer = 0;
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const tick = async () => {
    if (stopped) return;
    let text = null;
    try {
      if (video.readyState >= 2 && video.videoWidth) {
        if (detector) {
          text = (await detector.detect(video))[0]?.rawValue ?? null;
        } else {
          const w = 480;
          const h = Math.round((video.videoHeight / video.videoWidth) * w);
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(video, 0, 0, w, h);
          text = jsQR(ctx.getImageData(0, 0, w, h).data, w, h)?.data ?? null;
        }
      }
    } catch {
      text = null; // A bad frame; try the next one.
    }
    const code = text && normalizeCode(text);
    if (code && !stopped) {
      stop();
      onCode(code);
      return;
    }
    if (!stopped) timer = setTimeout(tick, 200); // 5 scans/s is plenty.
  };
  tick();
  return { stop };
}
