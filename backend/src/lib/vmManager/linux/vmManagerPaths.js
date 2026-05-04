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
import { join } from 'node:path';

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

export function getVMBasePath(name) {
  requireConfigured();
  return join(vmsPath, name);
}
