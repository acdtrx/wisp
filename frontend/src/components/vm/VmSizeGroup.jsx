import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { changedFields, NOTHING_CHANGED } from '../../hooks/editorValues.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import IconButton from '../shared/IconButton.jsx';
import Card from '../shared/Card.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import { formatMemory } from '../../utils/formatters.js';
import {
  CUSTOM_SIZE, SIZE_PRESETS, coresText, sizeForm, sizeProblems, sizeSent, withPreset,
} from './vmForms.js';
import RadioPills from '../shared/RadioPills.jsx';

/** The VM's cores and memory: a preset or a custom size, changed while it is shut off. */
export default function VmSizeGroup({ config, busy, lockReason, update }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card
      title="Size"
      lockReason={lockReason ? 'Stop the VM to change its size' : undefined}
      actions={<IconButton icon={Pencil} label="Change size" reason={busy ?? lockReason} onClick={() => setEditing(true)} />}
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
      <RadioPills
        variant="card"
        className="grid-cols-2 sm:grid-cols-4"
        label="Size"
        options={PRESET_CHOICES}
        value={form.preset}
        onChange={(v) => setForm((f) => withPreset(f, v))}
      />
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
