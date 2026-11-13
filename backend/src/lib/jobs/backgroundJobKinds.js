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
  CONTAINER_START: 'container-start',
  CONTAINER_STOP: 'container-stop',
  CONTAINER_RESTART: 'container-restart',
  CONTAINER_DELETE: 'container-delete',
  CONTAINER_MOUNT_DELETE: 'container-mount-delete',
  CONTAINER_MOUNT_DATA_DELETE: 'container-mount-data-delete',
  CONTAINER_IMAGE_DELETE: 'container-image-delete',
  CONTAINER_RESTORE_AS_NEW: 'container-restore-new',
  CONTAINER_ZIP_EXTRACT: 'container-zip-extract',
  // Started by MCP tools (lib/mcp/tools/containerAdminTools.js).
  CONTAINER_DEPLOY: 'container-deploy',
  CONTAINER_IMAGE_UPDATE: 'container-image-update',
  CONTAINER_IMAGE_CHECK: 'container-image-check',
};
