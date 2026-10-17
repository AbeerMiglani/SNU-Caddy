// Hidden driver-phone setup screen. main.js loads this module only when it is
// needed: after 5 quick taps on a logo, or for a #enroll=CODE link from the
// admin QR. See js/enroll.js for the security model.

import { isSnuUser } from './auth.js';
import { saveBinding } from './driver.js';
import {
  EnrollError,
  checkSetupCode,
  claimSetupCode,
  formatCode,
  normalizeCode,
  startScanner,
} from './enroll.js';
import { FIREBASE_ON, firebaseLoadFailed, loadFirebase } from './firebase.js';

let ui = null;

/**
 * Open the setup dialog.
 * @param {HTMLDialogElement} dialog
 * @param {string|null} [fromLink]  a '#enroll=CODE' hash, if the app was opened from the QR
 */
export function openEnrollment(dialog, fromLink = null) {
  ui ??= createUi(dialog);
  ui.open(fromLink ? normalizeCode(fromLink) : null);
}

function createUi(dialog) {
  const $ = (sel) => dialog.querySelector(sel);
  const form = $('#enroll-form');
  const input = $('#enroll-code');
  const status = $('#enroll-status');
  const scanBox = $('#enroll-scan');
  const video = $('#enroll-video');
  const scanBtn = $('#enroll-scan-btn');
  const linkBtn = $('#enroll-link');
  let scanner = null;
  let starting = null; // token of a camera start that is still in progress
  let busy = false;

  const say = (text, state = '') => {
    status.textContent = text;
    status.dataset.state = state;
  };

  function stopScan() {
    starting = null; // a start that is still running stops itself when it ends
    scanner?.stop();
    scanner = null;
    scanBox.hidden = true;
    scanBtn.textContent = 'Scan QR code';
  }

  function setBusy(on) {
    busy = on;
    // aria-disabled, not disabled: disabling the focused button would drop focus.
    linkBtn.setAttribute('aria-disabled', String(on));
    scanBtn.setAttribute('aria-disabled', String(on));
  }

  dialog.addEventListener('close', stopScan);
  $('#enroll-cancel').addEventListener('click', () => dialog.close());
  // Stop the camera when the app goes to the background.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScan();
  });

  scanBtn.addEventListener('click', async () => {
    if (busy) return;
    // While the camera starts or runs, this button is "Stop camera".
    if (scanner || starting) {
      stopScan();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      say('The camera needs the https:// address. Type the code instead.', 'error');
      return;
    }
    const token = {};
    starting = token;
    scanBox.hidden = false;
    scanBtn.textContent = 'Stop camera';
    say('Point the camera at the setup QR.');
    try {
      const started = await startScanner(video, (code) => {
        scanner = null;
        scanBox.hidden = true;
        scanBtn.textContent = 'Scan QR code';
        input.value = formatCode(code);
        link(code);
      });
      // Cancelled, closed or hidden while the camera was starting.
      if (starting !== token || !dialog.open || document.hidden) {
        started.stop();
        return;
      }
      starting = null;
      scanner = started;
    } catch (err) {
      if (starting !== token) return;
      stopScan();
      say(
        err?.name === 'NotAllowedError'
          ? 'Camera access is blocked. Allow the camera, or type the code.'
          : err?.name === 'NotFoundError'
            ? 'No camera found. Type the code instead.'
            : 'The camera did not start. Type the code instead.',
        'error',
      );
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode(input.value);
    if (!code) {
      say('That code is not valid. It has 24 letters and numbers.', 'error');
      return;
    }
    link(code);
  });

  async function link(code) {
    if (busy || !FIREBASE_ON) return;
    setBusy(true);
    say('Checking the setup code…');
    let fb = null;
    let linked = false;
    try {
      fb = await loadFirebase();
      // 1. Check the code first: a typo must not sign a student out.
      const info = await checkSetupCode(fb, code);
      const current = fb.auth.currentUser;
      if (
        isSnuUser(current) &&
        !window.confirm(
          `This phone is signed in as ${current.email}. A driver phone cannot be a student phone. Sign out and link it?`,
        )
      ) {
        say('Not linked.');
        return;
      }
      // 2. Claim it.
      say('Linking this phone…');
      const result = await claimSetupCode(fb, code, info);
      linked = true;
      saveBinding(result);
      say(`Linked to ${result.name}. Opening the driver screen…`, 'ok');
      setTimeout(() => location.replace(`driver.html${location.search}`), 900);
    } catch (err) {
      if (err instanceof EnrollError) say(err.message, 'error');
      else if (firebaseLoadFailed())
        say('No connection. Check the internet, then reload the page.', 'error');
      else if (err?.code === 'auth/operation-not-allowed')
        say('Anonymous sign-in is off. (Admin: turn it on in Firebase Authentication.)', 'error');
      else if (err?.code === 'auth/network-request-failed')
        say('No connection. Check the internet and try again.', 'error');
      else say('Linking did not work. Try again, or make a new code.', 'error');
    } finally {
      setBusy(false);
      // The code check opened a database connection. Without a link, and with
      // no live map using it, close it again (the free plan allows 100).
      if (!linked && fb && document.documentElement.dataset.live !== 'true') {
        fb.D.goOffline(fb.db);
      }
    }
  }

  return {
    open(prefill) {
      if (!dialog.open) {
        say(FIREBASE_ON ? '' : 'Firebase is not set up yet (docs/FIREBASE_SETUP.md).', 'error');
        input.value = prefill ? formatCode(prefill) : '';
        dialog.showModal();
      }
      if (prefill) say('Setup code received. Tap “Link this phone”.');
    },
  };
}
