/**
 * Row-scoped container bind mount CRUD (add / update / remove one mount).
 */
import { join } from 'node:path';
import { rename } from 'node:fs/promises';

import { containerError } from './containerManagerConnection.js';
import { getContainerFilesDir } from './containerPaths.js';
import { getTaskState } from './containerManagerLifecycle.js';
import {
  validateAndNormalizeMounts,
  validateMountSegmentName,
  validateSubPath,
  validateOwnerId,
  validateTmpfsSizeMiB,
  ensureMissingMountArtifacts,
  TMPFS_MAX_SIZE_MIB,
} from './containerManagerMounts.js';
import { deleteMountBackingStore } from './containerManagerMountsContent.js';
import { getRawMounts } from '../../settings.js';
import { readContainerConfig as loadContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';

const RESTART_WHEN_RUNNING = true;

function taskIsRunning(task) {
  return task && (task.status === 'RUNNING' || task.status === 'PAUSED');
}

/**
 * Append one mount, create backing artifact. Returns { requiresRestart }.
 * @param {string} containerName
 * @param {{ type: string, name: string, containerPath: string, readonly?: boolean, sourceId?: string|null, subPath?: string }} mountDef
 */
export async function addContainerMount(containerName, mountDef) {
  const storageMounts = await getRawMounts();
  const [normalized] = validateAndNormalizeMounts([mountDef], storageMounts);
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
  const requiresRestart = isRunning && RESTART_WHEN_RUNNING;
  if (requiresRestart) config.pendingRestart = true;
  await writeContainerConfig(containerName, config);
  await ensureMissingMountArtifacts(containerName, [normalized]);
  return { requiresRestart };
}

/**
 * Update one mount by current storage key (name). Optional rename moves files/<old> to files/<new>
 * (Local mounts only — Storage mounts use the name purely as a config key).
 * @param {string} containerName
 * @param {string} mountName - current mount name in config
 * @param {{ name?: string, containerPath?: string, readonly?: boolean, sourceId?: string|null, subPath?: string }} changes
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

  // tmpfs: only name, containerPath, sizeMiB are mutable. Reject changes to fields that
  // don't apply (sourceId/subPath/readonly/containerOwnerUid/Gid) explicitly so misuse surfaces.
  if (list[idx].type === 'tmpfs') {
    const cur = list[idx];
    const forbidden = ['sourceId', 'subPath', 'readonly', 'containerOwnerUid', 'containerOwnerGid'];
    for (const k of forbidden) {
      if (Object.prototype.hasOwnProperty.call(changes, k)) {
        const v = changes[k];
        const isEmpty = v === undefined || v === null || v === '' || v === 0 || v === false;
        if (!isEmpty) {
          throw containerError('INVALID_CONTAINER_MOUNTS', `${k} is not applicable to tmpfs mounts`);
        }
      }
    }
    let nextName = cur.name;
    if (changes.name !== undefined) {
      const seg = validateMountSegmentName(changes.name);
      if (!seg) throw containerError('INVALID_CONTAINER_MOUNTS', 'Invalid mount name');
      nextName = seg;
    }
    let nextPath = cur.containerPath;
    if (changes.containerPath !== undefined) {
      const cp = typeof changes.containerPath === 'string' ? changes.containerPath.trim() : '';
      if (!cp.startsWith('/') || cp.length < 2) {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'containerPath must be an absolute path');
      }
      nextPath = cp;
    }
    let nextSize = Number.isInteger(cur.sizeMiB) ? cur.sizeMiB : null;
    if (Object.prototype.hasOwnProperty.call(changes, 'sizeMiB')) {
      const v = validateTmpfsSizeMiB(changes.sizeMiB);
      if (v === null) {
        throw containerError(
          'INVALID_CONTAINER_MOUNTS',
          `sizeMiB must be an integer in [1, ${TMPFS_MAX_SIZE_MIB}]`,
        );
      }
      nextSize = v;
    }

    const other = list.filter((_, i) => i !== idx);
    if (other.some((m) => m.name === nextName)) {
      throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate mount name "${nextName}"`);
    }
    if (other.some((m) => m.containerPath === nextPath)) {
      throw containerError('CONTAINER_MOUNT_DUPLICATE', `Duplicate container path "${nextPath}"`);
    }

    const updated = { type: 'tmpfs', name: nextName, containerPath: nextPath, sizeMiB: nextSize };
    const unchanged =
      updated.name === cur.name
      && updated.containerPath === cur.containerPath
      && updated.sizeMiB === cur.sizeMiB;
    if (unchanged) return { requiresRestart: false };

    list[idx] = updated;
    config.mounts = list;
    const task = await getTaskState(containerName);
    const isRunning = taskIsRunning(task);
    const requiresRestart = isRunning && RESTART_WHEN_RUNNING;
    if (requiresRestart) config.pendingRestart = true;
    await writeContainerConfig(containerName, config);
    return { requiresRestart };
  }

  const current = {
    ...list[idx],
    sourceId: list[idx].sourceId || null,
    subPath: list[idx].subPath || '',
    containerOwnerUid: Number.isInteger(list[idx].containerOwnerUid) ? list[idx].containerOwnerUid : 0,
    containerOwnerGid: Number.isInteger(list[idx].containerOwnerGid) ? list[idx].containerOwnerGid : 0,
  };
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

  let nextSourceId = current.sourceId;
  let nextSubPath = current.subPath;
  const sourceIdProvided = Object.prototype.hasOwnProperty.call(changes, 'sourceId');
  if (sourceIdProvided) {
    if (changes.sourceId === null || changes.sourceId === '' || changes.sourceId === undefined) {
      nextSourceId = null;
      nextSubPath = '';
    } else if (typeof changes.sourceId === 'string' && changes.sourceId.trim()) {
      if (current.type !== 'directory') {
        throw containerError('INVALID_CONTAINER_MOUNTS', 'sourceId is only allowed on directory mounts');
      }
      const storageMounts = await getRawMounts();
      const sid = changes.sourceId.trim();
      if (!storageMounts.some((m) => m.id === sid)) {
        throw containerError('INVALID_CONTAINER_MOUNTS', `sourceId "${sid}" does not reference a configured storage mount`);
      }
      nextSourceId = sid;
    } else {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'sourceId must be a non-empty string or null');
    }
  }
  if (changes.subPath !== undefined && nextSourceId) {
    const normalizedSub = validateSubPath(changes.subPath);
    if (normalizedSub === null) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'subPath must be relative and must not contain ".." segments');
    }
    nextSubPath = normalizedSub;
  }
  if (!nextSourceId) {
    nextSubPath = '';
  }

  let nextOwnerUid = current.containerOwnerUid;
  if (changes.containerOwnerUid !== undefined) {
    const v = validateOwnerId(changes.containerOwnerUid);
    if (v === null) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'containerOwnerUid must be an integer in [0, 65535]');
    }
    nextOwnerUid = v;
  }
  let nextOwnerGid = current.containerOwnerGid;
  if (changes.containerOwnerGid !== undefined) {
    const v = validateOwnerId(changes.containerOwnerGid);
    if (v === null) {
      throw containerError('INVALID_CONTAINER_MOUNTS', 'containerOwnerGid must be an integer in [0, 65535]');
    }
    nextOwnerGid = v;
  }

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
    sourceId: nextSourceId,
    subPath: nextSubPath,
    containerOwnerUid: nextOwnerUid,
    containerOwnerGid: nextOwnerGid,
  };

  const unchanged =
    updated.name === current.name
    && updated.containerPath === current.containerPath
    && updated.readonly === current.readonly
    && updated.sourceId === current.sourceId
    && updated.subPath === current.subPath
    && updated.containerOwnerUid === current.containerOwnerUid
    && updated.containerOwnerGid === current.containerOwnerGid;
  if (unchanged) {
    return { requiresRestart: false };
  }

  /* Switching a Local mount to Storage: drop the now-unused local files/<name> backing store so we
   * don't leave stale data behind. Switching the other direction: leave external data in place. */
  if (!current.sourceId && updated.sourceId) {
    await deleteMountBackingStore(containerName, current);
  }

  /* Rename on disk only applies to Local mounts — Storage-backed names are just config keys. */
  if (!updated.sourceId && nextName !== current.name) {
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
  const requiresRestart = isRunning && RESTART_WHEN_RUNNING;
  if (requiresRestart) config.pendingRestart = true;
  await writeContainerConfig(containerName, config);
  if (!updated.sourceId && nextName === current.name) {
    await ensureMissingMountArtifacts(containerName, [updated]);
  }
  return { requiresRestart };
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
  if (!removed.sourceId && removed.type !== 'tmpfs') {
    /* Storage-sourced mounts reference user data outside the container dir — leave it alone.
     * tmpfs mounts have no host backing at all. */
    await deleteMountBackingStore(containerName, removed);
  }
  list.splice(idx, 1);
  config.mounts = list;
  const task = await getTaskState(containerName);
  const isRunning = taskIsRunning(task);
  const requiresRestart = isRunning && RESTART_WHEN_RUNNING;
  if (requiresRestart) config.pendingRestart = true;
  await writeContainerConfig(containerName, config);
  return { requiresRestart };
}
