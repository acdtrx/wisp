/**
 * Container operations that run as server jobs (Wisp glue): shared by the
 * REST routes and the MCP tools so both answer the same checks the same way.
 * The job starter holds the container's operation lock for the job's life
 * (busy is a 409 CONTAINER_BUSY at once); not found and already running / not
 * running are checked under it, before the job exists. Each returns the
 * job's ack.
 */
import {
  assertContainerState,
  startContainer,
  stopContainer,
  restartContainer,
  deleteContainer,
} from './containerManager/index.js';
import { unpublishContainer } from './containerMdnsReconciler.js';
import { forgetBackupStatus } from './backupStatus.js';
import {
  startJob,
  BACKGROUND_JOB_KIND,
  titleForContainerStart,
  titleForContainerStop,
  titleForContainerRestart,
  titleForContainerDelete,
} from './jobs/index.js';

const LIFECYCLE = {
  start: { kind: BACKGROUND_JOB_KIND.CONTAINER_START, title: titleForContainerStart, check: 'start' },
  stop: { kind: BACKGROUND_JOB_KIND.CONTAINER_STOP, title: titleForContainerStop, check: 'stop' },
  restart: { kind: BACKGROUND_JOB_KIND.CONTAINER_RESTART, title: titleForContainerRestart, check: 'exists' },
};

/**
 * Start, stop or restart `name` as a job. `done`: `{ name }`, and for a stop
 * `restartCancelled` (a pending restart-policy restart it cancelled).
 * @param {{ name: string, action: 'start' | 'stop' | 'restart', log: object }} opts
 */
export function startContainerLifecycleJob({ name, action, log }) {
  const spec = LIFECYCLE[action];
  return startJob({
    kind: spec.kind,
    title: spec.title(name),
    subject: { type: 'container', name },
    check: () => assertContainerState(name, spec.check),
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
  return startJob({
    kind: BACKGROUND_JOB_KIND.CONTAINER_DELETE,
    title: titleForContainerDelete(name),
    subject: { type: 'container', name },
    check: () => assertContainerState(name, 'exists'),
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
