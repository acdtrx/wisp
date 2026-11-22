/**
 * Container lifecycle operations on a task: its state, stop, kill, pause and
 * resume. Starting is containerManagerStart.js.
 */
import { containerError, containerState, getClient, callUnary } from './containerManagerConnection.js';
import { deregisterServicesForContainer } from '../../mdns/index.js';
import { findCurrentRunId, finalizeRun } from './containerManagerLogs.js';
import { noteIntentionalStop, getScheduledRestart } from './containerManagerRestartState.js';
import { readContainerConfig } from './containerManagerConfigIo.js';

const SIGTERM = 15;
const SIGKILL = 9;

/** containerd.types.task.Status names */
const TASK_STATUS_NAMES = ['UNKNOWN', 'CREATED', 'RUNNING', 'STOPPED', 'PAUSED', 'PAUSING'];

const CANON_TO_UI = {
  UNKNOWN: 'unknown',
  CREATED: 'created',
  RUNNING: 'running',
  STOPPED: 'stopped',
  PAUSED: 'paused',
  PAUSING: 'pausing',
};

/**
 * A task status as Wisp compares it: the enum's name, which gRPC answers carry
 * (the proto loader decodes enums as strings); anything else, or none, is UNKNOWN.
 */
export function normalizeTaskStatus(status) {
  return TASK_STATUS_NAMES.includes(status) ? status : 'UNKNOWN';
}

/** Whether a task (getTaskState's answer) is on: running or paused. */
export function isTaskOn(task) {
  return !!task && (task.status === 'RUNNING' || task.status === 'PAUSED');
}

/**
 * UI / API state string for a container task (list row, detail, stats SSE).
 */
export function containerTaskStatusToUi(task) {
  if (!task) return 'stopped';
  const canon = normalizeTaskStatus(task.status);
  return CANON_TO_UI[canon] || 'unknown';
}

/**
 * Get the task state for a container. Returns null if no task exists.
 * `status` is always a string (e.g. STOPPED, CREATED) for reliable comparisons.
 */
export async function getTaskState(name) {
  try {
    const res = await callUnary(getClient('tasks'), 'get', { containerId: name });
    const proc = res.process;
    if (!proc) return null;
    return { ...proc, status: normalizeTaskStatus(proc.status) };
  } catch (err) {
    if (err.code === 'CONTAINER_NOT_FOUND' || err.raw?.includes('not found')) return null;
    throw err;
  }
}

/**
 * The checks a lifecycle call makes first, alone, quick and without side
 * effects, for a caller that answers them before starting the slow part:
 * `exists` (CONTAINER_NOT_FOUND), `start` (also CONTAINER_ALREADY_RUNNING),
 * `stop` (also CONTAINER_NOT_RUNNING, unless a policy restart is pending,
 * which a stop cancels).
 * @param {string} name
 * @param {'exists' | 'start' | 'stop'} what
 */
export async function assertContainerState(name, what) {
  await readContainerConfig(name);
  if (what === 'exists') return;
  const task = await getTaskState(name);
  const st = task ? task.status : null;
  if (what === 'start' && st === 'RUNNING') {
    throw containerError('CONTAINER_ALREADY_RUNNING', `Container "${name}" is already running`);
  }
  if (what === 'stop' && (!task || task.status === 'STOPPED') && !getScheduledRestart(name)) {
    throw containerError('CONTAINER_NOT_RUNNING', `Container "${name}" is not running`);
  }
}

/**
 * Freeze all processes of a running container's task (cgroup freezer).
 * The task keeps its PIDs, memory, and sockets; it stops consuming CPU and
 * cannot write to disk until resumed.
 */
export async function pauseContainer(name) {
  await callUnary(getClient('tasks'), 'pause', { containerId: name });
}

/** Unfreeze a paused container task. */
export async function resumeContainer(name) {
  await callUnary(getClient('tasks'), 'resume', { containerId: name });
}

/**
 * Stop the container (SIGTERM, then SIGKILL after 10 s). On a stopped
 * container waiting out its restart-policy backoff, Stop cancels that restart
 * and succeeds with `restartCancelled: true`; on a stopped container with
 * nothing scheduled it throws CONTAINER_NOT_RUNNING.
 * @param {string} name
 * @param {{ graceSignal?: AbortSignal }} [opts] - aborting it ends the grace
 *   period at once: the task is killed, and the stop finishes as it would after
 *   the 10 s
 * @returns {Promise<{ restartCancelled: boolean }>}
 */
export async function stopContainer(name, { graceSignal } = {}) {
  const task = await getTaskState(name);
  // Before the not-running check: a Stop on a container waiting out its
  // restart-policy backoff cancels that restart.
  const restartCancelled = noteIntentionalStop(name, task && task.status !== 'STOPPED' ? task.pid : null);
  if (!task || task.status === 'STOPPED') {
    if (restartCancelled) return { restartCancelled };
    throw containerError('CONTAINER_NOT_RUNNING', `Container "${name}" is not running`);
  }

  try {
    await callUnary(getClient('tasks'), 'kill', {
      containerId: name,
      signal: SIGTERM,
      all: true,
    });
  } catch {
    // Task may have already exited
  }

  // Wait for graceful exit (up to 10s, or until the grace is cut), then force
  // kill — exponential backoff, not fixed polling
  const deadline = Date.now() + 10000;
  let sleepMs = 100;
  while (Date.now() < deadline && !graceSignal?.aborted) {
    const current = await getTaskState(name);
    if (!current || current.status === 'STOPPED') break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleepUnlessCut(Math.min(sleepMs, remaining), graceSignal);
    sleepMs = Math.min(sleepMs * 2, 2000);
  }

  const afterWait = await getTaskState(name);
  if (afterWait && afterWait.status !== 'STOPPED') {
    await killContainer(name);
  }

  await cleanupTask(name);
  containerState.containerStartTimes.delete(name);
  // A-record deregistration: handled by the reconciler when the /tasks/exit
  // event fires the network-change event with a null snapshot. Services stay
  // here because they're tied to the container's services array, not the IP.
  await deregisterServicesForContainer(name);
  return { restartCancelled };
}

/**
 * SIGKILL the container. Same scheduled-restart semantics as stopContainer.
 * @returns {Promise<{ restartCancelled: boolean }>}
 */
export async function killContainer(name) {
  const task = await getTaskState(name);
  const restartCancelled = noteIntentionalStop(name, task && task.status !== 'STOPPED' ? task.pid : null);
  if (!task || task.status === 'STOPPED') {
    if (restartCancelled) return { restartCancelled };
    throw containerError('CONTAINER_NOT_RUNNING', `Container "${name}" is not running`);
  }

  try {
    await callUnary(getClient('tasks'), 'kill', {
      containerId: name,
      signal: SIGKILL,
      all: true,
    });
  } catch {
    // Task may have already exited
  }

  await waitForStop(name, 5000);
  await cleanupTask(name);
  containerState.containerStartTimes.delete(name);
  // A-record deregistration: handled by the reconciler via the network-change
  // event. Services stay here, tied to the container's services array.
  await deregisterServicesForContainer(name);
  return { restartCancelled };
}

/** Sleep `ms`, or less when `signal` aborts meanwhile. */
function sleepUnlessCut(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Wait, up to `timeoutMs`, for the task to stop or go — exponential backoff,
 * no flat sleep. Resolves whether it did.
 */
export async function waitForStop(name, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sleepMs = 100;
  for (;;) {
    const task = await getTaskState(name);
    if (!task || task.status === 'STOPPED') return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((r) => setTimeout(r, Math.min(sleepMs, remaining)));
    sleepMs = Math.min(sleepMs * 2, 2000);
  }
}

/**
 * Delete the containerd task record and finalize the currently-active log run.
 * Exit status comes from Tasks.Delete (uint32; non-finite values become null).
 * Finalizing is best-effort — missing/already-finalized runs are skipped.
 * Exported so a start (containerManagerStart) runs the same flow before creating a task.
 * @returns {Promise<object|null>} the Tasks.Delete error when a task could not be
 *   deleted (not "no task"), so a start can name it if it then fails once its network is set up
 */
export async function cleanupTask(name) {
  let exitCode = null;
  let deleteError = null;
  try {
    const res = await callUnary(getClient('tasks'), 'delete', { containerId: name });
    const raw = res?.exitStatus;
    if (typeof raw === 'number' && Number.isFinite(raw)) exitCode = raw;
    else if (typeof raw === 'bigint') exitCode = Number(raw);
    else if (typeof raw === 'string' && /^\d+$/.test(raw)) exitCode = parseInt(raw, 10);
  } catch (err) {
    if (err.code !== 'CONTAINER_NOT_FOUND') deleteError = err;
  }
  try {
    const runId = await findCurrentRunId(name);
    if (runId) await finalizeRun(name, runId, { exitCode });
  } catch { /* best effort — finalization is informational */ }
  return deleteError;
}
