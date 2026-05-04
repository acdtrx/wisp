/**
 * Container manager facade: platform-specific implementation (Linux containerd vs macOS stub).
 */
import { platform } from 'node:os';

const impl = await import(
  platform() === 'linux' ? './linux/containerManager/index.js' : './darwin/containerManager/index.js',
);

export const configure = impl.configure;
export const connect = impl.connect;
export const disconnect = impl.disconnect;
export const containerState = impl.containerState;
export const containerError = impl.containerError;
export const IS_DARWIN = impl.IS_DARWIN;
export const getClient = impl.getClient;
export const callUnary = impl.callUnary;
export const callStream = impl.callStream;
export const packAny = impl.packAny;
export const unpackAny = impl.unpackAny;

export const getContainersPath = impl.getContainersPath;
export const getContainerDir = impl.getContainerDir;
export const getContainerFilesDir = impl.getContainerFilesDir;
export const ensureContainersDir = impl.ensureContainersDir;

export const listContainers = impl.listContainers;
export const getContainerConfig = impl.getContainerConfig;
export const getRunningContainerCount = impl.getRunningContainerCount;
export const findContainersUsingStorageMount = impl.findContainersUsingStorageMount;
export const subscribeContainerListChange = impl.subscribeContainerListChange;
export const notifyContainerConfigWrite = impl.notifyContainerConfigWrite;

export const startContainer = impl.startContainer;
export const startAutostartContainersAtBackendBoot = impl.startAutostartContainersAtBackendBoot;
export const stopContainer = impl.stopContainer;
export const killContainer = impl.killContainer;
export const restartContainer = impl.restartContainer;
export const getTaskState = impl.getTaskState;

export const createContainer = impl.createContainer;
export const deleteContainer = impl.deleteContainer;
export const pullImage = impl.pullImage;
export const startExistingContainer = impl.startExistingContainer;
export const renameContainer = impl.renameContainer;

export const createContainerBackup = impl.createContainerBackup;
export const listContainerBackups = impl.listContainerBackups;
export const restoreContainerBackup = impl.restoreContainerBackup;
export const deleteContainerBackup = impl.deleteContainerBackup;

export const listContainerImages = impl.listContainerImages;
export const deleteContainerImage = impl.deleteContainerImage;
export const getImageDigest = impl.getImageDigest;
export const findContainersUsingImage = impl.findContainersUsingImage;

export const checkAllImagesForUpdates = impl.checkAllImagesForUpdates;
export const checkSingleImageForUpdates = impl.checkSingleImageForUpdates;
export const getImageUpdateStatus = impl.getImageUpdateStatus;
export const startImageUpdateChecker = impl.startImageUpdateChecker;
export const stopImageUpdateChecker = impl.stopImageUpdateChecker;

export const updateContainerConfig = impl.updateContainerConfig;

export const addContainerMount = impl.addContainerMount;
export const updateContainerMount = impl.updateContainerMount;
export const removeContainerMount = impl.removeContainerMount;

export const addContainerService = impl.addContainerService;
export const updateContainerService = impl.updateContainerService;
export const removeContainerService = impl.removeContainerService;

export const getContainerStats = impl.getContainerStats;

export const listContainerRuns = impl.listContainerRuns;
export const getContainerRunLogs = impl.getContainerRunLogs;
export const streamContainerRunLogs = impl.streamContainerRunLogs;
export const resolveRunId = impl.resolveRunId;
export const createRunLogReadStream = impl.createRunLogReadStream;

export const uploadMountFileStream = impl.uploadMountFileStream;
export const uploadMountZipStream = impl.uploadMountZipStream;
export const initMountContent = impl.initMountContent;
export const deleteMountData = impl.deleteMountData;
export const MOUNT_FILE_CONTENT_MAX_BYTES = impl.MOUNT_FILE_CONTENT_MAX_BYTES;
export const getMountFileTextContent = impl.getMountFileTextContent;
export const putMountFileTextContent = impl.putMountFileTextContent;

export const setupNetwork = impl.setupNetwork;
export const teardownNetwork = impl.teardownNetwork;
export const discoverIpv4InNetnsOnce = impl.discoverIpv4InNetnsOnce;
export const writeContainerConfig = impl.writeContainerConfig;

export const buildOCISpec = impl.buildOCISpec;

export const execInContainer = impl.execInContainer;
export const execCommandInContainer = impl.execCommandInContainer;
export const resizeExec = impl.resizeExec;
