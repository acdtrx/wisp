/**
 * Container bind mount definitions: validation and bind-source checks.
 */
import { basename, join, resolve } from 'node:path';
import { mkdir, stat, writeFile } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerFilesDir } from './containerPaths.js';

/**
 * @param {string} name
 * @returns {string|null} normalized segment or null if invalid
 */
export function validateMountSegmentName(name) {
  if (!name || typeof name !== 'string') return null;
  const t = name.trim();
  if (t.includes('/') || t.includes('\\') || t.includes('..')) return null;
  if (t.startsWith('.')) return null;
  if (t !== basename(t)) return null;
  return t;
}

/**
 * Validate and normalize mounts for persistence. Rejects duplicate name or containerPath.
 * @param {unknown} mounts
 * @returns {{ type: 'file'|'directory', name: string, containerPath: string, readonly: boolean }[]}
 */
export function validateAndNormalizeMounts(mounts) {
  if (!Array.isArray(mounts)) {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'mounts must be an array');
  }
  const names = new Set();
  const containerPaths = new Set();
  const out = [];
  for (const raw of mounts) {
    if (!raw || typeof raw !== 'object') {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'Each mount must be an object');
    }
    const type = raw.type;
    if (type !== 'file' && type !== 'directory') {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'Mount type must be "file" or "directory"');
    }
    const seg = validateMountSegmentName(raw.name);
    if (!seg) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'Invalid mount name');
    }
    const containerPath = typeof raw.containerPath === 'string' ? raw.containerPath.trim() : '';
    if (!containerPath.startsWith('/') || containerPath.length < 2) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'containerPath must be an absolute path');
    }
    if (names.has(seg)) {
      throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate mount name "${seg}"`);
    }
    names.add(seg);
    if (containerPaths.has(containerPath)) {
      throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate container path "${containerPath}"`);
    }
    containerPaths.add(containerPath);
    out.push({
      type,
      name: seg,
      containerPath,
      readonly: raw.readonly === true,
    });
  }
  return out;
}

/**
 * @param {object} config - container.json
 * @param {string} mountName
 * @returns {{ type: string, name: string, containerPath: string, readonly: boolean } | null}
 */
export function findMount(config, mountName) {
  const list = config.mounts;
  if (!Array.isArray(list)) return null;
  return list.find((m) => m.name === mountName) ?? null;
}

/**
 * Create an empty file or directory for a mount if the artifact path is missing.
 * @param {string} containerName
 * @param {{ type: string, name: string }} mountEntry
 */
export async function ensureMountArtifactIfMissing(containerName, mountEntry) {
  const filesDir = getContainerFilesDir(containerName);
  await mkdir(filesDir, { recursive: true });
  const root = resolve(filesDir);
  const hostPath = resolve(join(filesDir, mountEntry.name));
  if (!hostPath.startsWith(root + '/') && hostPath !== root) {
    throw containerError('CONTAINERD_ERROR', `Invalid mount path for "${mountEntry.name}"`);
  }
  try {
    await stat(hostPath);
    return;
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (mountEntry.type === 'file') {
    await writeFile(hostPath, Buffer.alloc(0));
  } else {
    await mkdir(hostPath, { recursive: true });
  }
}

/**
 * @param {string} containerName
 * @param {{ type: string, name: string }[]} mounts
 */
export async function ensureMissingMountArtifacts(containerName, mounts) {
  if (!Array.isArray(mounts) || mounts.length === 0) return;
  for (const m of mounts) {
    await ensureMountArtifactIfMissing(containerName, m);
  }
}

/**
 * Ensure each mount's backing path exists under files/ and matches type (before task create).
 * Missing artifacts are created (empty file or empty directory) automatically.
 * @param {string} containerName
 * @param {object} config
 * @param {string} filesDir - absolute path to container files/
 */
export async function assertBindSourcesReady(containerName, config, filesDir) {
  const list = config.mounts;
  if (!Array.isArray(list) || list.length === 0) return;
  const root = resolve(filesDir);
  for (const m of list) {
    const hostPath = resolve(join(filesDir, m.name));
    if (!hostPath.startsWith(root + '/') && hostPath !== root) {
      throw containerError('CONTAINERD_ERROR', `Invalid mount path for "${m.name}"`);
    }
    try {
      const s = await stat(hostPath);
      if (m.type === 'file' && !s.isFile()) {
        throw containerError(
          'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
          `Mount "${m.name}" must be backed by a file on the host`,
        );
      }
      if (m.type === 'directory' && !s.isDirectory()) {
        throw containerError(
          'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
          `Mount "${m.name}" must be backed by a directory on the host`,
        );
      }
    } catch (err) {
      if (typeof err?.code === 'string' && err.code.startsWith('CONTAINER_')) throw err;
      if (err?.code === 'ENOENT') {
        await ensureMountArtifactIfMissing(containerName, m);
        const s = await stat(hostPath);
        if (m.type === 'file' && !s.isFile()) {
          throw containerError(
            'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
            `Mount "${m.name}" must be backed by a file on the host`,
          );
        }
        if (m.type === 'directory' && !s.isDirectory()) {
          throw containerError(
            'CONTAINER_MOUNT_SOURCE_WRONG_TYPE',
            `Mount "${m.name}" must be backed by a directory on the host`,
          );
        }
        continue;
      }
      throw err;
    }
  }
}
