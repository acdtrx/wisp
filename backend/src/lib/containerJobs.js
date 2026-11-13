/**
 * Container operations that run as server jobs (Wisp glue, like
 * containerOperationLock.js): shared by the REST routes and the MCP tools so
 * both answer the same checks the same way. Each starter checks synchronously
 * — the container's operation lock (409 CONTAINER_BUSY), not found, already
 * running / not running — and throws those; only the work runs in the job,
 * which holds the lock until it ends. Returns `{ jobId, title }`.
 */
import {
  assertContainerState,
  startContainer,
  stopContainer,
  restartContainer,
  deleteContainer,
} from './containerManager/index.js';
import { acquireContainerOperationLock } from './containerOperationLock.js';
import { unpublishContainer } from './containerMdnsReconciler.js';
import { forgetBackupStatus } from './backupStatus.js';
import {
  operationJobStore,
  BACKGROUND_JOB_KIND,
  titleForContainerStart,
  titleForContainerStop,
  titleForContainerRestart,
  titleForContainerDelete,
} from './jobs/index.js';

/**
 * Take `name`'s operation lock, run the synchronous `check`, then start the
 * job; `run` gets the progress reporter and runs under the lock.
 */
export async function startLockedContainerJob({ name, operation, check, kind, title, log, run }) {
  const release = acquireContainerOperationLock(name, operation);
  try {
    await check();
  } catch (err) {
    release();
    throw err;
  }
  return operationJobStore.startOperationJob({
    kind,
    title,
    log,
    run: async (report) => {
      try {
        return await run(report);
      } finally {
        release();
      }
    },
  });
}

const LIFECYCLE = {
  start: { kind: BACKGROUND_JOB_KIND.CONTAINER_START, title: titleForContainerStart, check: 'start' },
  stop: { kind: BACKGROUND_JOB_KIND.CONTAINER_STOP, title: titleForContainerStop, check: 'stop' },
  restart: { kind: BACKGROUND_JOB_KIND.CONTAINER_RESTART, title: titleForContainerRestart, check: 'exists' },
};

/**
 * Start, stop or restart `name` as a job. `done`: `{ name }`, and for a stop
 * `restartCancelled` (a pending restart-policy restart it cancelled).
 * @param {{ name: string, action: 'start' | 'stop' | 'restart', log?: object }} opts
 */
export function startContainerLifecycleJob({ name, action, log }) {
  const spec = LIFECYCLE[action];
  return startLockedContainerJob({
    name,
    operation: action,
    check: () => assertContainerState(name, spec.check),
    kind: spec.kind,
    title: spec.title(name),
    log,
    run: async () => {
      if (action === 'start') await startContainer(name);
      else if (action === 'restart') await restartContainer(name);
      else return { name, restartCancelled: (await stopContainer(name)).restartCancelled };
      return { name };
    },
  });
}

/** Delete `name` (and its files unless `deleteFiles` is false) as a job. `done`: `{ name }`. */
export function startContainerDeleteJob({ name, deleteFiles = true, log }) {
  return startLockedContainerJob({
    name,
    operation: 'delete',
    check: () => assertContainerState(name, 'exists'),
    kind: BACKGROUND_JOB_KIND.CONTAINER_DELETE,
    title: titleForContainerDelete(name),
    log,
    run: async () => {
      // Drop the mDNS A-record before tearing down the container so the name
      // doesn't keep resolving to a vanishing IP. Services are deregistered
      // inside deleteContainer.
      try { await unpublishContainer(name); } catch { /* best effort */ }
      await deleteContainer(name, deleteFiles);
      await forgetBackupStatus({ kind: 'container', name });
      return { name };
    },
  });
}
