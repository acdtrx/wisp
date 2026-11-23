/**
 * SMB mount/unmount via the unified wisp-mount helper (subcommand `smb`).
 */
import { writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppError } from '../../appErrors.js';
import { isMountPoint } from '../mountTable.js';
import { runWispMount } from './wispMountHelper.js';

/*
 * Each ends after the helper's own worst case (docs/specs/STORAGE.md,
 * Timeouts), each of its commands with 2 s to end: a mount's credentials
 * owner read (10 s), mkdir (10 s) and mount (20 s); a check's owner read,
 * mkdir, mount (15 s), umount (8 s) and rmdir (10 s); an unmount's 60 s, long
 * enough to flush after a large backup; an rmdir's 10 s.
 */
const MOUNT_TIMEOUT_MS = 50_000;
const CHECK_TIMEOUT_MS = 70_000;
const UNMOUNT_TIMEOUT_MS = 75_000;
const RMDIR_TIMEOUT_MS = 15_000;


const UNAVAILABLE = 'SMB_MOUNT_UNAVAILABLE';

/** In-process lock per mount path to avoid concurrent mount races for the same share. */
const mountLocks = new Map();

function sanitizeStderr(msg) {
  if (!msg || typeof msg !== 'string') return msg || '';
  return msg.replace(/password\s*=\s*\S+/gi, 'password=***').trim();
}

/**
 * Reject characters that have load-bearing meaning in either the wisp-mount
 * config file format (which is line-oriented `key=value`) or in mount.cifs
 * credentials files (`username=` / `password=` / `domain=` lines).
 *
 * Newlines/CR would create extra config keys; commas would have appeared as
 * extra `mount -o` options under the prior argv-based scheme and remain
 * reserved here for safety. The caller surfaces SMB_INVALID to the operator.
 */
function assertNoForbiddenChars(field, value) {
  if (value == null) return;
  if (typeof value !== 'string') {
    throw createAppError('SMB_INVALID', `${field} must be a string`);
  }
  if (/[\n\r,]/.test(value)) {
    throw createAppError(
      'SMB_INVALID',
      `${field} cannot contain newlines or commas`,
    );
  }
}

/**
 * The helper's credentials argument, and the file behind it: `guest` with no
 * username and no password; otherwise a file in mount.cifs's format (one
 * `key=value` per line) with the username and always a `password=` line, empty
 * when none was given, so mount.cifs never asks for one. Mode 0600, in a 0700
 * folder of its own; the caller removes the folder once the helper returned
 * (mount.cifs reads the file at once). The password never crosses argv. The
 * modes are set at creation: process.umask is process-global, and would race
 * with other file-create sites.
 * @returns {Promise<{ credentials: string, dir: string | null }>}
 */
async function credentialsArg({ username, password }) {
  const hasUser = username != null && username !== '';
  const hasPassword = password != null && password !== '';
  if (!hasUser && !hasPassword) return { credentials: 'guest', dir: null };
  const dir = await mkdtemp(join(tmpdir(), 'wisp-smb-'), { mode: 0o700 });
  const file = join(dir, 'credentials');
  const lines = [...(hasUser ? [`username=${username}`] : []), `password=${hasPassword ? password : ''}`];
  await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return { credentials: file, dir };
}

/** A failed helper run as SMB_MOUNT_UNAVAILABLE, the helper's error line as the cause, credentials masked. */
function helperFailure(message, err) {
  if (err?.code === UNAVAILABLE) return err;
  return createAppError(UNAVAILABLE, message, sanitizeStderr(err?.detail ?? err?.message));
}

/**
 * Mount an SMB share.
 * @param {string} share - e.g. //server/share
 * @param {string} mountPath - e.g. /mnt/wisp/smb-nas
 * @param {{ username?: string, password?: string, ownerOnly?: boolean }} options
 *   ownerOnly: mount with file mode 0600 / dir mode 0700 (the backup destination —
 *   CIFS without Unix extensions ignores chmod, so the mount sets the modes)
 */
export async function mountSMB(share, mountPath, { username, password, ownerOnly = false } = {}) {
  if (!share || typeof share !== 'string' || !mountPath || !mountPath.startsWith('/')) {
    throw createAppError('SMB_INVALID', 'Invalid share or mountPath', 'share and mountPath (absolute) required');
  }

  const key = `${share}:${mountPath}`;
  let lock = mountLocks.get(key) ?? Promise.resolve();
  const next = lock.then(() => _mountSMB(share, mountPath, { username, password, ownerOnly }));
  mountLocks.set(
    key,
    next.catch(() => {
      /* lock chain must not reject — failure surfaced from returned next */
    })
  );
  return next;
}

async function _mountSMB(share, mountPath, { username, password, ownerOnly } = {}) {
  assertNoForbiddenChars('share', share);
  assertNoForbiddenChars('mountPath', mountPath);
  assertNoForbiddenChars('username', username);
  assertNoForbiddenChars('password', password);

  const { credentials, dir } = await credentialsArg({ username, password });
  try {
    await runWispMount(['smb-mount', share, mountPath, credentials, ownerOnly ? 'owner-only' : 'shared'], MOUNT_TIMEOUT_MS, UNAVAILABLE);
  } catch (err) {
    throw helperFailure(`Failed to mount ${share}`, err);
  } finally {
    /* Best-effort: the folder may be gone already */
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Test SMB connection by mounting to a temp path then unmounting. Uses wisp-mount smb check.
 * @param {string} share - e.g. //server/share
 * @param {{ username?: string, password?: string }} options
 */
export async function checkSMBConnection(share, { username, password } = {}) {
  if (!share || typeof share !== 'string' || !share.trim()) {
    throw createAppError('SMB_INVALID', 'Share is required', 'share required');
  }
  const trimmedShare = share.trim();
  assertNoForbiddenChars('share', trimmedShare);
  assertNoForbiddenChars('username', username);
  assertNoForbiddenChars('password', password);

  const tempMountPath = `/mnt/wisp/smb-check-${Date.now()}`;
  const { credentials, dir } = await credentialsArg({ username, password });
  try {
    await runWispMount(['smb-check', trimmedShare, tempMountPath, credentials], CHECK_TIMEOUT_MS, UNAVAILABLE);
  } catch (err) {
    throw helperFailure(`Could not connect to ${trimmedShare}`, err);
  } finally {
    /* Best-effort: the folder may be gone already */
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Unmount at the given path. When { lazy: true }, uses `umount -l` (safe after surprise removal).
 * When { ignoreNotMounted: true }, swallows "not mounted" errors so delete flows don't fail
 * when the mount was already cleaned up.
 */
export async function unmountSMB(mountPath, { lazy = false, ignoreNotMounted = false } = {}) {
  if (!mountPath || !mountPath.startsWith('/')) {
    throw createAppError('SMB_INVALID', 'Invalid mountPath', 'mountPath must be absolute');
  }
  try {
    await runWispMount([lazy ? 'unmount-lazy' : 'unmount', mountPath], UNMOUNT_TIMEOUT_MS, UNAVAILABLE);
  } catch (err) {
    if (ignoreNotMounted && err.reason === 'not-found') return;
    if (err.code === UNAVAILABLE) throw err;
    throw createAppError(UNAVAILABLE, `Unmount of ${mountPath} failed (${err.reason ?? 'error'})`, sanitizeStderr(err.detail ?? err.message));
  }
}

/**
 * Remove an empty mount point directory under /mnt/wisp/. Used only by the delete flow;
 * regular unmount leaves the directory in place. A folder that is not there is
 * nothing to do; one not empty or still mounted throws.
 */
export async function rmdirMountpoint(mountPath) {
  if (!mountPath || !mountPath.startsWith('/mnt/wisp/')) return;
  try {
    await runWispMount(['rmdir', mountPath], RMDIR_TIMEOUT_MS, UNAVAILABLE);
  } catch (err) {
    if (err.reason === 'not-found') return;
    if (err.code === UNAVAILABLE) throw err;
    throw createAppError(UNAVAILABLE, `Failed to remove mount point ${mountPath}`, sanitizeStderr(err.detail ?? err.message));
  }
}

/**
 * Check if something is mounted exactly at `mountPath` (a mount on a parent
 * directory does not count). Reads the kernel mount table; no privilege needed.
 */
export async function getMountStatus(mountPath) {
  if (!mountPath || !mountPath.startsWith('/')) return { mounted: false };
  return { mounted: isMountPoint(mountPath) };
}
