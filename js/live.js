// Live caddies from Firebase for the student map.
//
// One WebSocket, no polling: the database pushes each change of `caddies`
// (one small object per caddy) and of `fleet` (the names). While live data
// is off (app hidden, off campus, demo, idle pause), the listeners are
// removed AND the connection is closed: on the free plan the database allows
// 100 open connections at the same moment, so a phone that does not look at
// the map must not hold one.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** "caddy_07" -> "Caddy 07" (used until the fleet name arrives). */
export const nameFromId = (id) => id.replace(/^caddy_/, 'Caddy ');

/**
 * Database object -> map / list record. All times move to this phone's clock
 * (serverTime - offset), so a wrong phone clock cannot fake "Signal lost".
 * @returns {object|null} null for an object that is not a usable caddy
 */
export function toRecord(id, v, name, offset) {
  if (!v || !isNum(v.lat) || !isNum(v.lng) || !isNum(v.lastUpdated)) return null;
  return {
    id,
    name: name ?? nameFromId(id),
    online: v.online === true,
    charging: v.charging === true,
    lat: v.lat,
    lng: v.lng,
    heading: isNum(v.bearing) ? v.bearing : null,
    speed: null,
    accuracy: isNum(v.accuracy) ? v.accuracy : null,
    ts: v.lastUpdated - offset,
    movedAt: isNum(v.movedAt) ? v.movedAt - offset : null,
  };
}

/**
 * @param {{
 *   onUpdate: (record: object) => void,
 *   onRemove: (id: string) => void,
 *   onStatus: (status: 'off'|'connecting'|'live'|'reconnecting'|'denied') => void,
 * }} hooks
 */
export function createLive({ onUpdate, onRemove, onStatus }) {
  let fb = null;
  let offs = [];
  let offset = 0;
  let names = {};
  let loaded = false; // the first full set of caddies arrived
  let connected = false;
  /** id -> last database object, so a new name or clock offset can re-emit it. */
  const raw = new Map();

  function emit(id) {
    const rec = toRecord(id, raw.get(id), names[id]?.name, offset);
    if (rec) onUpdate(rec);
    else onRemove(id);
  }

  function put(snap) {
    raw.set(snap.key, snap.val());
    emit(snap.key);
  }

  function drop(snap) {
    raw.delete(snap.key);
    onRemove(snap.key);
  }

  function report() {
    if (!offs.length) return;
    if (loaded && connected) onStatus('live');
    else onStatus(loaded ? 'reconnecting' : 'connecting');
  }

  function denied() {
    // Only an account that is no longer allowed gets here (rules: SNU login).
    detach();
    onStatus('denied');
  }

  function attach(next) {
    if (offs.length) return;
    fb = next;
    const { D, db } = fb;
    D.goOnline(db);
    loaded = false;
    connected = false;
    offs = [
      D.onValue(D.ref(db, '.info/serverTimeOffset'), (snap) => {
        offset = snap.val() ?? 0;
        for (const id of raw.keys()) emit(id);
      }),
      D.onValue(D.ref(db, '.info/connected'), (snap) => {
        connected = snap.val() === true;
        report();
      }),
      D.onValue(
        D.ref(db, 'fleet'),
        (snap) => {
          names = snap.val() ?? {};
          for (const id of raw.keys()) emit(id);
        },
        denied,
      ),
      D.onChildAdded(D.ref(db, 'caddies'), put, denied),
      D.onChildChanged(D.ref(db, 'caddies'), put),
      D.onChildRemoved(D.ref(db, 'caddies'), drop),
      // Fires once after the first full set (the same data: nothing extra is
      // downloaded). Until then the list says "Connecting…", not "No caddies".
      D.onValue(
        D.ref(db, 'caddies'),
        () => {
          loaded = true;
          report();
        },
        () => {},
        { onlyOnce: true },
      ),
    ];
    report();
  }

  function detach() {
    if (!offs.length) return;
    for (const off of offs) off();
    offs = [];
    for (const id of raw.keys()) onRemove(id);
    raw.clear();
    fb.D.goOffline(fb.db); // frees one of the 100 free connections
    onStatus('off');
  }

  return {
    attach,
    detach,
    get attached() {
      return offs.length > 0;
    },
  };
}
