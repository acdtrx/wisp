/**
 * Storage module facade — qemu-img wrappers (cross-platform), block-device
 * enumeration + hotplug, removable disk and SMB mount via the wisp-mount
 * helper, and SMART summaries. Single public surface for VM/container
 * managers, host routes, and Wisp app-level glue (mountsAutoMount).
 */
import { platform } from 'node:os';

const isLinux = platform() === 'linux';

const monitorImpl = await import(
  isLinux ? './linux/diskMonitor.js' : './darwin/diskMonitor.js',
);
const mountImpl = await import(
  isLinux ? './linux/diskMount.js' : './darwin/diskMount.js',
);
const smbImpl = await import(
  isLinux ? './linux/smbMount.js' : './darwin/smbMount.js',
);
const smartImpl = await import(
  isLinux ? './linux/smart.js' : './darwin/smart.js',
);

export { getDiskInfo, copyAndConvert, resizeDisk } from './diskOps.js';

// Block-device enumeration + hotplug
export const start = monitorImpl.start;
export const stop = monitorImpl.stop;
export const getDevices = monitorImpl.getDevices;
export const onChange = monitorImpl.onChange;
export const refresh = monitorImpl.refresh;

// Removable disk mount via wisp-mount
export const mountDisk = mountImpl.mountDisk;
export const unmountDisk = mountImpl.unmountDisk;

// SMB mount via wisp-mount
export const mountSMB = smbImpl.mountSMB;
export const checkSMBConnection = smbImpl.checkSMBConnection;
export const unmountSMB = smbImpl.unmountSMB;
export const getMountStatus = smbImpl.getMountStatus;
export const rmdirMountpoint = smbImpl.rmdirMountpoint;

// SMART
export const readDiskSmartSummary = smartImpl.readDiskSmartSummary;
export const readAllDiskSmartSummaries = smartImpl.readAllDiskSmartSummaries;
