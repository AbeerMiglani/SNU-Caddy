// Theme: 'auto' follows the phone setting; 'light' and 'dark' are manual choices.
// The inline script in index.html sets data-theme before first paint (no flash);
// this module keeps it in sync afterwards and owns the theme button in the top bar.

const STORAGE_KEY = 'snucaddy.theme';
const MODES = ['auto', 'light', 'dark'];
const NAMES = { auto: 'Auto', light: 'Light', dark: 'Dark' };
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
 * The theme button: each tap moves Auto -> Light -> Dark -> Auto.
 * It shows the current mode as an icon and a word.
 * @param {ReturnType<typeof createTheme>} theme
 */
export function bindThemeButton(theme, button, label) {
  const sync = () => {
    label.textContent = NAMES[theme.mode];
  };
  button.addEventListener('click', () => {
    theme.set(MODES[(MODES.indexOf(theme.mode) + 1) % MODES.length]);
    sync();
  });
  sync();
}
