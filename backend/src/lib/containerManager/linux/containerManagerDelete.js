/**
 * Deleting a container: its task, services, network, snapshot, containerd
 * record and folder.
 */
import { join } from 'node:path';
import { access, rm, readdir } from 'node:fs/promises';

import {
  containerError, containerState, getClient, callUnary, isWispError, wrapContainerError,
} from './containerManagerConnection.js';
import { getContainerDir, getContainerFilesDir, getContainerNetnsPath } from './containerPaths.js';
import { releaseNetworkLease, removeContainerNetns } from './containerManagerNetwork.js';
import { getTaskState, isTaskOn, waitForStop } from './containerManagerLifecycle.js';
import { noteIntentionalStop } from './containerManagerRestartState.js';
import { deregisterServicesForContainer } from '../../mdns/index.js';
import { readContainerConfig, notifyContainerConfigWrite } from './containerManagerConfigIo.js';
import { SNAPSHOTTER, SNAPSHOT_REMOVE_DEADLINE_MS } from './containerManagerSnapshot.js';

/**
 * Remove a container's folder: everything, or with `deleteFiles` false
 * everything but `files/` (the folder goes too when `files/` is empty).
 * `container.json` goes last, so a removal that fails leaves the container
 * listed and its delete can be run again.
 */
async function removeContainerFolder(name, deleteFiles) {
  const containerDir = getContainerDir(name);
  let entries;
  try {
    entries = await readdir(containerDir);
  } catch (err) {
    if (err?.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    if (entry === 'container.json' || (!deleteFiles && entry === 'files')) continue;
    await rm(join(containerDir, entry), { recursive: true, force: true });
  }
  await rm(join(containerDir, 'container.json'), { force: true });
  let kept = [];
  if (!deleteFiles) {
    try {
      kept = await readdir(getContainerFilesDir(name));
    } catch (err) {
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  if (kept.length === 0) await rm(containerDir, { recursive: true, force: true });
}

function pathExists(path) {
  return access(path).then(() => true, () => false /* a path access refuses is not there for this check */);
}

/** containerd's answer for an object that is not there: for a delete, already done. */
async function unlessGone(promise) {
  try {
    await promise;
  } catch (err) {
    if (err.code !== 'CONTAINER_NOT_FOUND') throw err;
  }
}

/**
 * Delete a container: stop its task, withdraw its services, tear down its
 * network, remove its snapshot and its containerd record, then its files (or,
 * with deleteFiles false, everything but files/). A step that fails stops the
 * delete there and names itself; what it would have removed, and everything
 * after it, stays — the container is still listed, and a second delete carries
 * on, since each step takes "not there" as done. A network lease that cannot
 * be released is the exception: the rest runs, and the delete ends as
 * CONTAINER_DELETE_INCOMPLETE naming it.
 */
export async function deleteContainer(name, deleteFiles = true) {
  const step = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      throw wrapContainerError(isWispError(err) ? err.code : 'INTERNAL_ERROR', `Could not delete container "${name}": ${what} failed`, err);
    }
  };

  noteIntentionalStop(name);
  await step('stopping its task', async () => {
    const task = await getTaskState(name);
    if (!task) return;
    if (isTaskOn(task)) {
      noteIntentionalStop(name, task.pid);
      await unlessGone(callUnary(getClient('tasks'), 'kill', { containerId: name, signal: 9, all: true }));
      if (!(await waitForStop(name, 15000))) {
        throw containerError('CONTAINERD_ERROR', `Container "${name}" did not stop within 15 s of being killed`);
      }
    }
    await unlessGone(callUnary(getClient('tasks'), 'delete', { containerId: name }));
  });
  /* Services (SRV/TXT) are deregistered here after the task is gone so we
   * never have a window where a service resolves to a tearing-down container.
   * The A record is Wisp glue's to withdraw. */
  await deregisterServicesForContainer(name);

  // A lease that cannot be released (the CNI DHCP daemon down) does not stop
  // the delete: the netns goes, the rest runs, and the delete ends saying so.
  let leaseError = null;
  await step('tearing down its network', async () => {
    if (!(await pathExists(getContainerNetnsPath(name)))) return;
    const config = await readContainerConfig(name);
    try {
      await releaseNetworkLease(name, config.network);
    } catch (err) {
      leaseError = err;
    }
    await removeContainerNetns(name);
  });

  await step('removing its snapshot', () => unlessGone(callUnary(
    getClient('snapshots'), 'remove', { snapshotter: SNAPSHOTTER, key: name }, { deadlineMs: SNAPSHOT_REMOVE_DEADLINE_MS },
  )));

  await step('removing it from containerd', () => unlessGone(callUnary(getClient('containers'), 'delete', { id: name })));

  containerState.containerStartTimes.delete(name);

  try {
    await step(`removing its folder ${getContainerDir(name)}`, () => removeContainerFolder(name, deleteFiles));
  } finally {
    // The earlier containerd /containers/delete event already triggered a cache
    // refresh while container.json was still on disk: read the list again now
    // that the folder is gone, or partly gone.
    notifyContainerConfigWrite(name);
  }

  if (leaseError) {
    throw wrapContainerError(
      'CONTAINER_DELETE_INCOMPLETE',
      `Container "${name}" was deleted, but its network lease was not released`,
      leaseError,
    );
  }
}
