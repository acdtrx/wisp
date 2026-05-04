/**
 * Jobs module facade. Bundles the in-memory background-job stores, the kind +
 * title constants/helpers, and the cross-area listing aggregator.
 *
 * Consumers import named groups (`createJobStore`, `backupJobStore`, ...) as
 * namespaces — same shape that routes used before the carve-out.
 */
export * as createJobStore from './createJobStore.js';
export * as backupJobStore from './backupJobStore.js';
export * as downloadJobStore from './downloadJobStore.js';

export { containerJobStore } from './containerJobStore.js';
export { imageUpdateJobStore } from './imageUpdateJobStore.js';

export { listBackgroundJobs } from './listBackgroundJobs.js';

export { BACKGROUND_JOB_KIND } from './backgroundJobKinds.js';
export {
  titleForLibraryDownloadUrl,
  titleForVmCreate,
  titleForBackup,
  titleForContainerCreate,
  titleForContainerBackup,
  TITLE_IMAGE_UPDATE_CHECK_ALL,
  titleForImageUpdateCheckSingle,
  TITLE_LIBRARY_UBUNTU_CLOUD,
  TITLE_LIBRARY_ARCH_CLOUD,
  TITLE_LIBRARY_HAOS,
} from './backgroundJobTitles.js';
