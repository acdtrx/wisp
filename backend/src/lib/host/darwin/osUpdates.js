/**
 * wisp-os-update stub (macOS dev).
 */
import { createAppError } from '../../appErrors.js';

const UNAVAILABLE = 'UPDATE_CHECK_UNAVAILABLE';

/** No OS update check here: the hourly trigger stays off; a manual check answers UPDATE_CHECK_UNAVAILABLE. */
export const supportsOsUpdateChecks = false;

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

export function isUpgradeInProgress() {
  return false;
}

export async function checkForUpdates() {
  throw createAppError(UNAVAILABLE, 'OS update operations are only supported on Linux', 'Unsupported platform');
}

export async function performUpgrade() {
  throw createAppError(UNAVAILABLE, 'OS upgrade is only supported on Linux', 'Unsupported platform');
}
