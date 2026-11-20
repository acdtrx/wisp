/**
 * Jobs module facade: the one job store and its starter, the job kinds and
 * the job titles.
 */
export {
  startJob,
  isJobRunning,
  countJobsThatMustFinish,
  cancelInterruptibleJobs,
  subscribeJobsChange,
  listJobs,
  readJob,
  hasJob,
  whenJobEnds,
  registerJobStream,
  unregisterJobStream,
} from './jobStore.js';

export { BACKGROUND_JOB_KIND } from './backgroundJobKinds.js';
export {
  titleForLibraryDownloadUrl,
  titleForVmCreate,
  titleForVmBackup,
  titleForContainerCreate,
  titleForContainerBackup,
  titleForContainerRestore,
  TITLE_IMAGE_UPDATE_CHECK_ALL,
  titleForImageUpdateCheckSingle,
  TITLE_LIBRARY_UBUNTU_CLOUD,
  TITLE_LIBRARY_ARCH_CLOUD,
  TITLE_LIBRARY_HAOS,
  titleForVmStart,
  titleForVmForceStop,
  titleForVmDelete,
  titleForVmRestore,
  TITLE_OS_UPDATE_CHECK,
  TITLE_OS_UPGRADE,
  titleForBridgeCreate,
  titleForBridgeDelete,
  titleForUnmount,
  titleForMountDelete,
  titleForSelfUpdate,
  titleForContainerStart,
  titleForContainerStop,
  titleForContainerRestart,
  titleForContainerDelete,
  titleForContainerMountDelete,
  titleForContainerMountDataDelete,
  titleForContainerImageDelete,
  titleForContainerRestoreAsNew,
  titleForZipExtract,
  titleForContainerDeploy,
  titleForContainerImageUpdate,
} from './backgroundJobTitles.js';
