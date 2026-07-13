import { create } from 'zustand';
import { subscribeTopic } from '../api/events.js';

export const useDiscoveryStore = create((set) => {
  let unsubscribe = null;

  return {
    peers: [],

    connect: () => {
      if (unsubscribe) return;

      unsubscribe = subscribeTopic(
        'discovery',
        (data) => set({ peers: Array.isArray(data) ? data : [] }),
      );
    },

    disconnect: () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      set({ peers: [] });
    },
  };
});
