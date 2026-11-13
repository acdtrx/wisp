/**
 * Linux vmManager implementation (libvirt over DBus).
 */
import { setVmManagerPaths } from './vmManagerPaths.js';

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
  getCachedLocalDns,
  subscribeVMListChange,
} from './vmManagerList.js';

export { subscribeVMNetworkChange } from './vmManagerNetwork.js';

export { getGuestNetwork } from './vmManagerStats.js';

export { assertVMState, startVM, stopVM, forceStopVM, rebootVM, suspendVM, resumeVM } from './vmManagerLifecycle.js';

export { getVMStats, getVMXML, getVNCPort } from './vmManagerStats.js';

export {
  assertVMNameAvailable,
  createVM,
  deleteVM,
} from './vmManagerCreate.js';

export { updateVMConfig, getGraphicsListen, setGraphicsListen } from './vmManagerConfig.js';

export { setVMPendingRestart } from './vmManagerPendingRestart.js';

export { getVMUSBDevices, attachUSBDevice, detachUSBDevice } from './vmManagerUsb.js';

export {
  attachDisk,
  createAndAttachDisk,
  detachDisk,
  resizeDiskBySlot,
  updateDiskBus,
} from './vmManagerDisk.js';

export { attachISO, ejectISO } from './vmManagerIso.js';

export {
  createBackup,
  listBackups,
  planBackupRestore,
  restoreBackup,
  deleteBackup,
  resolveVmBackupDir,
  setVMBackupOrigin,
} from './vmManagerBackup.js';

export { tightenVMBackupFileModes } from './vmManagerBackupModes.js';
