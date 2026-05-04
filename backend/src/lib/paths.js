import { join, resolve, sep } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { getConfigSync } from './config.js';
import { createAppError } from './routeErrors.js';

/**
 * Base directory for a VM's files: <vmsPath>/<name>/
 * All VM-owned files (disk, cloud-init ISO, NVRAM, config) live here.
 * vmsPath comes from wisp-config.json (or env WISP_CONFIG_PATH).
 */
export function getVMBasePath(name) {
  const { vmsPath } = getConfigSync();
  return join(vmsPath, name);
}

/**
 * Base directory for the image library (ISOs, disk images).
 * Comes from wisp-config.json.
 */
export function getImagePath() {
  const { imagePath } = getConfigSync();
  return imagePath;
}

/**
 * Ensure the image library directory exists (create if missing).
 */
export async function ensureImageDir() {
  const dir = getImagePath();
  try {
    await access(dir);
  } catch {
    /* directory missing — create it */
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Resolve a maybe-relative path against the image library, returning an absolute path.
 * Used by routes when accepting user input that can be either a basename ("ubuntu.iso")
 * or an absolute path. Does not validate — pair with assertPathInsideAllowedRoots.
 */
export function resolveLibraryPath(p) {
  if (typeof p !== 'string' || !p) return p;
  return p.startsWith('/') ? p : join(getImagePath(), p);
}

/**
 * Defense-in-depth check for VM attach/create paths supplied by API callers
 * (libvirt happily opens any host file QEMU has access to as a block/CDROM
 * device, so "/etc/shadow" would be a host-file-read primitive). Resolves
 * absPath and asserts it lives under the image library or this VM's own
 * per-VM directory. Throws PATH_NOT_ALLOWED (mapped to 422) otherwise.
 *
 * Lives here (Wisp app glue) rather than inside vmManager because the
 * "allowed roots" are Wisp policy — a reusable vmManager has no opinion on
 * which host paths a deployment considers safe.
 */
export function assertPathInsideAllowedRoots(absPath, vmName) {
  if (typeof absPath !== 'string' || !absPath.startsWith('/')) {
    throw createAppError('PATH_NOT_ALLOWED', 'Path must be an absolute path');
  }
  const resolved = resolve(absPath);
  const allowedRoots = [resolve(getImagePath()), resolve(getVMBasePath(vmName))];
  const allowed = allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + sep),
  );
  if (!allowed) {
    throw createAppError(
      'PATH_NOT_ALLOWED',
      `Path must be under the image library or this VM's directory: ${absPath}`,
    );
  }
}
