import {
  useState, useMemo, useEffect, lazy, Suspense,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Play, Square, Zap, RotateCcw, Trash2, Archive, Loader2, X,
} from 'lucide-react';

import { useContainerStore } from '../../store/containerStore.js';
import { useSectionsStore } from '../../store/sectionsStore.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { updateContainer } from '../../api/containers.js';
import { startContainerBackup } from '../../api/backups.js';
import { getSettings } from '../../api/settings.js';
import { JOB_KIND } from '../../api/jobProgress.js';
import { getVmIcon, getDefaultContainerIconId } from '../shared/vmIcons.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import BackupModal from '../shared/BackupModal.jsx';
import ContainerGeneralSection from '../sections/ContainerGeneralSection.jsx';
import ContainerEnvSection from '../sections/ContainerEnvSection.jsx';
import ContainerMountsSection from '../sections/ContainerMountsSection.jsx';
import ContainerNetworkSection from '../sections/ContainerNetworkSection.jsx';
import ContainerDevicesSection from '../sections/ContainerDevicesSection.jsx';
import ContainerLogsSection from '../sections/ContainerLogsSection.jsx';
import { CONTAINER_STATE_ICON_COLOR } from '../../utils/containerConstants.js';
import { getAppEntry } from '../../apps/appRegistry.js';
import AppConfigWrapper from '../../apps/AppConfigWrapper.jsx';

const ContainerConsolePanel = lazy(() => import('../console/ContainerConsolePanel.jsx'));

function ActionButton({ icon: Icon, label, onClick, disabled, variant = 'default', loading }) {
  const base = 'flex items-center justify-center rounded-md p-2 text-sm font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    default: 'border border-surface-border text-text-secondary hover:bg-surface hover:text-text-primary',
    danger: 'border border-red-200 text-status-stopped hover:bg-red-50',
    primary: 'bg-accent text-white hover:bg-accent-hover',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      title={label}
      aria-label={label}
      className={`${base} ${variants[variant]}`}
    >
      {loading ? <Loader2 size={18} className="animate-spin" /> : <Icon size={18} />}
    </button>
  );
}

export default function ContainerOverviewPanel() {
  const config = useContainerStore((s) => s.containerConfig);
  const loading = useContainerStore((s) => s.loading);
  const actionLoading = useContainerStore((s) => s.actionLoading);
  const error = useContainerStore((s) => s.error);
  const clearError = useContainerStore((s) => s.clearError);
  const startContainer = useContainerStore((s) => s.startContainer);
  const stopContainer = useContainerStore((s) => s.stopContainer);
  const killContainer = useContainerStore((s) => s.killContainer);
  const restartContainer = useContainerStore((s) => s.restartContainer);
  const deleteContainer = useContainerStore((s) => s.deleteContainer);
  const selectContainer = useContainerStore((s) => s.selectContainer);
  const refreshSelectedContainer = useContainerStore((s) => s.refreshSelectedContainer);
  const registerJob = useBackgroundJobsStore((s) => s.registerJob);
  const bgJobs = useBackgroundJobsStore((s) => s.jobs);

  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab === 'console' ? 'console' : tab === 'logs' ? 'logs' : 'overview';

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [backupModalOpen, setBackupModalOpen] = useState(false);
  const [backupDestinations, setBackupDestinations] = useState([]);
  const [backupSelectedIds, setBackupSelectedIds] = useState(['local']);
  const [backupJobId, setBackupJobId] = useState(null);
  const [backupError, setBackupError] = useState(null);

  const containerName = config?.name ?? '';
  const backupTitleForContainer = useMemo(
    () => (containerName ? `Backup ${containerName}` : ''),
    [containerName],
  );
  const backupRunningJob = useMemo(
    () => (backupTitleForContainer
      ? Object.values(bgJobs).find(
        (j) => j.kind === JOB_KIND.CONTAINER_BACKUP
          && j.title === backupTitleForContainer
          && j.status === 'running',
      )
      : undefined),
    [bgJobs, backupTitleForContainer],
  );
  const backupInProgress = !!backupRunningJob;

  useEffect(() => {
    if (!backupJobId) return;
    const row = bgJobs[backupJobId];
    if (row && (row.status === 'done' || row.status === 'error')) {
      setBackupJobId(null);
    }
  }, [backupJobId, bgJobs]);

  useEffect(() => {
    setBackupJobId(null);
    setBackupError(null);
    setBackupModalOpen(false);
  }, [containerName]);

  if (!config && error && !loading) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-status-stopped">{error}</p>
        <button
          type="button"
          onClick={() => { clearError(); navigate('/host/overview'); }}
          className="text-xs text-text-muted hover:text-text-secondary"
        >
          Go to Host overview
        </button>
      </div>
    );
  }

  if (loading || !config) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 size={24} className="animate-spin text-text-muted" />
      </div>
    );
  }

  const state = config.state;
  const isRunning = state === 'running';
  const isStopped = state === 'stopped' || state === 'unknown';
  const name = config.name;
  const iconColorClass = CONTAINER_STATE_ICON_COLOR[state] || CONTAINER_STATE_ICON_COLOR.unknown;
  const iconId = config.iconId || getDefaultContainerIconId();
  const IconComp = getVmIcon(iconId).component;

  const handleDelete = async () => {
    setDeleteDialogOpen(false);
    await deleteContainer(name, deleteFiles);
    if (!useContainerStore.getState().error) navigate('/host/overview');
  };

  const handleOpenBackup = () => {
    setBackupModalOpen(true);
    setBackupError(null);
    const existing = Object.values(bgJobs).find(
      (j) => j.kind === JOB_KIND.CONTAINER_BACKUP
        && j.title === backupTitleForContainer
        && j.status === 'running',
    );
    setBackupJobId(existing ? existing.jobId : null);
    setBackupSelectedIds(['local']);
    getSettings().then((s) => {
      const dests = [{ id: 'local', label: 'Local', path: s.backupLocalPath || '/var/lib/wisp/backups' }];
      if (s.backupMountId) {
        const m = (s.mounts || []).find((x) => x.id === s.backupMountId);
        const p = m && m.mountPath;
        if (m && p) dests.push({ id: m.id, label: m.label || 'Network', path: p });
      }
      setBackupDestinations(dests);
    }).catch(() => setBackupDestinations([{ id: 'local', label: 'Local', path: '/var/lib/wisp/backups' }]));
  };

  const handleSectionSave = async (changes) => {
    const result = await updateContainer(name, changes);
    /* PATCH may rename the container (when `name` is in the body); the
     * response reports the name actually in effect. Re-select under the new
     * name so the stats SSE reconnects, then update the URL. */
    const nextName = result?.name && result.name !== name ? result.name : null;
    if (nextName) {
      /* The backend moved the section assignment as part of the rename, but
       * the LeftPanel buckets workloads from the client-side sectionsStore
       * (which isn't optimistic — it mirrors the server's `{sections,
       * assignments}` payload after every API response that returns one).
       * PATCH /containers/:name doesn't return that payload, so refetch
       * sections to pick up the moved assignment. */
      await useSectionsStore.getState().loadSections();
      await selectContainer(nextName);
      navigate(`/container/${encodeURIComponent(nextName)}/${activeTab}`, { replace: true });
    } else {
      await refreshSelectedContainer();
    }
    return result;
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex h-11 flex-shrink-0 items-center justify-between gap-4 border-b border-surface-border bg-surface-card px-4">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setIconPickerOpen(true)}
            className={`flex-shrink-0 rounded-lg p-1 transition-colors duration-150 hover:bg-surface hover:opacity-90 ${iconColorClass}`}
            title="Change icon"
          >
            <IconComp size={18} />
          </button>
          <span className="truncate text-sm font-semibold text-text-primary">{name}</span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-muted shrink-0">container</span>
          <div className="flex border-l border-surface-border pl-3">
            <button
              type="button"
              onClick={() => navigate(`/container/${encodeURIComponent(name)}/overview`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'overview' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => navigate(`/container/${encodeURIComponent(name)}/logs`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'logs' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Logs
            </button>
            <button
              type="button"
              onClick={() => navigate(`/container/${encodeURIComponent(name)}/console`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'console' ? 'border-accent text-accent font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Console
            </button>
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1">
          {config.pendingRestart && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-status-warning mr-1">
              Restart required
            </span>
          )}
          <ActionButton
            icon={Play} label={backupInProgress ? 'Cannot start while a backup is in progress' : 'Start'}
            onClick={() => startContainer(name)}
            disabled={!isStopped || backupInProgress}
            loading={actionLoading === 'start'}
            variant="primary"
          />
          <ActionButton icon={Square} label="Stop" onClick={() => stopContainer(name)} disabled={isStopped} loading={actionLoading === 'stop'} />
          <ActionButton icon={Zap} label="Kill" onClick={() => killContainer(name)} disabled={isStopped} loading={actionLoading === 'kill'} variant="danger" />
          <ActionButton icon={RotateCcw} label="Restart" onClick={() => restartContainer(name)} disabled={!isRunning} loading={actionLoading === 'restart'} />
          <div className="mx-0.5 h-4 w-px bg-surface-border" />
          <ActionButton
            icon={Archive}
            label={isStopped ? 'Backup' : 'Backup (stop the container first)'}
            onClick={handleOpenBackup}
            disabled={!isStopped}
            loading={backupInProgress}
          />
          <ActionButton icon={Trash2} label="Delete" onClick={() => setDeleteDialogOpen(true)} variant="danger" loading={actionLoading === 'delete'} />
        </div>
      </div>

      {error && (
        <div className="flex-shrink-0 flex items-center justify-between gap-2 rounded-none border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-status-stopped">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={clearError} className="shrink-0 rounded p-1 hover:bg-red-100 transition-colors duration-150" title="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {config.updateAvailable && (
        <div className="flex-shrink-0 border-b border-orange-200 bg-orange-50 px-4 py-2 text-xs text-orange-900">
          New image version available. Restart to apply.
        </div>
      )}

      {activeTab === 'console' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <Suspense fallback={(
            <div className="flex flex-1 items-center justify-center">
              <Loader2 size={24} className="animate-spin text-text-muted" />
            </div>
          )}
          >
            <ContainerConsolePanel containerName={name} />
          </Suspense>
        </div>
      ) : activeTab === 'logs' ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ContainerLogsSection containerName={name} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          <ContainerGeneralSection config={config} onSave={handleSectionSave} />
          {config.app && getAppEntry(config.app) ? (
            <AppConfigWrapper config={config} onSave={handleSectionSave} onRefresh={refreshSelectedContainer} />
          ) : (
            <>
              <ContainerEnvSection config={config} onSave={handleSectionSave} />
              <ContainerMountsSection config={config} onRefresh={refreshSelectedContainer} />
            </>
          )}
          <ContainerNetworkSection config={config} onSave={handleSectionSave} onRefresh={refreshSelectedContainer} />
          <ContainerDevicesSection config={config} onSave={handleSectionSave} />
        </div>
      )}

      <ConfirmDialog
        open={deleteDialogOpen}
        title="Delete Container"
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => { setDeleteDialogOpen(false); setDeleteFiles(true); }}
      >
        <p>Are you sure you want to delete &ldquo;{name}&rdquo;? This cannot be undone.</p>
        <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="rounded border-surface-border" />
          Also delete uploaded files
        </label>
      </ConfirmDialog>

      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={config.iconId || getDefaultContainerIconId()}
        onSelect={async (selectedIconId) => {
          await updateContainer(name, { iconId: selectedIconId });
          await refreshSelectedContainer();
        }}
        onClose={() => setIconPickerOpen(false)}
      />

      {backupModalOpen && (
        <BackupModal
          name={name}
          subjectLabel="Container"
          backupStarted={!!backupJobId}
          destinations={backupDestinations}
          selectedIds={backupSelectedIds}
          onToggleDestination={(id) => {
            setBackupSelectedIds((prev) => (
              prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
            ));
          }}
          progress={
            backupJobId && bgJobs[backupJobId]
              ? {
                step: bgJobs[backupJobId].step || 'starting',
                percent: bgJobs[backupJobId].percent,
                currentFile: bgJobs[backupJobId].detail,
              }
              : null
          }
          error={
            backupJobId && bgJobs[backupJobId]?.status === 'error'
              ? bgJobs[backupJobId].error
              : backupError
          }
          onStart={async () => {
            setBackupError(null);
            try {
              const { jobId, title } = await startContainerBackup(name, { destinationIds: backupSelectedIds });
              registerJob({
                jobId,
                kind: JOB_KIND.CONTAINER_BACKUP,
                title,
              });
              /* Close the modal once the job is queued — progress is shown in
               * the top-bar via backgroundJobsStore, and the toolbar Backup
               * button is disabled while a backup runs (so the user can't
               * reopen this modal mid-backup anyway). */
              setBackupModalOpen(false);
              setBackupJobId(null);
              setBackupSelectedIds(['local']);
            } catch (err) {
              setBackupError(err.message || 'Failed to start backup');
              setBackupJobId(null);
            }
          }}
          onClose={() => {
            setBackupModalOpen(false);
            const row = backupJobId ? bgJobs[backupJobId] : null;
            if (!row || row.status !== 'running') {
              setBackupJobId(null);
              setBackupError(null);
            }
          }}
        />
      )}
    </div>
  );
}
