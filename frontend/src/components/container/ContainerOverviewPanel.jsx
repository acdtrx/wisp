import { lazy, Suspense, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Archive, Loader2, Play, RotateCcw, Smile, Square, TextCursorInput, Trash2, Unplug, Zap,
} from 'lucide-react';

import { ejectContainerApp, updateContainer } from '../../api/containers.js';
import { startContainerBackup } from '../../api/backups.js';
import { getAppEntry } from '../../apps/appRegistry.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useWorkloadBackup, useWorkloadBusy, workloadBusyReason } from '../../store/backgroundJobsStore.js';
import { useContainer, useContainerStore } from '../../store/containerStore.js';
import { RECORD } from '../../store/records.js';
import { CONTAINER_STATE_ICON_COLOR } from '../../utils/containerConstants.js';
import { renamedPath } from '../../utils/renamedPath.js';
import { containerLocked } from '../../utils/workloadLocks.js';
import { JOB_KIND } from '../../../../shared/wireNames.js';
import BackupModal from '../shared/BackupModal.jsx';
import CommandErrors from '../shared/CommandErrors.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import MoreMenu from '../shared/MoreMenu.jsx';
import RecordError from '../shared/RecordError.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import WorkloadGone from '../shared/WorkloadGone.jsx';
import { getDefaultContainerIconId, getVmIcon } from '../shared/vmIcons.jsx';
import ContainerLogsSection from '../sections/ContainerLogsSection.jsx';
import ContainerAdvancedGroup from './ContainerAdvancedGroup.jsx';
import ContainerEnvGroup from './ContainerEnvGroup.jsx';
import ContainerFigures from './ContainerFigures.jsx';
import ContainerImageGroup from './ContainerImageGroup.jsx';
import ContainerLimitsGroup from './ContainerLimitsGroup.jsx';
import ContainerNetworkGroup from './ContainerNetworkGroup.jsx';
import ContainerRenameDialog from './ContainerRenameDialog.jsx';
import ContainerStartupGroup from './ContainerStartupGroup.jsx';
import ContainerStorageGroup from './ContainerStorageGroup.jsx';
import ScheduledRestartBadge from './ScheduledRestartBadge.jsx';

const ContainerConsolePanel = lazy(() => import('../console/ContainerConsolePanel.jsx'));

const headerBtn = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 lg:h-8 lg:w-8';
const headerBtnPlain = `${headerBtn} border border-surface-border text-text-secondary hoverable:hover:bg-surface hoverable:hover:text-text-primary`;
const headerBtnPrimary = `${headerBtn} bg-accent text-white hoverable:hover:bg-accent-hover`;

const STATE_PILL = {
  running: 'bg-status-running-soft text-status-running',
  paused: 'bg-status-warning-soft text-status-warning',
  pausing: 'bg-status-warning-soft text-status-warning',
};

function TabSpinner() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Loader2 size={24} className="animate-spin text-text-muted" />
    </div>
  );
}

/** A header action: an icon, busy while its command runs. */
function HeaderAction({ icon: Icon, label, onClick, reason, loading, primary = false }) {
  const name = reason ? `${label}: ${reason}` : label;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!reason || loading}
      title={name}
      aria-label={name}
      className={primary ? headerBtnPrimary : headerBtnPlain}
    >
      {loading ? <Loader2 size={17} className="animate-spin" aria-hidden /> : <Icon size={17} aria-hidden />}
    </button>
  );
}

/**
 * A container's page (docs/specs/UI-CONTAINER.md): the header with its state and
 * actions, the figures while it runs, then its groups. Every group shows the server's
 * state as text; an Edit opens a small form, a switch or a row action acts at once.
 */
export default function ContainerOverviewPanel({ name }) {
  const { record, config: loadedConfig, seed } = useContainer(name);
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const actionLoading = useContainerStore((s) => s.actions[name] ?? null);
  const actionError = useContainerStore((s) => s.errors[name] ?? null);
  const iconChanging = useContainerStore((s) => !!s.iconChanges[name]);
  const store = useContainerStore.getState;

  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab === 'console' ? 'console' : tab === 'logs' ? 'logs' : 'overview';

  /* The page's actions (a switch, a row's Remove, Eject): their errors are the page's,
   * under the header. */
  const act = useCommand();
  /* The open dialog: 'delete', 'rename', 'icon', 'backup' or 'eject'. */
  const [dialog, setDialog] = useState(null);
  const [deleteFiles, setDeleteFiles] = useState(true);

  /* A job on the container holds its operation lock: what the server would refuse is
   * off, naming the job. A kill during a stop makes the stop immediate. */
  const busyJob = useWorkloadBusy({ type: 'container', name });
  const busy = workloadBusyReason(busyJob) ?? null;
  const backupJob = useWorkloadBackup({ type: 'container', name });

  if (record.status === 'gone') return <WorkloadGone what="container" name={name} />;

  /* The header paints from the list item while the config loads; the body is the
   * record's alone, behind its gate. */
  const config = loadedConfig ?? seed;
  if (!config) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
        <RecordGate record={record} what={`container ${name}`} loading={<Loader2 size={24} className="animate-spin text-text-muted" />}>
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
  const isStopped = state === 'stopped' || state === 'unknown';
  const isRunning = !isStopped;
  const restartScheduled = isStopped && !!config.scheduledRestart;
  const locked = containerLocked(state);
  const appEntry = config.metadata?.app ? getAppEntry(config.metadata.app) : null;
  const IconComp = getVmIcon(config.iconId || getDefaultContainerIconId()).component;
  const iconColor = CONTAINER_STATE_ICON_COLOR[state] || CONTAINER_STATE_ICON_COLOR.unknown;
  const killReason = busyJob?.kind === JOB_KIND.CONTAINER_STOP ? null : busy;
  const backupReason = busy ?? (state === 'pausing' || state === 'unknown' ? 'not while it changes state' : null);

  const update = (changes) => updateContainer(name, changes);

  /* After a rename, at its ack: the page follows to the new name, if the router still
   * shows this container (the user may have moved on). */
  const followRename = (target) => {
    store().followRename(name, target);
    const path = renamedPath(window.location.pathname, 'container', name, target);
    if (path) navigate(path, { replace: true });
  };

  const handleDelete = async () => {
    setDialog(null);
    if (await store().deleteContainer(name, deleteFiles)) navigate('/host/overview');
  };

  const handleEject = () => {
    setDialog(null);
    act.run(() => ejectContainerApp(name), { key: 'eject', about: "Couldn't eject the app" });
  };

  const tabButton = (id, label, extra = '') => (
    <button
      type="button"
      onClick={() => navigate(`/container/${encodeURIComponent(name)}/${id}`)}
      aria-current={activeTab === id ? 'page' : undefined}
      className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors duration-150 ${extra} ${
        activeTab === id ? 'border-accent font-semibold text-accent-text' : 'border-transparent text-text-muted hover:text-text-primary'
      }`}
    >
      {label}
    </button>
  );

  const moreItems = [
    [
      { icon: Zap, label: 'Kill', onClick: () => store().killContainer(name), reason: isStopped ? 'it is not running' : killReason ?? undefined },
    ],
    [
      { icon: TextCursorInput, label: 'Rename', onClick: () => setDialog('rename'), reason: busy ?? (locked ? 'stop the container first' : undefined) },
      { icon: Smile, label: 'Change icon', onClick: () => setDialog('icon'), reason: busy ?? undefined },
      { icon: Archive, label: 'Back up now', onClick: () => setDialog('backup'), reason: backupReason ?? undefined },
    ],
    [
      ...(appEntry ? [{ icon: Unplug, label: 'Eject the app', onClick: () => setDialog('eject'), reason: busy ?? undefined }] : []),
      { icon: Trash2, label: 'Delete', danger: true, onClick: () => setDialog('delete'), reason: busy ?? undefined },
    ],
  ];

  const groupProps = { config, busy, act, update };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-surface-border bg-surface-card px-4 py-1 lg:flex-nowrap lg:py-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 ${iconColor}`} aria-hidden>
            {iconChanging ? <Loader2 size={18} className="animate-spin" /> : <IconComp size={18} className={state === 'running' ? 'wisp-lit-glyph' : undefined} />}
          </span>
          <h1 className="truncate text-sm font-semibold text-text-primary">{name}</h1>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATE_PILL[state] ?? 'bg-surface text-text-muted'}`}>
            {state ?? 'unknown'}
          </span>
          <span className="hidden shrink-0 text-xs text-text-muted sm:inline">{appEntry ? appEntry.label : 'Container'}</span>
          <nav className="flex border-l border-surface-border pl-2" aria-label="Container tabs">
            {tabButton('overview', 'Overview')}
            {tabButton('logs', 'Logs')}
            {/* The console is desktop-only. */}
            {tabButton('console', 'Console', 'hidden lg:block')}
          </nav>
        </div>
        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 pb-1 lg:w-auto lg:pb-0">
          {config.pendingRestart && (
            <span className="mr-auto shrink-0 rounded-full bg-status-warning-soft px-2 py-0.5 text-[11px] font-medium text-status-warning lg:mr-1">
              Restart to apply
            </span>
          )}
          {restartScheduled && <ScheduledRestartBadge scheduledRestart={config.scheduledRestart} className="mr-1" />}
          {isStopped && (
            <HeaderAction icon={Play} label="Start" primary onClick={() => store().startContainer(name)} reason={busy} loading={actionLoading === 'start'} />
          )}
          {(isRunning || restartScheduled) && (
            <HeaderAction
              icon={Square}
              label={restartScheduled ? 'Stop (cancel the scheduled restart)' : 'Stop'}
              onClick={() => store().stopContainer(name)}
              reason={busy}
              loading={actionLoading === 'stop'}
            />
          )}
          {isRunning && (
            <HeaderAction icon={RotateCcw} label="Restart" onClick={() => store().restartContainer(name)} reason={busy} loading={actionLoading === 'restart'} />
          )}
          <MoreMenu items={moreItems} triggerClassName={headerBtnPlain} />
        </div>
      </div>

      {(actionError || act.errors.length > 0 || (record.data != null && record.error)) && (
        <div className="shrink-0 space-y-1.5 border-b border-surface-border bg-surface px-4 py-2">
          <ErrorBanner error={actionError} onDismiss={() => store().dismissActionError(name)} />
          <CommandErrors commands={[act]} prefix={(_key, _cmd, about) => about} />
          {record.data != null && <RecordError record={record} what="container" />}
        </div>
      )}

      {activeTab === 'console' ? (
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
        <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-4 lg:px-6 lg:py-5">
          <div className="mx-auto max-w-3xl space-y-3">
            <div className="px-1 pb-1">
              <ContainerFigures state={state} />
            </div>
            <RecordGate
              record={record}
              what="container"
              loading={<div className="flex justify-center py-8 text-text-muted"><Loader2 size={20} className="animate-spin" /></div>}
            >
              {() => (
                <>
                  {appEntry && <appEntry.Groups key={name} {...groupProps} />}
                  <ContainerImageGroup {...groupProps} />
                  {!appEntry && <ContainerEnvGroup {...groupProps} />}
                  {!appEntry && <ContainerStorageGroup {...groupProps} />}
                  <ContainerNetworkGroup {...groupProps} locked={locked} />
                  <ContainerLimitsGroup {...groupProps} />
                  <ContainerStartupGroup {...groupProps} backupReason={backupReason} onBackUp={() => setDialog('backup')} />
                  <ContainerAdvancedGroup {...groupProps} />
                </>
              )}
            </RecordGate>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={dialog === 'delete'}
        title={`Delete ${name}?`}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => { setDialog(null); setDeleteFiles(true); }}
      >
        <p>The container, its settings and its logs are deleted. This cannot be undone.</p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="rounded-sm border-surface-border" />
          Also delete the files it keeps on this host
        </label>
        {!deleteFiles && (
          <p className="mt-2 text-xs text-text-muted">
            Its <span className="font-mono">files/</span> folder stays on the host, and a new container named &ldquo;{name}&rdquo;
            can&rsquo;t be created until that folder is moved or removed.
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'eject'}
        title="Eject the app?"
        confirmLabel="Eject"
        onConfirm={handleEject}
        onCancel={() => setDialog(null)}
      >
        <p>
          {name} becomes a plain container: its variables and storage are kept as the app left them, and you edit
          them yourself from then on.
        </p>
        <p className="mt-2 text-xs text-text-muted">This cannot be undone.</p>
      </ConfirmDialog>

      {dialog === 'rename' && (
        <ContainerRenameDialog name={name} update={update} onRenamed={followRename} onClose={() => setDialog(null)} />
      )}

      <IconPickerModal
        open={dialog === 'icon'}
        currentIconId={config.iconId || getDefaultContainerIconId()}
        onSelect={(iconId) => store().setContainerIcon(name, iconId)}
        onClose={() => setDialog(null)}
      />

      {dialog === 'backup' && (
        <BackupModal
          name={name}
          subjectLabel="Container"
          settingsRecord={settingsRecord}
          runningJobId={backupJob?.kind === JOB_KIND.CONTAINER_BACKUP ? backupJob.jobId : null}
          start={(destinationIds) => startContainerBackup(name, { destinationIds })}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
