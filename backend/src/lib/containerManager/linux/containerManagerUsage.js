/**
 * Per-mount host-side disk usage for one container. Read-only companion to
 * the mounts CRUD: resolves each persisted mount's bind source (Local files
 * dir or storage mount) and sizes it with the storage module's walker.
 * Sizes are computed on demand — callers should treat this as a snapshot,
 * not a live feed.
 */
import { readContainerConfig } from './containerManagerConfigIo.js';
import { getContainerFilesDir, resolveMount } from './containerPaths.js';
import { resolveMountHostPath } from './containerManagerMounts.js';
import { measurePathSize } from '../../storage/index.js';

/**
 * @param {string} name
 * @returns {Promise<{ name: string, mounts: Array<{
 *   name: string, containerPath: string, type: string,
 *   source: 'local'|'storage'|'tmpfs'|'missing',
 *   hostPath: string|null, sizeBytes: number|null, partial: boolean
 * }> }>}
 */
export async function getContainerMountUsage(name) {
  const config = await readContainerConfig(name);
  const filesDir = getContainerFilesDir(name);
  const mounts = Array.isArray(config.mounts) ? config.mounts : [];

  const out = [];
  for (const mount of mounts) {
    const base = { name: mount.name, containerPath: mount.containerPath, type: mount.type };
    if (mount.type === 'tmpfs') {
      /* No host backing: contents live in kernel memory for the task lifetime. */
      out.push({ ...base, source: 'tmpfs', hostPath: null, sizeBytes: null, partial: false });
      continue;
    }
    let resolved;
    try {
      resolved = resolveMountHostPath(mount, filesDir, resolveMount);
    } catch {
      /* sourceId points at a storage mount that is no longer configured */
      out.push({ ...base, source: 'missing', hostPath: null, sizeBytes: null, partial: false });
      continue;
    }
    const { sizeBytes, partial } = await measurePathSize(resolved.hostPath);
    out.push({ ...base, source: resolved.source, hostPath: resolved.hostPath, sizeBytes, partial });
  }
  return { name, mounts: out };
}
