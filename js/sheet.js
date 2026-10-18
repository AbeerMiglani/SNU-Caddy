// Floating bottom sheet with three snap points: peek, half and full.
// Drag the handle, the header, or (below full) the list itself; a quick
// flick moves one step. At full, the list scrolls instead.
// On wide screens (laptop / projector for the pitch) it is a fixed side panel.

const SNAPS = ['peek', 'half', 'full'];
const FLICK_PX_PER_MS = 0.45;
const FLICK_WINDOW_MS = 100;
const TAP_SLOP_PX = 6;
const SNAP_MS = 320; // keep in sync with .sheet.is-animating in app.css

const wide = window.matchMedia('(min-width: 768px)');

/**
 * @param {HTMLElement} sheet
 * @param {{ onChange?: (cover: { top: number, bottom: number, left: number }) => void }} [opts]
 *   called with the covered map area whenever the sheet settles
 */
export function createSheet(sheet, { onChange } = {}) {
  const grab = sheet.querySelector('.sheet__grab');
  const header = sheet.querySelector('.sheet__header');
  const body = sheet.querySelector('.sheet__body');
  const list = sheet.querySelector('.list');
  const root = document.documentElement;

  let snap = 'peek';
  let heights = { peek: 0, half: 0, full: 0 };
  let visible = 0;
  let gapPx = 0;
  let drag = null;
  let justDragged = false;
  let shrinkTimer = 0;
  let bodyTop = 0; // where the body starts (below the handle and header) at the last measure()
  let peekRowH = 0; // height of the first row or card at the last measure()
  let stale = false; // the content changed while a finger was down

  /** Bottom edge of the top bar (it grows with the phone's safe area). */
  const barBottom = () => document.querySelector('.topbar')?.getBoundingClientRect().bottom ?? 64;

  /** Pixels of map hidden by the top bar, the sheet or the side panel, for camera framing. */
  function cover() {
    const top = barBottom();
    if (wide.matches) return { top, bottom: 0, left: sheet.getBoundingClientRect().right };
    return { top, bottom: visible + gapPx, left: 0 };
  }

  /** The peek shows the header plus this: the location card, the first row or the empty text. */
  const firstItem = () => body.querySelector('.gate:not([hidden]), .row, .empty:not([hidden])');

  function measure() {
    const vh = window.innerHeight;
    gapPx = parseFloat(getComputedStyle(sheet).bottom) || 0;
    // Full: the top bar stays visible above the sheet, with a strip of map that
    // fits the map attribution.
    const full = Math.max(240, vh - gapPx - barBottom() - 24);
    // Peek shows the header plus the first caddy row (or the whole location / empty card).
    const firstRow = firstItem();
    peekRowH = firstRow?.offsetHeight ?? 0;
    bodyTop = body.offsetTop;
    let rowPart = 72;
    if (firstRow && !firstRow.classList.contains('row')) rowPart = peekRowH + 8;
    else if (firstRow) rowPart = Math.min(peekRowH, 132) + 12;
    const peek = Math.min(full, bodyTop + rowPart);
    const half = Math.min(full, Math.max(peek + 80, Math.round(vh * 0.5)));
    heights = { peek, half, full };
    sheet.style.height = `${full}px`;
    watchFirst();
  }

  /** Re-measure after the content changes (for example the empty state appears). */
  function refresh() {
    if (wide.matches) return;
    if (drag) {
      stale = true; // measured when the finger lifts
      return;
    }
    measure();
    setSnap(snap, false);
  }

  function place(px, animate) {
    visible = px;
    sheet.classList.toggle('is-animating', animate);
    sheet.style.transform = `translate3d(0, ${heights.full - px}px, 0)`;
    // The map button and the attribution follow the sheet: with the same slide
    // when it snaps, at once when it is dragged or its content changes.
    root.classList.toggle('sheet-animating', animate);
    root.style.setProperty('--sheet-visible', `${Math.round(px)}px`);
  }

  /** The list scrolls inside the visible part only. */
  function fitBody(animate) {
    clearTimeout(shrinkTimer);
    const apply = () => {
      body.style.maxHeight = `${Math.max(0, visible - body.offsetTop)}px`;
    };
    const shrinking = visible - body.offsetTop < (parseFloat(body.style.maxHeight) || 0);
    // When collapsing, keep the rows drawn until the slide-down has finished,
    // then keep the selected row in view (below full, the list cannot be scrolled).
    if (animate && shrinking) {
      shrinkTimer = setTimeout(() => {
        apply();
        const sel = body.querySelector('.row.is-selected');
        if (!sel) return;
        const r = sel.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom + 8;
        else if (r.top < b.top) body.scrollTop -= b.top - r.top + 8;
      }, SNAP_MS);
    } else apply();
  }

  function settle(animate) {
    fitBody(animate);
    sheet.classList.toggle('is-full', snap === 'full');
    // At full, the map button would sit under the top bar.
    root.classList.toggle('sheet-full', snap === 'full');
    // The label says what a tap does next.
    grab.setAttribute(
      'aria-label',
      {
        peek: 'Show more caddies',
        half: 'Show the full caddy list',
        full: 'Collapse the caddy list',
      }[snap],
    );
    onChange?.(cover());
  }

  function setSnap(next, animate = true) {
    if (wide.matches) return;
    snap = next;
    place(heights[snap], animate);
    settle(animate);
  }

  // --- Drag -----------------------------------------------------------------
  function onDown(e) {
    justDragged = false;
    if (wide.matches || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // At full the list scrolls; drags there do not move the sheet.
    if (e.currentTarget === body && snap === 'full') return;
    drag = {
      id: e.pointerId,
      zone: e.currentTarget,
      startY: e.clientY,
      startVisible: visible,
      moved: false,
      samples: [{ y: e.clientY, t: e.timeStamp }],
    };
    // No pointer capture yet: a tap must still reach the row or button under the
    // finger. Listen on the window, so a fast first move that leaves the handle
    // is not lost.
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  function endDrag() {
    drag = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    // The content changed under the finger: measure before the sheet settles.
    const changed = stale;
    stale = false;
    if (changed) measure();
    return changed;
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dy) < TAP_SLOP_PX) return;
      drag.moved = true;
      drag.zone.setPointerCapture(e.pointerId);
      // Draw every row while the sheet is pulled up.
      clearTimeout(shrinkTimer);
      body.style.maxHeight = `${Math.max(0, heights.full - body.offsetTop)}px`;
    }
    let px = drag.startVisible - dy;
    // Rubber band past the ends.
    if (px > heights.full) px = heights.full + (px - heights.full) * 0.2;
    if (px < heights.peek) px = heights.peek - (heights.peek - px) * 0.35;
    place(px, false);
    drag.samples.push({ y: e.clientY, t: e.timeStamp });
    if (drag.samples.length > 12) drag.samples.shift();
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    const remeasured = endDrag();
    if (!d.moved) {
      // A tap: the row's or handle's own click does the work.
      if (remeasured) setSnap(snap, false);
      return;
    }
    // Swallow the click that may follow this drag (see the listener below), but
    // never a later, real tap.
    justDragged = true;
    setTimeout(() => {
      justDragged = false;
    }, 300);

    // Speed over the last 100 ms only: a finger that rests before release is no flick.
    d.samples.push({ y: e.clientY, t: e.timeStamp });
    const recent = d.samples.filter((s) => e.timeStamp - s.t <= FLICK_WINDOW_MS);
    const v =
      recent.length >= 2
        ? (recent[recent.length - 1].y - recent[0].y) /
          Math.max(1, recent[recent.length - 1].t - recent[0].t)
        : 0; // + = down

    // Choose from where the sheet IS now, not where the drag started.
    const byHeight = [...SNAPS].sort((a, b) => heights[a] - heights[b]);
    let next;
    if (v < -FLICK_PX_PER_MS) next = byHeight.find((s) => heights[s] > visible + 1) ?? 'full';
    else if (v > FLICK_PX_PER_MS)
      next = [...byHeight].reverse().find((s) => heights[s] < visible - 1) ?? 'peek';
    else
      next = byHeight.reduce((a, b) =>
        Math.abs(heights[b] - visible) < Math.abs(heights[a] - visible) ? b : a,
      );
    setSnap(next);
  }

  function onCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    endDrag();
    setSnap(snap);
  }

  /** Tap or Enter on the handle: peek -> half -> full -> peek. */
  function cycle() {
    setSnap(SNAPS[(SNAPS.indexOf(snap) + 1) % SNAPS.length]);
  }

  for (const zone of [grab, header, body]) zone.addEventListener('pointerdown', onDown);

  // A drag that started on a row or button must not also "click" it.
  sheet.addEventListener(
    'click',
    (e) => {
      if (!justDragged) return;
      justDragged = false;
      e.stopPropagation();
      e.preventDefault();
    },
    true,
  );
  // Tap, click, Enter and Space on the handle all arrive here as one click event.
  grab.addEventListener('click', cycle);

  // --- Layout mode ------------------------------------------------------------
  // Narrow mode: re-measure when the header or the first item changes size, for
  // example when the summary or a row's text starts to wrap. The sheet and the body
  // are never watched: measure() sets their size. The ResizeObserver delivers once
  // per frame, however many sizes changed.
  let watching = false;
  let watched = null;
  const resizes = new ResizeObserver(() => {
    // A new target is reported once, too: skip it when measure() has just seen the same.
    if (body.offsetTop !== bodyTop || (firstItem()?.offsetHeight ?? 0) !== peekRowH) refresh();
  });
  // Rows come, go and swap places: look at the new first one.
  const reorders = new MutationObserver(() => watchFirst());

  function watchFirst() {
    const item = watching ? firstItem() : null;
    if (item === watched) return;
    if (watched) resizes.unobserve(watched);
    if (item) resizes.observe(item);
    watched = item;
  }

  function watch(on) {
    if (on === watching) return;
    watching = on;
    if (on) {
      resizes.observe(header);
      reorders.observe(list, { childList: true });
    } else {
      resizes.disconnect();
      reorders.disconnect();
      watched = null;
    }
  }

  function layout() {
    if (wide.matches) {
      clearTimeout(shrinkTimer);
      sheet.style.height = '';
      sheet.style.transform = '';
      body.style.maxHeight = '';
      sheet.classList.remove('is-full');
      root.classList.remove('sheet-full', 'sheet-animating');
      root.style.setProperty('--sheet-visible', '0px');
      watch(false);
      onChange?.(cover());
      return;
    }
    watch(true);
    measure();
    setSnap(snap, false);
  }

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 120);
  });
  wide.addEventListener('change', layout);
  layout();

  return {
    get snap() {
      return snap;
    },
    setSnap,
    refresh,
    cover,
  };
}
