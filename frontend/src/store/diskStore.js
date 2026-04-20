import { create } from 'zustand';
import { createSSE } from '../api/sse.js';

export const useDiskStore = create((set) => {
  let closeFn = null;

  return {
    /** @type { Array<{ uuid: string, devPath: string, fsType: string, label: string, sizeBytes: number, removable: boolean, vendor: string, model: string, mountedAt: string | null }> | null } */
    disks: null,
    connected: false,

    connect: () => {
      if (closeFn) return;

      closeFn = createSSE(
        '/api/host/disks/stream',
        (data) => {
          if (Array.isArray(data)) {
            set({ disks: data, connected: true });
          }
        },
        () => set({ connected: false }),
      );
    },

    disconnect: () => {
      if (closeFn) {
        closeFn();
        closeFn = null;
      }
      set({ disks: null, connected: false });
    },
  };
});
