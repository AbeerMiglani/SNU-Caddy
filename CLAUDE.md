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
node --test tests/sw.test.mjs  # run a single test file
npm run deploy                 # firebase deploy --only hosting,database
python3 tools/build_campus_data.py   # regenerate js/data/campus.js and js/data/demo-routes.js from OSM
```

Dev URLs: `/?demo=1` (simulated caddies, no login; `&speed=2`), `/?emulator=1` on `localhost:5000` (and `/admin.html?emulator=1`) for the emulators. There is no linter; Prettier config is `singleQuote`, `printWidth: 100`.

## Architecture

Three separate pages, each with its own entry module and CSS: `index.html` (students, `js/main.js`), `driver.html` (`js/driver.js` → `driver-screen.js` → `driver-shift.js`), `admin.html` (`js/admin.js`). Shared settings (campus box, GPS rules, geofence, CARTO key, demo) live in `js/config.js`.

- **Student flow:** `student-gate.js` chains Google sign-in (`auth.js`, `@snu.edu.in` only) → one-shot geofence (`geofence.js`, `lib/polygon.js`) → `live.js` (Firebase child events; closes the connection when the page is hidden or idle). `demo.js` feeds the same `caddy-layer.js`/`caddy-list.js` code from a simulator, so demo and live share rendering. `caddy-state.js` derives Moving / Parked / Signal lost / Offline.
- **Driver flow:** drivers have no accounts. A phone gets an anonymous Firebase uid; an admin links it to a caddy via a single-use QR code (`enroll.js`, hidden 5-tap dialog in `enroll-ui.js`), written atomically as `drivers/{uid}` + `enrollCodes/{code}/usedBy`. `driver-shift.js` is the testable engine (GPS filter, rate limit via `lib/ping-gate.js`, `onDisconnect`, dead-zone recovery).
- **Firebase SDK is loaded on demand from the gstatic CDN** (`firebase.js`), as are Leaflet (unpkg) and the QR libs (jsDelivr); there is no `node_modules` runtime dependency. `firebase` in package.json is only for tests.
- **Access control is `database.rules.json`**, not client code. Caddy state is current-position-only (overwritten, no history). Admins are listed under `admins/{uid}` and edited only in the Firebase console.
- `js/data/campus.js` and `js/data/demo-routes.js` are **generated**; edit `tools/build_campus_data.py`, not the outputs.

## Things that break easily

- **CSP is hash-pinned.** `firebase.json` has a strict Content-Security-Policy with `sha256-` hashes of the inline scripts in the HTML pages, and the CDN URLs are version-pinned. Changing an inline `<script>`, or the Firebase/Leaflet/jsQR/qrcode-generator versions, requires updating the CSP; `tests/csp.test.mjs` checks the hashes.
- **Service worker shell list.** `sw.js` has a `SHELL` array and a `CACHE` version (`snu-caddy-vN`). When you add, rename or remove a module or asset, update `SHELL` (`tests/sw.test.mjs` verifies every needed module is saved) and bump `CACHE` in any release that changes a shell file.
- **Modulepreload lists** in `index.html` and `driver.html` must match the real import graph (`tests/modulepreload.test.mjs`).
- Version numbers (Firebase 12.19.0, Leaflet 1.9.4) appear in the CSP, `firebase.js`, and the README credits; keep them in sync.
- Test counts in README/ARCHITECTURE ("32 rules tests + 39 unit tests") are hand-maintained.
- Line endings must be LF (`.gitattributes` enforces it). CRLF changes the inline-script hashes and breaks the CSP in production.
- Battery/heat is a design goal: no continuous GPS on student phones, no endless animations, pure-black (`#000`) dark surfaces and driver screen.

## Conventions

- Any change to `database.rules.json` needs a matching test in `tests/database.rules.test.mjs`.
- Put text into the page only with `textContent`, never `innerHTML` (XSS rule, see the threat model in `docs/ARCHITECTURE.md`).
- UI wording: short, plain, sentence case, no exclamation marks (see "Design" in `docs/ARCHITECTURE.md`).
- The dev machine is Windows: use `python` or `py` if `python3` isn't found.
