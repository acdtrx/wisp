/**
 * Per-workload busy and error state for the VM and container stores (one model for
 * both detail views).
 *
 * Busy and errors are kept apart. `actions[name]` is the action in flight on workload
 * `name` ('start', 'delete', …), nothing else. `errors` holds what the detail view
 * shows, each until the user dismisses it, keyed by owner and workload: an `action`'s
 * failure (cleared when the next action on that workload begins), a failed `refresh`
 * of the config, and the `select` read that left no config (the error page). An entry
 * is `{ owner, vm, message }`, `vm` naming the workload.
 */

export function errorKey(owner, vm) {
  return `${owner}:${vm ?? ''}`;
}

export function withError(errors, owner, vm, message) {
  return { ...errors, [errorKey(owner, vm)]: { owner, vm: vm ?? null, message } };
}

export function withoutError(errors, owner, vm) {
  const key = errorKey(owner, vm);
  if (!(key in errors)) return errors;
  const next = { ...errors };
  delete next[key];
  return next;
}

/** The errors without those of workloads no longer listed (deleted). A `select` error
 *  stays: it is the error page of a workload that may never have been listed, up until
 *  the user leaves the view (the store's select and deselect clear it). */
export function withoutErrorsOfVanished(errors, names) {
  let next = null;
  for (const [key, entry] of Object.entries(errors)) {
    if (entry.vm == null || entry.owner === 'select' || names.has(entry.vm)) continue;
    next ??= { ...errors };
    delete next[key];
  }
  return next ?? errors;
}

/** The errors with workload `from`'s action and refresh errors moved to `to` (a rename:
 *  the workload still exists, so its undismissed errors stay with it). */
export function withErrorsRenamed(errors, from, to) {
  let next = errors;
  for (const owner of ['action', 'refresh']) {
    const entry = errors[errorKey(owner, from)];
    if (!entry) continue;
    next = withError(withoutError(next, owner, from), owner, to, entry.message);
  }
  return next;
}

export function withBusy(actions, name, action) {
  const next = { ...actions };
  if (action) next[name] = action;
  else delete next[name];
  return next;
}

export const anyActionInFlight = (actions) => Object.keys(actions).length > 0;
