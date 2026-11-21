import { useState } from 'react';

import { beginSave, endSave, failSave, followRecord, initialFormState, isDirty } from './formState.js';

/**
 * A form that stages edits behind a Save or a confirm (docs/FRONTEND-RULES.md, Data),
 * following its record by value (formState.js).
 *
 * @template F
 * @param {unknown} record — the saved record (null before it loads: `form` is null)
 * @param {(record: any) => F} toForm — the record's values as this form shows them
 * @returns {{ form: F, saved: F, setForm: (update: (form: F) => F) => void, setField: (key: string, value: unknown) => void,
 *   dirty: boolean, reset: () => void, save: <T>(send: (form: F) => Promise<T>) => Promise<T> }}
 */
export function useForm(record, toForm) {
  const values = record == null ? null : toForm(record);
  const [state, setState] = useState(() => initialFormState(values));
  /* Following the record is state derived while rendering, not an effect: the form
   * never paints a frame with the old values. */
  const current = followRecord(state, values);
  if (current !== state) setState(current);

  return {
    form: current.form,
    /** What the form counts as saved: the record's values. */
    saved: current.saved,
    setForm: (update) => setState((s) => ({ ...s, form: update(s.form) })),
    setField: (key, value) => setState((s) => ({ ...s, form: { ...s.form, [key]: value } })),
    dirty: isDirty(current),
    reset: () => setState((s) => ({ ...s, form: s.saved })),
    /** Run the save's command with the form; the form follows its record again when it ends. Rejects with its error. */
    save: async (send) => {
      setState(beginSave);
      try {
        const result = await send(current.form);
        setState(endSave);
        return result;
      } catch (err) {
        setState(failSave);
        throw err;
      }
    },
  };
}
