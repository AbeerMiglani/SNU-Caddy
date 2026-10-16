// Theme: 'auto' follows the phone setting; 'light' and 'dark' are manual choices.
// The inline script in index.html sets data-theme before first paint (no flash);
// this module keeps it in sync afterwards and owns the floating theme menu.

const STORAGE_KEY = 'snucaddy.theme';
const MODES = ['auto', 'light', 'dark'];
const BAR_COLOR = { light: '#ffffff', dark: '#000000' };

function readMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return MODES.includes(saved) ? saved : 'auto';
  } catch {
    return 'auto'; // Private mode or blocked storage: just use the default.
  }
}

function saveMode(mode) {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* Not saved; the choice still works for this visit. */
  }
}

/**
 * @param {{ onChange: (resolved: 'light'|'dark', mode: string) => void }} opts
 */
export function createTheme({ onChange }) {
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const metaColor = document.querySelector('meta[name="theme-color"]');
  let mode = readMode();

  const resolve = () => (mode === 'auto' ? (media.matches ? 'dark' : 'light') : mode);

  function apply() {
    const resolved = resolve();
    root.dataset.theme = resolved;
    root.dataset.themeMode = mode;
    metaColor?.setAttribute('content', BAR_COLOR[resolved]);
    onChange(resolved, mode);
  }

  media.addEventListener('change', () => {
    if (mode === 'auto') apply();
  });

  apply();

  return {
    get mode() {
      return mode;
    },
    get resolved() {
      return resolve();
    },
    /** @param {'auto'|'light'|'dark'} next */
    set(next) {
      if (!MODES.includes(next) || next === mode) return;
      mode = next;
      saveMode(mode);
      apply();
    },
  };
}

/**
 * Wire the floating theme button and its small Auto / Light / Dark menu.
 * @param {ReturnType<typeof createTheme>} theme
 */
export function bindThemeMenu(theme, button, menu) {
  const items = [...menu.querySelectorAll('[data-mode]')];

  function sync() {
    for (const item of items) {
      item.setAttribute('aria-checked', String(item.dataset.mode === theme.mode));
    }
    const label = { auto: 'Auto', light: 'Light', dark: 'Dark' }[theme.mode];
    button.setAttribute('aria-label', `Map theme: ${label}`);
  }

  function open() {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    (items.find((i) => i.dataset.mode === theme.mode) ?? items[0]).focus();
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKey);
  }

  function close({ refocus = false } = {}) {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey);
    if (refocus) button.focus();
  }

  function onOutside(e) {
    if (!menu.contains(e.target) && !button.contains(e.target)) close();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      close({ refocus: true });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      const at = items.indexOf(document.activeElement);
      items[(at + step + items.length) % items.length].focus();
    }
  }

  button.addEventListener('click', () => (menu.hidden ? open() : close()));
  for (const item of items) {
    item.addEventListener('click', () => {
      theme.set(item.dataset.mode);
      sync();
      close({ refocus: true });
    });
  }
  sync();
}
