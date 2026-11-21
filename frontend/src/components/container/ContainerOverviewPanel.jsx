import {
  Fragment, useState, useEffect, lazy, Suspense,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { renamedPath } from '../../utils/renamedPath.js';
import {
  Play, Square, Zap, RotateCcw, Trash2, Archive, Loader2,
} from 'lucide-react';

import { useContainer, useContainerStore } from '../../store/containerStore.js';
import { useWorkloadBusy, useWorkloadBackup, workloadBusyReason } from '../../store/backgroundJobsStore.js';
import { updateContainer, ejectContainerApp } from '../../api/containers.js';
import { startContainerBackup } from '../../api/backups.js';
import { JOB_KIND } from '../../../../shared/wireNames.js';
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
import ScheduledRestartBadge from './ScheduledRestartBadge.jsx';
import { getAppEntry } from '../../apps/appRegistry.js';
import AppConfigWrapper from '../../apps/AppConfigWrapper.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import WorkloadGone from '../shared/WorkloadGone.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import RecordError from '../shared/RecordError.jsx';

const ContainerConsolePanel = lazy(() => import('../console/ContainerConsolePanel.jsx'));

function TabSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-text-muted" />
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, disabled, variant = 'default', loading }) {
  const base = 'flex shrink-0 items-center justify-center rounded-md p-2 text-sm font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed';
  const variants = {
    default: 'border border-surface-border text-text-secondary hover:bg-surface hover:text-text-primary',
    danger: 'border border-status-stopped/30 text-status-stopped hover:bg-status-stopped-soft',
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

export default function ContainerOverviewPanel({ name: routeName }) {
  const { record, config: loadedConfig, seed } = useContainer(routeName);
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const actionLoading = useContainerStore((s) => s.actions[routeName] ?? null);
  const actionError = useContainerStore((s) => s.errors[routeName] ?? null);
  const iconChanging = useContainerStore((s) => !!s.iconChanges[routeName]);
  const dismissActionError = useContainerStore((s) => s.dismissActionError);
  const setContainerIcon = useContainerStore((s) => s.setContainerIcon);
  const startContainer = useContainerStore((s) => s.startContainer);
  const stopContainer = useContainerStore((s) => s.stopContainer);
  const killContainer = useContainerStore((s) => s.killContainer);
  const restartContainer = useContainerStore((s) => s.restartContainer);
  const deleteContainer = useContainerStore((s) => s.deleteContainer);

  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab === 'console' ? 'console' : tab === 'logs' ? 'logs' : 'overview';

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [backupModalOpen, setBackupModalOpen] = useState(false);

  const containerName = routeName;
  // A job on this container holds the backend's per-container operation lock
  // (every lifecycle action, delete and edit → 409 CONTAINER_BUSY), so it
  // blocks the conflicting actions here.
  const busyJob = useWorkloadBusy({ type: 'container', name: containerName });
  const busyHint = workloadBusyReason(busyJob) ?? null;
  /* A kill during a stop is that stop made immediate (the server cuts its grace
   * period), so Kill stays enabled while the busy job is a stop. */
  const killHint = busyJob?.kind === JOB_KIND.CONTAINER_STOP ? null : busyHint;
  const backupJob = useWorkloadBackup({ type: 'container', name: containerName });

  useEffect(() => {
    setBackupModalOpen(false);
  }, [containerName]);

  if (record.status === 'gone') return <WorkloadGone what="container" name={routeName} />;

  /* The header may paint from the list item while the config loads; the body is the
   * record's alone, behind its gate (loading, its error with a Retry). With neither,
   * the page is the gate. */
  const config = loadedConfig ?? seed;
  if (!config) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
        <RecordGate record={record} what={`container ${routeName}`} loading={<Loader2 size={24} className="animate-spin text-text-muted" />}>
          {() => null}
        </RecordGate>
        {record.status === 'error' && (
          <button type="button" onClick={() => navigate('/host/overview')} className="text-xs text-text-muted hover:text-text-secondary">
            Go to Host overview
          </button>
        )}
      </div>
    );
  }

  const state = config.state;
  const isRunning = state === 'running';
  const isStopped = state === 'stopped' || state === 'unknown';
  /* Stopped but waiting out a restart-policy backoff: Stop cancels the restart. */
  const restartScheduled = isStopped && !!config.scheduledRestart;
  const name = routeName;
  const iconColorClass = CONTAINER_STATE_ICON_COLOR[state] || CONTAINER_STATE_ICON_COLOR.unknown;
  const iconId = config.iconId || getDefaultContainerIconId();
  const IconComp = getVmIcon(iconId).component;


  const handleDelete = async () => {
    setDeleteDialogOpen(false);
    if (await deleteContainer(name, deleteFiles)) navigate('/host/overview');
  };

  const handleOpenBackup = () => setBackupModalOpen(true);

  /* A form's save: the PATCH, ending at its ack (the form then reads its record). */
  const handleSectionSave = (changes) => updateContainer(name, changes);
  /* A section's command (a device toggle): busy until the server answers. */
  const handleSectionCommand = (changes) => updateContainer(name, changes);

  /* After a save that renamed the container (at its ack; the server takes the name as
   * sent, after validation, and the section assignment moves with it): the page follows
   * to the new name, whose page reads its record, but only if the router still shows
   * this container's page — the user may have moved on. */
  const handleRenamed = (target) => {
    useContainerStore.getState().followRename(name, target);
    /* The router's location now (BrowserRouter's is the window's), also once this
     * page has unmounted: its tab, under the new name. */
    const path = renamedPath(window.location.pathname, 'container', name, target);
    if (path) navigate(path, { replace: true });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {/* Header. Below lg it wraps to two rows (title+tabs / actions)
          instead of clipping in a fixed h-11. */}
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-surface-border bg-surface-card px-4 py-1 lg:h-11 lg:flex-nowrap lg:py-0">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setIconPickerOpen(true)}
            disabled={!!busyHint || iconChanging}
            className={`shrink-0 rounded-lg p-2 lg:p-1 transition-colors duration-150 hover:bg-surface hover:opacity-90 disabled:cursor-not-allowed disabled:hover:bg-transparent ${iconColorClass}`}
            title={busyHint || 'Change icon'}
          >
            {iconChanging ? <Loader2 size={18} className="animate-spin" /> : <IconComp size={18} className={isRunning ? 'wisp-lit-glyph' : undefined} />}
          </button>
          <span className="truncate text-sm font-semibold text-text-primary">{name}</span>
          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-muted shrink-0">container</span>
          <div className="flex border-l border-surface-border pl-3">
            <button
              type="button"
              onClick={() => navigate(`/container/${encodeURIComponent(name)}/overview`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'overview' ? 'border-accent text-accent-text font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Overview
            </button>
            <button
              type="button"
              onClick={() => navigate(`/container/${encodeURIComponent(name)}/logs`)}
              className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'logs' ? 'border-accent text-accent-text font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Logs
            </button>
            {/* Terminal console is desktop-only — hidden below lg (Logs stays) */}
            <button
              type="button"
              onClick={() => navigate(`/container/${encodeURIComponent(name)}/console`)}
              className={`hidden lg:block border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${
                activeTab === 'console' ? 'border-accent text-accent-text font-semibold' : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              Console
            </button>
          </div>
        </div>
        {/* Below lg the actions become a full-width horizontally-scrollable row
            (primary actions leftmost); at lg+ they wrap right-aligned as before. */}
        <div className="flex w-full shrink-0 items-center justify-start gap-1 overflow-x-auto lg:w-auto lg:flex-wrap lg:justify-end lg:overflow-visible">
          {config.pendingRestart && (
            <span className="shrink-0 rounded-full bg-status-warning-soft px-2 py-0.5 text-[10px] font-medium text-status-warning mr-1">
              Restart required
            </span>
          )}
          {restartScheduled && (
            <ScheduledRestartBadge scheduledRestart={config.scheduledRestart} className="mr-1" />
          )}
          <ActionButton
            icon={Play} label={busyHint || 'Start'}
            onClick={() => startContainer(name)}
            disabled={!isStopped || !!busyHint}
            loading={actionLoading === 'start'}
            variant="primary"
          />
          <ActionButton
            icon={Square}
            label={busyHint || (restartScheduled ? 'Stop (cancel the scheduled restart)' : 'Stop')}
            onClick={() => stopContainer(name)}
            disabled={(isStopped && !restartScheduled) || !!busyHint}
            loading={actionLoading === 'stop'}
          />
          <ActionButton
            icon={Zap}
            label={killHint || 'Kill'}
            onClick={() => killContainer(name)}
            disabled={isStopped || !!killHint}
            loading={actionLoading === 'kill'}
            variant="danger"
          />
          <ActionButton
            icon={RotateCcw}
            label={busyHint || 'Restart'}
            onClick={() => restartContainer(name)}
            disabled={!isRunning || !!busyHint}
            loading={actionLoading === 'restart'}
          />
          <div className="mx-0.5 h-4 w-px shrink-0 bg-surface-border" />
          <ActionButton
            icon={Archive}
            label={busyHint || 'Backup'}
            onClick={handleOpenBackup}
            disabled={!!busyHint || state === 'pausing' || state === 'unknown'}
            loading={!!backupJob}
          />
          <ActionButton
            icon={Trash2}
            label={busyHint || 'Delete'}
            onClick={() => setDeleteDialogOpen(true)}
            disabled={!!busyHint}
            variant="danger"
            loading={actionLoading === 'delete'}
          />
        </div>
      </div>

      {/* Each error stays until dismissed */}
      {actionError && (
        <ErrorBanner className="shrink-0 rounded-none border-x-0 border-t-0 px-4 py-2" error={actionError} onDismiss={() => dismissActionError(name)} />
      )}
      {record.data != null && (
        <RecordError className="shrink-0 rounded-none border-x-0 border-t-0 px-4 py-2" record={record} what="container" />
      )}

      {config.updateAvailable && (
        <div className="shrink-0 border-b border-status-warning/30 bg-status-warning-soft px-4 py-2 text-xs text-status-warning">
          New image version available. Restart to apply.
        </div>
      )}

      {activeTab === 'console' ? (
        /* Every tab's body is the record's: behind its gate, like the overview's. */
        <RecordGate record={record} what="container" loading={<TabSpinner />}>
          {() => (
            <div className="flex min-h-0 flex-1 flex-col">
              <Suspense fallback={<TabSpinner />}>
                <ContainerConsolePanel containerName={name} />
              </Suspense>
            </div>
          )}
        </RecordGate>
      ) : activeTab === 'logs' ? (
        <RecordGate record={record} what="container" loading={<TabSpinner />}>
          {() => (
            <div className="flex min-h-0 flex-1 flex-col">
              <ContainerLogsSection containerName={name} />
            </div>
          )}
        </RecordGate>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-4 lg:px-6 lg:py-5 space-y-5">
          <RecordGate
            record={record}
            what="container"
            loading={(
              <div className="flex justify-center py-8 text-text-muted">
                <Loader2 size={20} className="animate-spin" />
              </div>
            )}
          >
          {/* Keyed by the workload: a section's own state (its commands' errors) is this
              workload's. */}
          {() => (
          <Fragment key={name}>
          <ContainerGeneralSection config={config} onSave={handleSectionSave} onRenamed={handleRenamed} />
          {config.metadata?.app && getAppEntry(config.metadata.app) ? (
            <AppConfigWrapper
              config={config}
              onSave={handleSectionSave}
              onEject={() => ejectContainerApp(name)}
            />
          ) : (
            <>
              <ContainerEnvSection config={config} onSave={handleSectionSave} />
              <ContainerMountsSection config={config} />
            </>
          )}
          <ContainerNetworkSection config={config} onSave={handleSectionSave} />
          <ContainerDevicesSection config={config} onSave={handleSectionCommand} />
          </Fragment>
          )}
          </RecordGate>
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
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="rounded-sm border-surface-border" />
          Also delete mount data (Local files)
        </label>
        {!deleteFiles && (
          <p className="mt-2 text-xs text-text-muted">
            The container&rsquo;s <span className="font-mono">files/</span> directory stays on the host. A new
            container named &ldquo;{name}&rdquo; can&rsquo;t be created until that directory is moved or removed.
          </p>
        )}
      </ConfirmDialog>

      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={config.iconId || getDefaultContainerIconId()}
        onSelect={(selectedIconId) => setContainerIcon(name, selectedIconId)}
        onClose={() => setIconPickerOpen(false)}
      />

      {backupModalOpen && (
        <BackupModal
          name={name}
          subjectLabel="Container"
          settingsRecord={settingsRecord}
          runningJobId={backupJob?.kind === JOB_KIND.CONTAINER_BACKUP ? backupJob.jobId : null}
          start={(destinationIds) => startContainerBackup(name, { destinationIds })}
          onClose={() => setBackupModalOpen(false)}
        />
      )}
    </div>
  );
}
