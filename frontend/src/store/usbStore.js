import { create } from 'zustand';
import { createSSE } from '../api/sse.js';

export const useUsbStore = create((set) => {
  let closeFn = null;

  return {
    /** @type { Array<{ bus: string, device: string, vendorId: string, productId: string, name: string }> | null } */
    devices: null,
    connected: false,

    connect: () => {
      if (closeFn) return;

      closeFn = createSSE(
        '/api/host/usb/stream',
        (data) => {
          if (Array.isArray(data)) {
            set({ devices: data, connected: true });
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
      set({ devices: null, connected: false });
    },
  };
});
