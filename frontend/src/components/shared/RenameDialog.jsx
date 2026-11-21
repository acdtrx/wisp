import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useForm.js';
import { autoFocusField } from '../../lib/focus.js';
import FormModal from './FormModal.jsx';
import { FormField } from './FormModalChrome.jsx';

/**
 * Rename a stopped workload: `PATCH { name }` (`update`). At its ack `onRenamed(name)`
 * moves the page to the new name (the server takes the name as sent, once it is valid).
 * `maxLength` is the kind's name rule; `hint` says what follows the name.
 */
export default function RenameDialog({ name, maxLength, hint, update, onRenamed, onClose }) {
  const { form, setField } = useEditor({ name });
  const save = useCommand();
  const next = form.name.trim();
  const blocked = next === '' ? 'A name is required' : (next === name ? 'Nothing changed' : null);
  return (
    <FormModal
      title="Rename"
      subtitle={name}
      saveLabel="Rename"
      save={save}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => save.run(() => update({ name: next })).then((ok) => {
        if (!ok) return;
        onClose();
        onRenamed(next);
      })}
    >
      <FormField label="New name" htmlFor="workload-new-name" hint={hint}>
        <input
          id="workload-new-name"
          ref={autoFocusField}
          type="text"
          value={form.name}
          onChange={(e) => setField('name', e.target.value)}
          maxLength={maxLength}
          spellCheck={false}
          autoComplete="off"
          className="input-field font-mono"
        />
      </FormField>
    </FormModal>
  );
}
