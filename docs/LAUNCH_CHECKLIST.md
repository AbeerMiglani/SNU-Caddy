# SNU Caddy: launch checklist

The code is ready. This list holds the steps that need a person: the project
owner, an admin, or someone on campus. Do them in this order.

## 0. Move to snu-caddy.abeermiglani.com (project owner)

The app's address is `snu-caddy.abeermiglani.com` (`CUSTOM_DOMAIN` in
`js/firebase-config.js`). It replaces `snu-caddy.abbykayo.com`, which is
removed. Do the steps in this order: until the Google Cloud step is done,
sign-in fails on the new address.

- [ ] **Firebase Hosting.** Firebase console → Hosting → Add custom domain →
      `snu-caddy.abeermiglani.com`. Do not tick the redirect option. Keep
      the page open: it shows the DNS records to add.
- [ ] **Cloudflare DNS** (zone `abeermiglani.com`). Add exactly the records
      that Firebase shows, with the proxy **off** (grey cloud, "DNS only").
      Cloudflare's proxy adds its own script to the pages, which the app's
      security policy blocks. Wait until Firebase says the domain is
      connected and the certificate is active (minutes to a few hours).
- [ ] **Authorized domains.** Firebase console → Authentication →
      Settings → Authorized domains → Add `snu-caddy.abeermiglani.com`.
- [ ] **Google Cloud: sign-in handler.** Google Cloud console (project
      `snu-caddy-45q9r`) → APIs & Services → Credentials → OAuth 2.0
      Client IDs → "Web client (auto created by Google Service)" →
      Authorized redirect URIs → add
      `https://snu-caddy.abeermiglani.com/__/auth/handler` → Save. If the
      console asks, also add `abeermiglani.com` to the authorized domains of
      the OAuth consent screen. Changes can take a few minutes.
- [ ] **Deploy** the release that names the new address (`npm run deploy`).
- [ ] **Test** on the new address: sign in as a student (in a browser tab
      and in the installed app), open `/admin.html` and sign in.
- [ ] **Re-link every driver phone** on the new address. A phone keeps its
      link per address, so phones linked on the old one are not linked on
      the new one. Per phone: open `https://snu-caddy.abeermiglani.com`,
      install it, link it with a new setup code (section 4). Then
      **Unlink** the phone's old entry on the admin page: under **Linked
      phones** it is the older row of the same caddy.
- [ ] **Tell students** the new address. They sign in and allow location
      once more there, and reinstall the app if they had installed it.
- [ ] **Remove the old address**, only after the phones work on the new
      one: Firebase console → Hosting → `snu-caddy.abbykayo.com` → Delete;
      Cloudflare (zone `abbykayo.com`) → delete the `snu-caddy` records;
      Authentication → Authorized domains → delete
      `snu-caddy.abbykayo.com`; and its handler URL in the OAuth client,
      if it is listed.

## 1. Accounts and keys (project owner)

- [ ] **Restrict the CARTO map key** to the app's addresses. CARTO dashboard →
      the key in `js/config.js` (`CARTO_KEY`) → allowed domains:
      `snu-caddy.abeermiglani.com`, `snu-caddy-45q9r.web.app` and
      `snu-caddy-45q9r.firebaseapp.com`. Without this, another site can use up
      the free 5 million tiles a month. (If CARTO refuses the tiles, the app
      falls back to grey OpenStreetMap tiles by itself.)
- [ ] **Restrict the Firebase browser key** to the same addresses. Google
      Cloud console → APIs & Services → Credentials → "Browser key" →
      Website restrictions. Keep `http://localhost/*` only if you develop
      against the real project.
- [ ] **Authorized domains.** Firebase console → Authentication → Settings →
      Authorized domains: the two Firebase addresses (there by default),
      `snu-caddy.abeermiglani.com` (section 0) and `localhost`. Nothing else.
- [ ] **A second admin.** Add one more trusted person under `admins` (see
      `docs/FIREBASE_SETUP.md`, step 7), so that one absent admin does not
      block the service.
- [x] **Licence.** MIT (`LICENSE`): the code is open to all, for any use.

## 2. People (SNU side)

- [ ] **Drivers know what is shared.** The caddy's position is public to
      signed-in SNU accounts between **GO** and **Go offline**, on campus
      only. There is no history. Tell each driver this before the first shift.
- [ ] **The privacy text is approved.** The **(i)** button in the app shows
      what the app does with student location (it stays on the phone) and
      with sign-in. Ask SNU IT to read it.
- [ ] **Someone reads the help address.** The About dialog tells students to
      write to the address in `js/config.js` (`SUPPORT_EMAIL`). Make sure
      that mailbox is read, and tell drivers who to call.

## 3. Campus data (someone who knows the campus)

- [ ] **Check the place names.** Open the app, tap a caddy (or use
      `/?demo=1`) and zoom in: the map names 31 places. Wrong or missing
      names are fixed in `tools/build_campus_data.py` (see the README,
      "Update the campus data").
- [ ] **Check the fence.** Walk or drive to each gate with the app open. The
      map must stay on (the fence has a 100 m margin). If the app says
      "You are outside campus" at a gate, the fence line in OpenStreetMap
      needs a fix.

## 4. Each driver phone (admin, about 5 minutes per phone)

- [ ] Android phone with Chrome, mobile data, and a charger in the caddy.
- [ ] Open the app address and **install it** (⋮ → Add to Home screen). Open
      it from the new icon. An installed app keeps its link when the phone
      runs low on storage.
- [ ] Link it: 5 taps on the name **SNU Caddy**, scan the setup code from the
      admin page.
- [ ] Tap **GO** and allow location. Choose **Precise** and **While using
      the app**.
- [ ] Phone settings: battery saver **off** for Chrome, and a mount where
      the screen can stay on. The shift pauses when the app is not on screen.
- [ ] On the admin page, the caddy's row must say **Moving** or **Parked**
      with an age that counts up from "just now" and jumps back every 30 s
      or sooner.

## 5. Test run before the announcement

- [ ] `npm test` and `npm run test:e2e` pass (CI runs both on every pull
      request).
- [ ] One full shift with one caddy: GO, drive the whole route, **Charging**
      (two taps), drive off (it must clear by itself), **Go offline**.
- [ ] A student phone on campus: sign in, allow location. Check the blue
      dot, the distance in the list, and **Show my location**.
- [ ] The same on an iPhone (Safari) and on an Android phone (Chrome).
- [ ] A student phone off campus: the app must say "You are outside campus".
- [ ] A dead zone: drive the caddy through one. Students must see
      **Signal lost** after 90 s and the caddy must come back by itself.
- [ ] Unlink a phone on the admin page: the phone must return to the student
      app within seconds.

## 6. Launch day

- [ ] **Sign-up limit.** Firebase allows a limited number of new accounts
      per hour from one network address, and campus Wi-Fi is one address
      for many students. The app then says "Too many sign-ins from this
      network right now". Mobile data works. In the Firebase console, look
      at Authentication → Settings → Sign-up quota for a temporary higher
      limit, and announce the app to one group at a time.
- [ ] **Connection limit.** The free Spark plan allows 100 open database
      connections at the same moment. The app closes its connection when
      it is hidden, off campus or idle for 5 minutes, so 100 means 100
      students who look at the map in the same minute. Watch Firebase
      console → Realtime Database → Usage. If the peak comes near 100, move
      to the Blaze plan: its limit is 200,000 connections for each database,
      and you pay only for stored and downloaded data above the free amounts
      (this app stores a few kilobytes).
- [ ] **Roll back if needed.** Firebase console → Hosting → Release history
      → Roll back. The database rules have their own history under Realtime
      Database → Rules.

## 7. Every semester

- [ ] Remove users who left SNU: Firebase console → Authentication → Users.
      A session stays valid until sign-out (see `docs/ARCHITECTURE.md`,
      threat model).
- [ ] Remove caddies that left the fleet (**Remove** on the admin page) and
      unlink phones that are no longer used.
- [ ] Run `python3 tools/build_campus_data.py` if new buildings were mapped.

## Not in version 1.0

These were left out on purpose. None of them blocks a launch.

- **Arrival times.** Caddies have no fixed timetable in the data, so the
  app shows where a caddy is, not when it arrives.
- **Notifications.** No push messages (they need a server, which the free
  plan does not have).
- **Firebase App Check.** It would stop scripts that are not the app from
  using the project. The security rules already protect the data.
- **Location history and statistics.** The database keeps only the newest
  position of each caddy.
