/**
 * Host introspection module facade — hardware/GPU enumeration, power control,
 * USB monitor, /proc stats, reboot-required signal, OS-update checker, and
 * disk SMART summaries. Linux uses sysfs/proc plus a few sudo helpers
 * (wisp-dmidecode, wisp-power, wisp-os-update, wisp-smartctl); macOS is
 * dev-only stubs (system_profiler for hardware, /proc absent so stats are
 * synthesized from os module).
 */
import { platform } from 'node:os';

const isLinux = platform() === 'linux';

const hardwareImpl = await import(
  isLinux ? './linux/hostHardware.js' : './darwin/hostHardware.js',
);
const gpusImpl = await import(
  isLinux ? './linux/hostGpus.js' : './darwin/hostGpus.js',
);
const powerImpl = await import(
  isLinux ? './linux/hostPower.js' : './darwin/hostPower.js',
);
const usbImpl = await import(
  isLinux ? './linux/usbMonitor.js' : './darwin/usbMonitor.js',
);
const statsImpl = await import(
  isLinux ? './linux/procStats.js' : './darwin/procStats.js',
);
const rebootImpl = await import(
  isLinux ? './linux/rebootRequired.js' : './darwin/rebootRequired.js',
);
const updatesImpl = await import(
  isLinux ? './linux/osUpdates.js' : './darwin/osUpdates.js',
);
const smartImpl = await import(
  isLinux ? './linux/smart.js' : './darwin/smart.js',
);

// Hardware inventory
export const getHostHardwareInfo = hardwareImpl.getHostHardwareInfo;

// GPU enumeration
export const listHostGpus = gpusImpl.listHostGpus;

// Power control
export const hostShutdown = powerImpl.hostShutdown;
export const hostReboot = powerImpl.hostReboot;

// USB monitor
export const start = usbImpl.start;
export const stop = usbImpl.stop;
export const getDevices = usbImpl.getDevices;
export const onChange = usbImpl.onChange;

// /proc stats
export const getHostStats = statsImpl.getHostStats;

// Reboot-required signal
export const getRebootSignal = rebootImpl.getRebootSignal;

// OS updates
export const getPendingUpdatesCount = updatesImpl.getPendingUpdatesCount;
export const getLastCheckedAt = updatesImpl.getLastCheckedAt;
export const isUpdateOperationInProgress = updatesImpl.isOperationInProgress;
export const getCachedPackages = updatesImpl.getCachedPackages;
export const checkForUpdates = updatesImpl.checkForUpdates;
export const performUpgrade = updatesImpl.performUpgrade;
export const listUpgradablePackages = updatesImpl.listUpgradablePackages;
export const startUpdateChecker = updatesImpl.startUpdateChecker;
export const stopUpdateChecker = updatesImpl.stopUpdateChecker;

// Disk SMART summaries
export const readDiskSmartSummary = smartImpl.readDiskSmartSummary;
export const readAllDiskSmartSummaries = smartImpl.readAllDiskSmartSummaries;
