import { JOB_KIND } from '../../../../shared/wireNames.js';

const K = JOB_KIND;

/**
 * The kinds that act on a workload: the subject's type, and the label the job
 * holds that workload's operation lock under (the busy error names it). A
 * kind not listed acts on no workload and takes no subject.
 * @type {Record<string, { type: 'vm' | 'container', lock: string }>}
 */
export const SUBJECT_KINDS = {
  [K.VM_CREATE]: { type: 'vm', lock: 'create' },
  [K.VM_BACKUP]: { type: 'vm', lock: 'backup' },
  [K.VM_START]: { type: 'vm', lock: 'start' },
  [K.VM_FORCE_STOP]: { type: 'vm', lock: 'force stop' },
  [K.VM_DELETE]: { type: 'vm', lock: 'delete' },
  [K.VM_RESTORE]: { type: 'vm', lock: 'restore' },
  [K.CONTAINER_CREATE]: { type: 'container', lock: 'create' },
  [K.CONTAINER_BACKUP]: { type: 'container', lock: 'backup' },
  [K.CONTAINER_RESTORE]: { type: 'container', lock: 'restore' },
  [K.CONTAINER_RESTORE_AS_NEW]: { type: 'container', lock: 'restore' },
  [K.CONTAINER_START]: { type: 'container', lock: 'start' },
  [K.CONTAINER_STOP]: { type: 'container', lock: 'stop' },
  [K.CONTAINER_RESTART]: { type: 'container', lock: 'restart' },
  [K.CONTAINER_DELETE]: { type: 'container', lock: 'delete' },
  [K.CONTAINER_MOUNT_DELETE]: { type: 'container', lock: 'configuration change' },
  [K.CONTAINER_MOUNT_DATA_DELETE]: { type: 'container', lock: 'mount data delete' },
  [K.CONTAINER_ZIP_EXTRACT]: { type: 'container', lock: 'zip upload' },
  [K.CONTAINER_DEPLOY]: { type: 'container', lock: 'deploy' },
  [K.CONTAINER_IMAGE_UPDATE]: { type: 'container', lock: 'image update' },
};
