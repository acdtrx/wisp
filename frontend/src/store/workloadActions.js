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

/** `slot` with `name` set to `value` (or removed, for null). */
export function withEntry(slot, name, value) {
  const next = { ...slot };
  if (value != null) next[name] = value;
  else delete next[name];
  return next;
}
