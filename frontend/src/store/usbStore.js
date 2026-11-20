import { createStreamStore, streamSource } from './streamStore.js';

/**
 * The host's USB devices, from their scoped stream: `data` is
 * `[{ bus, device, vendorId, productId, name }]`.
 */
export const useUsbStore = createStreamStore({
  source: streamSource(() => '/api/host/usb/stream'),
  toData: (frame) => (Array.isArray(frame) ? frame : undefined),
});
