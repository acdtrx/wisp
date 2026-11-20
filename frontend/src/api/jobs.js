import { api } from './client.js';
import { createJobSSE } from './sse.js';

/** The server's job kinds (docs/specs/API.md, Background jobs). */
export const JOB_KIND = Object.freeze({
  VM_CREATE: 'vm-create',
  VM_BACKUP: 'vm-backup',
  VM_START: 'vm-start',
  VM_FORCE_STOP: 'vm-force-stop',
  VM_DELETE: 'vm-delete',
  VM_RESTORE: 'vm-restore',
  CONTAINER_CREATE: 'container-create',
  CONTAINER_BACKUP: 'container-backup',
  CONTAINER_RESTORE: 'container-restore',
  CONTAINER_RESTORE_AS_NEW: 'container-restore-new',
  CONTAINER_START: 'container-start',
  CONTAINER_STOP: 'container-stop',
  CONTAINER_RESTART: 'container-restart',
  CONTAINER_DELETE: 'container-delete',
  CONTAINER_MOUNT_DELETE: 'container-mount-delete',
  CONTAINER_MOUNT_DATA_DELETE: 'container-mount-data-delete',
  CONTAINER_ZIP_EXTRACT: 'container-zip-extract',
  CONTAINER_DEPLOY: 'container-deploy',
  CONTAINER_IMAGE_UPDATE: 'container-image-update',
  CONTAINER_IMAGE_UPDATE_CHECK: 'container-image-update-check',
  CONTAINER_IMAGE_DELETE: 'container-image-delete',
  LIBRARY_DOWNLOAD: 'library-download',
  OS_UPDATE_CHECK: 'os-update-check',
  OS_UPGRADE: 'os-upgrade',
  NETWORK_BRIDGE_CREATE: 'network-bridge-create',
  NETWORK_BRIDGE_DELETE: 'network-bridge-delete',
  MOUNT_UNMOUNT: 'mount-unmount',
  MOUNT_DELETE: 'mount-delete',
  SELF_UPDATE: 'self-update',
});

/**
 * The server's jobs, running and recently finished, newest first.
 * @returns {Promise<{ jobs: Array<{ jobId: string, kind: string, title: string, subject: { type: 'vm' | 'container', name: string } | null, status: 'running' | 'done' | 'error', createdAt: number }> }>}
 */
export function listJobs() {
  return api('/api/jobs');
}

/**
 * Stream a job's progress events, whatever its kind, to its last event.
 * @param {(ev: object) => void} onEvent
 * @param {(reason?: 'not_found') => void} [onConnectionLost] - `not_found`: the server no longer knows the job
 * @returns {() => void} close
 */
export function streamJobProgress(jobId, onEvent, onConnectionLost) {
  return createJobSSE(`/api/jobs/${encodeURIComponent(jobId)}/progress`, onEvent, onConnectionLost);
}
