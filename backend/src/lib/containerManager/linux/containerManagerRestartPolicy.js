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

export const RESTART_POLICIES = ['never', 'on-failure', 'unless-stopped', 'always'];
const DEFAULT_RESTART_POLICY = 'unless-stopped';

const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const RESET_AFTER_MS = 60 * 1000;

/** name → Set<pid> of main processes Wisp is stopping on purpose. */
const intentionalStopPids = new Map();
/** name → { timer, exitStatus, attempt, at } — at most one scheduled restart per container. */
const pendingRestarts = new Map();
/** name → { nextDelayMs, attempt, lastStartAt } — kept while a crash loop is in progress. */
const backoffState = new Map();
const scheduledRestartChangeHandlers = new Set();

function log() {
  return containerState.logger;
}

function policyRestarts(policy, exitStatus) {
  if (policy === 'unless-stopped' || policy === 'always') return true;
  if (policy === 'on-failure') return exitStatus !== 0;
  return false;
}

function fireScheduledRestartChange(name) {
  for (const handler of scheduledRestartChangeHandlers) {
    try {
      handler(name);
    } catch (err) {
      log()?.warn?.({ err: err?.message || String(err), container: name }, 'Scheduled-restart change handler threw');
    }
  }
}

/**
 * Subscribe to scheduled-restart changes (scheduled, cancelled, fired). The
 * handler gets the container name. Returns an unsubscribe.
 */
export function subscribeScheduledRestartChange(handler) {
  scheduledRestartChangeHandlers.add(handler);
  return () => scheduledRestartChangeHandlers.delete(handler);
}

/**
 * The restart the policy has scheduled for this container, or null.
 * `at` is the epoch-ms time the timer fires; `attempt` counts restarts in the
 * current crash loop (1 for the first).
 * @returns {{ attempt: number, at: number } | null}
 */
export function getScheduledRestart(name) {
  const pending = pendingRestarts.get(name);
  return pending ? { attempt: pending.attempt, at: pending.at } : null;
}

function cancelPendingRestart(name) {
  const pending = pendingRestarts.get(name);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRestarts.delete(name);
  fireScheduledRestartChange(name);
  return true;
}

/**
 * Wisp is stopping this container, or keeping it stopped, on purpose. The exit
 * of `pid` (the current main process, when there is one) will not be treated
 * as a failure, and any pending policy restart is cancelled.
 * @returns {boolean} true when a scheduled restart was cancelled
 */
export function noteIntentionalStop(name, pid = null) {
  const cancelled = cancelPendingRestart(name);
  if (cancelled) {
    log()?.info?.({ container: name }, 'Pending restart-policy restart cancelled by a Wisp stop');
  }
  backoffState.delete(name);
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return cancelled;
  let pids = intentionalStopPids.get(name);
  if (!pids) {
    pids = new Set();
    intentionalStopPids.set(name, pids);
  }
  pids.add(n);
  return cancelled;
}

/**
 * A start is beginning (user, autostart, or this module). Supersedes any
 * pending policy restart and stamps the run start used for the backoff reset.
 */
export function noteContainerStart(name) {
  cancelPendingRestart(name);
  const state = backoffState.get(name);
  if (state) state.lastStartAt = Date.now();
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

  const { getTaskState, normalizeTaskStatus, startContainer } = await import('./containerManagerLifecycle.js');
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
