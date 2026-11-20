import { create } from 'zustand';
import { subscribeTopic } from '../api/events.js';
import { errorText } from '../api/errors.js';

export const useStatsStore = create((set) => {
  let unsubscribe = null;

  return {
    stats: null,
    connected: false,
    /** The last gather's error, until a good frame clears it. */
    lastError: null,
    /** Why Wisp refused the events stream, which then ended (errorText); null while it runs. */
    refusal: null,

    connect: () => {
      if (unsubscribe) return;

      unsubscribe = subscribeTopic(
        'stats',
        (data) => {
          // Error frame ({ error, detail, code? }): the stream is up but this gather
          // failed. Keep the last good stats — every consumer dereferences
          // stats.cpu / stats.memory, so storing the error object crashes the render.
          if (!data || data.error) {
            set({ connected: true, lastError: data ? errorText(data) : 'Stats unavailable' });
            return;
          }
          set({ stats: data, connected: true, lastError: null });
        },
        // A refused stream sends no more frames: drop the stats it can no longer
        // keep current, and say why instead.
        (refused) => set(refused
          ? { stats: null, connected: false, lastError: null, refusal: errorText(refused) }
          : { connected: false }),
      );
    },

    disconnect: () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      set({ stats: null, connected: false, lastError: null, refusal: null });
    },
  };
});
