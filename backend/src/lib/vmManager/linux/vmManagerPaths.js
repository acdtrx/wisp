/**
 * vmManager-internal path helpers.
 *
 * Pushed in via `vmManager.configure({ vmsPath })` during boot. Replaces the
 * former `lib/paths.js`/`lib/config.js` reach-arounds, so vmManager carries
 * no Wisp policy dependencies (precondition for eventual lib extraction).
 *
 * Scope is narrow on purpose: vmManager only needs the VM root to compute its
 * own per-VM dirs. The image-library root and the user-input path security
 * gate (`assertPathInsideAllowedRoots`) are Wisp policy and live in
 * `lib/paths.js` — routes resolve+validate before handing absolute paths to
 * vmManager.
 */
import { resolve, sep } from 'node:path';

import { vmError } from '../vmManagerShared.js';

/** Subdirectory under each backup root that holds VM backups
 * (`<root>/vms/<vmName>/<timestamp>/`), beside container backups under `containers/`. */
export const VMS_BACKUP_DIRNAME = 'vms';

let vmsPath = null;

export function setVmManagerPaths(cfg) {
  if (!cfg || typeof cfg.vmsPath !== 'string' || !cfg.vmsPath.startsWith('/')) {
    throw new Error('vmManager.configure: vmsPath must be an absolute path');
  }
  vmsPath = cfg.vmsPath;
}

function requireConfigured() {
  if (vmsPath === null) {
    throw new Error('vmManager not configured — call vmManager.configure() during boot');
  }
}

export function getVmsPath() {
  requireConfigured();
  return vmsPath;
}

/**
 * `root` joined with `segments` (a name, a timestamp, a file name), each one
 * path segment: an empty one, `.`, `..`, or one holding `/` or NUL is refused
 * (PATH_NOT_ALLOWED), and so is a result not below `root`. Every path this
 * manager builds from a name it was given goes through here, so a caller
 * that skips the route's schema (the scheduler, MCP) cannot leave the
 * directory a segment is joined into, nor land in a sibling's.
 */
export function pathUnder(root, ...segments) {
  for (const segment of segments) {
    if (typeof segment !== 'string' || segment === '' || segment === '.' || segment === '..'
      || segment.includes('/') || segment.includes('\0')) {
      throw vmError('PATH_NOT_ALLOWED', `${JSON.stringify(segment)} is not one path segment`);
    }
  }
  const base = resolve(root);
  const full = resolve(base, ...segments);
  if (!full.startsWith(base + sep)) {
    throw vmError('PATH_NOT_ALLOWED', `"${segments.join('/')}" would leave its directory`);
  }
  return full;
}

export function getVMBasePath(name) {
  requireConfigured();
  return pathUnder(vmsPath, name);
}
