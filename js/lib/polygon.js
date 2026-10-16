// Campus-fence maths. Polygons are arrays of [lat, lng]; points are { lat, lng }.
// A flat local projection is accurate to centimetres at campus scale.

const M_PER_DEG = 111_320;

/** Ray-casting point-in-polygon test. */
export function insidePolygon(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i];
    const [yj, xj] = poly[j];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Shortest distance in metres from p to the polygon outline. */
export function distanceToEdgeM(p, poly) {
  const kx = M_PER_DEG * Math.cos((p.lat * Math.PI) / 180);
  const ky = M_PER_DEG;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    // Segment a -> b, in metres relative to p.
    const ax = (poly[j][1] - p.lng) * kx;
    const ay = (poly[j][0] - p.lat) * ky;
    const bx = (poly[i][1] - p.lng) * kx;
    const by = (poly[i][0] - p.lat) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** 0 inside the polygon, otherwise the distance to it in metres. */
export function distanceOutsideM(p, poly) {
  return insidePolygon(p, poly) ? 0 : distanceToEdgeM(p, poly);
}
