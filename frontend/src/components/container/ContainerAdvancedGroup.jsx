import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { changedFields } from '../../hooks/editorValues.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import { formatCommandLine } from '../../utils/commandLine.js';
import FormModal from '../shared/FormModal.jsx';
import { FormCheckbox, FormField } from '../shared/FormModalChrome.jsx';
import GroupAction from '../shared/GroupAction.jsx';
import Card from '../shared/Card.jsx';
import RecordError from '../shared/RecordError.jsx';
import ValueRows from '../shared/ValueRows.jsx';
import { advancedForm, advancedProblems, advancedSent } from './containerForms.js';

const NO_GPUS = [];

const gpuName = (gpu) => [gpu.vendorName || gpu.vendor, gpu.model].filter(Boolean).join(' ');

/** The host's GPUs a container can share (`/dev/dri/renderD*`), once read. */
function useHostGpus() {
  const record = useRecord(RECORD.HOST_GPUS);
  return { record, gpus: Array.isArray(record.data?.gpus) ? record.data.gpus : NO_GPUS };
}

/** What the container runs and as whom, and the host devices it shares. */
export default function ContainerAdvancedGroup({ config, busy, update }) {
  const [editing, setEditing] = useState(false);
  const { gpus } = useHostGpus();
  const device = (config.devices ?? []).find((d) => d?.type === 'gpu')?.device ?? null;
  const gpu = device ? gpus.find((g) => g.device === device) : null;
  const command = Array.isArray(config.command) && config.command.length > 0
    ? formatCommandLine(config.command.map((a) => String(a ?? '')))
    : null;

  return (
    <Card
      title="Advanced"
      actions={<GroupAction icon={Pencil} label="Edit advanced settings" reason={busy} onClick={() => setEditing(true)} />}
    >
      <ValueRows
        rows={[
          { label: 'Command', value: command ?? 'The image’s own', mono: command != null },
          { label: 'Runs as', value: config.runAsRoot ? 'root' : 'Wisp’s user' },
          { label: 'Shared devices', value: device ? `GPU ${gpu ? gpuName(gpu) : device}` : 'None' },
        ]}
      />
      {editing && <AdvancedEditor config={config} update={update} onClose={() => setEditing(false)} />}
    </Card>
  );
}

function AdvancedEditor({ config, update, onClose }) {
  const { form, start, setField, dirty } = useEditor(() => advancedForm(config));
  const save = useCommand();
  const { record, gpus } = useHostGpus();
  const problems = advancedProblems(form);
  const blocked = Object.values(problems)[0] ?? (dirty ? null : 'Nothing changed');
  /* A device the config names that the host no longer has stays a choice. */
  const choices = form.gpu && !gpus.some((g) => g.device === form.gpu) ? [...gpus, { device: form.gpu }] : gpus;

  return (
    <FormModal
      title="Advanced"
      subtitle={config.name}
      save={save}
      blocked={blocked}
      onClose={onClose}
      size="md"
      onSubmit={() => save.run(() => update(changedFields(advancedSent(form), advancedSent(start))))
        .then((ok) => { if (ok) onClose(); })}
    >
      <FormField
        label="Command"
        htmlFor="container-command"
        hint={problems.command ?? 'Arguments quoted like a shell: \'a b\' is one. No shell runs; for pipes or $VARS use sh -c \'…\'. Empty: the image’s own.'}
      >
        <input
          id="container-command"
          type="text"
          value={form.command}
          onChange={(e) => setField('command', e.target.value)}
          placeholder="The image’s own"
          spellCheck={false}
          autoComplete="off"
          className="input-field font-mono"
        />
      </FormField>
      <FormCheckbox
        label="Run as root"
        hint="For images that need user 0 inside the container. Off: it runs as Wisp’s user."
        checked={form.runAsRoot}
        onChange={(e) => setField('runAsRoot', e.target.checked)}
      />
      <RecordError record={record} what="host GPUs" />
      <FormField
        label="Share a host GPU"
        htmlFor="container-gpu"
        hint={record.data != null && gpus.length === 0 ? 'The host has no Intel or AMD render node to share.' : 'For hardware video encoding and decoding.'}
      >
        <select
          id="container-gpu"
          value={form.gpu}
          onChange={(e) => setField('gpu', e.target.value)}
          disabled={choices.length === 0}
          className="input-field"
        >
          <option value="">None</option>
          {choices.map((g) => <option key={g.device} value={g.device}>{g.vendor ? `${gpuName(g)} (${g.device})` : g.device}</option>)}
        </select>
      </FormField>
    </FormModal>
  );
}
