/**
 * Linux containerManager implementation (containerd over gRPC).
 */
import { setContainerManagerConfig } from './containerPaths.js';

export function configure(cfg) {
  setContainerManagerConfig(cfg);
}

export {
  connect,
  disconnect,
  containerState,
  containerError,
  IS_DARWIN,
  getClient,
  callUnary,
  callStream,
  packAny,
  unpackAny,
} from './containerManagerConnection.js';

export {
  getContainersPath,
  getContainerDir,
  getContainerFilesDir,
  ensureContainersDir,
} from './containerPaths.js';

export {
  listContainers,
  getContainerConfig,
  getRunningContainerCount,
  findContainersUsingStorageMount,
  subscribeContainerListChange,
} from './containerManagerList.js';

export { notifyContainerConfigWrite, writeContainerConfig } from './containerManagerConfigIo.js';

export {
  startContainer,
  stopContainer,
  killContainer,
  restartContainer,
  getTaskState,
  startAutostartContainersAtBackendBoot,
} from './containerManagerLifecycle.js';

export {
  createContainer,
  deleteContainer,
  pullImage,
  startExistingContainer,
} from './containerManagerCreate.js';

export { renameContainer } from './containerManagerRename.js';

export {
  createContainerBackup,
  listContainerBackups,
  restoreContainerBackup,
  deleteContainerBackup,
} from './containerManagerBackup.js';

export {
  listContainerImages, deleteContainerImage, getImageDigest, findContainersUsingImage,
} from './containerManagerImages.js';

export {
  checkAllImagesForUpdates,
  checkSingleImageForUpdates,
  getImageUpdateStatus,
  startImageUpdateChecker,
  stopImageUpdateChecker,
} from './containerManagerImageUpdates.js';

export { updateContainerConfig } from './containerManagerConfig.js';

export {
  addContainerMount,
  updateContainerMount,
  removeContainerMount,
} from './containerManagerMountCrud.js';

export {
  addContainerService,
  updateContainerService,
  removeContainerService,
} from './containerManagerServices.js';

export { getContainerStats } from './containerManagerStats.js';

export {
  listContainerRuns,
  getContainerRunLogs,
  streamContainerRunLogs,
  resolveRunId,
  createRunLogReadStream,
} from './containerManagerLogs.js';

export {
  uploadMountFileStream,
  uploadMountZipStream,
  initMountContent,
  deleteMountData,
  MOUNT_FILE_CONTENT_MAX_BYTES,
  getMountFileTextContent,
  putMountFileTextContent,
} from './containerManagerMountsContent.js';

export { setupNetwork, teardownNetwork, discoverIpv4InNetnsOnce } from './containerManagerNetwork.js';

export { buildOCISpec } from './containerManagerSpec.js';

export { execInContainer, execCommandInContainer, resizeExec } from './containerManagerExec.js';
