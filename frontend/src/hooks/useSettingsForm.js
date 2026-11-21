import { useCallback, useEffect, useRef, useState } from 'react';
import { RECORD } from '../store/records.js';
import { useRecord } from './useRecord.js';

/**
 * Keeps a settings form in step with the settings record (specs/SETTINGS.md,
 * Saving and live updates).
 *
 * `reset(settings)` seeds the form. It runs on the first settings, on every load
 * whose content changed (whichever tab or section saved), and on any load while a
 * save is pending — so a load always resolves a save, even one the server stored
 * nothing new for (a blank field the form left out). A load with unchanged content
 * and no pending save leaves the form, and its unsaved edits, alone.
 *
 * `save(values, send)` runs `send()`. Once it answers without an error, `sent`
 * holds `values`, what the form counts as saved, until the next load resets the
 * form. It resolves `true` when the form holds them, `false` when a load already
 * landed and reset it.
 */
export function useSettingsForm(reset) {
  const record = useRecord(RECORD.SETTINGS);
  const settings = record.data;
  const loadCount = record.reads;
  const [sent, setSent] = useState(null);
  const seededFrom = useRef(null);
  const pending = useRef(false);
  const resetRef = useRef(reset);

  useEffect(() => {
    resetRef.current = reset;
  });

  useEffect(() => {
    if (!settings) return;
    if (settings === seededFrom.current && !pending.current) return;
    seededFrom.current = settings;
    pending.current = false;
    setSent(null);
    resetRef.current(settings);
  }, [settings, loadCount]);

  const save = useCallback(async (values, send) => {
    pending.current = true;
    try {
      await send();
    } catch (err) {
      pending.current = false;
      throw err;
    }
    if (!pending.current) return false;
    setSent(values);
    return true;
  }, []);

  return { settings, sent, save };
}
