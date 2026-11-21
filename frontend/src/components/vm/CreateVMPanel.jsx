import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

import { useCommand } from '../../hooks/useCommand.js';
import { useJobProgress } from '../../hooks/useJobProgress.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { createVM } from '../../api/vms.js';
import GeneralSection from '../sections/GeneralSection.jsx';
import DisksSection from '../sections/DisksSection.jsx';
import AdvancedSection from '../sections/AdvancedSection.jsx';
import VmNetworkInterfacesSection from '../sections/VmNetworkInterfacesSection.jsx';
import CloudInitSection from '../sections/CloudInitSection.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { createVmBody, defaultVmDraft, draftProblem, generalProblems, takesCloudInit, withGeneral } from './vmDraft.js';

const NO_BRIDGES = [];

const STEP_LABELS = {
  validating: 'Validating…',
  copying: 'Copying image…',
  resizing: 'Resizing disk…',
  'creating-disk': 'Creating disk…',
  cloudinit: 'Generating cloud-init ISO…',
  defining: 'Defining VM…',
  done: 'Done ✓',
  error: 'Error',
};

export default function CreateVMPanel() {
  const navigate = useNavigate();

  /* The only state of the VM being created (vmDraft.js): each section reads and writes
   * its part, and the request is made from it once, at Create. */
  const [draft, setDraft] = useState(defaultVmDraft);
  const bridges = useRecord(RECORD.HOST_BRIDGES).data ?? NO_BRIDGES;
  /* The create: a job, busy until it ended; its progress shows by the Create button. */
  const create = useCommand();
  const creating = create.busy;
  const [createJobId, setCreateJobId] = useState(null);
  const activeCreate = useJobProgress(createJobId);

  /* The create job outlives this panel (it keeps running in the jobs
   * tray), so its completion only opens the new workload while the user is
   * still here — never yanks them away from wherever they went meanwhile. */
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  /* What the sections show of the VM besides their own values. */
  const config = {
    name: draft.general.name,
    state: 'creating',
    features: draft.general.osType === 'Windows' ? { hyperv: true } : {},
  };

  /* A section's writes: functional updates of its part of the draft. */
  const part = (key) => (update) => setDraft((d) => ({ ...d, [key]: update(d[key]) }));
  const onGeneral = (update) => setDraft((d) => withGeneral(d, update(d.general)));

  /* A CPU or RAM the server refuses shows its problem under its field and keeps Create
   * off, with the reason; what has no field of its own (a name, a disk image) is said
   * when Create is clicked. */
  const fieldProblem = Object.values(generalProblems(draft.general))[0] ?? null;

  const handleCreate = () => {
    const problem = draftProblem(draft);
    if (problem) {
      create.fail(problem);
      return;
    }
    const spec = createVmBody(draft, bridges);
    create.run(() => createVM(spec), {
      job: true,
      onAck: ({ jobId }) => setCreateJobId(jobId),
      onDone: (result) => {
        if (mountedRef.current) navigate(`/vm/${encodeURIComponent(result.name)}/overview`);
      },
    }).then(() => setCreateJobId(null));
  };

  const displayStep = activeCreate?.step ?? (creating ? 'validating' : null);
  const displayPercent = activeCreate?.percent ?? null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col overflow-y-auto px-6 py-5">
        <div className="space-y-5">
          <GeneralSection draft={draft.general} onDraft={onGeneral} />
          <DisksSection draft={draft.disks} onDraft={part('disks')} />
          {takesCloudInit(draft) && (
            <CloudInitSection vmConfig={config} draft={draft.cloudInit} onDraft={part('cloudInit')} />
          )}
          <VmNetworkInterfacesSection draft={draft.nics} onDraft={part('nics')} />
          <AdvancedSection vmConfig={config} draft={draft.advanced} onDraft={part('advanced')} />
        </div>

        <ErrorBanner className="mt-4" error={create.error} onDismiss={create.dismiss} />

        <div className="sticky bottom-0 mt-8 flex flex-col gap-2 rounded-lg border border-surface-border bg-surface-card p-4">
          {creating && (
            <p className="text-sm text-text-secondary">
              {STEP_LABELS[displayStep] || displayStep || 'Working…'}
              {displayPercent != null && ` ${Math.round(displayPercent)}%`}
            </p>
          )}
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !!fieldProblem}
            title={fieldProblem ?? undefined}
            className="flex items-center justify-center gap-2 rounded-lg bg-accent px-6 py-3 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-60 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {creating && <Loader2 size={18} className="animate-spin" />}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
