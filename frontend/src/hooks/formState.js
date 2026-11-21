/**
 * The value logic of a form that edits a record (useForm.js), pure so it can be tested.
 * A form shows `form`; `start` is the values it started from. The app shows the
 * server's state except what is being edited:
 *
 * - A clean form (its values are its starting values) follows its record: new record
 *   data gives it the record's values afresh. An edited one keeps the user's values and
 *   ignores every change to the record, until Save succeeds or the edit is undone.
 * - `dirty` is a plain comparison of the form's values with its starting values.
 * - A save that succeeds makes the saved values the starting ones: the form is clean
 *   and follows its record again (a record that changed while the save ran is taken at
 *   once). A failed save leaves the form as typed.
 *
 * @typedef {{ data: unknown, from: unknown, start: any, form: any, saving: boolean, savedFrom: unknown }} FormState
 *   `data`: the record data the form last saw; `from`: the data its starting values came
 *   from; `savedFrom`: the data when the save began
 */

const keyOf = (values) => JSON.stringify(values ?? null);

/** Whether two forms' values are the same, by value. */
export const sameValues = (a, b) => keyOf(a) === keyOf(b);

/** The fields of `values` that differ from `saved`: what an edit's save sends when the
 *  server takes a partial update. */
export function changedFields(values, saved) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => keyOf(value) !== keyOf(saved?.[key])));
}

let lastRow = 0;
/** A row's identity in a form (its React key). */
export const rowId = () => `row-${++lastRow}`;

const valuesOf = (data, toForm) => (data == null ? null : toForm(data));

/** @returns {FormState} */
export const initialFormState = (data, toForm) => {
  const values = valuesOf(data, toForm);
  return { data, from: data, start: values, form: values, saving: false, savedFrom: undefined };
};

export const isDirty = (state) => state.form != null && !sameValues(state.form, state.start);

/** The record's data now (`data`): a clean form shows it — data that changed while the
 *  form was edited included, once the edit is undone — and an edited one only notes it. */
export function followRecord(state, data, toForm) {
  const next = data === state.data ? state : { ...state, data };
  if (next.saving || isDirty(next) || next.from === next.data) return next;
  const values = valuesOf(next.data, toForm);
  return { ...next, from: next.data, start: values, form: values };
}

/** An edit (`update` of the values); with no form, nothing. */
export function editForm(state, update) {
  if (state.form == null) return state;
  return { ...state, form: update(state.form) };
}

/** Undo the edit: the record's values as they are now. */
export const resetForm = (state, toForm) => {
  const values = valuesOf(state.data, toForm);
  return { ...state, from: state.data, start: values, form: values };
};

export const beginSave = (state) => ({ ...state, saving: true, savedFrom: state.data });

/** The save succeeded: the saved values are the starting ones; a record that changed
 *  while the save ran is taken. */
export function endSave(state, toForm) {
  if (state.data !== state.savedFrom) {
    const values = valuesOf(state.data, toForm);
    return { ...state, saving: false, savedFrom: undefined, from: state.data, start: values, form: values };
  }
  return { ...state, saving: false, savedFrom: undefined, from: state.data, start: state.form };
}

/** The save failed: the form stays as typed. */
export const failSave = (state) => ({ ...state, saving: false, savedFrom: undefined });
