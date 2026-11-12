/**
 * Linux containerManager implementation (containerd over gRPC).
 */
import { setContainerManagerConfig } from './containerPaths.js';
import { setOperationLockAcquirer } from './containerOperationGuard.js';

export function configure(cfg) {
  setContainerManagerConfig(cfg);
  setOperationLockAcquirer(cfg.tryAcquireOperationLock);
}

export {
  connect,
  disconnect,
  containerError,
  IS_DARWIN,
} from './containerManagerConnection.js';

export {
  getContainerDir,
} from './containerPaths.js';

export {
  listContainers,
  getContainerConfig,
  getRunningContainerCount,
  findContainersUsingStorageMount,
  subscribeContainerListChange,
} from './containerManagerList.js';

export { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';

export {
  startContainer,
  stopContainer,
  killContainer,
  restartContainer,
  getTaskState,
  startAutostartContainersAtBackendBoot,
  resumeStalePausedContainersAtBackendBoot,
} from './containerManagerLifecycle.js';

export {
  createContainer,
  deleteContainer,
  pullImage,
} from './containerManagerCreate.js';

export { renameContainer } from './containerManagerRename.js';

export {
  createContainerBackup,
  listContainerBackups,
  restoreContainerBackup,
  restoreContainerBackupInPlace,
  deleteContainerBackup,
  setContainerBackupOrigin,
} from './containerManagerBackup.js';

export { tightenContainerFileModes, tightenContainerBackupFileModes } from './containerManagerFileModes.js';

export {
  listContainerImages,
  deleteContainerImage,
  getImageDigest,
  resolveContainerImageRef,
} from './containerManagerImages.js';

export {
  checkAllImagesForUpdates,
  checkSingleImageForUpdates,
  getImageUpdateStatus,
  startImageUpdateChecker,
  stopImageUpdateChecker,
} from './containerManagerImageUpdates.js';

export { updateContainerConfig } from './containerManagerConfig.js';
export { setContainerPendingRestart } from './containerManagerPendingRestart.js';

export {
  addContainerMount,
  updateContainerMount,
  removeContainerMount,
} from './containerManagerMountCrud.js';

export { getContainerMountUsage } from './containerManagerUsage.js';

export {
  addContainerService,
  updateContainerService,
  removeContainerService,
} from './containerManagerServices.js';

export { getContainerStats } from './containerManagerStats.js';

export {
  listContainerRuns,
  getContainerRunLogs,
  readRunLogHistory,
  streamContainerRunLogs,
  resolveRunId,
  createRunLogReadStream,
} from './containerManagerLogs.js';

export {
  uploadMountFileStream,
  uploadMountZipStream,
  initMountContent,
  deleteMountData,
  deleteRemovedMountData,
  MOUNT_FILE_CONTENT_MAX_BYTES,
  getMountFileTextContent,
  putMountFileTextContent,
  getMountFileSize,
  getMountFileMode,
  setMountFileMode,
} from './containerManagerMountsContent.js';

export {
  subscribeContainerNetnsRemoved,
  generateContainerMac,
} from './containerManagerNetwork.js';

export { subscribeContainerNetworkChange } from './containerManagerNetworkEvents.js';

export { execInContainer, execCommandInContainer, resizeExec } from './containerManagerExec.js';
