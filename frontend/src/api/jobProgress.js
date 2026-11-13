import { createJobSSE } from './sse.js';

/** Discriminator for progress URL (see registerBackgroundJob). */
export const JOB_KIND = {
  VM_CREATE: 'vm-create',
  CONTAINER_CREATE: 'container-create',
  CONTAINER_IMAGE_UPDATE_CHECK: 'container-image-update-check',
  BACKUP: 'backup',
  CONTAINER_BACKUP: 'container-backup',
  CONTAINER_RESTORE: 'container-restore',
  LIBRARY_DOWNLOAD: 'library-download',
  VM_START: 'vm-start',
  VM_FORCE_STOP: 'vm-force-stop',
  VM_DELETE: 'vm-delete',
  VM_RESTORE: 'vm-restore',
  OS_UPDATE_CHECK: 'os-update-check',
  OS_UPGRADE: 'os-upgrade',
  NETWORK_BRIDGE_CREATE: 'network-bridge-create',
  NETWORK_BRIDGE_DELETE: 'network-bridge-delete',
  MOUNT_UNMOUNT: 'mount-unmount',
  MOUNT_DELETE: 'mount-delete',
  SELF_UPDATE: 'self-update',
};

/** Operation jobs (commands that can outlast a short request) share one stream route. */
const operationJobPath = (jobId) => `/api/jobs/${encodeURIComponent(jobId)}/progress`;

const PATHS = {
  [JOB_KIND.VM_CREATE]: (jobId) => `/api/vms/create-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.CONTAINER_CREATE]: (jobId) => `/api/containers/create-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.CONTAINER_IMAGE_UPDATE_CHECK]: (jobId) => `/api/containers/images/check-updates/${encodeURIComponent(jobId)}`,
  [JOB_KIND.BACKUP]: (jobId) => `/api/vms/backup-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.CONTAINER_BACKUP]: (jobId) => `/api/containers/backup-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.CONTAINER_RESTORE]: (jobId) => `/api/containers/backup-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.LIBRARY_DOWNLOAD]: (jobId) => `/api/library/download-progress/${encodeURIComponent(jobId)}`,
  [JOB_KIND.VM_START]: operationJobPath,
  [JOB_KIND.VM_FORCE_STOP]: operationJobPath,
  [JOB_KIND.VM_DELETE]: operationJobPath,
  [JOB_KIND.VM_RESTORE]: operationJobPath,
  [JOB_KIND.OS_UPDATE_CHECK]: operationJobPath,
  [JOB_KIND.OS_UPGRADE]: operationJobPath,
  [JOB_KIND.NETWORK_BRIDGE_CREATE]: operationJobPath,
  [JOB_KIND.NETWORK_BRIDGE_DELETE]: operationJobPath,
  [JOB_KIND.MOUNT_UNMOUNT]: operationJobPath,
  [JOB_KIND.MOUNT_DELETE]: operationJobPath,
  [JOB_KIND.SELF_UPDATE]: operationJobPath,
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
