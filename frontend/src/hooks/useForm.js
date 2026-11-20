import { useState } from 'react';

import { afterSave, beginSave, failedSave, followRecord, initialFormState, isDirty } from './formState.js';

/**
 * A form that stages edits behind a Save or a confirm (docs/FRONTEND-RULES.md, Data),
 * following its record by value (formState.js).
 *
 * @template F
 * @param {unknown} record — the saved record (null before it loads: `form` is null)
 * @param {(record: any) => F} toForm — the record's values as this form shows them
 * @param {number} [reads] — the record's answered reads (`useRecord(…).reads`); a form
 *   over a value that is not re-read (a modal's row) leaves it out
 * @returns {{ form: F, saved: F, setForm: (update: (form: F) => F) => void, setField: (key: string, value: unknown) => void,
 *   dirty: boolean, reset: () => void, save: <T>(send: (form: F) => Promise<T>) => Promise<T> }}
 */
export function useForm(record, toForm, reads = 0) {
  const values = record == null ? null : toForm(record);
  const [state, setState] = useState(() => initialFormState(values));
  /* Following the record is state derived while rendering, not an effect: the form
   * never paints a frame with the old values. */
  const current = followRecord(state, values, reads);
  if (current !== state) setState(current);

  return {
    form: current.form,
    /** What the form counts as saved (the record's values, or what a save sent). */
    saved: current.saved,
    setForm: (update) => setState((s) => ({ ...s, form: update(s.form) })),
    setField: (key, value) => setState((s) => ({ ...s, form: { ...s.form, [key]: value } })),
    dirty: isDirty(current),
    reset: () => setState((s) => ({ ...s, form: s.saved })),
    /** Send the form; once `send` answers, what it sent counts as saved. Rejects with its error. */
    save: async (send) => {
      const sent = current.form;
      setState((s) => beginSave(s, reads));
      let result;
      try {
        result = await send(sent);
      } catch (err) {
        setState(failedSave);
        throw err;
      }
      setState((s) => afterSave(s, sent));
      return result;
    },
  };
}
