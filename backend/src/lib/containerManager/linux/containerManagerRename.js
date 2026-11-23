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

import { containerError, containerState, getClient, callUnary } from './containerManagerConnection.js';
import { getContainerDir, getContainerNetnsPath } from './containerPaths.js';
import { getTaskState, cleanupTask } from './containerManagerLifecycle.js';
import { noteIntentionalStop } from './containerManagerRestartState.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { deregisterServicesForContainer } from '../../mdns/index.js';
import { validateContainerName } from './containerValidation.js';
import { teardownNetwork } from './containerManagerNetwork.js';
import { assertContainerNameAvailable } from './containerManagerCreate.js';
import { SNAPSHOTTER } from './containerManagerSnapshot.js';

async function ensureStopped(name) {
  // A restart-policy restart pending under the old name must not fire mid-rename.
  noteIntentionalStop(name);
  const task = await getTaskState(name);
  if (!task) return;
  const st = task.status;
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

/**
 * Tear down the old name's network: CNI DEL (so the DHCP lease under the old
 * container id is released), then the netns. Stop leaves both in place, and
 * the next start under the new name would otherwise leak them.
 */
async function bestEffortTeardownOldNetwork(name, networkConfig) {
  try {
    await access(getContainerNetnsPath(name));
  } catch {
    /* No netns left under the old name */
    return;
  }
  try {
    await teardownNetwork(name, networkConfig);
  } catch {
    /* best effort: a leaked netns is harmless — the new name gets its own */
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
 *  7. Rewrite container.json with the new name (also fans out config-write
 *     → list cache refresh → SSE push).
 *  8. Best-effort: deregister stale mDNS records and orphan netns.
 *
 * The route layer (PATCH /containers/:name) is responsible for moving any
 * custom-section assignment under the new name after this function returns
 * — sections are Wisp app glue, not a containerManager concern.
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
  await assertContainerNameAvailable(newNameTrim);

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
    }, { deadlineMs: 2 * 60_000 }); // a large rootfs can take a while
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
    try {
      await callUnary(getClient('containers'), 'delete', { id: newNameTrim });
    } catch (rollbackErr) {
      containerState.logger?.warn?.({ err: rollbackErr, container: newNameTrim }, 'Rename rollback: could not delete the new containerd record');
    }
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
    } catch (rollbackErr) {
      containerState.logger?.warn?.({ err: rollbackErr, container: oldName }, 'Rename rollback: could not recreate the old containerd record');
    }
    throw containerError(
      'CONTAINERD_ERROR',
      `Failed to move container directory for "${oldName}" → "${newNameTrim}"`,
      err.message,
    );
  }

  /* Step 7: rewrite container.json under the new path with the updated name.
   * writeContainerConfig fires notifyContainerConfigWrite, which refreshes
   * the container list cache and pushes container-list subscribers. */
  const nextConfig = { ...config, name: newNameTrim };
  await writeContainerConfig(newNameTrim, nextConfig);

  /* Step 8: best-effort cleanup of stale services + netns under the old name.
   * SRV/TXT services are managed by containerManager — clean them defensively
   * in case a previous stop crashed mid-flight. The A record under oldName is
   * Wisp glue's to withdraw, after this returns. */
  try {
    await deregisterServicesForContainer(oldName);
  } catch (err) {
    containerState.logger?.warn?.({ err, container: oldName }, 'Rename: could not withdraw the services announced under the old name');
  }
  await bestEffortTeardownOldNetwork(oldName, config.network);

  return { name: newNameTrim };
}
