/**
 * Starting a container: a new task from the current image and config, with its
 * network, mounts and log run; restart (stop, then start).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  containerError, containerState, getClient, callUnary, packAny, isWispError, wrapContainerError,
} from './containerManagerConnection.js';
import { buildOCISpec, OCI_SPEC_TYPE_URL } from './containerManagerSpec.js';
import { getContainerDir, getContainerFilesDir, resolveMount } from './containerPaths.js';
import { createNewRun } from './containerManagerLogs.js';
import {
  setupNetwork, teardownNetwork, mergeNetworkLeaseIntoConfig, resolveContainerResolvConf,
} from './containerManagerNetwork.js';
import {
  getTaskState, normalizeTaskStatus, cleanupTask, resumeContainer, stopContainer,
} from './containerManagerLifecycle.js';
import { deregisterServicesForContainer } from '../../mdns/index.js';
import { registerAllContainerServices } from './containerManagerServices.js';
import { assertBindSourcesReady, resolveBindSources } from './containerManagerMounts.js';
import { resolveDeviceSpecs } from './containerDeviceNode.js';
import { getImageDigest } from './containerManagerImages.js';
import { readContainerConfig, writeContainerConfig } from './containerManagerConfigIo.js';
import { RESTART_FIELDS } from './containerManagerConfig.js';
import { markPendingRestart, pendingRestartInForce } from './containerManagerPendingRestart.js';
import { pullImage, getImageConfig } from './containerManagerPull.js';
import { SNAPSHOTTER, SNAPSHOT_REMOVE_DEADLINE_MS, prepareSnapshot } from './containerManagerSnapshot.js';
import { noteContainerStart } from './containerManagerRestartState.js';

/** containerd-shim-runc-v2 `file://` stdio URI — appends stdout/stderr (see process/io.go). */
function taskLogStdioUri(logPath) {
  return pathToFileURL(logPath).href;
}

/** Restart-relevant fields, compared without the addresses a start itself writes. */
function restartFieldsSignature(config) {
  const sig = {};
  for (const key of RESTART_FIELDS) {
    if (key === 'network') {
      const { ip, ip6, ...net } = config.network || {};
      sig.network = net;
    } else {
      sig[key] = config[key] ?? null;
    }
  }
  return JSON.stringify(sig);
}

/**
 * Persist what this start owns into the latest container.json: the image
 * digest the task runs. Every other field comes from the latest file, so an
 * edit saved during the start is never reverted. The lease addresses were
 * already merged the same way. Returns the latest config as written.
 */
async function persistStartOwnedFields(name, specConfig) {
  const latest = await readContainerConfig(name);
  const next = { ...latest };
  if (specConfig.imageDigest) {
    next.imageDigest = specConfig.imageDigest;
    next.imagePulledAt = specConfig.imagePulledAt;
  }
  await writeContainerConfig(name, next);
  return next;
}

/**
 * Settle the restart-required flag once the task has started, in the latest
 * container.json. A restart-relevant field saved after the spec was built
 * found no running task, so nothing else marked it: flag it (`since` lies
 * after the task's start, so the flag holds until the next start). Otherwise
 * drop a flag the task started after — this start applied that change. A
 * flag set while the task was starting is newer than its start and stays.
 */
async function settleRestartFlagAfterStart(name, specConfig, pid) {
  const latest = await readContainerConfig(name);
  const since = latest.pendingRestart?.since;
  let result;
  if (restartFieldsSignature(latest) !== restartFieldsSignature(specConfig)) {
    markPendingRestart(latest);
    await writeContainerConfig(name, latest);
    result = 'flagged: edit saved during the start';
  } else if (!latest.pendingRestart) {
    result = 'no flag';
  } else if (await pendingRestartInForce(latest, pid)) {
    result = 'kept';
  } else {
    delete latest.pendingRestart;
    await writeContainerConfig(name, latest);
    result = 'cleared';
  }
  containerState.logger?.info?.({ container: name, trigger: 'start', since, result }, `[containerManager] restart-required flag check: ${result}`);
}

/**
 * Undo a start that failed after network setup: drop the task if one was
 * created, the netns/CNI attachment, the fresh snapshot, and any SRV/TXT
 * services still registered under the name — a failed start leaves nothing
 * published.
 */
async function rollbackFailedStart(name, networkConfig) {
  await cleanupTask(name);
  try { await teardownNetwork(name, networkConfig); } catch { /* best-effort — the next start re-creates the netns */ }
  try {
    await callUnary(getClient('snapshots'), 'remove', { snapshotter: SNAPSHOTTER, key: name }, { deadlineMs: SNAPSHOT_REMOVE_DEADLINE_MS });
  } catch { /* best-effort — the next start removes and re-prepares it */ }
  try { await deregisterServicesForContainer(name); } catch { /* best-effort — nothing may be registered */ }
}

/**
 * Start an existing (stopped) container by creating a new task.
 * Called from startContainer when no task exists.
 *
 * The task runs the config read here (`config`); container.json writes during
 * the start merge only start-owned fields into the latest file. Mount sources
 * are prepared before the network wait and re-resolved immediately before
 * task create, and the spec binds the resolved paths. SRV/TXT services are
 * registered only once the task has started.
 */
export async function startExistingContainer(name) {
  const containerDir = getContainerDir(name);
  const filesDir = getContainerFilesDir(name);

  // Read container.json
  let config;
  try {
    const raw = await readFile(join(containerDir, 'container.json'), 'utf8');
    config = JSON.parse(raw);
  } catch {
    throw containerError('CONTAINER_NOT_FOUND', `Container config not found for "${name}"`);
  }

  // Remove any stale task (STOPPED still exists until Delete; Create would fail
  // with "already exists"). cleanupTask also finalizes the prior log run if
  // one was still open, so the run picker shows it as ended rather than
  // perpetually "Running…".
  const staleTaskDeleteError = await cleanupTask(name);

  // Get image config. If the image was removed under us (e.g.
  // `ctr -n wisp image rm <ref>`), auto-pull it once and retry — the
  // container's image reference is canonical, so re-pulling restores
  // exactly what was there before. Anything else is treated as a transient
  // read failure and we continue with an empty imageConfig (existing
  // behavior — prepareSnapshot below will still throw if rootfs is missing).
  // The lookups below use the name the pull stored the image under — the
  // normalized ref, which a stored short ref (`nginx:1.27`) is not.
  let imageRef = config.image;
  let imageConfig = {};
  try {
    imageConfig = await getImageConfig(imageRef);
  } catch (err) {
    if (err.code === 'IMAGE_PULL_FAILED') throw err;
    if (err.code === 'CONTAINER_NOT_FOUND' || err.code === 'CONTAINER_IMAGE_NOT_FOUND') {
      containerState.logger?.info(
        { image: config.image, container: name },
        'Image missing on start; auto-pulling',
      );
      imageRef = await pullImage(config.image);
      imageConfig = await getImageConfig(imageRef);
    }
    /* other read failures fall through with empty imageConfig */
  }

  // Rootfs is ephemeral: on every start, discard the existing snapshot and re-prepare
  // from the current library image. State persists only through bind mounts.
  try {
    await callUnary(getClient('snapshots'), 'remove', { snapshotter: SNAPSHOTTER, key: name }, { deadlineMs: SNAPSHOT_REMOVE_DEADLINE_MS });
  } catch { /* no snapshot yet (first-ever start) — prepareSnapshot below creates it */ }

  const currentDigest = await getImageDigest(imageRef);
  if (currentDigest && config.imageDigest !== currentDigest) {
    config.imageDigest = currentDigest;
    config.imagePulledAt = new Date().toISOString();
  }

  // Create missing mount artifacts and fail fast on a bad source, before the
  // network wait. Re-checked (and resolved) again right before task create.
  await assertBindSourcesReady(name, config, filesDir, resolveMount);

  const mounts = await prepareSnapshot(name, imageConfig);

  // Set up networking. A failure fails the start: a task without its network
  // would log normally yet be unreachable, looking like a successful start.
  // Tear down partial state so the next start isn't blocked by a
  // half-attached netns or stale snapshot.
  let lease;
  try {
    lease = await setupNetwork(name, config.network);
  } catch (err) {
    try { await teardownNetwork(name, config.network); } catch { /* best-effort */ }
    try {
      await callUnary(getClient('snapshots'), 'remove', { snapshotter: SNAPSHOTTER, key: name }, { deadlineMs: SNAPSHOT_REMOVE_DEADLINE_MS });
    } catch { /* best-effort */ }
    throw wrapContainerError('CONTAINER_NETWORK_SETUP_FAILED', `Network setup failed for "${name}"`, err);
  }

  let runConfig;
  let taskPid;
  try {
    if (lease) await mergeNetworkLeaseIntoConfig(name, config, lease);

    const mountSources = await resolveBindSources(config, filesDir, resolveMount);
    const resolvConfPath = await resolveContainerResolvConf(config.network?.interface);
    const { deviceSpecs, renderGid } = await resolveDeviceSpecs(config);
    const ociSpec = buildOCISpec(config, imageConfig, filesDir, {
      resolvConfPath, resolveMount, deviceSpecs, renderGid, mountSources,
    });
    await callUnary(getClient('containers'), 'update', {
      container: {
        id: name,
        spec: packAny(OCI_SPEC_TYPE_URL, ociSpec),
      },
      updateMask: { paths: ['spec'] },
    });

    // Allocate a fresh log run (per-start file under runs/<runId>.log + sidecar).
    // The shim opens the path via file:// and appends stdout+stderr. Retention
    // keeps only the newest N runs, pruned inside createNewRun.
    const { logPath } = await createNewRun(name, { imageDigest: config.imageDigest || null });

    runConfig = await persistStartOwnedFields(name, config);

    const logUri = taskLogStdioUri(logPath);
    await callUnary(getClient('tasks'), 'create', {
      containerId: name,
      rootfs: mounts,
      stdout: logUri,
      stderr: logUri,
    });
    ({ pid: taskPid } = await callUnary(getClient('tasks'), 'start', { containerId: name }));
  } catch (err) {
    await rollbackFailedStart(name, config.network);
    if (!staleTaskDeleteError) throw err;
    throw wrapContainerError(
      isWispError(err) ? err.code : 'CONTAINERD_ERROR',
      `Container "${name}" failed to start, and its previous task could not be deleted first`,
      err,
      staleTaskDeleteError,
    );
  }

  // The task is running: a failed flag write is logged, not a failed start.
  try {
    await settleRestartFlagAfterStart(name, config, Number(taskPid) || 0);
  } catch (err) {
    containerState.logger?.warn?.({ err: err?.message || err, container: name }, '[containerManager] restart-required check after start failed');
  }

  // A-record registration is owned by the reconciler — the /tasks/start event
  // triggers a list refresh + network-change event, and the reconciler picks
  // up running + localDns containers there. SRV/TXT services are tied to the
  // services array, so they are registered here, against the latest config
  // (localDns may have been switched off during the start). The task is
  // already running: a registration failure is logged, not a failed start.
  if (runConfig.localDns) {
    try {
      await registerAllContainerServices(name, runConfig);
      // A task that died while its services were being registered (a crash
      // loop) found this start holding the lock, so the exit handler left the
      // services to it: drop them now rather than advertise a dead task.
      const task = await getTaskState(name);
      const st = task ? normalizeTaskStatus(task.status) : null;
      if (Number(task?.pid) !== Number(taskPid) || (st !== 'RUNNING' && st !== 'PAUSED')) {
        containerState.logger?.info?.({ container: name, pid: taskPid }, '[containerManager] task exited during start — services deregistered');
        await deregisterServicesForContainer(name);
      }
    } catch (err) {
      containerState.logger?.warn?.({ err: err?.message || err, container: name }, '[containerManager] service registration after start failed');
    }
  }
}

export async function startContainer(name) {
  noteContainerStart(name);
  const task = await getTaskState(name);
  const st = task ? normalizeTaskStatus(task.status) : null;

  if (task && st === 'RUNNING') {
    throw containerError('CONTAINER_ALREADY_RUNNING', `Container "${name}" is already running`);
  }

  if (task && st === 'PAUSED') {
    await resumeContainer(name);
    containerState.containerStartTimes.set(name, Date.now());
    return;
  }

  // STOPPED (and similar) tasks still exist in containerd until Tasks.Delete.
  // Without deleting first, startExistingContainer → Tasks.Create returns "already exists".
  // A CREATED task (a start interrupted between Tasks.Create and Tasks.Start)
  // is dropped too: its spec may be stale, and only a full start settles the
  // restart-required flag.
  if (task && (st === 'STOPPED' || st === 'CREATED' || st === 'PAUSING' || st === 'UNKNOWN')) {
    await cleanupTask(name);
  }

  // No task (or just removed stale one) — create and start a new task.
  await startExistingContainer(name);
  containerState.containerStartTimes.set(name, Date.now());
}

export async function restartContainer(name) {
  const task = await getTaskState(name);
  if (task && (task.status === 'RUNNING' || task.status === 'PAUSED')) {
    try { await stopContainer(name); } catch { /* may already be stopped */ }
  }
  await startContainer(name);
}
