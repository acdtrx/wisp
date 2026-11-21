/**
 * Per-workload busy and error state for the VM and container stores (one model for
 * both detail views), pure so it can be tested.
 *
 * Busy and errors are kept apart. `actions[name]` is the header action in flight on
 * workload `name` ('start', 'delete', …); `iconChanges[name]` the icon change in flight,
 * which is its own control's. `errors[name]` is the workload's one action error (an
 * icon change's included), shown until the user dismisses it and cleared when any of
 * its actions begins.
 */

export function withError(errors, name, message) {
  return { ...errors, [name]: message };
}

export function withoutError(errors, name) {
  if (!(name in errors)) return errors;
  const next = { ...errors };
  delete next[name];
  return next;
}

/** The errors without those of workloads no longer listed (deleted). */
export function withoutErrorsOfVanished(errors, names) {
  let next = null;
  for (const name of Object.keys(errors)) {
    if (names.has(name)) continue;
    next ??= { ...errors };
    delete next[name];
  }
  return next ?? errors;
}

/** The errors with workload `from`'s moved to `to` (a rename: the workload still
 *  exists, so its undismissed error stays with it). */
export function withErrorsRenamed(errors, from, to) {
  if (!(from in errors) || from === to) return errors;
  return withError(withoutError(errors, from), to, errors[from]);
}

/** `slot` with `name` set to `value` (or removed, for null). */
export function withEntry(slot, name, value) {
  const next = { ...slot };
  if (value != null) next[name] = value;
  else delete next[name];
  return next;
}
