import { lazy, Suspense, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Archive, Loader2, Pause, Play, PlayCircle, RotateCcw, Smile, Square, TextCursorInput, Trash2, Zap,
} from 'lucide-react';

import { updateVM } from '../../api/vms.js';
import { startBackup } from '../../api/backups.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useWorkloadBackup, useWorkloadBusy, workloadBusyReason } from '../../store/backgroundJobsStore.js';
import { RECORD } from '../../store/records.js';
import { liveData } from '../../store/streamStore.js';
import { useVm, useVmStatsStore, useVmStore } from '../../store/vmStore.js';
import { renamedPath } from '../../utils/renamedPath.js';
import { vmLocked } from '../../utils/workloadLocks.js';
import BackupModal from '../shared/BackupModal.jsx';
import CommandErrors from '../shared/CommandErrors.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import GroupCard from '../shared/GroupCard.jsx';
import GroupSwitch from '../shared/GroupSwitch.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import MoreMenu from '../shared/MoreMenu.jsx';
import RecordError from '../shared/RecordError.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import RenameDialog from '../shared/RenameDialog.jsx';
import WorkloadGone from '../shared/WorkloadGone.jsx';
import { getDefaultIconId, getVmIcon } from '../shared/vmIcons.jsx';
import VmDisksGroup from './VmDisksGroup.jsx';
import VmFigures from './VmFigures.jsx';
import VmFirstBootGroup from './VmFirstBootGroup.jsx';
import VmNetworkGroup from './VmNetworkGroup.jsx';
import VmSizeGroup from './VmSizeGroup.jsx';
import VmSystemGroup from './VmSystemGroup.jsx';
import VmUsbGroup from './VmUsbGroup.jsx';
import { profileText, takesFirstBootSetup } from './vmForms.js';
import TabSpinner from '../shared/TabSpinner.jsx';

const ConsolePanel = lazy(() => import('../console/ConsolePanel.jsx'));

const headerBtn = 'flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 lg:h-8 lg:w-8';
const headerBtnPlain = `${headerBtn} border border-surface-border text-text-secondary hoverable:hover:bg-surface hoverable:hover:text-text-primary`;
const headerBtnPrimary = `${headerBtn} bg-accent text-white hoverable:hover:bg-accent-hover`;

/** Icon colour by VM state. */
const STATE_ICON_COLOR = {
  running: 'text-status-running',
  blocked: 'text-status-running',
  paused: 'text-status-warning',
  pmsuspended: 'text-status-warning',
  shutdown: 'text-status-transition',
  shutoff: 'text-text-secondary',
  crashed: 'text-status-stopped',
  nostate: 'text-text-secondary',
};

const STATE_PILL = {
  running: 'bg-status-running-soft text-status-running',
  blocked: 'bg-status-running-soft text-status-running',
  paused: 'bg-status-warning-soft text-status-warning',
  pmsuspended: 'bg-status-warning-soft text-status-warning',
  crashed: 'bg-status-stopped-soft text-status-stopped',
};

const STATE_TEXT = { shutoff: 'Stopped', nostate: 'Stopped', shutdown: 'Shutting down', pmsuspended: 'Suspended', blocked: 'Running' };

const LOCKED = 'stop the VM first';

/** A header action: an icon, busy while its command runs. */
function HeaderAction({ icon: Icon, label, onClick, reason, loading, primary = false }) {
  const name = reason ? `${label}: ${reason}` : label;
  return (
    <button type="button" onClick={onClick} disabled={!!reason || loading} title={name} aria-label={name} className={primary ? headerBtnPrimary : headerBtnPlain}>
      {loading ? <Loader2 size={17} className="animate-spin" aria-hidden /> : <Icon size={17} aria-hidden />}
    </button>
  );
}

/**
 * A VM's page (docs/specs/UI-VM.md): the header with its state and actions, the figures
 * while it runs, then its groups. Every group shows the server's state as text; an Edit
 * opens a small form, a switch or a row action acts at once. The groups marked "needs
 * shut off" share one lock (`vmLocked`).
 */
export default function OverviewPanel({ name }) {
  const { record, config: loadedConfig, seed, item } = useVm(name);
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const stats = useVmStatsStore(liveData);
  const actionLoading = useVmStore((s) => s.actions[name] ?? null);
  const actionError = useVmStore((s) => s.errors[name] ?? null);
  const iconChanging = useVmStore((s) => !!s.iconChanges[name]);
  const store = useVmStore.getState;

  const { tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab === 'console' ? 'console' : 'overview';

  /* The page's actions (a switch, a row's Remove): their errors are the page's. */
  const act = useCommand();
  /* The open dialog: 'delete', 'rename', 'icon' or 'backup'. */
  const [dialog, setDialog] = useState(null);
  const [deleteDisks, setDeleteDisks] = useState(true);

  const busyJob = useWorkloadBusy({ type: 'vm', name });
  const busy = workloadBusyReason(busyJob) ?? null;
  const backupJob = useWorkloadBackup({ type: 'vm', name });

  if (record.status === 'gone') return <WorkloadGone what="VM" name={name} />;

  const config = loadedConfig ?? seed;
  if (!config) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
        <RecordGate record={record} what={`VM ${name}`} loading={<Loader2 size={24} className="animate-spin text-text-muted" />}>
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
  const isStopped = state === 'shutoff' || state === 'nostate';
  const isRunning = state === 'running' || state === 'blocked';
  const isPaused = state === 'paused' || state === 'pmsuspended';
  /* The one lock of the groups that need the VM shut off. */
  const lockReason = vmLocked(state) ? LOCKED : undefined;
  const staleBinary = !!(stats?.staleBinary || item?.staleBinary);
  const needsStart = !!config.pendingRestart || staleBinary;
  const IconComp = getVmIcon(config.iconId || getDefaultIconId(config.profile)).component;
  const notRunning = isRunning ? undefined : 'it is not running';

  const update = (changes) => updateVM(name, changes);

  const followRename = (target) => {
    store().followRename(name, target);
    const path = renamedPath(window.location.pathname, 'vm', name, target);
    if (path) navigate(path, { replace: true });
  };

  const handleDelete = async () => {
    setDialog(null);
    if (await store().deleteVM(name, deleteDisks)) navigate('/host/overview');
  };

  const tabButton = (id, label, extra = '') => (
    <button
      type="button"
      onClick={() => navigate(`/vm/${encodeURIComponent(name)}/${id}`)}
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
      isPaused
        ? { icon: PlayCircle, label: 'Resume', onClick: () => store().resumeVM(name), reason: busy ?? undefined }
        : { icon: Pause, label: 'Pause', onClick: () => store().suspendVM(name), reason: busy ?? notRunning },
      { icon: Zap, label: 'Force stop', onClick: () => store().forceStopVM(name), reason: busy ?? (isStopped ? 'it is not running' : undefined) },
    ],
    [
      { icon: TextCursorInput, label: 'Rename', onClick: () => setDialog('rename'), reason: busy ?? lockReason },
      { icon: Smile, label: 'Change icon', onClick: () => setDialog('icon'), reason: busy ?? undefined },
      { icon: Archive, label: 'Back up now', onClick: () => setDialog('backup'), reason: busy ?? lockReason },
    ],
    [
      { icon: Trash2, label: 'Delete', danger: true, onClick: () => setDialog('delete'), reason: busy ?? undefined },
    ],
  ];

  const groupProps = { config, busy, act, update };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-surface-border bg-surface-card px-4 py-1 lg:flex-nowrap lg:py-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`shrink-0 ${STATE_ICON_COLOR[state] || STATE_ICON_COLOR.nostate}`} aria-hidden>
            {iconChanging ? <Loader2 size={18} className="animate-spin" /> : <IconComp size={18} className={isRunning ? 'wisp-lit-glyph' : undefined} />}
          </span>
          <h1 className="truncate text-sm font-semibold text-text-primary">{name}</h1>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATE_PILL[state] ?? 'bg-surface text-text-muted'}`}>
            {STATE_TEXT[state] ?? state ?? 'unknown'}
          </span>
          <span className="hidden shrink-0 text-xs text-text-muted sm:inline">{`${profileText(config.profile)} VM`}</span>
          {/* The console is desktop-only: below lg Overview is the one tab, so none shows. */}
          <nav className="hidden border-l border-surface-border pl-2 lg:flex" aria-label="VM tabs">
            {tabButton('overview', 'Overview')}
            {tabButton('console', 'Console')}
          </nav>
        </div>
        <div className="flex w-full shrink-0 items-center justify-end gap-1.5 pb-1 lg:w-auto lg:pb-0">
          {needsStart && (
            <span
              className="mr-auto shrink-0 rounded-full bg-status-warning-soft px-2 py-0.5 text-[11px] font-medium text-status-warning lg:mr-1"
              title={staleBinary && !config.pendingRestart
                ? 'QEMU was updated since the VM started: stop and start it to run the new one. A reboot keeps the running QEMU.'
                : 'Saved changes apply when the VM is stopped and started again. A reboot from the guest or Restart keeps the running settings.'}
            >
              Stop and start to apply
            </span>
          )}
          {isStopped && (
            <HeaderAction icon={Play} label="Start" primary onClick={() => store().startVM(name)} reason={busy} loading={actionLoading === 'start'} />
          )}
          {!isStopped && (
            <>
              <HeaderAction icon={Square} label="Stop" onClick={() => store().stopVM(name)} reason={busy} loading={actionLoading === 'stop' || actionLoading === 'force-stop'} />
              <HeaderAction icon={RotateCcw} label="Restart" onClick={() => store().rebootVM(name)} reason={busy ?? notRunning} loading={actionLoading === 'reboot'} />
            </>
          )}
          <MoreMenu items={moreItems} triggerClassName={headerBtnPlain} />
        </div>
      </div>

      {(actionError || act.errors.length > 0 || (record.data != null && record.error)) && (
        <div className="shrink-0 space-y-1.5 border-b border-surface-border bg-surface px-4 py-2">
          <ErrorBanner error={actionError} onDismiss={() => store().dismissActionError(name)} />
          <CommandErrors commands={[act]} prefix={(_key, _cmd, about) => about} />
          {record.data != null && <RecordError record={record} what="VM" />}
        </div>
      )}

      {activeTab === 'console' ? (
        <RecordGate record={record} what="VM" loading={<TabSpinner />}>
          {() => (
            <Suspense fallback={<TabSpinner />}>
              <ConsolePanel vmName={name} />
            </Suspense>
          )}
        </RecordGate>
      ) : (
        <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-4 lg:px-6 lg:py-5">
          <div className="mx-auto max-w-3xl space-y-3">
            <div className="px-1 pb-1">
              <VmFigures state={state} />
            </div>
            <RecordGate
              record={record}
              what="VM"
              loading={<div className="flex justify-center py-8 text-text-muted"><Loader2 size={20} className="animate-spin" /></div>}
            >
              {() => (
                <>
                  <VmSizeGroup {...groupProps} lockReason={lockReason} />
                  <VmDisksGroup {...groupProps} lockReason={lockReason} />
                  <VmNetworkGroup {...groupProps} lockReason={lockReason} />
                  {takesFirstBootSetup(config.profile) && <VmFirstBootGroup {...groupProps} />}
                  <VmUsbGroup {...groupProps} />
                  <GroupCard title="Start-up">
                    <GroupSwitch
                      label="Start with the host"
                      hint="Started when the host boots."
                      checked={config.autostart === true}
                      onChange={(on) => act.run(() => update({ autostart: on }), { key: 'autostart', about: `Couldn't turn start with the host ${on ? 'on' : 'off'}` })}
                      busy={act.isBusy('autostart')}
                      reason={busy ?? undefined}
                    />
                  </GroupCard>
                  <VmSystemGroup {...groupProps} lockReason={lockReason} />
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
        onCancel={() => { setDialog(null); setDeleteDisks(true); }}
      >
        <p>The VM and its definition are deleted. This cannot be undone.</p>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={deleteDisks} onChange={(e) => setDeleteDisks(e.target.checked)} className="rounded-sm border-surface-border" />
          Also delete its disks and its folder on this host
        </label>
        {!deleteDisks && (
          <p className="mt-2 text-xs text-text-muted">
            Its folder stays on the host, and a new VM named &ldquo;{name}&rdquo; can&rsquo;t be created until that folder is moved or removed.
          </p>
        )}
      </ConfirmDialog>

      {dialog === 'rename' && (
        <RenameDialog
          name={name}
          maxLength={128}
          hint="Letters, digits, dots, dashes and underscores; its disks and page follow it."
          update={update}
          onRenamed={followRename}
          onClose={() => setDialog(null)}
        />
      )}

      <IconPickerModal
        open={dialog === 'icon'}
        currentIconId={config.iconId || getDefaultIconId(config.profile)}
        onSelect={(iconId) => store().setVmIcon(name, iconId)}
        onClose={() => setDialog(null)}
      />

      {dialog === 'backup' && (
        <BackupModal
          name={name}
          subjectLabel="VM"
          settingsRecord={settingsRecord}
          runningJobId={backupJob?.jobId ?? null}
          start={(destinationIds) => startBackup(name, { destinationIds })}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
