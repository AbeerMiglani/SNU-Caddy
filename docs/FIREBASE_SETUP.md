# Firebase setup (100% free Spark plan)

Time: about 20 minutes. You need a Google account. For a university
service, use a shared SNU or project account, not a personal one, so that
IT can take it over later.

You do **not** need a credit card. Stay on the **Spark** plan.

## Step 1: Create the project

1. Open <https://console.firebase.google.com> and click **Create a project**.
   (A Google account that never used Firebase must first accept the Firebase
   Terms of Service there. Until then, tools such as the Firebase CLI get
   "403 The caller does not have permission" when they add Firebase.)
2. Name: `snu-caddy` (Firebase may add a suffix, for example `snu-caddy-1a2b3`).
   This is your **project ID**.
3. Google Analytics: **turn it off** (not needed, and better for privacy).
4. Click **Create project**.

## Step 2: Add the web app

1. On the project overview page, click the **Web** icon (`</>`).
2. Nickname: `SNU Caddy web`. Do **not** tick "Firebase Hosting" here (we
   set it up from the command line in step 6).
3. Click **Register app**. Keep the `firebaseConfig` object that the page
   shows. You need it in step 5.

## Step 3: Turn on sign-in

1. **Build → Authentication → Get started**.
2. **Sign-in method** tab:
   - **Google** → Enable. Public-facing name: `SNU Caddy`. Support email: your
     email. Save.
   - **Anonymous** → Enable. Save. (Used only by linked driver phones.)
3. **Settings → Authorized domains**: `localhost`, `<project-id>.firebaseapp.com`
   and `<project-id>.web.app` are already there. Add a custom domain only if
   you use one later.
4. If the console offers **"Upgrade to Firebase Authentication with Identity
   Platform"**, do **not** accept it. On the free plan, that upgrade adds a
   limit of 3,000 daily active users.

## Step 4: Create the Realtime Database

1. **Build → Realtime Database → Create Database**.
2. Location: **Singapore (asia-southeast1)**. Realtime Database has only
   three regions (us-central1, europe-west1, asia-southeast1) and none in
   India; Singapore is the closest to Greater Noida, so updates arrive faster.
   The region cannot be changed later.
3. Security rules: **Start in locked mode**. (Step 6 uploads our real rules.)
4. Copy the database URL at the top of the **Data** tab, for example
   `https://snu-caddy-default-rtdb.asia-southeast1.firebasedatabase.app`.

## Step 5: Put the config in the app

Open `js/firebase-config.js` and replace the values with your project's values
(the file ships with the SNU project, `snu-caddy-45q9r`):

```js
export const FIREBASE_CONFIG = {
  apiKey: '…',
  authDomain: '<project-id>.firebaseapp.com',
  databaseURL: 'https://<project-id>-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: '<project-id>',
  appId: '…',
};
```

- Make sure `databaseURL` is there. If the console's config does not have
  it, paste the URL from step 4.
- These values are **not secret**. Every Firebase web app sends them to the
  browser. The security is in `database.rules.json`.
- With a project ID other than `snu-caddy-45q9r`, also change the
  `frame-src https://<project-id>.firebaseapp.com` entry of the
  Content-Security-Policy in `firebase.json` (Google sign-in uses that frame).
  `npm test` checks it.

## Step 6: Upload the rules and publish the app

You need Node.js 22 or newer (<https://nodejs.org>). For `npm test` you also
need a Java 21+ JDK (the test runs the Firebase Database Emulator).

```bash
npm install                 # installs the Firebase CLI and the test tools
npx firebase login          # opens a browser window to sign in
npx firebase use --add      # pick your project, alias: default
npm test                    # security-rule and driver tests in a local emulator
npm run deploy              # uploads database.rules.json and the website
```

The app is now live at:

- `https://<project-id>.firebaseapp.com` ← **use this address**
- `https://<project-id>.web.app` (same site)

Use the `firebaseapp.com` address. It is the same as `authDomain`, so Google
sign-in also works in browsers that block third-party storage (Safari,
Firefox, Brave, Vanadium on GrapheneOS).

No command line? You can paste `database.rules.json` into **Realtime Database
→ Rules** in the console and click **Publish**. (Hosting still needs the CLI.)

## Step 7: Make yourself the first admin

1. Open `https://<project-id>.firebaseapp.com/admin.html`.
2. Click **Continue with Google** and choose your `@snu.edu.in` account.
3. The page says **"Not an admin yet"** and shows your user ID. Click **Copy**.
4. In the console: **Realtime Database → Data**. Hover over the root, click
   **+**, and add:
   - Key: `admins`
   - Then, under `admins`: key = your user ID, value = `true`
     (type `true` without quotes, so it is a boolean).
5. Reload the admin page. You now see the dashboard.

Add other admins the same way. To remove an admin, delete their entry.

## Step 8: Add the caddies

On the admin page, under **Caddies**, add each caddy: number `1`, name
`Caddy 01`; number `2`, name `Caddy 02`; and so on.

## Step 9: Link each driver phone (once per phone)

1. On the driver's Android phone, open `https://<project-id>.firebaseapp.com`
   in Chrome and install it: **⋮ → Add to Home screen / Install app**. Open
   SNU Caddy from the new home-screen icon. (Installed apps get persistent
   storage, so Android does not clear the phone's link.)
2. Tap the name **SNU Caddy** at the top **5 times quickly**. The setup screen
   opens.
3. On the admin page, under **Link a driver phone**, choose the caddy and
   click **Create setup QR**.
4. On the phone, tap **Scan QR code** and point the camera at the QR. (Or
   scan the QR with the phone's normal camera app; it opens the link.)
5. The phone shows the black driver screen with the caddy name. Done. The
   driver never logs in.
6. Test it once: tap **GO** and allow location. Within a few seconds the
   caddy appears as online under **Realtime Database → Data → caddies**.
   Tap **Go offline** twice when done.

To unlink a phone (lost, replaced): admin page → **Linked phones** →
**Revoke**.

## Step 10: Students

Share `https://<project-id>.firebaseapp.com`. Students tap **Continue with
Google**, choose their `@snu.edu.in` account, and allow location once.

## Optional hardening

- **Restrict the browser API key** to your domains: Google Cloud console →
  APIs & Services → Credentials → the "Browser key" → Application
  restrictions → Websites → add `https://<project-id>.firebaseapp.com/*`,
  `https://<project-id>.web.app/*` and `http://localhost/*`.
- **Budget alert**: not needed on Spark (it cannot charge you).

## Test everything locally first (no Firebase project needed)

The Firebase emulators run the same Auth and Database on your computer. You
need Node.js 22+ and a Java 21+ JDK.

```bash
npm install
npm run emulators           # Auth :9099, Database :9000, Hosting :5000, UI :4000
```

Then open <http://localhost:5000/?emulator=1> (student app) and
<http://localhost:5000/admin.html?emulator=1> (admin). Google sign-in shows a
fake account page from the emulator. To make your test account an admin:

1. Open the Emulator UI at <http://127.0.0.1:4000> → **Realtime Database**.
2. In the database list at the top, choose **demo-snu-caddy-default-rtdb**
   (the one that has our security rules; the app uses it).
3. Add `admins/<uid>: true`.

`npm test` starts its own emulator, so stop `npm run emulators` (Ctrl-C)
before you run it.
