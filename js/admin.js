// Admin dashboard: caddies (fleet), one-time setup QR codes, linked phones.
// Every action here is also checked by database.rules.json: a page that
// is not signed in as an admin can read or change nothing.
/* global qrcode */

import {
  finishRedirect,
  isSnuUser,
  rejectAccount,
  signInErrorText,
  signInWithSnu,
} from './auth.js';
import { formatCode, newSetupCode } from './enroll.js';
import { FIREBASE_ON, loadFirebase, readOnce } from './firebase.js';

const CODE_LIFE_MS = 10 * 60_000;
const CLEAN_AFTER_MS = 24 * 60 * 60_000;
const SLOW_WRITE_MS = 10_000;
const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'config', 'offline', 'signin', 'denied', 'admin'];

function show(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
}

function el(tag, text = null, className = '') {
  const node = document.createElement(tag);
  if (text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

$('reload').addEventListener('click', () => location.reload());

if (FIREBASE_ON) boot();
else show('config');

async function boot() {
  let fb;
  try {
    fb = await loadFirebase();
  } catch {
    // A failed SDK download can only be retried by reloading the page.
    show('offline');
    return;
  }
  await finishRedirect(fb).catch((err) => {
    $('signin-error').textContent = signInErrorText(err);
  });

  $('sign-in').addEventListener('click', async () => {
    $('signin-error').textContent = '';
    try {
      await signInWithSnu(fb);
    } catch (err) {
      $('signin-error').textContent = signInErrorText(err);
    }
  });
  $('sign-out').addEventListener('click', () => fb.A.signOut(fb.auth));
  let copyTimer = 0;
  $('copy-uid').addEventListener('click', async () => {
    const btn = $('copy-uid');
    clearTimeout(copyTimer);
    try {
      await navigator.clipboard.writeText($('my-uid').textContent);
      btn.textContent = 'Copied';
      $('copy-status').textContent = 'User ID copied.';
    } catch {
      // No clipboard (old browser, or not allowed): select the ID for a manual copy.
      window.getSelection().selectAllChildren($('my-uid'));
      $('copy-status').textContent = 'Could not copy. The ID is selected: copy it by hand.';
    }
    copyTimer = setTimeout(() => {
      btn.textContent = 'Copy';
      $('copy-status').textContent = '';
    }, 2000);
  });

  let stop = null;
  fb.A.onAuthStateChanged(fb.auth, async (user) => {
    stop?.();
    stop = null;
    const signedIn = Boolean(user && !user.isAnonymous);
    $('who').hidden = !signedIn;
    if (!signedIn) {
      show('signin');
      return;
    }
    if (!isSnuUser(user)) {
      $('signin-error').textContent =
        `${user.email ?? 'That account'} cannot sign in here. Use your @snu.edu.in account.`;
      await rejectAccount(fb, user);
      return;
    }
    $('who-email').textContent = user.email;
    const isAdmin = await fb.D.get(fb.D.ref(fb.db, `admins/${user.uid}`))
      .then((s) => s.val() === true)
      .catch(() => false);
    if (!isAdmin) {
      $('my-uid').textContent = user.uid;
      show('denied');
      return;
    }
    show('admin');
    stop = startAdmin(fb, user);
  });
}

/** Wait for a server-confirmed write; after a while, tell the admin it is still waiting. */
async function confirmed(promise, onSlow) {
  const slow = setTimeout(onSlow, SLOW_WRITE_MS);
  try {
    return await promise;
  } finally {
    clearTimeout(slow);
  }
}

function startAdmin(fb, user) {
  const { D, db } = fb;
  let fleet = {};
  let drivers = {};
  let connected = false;
  let stopCode = null;
  let creating = false;
  let codeGen = 0;

  const offConnected = D.onValue(D.ref(db, '.info/connected'), (snap) => {
    connected = snap.val() === true;
  });
  const offFleet = D.onValue(D.ref(db, 'fleet'), (snap) => {
    fleet = snap.val() ?? {};
    renderFleet();
    renderDrivers();
  });
  const offDrivers = D.onValue(D.ref(db, 'drivers'), (snap) => {
    drivers = snap.val() ?? {};
    renderDrivers();
  });
  cleanOldCodes(fb).catch(() => {});

  const caddyName = (id) => fleet[id]?.name ?? id;

  // --- Fleet ------------------------------------------------------------------
  function renderFleet() {
    const ids = Object.keys(fleet).sort();
    const list = $('fleet-list');
    list.replaceChildren(
      ...ids.map((id) => {
        const li = el('li');
        li.append(
          el('span', caddyName(id), 'fleet__name'),
          el('span', `No. ${id.slice(-2)}`, 'fleet__id'),
        );
        return li;
      }),
    );
    $('fleet-empty').hidden = ids.length > 0;

    const select = $('code-caddy');
    const keep = select.value;
    select.replaceChildren(
      ...ids.map((id) => {
        const opt = el('option', caddyName(id));
        opt.value = id;
        return opt;
      }),
    );
    if (ids.includes(keep)) select.value = keep;
  }

  $('fleet-form').onsubmit = async (e) => {
    e.preventDefault();
    $('fleet-error').textContent = '';
    const num = Number($('fleet-num').value);
    const name = $('fleet-name').value.trim();
    if (!(num >= 1 && num <= 99) || !name) return;
    if (!connected) {
      $('fleet-error').textContent = 'No connection. The caddy was not saved.';
      return;
    }
    const id = `caddy_${String(num).padStart(2, '0')}`;
    // set() replaces: a number that exists already would rename that caddy.
    const old = fleet[id]?.name;
    if (
      old &&
      old !== name &&
      !window.confirm(`Caddy number ${num} is “${old}”. Rename it to “${name}”?`)
    ) {
      return;
    }
    // Clear the form now, not after the save: the admin can type the next
    // caddy while this one saves, and a late reset would erase it.
    $('fleet-form').reset();
    try {
      await D.set(D.ref(db, `fleet/${id}`), { name });
    } catch {
      $('fleet-error').textContent = 'Could not save the caddy. Try again.';
      if (!$('fleet-num').value && !$('fleet-name').value) {
        $('fleet-num').value = String(num);
        $('fleet-name').value = name;
      }
    }
  };

  // --- Linked phones ------------------------------------------------------------
  function renderDrivers() {
    const rows = Object.entries(drivers).sort(([, a], [, b]) =>
      caddyName(a.caddyId).localeCompare(caddyName(b.caddyId)),
    );
    $('drivers-body').replaceChildren(
      ...rows.map(([uid, d]) => {
        const tr = el('tr');
        const unlink = el('button', 'Unlink', 'btn btn--secondary btn--small btn--danger');
        unlink.type = 'button';
        // Every row has an "Unlink": the name says which phone (it starts with the visible word).
        unlink.setAttribute('aria-label', `Unlink ${caddyName(d.caddyId)}’s phone`);
        unlink.addEventListener('click', () => unlinkPhone(uid, d));
        const phone = el('td');
        // The start of the uid tells two phones of the same model apart.
        phone.append(el('span', d.device || 'Phone'), el('span', ` · ${uid.slice(0, 6)}`, 'muted'));
        // Date and time each stay whole; on a narrow phone the time goes under the date.
        const when = el('td');
        if (d.enrolledAt) {
          const t = new Date(d.enrolledAt);
          when.append(
            el('span', `${t.toLocaleDateString([], { day: 'numeric', month: 'short' })},`),
            ' ',
            el(
              'span',
              t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
            ),
          );
        }
        tr.append(el('td', caddyName(d.caddyId)), phone, when, el('td'));
        tr.lastChild.append(unlink);
        return tr;
      }),
    );
    $('drivers-empty').hidden = rows.length > 0;
  }

  async function unlinkPhone(uid, d) {
    const name = caddyName(d.caddyId);
    $('drivers-error').textContent = '';
    // The database applies writes locally first: offline, the row would vanish
    // although the server never heard of the unlink.
    if (!connected) {
      $('drivers-error').textContent =
        `No connection. ${name}’s phone is still linked. Try again when the page is online.`;
      return;
    }
    if (!window.confirm(`Unlink ${name}’s phone? It stops sending locations right away.`)) {
      return;
    }
    $('drivers-status').textContent = `Unlinking ${name}’s phone…`;
    try {
      await confirmed(D.remove(D.ref(db, `drivers/${uid}`)), () => {
        $('drivers-status').textContent =
          'Still waiting for the connection. Keep this page open until it says “Unlinked”.';
      });
      // Students should not see a ghost caddy from an unlinked phone.
      const live = await D.get(D.ref(db, `caddies/${d.caddyId}`));
      if (live.exists() && live.val().online) {
        await D.update(D.ref(db, `caddies/${d.caddyId}`), { online: false });
      }
      $('drivers-status').textContent = `Unlinked. ${name}’s phone can no longer send locations.`;
    } catch {
      $('drivers-status').textContent = '';
      $('drivers-error').textContent = `Could not unlink ${name}’s phone. Try again.`;
    }
  }

  // --- Setup codes (QR + typed) ------------------------------------------------------
  $('code-form').onsubmit = async (e) => {
    e.preventDefault();
    if (creating) return; // a double click must not make two codes
    $('code-error').textContent = '';
    const caddyId = $('code-caddy').value;
    if (!caddyId) {
      $('code-error').textContent = 'Add a caddy first, under Caddies.';
      return;
    }
    if (!connected) {
      $('code-error').textContent = 'No connection. Try again when the page is online.';
      return;
    }
    creating = true;
    try {
      stopCode?.(); // also deletes the previous code if nobody used it
      stopCode = null;
      stopCode = await showNewCode(caddyId);
    } catch {
      $('code-error').textContent = 'Could not create a setup code. Try again.';
    } finally {
      creating = false;
    }
  };

  async function showNewCode(caddyId) {
    const gen = ++codeGen;
    const offset = (await readOnce(fb, '.info/serverTimeOffset')).val() ?? 0;
    const serverNow = () => Date.now() + offset;
    const code = newSetupCode();
    const expiresAt = serverNow() + CODE_LIFE_MS;
    await D.set(D.ref(db, `enrollCodes/${code}`), {
      caddyId,
      createdAt: serverNow(),
      createdBy: user.uid,
      expiresAt,
    });

    // The QR holds a link to the app, so the phone's camera app can open it too.
    const link = new URL(`./#enroll=${code}`, location.href).href;
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    $('code-qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
    $('code-text').textContent = formatCode(code);
    $('code-box').hidden = false;
    $('code-box').dataset.state = 'live';
    // Screen readers hear state changes only, not the per-second countdown.
    $('code-status').textContent =
      `Setup code for ${caddyName(caddyId)} created. It expires in 10 minutes.`;

    const meta = $('code-meta');
    let used = false;
    const tick = () => {
      if (gen !== codeGen) return;
      const left = Math.max(0, expiresAt - serverNow());
      if (left === 0) {
        finish('expired', 'Expired. Create a new code.');
        return;
      }
      const m = Math.floor(left / 60_000);
      const s = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0');
      meta.textContent = `For ${caddyName(caddyId)} · works once · expires in ${m}:${s}`;
    };
    const timer = setInterval(tick, 1000);
    tick();

    const offUse = D.onValue(D.ref(db, `enrollCodes/${code}/usedBy`), (snap) => {
      if (!snap.exists()) return;
      used = true;
      finish('used', `Linked. ${caddyName(caddyId)} now has a driver phone.`);
    });

    function finish(state, text) {
      clearInterval(timer);
      offUse();
      if (gen !== codeGen) return; // a newer code owns the screen
      $('code-box').dataset.state = state;
      $('code-qr').replaceChildren();
      $('code-text').textContent = '';
      meta.textContent = text;
      $('code-status').textContent = text;
    }

    // Called when the code is replaced, the admin signs out, or the page closes:
    // a code that was shown but not used must not stay valid off screen.
    return () => {
      clearInterval(timer);
      offUse();
      if (!used) D.remove(D.ref(db, `enrollCodes/${code}`)).catch(() => {});
    };
  }

  const onPageHide = () => stopCode?.();
  window.addEventListener('pagehide', onPageHide);

  return () => {
    offConnected();
    offFleet();
    offDrivers();
    window.removeEventListener('pagehide', onPageHide);
    stopCode?.();
  };
}

/** Keep the database tiny: delete expired codes and codes used over a day ago. */
async function cleanOldCodes(fb) {
  const { D, db } = fb;
  const snap = await D.get(D.ref(db, 'enrollCodes'));
  const offset = (await readOnce(fb, '.info/serverTimeOffset')).val() ?? 0;
  const now = Date.now() + offset;
  const updates = {};
  snap.forEach((child) => {
    const c = child.val();
    const expired = !c.usedBy && c.expiresAt < now;
    const oldUsed = c.usedBy && (c.usedAt ?? 0) < now - CLEAN_AFTER_MS;
    if (expired || oldUsed) updates[`enrollCodes/${child.key}`] = null;
  });
  if (Object.keys(updates).length) await D.update(D.ref(db), updates);
}
