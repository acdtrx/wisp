/**
 * Background job kind strings (must match frontend JOB_KIND / subscribeJobProgress paths).
 */
export const BACKGROUND_JOB_KIND = {
  VM_CREATE: 'vm-create',
  CONTAINER_CREATE: 'container-create',
  CONTAINER_IMAGE_UPDATE_CHECK: 'container-image-update-check',
  BACKUP: 'backup',
  LIBRARY_DOWNLOAD: 'library-download',
  WISP_UPDATE: 'wisp-update',
};
