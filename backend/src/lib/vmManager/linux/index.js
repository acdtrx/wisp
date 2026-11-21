/**
 * Linux vmManager implementation (libvirt over DBus).
 */
import { setVmManagerPaths } from './vmManagerPaths.js';
import { announcingVMChange, announcingVMBackupDeleted } from './vmManagerChange.js';
import { deleteBackup as deleteBackupImpl } from './vmManagerBackup.js';
import {
  updateVMConfig as updateVMConfigImpl,
  setGraphicsListen as setGraphicsListenImpl,
  removeVMPref as removeVMPrefImpl,
  setMissingVMProfile as setMissingVMProfileImpl,
} from './vmManagerConfig.js';
import { setVMPendingRestart as setVMPendingRestartImpl } from './vmManagerPendingRestart.js';
import { attachUSBDevice as attachUSBDeviceImpl, detachUSBDevice as detachUSBDeviceImpl } from './vmManagerUsb.js';
import {
  attachDisk as attachDiskImpl,
  createAndAttachDisk as createAndAttachDiskImpl,
  detachDisk as detachDiskImpl,
  resizeDiskBySlot as resizeDiskBySlotImpl,
  updateDiskBus as updateDiskBusImpl,
} from './vmManagerDisk.js';
import { attachISO as attachISOImpl, ejectISO as ejectISOImpl } from './vmManagerIso.js';

export function configure(cfg) {
  setVmManagerPaths(cfg);
}

export {
  connect,
  disconnect,
  IS_DARWIN,
} from './vmManagerConnection.js';

export { parseVMFromXML } from './vmManagerXml.js';
export { isOfflineState } from './libvirtConstants.js';

export {
  getHostInfo,
  getHostHardware,
  listHostFirmware,
} from './vmManagerHost.js';

export {
  listVMs,
  getRunningVMAllocations,
  getVMConfig,
  findVMsUsingImage,
  subscribeVMListChange,
} from './vmManagerList.js';

export { subscribeVMChange } from './vmManagerChange.js';

export { getGuestNetwork } from './vmManagerStats.js';

export {
  assertVMState, startVM, stopVM, forceStopVM, rebootVM, suspendVM, resumeVM, subscribeVMStopped,
} from './vmManagerLifecycle.js';

export { getVMStats, getVMXML, getVNCPort } from './vmManagerStats.js';

export {
  assertVMNameAvailable,
  createVM,
  deleteVM,
} from './vmManagerCreate.js';

/* Every write to a VM's definition or devices announces itself (subscribeVMChange). */
export const updateVMConfig = announcingVMChange(updateVMConfigImpl, (_args, result) => result.name);
export { getGraphicsListen } from './vmManagerConfig.js';
export const setGraphicsListen = announcingVMChange(
  setGraphicsListenImpl,
  ([name], result) => (result.changed ? name : null),
);

export const removeVMPref = announcingVMChange(
  removeVMPrefImpl,
  ([name], result) => (result.changed ? name : null),
);

export const setMissingVMProfile = announcingVMChange(
  setMissingVMProfileImpl,
  ([name], result) => (result.changed ? name : null),
);

export const setVMPendingRestart = announcingVMChange(
  setVMPendingRestartImpl,
  ([name], result) => (result.changed ? name : null),
);

export { getVMUSBDevices } from './vmManagerUsb.js';
export const attachUSBDevice = announcingVMChange(attachUSBDeviceImpl);
export const detachUSBDevice = announcingVMChange(detachUSBDeviceImpl);

export const attachDisk = announcingVMChange(attachDiskImpl);
export const createAndAttachDisk = announcingVMChange(createAndAttachDiskImpl);
export const detachDisk = announcingVMChange(detachDiskImpl);
export const resizeDiskBySlot = announcingVMChange(resizeDiskBySlotImpl);
export const updateDiskBus = announcingVMChange(updateDiskBusImpl);

export const attachISO = announcingVMChange(attachISOImpl);
export const ejectISO = announcingVMChange(ejectISOImpl);

export {
  createBackup,
  listBackups,
  planBackupRestore,
  restoreBackup,
  resolveVmBackupDir,
  setVMBackupOrigin,
} from './vmManagerBackup.js';

export const deleteBackup = announcingVMBackupDeleted(deleteBackupImpl);
export { subscribeVMBackupDeleted } from './vmManagerChange.js';

export { tightenVMBackupFileModes } from './vmManagerBackupModes.js';
