/**
 * SMB mount/unmount via the unified wisp-mount helper (subcommand `smb`).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, writeFile, unlink, rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppError } from '../../routeErrors.js';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = '/usr/local/bin/wisp-mount';

const UNAVAILABLE = 'SMB_MOUNT_UNAVAILABLE';

/** In-process lock per mount path to avoid concurrent mount races for the same share. */
const mountLocks = new Map();

function sanitizeStderr(msg) {
  if (!msg || typeof msg !== 'string') return msg || '';
  return msg.replace(/password\s*=\s*\S+/gi, 'password=***');
}

function escapeShellValue(v) {
  if (v == null) return '';
  const s = String(v);
  return s.replace(/'/g, "'\"'\"'");
}

async function getScriptPath() {
  try {
    await access(SCRIPT_PATH);
    return SCRIPT_PATH;
  } catch (err) {
    throw createAppError(
      UNAVAILABLE,
      'wisp-mount script not found or not readable',
      err.message
    );
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
 * Mount an SMB share.
 * @param {string} share - e.g. //server/share
 * @param {string} mountPath - e.g. /mnt/wisp/smb-nas
 * @param {{ username?: string, password?: string }} options
 */
export async function mountSMB(share, mountPath, { username, password } = {}) {
  if (!share || typeof share !== 'string' || !mountPath || !mountPath.startsWith('/')) {
    throw createAppError('SMB_INVALID', 'Invalid share or mountPath', 'share and mountPath (absolute) required');
  }

  const key = `${share}:${mountPath}`;
  let lock = mountLocks.get(key) ?? Promise.resolve();
  const next = lock.then(() => _mountSMB(share, mountPath, { username, password }));
  mountLocks.set(
    key,
    next.catch(() => {
      /* lock chain must not reject — failure surfaced from returned next */
    })
  );
  return next;
}

async function _mountSMB(share, mountPath, { username, password } = {}) {
  const oldMask = process.umask(0o077);
  const tmpDir = await mkdtemp(join(tmpdir(), 'wisp-smb-'));
  process.umask(oldMask);
  const configPath = join(tmpDir, 'smb.conf');
  const uid = process.getuid && process.getuid();
  const gid = process.getgid && process.getgid();
  const lines = [
    `share='${escapeShellValue(share)}'`,
    `mountPath='${escapeShellValue(mountPath)}'`,
    `username='${escapeShellValue(username)}'`,
    `password='${escapeShellValue(password)}'`,
    ...(typeof uid === 'number' ? [`uid=${uid}`] : []),
    ...(typeof gid === 'number' ? [`gid=${gid}`] : []),
  ];
  await writeFile(configPath, lines.join('\n'), { mode: 0o600 });

  try {
    await runHelper(['smb', 'mount', configPath]);
  } finally {
    await unlink(configPath).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
  const oldMask = process.umask(0o077);
  const tmpDir = await mkdtemp(join(tmpdir(), 'wisp-smb-'));
  process.umask(oldMask);
  const tempMountPath = `/mnt/wisp/smb-check-${Date.now()}`;
  const configPath = join(tmpDir, 'smb.conf');
  const uid = process.getuid && process.getuid();
  const gid = process.getgid && process.getgid();
  const lines = [
    `share='${escapeShellValue(share.trim())}'`,
    `mountPath='${tempMountPath}'`,
    `username='${escapeShellValue(username)}'`,
    `password='${escapeShellValue(password)}'`,
    ...(typeof uid === 'number' ? [`uid=${uid}`] : []),
    ...(typeof gid === 'number' ? [`gid=${gid}`] : []),
  ];
  await writeFile(configPath, lines.join('\n'), { mode: 0o600 });
  try {
    await runHelper(['smb', 'check', configPath]);
  } finally {
    await unlink(configPath).catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
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
    await runHelper([lazy ? 'unmount-lazy' : 'unmount', mountPath], { timeout: 10000 });
  } catch (err) {
    const rawMsg = String(err.stderr || err.message || '');
    if (ignoreNotMounted && /not mounted|no such file|not found/i.test(rawMsg)) return;
    const safeMsg = sanitizeStderr(rawMsg);
    throw createAppError(UNAVAILABLE, `Unmount failed: ${safeMsg}`, safeMsg);
  }
}

/**
 * Remove an empty mount point directory under /mnt/wisp/. Used only by the delete flow;
 * regular unmount leaves the directory in place. Silently ignores missing or non-empty dirs.
 */
export async function rmdirMountpoint(mountPath) {
  if (!mountPath || !mountPath.startsWith('/mnt/wisp/')) return;
  try {
    await runHelper(['rmdir', mountPath], { timeout: 5000 });
  } catch (err) {
    /* rmdir is best-effort — log via thrown error only if caller wants it, otherwise swallow */
    throw createAppError(UNAVAILABLE, `rmdir failed: ${sanitizeStderr(err.stderr || err.message)}`);
  }
}

/**
 * Check if a path is currently mounted. Reads /proc/mounts (no privilege needed).
 */
export async function getMountStatus(mountPath) {
  if (!mountPath || !mountPath.startsWith('/')) return { mounted: false };
  try {
    const content = await readFile('/proc/mounts', 'utf8');
    const normalized = mountPath.replace(/\/+$/, '') || '/';
    const lines = content.split('\n');
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const mount = parts[1];
        if (mount === normalized || mount === mountPath || (mountPath.startsWith(mount + '/') && mount !== '/')) {
          return { mounted: true };
        }
      }
    }
  } catch {
    /* /proc/mounts unreadable — assume not mounted */
  }
  return { mounted: false };
}
