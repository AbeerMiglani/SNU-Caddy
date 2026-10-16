# SNU Caddy

A live, Uber-style caddy tracker for the Shiv Nadar University campus.
It is a mobile web app (PWA): plain HTML, CSS and JavaScript, with no build step.

| Phase | What | Status |
| ----- | ---- | ------ |
| 1 | Full-screen campus map, bottom sheet, theme switch, demo / pitch mode | Done |
| 2 | `@snu.edu.in` login and campus geofence | Next |
| 3 | OLED-black driver screen, GPS throttling, Screen Wake Lock | Planned |
| 4 | Firebase Realtime Database, live caddies on the student map | Planned |

## Run it on your computer

You need Python 3 (no other installs).

```bash
python3 -m http.server 8000
```

Then open:

- <http://localhost:8000/>: the normal app (no caddies until Phase 4)
- <http://localhost:8000/?demo=1>: demo mode starts at once
- <http://localhost:8000/?demo=1&speed=2>: demo at 2x speed (0.5 to 5)

ES modules do not load from `file://`, so always use a local server.

### Open it on your phone

Connect the phone and the computer to the same Wi-Fi. Find the computer's
local IP address (for example `192.168.1.20`) and open
`http://192.168.1.20:8000/?demo=1` on the phone.
Phase 1 works on plain `http`. From Phase 2, location needs `https`, so we
will use Firebase Hosting.

## Map tiles: get a free CARTO key (2 minutes)

In 2026, CARTO started to require a free API key for its basemaps. Without
the key, every tile shows an "API KEY REQUIRED" watermark. Until you add a
key, the app uses grey OpenStreetMap tiles. They are good for development,
but the OSM tile policy does not allow heavy use.

1. Go to <https://carto.com/basemaps/apikey> and request a key with your email.
   It is free for non-commercial use, up to 5 million tile requests a month.
2. Paste the key into `CARTO_KEY` in [`js/config.js`](js/config.js).
3. In the CARTO dashboard, restrict the key to your website's domain.

The key is public by design (it is part of every tile URL), so it is safe to
commit it.

## Demo / pitch mode

Tap **Start demo** (or the **Demo** switch). Three virtual caddies drive real
SNU roads, and a fourth caddy is parked and offline:

| Caddy | Route | Shows |
| ----- | ----- | ----- |
| Caddy 01 | Gate shuttle: Gate 1, Management Block, Central Library, Block A, Research Annexe, Gate 2 (4.0 km) | Seats open / Full |
| Caddy 02 | Hostel loop: Hostel 3A, Dining Hall 2, Indoor Sports Complex, Hostel 2B, Dining Hall 1, Central Library, Health Centre (2.1 km) | Full / Seats open |
| Caddy 03 | Academic loop: Block D, Central Library, Hostel 1A, Auctus Supermarket, Management Block, Block C (1.7 km) | Seats open / Full |
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
- **Page hidden** (app switched or phone locked): the demo clock and label timers stop.
  In Phase 4 the database listeners will stop here too.
- **No endless animations**: the selected caddy pulses twice, then stays still.
- **Dark mode** uses pure black (`#000000`) surfaces, so OLED pixels switch off.

## Project structure

```
index.html              page shell, theme set before first paint
manifest.webmanifest    PWA install data
css/app.css             all styles (light + dark tokens)
js/
  main.js               connects everything
  config.js             all settings: campus box, tiles, GPS rules, demo
  map.js                Leaflet map, campus lock, tile cross-fade
  caddy-layer.js        caddy icons: glide + rotate
  caddy-list.js         list rows in the sheet
  sheet.js              bottom sheet drag / snap (side panel on laptops)
  theme.js              Auto / Light / Dark
  demo.js               demo simulator
  lib/geo.js            distance, bearing, small helpers
  lib/ping-gate.js      5 m / 30 s / 20 m rules (shared with Phase 3)
  data/campus.js        GENERATED: fence polygon, landmarks
  data/demo-routes.js   GENERATED: demo routes on real roads
tools/build_campus_data.py   makes the two data files from OpenStreetMap
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

Please check the landmark names with someone who knows the campus. OSM has
two buildings called "Dining Hall 3"; the tool keeps the newer one.

## Credits and licences

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL 1.0)
- Basemaps © [CARTO](https://carto.com/attributions)
- [Leaflet](https://leafletjs.com) 1.9.4 (BSD-2-Clause)
- [Inter](https://rsms.me/inter/) font (SIL Open Font License 1.1, see `assets/fonts/OFL.txt`)
