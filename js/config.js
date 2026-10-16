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
 * CARTO basemaps need a free API key (new CARTO rule in 2026).
 *  1. Request it at https://carto.com/basemaps/apikey (email only, no account).
 *     Free for non-commercial use up to 5 million tile requests a month.
 *  2. Paste it below.
 *  3. In the CARTO dashboard, restrict the key to your website's domain.
 * The key is public by design (it is in every tile URL), so it is safe in this file.
 * Until a key is set, the map uses grey OpenStreetMap tiles (good for development only).
 */
export const CARTO_KEY = '';

/** CartoDB basemaps: Positron (light) and Dark Matter (dark). {r} = sharp @2x tiles on retina screens. */
export const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key={key}',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key={key}',
  subdomains: 'abcd',
  key: CARTO_KEY,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
    '&copy; <a href="https://carto.com/attributions">CARTO</a>',
  /**
   * No-key fallback: standard OSM tiles, made grey (or inverted in dark mode) with CSS.
   * The OSM tile policy allows light use only, so do not ship this to all students.
   */
  fallback: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
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
  /** Chance that a caddy flips between "Seats open" and "Full" at a stop. */
  flipChance: 0.35,
  /** Chance of a blurry fix (> 20 m), which the accuracy filter must drop. */
  badFixChance: 0.03,
  parkedMinutesAgo: 14,
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
