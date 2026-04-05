/**
 * Row-scoped container bind mount CRUD (add / update / remove one mount).
 */
import { join } from 'node:path';
import { readFile, writeFile, rename } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerDir, getContainerFilesDir } from './containerPaths.js';
import { getTaskState } from './containerManagerLifecycle.js';
import {
  validateAndNormalizeMounts,
  validateMountSegmentName,
  ensureMissingMountArtifacts,
} from './containerManagerMounts.js';
import { deleteMountBackingStore } from './containerManagerMountsContent.js';

const RESTART_WHEN_RUNNING = true;

async function loadContainerConfig(containerName) {
  const configPath = join(getContainerDir(containerName), 'container.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container "${containerName}" not found`);
  }
  return config;
}

async function writeContainerConfig(containerName, config) {
  const configPath = join(getContainerDir(containerName), 'container.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
}

function taskIsRunning(task) {
  return task && (task.status === 'RUNNING' || task.status === 'PAUSED');
}

/**
 * Append one mount, create backing artifact. Returns { requiresRestart }.
 * @param {string} containerName
 * @param {{ type: string, name: string, containerPath: string, readonly?: boolean }} mountDef
 */
export async function addContainerMount(containerName, mountDef) {
  const [normalized] = validateAndNormalizeMounts([mountDef]);
  const config = await loadContainerConfig(containerName);
  const list = Array.isArray(config.mounts) ? [...config.mounts] : [];
  const names = new Set(list.map((m) => m.name));
  const paths = new Set(list.map((m) => m.containerPath));
  if (names.has(normalized.name)) {
    throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate mount name "${normalized.name}"`);
  }
  if (paths.has(normalized.containerPath)) {
    throw containerError(
      'CONTAINER_MOUNT_DUPLICATE',
      `Duplicate container path "${normalized.containerPath}"`,
    );
  }
  list.push(normalized);
  config.mounts = list;
  const task = await getTaskState(containerName);
  const isRunning = taskIsRunning(task);
  await writeContainerConfig(containerName, config);
  await ensureMissingMountArtifacts(containerName, [normalized]);
  return { requiresRestart: isRunning && RESTART_WHEN_RUNNING };
}

/**
 * Update one mount by current storage key (name). Optional rename moves files/<old> to files/<new>.
 * @param {string} containerName
 * @param {string} mountName - current mount name in config
 * @param {{ name?: string, containerPath?: string, readonly?: boolean }} changes
 */
export async function updateContainerMount(containerName, mountName, changes) {
  if (!changes || typeof changes !== 'object') {
    throw containerError('INVALID_CONTAINER_MOUNTS', 'changes must be an object');
  }
  const config = await loadContainerConfig(containerName);
  const list = Array.isArray(config.mounts) ? [...config.mounts] : [];
  const idx = list.findIndex((m) => m.name === mountName);
  if (idx < 0) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  const current = { ...list[idx] };
  let nextName = current.name;
  if (changes.name !== undefined) {
    const seg = validateMountSegmentName(changes.name);
    if (!seg) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'Invalid mount name');
    }
    nextName = seg;
  }
  let nextPath = current.containerPath;
  if (changes.containerPath !== undefined) {
    const cp = typeof changes.containerPath === 'string' ? changes.containerPath.trim() : '';
    if (!cp.startsWith('/') || cp.length < 2) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'containerPath must be an absolute path');
    }
    nextPath = cp;
  }
  const nextReadonly = changes.readonly !== undefined ? changes.readonly === true : current.readonly;

  const other = list.filter((_, i) => i !== idx);
  if (other.some((m) => m.name === nextName)) {
    throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate mount name "${nextName}"`);
  }
  if (other.some((m) => m.containerPath === nextPath)) {
    throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate container path "${nextPath}"`);
  }

  const updated = {
    type: current.type,
    name: nextName,
    containerPath: nextPath,
    readonly: nextReadonly,
  };

  if (
    updated.name === current.name
    && updated.containerPath === current.containerPath
    && updated.readonly === current.readonly
  ) {
    return { requiresRestart: false };
  }

  if (nextName !== current.name) {
    const filesDir = getContainerFilesDir(containerName);
    const oldPath = join(filesDir, current.name);
    const newPath = join(filesDir, nextName);
    try {
      await rename(oldPath, newPath);
    } catch (err) {
      if (err?.code === 'ENOENT') {
        await ensureMissingMountArtifacts(containerName, [updated]);
      } else {
        throw err;
      }
    }
  }

  list[idx] = updated;
  config.mounts = list;
  const task = await getTaskState(containerName);
  const isRunning = taskIsRunning(task);
  await writeContainerConfig(containerName, config);
  if (nextName === current.name) {
    await ensureMissingMountArtifacts(containerName, [updated]);
  }
  return { requiresRestart: isRunning && RESTART_WHEN_RUNNING };
}

/**
 * Remove one mount and delete its backing store under files/.
 * @param {string} containerName
 * @param {string} mountName
 */
export async function removeContainerMount(containerName, mountName) {
  const config = await loadContainerConfig(containerName);
  const list = Array.isArray(config.mounts) ? [...config.mounts] : [];
  const idx = list.findIndex((m) => m.name === mountName);
  if (idx < 0) {
    throw containerError('CONTAINER_MOUNT_NOT_FOUND', `No mount named "${mountName}"`);
  }
  const removed = list[idx];
  await deleteMountBackingStore(containerName, removed);
  list.splice(idx, 1);
  config.mounts = list;
  const task = await getTaskState(containerName);
  const isRunning = taskIsRunning(task);
  await writeContainerConfig(containerName, config);
  return { requiresRestart: isRunning && RESTART_WHEN_RUNNING };
}
