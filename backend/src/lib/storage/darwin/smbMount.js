/**
 * SMB mount stub (macOS dev).
 */
import { createAppError } from '../../routeErrors.js';

const UNAVAILABLE = 'SMB_MOUNT_UNAVAILABLE';

export async function mountSMB() {
  throw createAppError(UNAVAILABLE, 'SMB mount is only supported on Linux', 'Unsupported platform');
}

export async function checkSMBConnection() {
  throw createAppError(UNAVAILABLE, 'SMB is only supported on Linux', 'Unsupported platform');
}

export async function unmountSMB() {
  throw createAppError(UNAVAILABLE, 'SMB unmount is only supported on Linux', 'Unsupported platform');
}

export async function getMountStatus(mountPath) {
  if (!mountPath || !mountPath.startsWith('/')) return { mounted: false };
  return { mounted: false };
}

export async function rmdirMountpoint() {
  /* no-op on macOS */
}
