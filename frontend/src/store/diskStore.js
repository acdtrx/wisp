import { createStreamStore, streamSource } from './streamStore.js';

/**
 * The host's block devices, from their scoped stream: `data` is
 * `[{ uuid, devPath, fsType, label, sizeBytes, removable, vendor, model, mountedAt }]`.
 */
export const useDiskStore = createStreamStore({
  source: streamSource(() => '/api/host/disks/stream'),
  toData: (frame) => (Array.isArray(frame) ? frame : undefined),
});
