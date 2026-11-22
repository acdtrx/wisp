/**
 * Restart policy: applies `container.json` `restartPolicy` when a container's
 * main process exits on its own. Triggered by containerd's `/tasks/exit` event
 * (wired from the events stream in containerManagerList.js); the decision is
 * `handleContainerExit`, invocable directly.
 *
 *   never           never restarted
 *   on-failure      restarted when the exit status is non-zero
 *   unless-stopped  restarted on any exit
 *   always          same as unless-stopped — Docker's difference (daemon
 *                   restart revives user-stopped containers) belongs to
 *                   `autostart` in Wisp, the only boot/backend-start mechanism
 *
 * Under every policy an exit Wisp caused (Stop, Kill, Restart, Delete) is not
 * a failure: those paths call `noteIntentionalStop(name, pid)` before
 * signalling, and the matching exit is skipped. Matching is by pid, not by
 * name, so a late exit event of the previous task can't be mistaken for a
 * crash of the next one.
 *
 * Restarts back off per container: 1s, doubling to a 5 min cap; a run that
 * stayed up for RESET_AFTER_MS starts over at 1s. One pending restart per
 * container. When the timer fires it takes the embedder's per-container
 * operation lock (containerOperationGuard.js) for the whole attempt; when
 * another operation holds it (a backup, an app-config save, …) the attempt is
 * deferred to the next backoff step, logged, never raised. With the lock
 * held the current state is re-read — a container
 * deleted (no container.json, including delete-keep-files), switched to
 * `never`, or already started by someone else is left alone. Starts go through
 * the regular `startContainer`, so a failed attempt is logged and retried on
 * the next backoff step.
 *
 * Only exits observed while the backend is subscribed are acted on: an exit
 * during a backend restart or an events-stream gap is not replayed, and host
 * boot is `autostart`'s job.
 *
 * A scheduled restart is visible: `getScheduledRestart(name)` feeds the list
 * and detail payloads (`scheduledRestart`), and every schedule / cancel / fire
 * notifies `subscribeScheduledRestartChange` handlers so the list cache
 * refreshes.
 */
import { containerState } from './containerManagerConnection.js';
import { readContainerConfig } from './containerManagerConfigIo.js';
import { tryAcquireOperationLock } from './containerOperationGuard.js';
import { findCurrentRunId, finalizeRun } from './containerManagerLogs.js';
import { deregisterServicesForContainer } from '../../mdns/index.js';
import { getTaskState, normalizeTaskStatus } from './containerManagerLifecycle.js';
import { startContainer } from './containerManagerStart.js';
import {
  RESTART_POLICIES, intentionalStopPids, pendingRestarts, backoffState, fireScheduledRestartChange, cancelPendingRestart,
} from './containerManagerRestartState.js';

const DEFAULT_RESTART_POLICY = 'unless-stopped';

const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const RESET_AFTER_MS = 60 * 1000;

function log() {
  return containerState.logger;
}

function policyRestarts(policy, exitStatus) {
  if (policy === 'unless-stopped' || policy === 'always') return true;
  if (policy === 'on-failure') return exitStatus !== 0;
  return false;
}

function scheduleRestart(name, exitStatus, policy, reason) {
  if (pendingRestarts.has(name)) return;
  let state = backoffState.get(name);
  // Judged at an exit only: a deferred or failed attempt is no run at all, and
  // lastStartAt still dates from the run before it.
  if (reason === 'exit' && state && state.lastStartAt != null && Date.now() - state.lastStartAt >= RESET_AFTER_MS) {
    state = null;
  }
  if (!state) {
    state = { nextDelayMs: INITIAL_DELAY_MS, attempt: 0, lastStartAt: null };
    backoffState.set(name, state);
  }
  const delayMs = state.nextDelayMs;
  state.nextDelayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
  state.attempt += 1;
  const attempt = state.attempt;

  const timer = setTimeout(() => {
    pendingRestarts.delete(name);
    fireScheduledRestartChange(name);
    // Taken synchronously as the timer fires: an operation that cancels the
    // pending restart (Stop, Kill, Start, Delete, Rename, restore) either
    // already did so or now finds the lock held.
    const release = tryAcquireOperationLock(name, 'restart-policy start');
    if (!release) {
      log()?.info?.({ container: name, attempt }, 'Restart-policy restart deferred: another operation on the container is in progress');
      scheduleRestart(name, exitStatus, policy, 'busy');
      return;
    }
    runRestart(name, exitStatus, attempt)
      .catch((err) => {
        log()?.warn?.({ err: err?.message || String(err), container: name }, 'Restart-policy restart threw');
      })
      .finally(release);
  }, delayMs);
  timer.unref?.();
  pendingRestarts.set(name, { timer, exitStatus, attempt, at: Date.now() + delayMs });
  fireScheduledRestartChange(name);

  log()?.info?.(
    { container: name, exitCode: exitStatus, policy, attempt, delayMs, trigger: reason },
    'Container exited — restart scheduled by restart policy',
  );
}

async function runRestart(name, exitStatus, attempt) {
  let config;
  try {
    config = await readContainerConfig(name);
  } catch {
    /* container.json gone — deleted (or deleted keeping files) while the restart was pending */
    backoffState.delete(name);
    log()?.info?.({ container: name, attempt }, 'Restart-policy restart skipped: container no longer exists');
    return;
  }
  const policy = config.restartPolicy ?? DEFAULT_RESTART_POLICY;
  if (!policyRestarts(policy, exitStatus)) {
    backoffState.delete(name);
    log()?.info?.({ container: name, policy, attempt }, 'Restart-policy restart skipped: policy changed');
    return;
  }

  const task = await getTaskState(name);
  const st = task ? normalizeTaskStatus(task.status) : null;
  if (st === 'RUNNING' || st === 'PAUSED' || st === 'PAUSING' || st === 'CREATED') {
    log()?.info?.({ container: name, state: st.toLowerCase(), attempt }, 'Restart-policy restart skipped: already started');
    return;
  }

  try {
    await startContainer(name);
    log()?.info?.({ container: name, policy, attempt }, 'Container restarted by restart policy');
  } catch (err) {
    if (err?.code === 'CONTAINER_ALREADY_RUNNING') return;
    if (err?.code === 'CONTAINER_NOT_FOUND') {
      backoffState.delete(name);
      log()?.info?.({ container: name, attempt }, 'Restart-policy restart skipped: container no longer exists');
      return;
    }
    log()?.warn?.(
      { err: err?.message || String(err), code: err?.code, container: name, attempt },
      'Restart-policy restart failed — retrying with backoff',
    );
    scheduleRestart(name, exitStatus, policy, 'start-failed');
  }
}

/**
 * What Wisp's own stops do for their task, done for a task that exited on its
 * own: drop its SRV/TXT services and finalize its log run (`endedAt`, exit
 * code), so the run reads as ended and the live log delivers a last line
 * without a newline.
 *
 * Skipped when the container already runs a different task (a late exit
 * event). The run is finalized under the container's operation lock, taken
 * in the same tick as that check: a start holding the lock may already have
 * allocated the next run, which this must never end, so a busy container is
 * left to its holder (start, stop, kill and delete finalize via `cleanupTask`).
 * The services are dropped without waiting — avahi calls are bounded but may
 * be slow, and nothing here depends on them. Best-effort: failures are
 * logged, and the restart policy applies either way.
 */
async function settleUnexpectedExit(name, pid, exitCode) {
  let release = null;
  try {
    const task = await getTaskState(name);
    if (task && Number(task.pid) !== pid) {
      log()?.info?.({ container: name, pid, currentPid: Number(task.pid) }, 'Late exit event for an earlier task — run and services left as they are');
      return;
    }
    release = tryAcquireOperationLock(name, 'exit handling');
    deregisterServicesForContainer(name).catch((err) => {
      log()?.warn?.({ err: err?.message || String(err), container: name }, 'Deregistering services after an unexpected exit failed');
    });
    if (!release) {
      log()?.info?.({ container: name, exitCode }, 'Container exited on its own while another operation holds it — that operation finalizes the run');
      return;
    }
    const runId = await findCurrentRunId(name);
    if (runId) await finalizeRun(name, runId, { exitCode });
    log()?.info?.({ container: name, exitCode, runId }, 'Container exited on its own — services deregistered, run finalized');
  } catch (err) {
    log()?.warn?.({ err: err?.message || String(err), container: name }, 'Settling an unexpected exit failed');
  } finally {
    release?.();
  }
}

/**
 * Apply the restart policy to one observed exit of a container's main process.
 * @param {{ containerId: string, id?: string, pid?: number, exitStatus?: number }} exit
 */
export async function handleContainerExit({ containerId, id, pid, exitStatus }) {
  if (!containerId) return;
  /* Exec'd processes (console sessions) publish /tasks/exit too; only the
   * main process carries the container id as its process id. */
  if (id && id !== containerId) return;
  const name = containerId;
  const code = Number(exitStatus) || 0;

  const pids = intentionalStopPids.get(name);
  if (pids?.has(Number(pid))) {
    pids.delete(Number(pid));
    if (pids.size === 0) intentionalStopPids.delete(name);
    log()?.info?.({ container: name, exitCode: code }, 'Container stopped by Wisp — restart policy not applied');
    return;
  }

  let config;
  try {
    config = await readContainerConfig(name);
  } catch {
    /* container.json gone — a deleted container's late exit event */
    cancelPendingRestart(name);
    backoffState.delete(name);
    return;
  }

  await settleUnexpectedExit(name, Number(pid), code);

  const policy = config.restartPolicy ?? DEFAULT_RESTART_POLICY;
  if (!RESTART_POLICIES.includes(policy)) {
    log()?.warn?.({ container: name, policy }, 'Unknown restartPolicy — not restarting');
    return;
  }
  if (!policyRestarts(policy, code)) {
    backoffState.delete(name);
    log()?.info?.({ container: name, exitCode: code, policy }, 'Container exited — restart policy does not restart it');
    return;
  }
  scheduleRestart(name, code, policy, 'exit');
}

/** Decode a `/tasks/exit` envelope payload (containerd.events.TaskExit) and apply the policy. */
export function handleTaskExitEvent(anyEvent) {
  const type = containerState.protoTypes?.['containerd.events.TaskExit']?.type;
  const buf = anyEvent?.value;
  if (!type || !buf || buf.length === 0) return;
  let ev;
  try {
    ev = type.toObject(type.decode(Buffer.isBuffer(buf) ? buf : Buffer.from(buf)), { defaults: true });
  } catch (err) {
    log()?.warn?.({ err: err?.message || String(err) }, 'Could not decode /tasks/exit event');
    return;
  }
  handleContainerExit(ev).catch((err) => {
    log()?.warn?.({ err: err?.message || String(err), container: ev.containerId }, 'Restart-policy exit handler threw');
  });
}
