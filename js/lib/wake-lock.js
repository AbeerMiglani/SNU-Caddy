// Screen Wake Lock: keeps the driver screen on during a shift.
//
// The browser drops the lock each time the page goes to the background, and
// Android can refuse it in battery saver. So the lock is taken again when the
// page comes back, and on every tap while it is missing.

/**
 * @param {(state: 'on'|'off'|'lost'|'unsupported') => void} onChange
 *   'lost' = wanted but not held (refused, or dropped by the system).
 */
export function createWakeLock(onChange = () => {}) {
  const api = navigator.wakeLock;
  let wanted = false;
  let sentinel = null;
  let pending = false;

  async function take() {
    if (!api) {
      onChange('unsupported');
      return;
    }
    if (!wanted || sentinel || pending || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      const lock = await api.request('screen');
      if (!wanted) {
        lock.release().catch(() => {});
        return;
      }
      sentinel = lock;
      lock.addEventListener('release', () => {
        if (sentinel !== lock) return;
        sentinel = null;
        onChange(wanted ? 'lost' : 'off');
      });
      onChange('on');
    } catch {
      onChange('lost');
    } finally {
      pending = false;
    }
  }

  document.addEventListener('visibilitychange', take);
  document.addEventListener('pointerdown', take, { passive: true });

  return {
    acquire() {
      wanted = true;
      take();
    },
    release() {
      wanted = false;
      const lock = sentinel;
      sentinel = null;
      lock?.release().catch(() => {});
      onChange('off');
    },
  };
}
