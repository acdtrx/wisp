/**
 * Per-workload action state for the VM and container stores:
 * `{ [name]: { action, error } }` — the action in flight on that workload
 * (e.g. 'start'), or the error its last action ended with. Keyed by name so a
 * slow action on one workload never disables or errors another's buttons.
 * A workload with neither has no entry.
 */

/** The map with `name`'s entry replaced by `entry` (dropped when it holds nothing). */
export function withWorkloadAction(actions, name, entry) {
  const next = { ...actions };
  if (entry.action || entry.error) next[name] = entry;
  else delete next[name];
  return next;
}

/**
 * The map without the settled entries (an error, nothing in flight) of
 * workloads no longer in `names` — deleted or renamed elsewhere.
 */
export function pruneWorkloadActions(actions, names) {
  let next = null;
  for (const [name, entry] of Object.entries(actions)) {
    if (entry.action || names.has(name)) continue;
    next ??= { ...actions };
    delete next[name];
  }
  return next ?? actions;
}

/** Whether any workload has an action in flight. */
export function anyActionInFlight(actions) {
  return Object.values(actions).some((a) => a.action);
}
