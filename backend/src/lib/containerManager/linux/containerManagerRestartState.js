/**
 * The restart policy's bookkeeping, shared by the paths that start and stop a
 * container and by the exit handling (containerManagerRestartPolicy.js): the
 * exits Wisp caused (by pid), the pending policy restarts, each container's
 * backoff, and who is told when a scheduled restart changes.
 */
import { containerState } from './containerManagerConnection.js';

export const RESTART_POLICIES = ['never', 'on-failure', 'unless-stopped', 'always'];

/** name → Set<pid> of main processes Wisp is stopping on purpose. */
export const intentionalStopPids = new Map();
/** name → { timer, exitStatus, attempt, at } — at most one scheduled restart per container. */
export const pendingRestarts = new Map();
/** name → { nextDelayMs, attempt, lastStartAt } — kept while a crash loop is in progress. */
export const backoffState = new Map();
const scheduledRestartChangeHandlers = new Set();

function log() {
  return containerState.logger;
}

export function fireScheduledRestartChange(name) {
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

export function cancelPendingRestart(name) {
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
