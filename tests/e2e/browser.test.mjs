// End-to-end tests in Chromium, against the Firebase emulators.
// Run with `npm run test:e2e`: it starts the Hosting, Auth and Database
// emulators. Hosting serves the pages with the real headers from firebase.json,
// so these tests also catch anything the production CSP blocks (a server
// like `python3 -m http.server` sends no CSP).
//
// The pages load Leaflet and the Firebase SDK from their CDNs, so the tests
// need internet access. Map tiles may fail to load: that is not checked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, devices } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:5000/';
const DB = 'http://127.0.0.1:9000';
const NS = 'demo-snu-caddy-default-rtdb';
const AUTH = 'http://127.0.0.1:9099';
const OWNER = { Authorization: 'Bearer owner' }; // the emulator's admin token
const PHONE = devices['Pixel 7'];
const LIBRARY = { latitude: 28.5245, longitude: 77.5745, accuracy: 6 }; // on campus
const TIMEOUT = 20_000;

let browser;

async function db(method, path, body) {
  const res = await fetch(`${DB}/${path}.json?ns=${NS}`, {
    method,
    headers: OWNER,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function until(fn, ms = TIMEOUT) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A browser context that records CSP violations and page errors. */
async function open(options = {}) {
  const ctx = await browser.newContext({ ...PHONE, serviceWorkers: 'block', ...options });
  const problems = [];
  await ctx.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    ),
  );
  const watch = (page) => {
    page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // Tiles come from the internet; a failed tile is not an app error.
      if (/cartocdn|openstreetmap/.test(m.location()?.url ?? '')) return;
      problems.push(m.text());
    });
  };
  ctx.on('page', watch);
  return { ctx, problems };
}

/** Sign in on the Auth emulator's sign-in page (opened as a popup). */
async function signIn(page, email, button = '#login-btn') {
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click(button)]);
  await popup.waitForLoadState();
  await popup.click('#add-account-button');
  await popup.fill('#email-input', email);
  await popup.fill('#display-name-input', email.split('@')[0]);
  await popup.click('#sign-in');
  await popup.waitForEvent('close', { timeout: TIMEOUT }).catch(() => {});
}

before(async () => {
  // A clean database with the real rules, and no accounts.
  await db('DELETE', '');
  await fetch(`${AUTH}/emulator/v1/projects/demo-snu-caddy/accounts`, { method: 'DELETE' });
  const rules = fs.readFileSync(new URL('../../database.rules.json', import.meta.url));
  const res = await fetch(`${DB}/.settings/rules.json?ns=${NS}`, {
    method: 'PUT',
    headers: OWNER,
    body: rules,
  });
  assert.ok(res.ok, `could not load the rules: ${await res.text()}`);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
});

test('pages are served with the production CSP', async () => {
  for (const page of ['', 'admin.html', 'driver.html']) {
    const res = await fetch(BASE + page);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self' 'sha256-/, `${page || 'index.html'}: no CSP header`);
  }
});

test('demo mode: the demo caddies on the map and in the list, nothing blocked', async () => {
  const { ctx, problems } = await open();
  const page = await ctx.newPage();
  await page.goto(BASE + '?emulator=1&demo=1');
  // Every demo caddy is on the map and in the list (a marker per row).
  const count = async () => [
    (await page.$$('.caddy-marker')).length,
    (await page.$$('#caddy-list .row')).length,
  ];
  const shown = await until(async () => {
    const [markers, rows] = await count();
    return markers >= 4 && markers === rows;
  });
  assert.ok(shown, `markers, rows: ${await count()}`);
  const states = await page.$$eval('#caddy-list .row', (rows) => rows.map((r) => r.dataset.state));
  for (const state of ['moving', 'charging', 'offline']) {
    assert.ok(states.includes(state), `no ${state} caddy in the demo: ${states}`);
  }
  // A charging caddy is counted apart, not as online; the screen-reader line has only the count.
  assert.match(await page.textContent('#summary'), /^\d+ online( · \d+ moving)? · 1 charging$/);
  assert.doesNotMatch(await page.textContent('#summary-status'), /charging/);
  assert.ok(await page.isHidden('#login'), 'the sign-in panel hides in demo mode');
  // The switch is the way out of the demo: on, and in view.
  assert.equal(await page.getAttribute('#demo-switch', 'aria-checked'), 'true');
  assert.ok(await page.isVisible('#demo-switch'));
  // Nobody is signed in: no own position, so no dot, no button and no distances.
  assert.equal((await page.$$('.me')).length, 0);
  assert.ok(await page.isHidden('#locate-btn'));
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('a signed-in student on campus sees a live caddy', async () => {
  await db('PUT', 'fleet/caddy_01', { name: 'Caddy 01' });
  await db('PUT', 'caddies/caddy_01', {
    lat: 28.5249,
    lng: 77.5742,
    accuracy: 6,
    online: true,
    lastUpdated: { '.sv': 'timestamp' },
    movedAt: { '.sv': 'timestamp' },
  });
  const { ctx, problems } = await open({ geolocation: LIBRARY, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  await page.goto(BASE + '?emulator=1');
  await page.waitForSelector('#login[data-state="ready"]:not([hidden])', { timeout: TIMEOUT });
  await signIn(page, 'e2e.student@snu.edu.in');
  await page.waitForSelector('html[data-live="true"]', { timeout: TIMEOUT });
  const row = await until(() =>
    page.evaluate(() => {
      const r = document.querySelector('#caddy-list .row');
      return r && { state: r.dataset.state, text: r.textContent };
    }),
  );
  assert.equal(row?.state, 'moving', JSON.stringify(row));
  assert.match(row.text, /Caddy 01/);
  assert.equal((await page.$$('.caddy-marker')).length, 1);
  // Real caddies only: no Demo switch for a signed-in student.
  assert.ok(await page.isHidden('#demo-switch'));

  // The student's own position (it stays in the page): the dot, the button,
  // and the distance to the caddy, about 50 m from the test position.
  assert.equal((await page.$$('.me')).length, 1, 'the "you are here" dot');
  assert.ok(await page.isVisible('#locate-btn'));
  assert.equal((await page.textContent('#caddy-list .row__dist')).trim(), '50 m away');

  // A tap on the row goes to the caddy; from that zoom on, places are named.
  assert.equal((await page.$$('.place__name')).length, 0, 'no place names on the whole campus');
  await page.click('#caddy-list .row');
  const named = await until(async () =>
    (await page.$$eval('.place__name', (els) => els.map((e) => e.textContent))).includes(
      'Central Library',
    ),
  );
  assert.ok(named, 'place names show near the caddy');

  // "Show my location" takes a new fix and keeps the student on the map.
  await page.click('#locate-btn');
  await page.waitForSelector('#locate-btn[aria-disabled="false"]', { timeout: TIMEOUT });
  assert.equal((await page.$$('.me')).length, 1);
  assert.equal(await page.getAttribute('html', 'data-live'), 'true');

  // About: opens over the map and closes again.
  await page.click('#about-btn');
  assert.ok(await page.evaluate(() => document.querySelector('#about').open));
  assert.match(await page.textContent('#about-version'), /^Version \d+\.\d+\.\d+$/);
  await page.click('#about-close');
  assert.ok(!(await page.evaluate(() => document.querySelector('#about').open)));
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('a driver phone links with a setup code, goes online, charges, then goes offline', async () => {
  const code = 'E2EABCDEFGHJKMNPQRSTVWXY';
  const now = Date.now();
  await db('PUT', 'fleet/caddy_02', { name: 'Caddy 02' });
  await db('PUT', `enrollCodes/${code}`, {
    caddyId: 'caddy_02',
    createdAt: now,
    createdBy: 'e2e-admin',
    expiresAt: now + 600_000,
  });
  const { ctx, problems } = await open({ geolocation: LIBRARY, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  await page.goto(BASE + '?emulator=1#enroll=' + code);
  await page.waitForFunction(() => document.querySelector('#enroll')?.open, null, {
    timeout: TIMEOUT,
  });
  await page.click('#enroll-link');
  await page.waitForURL(/driver\.html/, { timeout: TIMEOUT });
  await page.waitForSelector('#driver-go:not([disabled])', { timeout: TIMEOUT });
  assert.equal((await page.textContent('#driver-name')).trim(), 'Caddy 02');

  await page.click('#driver-go');
  const online = await until(async () => (await page.textContent('#driver-head')) === 'Online');
  assert.ok(online, `headline: ${await page.textContent('#driver-head')}`);
  const caddy = await db('GET', 'caddies/caddy_02');
  assert.equal(caddy?.online, true);
  assert.ok(Math.abs(caddy.lat - LIBRARY.latitude) < 1e-5, JSON.stringify(caddy));

  // Charging needs two taps, on and off, like Go offline; the database follows.
  await page.click('#driver-charge');
  assert.equal((await page.textContent('#driver-charge')).trim(), 'Tap again to mark charging');
  assert.equal(await page.getAttribute('#driver-charge', 'aria-pressed'), 'false');
  assert.equal(await page.textContent('#driver-head'), 'Online', 'one tap changes nothing');
  assert.notEqual(await db('GET', 'caddies/caddy_02/charging'), true);
  await page.click('#driver-charge');
  const charging = await until(async () => (await db('GET', 'caddies/caddy_02/charging')) === true);
  assert.ok(charging, 'charging reached the database');
  assert.equal(await page.textContent('#driver-head'), 'Charging');
  assert.equal(await page.getAttribute('#driver-charge', 'aria-pressed'), 'true');
  assert.equal((await page.textContent('#driver-charge')).trim(), 'Charging');
  await page.click('#driver-charge');
  assert.equal((await page.textContent('#driver-charge')).trim(), 'Tap again to end charging');
  assert.equal(await page.textContent('#driver-head'), 'Charging', 'one tap changes nothing');
  assert.equal(await db('GET', 'caddies/caddy_02/charging'), true);
  await page.click('#driver-charge');
  const cleared = await until(async () => (await db('GET', 'caddies/caddy_02/charging')) === false);
  assert.ok(cleared, 'charging cleared in the database');
  assert.equal(await page.textContent('#driver-head'), 'Online');
  assert.equal(await page.getAttribute('#driver-charge', 'aria-pressed'), 'false');
  assert.equal((await page.textContent('#driver-charge')).trim(), 'Charging');

  // Charging again, then Go offline: the shift ends with charging cleared too.
  await page.click('#driver-charge');
  await page.click('#driver-charge');
  assert.ok(await until(async () => (await db('GET', 'caddies/caddy_02/charging')) === true));

  // Go offline needs two taps.
  await page.click('#driver-off');
  assert.equal(await page.getAttribute('#driver', 'data-mode'), 'on');
  await page.click('#driver-off');
  const off = await until(async () => (await db('GET', 'caddies/caddy_02/online')) === false);
  assert.ok(off, 'the caddy is offline in the database');
  assert.equal(await db('GET', 'caddies/caddy_02/charging'), false, 'and no longer charging');
  assert.equal(await page.textContent('#driver-head'), 'Offline');
  assert.ok(await page.isHidden('#driver-charge'), 'no Charging button off shift');
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('an admin sees what students see of each caddy, and removes a caddy', async () => {
  await db('PUT', 'fleet/caddy_07', { name: 'Caddy 07' });
  await db('PUT', 'fleet/caddy_08', { name: 'Caddy 08' });
  await db('PUT', 'caddies/caddy_07', {
    lat: 28.5262,
    lng: 77.5761,
    accuracy: 6,
    online: true,
    charging: true,
    lastUpdated: { '.sv': 'timestamp' },
  });
  await db('PUT', 'drivers/e2e-phone', { caddyId: 'caddy_07', code: 'E2E', enrolledAt: 1 });
  const { ctx, problems } = await open({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept()); // "Remove Caddy 07? …"
  await page.goto(BASE + 'admin.html?emulator=1');
  await page.waitForSelector('#view-signin:not([hidden])', { timeout: TIMEOUT });
  await signIn(page, 'e2e.admin@snu.edu.in', '#sign-in');
  await page.waitForSelector('#view-denied:not([hidden])', { timeout: TIMEOUT });
  const uid = (await page.textContent('#my-uid')).trim();
  await db('PUT', `admins/${uid}`, true);
  await page.reload();
  await page.waitForSelector('#view-admin:not([hidden])', { timeout: TIMEOUT });

  const rowOf = (name) => page.locator('#fleet-body tr', { hasText: name });
  await rowOf('Caddy 07').waitFor({ timeout: TIMEOUT });
  const charging = await until(async () =>
    /Charging/.test(await rowOf('Caddy 07').locator('td').nth(1).textContent()),
  );
  assert.ok(charging, 'the live state of the caddy');
  assert.equal(await rowOf('Caddy 07').locator('td').nth(2).textContent(), 'Linked');
  assert.match(await rowOf('Caddy 08').locator('td').nth(1).textContent(), /No position yet/);
  assert.equal(await rowOf('Caddy 08').locator('td').nth(2).textContent(), 'No phone');

  await rowOf('Caddy 07').getByRole('button', { name: 'Remove Caddy 07' }).click();
  const gone = await until(async () => (await db('GET', 'fleet/caddy_07')) === null);
  assert.ok(gone, 'the caddy left the fleet');
  assert.equal(await db('GET', 'caddies/caddy_07'), null, 'and its live state (no ghost caddy)');
  assert.equal(await db('GET', 'drivers/e2e-phone'), null, 'and its phone link');
  assert.deepEqual(await db('GET', 'fleet/caddy_08'), { name: 'Caddy 08' });
  assert.equal(await rowOf('Caddy 07').count(), 0);
  assert.match(await page.textContent('#fleet-status'), /^Removed Caddy 07\.$/);
  assert.deepEqual(problems, []);
  await ctx.close();
});

test('admin page asks to sign in; driver page without a link goes to the student app', async () => {
  const { ctx, problems } = await open({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + 'admin.html?emulator=1');
  await page.waitForSelector('#view-signin:not([hidden])', { timeout: TIMEOUT });
  await page.goto(BASE + 'driver.html');
  await page.waitForURL((u) => !u.pathname.endsWith('driver.html'), { timeout: TIMEOUT });
  assert.deepEqual(problems, []);
  await ctx.close();
});
