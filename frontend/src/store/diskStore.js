import { create } from 'zustand';
import { openStream } from '../api/sse.js';
import { errorText } from '../api/errors.js';

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

      closeFn = openStream(
        '/api/host/disks/stream',
        (data) => {
          if (Array.isArray(data)) {
            set({ disks: data, connected: true, error: null });
          } else if (data && data.error) {
            set({ error: errorText(data) });
          }
        },
        { onDown: (err) => set({ connected: false, error: err ? errorText(err) : 'The device stream is not connected — retrying…' }) },
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
