import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useForm.js';
import { autoFocusField } from '../../lib/focus.js';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';

/**
 * Rename a stopped container: `PATCH { name }`. At its ack `onRenamed(name)` moves the
 * page to the new name (the server takes the name as sent, once it is valid).
 */
export default function ContainerRenameDialog({ name, update, onRenamed, onClose }) {
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
      <FormField label="New name" htmlFor="container-new-name" hint="Letters, digits, dots, dashes and underscores; its page, logs and local name follow it.">
        <input
          id="container-new-name"
          ref={autoFocusField}
          type="text"
          value={form.name}
          onChange={(e) => setField('name', e.target.value)}
          maxLength={63}
          spellCheck={false}
          autoComplete="off"
          className="input-field font-mono"
        />
      </FormField>
    </FormModal>
  );
}
