/**
 * wisp-os-update stub (macOS dev).
 */
import { createAppError } from '../../routeErrors.js';

const UNAVAILABLE = 'UPDATE_CHECK_UNAVAILABLE';

let cachedUpdateCount = 0;

export function getPendingUpdatesCount() {
  return cachedUpdateCount;
}

export function setCachedUpdateCount(count) {
  cachedUpdateCount = count;
}

export function getLastCheckedAt() {
  return null;
}

export async function checkForUpdates() {
  throw createAppError(UNAVAILABLE, 'OS update operations are only supported on Linux', 'Unsupported platform');
}

export async function performUpgrade() {
  throw createAppError(UNAVAILABLE, 'OS upgrade is only supported on Linux', 'Unsupported platform');
}

export async function listUpgradablePackages() {
  throw createAppError(UNAVAILABLE, 'OS update operations are only supported on Linux', 'Unsupported platform');
}

export function startUpdateChecker() {}

export function stopUpdateChecker() {}
