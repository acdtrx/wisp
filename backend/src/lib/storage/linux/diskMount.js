/**
 * Removable/fixed disk mount via `wisp-mount disk` helper. Same invocation pattern as smbMount.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, writeFile, unlink, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppError } from '../../routeErrors.js';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = '/usr/local/bin/wisp-mount';
const UNAVAILABLE = 'DISK_MOUNT_UNAVAILABLE';

const SUPPORTED_FSTYPES = new Set(['ext4', 'btrfs', 'vfat', 'exfat', 'ntfs3']);

/** In-process lock per mount path. */
const mountLocks = new Map();

function sanitizeStderr(msg) {
  if (!msg || typeof msg !== 'string') return msg || '';
  return msg;
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

async function getScriptPath() {
  try {
    await access(SCRIPT_PATH);
    return SCRIPT_PATH;
  } catch (err) {
    throw createAppError(UNAVAILABLE, 'wisp-mount script not found or not readable', err.message);
  }
}

async function runHelper(args, { timeout = 30000 } = {}) {
  const scriptPath = await getScriptPath();
  const isRoot = process.getuid && process.getuid() === 0;
  const cmd = isRoot ? scriptPath : 'sudo';
  const cmdArgs = isRoot ? args : ['-n', scriptPath, ...args];
  return execFileAsync(cmd, cmdArgs, { timeout });
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

  /* mkdtemp's `mode: 0o700` plus per-file `mode: 0o600` writes are enough; we
   * deliberately do NOT touch process.umask, which is process-global and would
   * race with concurrent file-create sites elsewhere. */
  const tmpDir = await mkdtemp(join(tmpdir(), 'wisp-disk-'), { mode: 0o700 });
  const configPath = join(tmpDir, 'disk.conf');
  const uid = process.getuid && process.getuid();
  const gid = process.getgid && process.getgid();
  const effectiveReadOnly = readOnly || fsType === 'ntfs3';
  const lines = [
    `uuid=${uuid}`,
    `mountPath=${mountPath}`,
    `fsType=${fsType}`,
    `readOnly=${effectiveReadOnly ? '1' : '0'}`,
    ...(typeof uid === 'number' ? [`uid=${uid}`] : []),
    ...(typeof gid === 'number' ? [`gid=${gid}`] : []),
  ];
  await writeFile(configPath, `${lines.join('\n')}\n`, { mode: 0o600 });

  try {
    await runHelper(['disk', 'mount', configPath]);
  } catch (err) {
    const safeMsg = sanitizeStderr(err.stderr || err.message);
    throw createAppError(UNAVAILABLE, `Disk mount failed: ${safeMsg}`, safeMsg);
  } finally {
    await unlink(configPath).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
    await runHelper([lazy ? 'unmount-lazy' : 'unmount', mountPath], { timeout: 10000 });
  } catch (err) {
    const rawMsg = String(err.stderr || err.message || '');
    if (ignoreNotMounted && /not mounted|no such file|not found/i.test(rawMsg)) return;
    const safeMsg = sanitizeStderr(rawMsg);
    throw createAppError(UNAVAILABLE, `Unmount failed: ${safeMsg}`, safeMsg);
  }
}
