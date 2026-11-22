/**
 * VM manager facade: platform-specific implementation (Linux libvirt vs macOS stub).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/index.js' : './darwin/index.js',
);

export const configure = impl.configure;
export const connect = impl.connect;
export const disconnect = impl.disconnect;
export const IS_DARWIN = impl.IS_DARWIN;

export const getHostInfo = impl.getHostInfo;
export const getHostHardware = impl.getHostHardware;
export const getRunningVMAllocations = impl.getRunningVMAllocations;
export const pingLibvirt = impl.pingLibvirt;
export const listHostFirmware = impl.listHostFirmware;

export const listVMs = impl.listVMs;
export const getVMConfig = impl.getVMConfig;
export const findVMsUsingImage = impl.findVMsUsingImage;
export const subscribeVMListChange = impl.subscribeVMListChange;
export const subscribeVMChange = impl.subscribeVMChange;
export const getGuestNetwork = impl.getGuestNetwork;

export const assertVMState = impl.assertVMState;
export const startVM = impl.startVM;
export const stopVM = impl.stopVM;
export const forceStopVM = impl.forceStopVM;
export const rebootVM = impl.rebootVM;
export const suspendVM = impl.suspendVM;
export const resumeVM = impl.resumeVM;
export const subscribeVMStopped = impl.subscribeVMStopped;

export const getVMStats = impl.getVMStats;
export const getVMXML = impl.getVMXML;
export const getVNCPort = impl.getVNCPort;


export const assertVMNameAvailable = impl.assertVMNameAvailable;
export const createVM = impl.createVM;
export const deleteVM = impl.deleteVM;

export const updateVMConfig = impl.updateVMConfig;
export const renameVM = impl.renameVM;
export const setVMPendingRestart = impl.setVMPendingRestart;
export const getGraphicsListen = impl.getGraphicsListen;
export const setGraphicsListen = impl.setGraphicsListen;
export const removeVMPref = impl.removeVMPref;
export const setMissingVMProfile = impl.setMissingVMProfile;

export const getVMUSBDevices = impl.getVMUSBDevices;
export const attachUSBDevice = impl.attachUSBDevice;
export const detachUSBDevice = impl.detachUSBDevice;

export const attachDisk = impl.attachDisk;
export const createAndAttachDisk = impl.createAndAttachDisk;
export const detachDisk = impl.detachDisk;
export const resizeDiskBySlot = impl.resizeDiskBySlot;

export const attachISO = impl.attachISO;
export const ejectISO = impl.ejectISO;
export const parseVMFromXML = impl.parseVMFromXML;
export const isShutOff = impl.isShutOff;

export const createBackup = impl.createBackup;
export const listBackups = impl.listBackups;
export const planBackupRestore = impl.planBackupRestore;
export const restoreBackup = impl.restoreBackup;
export const deleteBackup = impl.deleteBackup;
export const subscribeVMBackupDeleted = impl.subscribeVMBackupDeleted;
export const resolveVmBackupDir = impl.resolveVmBackupDir;
export const tightenVMBackupFileModes = impl.tightenVMBackupFileModes;
export const setVMBackupOrigin = impl.setVMBackupOrigin;
