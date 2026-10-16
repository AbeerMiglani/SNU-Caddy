// Full-screen Leaflet map with CartoDB tiles, locked to the SNU campus.
/* global L */

import { MAP, MAX_BOUNDS, TILES } from './config.js';
import { CAMPUS_BBOX, CAMPUS_POLYGON } from './data/campus.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * @param {HTMLElement} el  map container
 * @param {'light'|'dark'} initialTheme
 */
export function createMap(el, initialTheme) {
  const lockBounds = L.latLngBounds(MAX_BOUNDS);
  const campusBounds = L.latLngBounds(CAMPUS_BBOX);

  const map = L.map(el, {
    zoomControl: false, // Pinch to zoom, like Uber. Fewer buttons on screen.
    attributionControl: false,
    maxBounds: lockBounds,
    maxBoundsViscosity: 1.0, // Hard stop at the edge of campus.
    maxZoom: MAP.maxZoom,
    zoomSnap: MAP.zoomSnap,
    bounceAtZoomLimits: false,
    worldCopyJump: false,
  });

  L.control
    .attribution({ position: 'bottomright', prefix: '<a href="https://leafletjs.com">Leaflet</a>' })
    .addTo(map);

  // --- Tiles --------------------------------------------------------------
  // Battery: load tiles only when a pan/zoom ends, and keep a small buffer.
  const useCarto = Boolean(TILES.key);
  const tileOptions = {
    subdomains: TILES.subdomains,
    key: TILES.key,
    attribution: useCarto ? TILES.attribution : TILES.fallback.attribution,
    maxZoom: MAP.maxZoom,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 1,
  };
  const urlFor = (theme) => (useCarto ? TILES[theme] : TILES.fallback.url);
  if (!useCarto) {
    // CSS makes these tiles grey / dark, so a theme change needs no new tiles.
    el.classList.add('tiles-fallback');
    console.warn(
      'SNU Caddy: no CARTO key in js/config.js, so the map uses grey OpenStreetMap tiles. ' +
        'Get a free key at https://carto.com/basemaps/apikey',
    );
  }
  let tiles = L.tileLayer(urlFor(initialTheme), tileOptions).addTo(map);
  let tileTheme = initialTheme;
  let incoming = null;
  let incomingTheme = null;

  /** Cross-fade to the other basemap: the old layer goes away when the new one has loaded. */
  function setTheme(theme) {
    if (!useCarto) return;
    if (theme === (incoming ? incomingTheme : tileTheme)) return;
    if (incoming) {
      map.removeLayer(incoming);
      incoming = incomingTheme = null;
    }
    if (theme === tileTheme) return;
    const next = L.tileLayer(urlFor(theme), tileOptions);
    incoming = next;
    incomingTheme = theme;
    next.once('load', () => {
      if (incoming !== next) return;
      map.removeLayer(tiles);
      tiles = next;
      tileTheme = theme;
      incoming = incomingTheme = null;
    });
    next.addTo(map);
  }

  // --- Campus mask: dim everything outside the fence ----------------------
  const outer = lockBounds.pad(3);
  const outerRing = [
    outer.getNorthWest(),
    outer.getNorthEast(),
    outer.getSouthEast(),
    outer.getSouthWest(),
  ];
  // Colours come from CSS (.campus-mask / .campus-outline), so the theme switch is CSS-only.
  L.polygon([outerRing, CAMPUS_POLYGON], {
    className: 'campus-mask',
    interactive: false,
    stroke: false,
    fillOpacity: 1,
  }).addTo(map);
  L.polygon(CAMPUS_POLYGON, {
    className: 'campus-outline',
    interactive: false,
    fill: false,
    weight: 1.5,
  }).addTo(map);

  // --- Camera limits that respect the sheet / side panel -------------------
  // Leaflet's maxBounds and zoom floor work on the whole map box, but part of
  // it is under the bottom sheet or the side panel. So: (1) the zoom floor lets
  // the whole campus fit in the VISIBLE part, and (2) the lock is wider by the
  // covered pixels, so every corner of campus can be panned into view.
  let covered = { top: 0, bottom: 0, left: 0 };

  function updateLimits() {
    const size = map.getSize();
    // An expanded sheet hides most of the map; do not let that pull the floor far out.
    const bottom = Math.min(covered.bottom, size.y * 0.5);
    const z = map.getBoundsZoom(campusBounds, false, L.point(covered.left, covered.top + bottom));
    map.setMinZoom(Math.floor(z / MAP.zoomSnap) * MAP.zoomSnap);

    const zoom = map.getZoom();
    const sw = map.project(lockBounds.getSouthWest(), zoom).add([-covered.left, covered.bottom]);
    const ne = map.project(lockBounds.getNorthEast(), zoom).subtract([0, covered.top]);
    map.setMaxBounds(L.latLngBounds(map.unproject(sw, zoom), map.unproject(ne, zoom)));
  }

  map.fitBounds(campusBounds);
  updateLimits();
  // The lock is in pixels, so it changes with the zoom level.
  map.on('zoomend resize', updateLimits);

  /**
   * Centre for `latlng` so it shows in the middle of the part of the map that
   * is not under the bottom sheet / side panel.
   * @param {{ top: number, bottom: number, left: number }} cover  pixels hidden by UI
   */
  function centerFor(latlng, zoom, cover) {
    const p = map.project(latlng, zoom).add([-cover.left / 2, (cover.bottom - cover.top) / 2]);
    return map.unproject(p, zoom);
  }

  return {
    map,
    setTheme,

    /** The sheet or side panel moved: update the camera limits. */
    setCover(next) {
      covered = next;
      updateLimits();
    },

    /** Show the whole campus in the visible part of the screen. */
    fitCampus(cover, { animate = !reducedMotion.matches } = {}) {
      map.fitBounds(campusBounds, {
        paddingTopLeft: [cover.left + 16, cover.top + 16],
        paddingBottomRight: [16, cover.bottom + 16],
        animate,
      });
    },

    /** Move the camera to one caddy. */
    focus(latlng, cover) {
      const zoom = Math.max(map.getZoom(), MAP.focusZoom);
      const center = centerFor(latlng, zoom, cover);
      if (reducedMotion.matches) map.setView(center, zoom, { animate: false });
      else map.flyTo(center, zoom, { duration: 0.6 });
    },
  };
}
