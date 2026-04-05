/**
 * SMB mount/unmount via privileged wisp-smb script (same pattern as wisp-os-update).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, writeFile, unlink, rm, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppError } from '../../routeErrors.js';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = '/usr/local/bin/wisp-smb';

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
      'wisp-smb script not found or not readable',
      err.message
    );
  }
}

/**
 * Mount an SMB share. Writes a temp config file (0600), invokes wisp-smb mount <path>, then removes temp file.
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
  const scriptPath = await getScriptPath();
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
    const isRoot = process.getuid && process.getuid() === 0;
    if (isRoot) {
      await execFileAsync(scriptPath, ['mount', configPath], { timeout: 30000 });
    } else {
      await execFileAsync('sudo', ['-n', scriptPath, 'mount', configPath], { timeout: 30000 });
    }
  } finally {
    await unlink(configPath).catch(() => {
      /* temp file may already be removed */
    });
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* temp dir cleanup */
    });
  }
}

/**
 * Test SMB connection by mounting to a temp path then unmounting. Uses wisp-smb check.
 * @param {string} share - e.g. //server/share
 * @param {{ username?: string, password?: string }} options
 */
export async function checkSMBConnection(share, { username, password } = {}) {
  if (!share || typeof share !== 'string' || !share.trim()) {
    throw createAppError('SMB_INVALID', 'Share is required', 'share required');
  }
  const scriptPath = await getScriptPath();
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
    const isRoot = process.getuid && process.getuid() === 0;
    if (isRoot) {
      await execFileAsync(scriptPath, ['check', configPath], { timeout: 30000 });
    } else {
      await execFileAsync('sudo', ['-n', scriptPath, 'check', configPath], { timeout: 30000 });
    }
  } finally {
    await unlink(configPath).catch(() => {
      /* temp file may already be removed */
    });
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* temp dir cleanup */
    });
  }
}

/**
 * Unmount an SMB share at the given path.
 */
export async function unmountSMB(mountPath) {
  if (!mountPath || !mountPath.startsWith('/')) {
    throw createAppError('SMB_INVALID', 'Invalid mountPath', 'mountPath must be absolute');
  }

  const scriptPath = await getScriptPath();
  const isRoot = process.getuid && process.getuid() === 0;
  try {
    if (isRoot) {
      await execFileAsync(scriptPath, ['unmount', mountPath], { timeout: 10000 });
    } else {
      await execFileAsync('sudo', ['-n', scriptPath, 'unmount', mountPath], { timeout: 10000 });
    }
  } catch (err) {
    const safeMsg = sanitizeStderr(err.stderr || err.message);
    throw createAppError(UNAVAILABLE, `SMB unmount failed: ${safeMsg}`, safeMsg);
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
