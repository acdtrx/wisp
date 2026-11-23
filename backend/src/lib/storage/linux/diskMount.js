/**
 * Removable/fixed disk mount via `wisp-mount disk` helper. Same invocation pattern as smbMount.
 */
import { createAppError } from '../../appErrors.js';
import { runWispMount } from './wispMountHelper.js';

/*
 * Each ends after the helper's own worst case (docs/specs/STORAGE.md,
 * Timeouts), its commands' kill graces included: a mount's mkdir (10 s) and
 * mount (20 s); an unmount's 60 s, long enough to flush after a large backup.
 */
const MOUNT_TIMEOUT_MS = 40_000;
const UNMOUNT_TIMEOUT_MS = 75_000;

const UNAVAILABLE = 'DISK_MOUNT_UNAVAILABLE';

const SUPPORTED_FSTYPES = new Set(['ext4', 'btrfs', 'vfat', 'exfat', 'ntfs3']);

/** In-process lock per mount path. */
const mountLocks = new Map();

function sanitizeStderr(msg) {
  if (!msg || typeof msg !== 'string') return msg || '';
  return msg.trim();
}

/**
 * Reject characters that have load-bearing meaning in the wisp-mount config
 * file format (line-oriented `key=value`). Newlines/CR would inject extra
 * keys; we conservatively reject commas too to stay symmetrical with smbMount.
 */
function assertNoForbiddenChars(field, value) {
  if (value == null) return;
  if (typeof value !== 'string') {
    throw createAppError('DISK_MOUNT_INVALID', `${field} must be a string`);
  }
  if (/[\n\r,]/.test(value)) {
    throw createAppError('DISK_MOUNT_INVALID', `${field} cannot contain newlines or commas`);
  }
}

/**
 * Mount a filesystem by UUID at mountPath.
 * @param {string} uuid
 * @param {string} mountPath
 * @param {{ fsType: string, readOnly?: boolean }} options
 */
export async function mountDisk(uuid, mountPath, { fsType, readOnly = false } = {}) {
  if (!uuid || typeof uuid !== 'string' || !mountPath || !mountPath.startsWith('/')) {
    throw createAppError('DISK_MOUNT_INVALID', 'Invalid uuid or mountPath', 'uuid and absolute mountPath required');
  }
  if (!SUPPORTED_FSTYPES.has(fsType)) {
    throw createAppError('DISK_MOUNT_INVALID', `Unsupported fsType "${fsType}"`, 'fsType must be one of ext4/btrfs/vfat/exfat/ntfs3');
  }

  const key = `${uuid}:${mountPath}`;
  const lock = mountLocks.get(key) ?? Promise.resolve();
  const next = lock.then(() => _mountDisk(uuid, mountPath, { fsType, readOnly }));
  mountLocks.set(
    key,
    next.catch(() => {
      /* lock chain must not reject */
    }),
  );
  return next;
}

async function _mountDisk(uuid, mountPath, { fsType, readOnly }) {
  assertNoForbiddenChars('uuid', uuid);
  assertNoForbiddenChars('mountPath', mountPath);
  assertNoForbiddenChars('fsType', fsType);

  const access = readOnly || fsType === 'ntfs3' ? 'ro' : 'rw';
  try {
    await runWispMount(['disk-mount', uuid, mountPath, fsType, access], MOUNT_TIMEOUT_MS, UNAVAILABLE);
  } catch (err) {
    if (err.code === UNAVAILABLE) throw err;
    const safeMsg = sanitizeStderr(err.detail ?? err.message);
    throw createAppError(UNAVAILABLE, `Disk mount failed: ${safeMsg}`, safeMsg);
  }
}

/**
 * Unmount a mounted path. When { lazy: true }, uses `umount -l` (for surprise-removed devices).
 * When { ignoreNotMounted: true }, swallows "not mounted" errors so delete flows don't fail
 * when the mount was already cleaned up.
 */
export async function unmountDisk(mountPath, { lazy = false, ignoreNotMounted = false } = {}) {
  if (!mountPath || !mountPath.startsWith('/')) {
    throw createAppError('DISK_MOUNT_INVALID', 'Invalid mountPath', 'mountPath must be absolute');
  }
  try {
    await runWispMount([lazy ? 'unmount-lazy' : 'unmount', mountPath], UNMOUNT_TIMEOUT_MS, UNAVAILABLE);
  } catch (err) {
    if (ignoreNotMounted && err.reason === 'not-found') return;
    if (err.code === UNAVAILABLE) throw err;
    const safeMsg = sanitizeStderr(err.detail ?? err.message);
    throw createAppError(UNAVAILABLE, `Unmount failed: ${safeMsg}`, safeMsg);
  }
}
