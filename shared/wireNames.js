/**
 * The names the backend and the frontend must agree on, on the wire
 * (docs/specs/API.md): the events stream's topics, the `changes` topic's
 * kinds and the job kinds. Both sides import them from here, and ESLint
 * (eslint.config.mjs) refuses one written as a bare string elsewhere. This
 * folder holds nothing else.
 */

/** The topics of `GET /api/events` (API.md, Events stream). */
export const TOPIC = Object.freeze({
  STATS: 'stats',
  VMS: 'vms',
  CONTAINERS: 'containers',
  SECTIONS: 'sections',
  DISCOVERY: 'discovery',
  HOME: 'home',
  BACKUPS: 'backups',
  JOBS: 'jobs',
  CHANGES: 'changes',
});

/** The kinds a `changes` frame names (API.md, `changes` topic payload); `ALL` is the connect frame's. */
export const CHANGE_KIND = Object.freeze({
  ALL: 'all',
  VM: 'vm',
  CONTAINER: 'container',
  SETTINGS: 'settings',
  HOST_MOUNTS: 'host-mounts',
  NETWORK_BRIDGES: 'network-bridges',
  LIBRARY: 'library',
  IMAGES: 'images',
  TOKENS: 'tokens',
  CERTIFICATE: 'certificate',
  WISP_UPDATE: 'wisp-update',
});

/** Every job kind (API.md, Background jobs). */
export const JOB_KIND = Object.freeze({
  VM_CREATE: 'vm-create',
  VM_BACKUP: 'vm-backup',
  VM_START: 'vm-start',
  VM_STOP: 'vm-stop',
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
  CONTAINER_IMAGE_IMPORT: 'container-image-import',
  CONTAINER_IMAGE_DELETE: 'container-image-delete',
  LIBRARY_DOWNLOAD: 'library-download',
  OS_UPDATE_CHECK: 'os-update-check',
  OS_UPGRADE: 'os-upgrade',
  NETWORK_BRIDGE_CREATE: 'network-bridge-create',
  NETWORK_BRIDGE_DELETE: 'network-bridge-delete',
  MOUNT_UNMOUNT: 'mount-unmount',
  MOUNT_DELETE: 'mount-delete',
  CERTIFICATE_ISSUE: 'certificate-issue',
  SELF_UPDATE: 'self-update',
});
