// Admin dashboard: caddies (fleet), one-time setup QR codes, linked phones.
// Every action here is also checked by database.rules.json: a page that
// is not signed in as an admin can read or change nothing.
/* global qrcode */

import { isSnuUser, rejectAccount, signInErrorText, signInWithSnu } from './auth.js';
import { formatCode, newSetupCode } from './enroll.js';
import { FIREBASE_ON, loadFirebase, readOnce } from './firebase.js';

const CODE_LIFE_MS = 10 * 60_000;
const CLEAN_AFTER_MS = 24 * 60 * 60_000;
const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'config', 'signin', 'denied', 'admin'];

function show(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
}

function el(tag, text = null, className = '') {
  const node = document.createElement(tag);
  if (text !== null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

if (FIREBASE_ON) boot();
else show('config');

async function boot() {
  const fb = await loadFirebase();
  fb.A.getRedirectResult(fb.auth).catch((err) => {
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
  $('copy-uid').addEventListener('click', () =>
    navigator.clipboard?.writeText($('my-uid').textContent).catch(() => {}),
  );

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
        `${user.email ?? 'This account'} is not an SNU account. Use your @snu.edu.in Google account.`;
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

function startAdmin(fb, user) {
  const { D, db } = fb;
  let fleet = {};
  let drivers = {};
  let stopCode = null;

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
        li.append(el('span', caddyName(id), 'fleet__name'), el('code', id, 'fleet__id'));
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
    const id = `caddy_${String(num).padStart(2, '0')}`;
    try {
      await D.set(D.ref(db, `fleet/${id}`), { name });
      $('fleet-form').reset();
    } catch {
      $('fleet-error').textContent = 'Could not save the caddy. Check your connection.';
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
        const revoke = el('button', 'Revoke', 'btn btn--small btn--danger');
        revoke.type = 'button';
        revoke.addEventListener('click', () => revokePhone(uid, d));
        const phone = el('td');
        phone.append(el('span', d.device || 'Phone'), el('code', ` ${uid.slice(0, 6)}`, 'muted'));
        const when = d.enrolledAt ? new Date(d.enrolledAt).toLocaleString() : '';
        tr.append(el('td', caddyName(d.caddyId)), phone, el('td', when), el('td'));
        tr.lastChild.append(revoke);
        return tr;
      }),
    );
    $('drivers-empty').hidden = rows.length > 0;
  }

  async function revokePhone(uid, d) {
    const ok = window.confirm(
      `Unlink this phone from ${caddyName(d.caddyId)}? It can no longer send locations, at once.`,
    );
    if (!ok) return;
    await D.remove(D.ref(db, `drivers/${uid}`));
    // Students should not see a ghost caddy from a revoked phone.
    const live = await D.get(D.ref(db, `caddies/${d.caddyId}`));
    if (live.exists() && live.val().online) {
      await D.update(D.ref(db, `caddies/${d.caddyId}`), { online: false });
    }
  }

  // --- Setup QR codes -------------------------------------------------------------
  $('code-form').onsubmit = async (e) => {
    e.preventDefault();
    $('code-error').textContent = '';
    const caddyId = $('code-caddy').value;
    if (!caddyId) {
      $('code-error').textContent = 'Add a caddy first (below).';
      return;
    }
    stopCode?.();
    try {
      stopCode = await showNewCode(caddyId);
    } catch {
      $('code-error').textContent = 'Could not create a setup code. Check your connection.';
    }
  };

  async function showNewCode(caddyId) {
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

    const meta = $('code-meta');
    const tick = () => {
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
      if (snap.exists()) finish('used', `Linked. ${caddyName(caddyId)} now has a driver phone.`);
    });

    function finish(state, text) {
      clearInterval(timer);
      offUse();
      $('code-box').dataset.state = state;
      $('code-qr').replaceChildren();
      $('code-text').textContent = '';
      meta.textContent = text;
    }

    return () => {
      clearInterval(timer);
      offUse();
    };
  }

  return () => {
    offFleet();
    offDrivers();
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
