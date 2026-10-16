# SNU Caddy

A live, Uber-style caddy tracker for the Shiv Nadar University campus.
It is a mobile web app (PWA): plain HTML, CSS and JavaScript, with no build step.

| Phase | What | Status |
| ----- | ---- | ------ |
| 1 | Full-screen campus map, bottom sheet, theme pill (Auto / Light / Dark), demo / pitch mode | Done |
| 2 | Firebase project, `@snu.edu.in` Google login, campus geofence, QR driver-phone binding, admin dashboard, security rules + tests | Done |
| 3 | OLED-black driver screen: GO, Seats open / Full, GPS throttling, Screen Wake Lock, `onDisconnect` | Next |
| 4 | Live caddies on the student map, 90 s "Signal lost", service worker | Planned |

- **For the SNU IT department:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
  (system design, security rules, threat model, free-tier budget, edge cases).
- **Set up Firebase (free Spark plan):** [`docs/FIREBASE_SETUP.md`](docs/FIREBASE_SETUP.md).

## Run it on your computer

You need Python 3 (no other installs).

```bash
python3 -m http.server 8000
```

Then open:

- <http://localhost:8000/>: the app. Until `js/firebase-config.js` has your
  Firebase config, it runs without login (map + demo only).
- <http://localhost:8000/?demo=1>: demo mode starts at once
- <http://localhost:8000/?demo=1&speed=2>: demo at 2x speed (0.5 to 5)

ES modules do not load from `file://`, so always use a local server.

### Test login, geofence and driver binding without a Firebase project

The Firebase emulators run Auth and the Database on your computer. You need
Node.js 22+ and a Java 21+ JDK.

```bash
npm install
npm run emulators          # Auth :9099, Database :9000, Hosting :5000, UI :4000
```

Open <http://localhost:5000/?emulator=1> (student app) and
<http://localhost:5000/admin.html?emulator=1> (admin). See
[`docs/FIREBASE_SETUP.md`](docs/FIREBASE_SETUP.md) for the full flow.

The automated tests start their own emulator, so stop `npm run emulators`
(Ctrl-C) first:

```bash
npm test                   # 29 security-rule tests + 1 page check
```

### Open it on your phone

Connect the phone and the computer to the same Wi-Fi. Find the computer's
local IP address (for example `192.168.1.20`) and open
`http://192.168.1.20:8000/?demo=1` on the phone. The demo works on plain
`http`, but location and the camera need `https`, so use Firebase Hosting
(`npm run deploy`) for real tests.

## Pages

| Page | For | How to open |
| ---- | --- | ----------- |
| `index.html` | Students | The normal app address |
| `driver.html` | A linked driver phone | Opens by itself on a linked phone |
| `admin.html` | Admins | `…/admin.html` (SNU account on the admin list) |

To link a driver phone: on the phone, tap the SNU Caddy logo **5 times
quickly**, then scan the setup QR from the admin page.

## Map tiles (CARTO key)

The app uses the CARTO **Positron** (light) and **Dark Matter** (dark)
basemaps. Since 2026, CARTO requires a free API key: without it, every tile
shows an "API KEY REQUIRED" watermark. The project key is already in
`CARTO_KEY` in [`js/config.js`](js/config.js).

- The key is public by design (it is part of every tile URL), so it is safe
  to commit. In the CARTO dashboard, restrict it to your website's domain.
- CARTO raster tiles go up to zoom 18. At zoom 19 the map scales the zoom-18
  tiles (`maxNativeZoom: 18`).
- **Fallback:** if `CARTO_KEY` is empty, or CARTO refuses the key, the map
  uses grey OpenStreetMap tiles instead. They are good for development, but
  the OSM tile policy does not allow heavy use.
- To use a different key: get one at <https://carto.com/basemaps/apikey>
  (free for non-commercial use, up to 5 million tile requests a month).

## Demo / pitch mode

Tap **Start demo** (or the **Demo** switch). Three virtual caddies drive real
SNU roads, and a fourth caddy is parked and offline:

| Caddy | Route | Shows |
| ----- | ----- | ----- |
| Caddy 01 | Gate shuttle: Main Gate, Management Block, Library, A Block, Research Annexe, Gate 2 (4.0 km) | Seats open / Full |
| Caddy 02 | Hostel loop: Hostel 3A, DH2, DH3, Indoor Sports Complex, Hostel 2B, DH1, Library, Health Centre (2.2 km) | Full / Seats open |
| Caddy 03 | Academic loop: D Block, Library, Hostel 1A, Auctus Supermarket, Management Block, C Block (1.7 km) | Seats open / Full |
| Caddy 04 | Parked at Parking 1 | Offline |

Each virtual caddy acts like a real driver phone. It makes one GPS fix per
second with a small error, and sometimes a blurry fix (> 20 m). The same
rules that the driver screen will use (Phase 3) decide what is sent:

- Fixes with an error radius above 20 m are dropped.
- A fix is sent only if the caddy moved 5 m, or 30 s passed (heartbeat).

The student map then glides each icon between pings and turns it to face the
direction of travel. Phase 4 replaces the simulator with Firebase, and the
map code stays the same.

The demo is repeatable: it uses a fixed random seed, so every pitch looks the same.

## Battery and heat

- **Tiles** load only when a pan or zoom ends (`updateWhenIdle`), with a small buffer.
- **Glide animation** runs in one shared loop capped at 30 fps, and stops when no caddy moves.
- **Turning** uses a CSS transition (GPU), not JavaScript frames.
- **Page hidden** (app switched or phone locked): the demo clock, label timers and
  geofence re-checks stop. In Phase 4 the database connection closes here too.
- **Geofence**: one quick, low-accuracy location check when the app opens, then one
  every 5 minutes while it stays on screen. No continuous GPS on student phones.
- **Driver phones** open `driver.html`: no map, no tiles, no Leaflet, pure black.
- **No endless animations**: the selected caddy pulses twice, then stays still.
- **Dark mode** uses pure black (`#000000`) surfaces, so OLED pixels switch off.

## Project structure

```
index.html              student app (map, sign-in, geofence, hidden driver setup)
driver.html             OLED-black driver screen (linked phones only)
admin.html              admin dashboard (fleet, setup QR codes, linked phones)
manifest.webmanifest    PWA install data
database.rules.json     Firebase security rules (the real access control)
firebase.json           hosting, security headers, emulators
css/
  app.css               student app + shared tokens (light / dark)
  driver.css            driver screen
  admin.css             admin dashboard
js/
  main.js               student app: connects everything
  config.js             all settings: campus box, tiles, GPS rules, geofence, demo
  firebase-config.js    YOUR Firebase web config (public values)
  firebase.js           loads the Firebase SDK on demand; emulator mode
  auth.js               Google sign-in, @snu.edu.in check
  student-gate.js       login -> geofence -> live data
  geofence.js           one-shot, low-power campus check
  enroll.js             setup codes, QR scanner, atomic enrollment
  enroll-ui.js          hidden 5-tap setup dialog
  driver.js             driver binding + live revoke check
  admin.js              admin dashboard
  map.js                Leaflet map, campus lock, tile cross-fade
  caddy-layer.js        caddy icons: glide + rotate
  caddy-list.js         list rows in the sheet
  sheet.js              bottom sheet drag / snap (side panel on laptops)
  theme.js              Auto / Light / Dark pill
  demo.js               demo simulator
  lib/geo.js            distance, bearing, small helpers
  lib/polygon.js        point-in-polygon, distance to the fence
  lib/ping-gate.js      5 m / 30 s / 20 m rules (shared with Phase 3)
  data/campus.js        GENERATED: fence polygon, landmarks
  data/demo-routes.js   GENERATED: demo routes on real roads
tests/database.rules.test.mjs   29 security-rule tests (npm test)
tests/modulepreload.test.mjs    keeps the preload list in index.html in sync
tools/build_campus_data.py      makes the two data files from OpenStreetMap
docs/                   architecture + Firebase setup guide
assets/                 icons, Inter font
```

## Update the campus data

The fence line, landmarks and demo routes come from OpenStreetMap. To get
fresh data (for example after someone maps a new building):

```bash
python3 tools/build_campus_data.py
```

It uses only the Python standard library. To change the demo routes or the
landmark names, edit the lists at the top of that file.

Please check the landmark names with someone who knows the campus:

- OSM has two buildings called "Dining Hall 3". The tool labels the one
  between the hostels (west, OSM way 1473676593) as **DH3**. The other one
  (east, next to the faculty residences, way 729630264) is far from DH1, DH2
  and the Indoor Sports Complex, so the tool skips it until someone confirms
  what it is.
- OSM has no "Arcade" and no "Towers" building (the `tower` tags on campus
  are power pylons), so these are not on the map yet.

## Credits and licences

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL 1.0)
- Basemaps © [CARTO](https://carto.com/attributions)
- [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause)
- [Firebase JS SDK](https://firebase.google.com) 12.19.0 (Apache-2.0)
- [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (Apache-2.0), loaded only when a phone has no built-in QR reader
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 (MIT), admin page only
- [Inter](https://rsms.me/inter/) font (SIL Open Font License 1.1, see `assets/fonts/OFL.txt`)
