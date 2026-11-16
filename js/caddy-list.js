// The caddy list inside the bottom sheet.
// Rows are created once per caddy and then only patched, so focus and
// scroll position survive the frequent updates. Text goes in with
// textContent only (caddy names come from the database).

import { cartSvg } from './caddy-layer.js';
import { STATE_ORDER, STATE_TEXT } from './caddy-state.js';
import { NEAR_LANDMARK_M } from './config.js';
import { LANDMARKS } from './data/campus.js';
import { distanceText, timeAgo } from './lib/format.js';
import { distanceM } from './lib/geo.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** "Near Central Library", or a plain fallback when nothing is close. */
export function placeLabel(p) {
  let best = null;
  let bestD = Infinity;
  for (const l of LANDMARKS) {
    const d = distanceM(p, l);
    if (d < bestD) {
      best = l;
      bestD = d;
    }
  }
  return best && bestD <= NEAR_LANDMARK_M ? `Near ${best.name}` : 'On campus road';
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * @param {{ list: HTMLElement, empty: HTMLElement, summary: HTMLElement,
 *           summaryStatus: HTMLElement, onSelect: (id: string) => void }} els
 *   `summaryStatus` is a status region: it changes only with the online count
 *   or a note, so screen readers do not hear every Moving / Parked change.
 */
export function createCaddyList({ list, empty, summary, summaryStatus, onSelect }) {
  /** @type {Map<string, any>} */
  const rows = new Map();

  function createRow(c) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row';
    btn.addEventListener('click', () => onSelect(c.id));

    // The state dot is beside the state word, so the icon has no badge.
    const icon = document.createElement('span');
    icon.className = 'row__icon';
    icon.append(cartSvg());

    const main = document.createElement('span');
    main.className = 'row__main';
    const titleLine = document.createElement('span');
    titleLine.className = 'row__title';
    const name = document.createElement('span');
    const line = document.createElement('span');
    line.className = 'row__line';
    titleLine.append(name, line);
    // Place and age: two parts with a dot between them. When the age wraps
    // to a second line, the dot is hidden (app.css).
    const meta = document.createElement('span');
    meta.className = 'row__meta';
    const parts = document.createElement('span');
    parts.className = 'row__parts';
    const place = document.createElement('span');
    const age = document.createElement('span');
    parts.append(place, age);
    meta.append(parts);
    main.append(titleLine, meta);

    // State, and under it the distance from the student (when it is known).
    const side = document.createElement('span');
    side.className = 'row__side';
    const state = document.createElement('span');
    state.className = 'row__state';
    const far = document.createElement('span');
    far.className = 'row__dist';
    const dist = document.createElement('span');
    const away = document.createElement('span'); // "250 m" reads as "250 m away"
    away.className = 'sr-only';
    far.append(dist, away);
    side.append(state, far);

    btn.append(icon, main, side);
    li.append(btn);
    return { li, btn, name, line, place, age, state, dist, away };
  }

  /**
   * @param {Map<string, any>} caddies  id -> caddy record (with its `state`)
   * @param {string|null} selectedId
   * @param {string|null} [note]  replaces the summary ("Connecting…", "Paused …")
   * @param {{ lat: number, lng: number } | null} [origin]  the student's own
   *   position, for the distance to each caddy; null when it is not known well
   * @returns {boolean} true when the list switched between empty and not empty
   */
  function render(caddies, selectedId, note = null, origin = null) {
    const now = Date.now();
    const wasEmpty = !empty.hidden;
    // Moving a focused row in the DOM drops focus; put it back afterwards.
    const focused = list.contains(document.activeElement) ? document.activeElement : null;

    for (const [id, row] of rows) {
      if (!caddies.has(id)) {
        row.li.remove();
        rows.delete(id);
      }
    }

    const sorted = [...caddies.values()].sort(
      (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name),
    );

    sorted.forEach((c, i) => {
      let row = rows.get(c.id);
      if (!row) {
        row = createRow(c);
        rows.set(c.id, row);
      }
      setText(row.name, c.name);
      setText(row.line, c.line ?? '');
      // The place first: it is what a student looks for. Then the age of the position.
      const when = timeAgo(c.ts, now);
      setText(row.place, placeLabel(c));
      setText(
        row.age,
        { offline: `Last seen ${when}`, lost: `Last update ${when}` }[c.state] ?? when,
      );
      setText(row.state, STATE_TEXT[c.state] ?? c.state);
      // A straight line, not a walking route: "250 m" (steps of 10 m).
      const far = origin ? distanceText(distanceM(origin, c)) : '';
      setText(row.dist, far);
      setText(row.away, far && far !== 'Here' ? ' away' : '');
      row.btn.dataset.state = c.state;
      row.btn.classList.toggle('is-selected', c.id === selectedId);
      row.btn.setAttribute('aria-current', String(c.id === selectedId));
      if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] ?? null);
    });

    // "Online" = a caddy a student can catch now. Signal lost is counted apart.
    const count = (state) => sorted.filter((c) => c.state === state).length;
    const moving = count('moving');
    const online = moving + count('parked');
    const charging = count('charging');
    const lost = count('lost');
    const parts = [
      online === 0
        ? 'No caddies online'
        : moving
          ? `${online} online · ${moving} moving`
          : `${online} online`,
    ];
    // A charging caddy is not one a student can catch: counted apart, like Signal lost.
    if (charging) parts.push(`${charging} charging`);
    if (lost) parts.push(`${lost} signal lost`);
    setText(summary, note ?? parts.join(' · '));
    setText(summaryStatus, note ?? parts[0].replace(/ · \d+ moving$/, ''));

    empty.hidden = sorted.length > 0;
    list.hidden = sorted.length === 0;
    if (focused?.isConnected && document.activeElement !== focused) {
      focused.focus({ preventScroll: true });
    }
    return wasEmpty !== !empty.hidden;
  }

  /** Scroll the list so this caddy's row is the first one in view (for map taps). */
  function reveal(id) {
    const row = rows.get(id);
    const box = list.parentElement;
    if (!row || !box) return;
    const offset = row.li.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTo({
      top: box.scrollTop + offset - 4,
      behavior: reducedMotion.matches ? 'auto' : 'smooth',
    });
  }

  return { render, reveal };
}
