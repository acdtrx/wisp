import { create } from 'zustand';
import * as settingsApi from '../api/settings.js';
import { subscribeChanges } from '../api/events.js';

/** Single subscriber, held at module scope (the store is a singleton) so
 *  stopSettingsSync can clean up after startSettingsSync. */
let syncCloseFn = null;
/** Numbers each GET, so a slow older response never overwrites a newer one. */
let latestRequest = 0;

export const useSettingsStore = create((set, get) => ({
  settings: null,
  loading: false,
  error: null,

  /** GET the settings. A failed reload keeps the last good settings. */
  loadSettings: async () => {
    const request = ++latestRequest;
    set({ loading: true, error: null });
    try {
      const settings = await settingsApi.getSettings();
      if (request === latestRequest) set({ settings, loading: false });
      return settings;
    } catch (err) {
      if (request === latestRequest) set({ error: err.message, loading: false });
      throw err;
    }
  },

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
