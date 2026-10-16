# SNU Caddy: system design and security architecture

This document is for the Shiv Nadar University IT department. It describes
how SNU Caddy works, how it protects data, how it stays on the free tier,
and how it handles failures.

- **Product:** a live map of campus caddies (golf-cart shuttles) for students,
  with seat status (Seats open / Full / Offline).
- **Platform:** a Progressive Web App (PWA): HTML, CSS and JavaScript. No app
  store. It works on iPhone, Android, and Android without Google Play Services
  (GrapheneOS, LineageOS, CalyxOS).
- **Backend:** Firebase (Google) on the free **Spark** plan: Authentication,
  Realtime Database, Hosting. No servers and no Cloud Functions.

## 1. Components

```mermaid
flowchart LR
  subgraph Phones
    S["Student app<br/>index.html<br/>(map, Google login, geofence)"]
    D["Driver app<br/>driver.html<br/>(OLED black, GPS, Wake Lock)"]
    A["Admin dashboard<br/>admin.html<br/>(fleet, QR enrollment, revoke)"]
  end
  subgraph Firebase["Firebase (Spark, free)"]
    AU["Authentication<br/>Google + Anonymous"]
    DB[("Realtime Database<br/>asia-southeast1")]
    H["Hosting<br/>static files, HTTPS"]
  end
  T["CARTO basemap tiles<br/>(OpenStreetMap data)"]

  D -- "writes caddies/{id}<br/>(5 m or 30 s)" --> DB
  DB -- "WebSocket push (onValue)" --> S
  A -- "fleet, codes, revoke" --> DB
  S & D & A -- "sign-in" --> AU
  S -- "map tiles" --> T
  H -- "app files" --> S & D & A
```

| Part | File | Who uses it |
| ---- | ---- | ----------- |
| Student app | `index.html`, `js/main.js` | Students and staff with an `@snu.edu.in` Google account |
| Driver app | `driver.html`, `js/driver.js` | One dedicated Android phone per caddy |
| Admin dashboard | `admin.html`, `js/admin.js` | SNU accounts on the admin list |
| Security rules | `database.rules.json` | Enforced by Firebase on every read and write |
| Rules tests | `tests/database.rules.test.mjs` | 29 automated tests (`npm test`) |

## 2. Roles and sign-in

| Role | Sign-in | Why |
| ---- | ------- | --- |
| **Student** | Google sign-in, restricted to `@snu.edu.in` | SNU uses Google Workspace. It is standard web OAuth in the browser, so it works without Google Play Services. The session stays until sign-out. |
| **Driver phone** | Firebase **Anonymous** sign-in + one-time **device binding** | Drivers have no SNU accounts. The phone gets a permanent device identity (a Firebase uid). An admin links that uid to one caddy with a single-use QR code. Drivers never log in. |
| **Admin** | Google sign-in (`@snu.edu.in`) **and** listed under `admins/{uid}` | The admin list is edited only in the Firebase console, never from the app. |

Email-link sign-in is not used: the free plan allows only 5 such emails per day.

### Driver device binding (QR enrollment)

```mermaid
sequenceDiagram
  participant Admin as Admin dashboard
  participant DB as Realtime Database
  participant Phone as Driver phone
  Admin->>DB: enrollCodes/{code} = {caddyId, expiresAt: +10 min}
  Note over Admin: Shows QR (link with #enroll=code) and typed code
  Phone->>Phone: 5 taps on logo, scan QR (or camera app opens link)
  Phone->>Phone: Anonymous sign-in (uid = device identity)
  Phone->>DB: ONE atomic update:<br/>drivers/{uid} = {caddyId, code}<br/>enrollCodes/{code}/usedBy = uid
  DB-->>Phone: Rules accept only if the code exists, is unused,<br/>is not expired and matches the caddy
  Phone->>Phone: Save hint in localStorage, open driver.html
  Admin->>DB: Revoke = delete drivers/{uid}
  DB-->>Phone: Next write is denied; the open listener shows "unlinked"
```

- The setup code has **120 random bits** (24 characters, Crockford base32).
  It works **once** and expires after **10 minutes** (the rules allow at most 30).
- The code list cannot be read or listed by non-admins, so a code cannot be
  found by guessing. There is **no short PIN** to brute-force.
- `localStorage` holds only a hint (`caddy_03`) so that the phone opens the
  driver screen at once. The real permission is `drivers/{uid}` in the
  database, checked by the rules on every write.
- Firebase keeps the anonymous session in IndexedDB. The driver page asks the
  browser for persistent storage on every start. Chrome grants it once the app
  is installed (Add to Home screen), so the setup guide makes installing a
  required step. Then Android does not clear the session under storage pressure.

## 3. Data model: one small object per caddy

The database stores the **current state** only. A new GPS fix **overwrites**
the caddy's object; there is no location history. The whole database stays
under a few kilobytes.

```jsonc
{
  "admins":  { "<uid>": true },
  "fleet":   { "caddy_01": { "name": "Caddy 01" } },
  "caddies": {
    "caddy_01": {
      "lat": 28.52471, "lng": 77.57412,  // inside the campus box (rules)
      "bearing": 92,                      // degrees, only while moving
      "accuracy": 6,                      // metres, at most 20 (rules)
      "status": "open",                   // "open" | "full"
      "online": true,                     // false = off shift / disconnected
      "lastUpdated": 1792147071000        // server time (rules)
    }
  },
  "drivers":     { "<anonymous uid>": { "caddyId": "caddy_01", "code": "…", "enrolledAt": 0, "device": "Android 14 · Chrome 130" } },
  "enrollCodes": { "<24-char code>": { "caddyId": "caddy_01", "createdAt": 0, "createdBy": "<admin uid>", "expiresAt": 0, "usedBy": "<uid>", "usedAt": 0 } }
}
```

Size: about 200 bytes per caddy. Old setup codes are deleted by the admin
dashboard (expired ones at once, used ones after 24 hours).

## 4. Real-time data flow

1. **Driver phone** (`js/driver-shift.js`): after **GO**, `watchPosition`
   with `enableHighAccuracy: true` and `maximumAge: 0`. Each fix goes
   through one shared gate (`js/lib/ping-gate.js`):
   - drop the fix if its error radius is more than **20 m**;
   - drop it if it is outside the campus fence + 100 m (the driver's
     location is never shared off campus; the caddy shows as offline);
   - send it only if it is the first fix, the caddy moved **5 m** from the
     last sent fix, or **30 s** passed (heartbeat). A browser that reports
     only changes gets asked for a fresh fix when the heartbeat is due.

   Then a sender limits the writes: one write in flight at a time, at most
   one every **2 s** (the newest fix wins), never while the connection is
   down. Each write is one `update()` of the caddy object with
   `online: true`, the seat status and `lastUpdated: ServerValue.TIMESTAMP`.
   A seat tap (Seats open / Full) is written at once.
2. **Database**: the write overwrites `caddies/{id}`. The rules check the
   sender, the fields, the campus box, and the server timestamp. A GPS field
   (lat, lng, bearing, accuracy) can change only together with a new server
   timestamp, at most once per second per caddy. Status taps (Seats open /
   Full) and Go offline are human actions and are not rate-limited.
3. **Student phones**: one WebSocket listener (`onValue` on `caddies`)
   receives the change. There is **no polling**. The icon glides to the new
   point and turns to the direction of travel.
4. **Battery**: student phones listen only while the app is on screen, the
   student is signed in, and the phone is on campus. When the app is hidden,
   the app closes the database connection (`goOffline`) and stops timers.

### Driver shift: presence and recovery

| Moment | What the phone does |
| ------ | ------------------- |
| GO | Screen Wake Lock on, GPS watch on. The first sharp fix creates or overwrites the caddy object. |
| First confirmed write on a connection | Registers `onDisconnect().update({ online: false })`. (The rules accept it only for an existing caddy object, so it comes after the write.) |
| Connection lost (dead zone) | No writes and no queue. The server runs `onDisconnect`: students see the caddy offline. |
| Connection back | The newest fix goes out at once with `online: true`, then `onDisconnect` is registered again. |
| Old connection's `onDisconnect` runs late | Every position write carries `online: true`, so the next write (at most 30 s later) corrects it. |
| Outside campus | No positions; `online: false` once. Back inside: the next fix makes it online again. |
| App in the background | The browser stops GPS and timers. Students see "Signal lost" after 90 s (Phase 4). Back within 10 min: the shift continues. After 10 min: the shift ends, so a forgotten phone leaves no ghost caddy. |
| Reload or crash during a shift | The shift resumes by itself (seat status kept) if it was alive in the last 10 min. |
| Go offline (two taps) | `online: false`, then `onDisconnect` cancelled; GPS and wake lock off. |
| Admin revokes the phone | The `drivers/{uid}` listener fires: the shift stops at once, the phone returns to the student app. The admin page sets `online: false`. |
| Writes refused (for example the caddy was removed from the fleet) | Back-off (2, 4, 8 … 30 s); after 3 in a row the screen says "Ask an admin". |

The driver screen is OLED-black: a pure `#000` background, dim text and
thin rings. It dims after 20 s without a touch and moves its content by a
few pixels every minute, so hours of a still picture cannot burn in.

## 5. Security rules (enforced by Firebase)

| Path | Read | Write |
| ---- | ---- | ----- |
| `caddies` | Verified `@snu.edu.in` accounts | Only the phone bound to **that** caddy (validated fields). Admins may force it offline. |
| `fleet` | Verified `@snu.edu.in` accounts; a bound phone reads its own caddy | Admins |
| `drivers/{uid}` | That phone; admins | The phone itself, **only** together with a valid code claim. Admins may delete (revoke). |
| `enrollCodes/{code}` | Anyone signed in **who knows the exact code**; admins may list | Admins create/delete. A phone may only claim an unused, unexpired code once. |
| `admins/{uid}` | That user (to check own status) | Nobody from the app (console only) |
| Everything else | Nobody | Nobody |

Validation on `caddies/{id}`: lat/lng inside the campus box (also protects
the driver's privacy off campus), `accuracy` ≤ 20 m, `status` is `open` or
`full`, `bearing` 0–360, `online` boolean, `lastUpdated` = server time, no
extra fields, and the caddy must exist in `fleet`. GPS fields change only
with a new `lastUpdated`, at most once per second.

The rules are tested with the Firebase Emulator: 31 tests, one per attack
or allowed action, including the exact writes a driver phone makes in a
shift (`npm test`). The shift engine has 22 more tests with a fake GPS, a
fake database and fake timers (`npm run test:unit`, no emulator needed).

## 6. Threat model

| Threat | Mitigation |
| ------ | ---------- |
| A student pretends to be a driver | Writes to `caddies/{id}` need a binding in `drivers/{uid}`, which needs a one-time admin code. Anonymous sign-in alone gives no access (tested). |
| A driver phone is lost or stolen | Admin taps **Revoke**: the binding is deleted, writes fail at once, and the caddy is set offline. |
| Someone photographs a setup QR | Single use, 10-minute life, and the admin sees which phone used it (and can revoke). |
| Guessing setup codes | 120-bit codes, and the code list cannot be read. No short PIN. |
| Non-SNU people read caddy positions | Rules need a **verified** `@snu.edu.in` email. Look-alike domains (`@snu.edu.in.evil.com`) fail (tested). Non-SNU Google accounts are deleted right after sign-in. |
| The Firebase web config is "public" | It is public by design. Security is in the rules, not in the config. Optional: restrict the browser API key to the app's domains (setup guide). |
| A bound phone sends junk or floods writes | Field validation, campus box, accuracy limit, server timestamps, and at most 1 position write per second (GPS fields cannot change without a new timestamp; tested). Status taps are not limited; an abusive phone is revoked. |
| A setup QR is replaced or left on screen | When the admin makes a new code, signs out or closes the page, the unused code is deleted at once. Unused codes also expire after 10 minutes. |
| Driver location outside work | The phone shares only between GO and Go offline, and stops at the campus fence + 100 m. The rules also reject positions outside the campus box. |
| Student location privacy | The geofence check runs **on the phone**. The location is never sent or stored. |
| Ghost caddies (dead battery, closed app, dead zone) | `onDisconnect()` sets `online: false` on the server (tested). Students also dim any caddy whose `lastUpdated` is older than **90 s** and label it "Signal lost". |
| Script injection (XSS) | All text goes into the page with `textContent`. Leaflet, jsQR and qrcode-generator are pinned and use Subresource Integrity. The Firebase SDK is pinned to 12.19.0 on Google's gstatic CDN; it loads as ES modules, which cannot carry SRI (self-hosting it is planned with the Phase 4 service worker). Pages cannot be framed (`frame-ancestors 'none'`). A strict Content-Security-Policy follows in Phase 4, after a test against the live project. |
| Students who graduate or leave | Firebase keeps a session until sign-out, even after the Google Workspace account is disabled. Options for IT: (a) disable or delete old users in Firebase Authentication each semester, or (b) add one rule line that requires a fresh sign-in every N days (`auth.token.auth_time`). The current build keeps students signed in, as requested. |
| Geofence bypass with developer tools | Accepted: the geofence is a usage policy, not a security boundary. The data is protected by the SNU login. |

## 7. Free-tier budget (Spark plan)

| Limit | Free amount | Our use |
| ----- | ----------- | ------- |
| Database storage | 1 GB | A few KB (state overwrite, no history) |
| Database download | 10 GB/month (~360 MB/day) | About 1–2 MB per student per hour of viewing (each moving caddy writes at most once every 2 s; a parked one every 30 s). Sessions are short (open, look, close), and listeners stop when the app is hidden. |
| Simultaneous DB connections | **100** | Driver phones (one per caddy) + students who have the app **on screen, on campus**. Phase 4 also pauses after a few minutes without interaction. |
| New accounts | 100 per hour per IP address | Campus Wi-Fi shares IP addresses, so plan a staggered launch. The app shows a clear "try again in a few minutes" message. |
| Email-link sign-in | 5 emails/day | Not used. |
| Daily active users | 3,000/day **only** if the project is upgraded to "Identity Platform" | Do **not** upgrade. Standard Firebase Auth is enough. |
| Hosting | 10 GB storage, 360 MB/day transfer | App files are about 200 KB. Leaflet and the Firebase SDK come from public CDNs. |
| CARTO basemap tiles | 5 million requests/month (non-commercial key) | Tiles are cached for 30 days by the browser. |

If SNU grows past 100 viewers at the same moment, the next step is the
Blaze (pay-as-you-go) plan: it keeps the free quotas and raises the
connection limit to 200,000. At this data volume the cost would be very low,
but it needs a billing account. That is a decision for SNU IT.

## 8. Failures and edge cases

| Situation | What happens |
| --------- | ------------ |
| GPS fix is blurry (> 20 m) | Dropped on the phone, and the rules reject it too. |
| Caddy parked for a long time | One heartbeat every 30 s. If the browser reports no new fix, the phone asks the GPS for one. |
| Driver drives through a dead zone | No writes are queued. The server sets `online: false` (`onDisconnect`). On reconnect the phone sends only its newest fix and registers `onDisconnect` again (`.info/connected`). |
| Phone battery dies, app is killed | The server runs `onDisconnect`: `online: false`. |
| Phone clock is wrong | All times are server time (`ServerValue.TIMESTAMP`); students use the server time offset for the 90 s check. |
| Student switches app or locks the phone | Page Visibility API: no GPS, no timers, database connection closed. |
| Student is off campus | "You're outside campus—live tracking activates on campus grounds." No data is loaded. |
| Student denies location | A clear card explains why location is needed and that it stays on the phone. No data is loaded. |
| Site opened over plain `http://` | Location needs HTTPS; the app says so. |
| Non-SNU Google account | The account is removed again, and the app asks for an `@snu.edu.in` account. |
| Too many sign-ups from one network | Clear message; try again later or on mobile data. |
| Setup code expired or already used | Clear message; the admin makes a new code. |
| Driver phone storage was cleared | The phone opens the student app; the admin links it again. |
| Phone revoked while driving | The shift stops at once and the driver screen shows "An admin unlinked this phone". |
| Driver denies location | The shift does not start; the screen explains how to allow location in Chrome. |
| Driver leaves campus during a shift | Location not shared; the caddy shows offline until it is back. |
| Screen Wake Lock refused (battery saver) | The screen says the screen can turn off; every tap tries again. |
| Installed iPhone app (standalone) | Sign-in uses a full-page redirect instead of a popup. |
| No Google Play Services | Nothing in the app needs them: web OAuth, W3C Geolocation, WebSocket. |

## 9. Delivery phases

| Phase | Scope | Status |
| ----- | ----- | ------ |
| 1 | Uber-style map, bottom sheet, theme (Auto/Light/Dark), demo/pitch mode | Done |
| 2 | Firebase project, `@snu.edu.in` login, geofence, QR device binding, admin dashboard, security rules + tests | Done |
| 3 | Driver screen: GO / Seats open / Full / Go offline, GPS gate, Screen Wake Lock, `onDisconnect`, dead-zone recovery | Done |
| 4 | Live caddies on the student map, 90 s "Signal lost", connection management, service worker (offline app shell), strict CSP | Next |
