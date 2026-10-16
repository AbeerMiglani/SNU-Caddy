// Hidden driver-phone setup screen: 5 quick taps on the logo, or a
// #enroll=CODE link from the admin QR. See js/enroll.js for the security model.

import { isSnuUser } from './auth.js';
import { saveBinding } from './driver.js';
import {
  EnrollError,
  enrollThisPhone,
  formatCode,
  normalizeCode,
  onFiveTaps,
  startScanner,
} from './enroll.js';
import { FIREBASE_ON, loadFirebase } from './firebase.js';

/**
 * @param {Element[]} triggers  the logos (header logo, and the one on the sign-in screen)
 * @param {HTMLDialogElement} dialog
 */
export function setupEnrollment(triggers, dialog) {
  const $ = (sel) => dialog.querySelector(sel);
  const form = $('#enroll-form');
  const input = $('#enroll-code');
  const status = $('#enroll-status');
  const scanBox = $('#enroll-scan');
  const video = $('#enroll-video');
  const scanBtn = $('#enroll-scan-btn');
  const linkBtn = $('#enroll-link');
  let scanner = null;
  let busy = false;

  const say = (text, state = '') => {
    status.textContent = text;
    status.dataset.state = state;
  };

  function stopScan() {
    scanner?.stop();
    scanner = null;
    scanBox.hidden = true;
    scanBtn.textContent = 'Scan QR code';
  }

  function open(prefill = null) {
    if (dialog.open) return;
    say(FIREBASE_ON ? '' : 'Firebase is not set up yet (docs/FIREBASE_SETUP.md).', 'error');
    input.value = prefill ? formatCode(prefill) : '';
    dialog.showModal();
    if (prefill) say('Setup code received. Tap “Link this phone”.');
  }

  dialog.addEventListener('close', stopScan);
  $('#enroll-cancel').addEventListener('click', () => dialog.close());
  // Stop the camera when the app goes to the background.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopScan();
  });

  scanBtn.addEventListener('click', async () => {
    if (scanner) {
      stopScan();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      say('The camera needs the https:// address. Type the code instead.', 'error');
      return;
    }
    scanBox.hidden = false;
    scanBtn.textContent = 'Stop camera';
    say('Point the camera at the setup QR.');
    try {
      scanner = await startScanner(video, (code) => {
        scanner = null;
        scanBox.hidden = true;
        scanBtn.textContent = 'Scan QR code';
        input.value = formatCode(code);
        link(code);
      });
    } catch (err) {
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
    busy = true;
    linkBtn.disabled = scanBtn.disabled = true;
    say('Linking this phone…');
    try {
      const fb = await loadFirebase();
      await fb.auth.authStateReady();
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
      const result = await enrollThisPhone(fb, code);
      saveBinding(result);
      say(`Linked to ${result.name}. Opening the driver screen…`, 'ok');
      setTimeout(() => location.replace(`driver.html${location.search}`), 900);
    } catch (err) {
      if (err instanceof EnrollError) say(err.message, 'error');
      else if (err?.code === 'auth/operation-not-allowed')
        say('Anonymous sign-in is off. (Admin: turn it on in Firebase Authentication.)', 'error');
      else if (err?.code === 'auth/network-request-failed')
        say('No connection. Check the internet and try again.', 'error');
      else say('Linking did not work. Try again, or make a new code.', 'error');
    } finally {
      busy = false;
      linkBtn.disabled = scanBtn.disabled = false;
    }
  }

  for (const trigger of triggers) onFiveTaps(trigger, () => open());

  // Opened from the QR with the phone's camera app: …/#enroll=CODE
  if (/[#&]enroll=/.test(location.hash)) {
    const code = normalizeCode(location.hash);
    history.replaceState(null, '', location.pathname + location.search); // Do not keep the code in the URL bar.
    if (code) open(code);
  }
}
