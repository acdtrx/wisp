import { create } from 'zustand';
import { createSSE } from '../api/sse.js';

export const useDiskStore = create((set) => {
  let closeFn = null;

  return {
    /** @type { Array<{ uuid: string, devPath: string, fsType: string, label: string, sizeBytes: number, removable: boolean, vendor: string, model: string, mountedAt: string | null }> | null } */
    disks: null,
    connected: false,
    /** The stream's last failure (an error frame, or a connection that dropped); cleared by the next list. */
    error: null,

    connect: () => {
      if (closeFn) return;

      closeFn = createSSE(
        '/api/host/disks/stream',
        (data) => {
          if (Array.isArray(data)) {
            set({ disks: data, connected: true, error: null });
          } else if (data && data.error) {
            set({ error: data.detail || data.error });
          }
        },
        () => set({ connected: false, error: 'The device stream is not connected — retrying…' }),
      );
    },

    disconnect: () => {
      if (closeFn) {
        closeFn();
        closeFn = null;
      }
      set({ disks: null, connected: false, error: null });
    },
  };
});
