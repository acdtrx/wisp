import { createJobSSE } from './sse.js';

/** Discriminator for progress URL (see registerBackgroundJob). */
export const JOB_KIND = {
  VM_CREATE: 'vm-create',
  CONTAINER_CREATE: 'container-create',
  CONTAINER_IMAGE_UPDATE_CHECK: 'container-image-update-check',
  BACKUP: 'backup',
  LIBRARY_DOWNLOAD: 'library-download',
  WISP_UPDATE: 'wisp-update',
};

const PATHS = {
  [JOB_KIND.VM_CREATE]: (jobId) => `/api/vms/create-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.CONTAINER_CREATE]: (jobId) => `/api/containers/create-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK]: (jobId) => `/api/containers/images/check-updates/${encodeURIComponent(jobId)}`,
  [JOB_KIND.BACKUP]: (jobId) => `/api/vms/backup-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.LIBRARY_DOWNLOAD]: (jobId) => `/api/library/download-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.WISP_UPDATE]: (jobId) => `/api/updates/progress/${encodeURIComponent(jobId)}`,
};

/**
 * Subscribe to a job progress stream. Same behavior as per-feature wrappers in vms/backups/containers/library.
 * @param {(reason?: 'not_found') => void} [onConnectionLost]
 */
export function subscribeJobProgress(kind, jobId, onMessage, onConnectionLost) {
  const build = PATHS[kind];
  if (!build) {
    throw new Error(`Unknown job kind: ${kind}`);
  }
  return createJobSSE(build(jobId), onMessage, onConnectionLost);
}
