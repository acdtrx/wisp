/**
 * Background job kind strings (must match frontend JOB_KIND / subscribeJobProgress paths).
 */
export const BACKGROUND_JOB_KIND = {
  VM_CREATE: 'vm-create',
  CONTAINER_CREATE: 'container-create',
  CONTAINER_IMAGE_UPDATE_CHECK: 'container-image-update-check',
  BACKUP: 'backup',
  CONTAINER_BACKUP: 'container-backup',
  CONTAINER_RESTORE: 'container-restore',
  LIBRARY_DOWNLOAD: 'library-download',
  // Operation jobs (operationJobStore): progress at /api/jobs/:jobId/progress.
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
