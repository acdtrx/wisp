import { create } from 'zustand';
import * as settingsApi from '../api/settings.js';
import { subscribeChanges } from '../api/events.js';

/** Single subscriber, held at module scope (the store is a singleton) so
 *  stopSettingsSync can clean up after startSettingsSync. */
let syncCloseFn = null;
/** Each GET is numbered; a response is applied only when it is newer than the
 *  last one applied, so a slow older answer never overwrites a newer one and a
 *  failed newer GET doesn't discard an older success. */
let lastSent = 0;
let lastApplied = 0;
let inFlight = 0;

export const useSettingsStore = create((set, get) => ({
  settings: null,
  loading: false,
  /** A load's failure, shown until the user dismisses it. While `settings` is set
   *  it is a failed refresh: the last good settings stay. */
  error: null,
  errorDetail: null,

  loadSettings: async () => {
    const request = ++lastSent;
    inFlight += 1;
    set({ loading: true });
    try {
      const settings = await settingsApi.getSettings();
      if (request > lastApplied) {
        lastApplied = request;
        const previous = get().settings;
        /* Keep the same object when nothing changed (a reconnect's reload): the
         * forms reset on a new object, and only a change should drop their edits. */
        const same = previous && JSON.stringify(previous) === JSON.stringify(settings);
        set({ settings: same ? previous : settings });
      }
      return settings;
    } catch (err) {
      /* A newer GET already sent supersedes this one: show only the newest failure. */
      if (request === lastSent && request > lastApplied) {
        set({ error: err.message, errorDetail: err.detail ?? null });
      }
      throw err;
    } finally {
      inFlight -= 1;
      if (inFlight === 0) set({ loading: false });
    }
  },

  dismissError: () => set({ error: null, errorDetail: null }),

  /**
   * Load the settings, and again whenever the `changes` topic names them — a save
   * from any tab, or the reconnect after the stream was down.
   */
  startSettingsSync: () => {
    if (syncCloseFn) return;
    const { loadSettings } = get();
    /* Non-fatal: the store tracks the error; the app shell still renders */
    loadSettings().catch(() => {});
    syncCloseFn = subscribeChanges(['settings'], () => {
      loadSettings().catch(() => {});
    });
  },

  stopSettingsSync: () => {
    if (syncCloseFn) {
      syncCloseFn();
      syncCloseFn = null;
    }
  },
}));
