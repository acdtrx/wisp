/**
 * Linux containerManager implementation (containerd over gRPC).
 */
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

export { listContainers, getContainerConfig, getRunningContainerCount } from './containerManagerList.js';

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

export { getContainerStats } from './containerManagerStats.js';

export { getContainerLogs, streamContainerLogs } from './containerManagerLogs.js';

export {
  uploadMountFileStream,
  uploadMountZipStream,
  initMountContent,
  deleteMountData,
  MOUNT_FILE_CONTENT_MAX_BYTES,
  getMountFileTextContent,
  putMountFileTextContent,
} from './containerManagerMountsContent.js';

export { setupNetwork, teardownNetwork } from './containerManagerNetwork.js';

export { buildOCISpec } from './containerManagerSpec.js';

export { execInContainer, execCommandInContainer, resizeExec } from './containerManagerExec.js';
