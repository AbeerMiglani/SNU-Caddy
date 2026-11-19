# Plan: fixes for the version 1.0 code review

> **Status: planned, not implemented.** This file lists the findings of a code
> review of `main` at `636cda0` (Version 1.0) and a fix plan for each. No app
> code changes yet. Line numbers are for `636cda0`.

## Context

A review of the whole codebase found 9 issues: 6 **Important** (a real bug
worth fixing) and 3 **Nit** (minor). Unit tests passed (83/83) at the time of
the review; the rules and browser tests were not run.

How each finding was checked:

- **Finding 2** was reproduced by running the shift engine with a write held in
  flight (the `hold` option of the fake store in `tests/driver-shift.test.mjs`).
- **Finding 1** depends on the order of events inside Firebase. It was checked
  in the pinned SDK source (`@firebase/auth` 1.13.6, `@firebase/database`
  1.1.5): Auth tells the database connection about the new token before it
  calls `onAuthStateChanged` listeners.
- The others were found by reading the code; the failure scenarios follow from
  the code paths quoted below.

| # | Severity | Where | In one line |
|---|---|---|---|
| 1 | Important | `js/admin.js:477` | Signing out does not delete the setup code on screen |
| 2 | Important | `js/driver-shift.js:222` | A caddy back on campus can stay Offline for up to 30 s |
| 3 | Important | `js/student-gate.js:285` | Live data restarts on an old campus check |
| 4 | Important | `js/admin.js:137` | Sign out and in again: every caddy row shows twice |
| 5 | Important | `js/admin.js:377` | Unlinking one phone takes a caddy offline while another drives it |
| 6 | Important | `js/admin.js:106` | Sign out during the admin check leaves a wrong screen |
| 7 | Nit | `js/enroll-ui.js:99` | After an instant QR read, the next Scan tap does nothing |
| 8 | Nit | `js/student-gate.js:300` | The setup-problem message is replaced by "try again" |
| 9 | Nit | `js/admin.js:431` | `innerHTML` against the CLAUDE.md rule |

Suggested order: 1, 5 and 6 first (security and wrong data in the admin
panel), then 2 and 3 (what students see), then 4, then the nits. Each fix is
small and local; they can ship in one PR or one per finding.

---

## 1. Signing out does not delete the setup code (Important)

**Where:** `js/admin.js:69` (Sign out handler), `js/admin.js:474-478` (the
cleanup returned by `showNewCode`), `js/admin.js:484-494` (the `startAdmin`
cleanup).

**What happens.** The comment at line 472 and the threat model
(`docs/ARCHITECTURE.md`, "A setup QR is replaced or left on screen") say an
unused code is deleted when the admin signs out. The delete runs from the
`onAuthStateChanged(null)` callback (`stop?.()` at line 91 → `stopCode?.()` →
`D.remove(...)`). By then Auth has already given the database connection the
signed-out token, so the admin-only rule refuses the delete, and
`.catch(() => {})` hides the error.

**Failure scenario.** An admin creates a code, so the QR is on screen and
unused, then clicks Sign out. The code stays claimable for up to 10 minutes;
anyone who photographed the QR can still link a phone.

**Fix.**
1. Make the `showNewCode` cleanup return the remove promise
   (`return used ? undefined : D.remove(...).catch(() => {})`).
2. In the `#sign-out` click handler, run the code cleanup first and await it
   (with a short time limit, about 3 s, so a dead connection cannot block
   sign-out), then call `fb.A.signOut`. `startAdmin` can expose this as a
   `beforeSignOut()` next to the existing stop function.
3. Keep the `pagehide` path as is (the admin is still signed in there).

**Test.** Browser test (`tests/e2e/browser.test.mjs`): admin creates a code,
signs out; then, as admin again (or with the emulator's admin access), check
`enrollCodes/{code}` no longer exists.

## 2. A caddy back on campus can stay Offline (Important)

**Where:** `js/driver-shift.js:222` (success handler of `sendPosition`),
`js/driver-shift.js:301-308` (`markOffCampus`), `js/driver-shift.js:293`
(`want ??= 'back'`).

**What happens.** The success handler of a position write sets
`offCampusMarked = false`. If that write was sent *before* the caddy left
campus, `markOffCampus()` has just queued `online:false` behind it, but the
flag is cleared anyway. The next fix on campus then does not set
`want = 'back'`, so nothing re-sends `online:true`.

**Failure scenario.** A position write is in flight. The next sharp fix is more
than 100 m outside the fence (an edge road, or a GPS jump), so `online:false`
is queued. The write is confirmed and the mark is cleared. The next fix is back
on campus within 5 m of the last approved fix, so the ping gate says
"deadband" and nothing is sent. Students see Offline until the 30 s heartbeat,
while the driver screen says Online.

**Fix.** Only clear the mark for a write sent after the mark:
- keep a counter `markGen` that `markOffCampus()` increases;
- record `const sentMarkGen = markGen` when a write starts;
- in the success handler, clear `offCampusMarked` only if
  `sentMarkGen === markGen`.

The failed-write path in `markOffCampus` (`.catch(() => { offCampusMarked =
false; })`) stays as it is.

**Test.** Unit test in `tests/driver-shift.test.mjs` with `db.hold = []`:
send a fix, keep it in flight, give a fix far outside, release the held write,
then give a fix back on campus within the deadband. Expect a position write
with `online: true` (today: none).

## 3. Live data restarts on an old campus check (Important)

**Where:** `js/student-gate.js:277-286` (`visibilitychange` handler),
`js/student-gate.js:367-372` (`setPaused(false)`), `updateLive()`.

**What happens.** When the app comes back on screen, or the idle pause ends,
the handler starts `checkFence()` (which first awaits the Permissions API) and
then calls `updateLive()` at once, while `fence` is still the old `inside`.
That breaks the module's rule that live data runs only on campus, and its own
10-minute `GEOFENCE.graceMs` limit.

**Failure scenario.** A student looks at the map on campus, locks the phone,
and opens the app at home the next day. `live.attach()` opens a database
connection (one of the 100 free connections) and streams every caddy position
for up to about 30 s, until the new check shows "You are outside campus".

**Fix.** Before `updateLive()` in both places, if
`Date.now() - insideAt > GEOFENCE.graceMs`, treat the fence as unknown (set it
to the same "checking" state a first check uses), so `updateLive()` keeps live
data off until the fresh result arrives. Within the grace time nothing
changes, so a quick unlock still shows caddies at once.

**Test.** Unit test (new, or in `tests/student.test.mjs`) if the gate can be
driven with a fake `document` and clock; otherwise a browser test that moves
the clock past `graceMs` while the page is hidden and checks that no `caddies`
listener is attached before the new fix.

## 4. Sign out and in again: every caddy row shows twice (Important)

**Where:** `js/admin.js:137` (`fleetRows` is new per session),
`js/admin.js:180-185` (rows inserted into `#fleet-body`),
`js/admin.js:484-494` (cleanup), `js/admin.js:433-434` (`#code-box`).

**What happens.** Each sign-in makes a new `fleetRows` map, but the cleanup
never removes the rows the last session added to `#fleet-body`. New rows go in
at the top and the old ones stay below, with frozen Now/Phone cells and Remove
buttons that use the old session's `drivers` and `connected`. `#code-box` also
keeps showing the last session's QR with a stopped countdown.

**Failure scenario.** Admin A signs out and admin B signs in on the same
laptop. "Caddy 01" shows twice; one row is live and one is stuck. Remove on the
stale row can miss a phone linked since then.

**Fix.** In the function `startAdmin` returns: `$('fleet-body').replaceChildren()`,
and reset the code box (`$('code-box').hidden = true`, clear `#code-qr`,
`#code-text`, `#code-meta`, `#code-status`). Doing the same at the start of
`startAdmin` as well makes it safe either way.

**Test.** Browser test: admin signs in, signs out, signs in again; the Caddies
table has one row per caddy and the code box is hidden.

## 5. Unlinking one phone takes a caddy offline while another drives it (Important)

**Where:** `js/admin.js:375-378` (`unlinkPhone`).

**What happens.** After removing `drivers/{uid}`, the code writes
`online:false, charging:false` whenever the caddy is online or charging. It
never checks `drivers` for another phone with the same `caddyId`, although the
table supports several phones per caddy ("N phones").

**Failure scenario.** An admin replaces a phone: links the new one, which is
now on shift (maybe charging), then unlinks the old one. Students see Offline,
and Charging is lost, until the new phone's next write (up to 30 s when
parked).

**Fix.** Skip the offline write when another entry in `drivers` (the live copy
`startAdmin` keeps) has the same `caddyId`:

```js
const others = Object.entries(drivers).some(([u, x]) => u !== uid && x.caddyId === d.caddyId);
if (!others && live.exists() && (live.val().online || live.val().charging)) { ... }
```

**Test.** Browser test: two phones linked to one caddy, one online; unlink the
other; the caddy stays online. (Rules are unchanged, so no rules test is
needed.)

## 6. Sign out during the admin check leaves a wrong screen (Important)

**Where:** `js/admin.js:106-115` (`onAuthStateChanged` callback).

**What happens.** After awaiting `D.get(admins/{uid})`, the callback does not
check that the same user is still signed in. In this SDK `get()` waits for the
connection with no time limit, and Sign out is visible during "Loading…".

**Failure scenario.** On a slow connection the admin clicks Sign out while the
page says "Loading…". The sign-in view shows. When the connection comes up,
the pending `get` runs signed out, is refused, is caught as `false`, and
`show('denied')` replaces the sign-in view. The page needs a reload.

**Fix.** Add a generation counter: `const myGen = ++authGen` at the top of the
callback, and after the `await`, `if (myGen !== authGen) return;`. (Checking
`fb.auth.currentUser?.uid !== user.uid` also works, but the counter also
covers signing in again as the same user.) The same check belongs after
`await rejectAccount(...)`.

**Test.** Hard to force in a browser test (needs a stalled connection). A
manual check is enough: throttle the network in DevTools, sign in, click Sign
out during "Loading…".

## 7. After an instant QR read, the next Scan tap does nothing (Nit)

**Where:** `js/enroll-ui.js:86-99`.

**What happens.** With jsQR (browsers without `BarcodeDetector`, such as iOS
Safari and Firefox), a code in the first camera frame calls `onCode`
synchronously inside `startScanner()`. `onCode` sets `scanner = null`, but
`starting` still holds the token, so line 99 stores the already-stopped
scanner. The next click sees `scanner` set (line 72), only calls `stopScan()`,
and returns.

**Failure scenario.** On an iPhone, Scan QR code with the QR already in view:
the code is read at once, the link fails (for example the code expired), and
the next tap on Scan QR code does nothing visible; a second tap is needed.

**Fix.** In the `onCode` callback also set `starting = null`. Then the check at
line 94 (`starting !== token`) stops and drops the scanner instead of storing
it.

**Test.** Manual on a browser without `BarcodeDetector`, or a unit test with a
fake `startScanner` that calls `onCode` before it resolves.

## 8. The setup-problem message is replaced by "try again" (Nit)

**Where:** `js/student-gate.js:289-304` (login click handler),
`js/student-gate.js:318-330` (`follow`).

**What happens.** When Firebase fails to load or start, `follow()` shows the
right message ("SNU Caddy has a setup problem…" or "No connection…") and
rethrows. The click handler's `catch` then passes that non-sign-in error to
`signInErrorText()`, whose default is "Sign-in did not work. Please try
again."

**Failure scenario.** A bad value in `js/firebase-config.js` is deployed. The
student sees the setup-problem text, taps Continue with Google, and is told to
try again, which can never work.

**Fix.** Split the try: `const f = fb ?? (await start().catch(() => null)); if
(!f) return;` so a failed start keeps the message `follow()` set, and only
errors from `signInWithSnu` reach `showLoginError(signInErrorText(err))`.

**Test.** Unit or browser test with a Firebase load that fails: after the tap,
the error text is still the setup-problem message.

## 9. `innerHTML` against the CLAUDE.md rule (Nit)

**Where:** `js/admin.js:431` (`$('code-qr').innerHTML = qr.createSvgTag(...)`)
and `js/caddy-layer.js:25` (`svg.innerHTML = ...`).

**What happens.** CLAUDE.md (Conventions) says to put text into the page only
with `textContent`, never `innerHTML`. Both places insert fixed or
library-made SVG markup; no user text reaches them, so there is no injection
path today.

**Fix (pick one).**
- Build the cart icon with `createElementNS` + `setAttribute`, and parse the QR
  SVG with `new DOMParser().parseFromString(svg, 'image/svg+xml')` and
  `replaceChildren(doc.documentElement)`; or
- write the exception into CLAUDE.md and `docs/ARCHITECTURE.md`: `innerHTML`
  is allowed only for fixed markup or library-made SVG with no user text.

Either way, check the hosting emulator for CSP errors after the change.

---

## Checklist when the fixes are made

- `npm test` (rules + unit) and `npm run test:e2e` pass.
- Update the hand-kept test counts in `README.md` and `docs/ARCHITECTURE.md`
  ("37 rules tests + 83 unit tests", "6 browser tests") and in `CLAUDE.md`.
- If any shell file changes, bump `CACHE` in `sw.js`.
- If an inline `<script>` changes (not expected), update the CSP hashes in
  `firebase.json`.
- Update this file's status line.
