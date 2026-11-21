import { useState } from 'react';

import { followRecord, initialFormState, isDirty, saveForm } from './formState.js';

/**
 * A form that stages edits behind a Save or a confirm (docs/FRONTEND-RULES.md, Data),
 * following its record by value (formState.js).
 *
 * @template F
 * @param {{ data: unknown, reread?: () => Promise<boolean> }} record — the saved record, as
 *   `useRecord` answers it (`data` null before it loads: `form` is null); a create
 *   form's draft is `{ data: draft }`, with no save
 * @param {(record: any) => F} toForm — the record's values as this form shows them
 * @returns {{ form: F, saved: F, setForm: (update: (form: F) => F) => void, setField: (key: string, value: unknown) => void,
 *   dirty: boolean, saving: boolean, reset: () => void, save: (send: (form: F) => Promise<boolean>) => Promise<boolean> }}
 */
export function useForm(record, toForm) {
  const values = record.data == null ? null : toForm(record.data);
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
    /** From the command until its re-read has landed: what a Save control shows. */
    saving: current.saving,
    reset: () => setState((s) => ({ ...s, form: s.saved })),
    /** Save: run the command with the form (`send` resolves whether it succeeded, as
     *  the command hook's `run` does), then read the record again; the form follows it
     *  only once that read has landed (formState.js, `saveForm`). */
    save: (send) => saveForm(() => send(current.form), record.reread, setState),
  };
}
