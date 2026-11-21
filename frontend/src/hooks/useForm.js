import { useCallback, useState } from 'react';

import { beginSave, editForm, endSave, failSave, followRecord, initialFormState, isDirty, resetForm, sameValues } from './formState.js';

const asIs = (values) => values;

/**
 * A form that edits a record (docs/FRONTEND-RULES.md, Data; formState.js): it shows the
 * record and follows it while it is clean; from the first edit until Save succeeds or
 * the edit is undone it keeps the user's values. Validation is the view's, over the
 * form's values: a form with a problem is not saved.
 *
 * @template F, S
 * @param {{ data: unknown, id?: unknown }} record — as `useRecord` answers it (`data`
 *   null before it loads, or when gone: `form` is null)
 * @param {(data: any) => F} toForm — the record's values as this form shows them (pure)
 * @param {(form: F, data: any, id: any) => S} [toSend] — what Save sends for the values,
 *   given the record's data and the id it is read by (pure)
 * @returns {{ form: F, start: F, setForm: (update: (form: F) => F) => void,
 *   setField: (key: string, value: unknown) => void, dirty: boolean, saving: boolean,
 *   reset: () => void, save: (send: (values: S, start: S) => Promise<boolean>) => Promise<boolean> }}
 *   `save` runs the command with what the form and its starting values send; it
 *   resolves whether the command succeeded
 */
export function useForm(record, toForm, toSend = asIs) {
  const [state, setState] = useState(() => initialFormState(record.data, toForm));
  const current = followRecord(state, record.data, toForm);
  if (current !== state) setState(current);
  const sent = (values) => (values == null ? values : toSend(values, record.data, record.id));
  /* Stable setters: a view may hand them to children and effects. */
  const setForm = useCallback((update) => setState((s) => editForm(s, update)), []);
  const setField = useCallback((key, value) => setState((s) => editForm(s, (form) => ({ ...form, [key]: value }))), []);

  return {
    form: current.form,
    start: current.start,
    setForm,
    setField,
    dirty: isDirty(current),
    saving: current.saving,
    reset: () => setState((s) => resetForm(s, toForm)),
    save: async (send) => {
      setState(beginSave);
      const ok = await send(sent(current.form), sent(current.start));
      setState((s) => (ok ? endSave(s, toForm) : failSave(s)));
      return ok;
    },
  };
}

/**
 * A modal editor's values: taken when it opens (`initial`, or a function making them)
 * and never from its record again. Save sends them; success closes the editor.
 *
 * @template F
 * @param {F | (() => F)} initial
 * @returns {{ form: F, start: F, setForm: (update: F | ((form: F) => F)) => void,
 *   setField: (key: string, value: unknown) => void, dirty: boolean }}
 */
export function useEditor(initial) {
  const [start] = useState(initial);
  const [form, setForm] = useState(start);
  const setField = useCallback((key, value) => setForm((f) => ({ ...f, [key]: value })), []);
  return {
    form,
    start,
    setForm,
    setField,
    dirty: !sameValues(form, start),
  };
}
