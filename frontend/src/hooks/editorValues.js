/**
 * The value helpers of an editor (useEditor.js), pure: comparing its values, what its
 * save sends, and the identity of its rows.
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

/** Why an edit's Save is off when nothing in the form differs from what it opened with. */
export const NOTHING_CHANGED = 'Nothing changed.';
