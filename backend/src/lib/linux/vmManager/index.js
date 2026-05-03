/**
 * Linux vmManager implementation (libvirt over DBus).
 */
export {
  connect,
  disconnect,
  connectionState,
  IS_DARWIN,
  vmError,
  unwrapVariant,
  unwrapDict,
  formatVersion,
  generateMAC,
  resolveDomain,
  getDomainState,
  getDomainXML,
  getDomainObjAndIface,
} from './vmManagerConnection.js';

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
  getCachedStaleBinary,
  subscribeVMListChange,
} from './vmManagerList.js';

export { startVM, stopVM, forceStopVM, rebootVM, suspendVM, resumeVM } from './vmManagerLifecycle.js';

export { getVMStats, getVMXML, getVNCPort } from './vmManagerStats.js';

export { isVMBinaryStale } from './vmManagerProc.js';

export {
  createVM,
  deleteVM,
  cloneVM,
  getWindowsFeatures,
  getWindowsClock,
  getLinuxFeatures,
} from './vmManagerCreate.js';

export { updateVMConfig } from './vmManagerConfig.js';

export { getVMUSBDevices, attachUSBDevice, detachUSBDevice } from './vmManagerUsb.js';

export {
  attachDisk,
  createAndAttachDisk,
  detachDisk,
  resizeDiskBySlot,
  updateDiskBus,
  extractDiskSnippet,
} from './vmManagerDisk.js';

export { attachISO, ejectISO } from './vmManagerIso.js';

export {
  generateCloudInit,
  attachCloudInitDisk,
  detachCloudInitDisk,
  getCloudInitConfig,
  updateCloudInit,
} from './vmManagerCloudInit.js';

export {
  listSnapshots,
  createSnapshot,
  revertSnapshot,
  deleteSnapshot,
} from './vmManagerSnapshots.js';

export {
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
} from './vmManagerBackup.js';
