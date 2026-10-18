# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SNU Caddy: a live campus caddy (golf-cart shuttle) tracker for Shiv Nadar University. A PWA in plain HTML/CSS/ES modules with **no build step and no bundler**. Backend is Firebase on the free Spark plan (Auth, Realtime Database, Hosting), with no Cloud Functions. `README.md` and `docs/ARCHITECTURE.md` (data model, threat model, free-tier budget) hold the detail.

## Commands

```bash
python3 -m http.server 8000    # serve statically (npm run serve); ES modules don't load from file://
npm run emulators              # Auth :9099, DB :9000, Hosting :5000 (needs Node 22+, Java 21+)
npm test                       # starts its own DB emulator: rules tests + unit tests. Stop `npm run emulators` first.
npm run test:unit              # unit tests only (no Java needed)
npm run test:e2e               # Chromium on the Hosting emulator (real CSP); needs `npx playwright install chromium` once
node --test tests/sw.test.mjs  # run a single test file
npm run deploy                 # firebase deploy --only hosting,database
python3 tools/build_campus_data.py   # regenerate js/data/campus.js and js/data/demo-routes.js from OSM
```

Dev URLs: `/?demo=1` (simulated caddies, no login; `&speed=2`), `/?emulator=1` on `localhost:5000` (and `/admin.html?emulator=1`) for the emulators. There is no linter; Prettier config is `singleQuote`, `printWidth: 100`.

## Architecture

Three separate pages, each with its own entry module: `index.html` (students, `js/main.js`, `css/app.css`), `driver.html` (`js/driver-screen.js`, `css/driver.css`; it imports `driver-shift.js` and `driver.js`, the phone's localStorage binding, which the student page also imports through `enroll-ui.js`), `admin.html` (`js/admin.js`, `css/app.css` + `css/admin.css`). Shared settings (campus box, GPS rules, geofence, CARTO key, demo) live in `js/config.js`.

- **Student flow:** `student-gate.js` chains Google sign-in (`auth.js`, `@snu.edu.in` only) → one-shot geofence (`geofence.js`, `lib/polygon.js`) → `live.js` (Firebase child events; closes the connection when the page is hidden or idle). `demo.js` feeds the same `caddy-layer.js`/`caddy-list.js` code from a simulator, so demo and live share rendering. `caddy-state.js` derives Moving / Parked / Signal lost / Offline.
- **Driver flow:** drivers have no accounts. A phone gets an anonymous Firebase uid; an admin links it to a caddy via a single-use QR code (`enroll.js`, hidden 5-tap dialog in `enroll-ui.js`), written atomically as `drivers/{uid}` + `enrollCodes/{code}/usedBy`. `driver-shift.js` is the testable engine (GPS filter, rate limit via `lib/ping-gate.js`, `onDisconnect`, dead-zone recovery).
- **The Firebase SDK is loaded on demand** as ES modules from gstatic (`js/firebase.js`). Leaflet (`index.html`) and qrcode-generator (`admin.html`) are classic `<script>` tags with SRI hashes, used as the globals `L` and `qrcode`. jsQR is loaded on demand by `js/enroll.js`, only when `BarcodeDetector` is missing. There is no `node_modules` runtime dependency; `firebase` in package.json is only for tests.
- **Access control is `database.rules.json`**, not client code. Caddy state is current-position-only (overwritten, no history). Admins are listed under `admins/{uid}` and edited only in the Firebase console.
- `js/data/campus.js` and `js/data/demo-routes.js` are **generated**; edit `tools/build_campus_data.py`, not the outputs.

## Things that break easily

- **CSP is hash-pinned.** `firebase.json` has a strict Content-Security-Policy with `sha256-` hashes of the inline scripts in the HTML pages, and the CDN URLs are version-pinned. Changing an inline `<script>`, or the Firebase/Leaflet/jsQR/qrcode-generator versions, requires updating the CSP; `tests/csp.test.mjs` checks the hashes.
- Only Hosting sends the CSP (`firebase.json` headers, for the three pages only); `python3 -m http.server` sends none. Check UI changes on the hosting emulator (`npm run emulators`, then http://localhost:5000/?demo=1) and look for CSP errors in the console. Set styles from JS with `el.style.x = ...`, never a `style=""` attribute in markup. A new CDN or tile host needs a CSP entry.
- **Service worker shell list.** `sw.js` has a `SHELL` array and a `CACHE` version (`snu-caddy-vN`). When you add, rename or remove a module or asset, update `SHELL` (`tests/sw.test.mjs` verifies every needed module is saved) and bump `CACHE` in any release that changes a shell file.
- **Modulepreload lists** in `index.html` and `driver.html` must match the real import graph (`tests/modulepreload.test.mjs`).
- Pinned CDN versions (Firebase 12.19.0, Leaflet 1.9.4, jsQR 1.4.0, qrcode-generator 2.0.4) must change everywhere at once: the `firebase.json` CSP; `sw.js` `LIBS` and `LIB_PREFIXES` (then bump `CACHE`); `js/firebase.js` `SDK`; the Leaflet CSS/JS URLs in `index.html` and their `integrity` hashes; `JSQR_URL` and `JSQR_SRI` in `js/enroll.js`; the qrcode-generator URL and `integrity` in `admin.html`; the `firebase` devDependency in `package.json`; the README credits; `docs/ARCHITECTURE.md`. `tests/versions.test.mjs` checks that they all match, but not the SRI `integrity` hashes: update those by hand.
- Test counts in README/ARCHITECTURE ("35 rules tests + 56 unit tests", "5 browser tests") are hand-maintained.
- CI (`.github/workflows/test.yml`) runs `npm test` and `npm run test:e2e` on every PR.
- Line endings must be LF. `.gitattributes` makes new checkouts LF, but a clone made before it keeps its CRLF files (with a clean `git status`) until you run this once, after you commit or stash your work: `git rm -r --cached -q . && git reset --hard`. Then `git ls-files --eol | grep w/crlf` (Git Bash) must print nothing. Browsers hash inline scripts after they turn CRLF into LF, so the LF hashes in `firebase.json` are the correct ones: never paste hashes from a CRLF checkout.
- Battery/heat is a design goal: no continuous GPS on student phones, no endless animations, pure-black (`#000`) dark surfaces and driver screen.

## Conventions

- Any change to `database.rules.json` needs a matching test in `tests/database.rules.test.mjs`.
- Put text into the page only with `textContent`, never `innerHTML` (XSS rule, see the threat model in `docs/ARCHITECTURE.md`).
- UI wording: short, plain, sentence case, no exclamation marks (see "Design" in `docs/ARCHITECTURE.md`).
- On Windows, use `python` or `py` if `python3` is not found (`npm run serve` calls `python3`).
