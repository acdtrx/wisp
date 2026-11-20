/**
 * The value logic of a form that stages edits behind a Save (useForm.js), pure so it
 * can be tested. A form shows `form`; `saved` is what it counts as saved.
 *
 * - It follows its record by value: when the values the form shows from its record
 *   change, the form and its saved values are reset to them; a write elsewhere in the
 *   record, which leaves those values as they were, does not touch it.
 * - A save: once it answered, the values sent count as saved until the record is next
 *   read, whatever that read brings (docs/specs/SETTINGS.md): a save the server stored
 *   unchanged, or normalised, then shows what the server holds. A read that lands
 *   before the save answers resolves it the same way.
 *
 * `reads` is the record's count of answered reads (store/recordCache.js).
 */

const keyOf = (values) => JSON.stringify(values ?? null);

/** @returns {{ form: any, saved: any, followed: string, pending: null | { reads: number } }} */
export function initialFormState(values) {
  return { form: values, saved: values, followed: keyOf(values), pending: null };
}

const resetTo = (values) => initialFormState(values);

/** The state once the record holds `values` after `reads` answered reads. */
export function followRecord(state, values, reads) {
  if (state.pending && reads > state.pending.reads) return resetTo(values);
  if (keyOf(values) === state.followed) return state;
  return resetTo(values);
}

/** The state as a save of the form starts, `reads` answered so far. */
export function beginSave(state, reads) {
  return { ...state, pending: { reads } };
}

/** The state once the save of `sent` answered: what it sent counts as saved, unless a
 *  read already resolved it. */
export function afterSave(state, sent) {
  if (!state.pending) return state;
  return { ...state, saved: sent };
}

/** The state once the save failed: the form keeps its edits. */
export function failedSave(state) {
  return { ...state, pending: null };
}

export function isDirty(state) {
  return keyOf(state.form) !== keyOf(state.saved);
}
