import { AlertTriangle, Shuffle } from 'lucide-react';

import { FormField } from '../shared/FormModalChrome.jsx';
import NicModelPills from './NicModelPills.jsx';
import { randomMac } from '../../utils/randomMac.js';
import { autoFocusField } from '../../lib/focus.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import FormModal from '../shared/FormModal.jsx';
import { NOTHING_CHANGED } from '../../hooks/editorValues.js';
import IconButton from '../shared/IconButton.jsx';


/* A new NIC starts on the first host bridge with a fresh locally-administered
 * MAC — the same defaults the create-flow draft rows use. */
function formFromNic(nic, bridges) {
  if (!nic) return { source: bridges[0] || '', model: 'virtio', mac: randomMac() };
  return { source: nic.source || '', model: nic.model || 'virtio', mac: nic.mac || '' };
}

/** What Save writes for the values: the MAC trimmed and in lower case. */
const nicSent = (form) => ({ source: form.source, model: form.model, mac: form.mac.trim().toLowerCase() });

/**
 * Modal form editor for one VM network interface — create when `opened` is null, edit
 * the NIC at `index` otherwise (see docs/FRONTEND-RULES.md § Modal form editor). It
 * takes the NIC's values when it opens. The section owns the full-array PATCH
 * (`onSubmit(fields, index)`).
 */
export default function NicEditorModal(props) {
  return props.open ? <NicEditor {...props} /> : null;
}

function NicEditor({ index, opened, bridges = [], onSubmit, onClose }) {
  const isEdit = opened != null;
  const { form, start, dirty, setField } = useEditor(() => formFromNic(opened, bridges));
  const save = useCommand();
  const saving = save.busy;

  /* An edit needs a change; a new NIC only its values (they are all valid). */
  const canSave = (!isEdit || dirty) && !saving;

  /* cloud-init writes the network config against the first NIC's MAC. */
  const macBreaksCloudInit = isEdit && index === 0 && nicSent(form).mac !== start.mac.trim().toLowerCase();

  const handleSave = () => {
    if (!canSave) return;
    save.run(() => onSubmit(nicSent(form), isEdit ? index : null)).then((ok) => { if (ok) onClose(); });
  };

  return (
    <FormModal
      title={isEdit ? 'Edit network interface' : 'Add network interface'}
      subtitle={`net${index} · bridged`}
      size="md"
      save={save}
      blocked={isEdit && !dirty ? NOTHING_CHANGED : null}
      onSubmit={handleSave}
      onClose={onClose}
    >
      <FormField label="Bridge" htmlFor="nic-editor-bridge">
        <select
          id="nic-editor-bridge"
          value={form.source}
          onChange={(e) => setField('source', e.target.value)}
          ref={!isEdit ? autoFocusField : undefined}
          className="input-field"
        >
          {!form.source && <option value="">Select…</option>}
          {bridges.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
          {form.source && !bridges.includes(form.source) && (
            <option value={form.source}>{form.source}</option>
          )}
        </select>
      </FormField>
      <FormField label="Model">
        <NicModelPills
          value={form.model}
          onChange={(v) => setField('model', v)}
        />
      </FormField>
      <FormField
        label="MAC address"
        htmlFor="nic-editor-mac"
        hint={macBreaksCloudInit ? (
          <span className="inline-flex items-center gap-1 text-status-warning">
            <AlertTriangle size={12} aria-hidden />
            If this VM uses cloud-init, re-save cloud-init after changing the MAC.
          </span>
        ) : null}
      >
        <div className="flex items-center gap-2">
          <input
            id="nic-editor-mac"
            type="text"
            value={form.mac}
            onChange={(e) => setField('mac', e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="input-field min-w-0 flex-1 font-mono"
          />
          <IconButton variant="field" icon={Shuffle} label="Randomize MAC" className="self-stretch" onClick={() => setField('mac', randomMac())} />
        </div>
      </FormField>
    </FormModal>
  );
}
