import { create } from 'zustand';
import { createSSE } from '../api/sse.js';

export const useStatsStore = create((set, get) => {
  let closeFn = null;

  return {
    stats: null,
    connected: false,

    connect: () => {
      if (closeFn) return;

      closeFn = createSSE(
        '/api/stats',
        (data) => set({ stats: data, connected: true }),
        () => set({ connected: false }),
      );
    },

    disconnect: () => {
      if (closeFn) {
        closeFn();
        closeFn = null;
      }
      set({ stats: null, connected: false });
    },
  };
});
