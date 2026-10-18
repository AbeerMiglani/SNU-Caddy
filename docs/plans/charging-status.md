# Plan: "Charging" driver status

> **Status: implemented (PR #4).** This is the plan as written before review.
> Some details changed during review (for example, Charging now ends only
> when the caddy drives about 30 m away, and the cache version). Where this
> file and `docs/ARCHITECTURE.md` differ, ARCHITECTURE describes the shipped
> behaviour. Later review fixes changed more: Charging needs two taps, Go
> offline and `onDisconnect` also clear `charging`, and the demo's charging
> caddy is generated (`DEMO_CHARGING`) at Faculty Residence.

## Context

Drivers need to tell students "this caddy is parked and plugged in, don't wait for it". Today a parked caddy shows as **Parked**, which reads as "available soon". Product decisions are fixed (see the request): one-tap toggle while Online, no return estimate, students see a 5th state "Charging" with the pin still shown, Signal lost and Offline win, location keeps heartbeating, OLED-black driver screen stays low-interaction.

## 1. Data model

One new optional boolean on `caddies/{id}`: **`charging`**.

- **Rules:** `"charging": { ".validate": "newData.isBoolean()" }`. It is *not* added to `hasChildren([...])`, so old clients and existing tests keep working. `$other: false` stays, so `status` is still refused.
- **Not tied to `lastUpdated`.** Unlike lat/lng/bearing/accuracy/`movedAt`, a boolean flip is not a position, so it needs no new server timestamp. Same precedent as `online` ("going online/offline is not rate-limited"). The 1-write-per-second rule is untouched: position writes still need a fresh `lastUpdated` >= 1 s after the last.
- **Two write paths, both carry the flag:**
  1. *Toggle:* `store.setFields({ charging })` (a plain `update`, like `markOffCampus` does for `online:false`). The label flips on students' phones in about a second, even if there is no fresh GPS fix.
  2. *Every position write also carries `charging`* (next to `online: true`), so a flag lost to a dead zone or stale data is corrected by the next heartbeat (<= 30 s). This mirrors how `online: true` self-heals today.
- **`lastUpdated`:** the toggle does not touch it, so it does not hide a stale caddy: "Signal lost" still comes from `lastUpdated` age.
- **`onDisconnect`: unchanged** (`{ online: false }`). A disconnected charging phone is `online:false`, and `caddyState` checks `online` first, so Offline wins. The leftover `charging:true` is harmless: the next shift's first position write overwrites it, and `go()` resets the engine flag to false.
- **`stop()` / off-campus `markOffCampus`:** leave as `{ online: false }`. (Optional tidy: also send `charging:false` in `stop()`. Not needed, and it would change the existing `deepEqual(... { online: false })` asserts. Skipping.)
- **Engine keeps the flag in memory**, resets it on `go()`, and passes it to the store as an option: `sendPosition(fields, { moved, charging })`. This keeps `fields` unchanged, so `tests/driver-shift.test.mjs:162` (`deepEqual(db.positions[0], {lat,lng,accuracy})`) still holds.

## 2. Files that change

| File | Change |
| --- | --- |
| `database.rules.json` | Add the `charging` validate line. Update the header comment. |
| `js/driver-shift.js` | New `charging` field in `ShiftState` (typedef + initial state). New `setCharging(on)` on the returned API: no-op unless `mode === 'on'`; sets the flag, `store.setFields({ charging: on })`, `emit()`. `send()` passes `{ moved, charging }`. `go()` resets to false. `stop()` resets to false. Update the `Store` typedef and the header comment. Auto-clear question: see section 6. |
| `js/driver-screen.js` | `caddyStore.sendPosition` adds `charging` to its update. New `els.charge` button (`driver-charge`). Click handler: `buzz()`, `shift.setCharging(!ui.shift.charging)`. `statusLine()`: after the "Sending location…" / stale checks, `if (s.charging) return ['Charging', 'Students see this caddy as charging.', 'charging']`. Problem states (refused, outside, GPS, no internet) still win over it, because they come earlier in the function. `render()`: show the Charging button only while `on`. Add `charging` to the tone handling (`lightUpFor` ignores it, so it is treated like `ok`: no wake-up). |
| `driver.html` | One new `<button class="driver__charge" id="driver-charge" hidden>Charging</button>` in the footer. HTML only, no inline script, so the CSP hashes are unaffected. |
| `css/driver.css` | `--charge` token. `.driver__status[data-tone='charging'] .driver__head { color: var(--charge) }`. `.driver__charge` styled like `.driver__off` (grey fill, 56 px, 8 px corners). In charging mode: `aria-pressed="true"` plus a purple text/outline so the on-state is clear without a new shape. Landscape layout: the two buttons stack in the bottom area. Stays on `#000`, no animation. |
| `js/caddy-state.js` | `STATE_TEXT.charging = 'Charging'`. `STATE_ORDER`: moving 0, parked 1, **charging 2**, lost 3, offline 4. `caddyState`: `offline` → `lost` → `charging` → moving/parked. Update the header comment and JSDoc return type. |
| `js/live.js` | `toRecord`: add `charging: v.charging === true`. |
| `js/caddy-list.js` | The state word comes from `STATE_TEXT`, and the place comes from `placeLabel` (already gives "Near DH1"), so the row reads "Near DH1 · updated 5 s ago" with state "Charging". Needed: the summary adds `· N charging` (like the existing `signal lost` part); a caddy that is only charging must not count as "online" (it is not catchable), so the `online` count stays `moving + parked`. |
| `js/caddy-layer.js` | `setZ`: `charging: -250` (draws under catchable caddies, above Signal lost). `applyState` already writes `data-state` and the aria label from `STATE_TEXT`. JSDoc state union gains `'charging'`. |
| `css/app.css` | Tokens `--state-charging` (light + dark block). `[data-state='charging'] { --dot: var(--state-charging); }`. No dimming of the cart (the pin must stay clearly visible). |
| `js/main.js` | No logic change. `caddyState(merged, now)` already gets `charging` from the record. |
| `js/demo.js` + `js/config.js` | Make one demo caddy Charging: add `DEMO.charging = { id: 'caddy-05', name: 'Caddy 05', landmark: 'DH1' }` and resolve the coordinates from `LANDMARKS` (DH1 exists in `campus.js`). No change to the **generated** `demo-routes.js` / `tools/build_campus_data.py`. `start()` emits it with `online: true, charging: true`; the simulator re-emits it on each 30 s heartbeat (otherwise it would turn "Signal lost" after 90 s) and from `resume()`; `stop()` removes it. |
| `js/admin.js` | **No change.** It does not display state; it only force-offlines (`online:false`), and Offline wins anyway. |
| `sw.js` | Bump `CACHE` `snu-caddy-v3` → `v4` (shell files changed). No `SHELL` change, since no new files. |

## 3. Tests

**`tests/database.rules.test.mjs`** (32 → 36):
1. Bound driver may write `charging: true` and `false` (position + `charging`), and may flip it alone with `update(node, { charging: true })` right after a position write (no new `lastUpdated`).
2. `charging` must be a boolean: `'yes'` and `1` refused (add to the field-validation test or a new test).
3. A student and an unbound phone cannot write `charging`.
4. The old `status: 'open'` and `extra: 1` writes are still refused (existing asserts at lines 205/211 stay).
5. `onDisconnect` still sets `online:false` while `charging:true`, and the node stays valid (extend the existing onDisconnect test).

**`tests/driver-shift.test.mjs`** (31 → ~36), extend `fakeDb` to record `charging` from the `sendPosition` options:
1. `setCharging(true)` while on → one `fields` call `{ charging: true }`, state `charging === true`; again → `false`.
2. `setCharging` while idle is a no-op (no write).
3. Next heartbeat/position write after toggling carries `charging: true`; the toggle does not break the 2 s write gap or the 1-write-in-flight rule.
4. `stop()` and a new `go()` start with `charging === false` (the next shift's first write says `false`).
5. Toggle while offline (no connection): state flips, the write is left to the SDK queue, and the next position write after reconnect carries the right value.

**Unit test for `caddyState`** (new `tests/caddy-state.test.mjs`, about 3 tests): charging + fresh → `charging`; charging + stale → `lost`; charging + `online:false` → `offline`. This is the one place the precedence rule is checked, so it is worth the small file. (It must also be checked against `sw.test.mjs`/`modulepreload.test.mjs`, since it is a test file only, not a shell file.)

New totals: about 36 rules tests + about 42 unit tests (31 + 5 shift, 3 + 2 + 3 other = 8 existing non-shift, + 3 state). I will count for real after writing them.

## 4. Docs

- `README.md`: state table (line ~133) gets a **Charging** row; line 11 phase table and line 203 file-map comment gain "Charging"; the demo caddy table gets Caddy 05; test counts at lines 57, 215, 216.
- `docs/ARCHITECTURE.md`: the product bullet (line 8), the data model JSON sample (`"charging": false`), the states table (line ~120, with the precedence rule), the driver screen paragraph (Charging button, purple headline), the rules section (`charging` boolean, status field still refused), the test counts (lines 48, 210, 212), the phase table (324), and the Design colour row (333: add Charging purple).
- `CLAUDE.md`: test-count example only if the numbers there are meant to track. They are an example string, so I will leave it unless you want it changed.

## 5. "Things that break easily"

- **CSP:** unaffected. Only a `<button>` is added; no inline script changes. `tests/csp.test.mjs` should stay green.
- **Service worker:** bump `CACHE` to `v4`. `SHELL` unchanged, no new modules or assets. (If I add the new test file, it is outside the shell.)
- **Modulepreload:** no new imports between modules (`live.js`, `caddy-state.js` already preloaded), so unchanged. `tests/modulepreload.test.mjs` confirms it.
- **LF endings:** all edits keep LF (the Windows trap in CLAUDE.md). I will check with `git diff --stat` / `.gitattributes` after editing.
- **Test counts** are hand-maintained: updated as above.
- **Rules change needs a rules test:** covered in section 3.
- **`textContent` only:** the new label and button text use `textContent`.

## 6. Risks and open questions for you

1. **Colour for Charging (recommend purple).** Green/blue/amber/grey are taken, red means error. Proposal: purple, light `#7356bf`, dark `#a58df0`, on both student dots and the driver headline; contrast to be verified with the same method used for the existing tokens before it ships. Alternative: teal (close to the Moving green on a small dot, which I'd avoid).
2. **Where "GO" appears while charging.** The request says "tapping it again (or GO) returns to Online". Today GO is the big blue circle shown only when idle, and `go()` is a no-op while on. Options: (a) the Charging button is a toggle, and that is the whole control (recommended: one button, no new layout); (b) also show a blue GO in charging mode that returns to Online. I assumed (a). Tell me if you meant (b).
3. **Auto-clear when it drives off.** If a driver forgets to un-tap, students see "Charging" on a moving cart. Cheap fix: in `send()`, if the fix counts as `moved`, clear `charging` locally and write it. This is a small deviation from "one tap" but removes the worst failure. Recommend yes; say no and I leave it manual.
4. **Wake/dim:** Charging is a calm state, so the screen dims as in Online (20 s). No change.
5. **Summary text.** "No caddies online · 1 charging" when only charging caddies exist. OK?
6. **Abuse / cost:** a bound phone can flip `charging` freely (no rate limit, like `online`). Same trust model as today (admin can unlink). A rate limit would need a timestamp field, so I'd not add one.
7. **Admin force-offline** leaves a stale `charging:true`. Harmless (Offline wins, next shift overwrites). Say if you want admin.js to clear it too.

## Verification (after you approve and I implement)

- `npm test` (emulator + unit), with `npm run emulators` stopped.
- `node --test tests/sw.test.mjs tests/csp.test.mjs tests/modulepreload.test.mjs` individually if anything fails.
- Manual: `python -m http.server 8000`, open `/?demo=1` and check the Charging row ("Near DH1", purple dot, sorted after Parked, summary count), light and dark themes, then `driver.html` with the emulators (`/?emulator=1`) for the toggle and the student view.
