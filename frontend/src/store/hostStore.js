import { create } from 'zustand';
import { getHostHardware } from '../api/host.js';

export const useHostStore = create((set) => ({
  hardware: null,
  hardwareError: null,

  fetchHardware: async () => {
    set({ hardwareError: null });
    try {
      const hardware = await getHostHardware();
      set({ hardware });
      return hardware;
    } catch (err) {
      const message = err.detail || err.message || 'Failed to load hardware';
      set({ hardware: null, hardwareError: message });
      throw err;
    }
  },

  clearHardware: () => set({ hardware: null, hardwareError: null }),
}));
