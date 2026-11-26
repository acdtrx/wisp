/**
 * Every command that changes a container (app glue): one purpose-named
 * function per command, with its lock and its follow-ups, which the routes,
 * the MCP tools and the backup scheduler call. A job takes the container's
 * operation lock through the job starter (`subject`), for the whole job; an
 * instant command through `withContainerOperationLock`, for the call — the
 * mount content commands for as long as they write into the container's
 * directory (the zip upload as a job, from its first byte to the end of its
 * extract). No route takes a lock itself (docs/specs/CONTAINERS.md →
 * Per-container operation lock).
 *
 * The follow-ups outside the container's own record — its section
 * assignment, its last backup attempt and its `.local` name — are
 * lib/workloadFollowUps.js's, the same as a VM's.
 */
import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  getContainerDir,
  assertContainerState,
  assertContainerNameAvailable,
  listContainers,
  getContainerConfig,
  createContainer,
  startContainer,
  stopContainer,
  restartContainer,
  killContainer,
  deleteContainer,
  renameContainer,
  updateContainerConfig,
  addContainerMount,
  updateContainerMount,
  removeContainerMount,
  addContainerService,
  updateContainerService,
  removeContainerService,
  planMountFileUpload,
  commitMountFileUpload,
  assertMountTakesZip,
  planMountZipExtract,
  extractMountZip,
  assertMountOperation,
  initMountContent,
  deleteMountData,
  deleteRemovedMountData,
  putMountFileTextContent,
  createContainerBackup,
  planContainerBackupRestore,
  restoreContainerBackup,
  restoreContainerBackupInPlace,
  resolveContainerBackupDir,
  pullImage,
  getImageDigest,
  resolveContainerImageRef,
  isLocalImageRef,
} from './containerManager/index.js';
import {
  createAppContainer,
  applyAppConfig,
  eject,
  maskContainerConfigSecrets,
  getAppModule,
  assertMountNotAppManaged,
  assertMountListNotAppManaged,
} from './containerApps/index.js';
import {
  startJob,
  titleForContainerCreate,
  titleForContainerDeploy,
  titleForContainerImageUpdate,
  titleForContainerStart,
  titleForContainerStop,
  titleForContainerRestart,
  titleForContainerDelete,
  titleForContainerBackup,
  titleForContainerRestore,
  titleForContainerRestoreAsNew,
  titleForContainerMountDelete,
  titleForContainerMountDataDelete,
  titleForZipExtract,
} from './jobs/index.js';
import { tryAcquireContainerOperationLock, withContainerOperationLock } from './containerOperationLock.js';
import { getHeldCertificate } from './hostCertificateStore.js';
import { createAppError, isAppError, wrapAppError } from './appErrors.js';
import { resolveBackupDestinations } from './backupDestinations.js';
import { startWorkloadBackupJob, backUpWorkload } from './workloadBackup.js';
import { followContainerConfigUpdate, followWorkloadDelete, followWorkloadRename } from './workloadFollowUps.js';
import { JOB_KIND } from '../../../shared/wireNames.js';

const container = (name) => ({ type: 'container', name });

/** The container's own backup to one destination, for the backup orchestration. */
function containerBackupTo(name, origin) {
  return (dest, onProgress) => createContainerBackup(name, dest.path, { origin, onProgress });
}

/**
 * Write `changes` to container.json, delete the data of the Local mounts it
 * dropped, then the follow-ups. The caller holds the container's lock.
 */
async function applyContainerConfigChanges({ name, changes, log }) {
  if (Object.keys(changes).length > 0) {
    const { removedMounts } = await updateContainerConfig(name, changes);
    // A Local mount dropped from `mounts` loses its data — the same contract as
    // a mount delete. The manager only reports it; deleting is glue's decision
    // (app flows decide their own, inside applyAppConfig).
    for (const mountName of removedMounts) {
      await deleteRemovedMountData(name, mountName);
    }
  }
  await followContainerConfigUpdate({ name, localDns: changes.localDns, log });
}

// ── Create ──────────────────────────────────────────────────────────

/**
 * Create a container (`{ name, image, iconId?, app?, appConfig? }`; an app
 * container through its recipe) as a job holding the new name's lock. It is
 * defined, not started. `done`: `{ name }`.
 */
export function startContainerCreateJob({ spec, log }) {
  const { name } = spec;
  return startJob({
    kind: JOB_KIND.CONTAINER_CREATE,
    title: titleForContainerCreate(name),
    subject: container(name),
    check: () => assertContainerNameAvailable(name),
    log,
    run: async (report) => {
      if (spec.app) {
        await createAppContainer(spec, report, { certificate: await getHeldCertificate() });
      } else {
        await createContainer(spec, report);
      }
      return { name };
    },
  });
}

/**
 * Deploy a container (MCP `deploy_container`): create it from `image` with
 * `env`, apply the settings `changes` as a configuration update — its
 * follow-ups included — and start it, as one job holding the new name's lock.
 * Its `.local` name is published once it runs, by the network-change event,
 * as for any start. A failure after the create says the container now exists,
 * stopped, and keeps the failure's code (INTERNAL_ERROR for one without a
 * code from the table). `done`: the container's config, secrets masked.
 */
export function startContainerDeployJob({ name, image, env, changes, log }) {
  return startJob({
    kind: JOB_KIND.CONTAINER_DEPLOY,
    title: titleForContainerDeploy(name),
    subject: container(name),
    check: () => assertContainerNameAvailable(name),
    log,
    run: async (report) => {
      await createContainer({ name, image, env }, report);
      let failed = 'its settings could not be applied; it exists in stopped state (fix it, then start_container)';
      try {
        await applyContainerConfigChanges({ name, changes, log });
        report({ step: 'starting' });
        failed = 'failed to start; it exists in stopped state (check get_container_logs, or fix and start_container)';
        await startContainer(name);
      } catch (err) {
        throw wrapAppError(isAppError(err) ? err.code : 'INTERNAL_ERROR', `Container "${name}" was created but ${failed}`, err);
      }
      return await maskContainerConfigSecrets(await getContainerConfig(name));
    },
  });
}

/**
 * Point the container at `image` (or re-pull its own) and restart it when it
 * runs, as one job: nothing changes the container between the pull and the
 * restart. `done`: `{ name, image, restarted, applied, note }`.
 */
export async function startContainerImageUpdateJob({ name, image, log }) {
  const cfg = await getContainerConfig(name);
  const requested = typeof image === 'string' && image.trim() ? image.trim() : cfg.image;
  // The ref create and PATCH store: an exact local name when containerd has
  // one, else the normalized ref the pull stores the image under.
  const { ref } = await resolveContainerImageRef(requested);
  return startJob({
    kind: JOB_KIND.CONTAINER_IMAGE_UPDATE,
    title: titleForContainerImageUpdate(name),
    subject: container(name),
    log,
    run: async (report) => {
      if (isLocalImageRef(ref)) {
        // This host's own image: never pulled, used as containerd holds it.
        if (!(await getImageDigest(ref))) {
          throw createAppError('CONTAINER_IMAGE_NOT_FOUND', `No image ${ref} on this host: a localhost/ image is this host's own, and is never pulled`);
        }
      } else {
        report({ step: 'pulling', detail: ref });
        try {
          await pullImage(ref);
        } catch (err) {
          // Locally-imported images have no registry to pull from — fine if present.
          if (!(await getImageDigest(ref))) {
            throw createAppError('IMAGE_PULL_FAILED', `Cannot pull "${ref}" and it is not present locally`, err.message);
          }
        }
      }
      const current = await getContainerConfig(name);
      if (ref !== current.image) await applyContainerConfigChanges({ name, changes: { image: ref }, log });
      const restarted = current.state === 'running';
      if (restarted) await restartContainer(name);
      return {
        name,
        image: ref,
        restarted,
        applied: restarted,
        note: restarted ? 'Restarted on the updated image.' : 'Image updated; takes effect at the next start.',
      };
    },
  });
}

// ── Lifecycle ───────────────────────────────────────────────────────

/** Start a stopped container as a job. `done`: `{ name }`. */
export function startContainerStartJob({ name, log }) {
  return startJob({
    kind: JOB_KIND.CONTAINER_START,
    title: titleForContainerStart(name),
    subject: container(name),
    check: () => assertContainerState(name, 'start'),
    log,
    run: async () => {
      await startContainer(name);
      return { name };
    },
  });
}

/**
 * The grace period of each stop job while it runs, by container: a kill sent
 * meanwhile cuts it short instead of meeting the stop's lock (killContainerNow).
 * @type {Map<string, AbortController>}
 */
const stopGraces = new Map();

/**
 * Stop the container (SIGTERM, then SIGKILL after its grace period) as a job,
 * or cancel its scheduled restart. `done`: `{ name, restartCancelled }`.
 */
export function startContainerStopJob({ name, log }) {
  const grace = new AbortController();
  return startJob({
    kind: JOB_KIND.CONTAINER_STOP,
    title: titleForContainerStop(name),
    subject: container(name),
    check: async () => {
      await assertContainerState(name, 'stop');
      // Last in the check: once it passes, the job exists and its run removes it.
      stopGraces.set(name, grace);
    },
    log,
    run: async () => {
      try {
        const { restartCancelled } = await stopContainer(name, { graceSignal: grace.signal });
        return { name, restartCancelled };
      } finally {
        stopGraces.delete(name);
      }
    },
  });
}

/** Restart the container (stop, then start) as a job. `done`: `{ name }`. */
export function startContainerRestartJob({ name, log }) {
  return startJob({
    kind: JOB_KIND.CONTAINER_RESTART,
    title: titleForContainerRestart(name),
    subject: container(name),
    check: () => assertContainerState(name, 'exists'),
    log,
    run: async () => {
      await restartContainer(name);
      return { name };
    },
  });
}

/**
 * Kill the container (SIGKILL), or cancel its scheduled restart. While a stop
 * job waits out the grace period, the kill is that stop made immediate: the
 * stop job, which holds the lock, kills the task at once and ends as it
 * would — so a kill stays possible during a stop, as a VM's force stop does
 * during a guest shutdown, and only one command acts on the task.
 */
export async function killContainerNow(name) {
  const grace = stopGraces.get(name);
  if (grace) {
    grace.abort();
    return;
  }
  await withContainerOperationLock(name, 'kill', () => killContainer(name));
}

/** Delete the container (its files too unless `deleteFiles` is false) as a job, then its follow-ups. `done`: `{ name }`. */
export function startContainerDeleteJob({ name, deleteFiles = true, log }) {
  return startJob({
    kind: JOB_KIND.CONTAINER_DELETE,
    title: titleForContainerDelete(name),
    subject: container(name),
    check: () => assertContainerState(name, 'exists'),
    log,
    run: async () => {
      try {
        await deleteContainer(name, deleteFiles);
      } catch (err) {
        // The container is gone even though its lease was not released: its follow-ups still run.
        if (err.code === 'CONTAINER_DELETE_INCOMPLETE') await followWorkloadDelete({ type: 'container', name, log });
        throw err;
      }
      await followWorkloadDelete({ type: 'container', name, log });
      return { name };
    },
  });
}

// ── Configuration ───────────────────────────────────────────────────

/**
 * Apply a configuration update (`PATCH /api/containers/:name` other than an
 * `appConfig` save), a rename included, with its follow-ups. A body `name`
 * other than `name` is a step of its own: the rename and its follow-ups, then
 * the rest under the new name — a failure of the rest leaves the rename, and
 * its follow-ups, standing. Every branch writes container.json, so it holds
 * the lock; a rename also holds the target name's, so nothing starts on it
 * mid-move. An app container's env and mounts come from its appConfig:
 * changing them here is refused before anything is written.
 */
export async function editContainerConfig({ name, changes, log }) {
  const { name: requestedName, ...rest } = changes;
  const renameTo = 'name' in changes && requestedName !== name ? requestedName : null;
  const apply = async () => {
    if ('env' in rest || 'envPatch' in rest || 'mounts' in rest) {
      const config = await getContainerConfig(name);
      if (config?.metadata?.app) {
        throw createAppError('APP_CONFIG_ONLY', 'Use appConfig to configure app containers, or eject to generic first');
      }
    }
    let current = name;
    if (renameTo) {
      current = (await renameContainer(name, renameTo)).name;
      await followWorkloadRename({ type: 'container', from: name, to: current, log });
    }
    await applyContainerConfigChanges({ name: current, changes: rest, log });
  };
  if (!renameTo) {
    await withContainerOperationLock(name, 'configuration change', apply);
    return;
  }
  await withContainerOperationLock(name, 'rename', () => withContainerOperationLock(renameTo, 'rename', apply));
}

/**
 * Save an app container's appConfig: validated by its app module, which
 * regenerates the derived env, mounts and files (deleting a dropped mount's
 * data) and live-reloads when it can. `appConfigFor(config)` answers the
 * appConfig to save from the container's config as read under the lock, so
 * a merge onto the stored one cannot interleave with another save. An app
 * that uses the host's certificate gets the one Wisp holds, so every save
 * delivers it too. Resolves `{ requiresRestart, reloaded? }`.
 */
function saveAppConfigUnderLock(name, appConfigFor) {
  return withContainerOperationLock(name, 'configuration change', async () => {
    const appConfig = appConfigFor(await getContainerConfig(name));
    return applyAppConfig(name, appConfig, { certificate: await getHeldCertificate() });
  });
}

/**
 * The one rule for an agent's appConfig (MCP `update_app_config`, a `PATCH`
 * from an `agent` token): it holds only the keys the app marks agent-writable,
 * each replacing that key, merged onto the stored, unmasked config, so what
 * the agent cannot write — secrets included — passes through untouched.
 * `refusalCode` is the caller's: the tool refuses every caller, the `PATCH`
 * the scope. A generic container is CONFIG_ERROR for both.
 */
function agentWritableAppConfig(name, appConfig, refusalCode) {
  return (cfg) => {
    const appType = cfg?.metadata?.app;
    if (!appType) throw createAppError('CONFIG_ERROR', `Container "${name}" is not an app container`);
    const writable = getAppModule(appType)?.agentWritableAppConfigFields ?? [];
    if (!writable.length) {
      throw createAppError(refusalCode, `The "${appType}" app has no agent-writable appConfig field: configure it in the Wisp UI`);
    }
    const blocked = Object.keys(appConfig).filter((key) => !writable.includes(key));
    if (blocked.length) {
      throw createAppError(
        refusalCode,
        `Field(s) not agent-writable for "${appType}": ${blocked.join(', ')}. Writable: ${writable.join(', ')}. Everything else is configured in the Wisp UI.`,
      );
    }
    return { ...cfg.metadata.appConfig, ...appConfig };
  };
}

/**
 * `PATCH /api/containers/:name` with `{ appConfig }`: the whole config from a
 * session or an `admin` token; from an `agent` token, its agent-writable keys
 * merged onto the stored config, any other key refused for the scope.
 */
export function saveContainerAppConfig({ name, appConfig, scope }) {
  if (scope === 'agent') return saveAppConfigUnderLock(name, agentWritableAppConfig(name, appConfig, 'SCOPE_INSUFFICIENT'));
  return saveAppConfigUnderLock(name, () => appConfig);
}

/** MCP `update_app_config`: the agent-writable keys, for every caller (APP_CONFIG_ONLY otherwise). */
export function saveAgentAppConfig(name, appConfig) {
  return saveAppConfigUnderLock(name, agentWritableAppConfig(name, appConfig, 'APP_CONFIG_ONLY'));
}

/**
 * Deliver the host's certificate to an app container that uses it
 * (docs/specs/CERTIFICATES.md, Delivery): its own config save, with its stored
 * appConfig and the certificate Wisp holds (none: the app serves no site).
 * A container whose operation lock is held is skipped, not waited for: the
 * next check delivers to it. Resolves `{ delivered: false }` when skipped,
 * else `{ delivered: true, requiresRestart, reloaded? }`.
 */
export async function deliverHostCertificate(name) {
  const release = tryAcquireContainerOperationLock(name, 'certificate delivery');
  if (!release) return { delivered: false };
  try {
    const config = await getContainerConfig(name);
    const result = await applyAppConfig(name, config.metadata?.appConfig, { certificate: await getHeldCertificate() });
    return { delivered: true, ...result };
  } finally {
    release();
  }
}

/** Turn an app container into a generic one, keeping its env, mounts and files (no-op on a generic container). */
export function ejectContainerApp(name) {
  return withContainerOperationLock(name, 'eject', () => eject(name));
}

/** Append one mount (row-scoped). */
export function addContainerMountRow(name, mount) {
  return withContainerOperationLock(name, 'configuration change', async () => {
    assertMountListNotAppManaged(await getContainerConfig(name));
    return addContainerMount(name, mount);
  });
}

/**
 * A mount backed by a storage share or a drive (one with a `sourceId`) is the
 * container's reach into the host: an `agent` token changes nothing of it.
 * Read under the lock, from the stored mount.
 */
function assertAgentMayTouchMount(config, mountName, scope) {
  if (scope !== 'agent') return;
  const mount = config?.mounts?.find((m) => m.name === mountName);
  if (mount?.sourceId) {
    throw createAppError(
      'SCOPE_INSUFFICIENT',
      `Mount "${mountName}" is backed by a storage mount: an agent token cannot change it; it needs an admin-scoped token or a session`,
    );
  }
}

/** Edit one mount by its current name (row-scoped). `scope` is the caller's token scope (null for a session). */
export function editContainerMountRow(name, mountName, changes, { scope = null } = {}) {
  return withContainerOperationLock(name, 'configuration change', async () => {
    const config = await getContainerConfig(name);
    assertMountNotAppManaged(config, mountName);
    assertAgentMayTouchMount(config, mountName, scope);
    return updateContainerMount(name, mountName, changes);
  });
}

/** Remove one mount and its data as a job. Not found and app-managed are answered under the lock, before the job. `done`: `{ requiresRestart }`. */
export function startContainerMountDeleteJob({ name, mountName, log }) {
  return startJob({
    kind: JOB_KIND.CONTAINER_MOUNT_DELETE,
    title: titleForContainerMountDelete(name, mountName),
    subject: container(name),
    check: async () => {
      assertMountNotAppManaged(await getContainerConfig(name), mountName);
      await assertMountOperation(name, mountName, 'remove');
    },
    log,
    run: () => removeContainerMount(name, mountName),
  });
}

export function addContainerServiceRow(name, service) {
  return withContainerOperationLock(name, 'configuration change', () => addContainerService(name, service));
}

export function editContainerServiceRow(name, port, changes) {
  return withContainerOperationLock(name, 'configuration change', () => updateContainerService(name, port, changes));
}

export function removeContainerServiceRow(name, port) {
  return withContainerOperationLock(name, 'configuration change', () => removeContainerService(name, port));
}

// ── Mount content ───────────────────────────────────────────────────

/**
 * Replace a file mount's content with an upload. `stage(tmpPath, mode)`
 * writes the whole upload to `tmpPath` (beside the mount's file, in files/),
 * which is then renamed over it: an atomic replace, and every refusal leaves
 * the mount as it was. Locked from the first write to the rename; the temp
 * file goes on any failure.
 */
export function writeContainerMountFile({ name, mountName, stage }) {
  return withContainerOperationLock(name, 'file upload', async () => {
    assertMountNotAppManaged(await getContainerConfig(name), mountName);
    const plan = await planMountFileUpload(name, mountName);
    let committed = false;
    try {
      await stage(plan.tmp, plan.mode);
      await commitMountFileUpload(plan);
      committed = true;
    } finally {
      if (!committed) await unlink(plan.tmp).catch(() => { /* never created, or already gone */ });
    }
  });
}

/**
 * Receive a zip for a directory mount and extract it, as one job holding the
 * container's lock from the upload's first byte to the end of the extract:
 * the job's check — under that lock, before the job exists — refuses an
 * app-managed or non-directory mount, has `stage(path)` write the whole
 * upload to a staging file inside the container's directory (on the mount
 * data's disk, not a tmpfs /tmp), and plans the extract from it; the job's
 * run extracts. So no rename, delete or edit lands between the staging and
 * the extract, and what the check throws is the request's answer, never a
 * failed job. The staging file goes when the extract ends, or with the check
 * that failed. `done`: `{ name, mount }`.
 */
export function startContainerZipExtractJob({ name, mountName, stage, log }) {
  const stagingPath = join(getContainerDir(name), `.wisp-upload-${randomBytes(8).toString('hex')}`);
  let plan;
  return startJob({
    kind: JOB_KIND.CONTAINER_ZIP_EXTRACT,
    title: titleForZipExtract(name, mountName),
    subject: container(name),
    check: async () => {
      try {
        assertMountNotAppManaged(await getContainerConfig(name), mountName);
        await assertMountTakesZip(name, mountName);
        await stage(stagingPath);
        plan = await planMountZipExtract(name, mountName, stagingPath);
      } catch (err) {
        await unlink(stagingPath).catch(() => { /* never created, or already gone */ });
        throw err;
      }
    },
    log,
    run: async () => {
      try {
        await extractMountZip(plan);
        return { name, mount: mountName };
      } finally {
        await unlink(stagingPath).catch((err) => {
          if (err.code !== 'ENOENT') log.warn({ err, file: stagingPath }, 'Could not remove a zip upload\'s staging file');
        });
      }
    },
  });
}

/** Replace a file mount's content with UTF-8 text. */
export function putContainerMountContent(name, mountName, content) {
  return withContainerOperationLock(name, 'mount content edit', async () => {
    assertMountNotAppManaged(await getContainerConfig(name), mountName);
    await putMountFileTextContent(name, mountName, content);
  });
}

/** Create a mount's empty file or directory. `scope` is the caller's token scope (null for a session). */
export function initContainerMountContent(name, mountName, { scope = null } = {}) {
  return withContainerOperationLock(name, 'mount init', async () => {
    const config = await getContainerConfig(name);
    assertMountNotAppManaged(config, mountName);
    assertAgentMayTouchMount(config, mountName, scope);
    await initMountContent(name, mountName);
  });
}

/** Delete a mount's data (the row stays) as a job. `done`: `{ name, mount }`. */
export function startContainerMountDataDeleteJob({ name, mountName, log }) {
  return startJob({
    kind: JOB_KIND.CONTAINER_MOUNT_DATA_DELETE,
    title: titleForContainerMountDataDelete(name, mountName),
    subject: container(name),
    check: async () => {
      assertMountNotAppManaged(await getContainerConfig(name), mountName);
      await assertMountOperation(name, mountName, 'data');
    },
    log,
    run: async () => {
      await deleteMountData(name, mountName);
      return { name, mount: mountName };
    },
  });
}

// ── Backup and restore ──────────────────────────────────────────────

/**
 * Back the container up (running ones are paused for the archive) through the
 * one backup orchestration: `manual` from the API, `scheduled` from the
 * scheduler, which prunes after each destination (`afterEach`). `done`:
 * `{ timestamp }`.
 */
export function startContainerBackupJob({ name, origin, destinationIds, afterEach, log }) {
  return startWorkloadBackupJob({
    kind: JOB_KIND.CONTAINER_BACKUP,
    title: titleForContainerBackup(name),
    subject: container(name),
    origin,
    destinationIds,
    check: () => assertContainerState(name, 'exists'),
    backupOne: containerBackupTo(name, origin),
    afterEach,
    log,
  });
}

/**
 * Restore the backup `timestamp` of destination `destinationId` over the live
 * container it was taken from, as one job holding its lock: first, unless
 * `safetyBackup` is false, a manual backup of its current state to the same
 * destination through the backup orchestration (0–45% of the bar, steps
 * prefixed `safety-`), whose failure ends the job before the container is
 * touched; then the restore. The container must exist and be stopped,
 * checked under the lock before the job exists. `done`: `{ name, image }`.
 */
export function startContainerRestoreJob({ name, destinationId, timestamp, safetyBackup, log }) {
  let dest;
  let backupPath;
  return startJob({
    kind: JOB_KIND.CONTAINER_RESTORE,
    title: titleForContainerRestore(name),
    subject: container(name),
    // The manager re-checks inside the job.
    check: async () => {
      const found = (await listContainers()).find((c) => c.name === name);
      if (!found) {
        throw createAppError('CONTAINER_NOT_FOUND', `Container "${name}" not found — restore the backup as a new container instead`);
      }
      if (found.state !== 'stopped' && found.state !== 'created') {
        throw createAppError('CONTAINER_MUST_BE_STOPPED', `Container "${name}" must be stopped to restore in place`);
      }
      [dest] = await resolveBackupDestinations([destinationId]);
      backupPath = await resolveContainerBackupDir(dest.path, name, timestamp);
    },
    log,
    run: async (report) => {
      // Every field the event carries passes through (destination-done's
      // destinationId among them); only the step and the percent are mapped.
      const scaled = (base, span, stepPrefix = '') => (ev) => {
        report({
          ...ev,
          step: `${stepPrefix}${ev.step}`,
          percent: ev.percent != null ? Math.min(100, Math.round(base + (ev.percent / 100) * span)) : undefined,
        });
      };
      if (safetyBackup) {
        await backUpWorkload({
          subject: container(name),
          origin: 'manual',
          destinations: [dest],
          backupOne: containerBackupTo(name, 'manual'),
          report: scaled(0, 45, 'safety-'),
        });
      }
      return restoreContainerBackupInPlace(backupPath, {
        onProgress: scaled(safetyBackup ? 45 : 0, safetyBackup ? 55 : 100),
      });
    },
  });
}

/**
 * Restore the backup at `backupPath` as the new container `newName`, as a job
 * holding the new name's lock; the backup is planned under it, before the job
 * exists. `done`: `{ name, sourceName, image }`.
 */
export function startContainerRestoreAsNewJob({ backupPath, newName, log }) {
  let plan;
  return startJob({
    kind: JOB_KIND.CONTAINER_RESTORE_AS_NEW,
    title: titleForContainerRestoreAsNew(newName),
    subject: container(newName),
    check: async () => { plan = await planContainerBackupRestore(backupPath, newName); },
    log,
    run: () => restoreContainerBackup(plan),
  });
}
