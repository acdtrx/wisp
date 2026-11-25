import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import FormModal from '../shared/FormModal.jsx';
import { NOTHING_CHANGED } from '../../hooks/editorValues.js';
import { changedSent } from './settingsForms.js';

/**
 * A settings group's form (docs/specs/SETTINGS.md): it starts from the settings as they
 * are when it opens (`initial`) and never follows them; Save sends one request, `send`
 * with only the fields of `sent(form)` that changed. `problem(form)` says why it cannot
 * be saved (shown in the form, and on Save); nothing changed is no save either. `send`
 * also gets the whole form, for a request that must name a field it did not change.
 * `children` renders the fields from `{ form, setField, setForm }`.
 */
export default function SettingsEditor({ title, subtitle, initial, sent, problem, send, onClose, size, children }) {
  const { form, setField, setForm, start } = useEditor(initial);
  const save = useCommand();
  const changed = changedSent(sent, form, start);
  const why = problem?.(form) ?? null;
  const blocked = why ?? (Object.keys(changed).length === 0 ? NOTHING_CHANGED : null);
  return (
    <FormModal
      title={title}
      subtitle={subtitle}
      save={save}
      blocked={blocked}
      onClose={onClose}
      size={size}
      onSubmit={() => save.run(() => send(changed, form)).then((ok) => { if (ok) onClose(); })}
    >
      {children({ form, setField, setForm })}
      {why && <p className="text-[11px] text-status-stopped">{why}</p>}
    </FormModal>
  );
}
