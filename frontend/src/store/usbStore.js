import { create } from 'zustand';
import { createSSE } from '../api/sse.js';

export const useUsbStore = create((set) => {
  let closeFn = null;

  return {
    /** @type { Array<{ bus: string, device: string, vendorId: string, productId: string, name: string }> | null } */
    devices: null,
    connected: false,
    /** The stream's last failure (an error frame, or a connection that dropped); cleared by the next list. */
    error: null,

    connect: () => {
      if (closeFn) return;

      closeFn = createSSE(
        '/api/host/usb/stream',
        (data) => {
          if (Array.isArray(data)) {
            set({ devices: data, connected: true, error: null });
          } else if (data && data.error) {
            set({ error: data.detail || data.error });
          }
        },
        () => set({ connected: false, error: 'The USB device stream is not connected — retrying…' }),
      );
    },

    disconnect: () => {
      if (closeFn) {
        closeFn();
        closeFn = null;
      }
      set({ devices: null, connected: false, error: null });
    },
  };
});
