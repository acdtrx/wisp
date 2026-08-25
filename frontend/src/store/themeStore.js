import { create } from 'zustand';

import {
  getEffectiveTheme,
  getThemePreference,
  setThemePreference,
  subscribeTheme,
} from '../theme.js';

/* The control cycles in this order; `system` last so a tap from the default
   lands on an explicit choice rather than back on the default. */
const CYCLE = ['light', 'dark', 'system'];

/**
 * React's view of the theme. `theme.js` owns the state — it has to, since the
 * OS media query and the pre-hydration inline script both write it — so this
 * store only mirrors it and forwards writes.
 */
export const useThemeStore = create((set) => ({
  preference: getThemePreference(),
  effective: getEffectiveTheme(),

  setPreference: (value) => setThemePreference(value),

  cyclePreference: () => {
    const next = CYCLE[(CYCLE.indexOf(getThemePreference()) + 1) % CYCLE.length];
    setThemePreference(next);
  },
}));

/* Single module-scope subscription (the store is a singleton), and the only
   writer of this store's state — every path into theme.js comes back here. */
subscribeTheme(() => {
  useThemeStore.setState({
    preference: getThemePreference(),
    effective: getEffectiveTheme(),
  });
});
