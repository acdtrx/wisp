import { useCallback, useState } from 'react';

import { sameValues } from './editorValues.js';

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
