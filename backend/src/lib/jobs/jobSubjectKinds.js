import { JOB_KIND } from '../../../../shared/wireNames.js';

const K = JOB_KIND;

/**
 * Every job kind, and the workload it acts on: the subject's type and the label
 * the job holds that workload's operation lock under (the busy error names it),
 * or `null` for a kind that acts on no workload and takes no subject. A kind is
 * listed here or the backend does not start: a new kind's author decides its
 * lock, and cannot leave it out by omission.
 * @type {Record<string, { type: 'vm' | 'container', lock: string } | null>}
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
  [K.CONTAINER_IMAGE_UPDATE_CHECK]: null,
  [K.CONTAINER_IMAGE_DELETE]: null,
  [K.LIBRARY_DOWNLOAD]: null,
  [K.OS_UPDATE_CHECK]: null,
  [K.OS_UPGRADE]: null,
  [K.NETWORK_BRIDGE_CREATE]: null,
  [K.NETWORK_BRIDGE_DELETE]: null,
  [K.MOUNT_UNMOUNT]: null,
  [K.MOUNT_DELETE]: null,
  [K.CERTIFICATE_ISSUE]: null,
  [K.SELF_UPDATE]: null,
};

/** Throw unless `table` has an entry for each of `kinds` and for nothing else. */
export function assertEveryKindListed(table, kinds) {
  const known = new Set(kinds);
  const missing = kinds.filter((kind) => !Object.hasOwn(table, kind));
  const unknown = Object.keys(table).filter((kind) => !known.has(kind));
  if (missing.length || unknown.length) {
    throw new Error(`SUBJECT_KINDS must list every job kind once: ${[
      missing.length ? `missing ${missing.join(', ')}` : '',
      unknown.length ? `unknown ${unknown.join(', ')}` : '',
    ].filter(Boolean).join('; ')}`);
  }
}

assertEveryKindListed(SUBJECT_KINDS, Object.values(JOB_KIND));
