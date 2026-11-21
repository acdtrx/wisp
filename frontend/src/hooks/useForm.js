import { useCallback, useEffect, useRef, useState } from 'react';

import { applyLocks, editForm, followRecord, initialFormState, isDirty, resetForm, saveForm, standingProblems, writeHeld } from './formState.js';

const asIs = (values) => values;
const NONE = [];
const NO_PROBLEMS = Object.freeze({});

/**
 * A form that edits a saved record (docs/FRONTEND-RULES.md, Data), following it by
 * value (formState.js). A modal editor's record is its parent's (the workload's config,
 * the settings), its `toForm` picking the entity the editor opened on.
 *
 * @template F, S
 * @param {{ data: unknown, reread: () => Promise<boolean> }} record — as `useRecord`
 *   answers it (`data` null before it loads, or when gone: `form` is null)
 * @param {(data: any) => F} toForm — the record's values as this form shows them (pure
 *   and total); rows take a new `rowId()` each time
 * @param {(form: F, data: any, id: any) => S} [toSend] — what Save sends for these
 *   values, given the record's data and the id it is read by (pure and total, reading
 *   only its arguments: text that does not parse is sent as typed, its problem shown
 *   beside the field): `dirty` and the following compare it, and `save` sends it
 * @param {{ locked?: string[], problems?: (form: F, data: any, taken: any) => Record<string, string>,
 *   creating?: boolean }} [options] — `locked`: the form's fields the record's state
 *   locks now; they show the saved value, are not sent and make no change.
 *   `problems`: what keeps the values from being saved, by the path of the value each
 *   is about (formState.js, `standingProblems`); the hook keeps those of values the user
 *   changed — `creating` (an editor of a new entity), all — and answers them
 * @returns {{ form: F, saved: F, taken: any, generation: number,
 *   setForm: (update: (form: F) => F) => void, setField: (key: string, value: unknown) => void,
 *   dirty: boolean, saving: boolean, reset: () => void,
 *   problems: Record<string, string>, blocked: string | null,
 *   save: (send: (values: S, saved: S) => Promise<boolean>) => Promise<boolean> }}
 *   `taken`: the record as the form took its values (what "the others" are checked
 *   against); `generation`: the form's reset count (`useHeld`); `saving`: from the
 *   command until its re-read has landed (every Save control shows it); `problems`: those
 *   that stand, each shown beside its field; `blocked`: the first of them, the reason
 *   every Save control is off (null when none stands)
 */
export function useForm(record, toForm, toSendFor = asIs, { locked = NONE, problems: problemsOf = null, creating = false } = {}) {
  const toSend = (form) => toSendFor(form, record.data, record.id);
  const values = record.data == null ? null : toForm(record.data);
  const [state, setState] = useState(() => initialFormState(values, record.data));
  /* Following the record, and its locks, are state derived while rendering, not
   * effects: the form never paints a frame with the old values. */
  const current = applyLocks(followRecord(state, values, toSend, record.data), locked);
  if (current !== state) setState(current);

  /* Stable setters: a view may hand them to children and effects. */
  const setForm = useCallback((update) => setState((s) => editForm(s, update)), []);
  const setField = useCallback((key, value) => setState((s) => editForm(s, (form) => ({ ...form, [key]: value }))), []);
  const reset = useCallback(() => setState(resetForm), []);

  const problems = current.form == null || problemsOf == null
    ? NO_PROBLEMS
    : standingProblems(problemsOf(current.form, record.data, current.taken), current.form, current.saved, creating);

  return {
    form: current.form,
    saved: current.saved,
    taken: current.taken,
    generation: current.generation,
    setForm,
    setField,
    dirty: isDirty(current, toSend),
    saving: current.saving,
    reset,
    problems,
    blocked: Object.values(problems)[0] ?? null,
    /** Save: run the command with what the form sends (and what the saved values would)
     *  — it ends at its ack, resolving whether it succeeded — then read the record again;
     *  resolves once that read has landed (formState.js, `saveForm`). */
    save: (send) => saveForm(() => send(toSend(current.form), toSend(current.saved)), record.reread, setState),
  };
}

/**
 * State a view keeps on a form as it is now — an open confirm, a row editor, a revealed
 * secret, anything pending on the form's values as they were: it belongs to the form's
 * `generation`, and a reset of the form drops it (a failed save does not).
 *
 * @template T
 * @param {number} generation — the form's, from `useForm`
 * @returns {[T | null, (value: T | null | ((value: T | null) => T | null)) => void]}
 */
export function useHeld(generation) {
  const [held, setHeld] = useState(null);
  /* The form's generation as last rendered: a setter kept from an older one writes
   * nothing (formState.js, `writeHeld`). */
  const now = useRef(generation);
  useEffect(() => { now.current = generation; }, [generation]);
  const value = held != null && held.generation === generation ? held.value : null;
  const set = useCallback((next) => setHeld((was) => writeHeld(was, generation, now.current, next)), [generation]);
  return [value, set];
}
