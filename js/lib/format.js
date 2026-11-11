// Short texts for times and distances, the same on every page.

/** Seconds in steps of 5 (the lists refresh every 5 s, so the number never looks stuck). */
export function timeAgo(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${Math.floor(s / 5) * 5} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * A straight-line distance for people on foot: "Here", "250 m", "1.2 km".
 * Steps of 10 m: a phone's own position is not better than that.
 */
export function distanceText(metres) {
  if (!(metres >= 0)) return '';
  if (metres < 25) return 'Here';
  if (metres < 995) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}
