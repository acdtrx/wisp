/**
 * Storage module facade — qemu-img wrappers (cross-platform), block-device
 * enumeration + hotplug, removable disk and SMB mount via the wisp-mount
 * helper, the kernel mount table reader, and owner-only mode tightening for
 * secret-holding files. Single public surface for
 * VM/container managers, host routes and inspection (host/), and Wisp
 * app-level glue (mountsAutoMount). SMART summaries live in the host module
 * (sole consumer is hostHardware).
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

export {
  getDiskInfo, inspectDiskImage, imageFormatForFile, getBackingChain, copyAndConvert, resizeDisk,
} from './diskOps.js';
export { measurePathSize } from './dirSize.js';
export { createStallWatchdog, fileBlocksProbe, processReadProbe, stallMinutes, killProcessGroup } from './stallWatchdog.js';
export { restrictToOwner, describeModeChanges } from './fileModes.js';

// Kernel mount table (/proc/self/mounts), decoded — the one reader for mount state
export { readMountTable } from './mountTable.js';

// A mount's size, read off the main thread with a bound (a dead share never stalls the backend)
export { readMountSize, mountSizeReadsInFlight } from './mountSize.js';

// Block-device enumeration + hotplug
export const start = monitorImpl.start;
export const stop = monitorImpl.stop;
export const getDevices = monitorImpl.getDevices;
export const onChange = monitorImpl.onChange;
export const refresh = monitorImpl.refresh;

/** Notified after a mount or unmount (disk or SMB) succeeded. No replay: a cue to
 *  read the mount status again. */
const mountStateHandlers = new Set();

export function subscribeMountStateChange(handler) {
  mountStateHandlers.add(handler);
  return () => mountStateHandlers.delete(handler);
}

function announcingMountState(operation) {
  return async (...args) => {
    const result = await operation(...args);
    for (const handler of mountStateHandlers) {
      try {
        handler();
      } catch (err) {
        // A broken subscriber must not fail the mount or silence the others.
        console.error('storage: mount state subscriber failed', err);
      }
    }
    return result;
  };
}

// Removable disk mount via wisp-mount
export const mountDisk = announcingMountState(mountImpl.mountDisk);
export const unmountDisk = announcingMountState(mountImpl.unmountDisk);

// SMB mount via wisp-mount
export const mountSMB = announcingMountState(smbImpl.mountSMB);
export const checkSMBConnection = smbImpl.checkSMBConnection;
export const unmountSMB = announcingMountState(smbImpl.unmountSMB);
export const getMountStatus = smbImpl.getMountStatus;
export const rmdirMountpoint = smbImpl.rmdirMountpoint;
