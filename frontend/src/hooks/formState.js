/**
 * The value logic of a form that edits a saved record (useForm.js), pure so it can be
 * tested. A form shows `form`; `saved` is the record's values as the form last took
 * them. Each form names what its Save sends for its values (`toSend`, identity where
 * they are the same), and everything here compares that, never the form's own shape:
 *
 * - `dirty` is "Save would send something": what the form would send differs from what
 *   the saved values would. An edit that normalises to the saved value, a row removed
 *   and added again the same, a row's identity: none of them is a change.
 * - The form follows its record by value: when what the record's values would send
 *   changes, the form is reset to them; a write elsewhere in the record does not touch
 *   it. Every reset takes the record's values afresh (`toForm` again), so rows get new
 *   identities and whatever a view kept on a row as it was is left behind.
 * - A field the record's state locks (a running VM's CPU) shows the saved value, is not
 *   sent and makes no change: a value typed in it before the lock began is dropped.
 * - Each reset starts a new generation of the form: what a view keeps on the form as it
 *   was (a confirm, a row editor, a revealed secret) belongs to its generation and is
 *   dropped with it. A failed save is no reset.
 * - While its own save runs it does not follow its record. The save is the command and
 *   then a new read of the record; once that read has landed the form shows the record
 *   as it then is. A failed command or a failed read leaves the form as typed, dirty
 *   against the record.
 */

const asIs = (values) => values;
const keyOf = (values) => JSON.stringify(values ?? null);

/** What `values` would send, as a comparable key. */
const sentKey = (values, toSend = asIs) => keyOf(values == null ? null : toSend(values));

let lastRow = 0;
/** Every row identity made: what a comparison of values leaves out. */
const rowIds = new Set();
/** A row's identity in a form (a React key, what a view keeps on a row): never part of
 *  what the form sends, new at every reset. */
export const rowId = () => {
  const id = `row-${++lastRow}`;
  rowIds.add(id);
  return id;
};
/** A value as compared, its rows' identities left out (a row taken afresh is the same row). */
const valueKey = (value) => JSON.stringify(value, (key, v) => (typeof v === 'string' && rowIds.has(v) ? undefined : v));

/** The fields of `values` that differ from `saved`: what an edit's save sends when the
 *  server takes a partial update. */
export function changedFields(values, saved) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => keyOf(value) !== keyOf(saved?.[key])));
}

/**
 * @param {any} values — the record's values as the form shows them
 * @param {any} [taken] — the record they were taken from
 * @param {number} [generation] — the generation this state starts (0 at first)
 * @returns {{ form: any, saved: any, taken: any, generation: number, saving: boolean, after: null | 'reset' | 'rebase' }}
 */
export function initialFormState(values, taken = null, generation = 0) {
  return { form: values, saved: values, taken, generation, saving: false, after: null };
}

/** The next generation's state, from the record's values afresh. */
const restart = (state, values, taken) => initialFormState(values, taken, state.generation + 1);

/** The state once the record holds `values` (the record's values as `toForm` gives them). */
export function followRecord(state, values, toSend = asIs, taken = null) {
  if (state.saving) return state;
  if (state.after === 'reset') return restart(state, values, taken);
  if (state.after === 'rebase') return { ...state, saved: values, taken, after: null };
  /* Compared with today's `toSend`: what is sent may depend on the record's state (a
   * field locked while running), and that alone is no change of the values. */
  if (sentKey(values, toSend) === sentKey(state.saved, toSend)) return state;
  return restart(state, values, taken);
}

/** The state with the fields in `locked` back at their saved values (a value typed in a
 *  field before its lock began is dropped, and does not come back when it ends). */
export function applyLocks(state, locked) {
  if (!locked?.length || state.form == null || state.saved == null) return state;
  const stale = locked.filter((key) => keyOf(state.form[key]) !== keyOf(state.saved[key]));
  if (stale.length === 0) return state;
  return { ...state, form: { ...state.form, ...Object.fromEntries(stale.map((key) => [key, state.saved[key]])) } };
}

/** The state after an edit of the form (`update` of its values); none while there is no
 *  form (the record not loaded, or gone). */
export function editForm(state, update) {
  if (state.form == null) return state;
  return { ...state, form: update(state.form) };
}

/**
 * The held value after a write (`useHeld`): the write lands only from the form's
 * current generation (a setter kept from an older one writes nothing), and a null
 * value clears it.
 *
 * @param {{ generation: number, value: any } | null} held
 * @param {number} writer — the generation the setter was made in
 * @param {number} now — the form's generation now
 */
export function writeHeld(held, writer, now, next) {
  if (writer !== now) return held;
  const before = held != null && held.generation === now ? held.value : null;
  const value = typeof next === 'function' ? next(before) : next;
  return value == null ? null : { generation: now, value };
}

/** Back to the record's values, afresh. */
export function resetForm(state) {
  return { ...state, after: 'reset' };
}

export function beginSave(state) {
  return { ...state, saving: true, after: null };
}

/** The save's command and re-read ended: the form shows the record as it now is. */
export function endSave(state) {
  return { ...state, saving: false, after: 'reset' };
}

/** The save failed: the form keeps what was typed, against the record as it now is. */
export function failSave(state) {
  return { ...state, saving: false, after: 'rebase' };
}

export function isDirty(state, toSend = asIs) {
  if (state.form == null || state.saved == null) return false;
  return sentKey(state.form, toSend) !== sentKey(state.saved, toSend);
}

/**
 * A form's save, by construction: run its command (`send`, resolving whether it
 * succeeded), then read the form's own record again — a new read, sent after the
 * command ended, whatever the events stream does — and only then follow the record.
 * A failed command, or a failed re-read (the record's error state shows it), leaves
 * the form as typed. `update` applies a state step (`beginSave`, `endSave`, `failSave`).
 *
 * @param {() => Promise<boolean>} send
 * @param {() => Promise<boolean>} reread
 * @param {(step: (state: any) => any) => void} update
 * @returns {Promise<boolean>} whether the command succeeded
 */
export async function saveForm(send, reread, update) {
  update(beginSave);
  let ok = false;
  try {
    ok = await send();
  } finally {
    if (!ok) update(failSave);
  }
  if (!ok) return false;
  update((await reread()) ? endSave : failSave);
  return true;
}

/** The value at `path` (dot-separated: `server.dataUid`, `shares.0`) in `values`. */
const valueAt = (values, path) => path.split('.').reduce((v, key) => (v == null ? v : v[key]), values);

/**
 * The problems that stand, of a form's (`problems`, by key): a value the record already
 * holds is never a problem, only one the user changed. A key is the path of the value
 * the problem is about in the form's values, or several joined by `,` (it stands when any
 * of them changed); a row's identity is not compared. Creating (`creating`: an editor of
 * a new entity), every one stands.
 *
 * @param {Record<string, string>} problems
 * @param {unknown} form
 * @param {unknown} saved
 * @param {boolean} creating
 */
export function standingProblems(problems, form, saved, creating) {
  if (creating) return problems;
  return Object.fromEntries(Object.entries(problems).filter(([key]) => key.split(',')
    .some((path) => valueKey(valueAt(form, path)) !== valueKey(valueAt(saved, path)))));
}
