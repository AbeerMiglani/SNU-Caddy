// Small geo helpers. Points are { lat, lng } objects (same shape as Leaflet LatLng).

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance in metres (haversine). */
export function distanceM(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from a to b in degrees: 0 = north, 90 = east. */
export function bearingDeg(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Straight-line blend between two points, t in [0, 1].
 * Plain degree interpolation is accurate to centimetres over campus distances.
 */
export function lerpLatLng(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Move a point by metres to the north and east. */
export function offsetM(p, northM, eastM) {
  return {
    lat: p.lat + toDeg(northM / EARTH_RADIUS_M),
    lng: p.lng + toDeg(eastM / (EARTH_RADIUS_M * Math.cos(toRad(p.lat)))),
  };
}

/** Signed smallest turn from one heading to another, in [-180, 180). */
export function turnDeg(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180;
}
