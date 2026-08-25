// Theme controller: the single owner of `data-theme` on <html>, the stored
// preference, and the <meta name="theme-color"> the phone paints its status bar
// with. Framework-free on purpose — the same state has to be resolved by the
// inline no-flash script in index.html before React exists. React reads it
// through store/themeStore.js.
//
// The preference is per-device (localStorage, not wisp-config.json): `system` is
// only meaningful per device, and the phone wants dark at night while the
// desktop stays light. See docs/spec/UI.md § Design Language.

/** Mirrored by the no-flash script in index.html — change both together. */
export const THEME_STORAGE_KEY = 'wisp_theme';

const PREFERENCES = ['light', 'dark', 'system'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

/* Status-bar colour per effective theme. Light keeps the brand teal it has
   always used; dark takes `--color-surface-card`, the top bar the status strip
   sits above — a luminous teal band over a dark app is the flash we are
   avoiding. Mirrored in index.html's no-flash script. */
const THEME_COLOR = { light: '#0fa396', dark: '#142523' };

const listeners = new Set();

let preference = readStoredPreference();
let mediaQuery = null;

function readStoredPreference() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (PREFERENCES.includes(stored)) return stored;
  } catch {
    /* private windows and blocked site data throw on access — fall through */
  }
  return 'system';
}

function prefersDark() {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

/** The stored choice: `light`, `dark`, or `system`. */
export function getThemePreference() {
  return preference;
}

/** What is actually painted right now: `light` or `dark`. */
export function getEffectiveTheme() {
  if (preference !== 'system') return preference;
  return prefersDark() ? 'dark' : 'light';
}

function apply() {
  const effective = getEffectiveTheme();
  const root = document.documentElement;

  if (effective === 'dark') root.setAttribute('data-theme', 'dark');
  else root.removeAttribute('data-theme');

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[effective]);

  for (const fn of listeners) fn();
}

/**
 * Store a new preference and repaint. Values outside `light | dark | system`
 * are ignored rather than stored — the getter would reject them on next load
 * anyway, leaving the DOM and localStorage disagreeing.
 */
export function setThemePreference(value) {
  if (!PREFERENCES.includes(value) || value === preference) return;
  preference = value;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    /* best-effort: the choice still applies for this page's lifetime */
  }
  apply();
}

/** Notified on every effective-theme change, whether from the control or the OS. */
export function subscribeTheme(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Called once from main.jsx. The inline script already set the attribute for
 * first paint; this re-derives everything else — the theme-color meta and the
 * OS listener that keeps `system` live while the tab stays open.
 */
export function initTheme() {
  if (!mediaQuery) {
    mediaQuery = window.matchMedia(DARK_QUERY);
    /* Fires in every preference, but only changes the outcome under `system`;
       apply() re-derives, so no branch is needed here. */
    mediaQuery.addEventListener('change', apply);
  }
  apply();
}
