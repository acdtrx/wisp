import { create } from 'zustand';
import { createSSE } from '../api/sse.js';

export const useDiscoveryStore = create((set) => {
  let closeFn = null;

  return {
    peers: [],

    connect: () => {
      if (closeFn) return;

      closeFn = createSSE(
        '/api/discovery/stream',
        (data) => set({ peers: Array.isArray(data) ? data : [] }),
        () => {},
      );
    },

    disconnect: () => {
      if (closeFn) {
        closeFn();
        closeFn = null;
      }
      set({ peers: [] });
    },
  };
});
