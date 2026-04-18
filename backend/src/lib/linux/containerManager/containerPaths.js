/**
 * Path helpers for container storage.
 * Containers live under /var/lib/wisp/containers/<name>/
 */
import { join } from 'node:path';
import { access, mkdir } from 'node:fs/promises';
import { getConfigSync } from '../../config.js';

const DEFAULT_CONTAINERS_PATH = '/var/lib/wisp/containers';

export function getContainersPath() {
  const config = getConfigSync();
  return config.containersPath || DEFAULT_CONTAINERS_PATH;
}

export function getContainerDir(name) {
  return join(getContainersPath(), name);
}

export function getContainerFilesDir(name) {
  return join(getContainersPath(), name, 'files');
}

/** Directory for `ip netns` bind mounts (must match system `/var/run/netns`). */
export const CONTAINER_NETNS_DIR = '/var/run/netns';

/** Path to the bind mount `ip netns` creates (`ip netns add <name>`). Used by CNI and OCI `linux.namespaces`. */
export function getContainerNetnsPath(name) {
  return join(CONTAINER_NETNS_DIR, name);
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
