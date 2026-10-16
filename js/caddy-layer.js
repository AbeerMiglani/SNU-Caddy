// Caddy icons on the student map: they glide between GPS pings and turn to
// face the direction of travel, like the cars in Uber.
//
// Battery notes:
//  - One shared animation loop for all caddies, capped at GLIDE.fps; between
//    frames it sleeps on a timer, so 90-120 Hz screens do not wake it more often.
//  - The loop stops completely when no caddy is moving.
//  - requestAnimationFrame does not run while the tab is hidden.
//  - Turning uses a CSS transition (runs on the GPU, no JS per frame).
/* global L */

import { GLIDE } from './config.js';
import { bearingDeg, distanceM, lerpLatLng, turnDeg } from './lib/geo.js';

const FRAME_MS = 1000 / GLIDE.fps;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const STATUS_TEXT = { open: 'Seats open', full: 'Full', offline: 'Offline' };

/** Top-down golf cart, nose pointing up (north) at 0 degrees. */
export function cartSvg() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 36');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML =
    '<rect class="cart-wheel" x="1" y="6" width="4" height="7" rx="1.5"/>' +
    '<rect class="cart-wheel" x="19" y="6" width="4" height="7" rx="1.5"/>' +
    '<rect class="cart-wheel" x="1" y="23" width="4" height="7" rx="1.5"/>' +
    '<rect class="cart-wheel" x="19" y="23" width="4" height="7" rx="1.5"/>' +
    '<rect class="cart-body" x="3.5" y="2" width="17" height="32" rx="6"/>' +
    '<path class="cart-glass" d="M6.5 9.5 Q12 6 17.5 9.5 L17 11.5 H7 Z"/>' +
    '<rect class="cart-roof" x="5.5" y="12.5" width="13" height="17" rx="3"/>';
  return svg;
}

export class CaddyLayer {
  /**
   * @param {L.Map} map
   * @param {{ onSelect?: (id: string) => void }} [opts]
   */
  constructor(map, { onSelect } = {}) {
    this.map = map;
    this.onSelect = onSelect;
    /** @type {Map<string, any>} */
    this.items = new Map();
    this.selectedId = null;
    this.raf = 0;
    this.lastFrame = 0;
    this.zooming = false;
    this.frame = this.frame.bind(this);

    // Leaflet moves markers itself during a zoom animation; do not fight it.
    // Pause only during the CSS zoom animation ('zoomanim'), when Leaflet moves
    // the markers itself. flyTo and drags do not need a pause, and a drag can
    // cancel a flyTo without 'zoomend', so 'moveend' also resumes the loop.
    map.on('zoomanim', () => {
      this.zooming = true;
    });
    map.on('zoomend moveend', () => {
      this.zooming = false;
      this.kick();
    });
  }

  /**
   * Add a caddy or apply a new ping.
   * @param {{ id: string, name: string, status: 'open'|'full'|'offline',
   *           lat: number, lng: number, ts: number, heading?: number|null, speed?: number|null }} c
   */
  update(c) {
    const target = { lat: c.lat, lng: c.lng };
    let it = this.items.get(c.id);

    if (!it) {
      it = this.create(c, target);
      this.items.set(c.id, it);
      this.applyStatus(it, c);
      return;
    }

    this.applyStatus(it, c);

    // Ignore pings that are older than the one on screen (out-of-order delivery).
    if (c.ts < it.ts) return;
    // Same place (heartbeat or status-only change): nothing to move.
    if (c.lat === it.to.lat && c.lng === it.to.lng) {
      it.ts = c.ts;
      return;
    }

    const now = performance.now();
    const shown = this.positionAt(it, now);
    const gap = c.ts - it.ts;
    it.ts = c.ts;

    if (distanceM(shown, target) > GLIDE.teleportM) {
      // Too far to glide (GPS came back after a gap): jump.
      it.from = it.to = target;
      it.dur = 0;
      it.marker.setLatLng(target);
      return;
    }

    this.turn(it, c, target);
    it.from = shown;
    it.to = target;
    it.start = now;
    it.dur =
      gap >= GLIDE.minMs && gap <= GLIDE.maxMs
        ? Math.min(gap * GLIDE.stretch, GLIDE.maxMs)
        : GLIDE.fallbackMs;
    this.kick();
  }

  remove(id) {
    const it = this.items.get(id);
    if (!it) return;
    it.marker.remove();
    this.items.delete(id);
    if (this.selectedId === id) this.selectedId = null;
  }

  clear() {
    for (const id of [...this.items.keys()]) this.remove(id);
  }

  /** Where the icon is on screen now (mid-glide aware). */
  shownLatLng(id) {
    const it = this.items.get(id);
    return it ? this.positionAt(it, performance.now()) : null;
  }

  select(id) {
    if (this.selectedId === id) return;
    this.items.get(this.selectedId)?.el.classList.remove('is-selected');
    this.selectedId = id;
    const it = this.items.get(id);
    if (!it) return;
    // Restart the short pulse animation on every new selection.
    it.el.classList.remove('is-selected');
    void it.el.offsetWidth;
    it.el.classList.add('is-selected');
  }

  // ---------------------------------------------------------------------------

  create(c, target) {
    const icon = L.divIcon({
      className: 'caddy-marker',
      html: '',
      iconSize: [44, 44],
      iconAnchor: [22, 22],
    });
    const marker = L.marker(target, { icon, keyboard: true, title: c.name, riseOnHover: true });
    marker.on('click', () => this.onSelect?.(c.id));
    marker.addTo(this.map);

    const el = marker.getElement();
    const body = document.createElement('span');
    body.className = 'caddy__body';
    body.append(cartSvg());
    const badge = document.createElement('span');
    badge.className = 'caddy__badge';
    el.append(body, badge);

    const heading = Number.isFinite(c.heading) ? c.heading : 0;
    body.style.transform = `rotate(${heading}deg)`;

    return {
      marker,
      el,
      body,
      rot: heading,
      from: target,
      to: target,
      start: 0,
      dur: 0,
      ts: c.ts,
      status: null,
      name: c.name,
    };
  }

  applyStatus(it, c) {
    if (it.status === c.status && it.name === c.name) return;
    it.status = c.status;
    it.name = c.name;
    it.el.dataset.status = c.status;
    it.el.setAttribute('aria-label', `${c.name}, ${STATUS_TEXT[c.status] ?? c.status}`);
    // Active caddies draw above parked/offline ones.
    it.marker.setZIndexOffset(c.status === 'offline' ? -1000 : 0);
  }

  /** Face the direction of travel. Prefer the phone's own heading when it is moving. */
  turn(it, c, target) {
    let heading = null;
    // 1. The phone's own heading (only sent while the caddy moves).
    if (Number.isFinite(c.heading)) heading = c.heading;
    // 2. Known to be stopped: keep the last heading, so GPS noise cannot spin a parked caddy.
    else if (Number.isFinite(c.speed) && c.speed <= 0.5) return;
    // 3. Unknown speed: use the direction between the two pings.
    else if (distanceM(it.to, target) >= GLIDE.minTurnMoveM) heading = bearingDeg(it.to, target);
    if (heading === null) return;
    // Keep the angle unwrapped so 350 -> 10 turns +20, not -340.
    it.rot += turnDeg(it.rot, heading);
    it.body.style.transform = `rotate(${it.rot}deg)`;
  }

  positionAt(it, now) {
    if (!it.dur) return it.to;
    const t = (now - it.start) / it.dur;
    return t >= 1 ? it.to : lerpLatLng(it.from, it.to, Math.max(0, t));
  }

  kick() {
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  /** Next frame in about `ms`: sleep with a timer, then align to the screen refresh. */
  later(ms) {
    this.raf = setTimeout(() => {
      this.raf = requestAnimationFrame(this.frame);
    }, ms);
  }

  frame(now) {
    this.raf = 0;
    if (this.zooming) return; // zoomend / moveend call kick() again.
    // Too early (a ping arrived between frames): wait for the 30 fps slot without
    // waking up on every 60-120 Hz screen refresh.
    if (now - this.lastFrame < FRAME_MS - 1) {
      this.later(FRAME_MS - (now - this.lastFrame));
      return;
    }
    this.lastFrame = now;

    let moving = false;
    for (const it of this.items.values()) {
      if (!it.dur) continue;
      if (now - it.start >= it.dur) {
        it.dur = 0;
        it.marker.setLatLng(it.to);
      } else {
        it.marker.setLatLng(this.positionAt(it, now));
        moving = true;
      }
    }
    if (moving) this.later(FRAME_MS - 8);
  }
}
