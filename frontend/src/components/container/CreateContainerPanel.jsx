import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';

import { useCommand } from '../../hooks/useCommand.js';
import { useJobProgress } from '../../hooks/useJobProgress.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { createContainer } from '../../api/containers.js';
import ContainerGeneralSection from '../sections/ContainerGeneralSection.jsx';
import { getAppList } from '../../apps/appRegistry.js';

const STEP_LABELS = {
  validating: 'Validating…',
  'using-local': 'Using local image…',
  pulling: 'Pulling image…',
  pulled: 'Image pulled',
  creating: 'Creating container…',
  created: 'Finishing…',
  done: 'Ready — configure and start when ready',
  error: 'Error',
};

export default function CreateContainerPanel() {
  const navigate = useNavigate();

  const [selectedApp, setSelectedApp] = useState(null);
  const [form, setForm] = useState({
    name: '',
    image: '',
  });

  /* The create: a job, busy until it ended; its progress shows by the Create button. */
  const create = useCommand();
  const creating = create.busy;
  const [createJobId, setCreateJobId] = useState(null);
  const row = useJobProgress(createJobId);

  /* The create job outlives this panel (it keeps running in the jobs
   * tray), so its completion only opens the new workload while the user is
   * still here — never yanks them away from wherever they went meanwhile. */
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const appList = getAppList();

  const handleSelectApp = (appId) => {
    const next = appId || null;
    if (next === selectedApp) return;
    setSelectedApp(next);
    if (next) {
      const app = appList.find((a) => a.id === next);
      if (app?.defaultImage) {
        setForm((prev) => ({ ...prev, image: app.defaultImage }));
      }
    } else {
      setForm((prev) => ({ ...prev, image: '' }));
    }
  };

  const handleFormChange = (changes) => {
    setForm((prev) => ({ ...prev, ...changes }));
  };

  const handleCreate = () => {
    const spec = {
      name: form.name.trim(),
      image: form.image.trim(),
    };
    if (selectedApp) spec.app = selectedApp;

    create.run(() => createContainer(spec), {
      job: true,
      onAck: ({ jobId }) => setCreateJobId(jobId),
      onDone: () => {
        if (mountedRef.current) navigate(`/container/${encodeURIComponent(spec.name)}/overview`);
      },
    }).then(() => setCreateJobId(null));
  };

  const config = {
    name: form.name,
    image: form.image,
    state: 'creating',
  };

  const canCreate = form.name.trim() && form.image.trim() && !creating;

  const progressStep = row?.step ?? (creating ? 'validating' : null);
  const progressDetail = row?.detail ?? null;

  const appSelector = (
    <select
      value={selectedApp || ''}
      onChange={(e) => handleSelectApp(e.target.value)}
      className="input-field h-7 text-[11px] min-w-[140px]"
    >
      <option value="">Generic Container</option>
      {appList.map((app) => (
        <option key={app.id} value={app.id}>{app.label}</option>
      ))}
    </select>
  );

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-3 border-b border-surface-border bg-surface-card px-4 py-3">
        <button
          onClick={() => navigate('/host/overview')}
          className="rounded-md p-1 text-text-muted hover:text-text-primary hover:bg-surface transition-colors duration-150"
          title="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-sm font-semibold text-text-primary">Create Container</h2>
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto px-6 py-5">
        <div className="space-y-5">
          <p className="text-xs text-text-muted">
            Enter a name and image. After creation the container stays stopped so you can configure it, then start it from the overview.
          </p>

          <ContainerGeneralSection
            config={config}
            isCreating
            onSave={() => Promise.resolve({})}
            onFormChange={handleFormChange}
            headerAction={appSelector}
          />
        </div>

        <ErrorBanner className="mt-4" error={create.error} onDismiss={create.dismiss} />

        <div className="sticky bottom-0 mt-6 flex items-center justify-end gap-3 border-t border-surface-border bg-surface pt-4 pb-2">
          {creating && progressStep && (
            <div className="flex max-w-[min(100%,28rem)] flex-col items-end gap-0.5 text-xs text-text-muted">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin shrink-0" />
                <span>{STEP_LABELS[progressStep] || progressStep}</span>
              </div>
              {progressDetail && (
                <span className="max-w-full wrap-break-word text-right text-[11px] leading-snug text-text-muted/90">
                  {progressDetail}
                </span>
              )}
            </div>
          )}
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            className="flex items-center gap-2 rounded-md bg-accent px-5 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150"
          >
            {creating ? <Loader2 size={16} className="animate-spin" /> : null}
            Create Container
          </button>
        </div>
      </div>
    </div>
  );
}
