/**
 * Host power stub (macOS dev).
 */
import { createAppError } from '../../routeErrors.js';

const POWER_UNAVAILABLE = 'POWER_UNAVAILABLE';

export async function hostShutdown() {
  throw createAppError(POWER_UNAVAILABLE, 'Power operations are only supported on Linux', 'Unsupported platform');
}

export async function hostReboot() {
  throw createAppError(POWER_UNAVAILABLE, 'Power operations are only supported on Linux', 'Unsupported platform');
}
