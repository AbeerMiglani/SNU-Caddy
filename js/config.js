// Central settings for the whole app. Change values here, not in the modules.

import { CAMPUS_BBOX } from './data/campus.js';

export const APP_NAME = 'SNU Caddy';

/** Campus centre, as given by the SNU team. */
export const CAMPUS_CENTER = [28.5267, 77.5754];

/** Box given by the SNU team: [[south, west], [north, east]]. */
const TEAM_BOX = [
  [28.518, 77.565],
  [28.534, 77.584],
];

/**
 * Camera lock (Leaflet `maxBounds`): the OSM fence box joined with the team
 * box, plus about 150 m so the gates and edge roads never touch the screen edge.
 */
export const MAX_BOUNDS = padBox(joinBox(CAMPUS_BBOX, TEAM_BOX), 0.0015);

export const MAP = {
  maxZoom: 19,
  zoomSnap: 0.5,
  /** Zoom used when the camera goes to one caddy. */
  focusZoom: 17.5,
};

/**
 * CARTO basemaps need a free API key (new CARTO rule in 2026): without one,
 * every tile is an "API KEY REQUIRED" watermark (checked October 2026).
 *  - Free for non-commercial use, up to 5 million tile requests a month.
 *  - In the CARTO dashboard, restrict the key to the app's domains.
 * The key is public by design (it is in every tile URL), so it is safe in this file.
 * With no key, or if CARTO refuses the tiles, the map uses grey OpenStreetMap tiles.
 */
export const CARTO_KEY = 'cb1_4mna_1_ff92d71f8afbdac33e36e57a';

/** CartoDB basemaps: Positron (light) and Dark Matter (dark). {r} = sharp @2x tiles on retina screens. */
export const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key={key}',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key={key}',
  subdomains: 'abcd',
  key: CARTO_KEY,
  /** CARTO raster tiles exist up to zoom 18; Leaflet scales them for zoom 19. */
  maxNativeZoom: 18,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  /**
   * No-key fallback: standard OSM tiles, made grey (or inverted in dark mode) with CSS.
   * The OSM tile policy allows light use only, so do not ship this to all students.
   */
  fallback: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxNativeZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
};

/**
 * GPS rules shared by the demo and the driver screen (Phase 3).
 * A fix goes to the database only if it is sharp enough AND the caddy moved
 * far enough, or if the heartbeat time has passed.
 */
export const GPS_RULES = {
  maxAccuracyM: 20,
  minMoveM: 5,
  heartbeatMs: 30_000,
};

/** Driver phone: how the shift engine (js/driver-shift.js) talks to the database. */
export const DRIVER = {
  /**
   * At most one position write per this time. The database allows one per
   * second; the extra time absorbs network jitter and, at caddy speed, cuts
   * the data that every student downloads by up to 40%.
   */
  minWriteGapMs: 2000,
  /** After the server confirms a write, wait at least this long (its 1 s limit). */
  ackGapMs: 1100,
  /** Only fixes this new are sent. An older fix means: ask the GPS again. */
  fixFreshMs: 10_000,
  /** No fix for this long: the screen says "No GPS signal". */
  gpsLostMs: 20_000,
  /** How often the engine checks the heartbeat and the GPS. */
  tickMs: 5000,
  /** A shift paused for longer than this (app closed or in the background) ends by itself. */
  resumeWithinMs: 10 * 60_000,
  /** This many refused writes in a row: tell the driver to call an admin. */
  refusedAfter: 3,
  /** Blurry fixes for this long after the last sharp one: the screen says "GPS is weak". */
  weakAfterMs: 5000,
  /** An error radius above this means "approximate location" (precise location is off). */
  approximateM: 500,
  /** Moving (for "Moving" / "Parked"): GPS speed at least this (m/s), ... */
  movingSpeedMs: 1,
  /** ... or, without speed, this far (and beyond the error radius) from the last move. */
  movingMinM: 10,
  /**
   * Charging ends only when the caddy moves AND is this far from where the
   * driver set it: GPS drift of a parked phone must not end it.
   */
  chargeClearM: 30,
};

/** Student map: what each caddy's state means. */
export const LIVE = {
  /** No new data for this long: "Signal lost" (the caddy is dimmed). */
  signalLostMs: 90_000,
  /** No real move for this long: "Parked" instead of "Moving". */
  parkedAfterMs: 60_000,
  /** No touch for this long: live updates pause (saves battery, data and DB connections). */
  idlePauseMs: 5 * 60_000,
};

/** How caddy icons glide between GPS pings on the student map. */
export const GLIDE = {
  /** Frame cap for the glide loop. Caddies move slowly, so 30 fps looks smooth. */
  fps: 30,
  minMs: 300,
  maxMs: 6_000,
  /** Used when the time between pings is unknown or too long. */
  fallbackMs: 1_000,
  /** Make each glide a bit longer than the ping gap so the icon never stops between pings. */
  stretch: 1.15,
  /** Jump straight to the new point (no glide) when it is farther than this. */
  teleportM: 250,
  /** Minimum movement before the icon turns, so a parked caddy does not spin on GPS noise. */
  minTurnMoveM: 3,
};

/** Demo / pitch mode. Speed can also be set in the URL: ?demo=1&speed=2 */
export const DEMO = {
  seed: 2026,
  cruiseKmh: 15,
  gpsTickMs: 1_000,
  gpsNoiseM: 1.2,
  dwellMs: [8_000, 15_000],
  /** One caddy takes a long break at one stop, so the pitch also shows "Parked". */
  longBreak: { caddy: 'caddy-03', stop: 'D Block', ms: 100_000 },
  /** Chance of a blurry fix (> 20 m), which the accuracy filter must drop. */
  badFixChance: 0.03,
  parkedMinutesAgo: 14,
  /** One caddy is plugged in at a landmark (see LANDMARKS), so the pitch shows "Charging". */
  charging: { id: 'caddy-05', name: 'Caddy 05', landmark: 'DH1', movedMinutesAgo: 25 },
};

/** Student / admin login: Google accounts on this domain only (enforced again in the database rules). */
export const AUTH = {
  domain: 'snu.edu.in',
};

/**
 * Campus geofence for students (a usage policy; the data is protected by login).
 * Location is checked on the phone only and never sent anywhere.
 */
export const GEOFENCE = {
  /** Still "on campus" up to this far outside the fence (GPS error, gates, roadside stops). */
  marginM: 100,
  /** Accept a recent cached fix: no need to wake the GPS each time. */
  maxAgeMs: 120_000,
  timeoutMs: 15_000,
  /** Check again while the app stays open on screen. */
  recheckMs: 5 * 60_000,
};

/** "Near <landmark>" is shown only within this distance. */
export const NEAR_LANDMARK_M = 120;

function joinBox(a, b) {
  return [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1])],
  ];
}

function padBox(box, deg) {
  return [
    [box[0][0] - deg, box[0][1] - deg],
    [box[1][0] + deg, box[1][1] + deg],
  ];
}
