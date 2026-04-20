/**
 * Disk mount stub (macOS dev).
 */
import { createAppError } from '../../routeErrors.js';

const UNAVAILABLE = 'DISK_MOUNT_UNAVAILABLE';

export async function mountDisk() {
  throw createAppError(UNAVAILABLE, 'Disk mount is only supported on Linux', 'Unsupported platform');
}

export async function unmountDisk() {
  throw createAppError(UNAVAILABLE, 'Disk unmount is only supported on Linux', 'Unsupported platform');
}
