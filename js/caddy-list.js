// The caddy list inside the bottom sheet.
// Rows are created once per caddy and then only patched, so focus and
// scroll position survive the frequent updates. Text goes in with
// textContent only (caddy names will come from the database in Phase 4).

import { NEAR_LANDMARK_M } from './config.js';
import { STATUS_TEXT, cartSvg } from './caddy-layer.js';
import { LANDMARKS } from './data/campus.js';
import { distanceM } from './lib/geo.js';

const ORDER = { open: 0, full: 1, offline: 2 };

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

export function timeAgo(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/**
 * @param {{ list: HTMLElement, empty: HTMLElement, summary: HTMLElement,
 *           onSelect: (id: string) => void }} els
 */
export function createCaddyList({ list, empty, summary, onSelect }) {
  /** @type {Map<string, any>} */
  const rows = new Map();

  function createRow(c) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row';
    btn.addEventListener('click', () => onSelect(c.id));

    const icon = document.createElement('span');
    icon.className = 'row__icon';
    const badge = document.createElement('span');
    badge.className = 'caddy__badge';
    icon.append(cartSvg(), badge);

    const main = document.createElement('span');
    main.className = 'row__main';
    const titleLine = document.createElement('span');
    titleLine.className = 'row__title';
    const name = document.createElement('span');
    const line = document.createElement('span');
    line.className = 'row__line';
    titleLine.append(name, line);
    const meta = document.createElement('span');
    meta.className = 'row__meta';
    main.append(titleLine, meta);

    const pill = document.createElement('span');
    pill.className = 'pill';

    btn.append(icon, main, pill);
    li.append(btn);
    return { li, btn, name, line, meta, pill };
  }

  /**
   * @param {Map<string, any>} caddies  id -> caddy record
   * @param {string|null} selectedId
   * @returns {boolean} true when the list switched between empty and not empty
   */
  function render(caddies, selectedId) {
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
      (a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name),
    );

    sorted.forEach((c, i) => {
      let row = rows.get(c.id);
      if (!row) {
        row = createRow(c);
        rows.set(c.id, row);
      }
      setText(row.name, c.name);
      setText(row.line, c.line ?? '');
      const when = timeAgo(c.ts, now);
      setText(
        row.meta,
        `${placeLabel(c)} · ${c.status === 'offline' ? `last seen ${when}` : when}`,
      );
      setText(row.pill, STATUS_TEXT[c.status] ?? c.status);
      row.btn.dataset.status = c.status;
      row.btn.classList.toggle('is-selected', c.id === selectedId);
      row.btn.setAttribute('aria-current', String(c.id === selectedId));
      if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] ?? null);
    });

    const onShift = sorted.filter((c) => c.status !== 'offline').length;
    const withSeats = sorted.filter((c) => c.status === 'open').length;
    setText(
      summary,
      onShift === 0 ? 'No caddies on shift' : `${onShift} on shift · ${withSeats} with open seats`,
    );

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
    box.scrollTo({ top: box.scrollTop + offset - 4, behavior: 'smooth' });
  }

  return { render, reveal };
}
