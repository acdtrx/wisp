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
 * container. When the timer fires the current state is re-read — a container
 * deleted (no container.json, including delete-keep-files), switched to
 * `never`, or already started by someone else is left alone. Starts go through
 * the regular `startContainer`, so a failed attempt is logged and retried on
 * the next backoff step.
 *
 * Only exits observed while the backend is subscribed are acted on: an exit
 * during a backend restart or an events-stream gap is not replayed, and host
 * boot is `autostart`'s job.
 */
import { containerState } from './containerManagerConnection.js';
import { readContainerConfig } from './containerManagerConfigIo.js';

export const RESTART_POLICIES = ['never', 'on-failure', 'unless-stopped', 'always'];
const DEFAULT_RESTART_POLICY = 'unless-stopped';

const INITIAL_DELAY_MS = 1000;
const MAX_DELAY_MS = 5 * 60 * 1000;
const RESET_AFTER_MS = 60 * 1000;

/** name → Set<pid> of main processes Wisp is stopping on purpose. */
const intentionalStopPids = new Map();
/** name → { timer, exitStatus } — at most one scheduled restart per container. */
const pendingRestarts = new Map();
/** name → { nextDelayMs, attempt, lastStartAt } — kept while a crash loop is in progress. */
const backoffState = new Map();

function log() {
  return containerState.logger;
}

function policyRestarts(policy, exitStatus) {
  if (policy === 'unless-stopped' || policy === 'always') return true;
  if (policy === 'on-failure') return exitStatus !== 0;
  return false;
}

function cancelPendingRestart(name) {
  const pending = pendingRestarts.get(name);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingRestarts.delete(name);
  return true;
}

/**
 * Wisp is stopping this container, or keeping it stopped, on purpose. The exit
 * of `pid` (the current main process, when there is one) will not be treated
 * as a failure, and any pending policy restart is cancelled.
 */
export function noteIntentionalStop(name, pid = null) {
  if (cancelPendingRestart(name)) {
    log()?.info?.({ container: name }, 'Pending restart-policy restart cancelled by a Wisp stop');
  }
  backoffState.delete(name);
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return;
  let pids = intentionalStopPids.get(name);
  if (!pids) {
    pids = new Set();
    intentionalStopPids.set(name, pids);
  }
  pids.add(n);
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
  if (state && state.lastStartAt != null && Date.now() - state.lastStartAt >= RESET_AFTER_MS) {
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
    runRestart(name, exitStatus, attempt).catch((err) => {
      log()?.warn?.({ err: err?.message || String(err), container: name }, 'Restart-policy restart threw');
    });
  }, delayMs);
  timer.unref?.();
  pendingRestarts.set(name, { timer, exitStatus });

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
