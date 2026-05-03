/**
 * Rename a stopped container.
 *
 * The container name is the containerd container ID and the on-disk directory
 * key under containersPath. containerd has no Rename API, so a rename is:
 * Containers.Delete(old) → Containers.Create(new) → fs.rename(old → new). The
 * rootfs snapshot is ephemeral (rebuilt from the image on every start — see
 * `startExistingContainer`), so any old snapshot is dropped at rename time and
 * the next start re-prepares it under the new key. State persists only through
 * bind mounts, which travel with the directory move.
 */
import { rename, access } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { containerError, getClient, callUnary } from './containerManagerConnection.js';
import { getContainerDir, getContainerNetnsPath } from './containerPaths.js';
import { getTaskState, normalizeTaskStatus, cleanupTask } from './containerManagerLifecycle.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { deregisterAddress, deregisterServicesForContainer } from '../../mdns/index.js';
import { validateContainerName } from '../../validation.js';
import { renameWorkloadAssignment } from '../../sections.js';

const execFile = promisify(execFileCb);
const SNAPSHOTTER = 'overlayfs';

async function ensureNewNameFree(newName) {
  try {
    await access(getContainerDir(newName));
    throw containerError(
      'CONTAINER_EXISTS',
      `Container directory for "${newName}" already exists`,
    );
  } catch (err) {
    if (err.code === 'CONTAINER_EXISTS') throw err;
    /* ENOENT — directory does not exist, good */
  }

  try {
    await callUnary(getClient('containers'), 'get', { id: newName });
    throw containerError(
      'CONTAINER_EXISTS',
      `Container "${newName}" already exists in containerd`,
    );
  } catch (err) {
    if (err.code === 'CONTAINER_EXISTS') throw err;
    /* NOT_FOUND in containerd — expected; continue */
  }
}

async function ensureStopped(name) {
  const task = await getTaskState(name);
  if (!task) return;
  const st = normalizeTaskStatus(task.status);
  if (st === 'STOPPED') {
    /* Dangling task record from a previous run — finalize it before rename
     * so Containers.Delete doesn't fail with "task must be deleted first". */
    await cleanupTask(name);
    return;
  }
  throw containerError(
    'CONTAINER_MUST_BE_STOPPED',
    `Container "${name}" must be stopped before rename (current state: ${st.toLowerCase()})`,
  );
}

async function bestEffortRemoveOrphanNetns(name) {
  const nsPath = getContainerNetnsPath(name);
  try {
    await access(nsPath);
  } catch {
    /* No orphan netns to remove */
    return;
  }
  /* Reuse wisp-netns helper via sudo; ignore errors (the netns will leak
   * harmlessly if cleanup fails — next start under the new name will
   * create a fresh one at a different path). */
  try {
    await execFile('sudo', ['-n', '/usr/local/bin/wisp-netns', 'delete', name], {
      timeout: 8000,
    });
  } catch {
    /* best effort */
  }
}

/**
 * Rename a stopped container.
 *
 * Order of operations:
 *  1. Validate new name and preconditions (no task, new name unused).
 *  2. Capture old containerd record for rollback.
 *  3. Containers.Delete(old).
 *  4. Snapshots.Remove(old) — best-effort; ephemeral rootfs means the
 *     snapshot is recreated on next start anyway.
 *  5. Containers.Create(new) using the captured runtime/spec/labels.
 *  6. fs.rename old dir → new dir.
 *  7. Move any custom-section assignment (settings.assignments). The
 *     frontend reads sections from /api/sections, not from the list SSE,
 *     so order vs. step 8 is not load-bearing — but doing it before
 *     step 8 keeps disk state consistent before any config-write fanout.
 *  8. Rewrite container.json with the new name (also fans out config-write
 *     → list cache refresh → SSE push).
 *  9. Best-effort: deregister stale mDNS records and orphan netns.
 *
 * Rollback on partial failure between steps 3–6 recreates the old containerd
 * container from the captured record so the user can retry.
 */
export async function renameContainer(oldName, newName) {
  if (typeof newName !== 'string') {
    throw containerError('INVALID_CONTAINER_NAME', 'New container name is required');
  }
  const newNameTrim = newName.trim();
  validateContainerName(newNameTrim);

  if (newNameTrim === oldName) {
    throw containerError(
      'INVALID_CONTAINER_NAME',
      'New container name must be different from the current name',
    );
  }

  /* Read old container.json first — surfaces CONTAINER_NOT_FOUND cleanly. */
  const config = await readContainerConfig(oldName);

  await ensureStopped(oldName);
  await ensureNewNameFree(newNameTrim);

  const captured = await callUnary(getClient('containers'), 'get', { id: oldName });
  const oldRecord = captured.container;
  if (!oldRecord) {
    throw containerError(
      'CONTAINER_NOT_FOUND',
      `Container "${oldName}" not found in containerd`,
    );
  }

  /* Step 3: delete old containerd container record. */
  await callUnary(getClient('containers'), 'delete', { id: oldName });

  /* Step 4: drop the old snapshot — best effort. The snapshot is ephemeral;
   * `startExistingContainer` removes and re-prepares it on every start. */
  try {
    await callUnary(getClient('snapshots'), 'remove', {
      snapshotter: SNAPSHOTTER,
      key: oldName,
    });
  } catch {
    /* No snapshot to remove (never started, or already gone) */
  }

  /* Step 5: create new containerd container. Pass through the captured spec
   * Any verbatim — it's regenerated on next start anyway, but keeping it
   * means anything that reads the container record between rename and start
   * sees a valid spec. */
  try {
    await callUnary(getClient('containers'), 'create', {
      container: {
        id: newNameTrim,
        image: oldRecord.image,
        runtime: oldRecord.runtime,
        spec: oldRecord.spec,
        snapshotter: oldRecord.snapshotter || SNAPSHOTTER,
        snapshotKey: newNameTrim,
        labels: oldRecord.labels || { 'wisp.managed': 'true' },
      },
    });
  } catch (err) {
    /* Recreate the old containerd record so the user can retry. */
    try {
      await callUnary(getClient('containers'), 'create', {
        container: {
          id: oldName,
          image: oldRecord.image,
          runtime: oldRecord.runtime,
          spec: oldRecord.spec,
          snapshotter: oldRecord.snapshotter || SNAPSHOTTER,
          snapshotKey: oldName,
          labels: oldRecord.labels || { 'wisp.managed': 'true' },
        },
      });
    } catch {
      /* Rollback failed — the user must recreate the container. The on-disk
       * config and files are still intact under the old name. */
    }
    throw containerError(
      'CONTAINERD_ERROR',
      `Failed to create new container record for "${newNameTrim}"`,
      err.raw || err.message,
    );
  }

  /* Step 6: move the on-disk directory. */
  try {
    await rename(getContainerDir(oldName), getContainerDir(newNameTrim));
  } catch (err) {
    /* Roll back the containerd state: drop the new container, recreate old. */
    try { await callUnary(getClient('containers'), 'delete', { id: newNameTrim }); } catch { /* best effort */ }
    try {
      await callUnary(getClient('containers'), 'create', {
        container: {
          id: oldName,
          image: oldRecord.image,
          runtime: oldRecord.runtime,
          spec: oldRecord.spec,
          snapshotter: oldRecord.snapshotter || SNAPSHOTTER,
          snapshotKey: oldName,
          labels: oldRecord.labels || { 'wisp.managed': 'true' },
        },
      });
    } catch { /* best effort */ }
    throw containerError(
      'CONTAINERD_ERROR',
      `Failed to move container directory for "${oldName}" → "${newNameTrim}"`,
      err.message,
    );
  }

  /* Step 7: move any custom-section assignment so the container keeps its
   * sidebar section after rename. Best-effort — assignments are pure UI
   * metadata. The frontend reads sections from /api/sections (mirrored into
   * sectionsStore), so the renamed container picks up its section the next
   * time the client refetches that endpoint. */
  try { await renameWorkloadAssignment('container', oldName, newNameTrim); } catch { /* best effort */ }

  /* Step 8: rewrite container.json under the new path with the updated name.
   * writeContainerConfig fires notifyContainerConfigWrite, which refreshes
   * the container list cache and pushes /containers/stream subscribers. */
  const nextConfig = { ...config, name: newNameTrim };
  await writeContainerConfig(newNameTrim, nextConfig);

  /* Step 9: best-effort cleanup of stale mDNS + netns under the old name.
   * mDNS should already be deregistered (stopContainer deregisters on stop),
   * but call defensively in case a previous stop crashed mid-flight. */
  try { await deregisterServicesForContainer(oldName); } catch { /* best effort */ }
  try { await deregisterAddress(oldName); } catch { /* best effort */ }
  await bestEffortRemoveOrphanNetns(oldName);

  return { name: newNameTrim };
}
