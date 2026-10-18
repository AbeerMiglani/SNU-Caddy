// Security rules tests for SNU Caddy. Run: npm test (starts the Database Emulator).
// Each test is one attack or one allowed action from docs/ARCHITECTURE.md.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  ref,
  get,
  set,
  update,
  remove,
  serverTimestamp,
  onDisconnect,
  goOffline,
} from 'firebase/database';

const RULES = fs.readFileSync(new URL('../database.rules.json', import.meta.url), 'utf8');
const CODE = 'ABCDEFGHJKMNPQRSTVWXYZ01'; // 24 chars, Crockford base32
const CODE2 = '0123456789ABCDEFGHJKMNPQ';
let env;

const student = { email: 'stu@snu.edu.in', email_verified: true };
const adminTok = { email: 'it.admin@snu.edu.in', email_verified: true };
const gmail = { email: 'someone@gmail.com', email_verified: true };
const unverified = { email: 'stu2@snu.edu.in', email_verified: false };
const lookalike = { email: 'evil@snu.edu.in.attacker.com', email_verified: true };
const anon = { firebase: { sign_in_provider: 'anonymous' } };

const db = (uid, token) =>
  (uid ? env.authenticatedContext(uid, token) : env.unauthenticatedContext()).database();
const pos = (o = {}) => ({
  lat: 28.5245,
  lng: 77.5745,
  bearing: 90,
  accuracy: 6,
  online: true,
  lastUpdated: serverTimestamp(),
  ...o,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-snu-caddy',
    database: { rules: RULES, host: '127.0.0.1', port: 9000 },
  });
});
after(async () => env.cleanup());

beforeEach(async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const now = Date.now();
    await set(ref(ctx.database()), {
      admins: { adm: true },
      fleet: { caddy_01: { name: 'Caddy 01' }, caddy_02: { name: 'Caddy 02' } },
      caddies: {
        caddy_02: {
          lat: 28.525,
          lng: 77.575,
          accuracy: 5,
          online: true,
          movedAt: now - 5000,
          lastUpdated: now - 5000,
        },
      },
      drivers: { drv2: { caddyId: 'caddy_02', code: 'OLD', enrolledAt: now - 100000 } },
      enrollCodes: {
        [CODE]: { caddyId: 'caddy_01', createdAt: now, createdBy: 'adm', expiresAt: now + 600000 },
        [CODE2]: {
          caddyId: 'caddy_01',
          createdAt: now - 1200000,
          createdBy: 'adm',
          expiresAt: now - 600000,
        },
      },
    });
  });
});

/** The phone's enrollment write: binding + claim in one atomic multi-path update. */
const enroll = (d, uid, code, caddyId = 'caddy_01') =>
  update(ref(d), {
    [`drivers/${uid}`]: { caddyId, code, enrolledAt: serverTimestamp(), device: 'Android test' },
    [`enrollCodes/${code}/usedBy`]: uid,
    [`enrollCodes/${code}/usedAt`]: serverTimestamp(),
  });

// ---------------------------------------------------------------- reading --
test('nobody signed in reads nothing', async () => {
  await assertFails(get(ref(db(null), 'caddies')));
  await assertFails(get(ref(db(null), 'fleet')));
  await assertFails(get(ref(db(null), '/')));
});

test('verified @snu.edu.in student reads caddies and fleet', async () => {
  await assertSucceeds(get(ref(db('stu', student), 'caddies')));
  await assertSucceeds(get(ref(db('stu', student), 'fleet')));
});

test('student cannot read drivers, codes, admins or root', async () => {
  const d = db('stu', student);
  await assertFails(get(ref(d, 'drivers')));
  await assertFails(get(ref(d, 'enrollCodes')));
  await assertFails(get(ref(d, 'admins')));
  await assertFails(get(ref(d, '/')));
});

test('gmail, unverified and look-alike domains are rejected', async () => {
  await assertFails(get(ref(db('g', gmail), 'caddies')));
  await assertFails(get(ref(db('u', unverified), 'caddies')));
  await assertFails(get(ref(db('e', lookalike), 'caddies')));
});

test('anonymous (unbound) phone cannot read caddies', async () => {
  await assertFails(get(ref(db('anon1', anon), 'caddies')));
});

// ---------------------------------------------------------------- writing --
test('students cannot write any caddy', async () => {
  await assertFails(set(ref(db('stu', student), 'caddies/caddy_01'), pos()));
  await assertFails(update(ref(db('stu', student), 'caddies/caddy_02'), { online: false }));
});

test('unbound anonymous phone cannot write a caddy', async () => {
  await assertFails(set(ref(db('anon1', anon), 'caddies/caddy_01'), pos()));
});

// -------------------------------------------------------------- enrolment --
test('phone with a valid code can look it up and enroll', async () => {
  const d = db('anon1', anon);
  await assertSucceeds(get(ref(d, `enrollCodes/${CODE}`)));
  await assertSucceeds(enroll(d, 'anon1', CODE));
  await assertSucceeds(get(ref(d, 'drivers/anon1')));
  await assertSucceeds(get(ref(d, 'fleet/caddy_01')));
  await assertFails(get(ref(d, 'fleet/caddy_02')));
});

test('anonymous phone cannot list codes', async () => {
  await assertFails(get(ref(db('anon1', anon), 'enrollCodes')));
});

test('a code works only once', async () => {
  await assertSucceeds(enroll(db('anon1', anon), 'anon1', CODE));
  await assertFails(enroll(db('anon9', anon), 'anon9', CODE));
});

test('expired code is rejected', async () => {
  await assertFails(enroll(db('anon1', anon), 'anon1', CODE2));
});

test('code for caddy_01 cannot bind caddy_02', async () => {
  await assertFails(enroll(db('anon1', anon), 'anon1', CODE, 'caddy_02'));
});

test('binding without claiming the code is rejected', async () => {
  await assertFails(
    set(ref(db('anon1', anon), 'drivers/anon1'), {
      caddyId: 'caddy_01',
      code: CODE,
      enrolledAt: serverTimestamp(),
    }),
  );
});

test('claiming a code without a binding is rejected', async () => {
  await assertFails(
    update(ref(db('anon1', anon), `enrollCodes/${CODE}`), {
      usedBy: 'anon1',
      usedAt: serverTimestamp(),
    }),
  );
});

test('phone cannot bind another uid', async () => {
  await assertFails(enroll(db('anon1', anon), 'anon2', CODE));
});

test('unknown code is rejected', async () => {
  await assertFails(enroll(db('anon1', anon), 'anon1', 'ZZZZZZZZZZZZZZZZZZZZZZZZ'));
});

// ------------------------------------------------------- bound driver writes --
test('bound driver writes its own caddy, not another', async () => {
  const d = db('drv2', anon);
  await assertSucceeds(set(ref(d, 'caddies/caddy_02'), pos({ bearing: 180 })));
  await assertFails(set(ref(d, 'caddies/caddy_01'), pos()));
});

test('newly enrolled phone can write its caddy', async () => {
  const d = db('anon1', anon);
  await assertSucceeds(enroll(d, 'anon1', CODE));
  await assertSucceeds(set(ref(d, 'caddies/caddy_01'), pos()));
});

test('field validation blocks spoofed or junk data', async () => {
  const d = db('drv2', anon);
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ lat: 28.7 }))); // off campus
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ lng: 'x' })));
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ status: 'open' }))); // seat status is gone
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ online: 'yes' })));
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ movedAt: Date.now() }))); // client clock
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ accuracy: 45 }))); // blurry fix
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ bearing: 400 })));
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ lastUpdated: Date.now() }))); // client clock
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos({ extra: 1 })));
  await assertFails(set(ref(d, 'caddies/caddy_02'), { lat: 28.5245, lng: 77.5745 })); // missing fields
  await assertFails(remove(ref(d, 'caddies/caddy_02'))); // drivers cannot delete
});

test('position writes faster than 1 per second are rejected; going offline is not limited', async () => {
  const d = db('drv2', anon);
  await assertSucceeds(set(ref(d, 'caddies/caddy_02'), pos()));
  await assertFails(
    update(ref(d, 'caddies/caddy_02'), { lat: 28.5246, lastUpdated: serverTimestamp() }),
  );
  await assertSucceeds(update(ref(d, 'caddies/caddy_02'), { online: false }));
  await sleep(1100);
  await assertSucceeds(
    update(ref(d, 'caddies/caddy_02'), { lat: 28.5246, lastUpdated: serverTimestamp() }),
  );
});

test('GPS fields cannot change without a new server timestamp (no flood path)', async () => {
  const d = db('drv2', anon);
  await assertFails(update(ref(d, 'caddies/caddy_02'), { lat: 28.5251, lng: 77.5751 }));
  await assertFails(set(ref(d, 'caddies/caddy_02/lat'), 28.5252));
  await assertFails(update(ref(d, 'caddies/caddy_02'), { bearing: 45 }));
  await assertFails(update(ref(d, 'caddies/caddy_02'), { accuracy: 4 }));
  await assertSucceeds(
    update(ref(d, 'caddies/caddy_02'), { lat: 28.5251, lastUpdated: serverTimestamp() }),
  );
  await assertFails(
    update(ref(d, 'caddies/caddy_02'), { lat: 28.5252, lastUpdated: serverTimestamp() }),
  );
});

test('charging: a boolean the driver may flip on its own; nobody else writes it', async () => {
  const d = db('drv2', anon);
  const node = ref(d, 'caddies/caddy_02');
  await assertSucceeds(set(node, pos({ charging: true })));
  // A flag, not a position: no new lastUpdated needed (like going offline).
  await assertSucceeds(update(node, { charging: false }));
  await assertSucceeds(update(node, { charging: true }));
  await assertFails(update(node, { charging: 'yes' }));
  await assertFails(update(node, { charging: 1 }));
  let v;
  await env.withSecurityRulesDisabled(async (ctx) => {
    v = (await get(ref(ctx.database(), 'caddies/caddy_02'))).val();
  });
  assert.equal(v.charging, true);
  await assertFails(update(ref(db('stu', student), 'caddies/caddy_02'), { charging: false }));
  await assertFails(update(ref(db('anon1', anon), 'caddies/caddy_02'), { charging: false }));
  // Another caddy: give caddy_01 a valid node first, so that only the binding
  // (drv2 is bound to caddy_02) can refuse the write, not the node's shape.
  await env.withSecurityRulesDisabled(async (ctx) =>
    set(ref(ctx.database(), 'caddies/caddy_01'), {
      lat: 28.525,
      lng: 77.575,
      accuracy: 5,
      online: true,
      lastUpdated: Date.now() - 5000,
    }),
  );
  await assertFails(update(ref(d, 'caddies/caddy_01'), { charging: true })); // another caddy
  // The same update is fine for someone who may write that node.
  await assertSucceeds(update(ref(db('adm', adminTok), 'caddies/caddy_01'), { charging: true }));
});

test('charging does not open a flood path: GPS fields still need a new timestamp', async () => {
  const d = db('drv2', anon);
  const node = ref(d, 'caddies/caddy_02');
  await assertSucceeds(set(node, pos({ charging: true })));
  await assertFails(update(node, { charging: true, lat: 28.5251 }));
  await assertFails(update(node, { charging: false, lastUpdated: serverTimestamp() })); // < 1 s
  await sleep(1100);
  await assertSucceeds(update(node, { charging: false, lastUpdated: serverTimestamp() }));
});

test('caddy must exist in the fleet', async () => {
  await env.withSecurityRulesDisabled(async (ctx) =>
    set(ref(ctx.database(), 'drivers/drv9'), { caddyId: 'caddy_09', code: 'X', enrolledAt: 1 }),
  );
  await assertFails(set(ref(db('drv9', anon), 'caddies/caddy_09'), pos()));
});

// ----------------------------------------------------------------- admins --
test('admin creates a code, lists drivers and codes; students cannot', async () => {
  const a = db('adm', adminTok);
  const code = 'QQQQQQQQQQQQQQQQQQQQQQQQ';
  await assertSucceeds(
    set(ref(a, `enrollCodes/${code}`), {
      caddyId: 'caddy_01',
      createdAt: Date.now(),
      createdBy: 'adm',
      expiresAt: Date.now() + 600000,
    }),
  );
  await assertSucceeds(get(ref(a, 'drivers')));
  await assertSucceeds(get(ref(a, 'enrollCodes')));
  await assertFails(
    set(ref(db('stu', student), `enrollCodes/${code}x`), {
      caddyId: 'caddy_01',
      createdAt: 1,
      createdBy: 'stu',
      expiresAt: Date.now() + 1000,
    }),
  );
});

test('admin cannot make a code that lives longer than 30 min, or a bad code', async () => {
  const a = db('adm', adminTok);
  await assertFails(
    set(ref(a, 'enrollCodes/QQQQQQQQQQQQQQQQQQQQQQQQ'), {
      caddyId: 'caddy_01',
      createdAt: Date.now(),
      createdBy: 'adm',
      expiresAt: Date.now() + 7200000,
    }),
  );
  await assertFails(
    set(ref(a, 'enrollCodes/short'), {
      caddyId: 'caddy_01',
      createdAt: Date.now(),
      createdBy: 'adm',
      expiresAt: Date.now() + 600000,
    }),
  );
});

test('an admin entry only counts with a verified SNU account', async () => {
  await assertFails(
    get(ref(db('adm', { email: 'it.admin@gmail.com', email_verified: true }), 'drivers')),
  );
  await assertFails(get(ref(db('adm', anon), 'drivers')));
});

test('revoke: admin deletes the binding, the phone loses write access at once', async () => {
  const d = db('drv2', anon);
  await assertSucceeds(set(ref(d, 'caddies/caddy_02'), pos()));
  await assertSucceeds(remove(ref(db('adm', adminTok), 'drivers/drv2')));
  await sleep(1100);
  await assertFails(set(ref(d, 'caddies/caddy_02'), pos()));
});

test('admin can force a caddy offline; a driver cannot delete its binding', async () => {
  await assertSucceeds(update(ref(db('adm', adminTok), 'caddies/caddy_02'), { online: false }));
  await assertFails(remove(ref(db('drv2', anon), 'drivers/drv2')));
});

test('going offline also clears charging: the bound phone and an admin may write both', async () => {
  const read = async () => {
    let v;
    await env.withSecurityRulesDisabled(async (ctx) => {
      v = (await get(ref(ctx.database(), 'caddies/caddy_02'))).val();
    });
    return v;
  };
  const charging = () =>
    env.withSecurityRulesDisabled(async (ctx) =>
      update(ref(ctx.database(), 'caddies/caddy_02'), { online: true, charging: true }),
    );

  // The phone (Go offline, the stale-shift cleanup).
  await assertSucceeds(update(ref(db('drv2', anon), 'caddies/caddy_02'), { charging: true }));
  await assertSucceeds(
    update(ref(db('drv2', anon), 'caddies/caddy_02'), { online: false, charging: false }),
  );
  let v = await read();
  assert.equal(v.online, false);
  assert.equal(v.charging, false);
  assert.equal(v.accuracy, 5, 'the position stays');

  // An admin (Unlink on the dashboard).
  await charging();
  await assertSucceeds(
    update(ref(db('adm', adminTok), 'caddies/caddy_02'), { online: false, charging: false }),
  );
  v = await read();
  assert.equal(v.online, false);
  assert.equal(v.charging, false);

  // Nobody else.
  await charging();
  await assertFails(
    update(ref(db('stu', student), 'caddies/caddy_02'), { online: false, charging: false }),
  );
  await assertFails(
    update(ref(db('anon1', anon), 'caddies/caddy_02'), { online: false, charging: false }),
  );
  assert.equal((await read()).charging, true);
});

test('students cannot make themselves admin', async () => {
  await assertFails(set(ref(db('stu', student), 'admins/stu'), true));
});

// ------------------------------------------- the driver phone's real calls --
// js/driver-screen.js caddyStore(): the exact writes a phone makes in a shift.
const phonePosition = (o = {}) => ({
  lat: 28.5245,
  lng: 77.5745,
  accuracy: 6,
  online: true,
  lastUpdated: serverTimestamp(),
  ...o,
});

test('shift: first position creates the node (no bearing yet), then onDisconnect at once', async () => {
  const d = db('anon1', anon);
  await assertSucceeds(enroll(d, 'anon1', CODE));
  const node = ref(d, 'caddies/caddy_01');
  // Before the node exists, onDisconnect's online:false alone would be an incomplete caddy.
  await assertFails(onDisconnect(node).update({ online: false, charging: false }));
  await assertSucceeds(update(node, phonePosition()));
  await assertSucceeds(onDisconnect(node).update({ online: false, charging: false })); // no wait needed
  await assertSucceeds(update(node, { online: false })); // outside campus
  await assertSucceeds(update(node, { online: false, charging: false })); // Go offline
  await assertSucceeds(onDisconnect(node).cancel());
});

test('shift: position updates with and without bearing; heartbeat with the same place', async () => {
  const node = ref(db('drv2', anon), 'caddies/caddy_02');
  await assertSucceeds(update(node, phonePosition({ bearing: 90 })));
  await sleep(1100);
  await assertSucceeds(update(node, phonePosition({ lat: 28.52455 }))); // keeps the old bearing
  await sleep(1100);
  await assertSucceeds(update(node, phonePosition({ lat: 28.52455 }))); // heartbeat
  let v;
  await env.withSecurityRulesDisabled(async (ctx) => {
    v = (await get(ref(ctx.database(), 'caddies/caddy_02'))).val();
  });
  assert.equal(v.bearing, 90);
  assert.equal(v.lat, 28.52455);
});

test('shift: a position write with charging, and charging alone while parked', async () => {
  const node = ref(db('drv2', anon), 'caddies/caddy_02');
  await assertSucceeds(update(node, phonePosition({ charging: true })));
  await assertSucceeds(update(node, { charging: false })); // the toggle: setFields({ charging })
  await sleep(1100);
  await assertSucceeds(update(node, phonePosition({ charging: false }))); // next heartbeat
  let v;
  await env.withSecurityRulesDisabled(async (ctx) => {
    v = (await get(ref(ctx.database(), 'caddies/caddy_02'))).val();
  });
  assert.equal(v.charging, false);
  assert.equal(v.online, true);
});

test('movedAt: server time only, and only together with a position write', async () => {
  const node = ref(db('drv2', anon), 'caddies/caddy_02');
  // A moving caddy: position + movedAt in one write.
  await assertSucceeds(update(node, phonePosition({ lat: 28.5246, movedAt: serverTimestamp() })));
  await sleep(1100);
  // Heartbeat: movedAt left out, so it keeps its value.
  await assertSucceeds(update(node, phonePosition({ lat: 28.5246 })));
  // movedAt alone (no new lastUpdated) would fake movement without the rate limit.
  await assertFails(update(node, { movedAt: serverTimestamp() }));
  await assertFails(update(node, { movedAt: 'now' }));
  let v;
  await env.withSecurityRulesDisabled(async (ctx) => {
    v = (await get(ref(ctx.database(), 'caddies/caddy_02'))).val();
  });
  assert.ok(v.movedAt < v.lastUpdated, 'the heartbeat did not touch movedAt');
});

test('onDisconnect flips online and charging to false when the phone drops', async () => {
  const d = db('drv2', anon);
  const node = ref(d, 'caddies/caddy_02');
  await assertSucceeds(update(node, phonePosition({ charging: true })));
  await assertSucceeds(onDisconnect(node).update({ online: false, charging: false }));
  goOffline(d);
  await sleep(1500);
  let v;
  await env.withSecurityRulesDisabled(async (ctx) => {
    v = (await get(ref(ctx.database(), 'caddies/caddy_02'))).val();
  });
  assert.equal(v.online, false);
  assert.equal(v.charging, false, 'a dropped phone is not charging any more');
  assert.equal(v.accuracy, 6, 'everything else stays');
});
