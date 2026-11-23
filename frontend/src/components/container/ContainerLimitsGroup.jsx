import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { changedFields, NOTHING_CHANGED } from '../../hooks/editorValues.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import IconButton from '../shared/IconButton.jsx';
import Card from '../shared/Card.jsx';
import RadioPills from '../shared/RadioPills.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import { formatMemory } from '../../utils/formatters.js';
import { RESTART_POLICIES, limitsForm, limitsProblems, limitsSent, restartPolicyText } from './containerForms.js';

const cores = (n) => `${n} ${Number(n) === 1 ? 'core' : 'cores'}`;

/** How much of the host the container may use, and what happens when it stops. */
export default function ContainerLimitsGroup({ config, busy, update }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card
      title="Limits and restarts"
      actions={<IconButton icon={Pencil} label="Edit limits and restarts" reason={busy} onClick={() => setEditing(true)} />}
    >
      <ValueRows
        rows={[
          { label: 'CPU limit', value: config.cpuLimit == null ? 'None' : cores(config.cpuLimit) },
          { label: 'Memory limit', value: config.memoryLimitMiB == null ? 'None' : formatMemory(config.memoryLimitMiB) },
          { label: 'Restart', value: restartPolicyText(config.restartPolicy) },
        ]}
      />
      {editing && <LimitsEditor config={config} update={update} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function LimitsEditor({ config, update, onClose }) {
  const { form, start, setField, dirty } = useEditor(() => limitsForm(config));
  const save = useCommand();
  const problems = limitsProblems(form);
  const blocked = Object.values(problems)[0] ?? (dirty ? null : NOTHING_CHANGED);
  return (
    <FormModal
      title="Limits and restarts"
      subtitle={config.name}
      save={save}
      blocked={blocked}
      onClose={onClose}
      onSubmit={() => save.run(() => update(changedFields(limitsSent(form), limitsSent(start))))
        .then((ok) => { if (ok) onClose(); })}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="CPU limit (cores)" htmlFor="container-cpu" hint={problems.cpuLimit ?? 'Empty: no limit.'}>
          <input
            id="container-cpu"
            type="text"
            inputMode="decimal"
            value={form.cpuLimit}
            onChange={(e) => setField('cpuLimit', e.target.value)}
            placeholder="None"
            className="input-field"
          />
        </FormField>
        <FormField label="Memory limit (MB)" htmlFor="container-memory" hint={problems.memoryLimitMiB ?? 'Empty: no limit.'}>
          <input
            id="container-memory"
            type="text"
            inputMode="numeric"
            value={form.memoryLimitMiB}
            onChange={(e) => setField('memoryLimitMiB', e.target.value)}
            placeholder="None"
            className="input-field"
          />
        </FormField>
      </div>
      <FormField label="Restart when it stops" hint="Applies at its next stop; stopping it yourself never restarts it.">
        <RadioPills options={RESTART_POLICIES} value={form.restartPolicy} onChange={(v) => setField('restartPolicy', v)} />
      </FormField>
    </FormModal>
  );
}
