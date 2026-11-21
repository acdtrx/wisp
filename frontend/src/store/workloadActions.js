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

/**
 * The renames one list frame shows against the one before: a name the new list no
 * longer has, whose uuid it lists under another name. `[from, to]` pairs.
 */
export function renamesBetween(previous, list) {
  if (!Array.isArray(previous) || !Array.isArray(list)) return [];
  const names = new Set(list.map((w) => w.name));
  const byUuid = new Map(list.filter((w) => w.uuid).map((w) => [w.uuid, w.name]));
  const renames = [];
  for (const w of previous) {
    if (names.has(w.name) || !w.uuid) continue;
    const to = byUuid.get(w.uuid);
    if (to && to !== w.name) renames.push([w.name, to]);
  }
  return renames;
}

export function withBusy(actions, name, action) {
  const next = { ...actions };
  if (action) next[name] = action;
  else delete next[name];
  return next;
}

export const anyActionInFlight = (actions) => Object.keys(actions).length > 0;
