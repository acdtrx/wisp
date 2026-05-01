import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, ArrowLeft } from 'lucide-react';

import { useContainerStore } from '../../store/containerStore.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { JOB_KIND } from '../../api/jobProgress.js';
import { createContainer } from '../../api/containers.js';
import ContainerGeneralSection from '../sections/ContainerGeneralSection.jsx';
import { getAppList } from '../../apps/appRegistry.js';

const STEP_LABELS = {
  validating: 'Validating…',
  'using-local': 'Using local image…',
  pulling: 'Pulling image…',
  pulled: 'Image pulled',
  creating: 'Creating container…',
  done: 'Ready — configure and start when ready',
  error: 'Error',
};

const CONNECTION_LOST_DETAIL =
  'The progress stream closed unexpectedly (e.g. proxy timeout). Check the server: journalctl -u wisp -n 50';

export default function CreateContainerPanel() {
  const navigate = useNavigate();
  const fetchContainers = useContainerStore((s) => s.fetchContainers);
  const registerJob = useBackgroundJobsStore((s) => s.registerJob);
  const jobs = useBackgroundJobsStore((s) => s.jobs);

  const [selectedApp, setSelectedApp] = useState(null);
  const [form, setForm] = useState({
    name: '',
    image: '',
  });

  const [creating, setCreating] = useState(false);
  const [createJobId, setCreateJobId] = useState(null);
  const [createError, setCreateError] = useState(null);
  const [createDetail, setCreateDetail] = useState(null);

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

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    setCreateDetail(null);

    const spec = {
      name: form.name.trim(),
      image: form.image.trim(),
    };
    if (selectedApp) spec.app = selectedApp;

    try {
      const { jobId, title } = await createContainer(spec);
      setCreateJobId(jobId);
      registerJob({
        jobId,
        kind: JOB_KIND.CONTAINER_CREATE,
        title,
        onTerminal: (ev) => {
          if (ev.step === 'done') {
            setCreating(false);
            setCreateJobId(null);
            fetchContainers();
            navigate(`/container/${encodeURIComponent(spec.name)}/overview`);
          }
          if (ev.step === 'error') {
            setCreateError(ev.error || 'Creation failed');
            setCreateDetail(
              ev.error === 'Connection lost' ? CONNECTION_LOST_DETAIL : (ev.detail || null),
            );
            setCreating(false);
            setCreateJobId(null);
          }
        },
      });
    } catch (err) {
      setCreateError(err.message || 'Failed to create container');
      setCreateDetail(err.detail || null);
      setCreating(false);
      setCreateJobId(null);
    }
  };

  const config = {
    name: form.name,
    image: form.image,
    state: 'creating',
  };

  const canCreate = form.name.trim() && form.image.trim() && !creating;

  const row = createJobId ? jobs[createJobId] : null;
  const progressStep = row?.step ?? (creating ? 'validating' : null);
  const progressDetail = row?.detail ?? null;

  const selectedLabel = selectedApp
    ? appList.find((a) => a.id === selectedApp)?.label || selectedApp
    : 'Generic Container';

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
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-surface-border bg-surface-card px-4 py-3">
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

        {createError && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm font-medium text-status-stopped">{createError}</p>
            {createDetail && <p className="mt-1 text-xs text-status-stopped/80">{createDetail}</p>}
          </div>
        )}

        <div className="sticky bottom-0 mt-6 flex items-center justify-end gap-3 border-t border-surface-border bg-surface pt-4 pb-2">
          {creating && progressStep && (
            <div className="flex max-w-[min(100%,28rem)] flex-col items-end gap-0.5 text-xs text-text-muted">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="animate-spin shrink-0" />
                <span>{STEP_LABELS[progressStep] || progressStep}</span>
              </div>
              {progressDetail && (
                <span className="max-w-full break-words text-right text-[11px] leading-snug text-text-muted/90">
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
