/**
 * VM manager facade: platform-specific implementation (Linux libvirt vs macOS stub).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/vmManager/index.js' : './darwin/vmManager/index.js',
);

export const connect = impl.connect;
export const disconnect = impl.disconnect;
export const connectionState = impl.connectionState;
export const IS_DARWIN = impl.IS_DARWIN;
export const vmError = impl.vmError;
export const unwrapVariant = impl.unwrapVariant;
export const unwrapDict = impl.unwrapDict;
export const formatVersion = impl.formatVersion;
export const generateMAC = impl.generateMAC;
export const resolveDomain = impl.resolveDomain;
export const getDomainState = impl.getDomainState;
export const getDomainXML = impl.getDomainXML;
export const getDomainObjAndIface = impl.getDomainObjAndIface;

export const getHostInfo = impl.getHostInfo;
export const getHostHardware = impl.getHostHardware;
export const getRunningVMAllocations = impl.getRunningVMAllocations;
export const listHostFirmware = impl.listHostFirmware;

export const listVMs = impl.listVMs;
export const getVMConfig = impl.getVMConfig;
export const findVMsUsingImage = impl.findVMsUsingImage;
export const getCachedLocalDns = impl.getCachedLocalDns;
export const getCachedStaleBinary = impl.getCachedStaleBinary;
export const subscribeVMListChange = impl.subscribeVMListChange;

export const startVM = impl.startVM;
export const stopVM = impl.stopVM;
export const forceStopVM = impl.forceStopVM;
export const rebootVM = impl.rebootVM;
export const suspendVM = impl.suspendVM;
export const resumeVM = impl.resumeVM;

export const getVMStats = impl.getVMStats;
export const getVMXML = impl.getVMXML;
export const getVNCPort = impl.getVNCPort;

export const isVMBinaryStale = impl.isVMBinaryStale;

export const createVM = impl.createVM;
export const deleteVM = impl.deleteVM;
export const cloneVM = impl.cloneVM;
export const getWindowsFeatures = impl.getWindowsFeatures;
export const getWindowsClock = impl.getWindowsClock;
export const getLinuxFeatures = impl.getLinuxFeatures;

export const updateVMConfig = impl.updateVMConfig;

export const getVMUSBDevices = impl.getVMUSBDevices;
export const attachUSBDevice = impl.attachUSBDevice;
export const detachUSBDevice = impl.detachUSBDevice;

export const attachDisk = impl.attachDisk;
export const createAndAttachDisk = impl.createAndAttachDisk;
export const detachDisk = impl.detachDisk;
export const resizeDiskBySlot = impl.resizeDiskBySlot;
export const updateDiskBus = impl.updateDiskBus;
export const extractDiskSnippet = impl.extractDiskSnippet;

export const attachISO = impl.attachISO;
export const ejectISO = impl.ejectISO;

export const generateCloudInit = impl.generateCloudInit;
export const attachCloudInitDisk = impl.attachCloudInitDisk;
export const detachCloudInitDisk = impl.detachCloudInitDisk;
export const getCloudInitConfig = impl.getCloudInitConfig;
export const updateCloudInit = impl.updateCloudInit;

export const listSnapshots = impl.listSnapshots;
export const createSnapshot = impl.createSnapshot;
export const revertSnapshot = impl.revertSnapshot;
export const deleteSnapshot = impl.deleteSnapshot;

export const createBackup = impl.createBackup;
export const listBackups = impl.listBackups;
export const restoreBackup = impl.restoreBackup;
export const deleteBackup = impl.deleteBackup;
