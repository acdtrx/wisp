/**
 * Linux containerManager implementation (containerd over gRPC).
 */
import { setContainerManagerConfig } from './containerPaths.js';
import { announcingContainerChange, announcingContainerBackupDeleted } from './containerManagerChange.js';
import { deleteContainerBackup as deleteContainerBackupImpl } from './containerManagerBackup.js';
import {
  commitMountFileUpload as commitMountFileUploadImpl,
  extractMountZip as extractMountZipImpl,
  initMountContent as initMountContentImpl,
  deleteMountData as deleteMountDataImpl,
  putMountFileTextContent as putMountFileTextContentImpl,
  setMountFileMode as setMountFileModeImpl,
} from './containerManagerMountsContent.js';
import { setOperationLockAcquirer } from './containerOperationGuard.js';

export function configure(cfg) {
  setContainerManagerConfig(cfg);
  setOperationLockAcquirer(cfg.tryAcquireOperationLock);
}

export {
  connect,
  disconnect,
  containerError,
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
  subscribeImagesChange,
} from './containerManagerList.js';

export { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';

export {
  assertContainerState,
  stopContainer,
  killContainer,
  getTaskState,
  isTaskOn,
} from './containerManagerLifecycle.js';

export { startContainer, restartContainer } from './containerManagerStart.js';

export { startAutostartContainersAtBackendBoot, resumeStalePausedContainersAtBackendBoot } from './containerManagerBoot.js';

export { assertContainerNameAvailable, createContainer } from './containerManagerCreate.js';

export { deleteContainer } from './containerManagerDelete.js';

export { pullImage } from './containerManagerPull.js';

export { renameContainer } from './containerManagerRename.js';

export {
  createContainerBackup,
  listContainerBackups,
  planContainerBackupRestore,
  restoreContainerBackup,
  restoreContainerBackupInPlace,
  resolveContainerBackupDir,
  setContainerBackupOrigin,
} from './containerManagerBackup.js';

export const deleteContainerBackup = announcingContainerBackupDeleted(deleteContainerBackupImpl);
export { subscribeContainerBackupDeleted } from './containerManagerChange.js';

export { tightenContainerFileModes, tightenContainerBackupFileModes } from './containerManagerFileModes.js';

export {
  listContainerImages,
  getImageDigest,
  resolveContainerImageRef,
} from './containerManagerImages.js';

export { assertContainerImageDeletable, deleteContainerImage } from './containerManagerImageDelete.js';

export {
  checkAllImagesForUpdates,
  checkSingleImageForUpdates,
  getImageUpdateStatus,
  supportsImageUpdateChecks,
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
  planMountFileUpload,
  assertMountTakesZip,
  planMountZipExtract,
  assertMountOperation,
  deleteRemovedMountData,
  MOUNT_FILE_CONTENT_MAX_BYTES,
  getMountFileTextContent,
  getMountFileSize,
  getMountFileMode,
} from './containerManagerMountsContent.js';

export { subscribeContainerChange } from './containerManagerChange.js';

/* Every write of a mount's content announces itself (subscribeContainerChange);
 * container.json writes announce through the config-write notification. */
export const commitMountFileUpload = announcingContainerChange(commitMountFileUploadImpl, ([plan]) => plan.containerName);
export const extractMountZip = announcingContainerChange(extractMountZipImpl, ([job]) => job.containerName);
export const initMountContent = announcingContainerChange(initMountContentImpl);
export const deleteMountData = announcingContainerChange(deleteMountDataImpl);
export const putMountFileTextContent = announcingContainerChange(putMountFileTextContentImpl);
export const setMountFileMode = announcingContainerChange(setMountFileModeImpl);

export {
  subscribeContainerNetnsRemoved,
  generateContainerMac,
} from './containerManagerNetwork.js';

export { subscribeContainerNetworkChange } from './containerManagerNetworkEvents.js';

export { execInContainer, execCommandInContainer, resizeExec } from './containerManagerExec.js';
