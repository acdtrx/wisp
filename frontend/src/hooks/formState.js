/**
 * The value logic of a form that stages edits behind a Save (useForm.js), pure so it
 * can be tested. A form shows `form`; `saved` is what it counts as saved.
 *
 * - It follows its record by value: when the values the form shows from its record
 *   change, the form and its saved values are reset to them; a write elsewhere in the
 *   record, which leaves those values as they were, does not touch it.
 * - While its own save is in flight it does not follow its record. When the save ends,
 *   it follows the record as it then is: a save's command ends only once the re-read
 *   of what it changed has landed, so that record is the saved one, normalised or not.
 * - A failed save leaves the form as typed, dirty against the record.
 */

const keyOf = (values) => JSON.stringify(values ?? null);

/** @returns {{ form: any, saved: any, followed: string, saving: boolean, after: null | 'reset' | 'rebase' }} */
export function initialFormState(values) {
  return { form: values, saved: values, followed: keyOf(values), saving: false, after: null };
}

/** The state once the record holds `values`. */
export function followRecord(state, values) {
  if (state.saving) return state;
  if (state.after === 'reset') return initialFormState(values);
  if (state.after === 'rebase') return { ...state, saved: values, followed: keyOf(values), after: null };
  if (keyOf(values) === state.followed) return state;
  return initialFormState(values);
}

export function beginSave(state) {
  return { ...state, saving: true, after: null };
}

/** The save's command ended: the form shows the record as it now is. */
export function endSave(state) {
  return { ...state, saving: false, after: 'reset' };
}

/** The save failed: the form keeps what was typed, against the record as it now is. */
export function failSave(state) {
  return { ...state, saving: false, after: 'rebase' };
}

export function isDirty(state) {
  return keyOf(state.form) !== keyOf(state.saved);
}
