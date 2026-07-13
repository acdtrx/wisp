import { create } from 'zustand';
import { subscribeTopic } from '../api/events.js';

export const useStatsStore = create((set, get) => {
  let unsubscribe = null;

  return {
    stats: null,
    connected: false,

    connect: () => {
      if (unsubscribe) return;

      unsubscribe = subscribeTopic(
        'stats',
        (data) => set({ stats: data, connected: true }),
        () => set({ connected: false }),
      );
    },

    disconnect: () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      set({ stats: null, connected: false });
    },
  };
});
