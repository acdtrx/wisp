/**
 * wisp-os-update stub (macOS dev).
 */
import { createAppError } from '../../routeErrors.js';

const UNAVAILABLE = 'UPDATE_CHECK_UNAVAILABLE';

export function getPendingUpdatesCount() {
  return 0;
}

export function getLastCheckedAt() {
  return null;
}

export function getCachedPackages() {
  return null;
}

export function isOperationInProgress() {
  return false;
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
