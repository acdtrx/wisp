import { create } from 'zustand';
import { subscribeTopic } from '../api/events.js';

export const useStatsStore = create((set, get) => {
  let unsubscribe = null;

  return {
    stats: null,
    connected: false,
    /** The last gather's error, until a good frame clears it. */
    lastError: null,

    connect: () => {
      if (unsubscribe) return;

      unsubscribe = subscribeTopic(
        'stats',
        (data) => {
          // Error frame ({ error, detail, code? }): the stream is up but this gather
          // failed. Keep the last good stats — every consumer dereferences
          // stats.cpu / stats.memory, so storing the error object crashes the render.
          if (!data || data.error) {
            set({ connected: true, lastError: data?.detail || data?.error || 'Stats unavailable' });
            return;
          }
          set({ stats: data, connected: true, lastError: null });
        },
        () => set({ connected: false }),
      );
    },

    disconnect: () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      set({ stats: null, connected: false, lastError: null });
    },
  };
});
