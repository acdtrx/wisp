/**
 * containerManager-internal path helpers + storage-mount resolver slot.
 *
 * Pushed in via `containerManager.configure({ containersPath, resolveMount })` during boot.
 * Replaces former imports of `lib/config.js` (containersPath) and `lib/settings.js`
 * (getRawMounts) so containerManager carries no Wisp policy dependencies
 * (precondition for eventual lib extraction).
 */
import { join, resolve, sep } from 'node:path';
import { access, mkdir } from 'node:fs/promises';

import { containerError } from '../containerManagerShared.js';

let containersPath = null;
let resolveMountFn = null;

export function setContainerManagerConfig(cfg) {
  if (!cfg || typeof cfg.containersPath !== 'string' || !cfg.containersPath.startsWith('/')) {
    throw new Error('containerManager.configure: containersPath must be an absolute path');
  }
  if (typeof cfg.resolveMount !== 'function') {
    throw new Error('containerManager.configure: resolveMount must be a function (id) => null | { id, mountPath, label? }');
  }
  containersPath = cfg.containersPath;
  resolveMountFn = cfg.resolveMount;
}

function requireConfigured() {
  if (containersPath === null || resolveMountFn === null) {
    throw new Error('containerManager not configured — call containerManager.configure() during boot');
  }
}

export function getContainersPath() {
  requireConfigured();
  return containersPath;
}

/**
 * `root` joined with `segments` (a name, a timestamp, a file name), checked
 * to stay below `root`: a segment that is absolute, holds a separator that
 * climbs out, or is `..` is refused (PATH_NOT_ALLOWED). Every path this
 * manager builds from a name it was given goes through here, so a caller
 * that skips the route's schema (the scheduler, MCP) cannot leave the root.
 */
export function pathUnder(root, ...segments) {
  const base = resolve(root);
  const full = resolve(base, ...segments);
  if (!full.startsWith(base + sep)) {
    throw containerError('PATH_NOT_ALLOWED', `"${segments.join('/')}" would leave its directory`);
  }
  return full;
}

export function getContainerDir(name) {
  return pathUnder(getContainersPath(), name);
}

export function getContainerFilesDir(name) {
  return join(getContainerDir(name), 'files');
}

export function getContainerRunsDir(name) {
  return join(getContainerDir(name), 'runs');
}

export function getRunLogPath(name, runId) {
  return pathUnder(getContainerRunsDir(name), `${runId}.log`);
}

export function getRunMetaPath(name, runId) {
  return pathUnder(getContainerRunsDir(name), `${runId}.json`);
}

/** Subdirectory under each backup root that holds container backups
 * (`<root>/containers/<name>/<timestamp>/`), beside VM backups under `vms/`. */
export const CONTAINERS_BACKUP_DIRNAME = 'containers';

/** Filesystem-safe ISO timestamp: 2026-04-18T12-34-56-789Z (colons replaced with hyphens). */
export const RUN_ID_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** Directory for `ip netns` bind mounts (must match system `/var/run/netns`). */
export const CONTAINER_NETNS_DIR = '/var/run/netns';

/** Path to the bind mount `ip netns` creates (`ip netns add <name>`). Used by CNI and OCI `linux.namespaces`. */
export function getContainerNetnsPath(name) {
  return pathUnder(CONTAINER_NETNS_DIR, name);
}

export async function ensureContainersDir() {
  const dir = getContainersPath();
  try {
    await access(dir);
  } catch {
    /* Path does not exist yet — create containers root */
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Resolve a storage-mount id to its host path. Returns null if the id
 * doesn't match any configured mount. The resolver is supplied by Wisp glue
 * via configure(); it closes over `getRawMounts()` from settings.
 *
 * @param {string} id
 * @returns {{ id: string, mountPath: string, label?: string } | null}
 */
export function resolveMount(id) {
  requireConfigured();
  if (typeof id !== 'string' || !id) return null;
  return resolveMountFn(id);
}
