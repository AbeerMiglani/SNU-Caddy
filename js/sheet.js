// Floating bottom sheet with three snap points: peek, half and full.
// Drag the handle or the header; a quick flick moves one step.
// On wide screens (laptop / projector for the pitch) it is a fixed side panel.

const SNAPS = ['peek', 'half', 'full'];
const FLICK_PX_PER_MS = 0.45;
const TAP_SLOP_PX = 6;

const wide = window.matchMedia('(min-width: 768px)');

/**
 * @param {HTMLElement} sheet
 * @param {{ onChange?: () => void }} [opts]  called when the visible area settles
 */
export function createSheet(sheet, { onChange } = {}) {
  const grab = sheet.querySelector('.sheet__grab');
  const header = sheet.querySelector('.sheet__header');
  const body = sheet.querySelector('.sheet__body');
  const root = document.documentElement;

  let snap = 'peek';
  let heights = { peek: 0, half: 0, full: 0 };
  let visible = 0;
  let gapPx = 0;
  let drag = null;
  let justDragged = false;

  function measure() {
    const vh = window.innerHeight;
    gapPx = parseFloat(getComputedStyle(sheet).bottom) || 0;
    // Full: leave the top bar (brand + buttons) visible above the sheet.
    const full = Math.max(240, vh - gapPx - 84);
    // Peek shows the header plus the first caddy row (or the whole empty-state card).
    const firstRow = body.querySelector('.row, .empty:not([hidden])');
    let rowPart = 72;
    if (firstRow?.classList.contains('empty')) rowPart = firstRow.offsetHeight + 8;
    else if (firstRow) rowPart = Math.min(firstRow.offsetHeight, 132) + 12;
    const peek = Math.min(full, body.offsetTop + rowPart);
    const half = Math.min(full, Math.max(peek + 80, Math.round(vh * 0.5)));
    heights = { peek, half, full };
    sheet.style.height = `${full}px`;
  }

  function place(px, animate) {
    visible = px;
    sheet.classList.toggle('is-animating', animate);
    sheet.style.transform = `translate3d(0, ${heights.full - px}px, 0)`;
  }

  function settle() {
    // The list scrolls inside the visible part only.
    body.style.maxHeight = `${Math.max(0, visible - body.offsetTop)}px`;
    root.style.setProperty('--sheet-visible', `${Math.round(visible)}px`);
    grab.setAttribute('aria-expanded', String(snap !== 'peek'));
    grab.setAttribute('aria-label', snap === 'full' ? 'Collapse caddy list' : 'Expand caddy list');
    onChange?.();
  }

  function setSnap(next, animate = true) {
    if (wide.matches) return;
    snap = next;
    place(heights[snap], animate);
    settle();
  }

  // --- Drag -----------------------------------------------------------------
  function onDown(e) {
    if (wide.matches || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // Let real controls in the header (like the demo switch) work normally.
    if (e.target.closest('button, a, input, [role="switch"]') && !grab.contains(e.target)) return;
    justDragged = false;
    drag = {
      id: e.pointerId,
      startY: e.clientY,
      startVisible: visible,
      moved: false,
      samples: [{ y: e.clientY, t: e.timeStamp }],
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.abs(dy) < TAP_SLOP_PX) return;
    drag.moved = true;
    let px = drag.startVisible - dy;
    // Rubber band past the ends.
    if (px > heights.full) px = heights.full + (px - heights.full) * 0.2;
    if (px < heights.peek) px = heights.peek - (heights.peek - px) * 0.35;
    place(px, false);
    drag.samples.push({ y: e.clientY, t: e.timeStamp });
    if (drag.samples.length > 6) drag.samples.shift();
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) return; // A tap: the handle's click listener does the work.
    justDragged = true;
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const v = (last.y - first.y) / Math.max(1, last.t - first.t); // + = down
    const at = SNAPS.indexOf(snap);
    let next;
    if (v > FLICK_PX_PER_MS) next = SNAPS[Math.max(0, at - 1)];
    else if (v < -FLICK_PX_PER_MS) next = SNAPS[Math.min(SNAPS.length - 1, at + 1)];
    else
      next = SNAPS.reduce((a, b) =>
        Math.abs(heights[b] - visible) < Math.abs(heights[a] - visible) ? b : a,
      );
    setSnap(next);
  }

  function onCancel(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    setSnap(snap);
  }

  /** Tap or Enter on the handle: peek -> half -> full -> peek. */
  function cycle() {
    setSnap(SNAPS[(SNAPS.indexOf(snap) + 1) % SNAPS.length]);
  }

  for (const zone of [grab, header]) {
    zone.addEventListener('pointerdown', onDown);
    zone.addEventListener('pointermove', onMove);
    zone.addEventListener('pointerup', onUp);
    zone.addEventListener('pointercancel', onCancel);
  }
  // Tap, click, Enter and Space all arrive here as one click event.
  grab.addEventListener('click', () => {
    if (justDragged) {
      justDragged = false;
      return;
    }
    cycle();
  });

  // --- Layout mode ------------------------------------------------------------
  function layout() {
    if (wide.matches) {
      sheet.style.height = '';
      sheet.style.transform = '';
      body.style.maxHeight = '';
      root.style.setProperty('--sheet-visible', '0px');
      onChange?.();
      return;
    }
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
    /** Re-measure after the content changes (for example the empty state appears). */
    refresh() {
      if (!wide.matches && !drag) {
        measure();
        setSnap(snap, false);
      }
    },
    /** Pixels of map hidden by the sheet or side panel, for camera framing. */
    cover() {
      const top = 76;
      if (wide.matches) return { top, bottom: 0, left: sheet.getBoundingClientRect().right };
      return { top, bottom: visible + gapPx, left: 0 };
    },
  };
}
