import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { changedFields, NOTHING_CHANGED } from '../../hooks/editorValues.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import Card from '../shared/Card.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import { formatMemory } from '../../utils/formatters.js';
import {
  CUSTOM_SIZE, SIZE_PRESETS, coresText, sizeForm, sizeProblems, sizeSent, withPreset,
} from './vmForms.js';

/** The VM's cores and memory: a preset or a custom size, changed while it is shut off. */
export default function VmSizeGroup({ config, busy, lockReason, update }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card
      title="Size"
      lockReason={lockReason ? 'Stop the VM to change its size' : undefined}
      actions={<GroupAction icon={Pencil} label="Change size" reason={busy ?? lockReason} onClick={() => setEditing(true)} />}
    >
      <ValueRows
        rows={[
          { label: 'CPU', value: coresText(config.vcpus ?? 1) },
          { label: 'Memory', value: formatMemory(config.memoryMiB) },
        ]}
      />
      {editing && <SizeEditor config={config} update={update} onClose={() => setEditing(false)} />}
    </Card>
  );
}

const PRESET_CHOICES = [
  ...SIZE_PRESETS.map((p) => ({ value: p.value, label: p.label, detail: `${coresText(p.vcpus)}, ${formatMemory(p.memoryMiB)}` })),
  { value: CUSTOM_SIZE, label: 'Custom', detail: 'Your own' },
];

function SizeEditor({ config, update, onClose }) {
  const { form, start, setForm, setField, dirty } = useEditor(() => sizeForm(config));
  const save = useCommand();
  const problems = sizeProblems(form);
  const blocked = Object.values(problems)[0] ?? (dirty ? null : NOTHING_CHANGED);
  return (
    <FormModal
      title="Size"
      subtitle={config.name}
      save={save}
      blocked={blocked}
      onClose={onClose}
      size="md"
      onSubmit={() => save.run(() => update(changedFields(sizeSent(form), sizeSent(start)))).then((ok) => { if (ok) onClose(); })}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Size">
        {PRESET_CHOICES.map((p) => {
          const on = form.preset === p.value;
          return (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => setForm((f) => withPreset(f, p.value))}
              className={`rounded-md border px-2.5 py-2 text-left transition-colors duration-150 ${on ? 'border-accent bg-accent-soft text-accent-text' : 'border-surface-border text-text-secondary hoverable:hover:bg-surface'}`}
            >
              <span className="block text-sm font-medium">{p.label}</span>
              <span className="block text-[11px] text-text-muted">{p.detail}</span>
            </button>
          );
        })}
      </div>
      {form.preset === CUSTOM_SIZE && (
        <div className="grid grid-cols-2 gap-3">
          <FormField label="CPU cores" htmlFor="vm-cores" hint={problems.vcpus}>
            <input id="vm-cores" type="text" inputMode="numeric" value={form.vcpus} onChange={(e) => setField('vcpus', e.target.value)} className="input-field" />
          </FormField>
          <FormField label="Memory (GB)" htmlFor="vm-memory" hint={problems.memoryGB}>
            <input id="vm-memory" type="text" inputMode="decimal" value={form.memoryGB} onChange={(e) => setField('memoryGB', e.target.value)} className="input-field" />
          </FormField>
        </div>
      )}
    </FormModal>
  );
}
