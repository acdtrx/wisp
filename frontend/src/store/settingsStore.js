import { create } from 'zustand';
import * as settingsApi from '../api/settings.js';

export const useSettingsStore = create((set, get) => ({
  settings: null,
  loading: false,
  error: null,

  loadSettings: async () => {
    set({ loading: true, error: null });
    try {
      const settings = await settingsApi.getSettings();
      set({ settings, loading: false });
      return settings;
    } catch (err) {
      set({ error: err.message, loading: false });
      throw err;
    }
  },

  setSettings: (partial) => {
    const { settings } = get();
    set({ settings: settings ? { ...settings, ...partial } : partial });
  },
}));
