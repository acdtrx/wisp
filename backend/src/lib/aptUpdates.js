/**
 * OS update background checks (Linux) vs stub (macOS dev).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/host/osUpdates.js' : './darwin/host/osUpdates.js',
);

export const getPendingUpdatesCount = impl.getPendingUpdatesCount;
export const setCachedUpdateCount = impl.setCachedUpdateCount;
export const getLastCheckedAt = impl.getLastCheckedAt;
export const checkForUpdates = impl.checkForUpdates;
export const performUpgrade = impl.performUpgrade;
export const listUpgradablePackages = impl.listUpgradablePackages;
export const startUpdateChecker = impl.startUpdateChecker;
export const stopUpdateChecker = impl.stopUpdateChecker;
