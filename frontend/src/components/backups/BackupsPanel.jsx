import { useState, useEffect, useMemo } from 'react';
import {
  Loader2, Trash2, ChevronDown, ChevronRight, Plus, Archive, ArchiveRestore, CopyPlus,
} from 'lucide-react';

import BackupModal from '../shared/BackupModal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import RecordError from '../shared/RecordError.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
  rowActionIconBtn,
} from '../shared/DataTableChrome.jsx';
import {
  startBackup,
  restoreBackup,
  deleteBackup,
  startContainerBackup,
  restoreContainerBackup,
  restoreContainerBackupInPlace,
  deleteContainerBackup,
} from '../../api/backups.js';
import { sendAndAwaitTopic } from '../../api/events.js';
import {
  useBackgroundJobsStore, workloadBusyJob, workloadBackupJob, workloadBusyReason,
} from '../../store/backgroundJobsStore.js';
import { useVmStore } from '../../store/vmStore.js';
import { useContainerStore } from '../../store/containerStore.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { formatSize, formatRelativeTime } from '../../utils/formatters.js';
import { useCommand } from '../../hooks/useCommand.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import CommandErrors from '../shared/CommandErrors.jsx';
import { JOB_KIND, TOPIC } from '../../../../shared/wireNames.js';
import { useBackupsStore } from '../../store/backupsStore.js';

/* Same stopped set as the VM Overview. `shutdown` is a guest shutdown still in
 * progress (qemu holds the disks) — the backend refuses a backup then. */
const VM_STOPPED_STATES = ['shutoff', 'nostate'];
const NO_WORKLOADS = [];
const NO_BACKUPS = [];

/** Backup dir timestamps are ISO with `:` swapped to `-` (2026-05-08T06-30-00). */
function backupTsToIso(ts) {
  if (typeof ts !== 'string') return null;
  const m = ts.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

/* A backup row may carry no `origin` (one on a backup mount that was unmounted
 * when migration 0007 ran); it is shown as manual — never auto-pruned, as the
 * server treats it. */
function decorateVmRow(row) {
  return {
    kind: 'vm',
    name: row.vmName,
    timestamp: row.timestamp,
    destinationId: row.destinationId,
    destinationLabel: row.destinationLabel,
    sizeBytes: row.sizeBytes,
    origin: row.origin === 'scheduled' ? 'scheduled' : 'manual',
  };
}

function decorateContainerRow(row) {
  return {
    kind: 'container',
    name: row.name,
    timestamp: row.timestamp,
    destinationId: row.destinationId,
    destinationLabel: row.destinationLabel,
    sizeBytes: row.sizeBytes,
    image: row.image,
    origin: row.origin === 'scheduled' ? 'scheduled' : 'manual',
  };
}

function OriginBadge({ origin }) {
  return origin === 'scheduled' ? (
    <span className="inline-flex items-center rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent-text">scheduled</span>
  ) : (
    <span className="inline-flex items-center rounded-sm border border-surface-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">manual</span>
  );
}

function DestinationBadge({ label }) {
  return (
    <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${label === 'Local' ? 'bg-surface-border text-text-secondary' : 'bg-accent-soft text-accent-text'}`}>
      {label || '—'}
    </span>
  );
}

/** Header dot + one-line summary of a workload's backup situation. */
function groupStatusLine(group, scheduleEnabled) {
  const attempt = group.status;
  const newest = group.backups[0] || null;
  const newestIso = newest ? backupTsToIso(newest.timestamp) : null;

  if (attempt && attempt.ok === false) {
    return {
      dotClass: 'bg-status-stopped',
      text: (
        <>
          <span className="font-medium text-status-stopped">last attempt failed</span>
          {newestIso && <> · good {formatRelativeTime(newestIso)}</>}
        </>
      ),
    };
  }

  const lastIso = attempt?.ok ? attempt.at : newestIso;
  if (!lastIso) {
    return { dotClass: 'bg-surface-border', text: <>no backups yet</> };
  }
  const origin = attempt?.ok ? attempt.origin : (newest?.origin || 'manual');
  /* Stale: a daily-scheduled workload should have a backup within ~a day
   * (26h = daily + grace); manual-only workloads get a lazier 7-day nudge. */
  const autoActive = group.autoBackup && scheduleEnabled;
  const staleMs = autoActive ? 26 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
  const stale = group.live && Date.now() - new Date(lastIso).getTime() > staleMs;
  return {
    dotClass: !group.live ? 'bg-surface-border' : stale ? 'bg-status-warning' : 'bg-status-running',
    text: (
      <>
        last <span className="font-medium text-text-primary">{formatRelativeTime(lastIso)}</span> · {origin}
      </>
    ),
  };
}

/** A backup's key for its commands: kind, workload, destination and timestamp. */
const backupKey = (b) => [b.kind, b.name, b.destinationId, b.timestamp].join('|');

export default function BackupsPanel() {
  const vms = useVmStore((s) => s.data) ?? NO_WORKLOADS;
  const containers = useContainerStore((s) => s.data) ?? NO_WORKLOADS;
  const jobs = useBackgroundJobsStore((s) => s.jobs);

  /* The backup lists are records, read again on every `backups` frame (an attempt, a
   * delete, a prune — from anywhere). */
  const vmList = useRecord(RECORD.VM_BACKUPS);
  const ctList = useRecord(RECORD.CONTAINER_BACKUPS);
  const vmBackups = vmList.data ?? NO_BACKUPS;
  const ctBackups = ctList.data ?? NO_BACKUPS;
  const loading = vmList.status === 'loading' || ctList.status === 'loading';
  const status = useBackupsStore((s) => s.data);
  const statusError = useBackupsStore((s) => s.error);
  const dismissStatusError = useBackupsStore((s) => s.dismissError);
  const connectStatus = useBackupsStore((s) => s.connect);
  const disconnectStatus = useBackupsStore((s) => s.disconnect);
  useEffect(() => {
    connectStatus();
    return () => disconnectStatus();
  }, [connectStatus, disconnectStatus]);
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const settings = settingsRecord.data;
  const schedule = settings?.backupSchedule || null;
  const [expanded, setExpanded] = useState(() => new Set());

  /* Back up now (BackupModal) */
  const [backupTarget, setBackupTarget] = useState(null);

  /* Restore as new (inline strip) */
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restoreName, setRestoreName] = useState('');
  /* Each command keyed by the backup (or, in place, by the workload): backups run in
   * parallel, each with its error. Confirms close at once; the row shows its command. */
  const restore = useCommand();

  /* Restore in place (confirm dialog) */
  const [inPlaceTarget, setInPlaceTarget] = useState(null);
  const [inPlaceName, setInPlaceName] = useState('');
  const [inPlaceSafety, setInPlaceSafety] = useState(true);
  const inPlace = useCommand();

  /* Delete (confirm dialog) */
  const [deleteTarget, setDeleteTarget] = useState(null);
  const remove = useCommand();

  /* What a backup's command is about (what its error names, and its workload's card),
   * held by the command hook with its key. */
  const aboutOf = (backup, group) => ({ backup: `the backup ${backup.timestamp} of ${backup.name}`, workload: group.name, group: group.key });
  /** Whether a restore in place of the workload of `group` is under way (one at a time). */
  const inPlaceRunning = (group) => inPlace.running.some((key) => inPlace.aboutOf(key)?.group === group.key);

  const groups = useMemo(() => {
    const map = new Map();
    const ensure = (kind, name) => {
      const key = `${kind}:${name}`;
      let g = map.get(key);
      if (!g) {
        g = { key, kind, name, live: false, state: null, autoBackup: false, backups: [] };
        map.set(key, g);
      }
      return g;
    };
    for (const vm of vms) {
      const g = ensure('vm', vm.name);
      g.live = true;
      g.state = vm.state;
    }
    for (const c of containers) {
      const g = ensure('container', c.name);
      g.live = true;
      g.state = c.state;
      g.autoBackup = !!c.autoBackup;
    }
    for (const b of vmBackups) ensure('vm', b.vmName).backups.push(decorateVmRow(b));
    for (const b of ctBackups) ensure('container', b.name).backups.push(decorateContainerRow(b));
    for (const g of map.values()) {
      g.backups.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
      g.totalBytes = g.backups.reduce((sum, b) => sum + (b.sizeBytes || 0), 0);
      g.status = status?.[g.kind === 'vm' ? 'vms' : 'containers']?.[g.name] ?? null;
    }
    return [...map.values()].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [vms, containers, vmBackups, ctBackups, status]);

  const toggleExpanded = (key) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const subjectOf = (group) => ({ type: group.kind, name: group.name });
  /** The running backup or restore-in-place of a workload: what the card shows. */
  const activeJobFor = (group) => workloadBackupJob(jobs, subjectOf(group));

  const isWorkloadStopped = (group) => (
    group.kind === 'vm'
      ? VM_STOPPED_STATES.includes(group.state)
      : group.state === 'stopped' || group.state === 'created'
  );

  /* Only workloads that carry a backup get a card — first backups start from
   * the VM/container page. A failed last attempt or a running backup/restore
   * job also earns one: that signal has no other surface on this panel. */
  const visibleGroups = groups.filter(
    (g) => g.backups.length > 0 || g.status?.ok === false || activeJobFor(g),
  );

  /* ── Back up now ── */

  const handleOpenBackup = (group) => setBackupTarget(group);

  /** The backup of `group` running now, for the dialog to follow. */
  const runningBackupOf = (group) => {
    const running = activeJobFor(group);
    const backupKind = group.kind === 'vm' ? JOB_KIND.VM_BACKUP : JOB_KIND.CONTAINER_BACKUP;
    return running?.kind === backupKind ? running.jobId : null;
  };

  /* ── Restore as new ── */

  /* A job: busy until it ended; the new workload arrives on its list topic. */
  const handleRestoreAsNew = () => {
    if (!restoreTarget || !restoreName.trim()) return;
    const { group, backup } = restoreTarget;
    const newName = restoreName.trim();
    restore.run(() => (backup.kind === 'container'
      ? restoreContainerBackup({ destinationId: backup.destinationId, name: backup.name, timestamp: backup.timestamp }, newName)
      : restoreBackup({ destinationId: backup.destinationId, vmName: backup.name, timestamp: backup.timestamp }, newName)), {
      job: true,
      key: backupKey(backup), about: aboutOf(backup, group),
      onDone: () => {
        setRestoreTarget(null);
        setRestoreName('');
      },
    });
  };

  /* ── Restore in place (containers only) ── */

  const handleOpenInPlace = (group, backup) => {
    setInPlaceTarget({ group, backup });
    setInPlaceName('');
    setInPlaceSafety(true);
    inPlace.dismiss('confirm');
  };

  /* The confirm closes once the typed name matches; busy until the ack, then the job's
   * progress shows on the workload's card. */
  const handleInPlaceConfirm = () => {
    if (!inPlaceTarget) return;
    const { group, backup } = inPlaceTarget;
    if (inPlaceName.trim() !== group.name) {
      inPlace.fail(`Type "${group.name}" to confirm`, 'confirm');
      return;
    }
    setInPlaceTarget(null);
    const target = { destinationId: backup.destinationId, name: group.name, timestamp: backup.timestamp };
    inPlace.run(() => restoreContainerBackupInPlace(target, { safetyBackup: inPlaceSafety }), { key: backupKey(backup), about: aboutOf(backup, group) });
  };

  /* ── Delete ── */

  /* The delete answers 204; the lists re-read on the `backups` frame it announces. */
  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    const { group, backup } = deleteTarget;
    setDeleteTarget(null);
    remove.run(() => sendAndAwaitTopic(TOPIC.BACKUPS, () => (backup.kind === 'container'
      ? deleteContainerBackup({ destinationId: backup.destinationId, name: backup.name, timestamp: backup.timestamp })
      : deleteBackup({ destinationId: backup.destinationId, vmName: backup.name, timestamp: backup.timestamp }))), {
      key: backupKey(backup), about: aboutOf(backup, group),
    });
  };

  /* ── Rendering ── */

  const renderGroupCard = (group) => {
    const isOpen = expanded.has(group.key);
    const activeJob = activeJobFor(group);
    /* Any job on the workload (a start, a delete…) holds it: its commands would be refused. */
    const busyJob = workloadBusyJob(jobs, subjectOf(group));
    const stopped = isWorkloadStopped(group);
    const { dotClass, text: statusText } = groupStatusLine(group, !!schedule?.enabled);
    const backupDisabled = !group.live || !!busyJob
      || (group.kind === 'vm' ? !stopped : (group.state === 'pausing' || group.state === 'unknown'));
    const backupDisabledTitle = !group.live
      ? 'Workload no longer exists'
      : busyJob
        ? workloadBusyReason(busyJob)
        : group.kind === 'vm' && !stopped
          ? 'VM must be stopped to back up'
          : 'Back up now';

    return (
      <div key={group.key} className={`rounded-card border border-surface-border bg-surface-card ${group.live ? '' : 'opacity-75'}`}>
        <div
          className="flex cursor-pointer select-none flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2.5 lg:px-5"
          onClick={() => toggleExpanded(group.key)}
        >
          {isOpen
            ? <ChevronDown size={14} className="shrink-0 text-text-muted" aria-hidden />
            : <ChevronRight size={14} className="shrink-0 text-text-muted" aria-hidden />}
          <span className="text-sm font-semibold text-text-primary">{group.name}</span>
          <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${group.kind === 'container' ? 'bg-accent-soft text-accent-text' : 'bg-surface-border text-text-secondary'}`}>
            {group.kind === 'container' ? 'container' : 'vm'}
          </span>
          {group.kind === 'container' && group.live && (
            group.autoBackup ? (
              <span
                className="inline-flex items-center rounded-sm bg-status-running-soft px-1.5 py-0.5 text-[10px] font-medium text-status-running"
                title={schedule?.enabled ? `Scheduled daily at ${schedule.time}` : 'Auto Backup is on, but the scheduler is disabled in Host Mgmt'}
              >
                {schedule?.enabled ? `auto · daily ${schedule.time}` : 'auto · scheduler off'}
              </span>
            ) : (
              <span className="inline-flex items-center rounded-sm border border-dashed border-surface-border px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
                auto off
              </span>
            )
          )}
          {!group.live && (
            <span className="inline-flex items-center rounded-sm bg-status-warning-soft px-1.5 py-0.5 text-[10px] font-medium text-status-warning">
              workload deleted
            </span>
          )}

          <span className="flex-1" />

          {activeJob ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
              <Loader2 size={12} className="animate-spin text-accent" aria-hidden />
              {activeJob.title}…{activeJob.percent != null ? ` ${activeJob.percent}%` : ''}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-text-secondary">
              <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden />
              {statusText}
            </span>
          )}
          <span className="whitespace-nowrap text-[11px] text-text-muted">
            {group.backups.length} {group.backups.length === 1 ? 'backup' : 'backups'}
            {group.totalBytes > 0 && <> · {formatSize(group.totalBytes)}</>}
          </span>
          {group.live && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleOpenBackup(group); }}
              disabled={backupDisabled}
              className="flex items-center gap-0.5 rounded-md bg-accent px-2 py-1 text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              title={backupDisabledTitle}
              aria-label={`Back up ${group.name} now`}
            >
              <Plus size={12} aria-hidden />
              <Archive size={12} aria-hidden />
            </button>
          )}
        </div>

        {isOpen && (
          <div className="border-t border-surface-border px-4 pb-3 lg:px-5">
            {group.backups.length === 0 ? (
              <p className="py-3 text-sm text-text-muted">
                No backups yet. Use the header button to create the first one.
              </p>
            ) : (
              <DataTableScroll>
                <DataTable>
                  <thead>
                    <tr className={dataTableHeadRowClass}>
                      <DataTableTh>When</DataTableTh>
                      <DataTableTh>Origin</DataTableTh>
                      <DataTableTh>Location</DataTableTh>
                      <DataTableTh>Size</DataTableTh>
                      <DataTableTh align="right">Actions</DataTableTh>
                    </tr>
                  </thead>
                  <tbody>
                    {group.backups.map((b) => {
                      const iso = backupTsToIso(b.timestamp);
                      /* Every control of the row is disabled while a command on it runs. */
                      const k = backupKey(b);
                      const rowBusy = restore.isBusy(k) || remove.isBusy(k) || inPlace.isBusy(k);
                      const inPlaceDisabled = !group.live || !stopped || !!busyJob || rowBusy || inPlaceRunning(group);
                      const inPlaceTitle = !group.live
                        ? 'Workload no longer exists — restore as new instead'
                        : !stopped
                          ? 'Stop the container first'
                          : busyJob
                            ? workloadBusyReason(busyJob)
                            : 'Restore in place (overwrite current state)';
                      return (
                        <tr key={`${b.destinationId}:${b.timestamp}`} className={dataTableInteractiveRowClass}>
                          <DataTableTd>
                            <span className="font-mono text-xs text-text-secondary">{b.timestamp}</span>
                            {iso && <span className="ml-2 text-[11px] text-text-muted">{formatRelativeTime(iso)}</span>}
                          </DataTableTd>
                          <DataTableTd><OriginBadge origin={b.origin} /></DataTableTd>
                          <DataTableTd><DestinationBadge label={b.destinationLabel} /></DataTableTd>
                          <DataTableTd className="text-sm text-text-secondary">{b.sizeBytes != null ? formatSize(b.sizeBytes) : '—'}</DataTableTd>
                          <DataTableTd align="right">
                            <DataTableRowActions forceVisible={rowBusy}>
                              {group.kind === 'container' && (
                                <button
                                  type="button"
                                  onClick={() => handleOpenInPlace(group, b)}
                                  disabled={inPlaceDisabled}
                                  className={`${rowActionIconBtn} disabled:cursor-not-allowed disabled:opacity-40`}
                                  title={inPlaceTitle}
                                  aria-label={`Restore ${group.name} in place from ${b.timestamp}`}
                                >
                                  {inPlace.isBusy(k) ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ArchiveRestore size={14} aria-hidden />}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => { setRestoreTarget({ group, backup: b }); setRestoreName(''); }}
                                disabled={rowBusy}
                                className={rowActionIconBtn}
                                title={group.kind === 'container' ? 'Restore as new container' : 'Restore as new VM'}
                                aria-label={`Restore ${group.name} backup ${b.timestamp} as new`}
                              >
                                <CopyPlus size={14} aria-hidden />
                              </button>
                              <button
                                type="button"
                                onClick={() => setDeleteTarget({ group, backup: b })}
                                disabled={rowBusy}
                                className={`${rowActionIconBtn} hover:bg-status-stopped-soft hover:text-status-stopped`}
                                title="Delete backup"
                                aria-label={`Delete backup ${b.timestamp} of ${group.name}`}
                              >
                                {remove.isBusy(k) ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                              </button>
                            </DataTableRowActions>
                          </DataTableTd>
                        </tr>
                      );
                    })}
                  </tbody>
                </DataTable>
              </DataTableScroll>
            )}

            {restoreTarget && restoreTarget.group.key === group.key && (
              <div className="mt-3 rounded-md border border-surface-border bg-surface p-4">
                <p className="text-sm font-medium text-text-primary">
                  Restore &ldquo;{group.name}&rdquo; ({restoreTarget.backup.timestamp}) as new {group.kind === 'container' ? 'container' : 'VM'}
                </p>
                <ErrorBanner className="mt-1" error={restore.errorOf(backupKey(restoreTarget.backup))} onDismiss={() => restore.dismiss(backupKey(restoreTarget.backup))} />
                <input
                  type="text"
                  value={restoreName}
                  onChange={(e) => setRestoreName(e.target.value)}
                  placeholder={group.kind === 'container' ? 'New container name' : 'New VM name'}
                  className="input-field mt-2 w-full max-w-xs"
                />
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={() => { setRestoreTarget(null); setRestoreName(''); }}
                    className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRestoreAsNew}
                    disabled={!restoreName.trim() || restore.isBusy(backupKey(restoreTarget.backup))}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    {restore.isBusy(backupKey(restoreTarget.backup)) ? 'Restoring…' : 'Restore'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-surface-border px-6 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">Backups</h2>
        <p className="mt-0.5 text-sm text-text-secondary">
          Every VM and container that carries a backup: back up again, restore as a new copy (containers also in place), and delete old backups.
          Containers with Auto Backup follow the scheduler in Host Mgmt.
        </p>
      </div>

      <div className="flex-1 space-y-3 px-4 py-4 lg:px-6 lg:py-5">
        <RecordError record={settingsRecord} what="settings" />
        <ErrorBanner error={statusError} prefix="Couldn't load the last backup attempts" onDismiss={dismissStatusError} />
        <CommandErrors
          commands={[remove, inPlace]}
          shows={(error) => typeof error !== 'string'}
          prefix={(key, command, about) => (command === remove
            ? `Couldn't delete ${about?.backup ?? 'the backup'}`
            : `Couldn't restore ${about?.workload ?? 'the container'} in place`)}
        />
        <RecordError record={vmList} what="VM backups" />
        <RecordError record={ctList} what="container backups" />
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        ) : visibleGroups.length === 0 ? (
          vmList.error || ctList.error ? null : <p className="text-sm text-text-muted">
            No backups yet. Back up a VM or container from its page and it will appear here.
          </p>
        ) : (
          visibleGroups.map(renderGroupCard)
        )}
      </div>

      {backupTarget && (
        <BackupModal
          name={backupTarget.name}
          subjectLabel={backupTarget.kind === 'vm' ? 'VM' : 'Container'}
          settingsRecord={settingsRecord}
          runningJobId={runningBackupOf(backupTarget)}
          start={(destinationIds) => (backupTarget.kind === 'vm' ? startBackup : startContainerBackup)(
            backupTarget.name, { destinationIds },
          )}
          onClose={() => setBackupTarget(null)}
        />
      )}

      <ConfirmDialog
        open={!!inPlaceTarget}
        title={inPlaceTarget ? `Restore ${inPlaceTarget.group.name} in place` : ''}
        confirmLabel="Restore in place"
        onConfirm={handleInPlaceConfirm}
        onCancel={() => setInPlaceTarget(null)}
      >
        {inPlaceTarget && (
          <div className="space-y-3 px-4 py-4 text-sm text-text-secondary">
            <p>
              Overwrites the current state of <span className="font-medium text-text-primary">{inPlaceTarget.group.name}</span> with
              the backup from <span className="font-mono text-xs">{inPlaceTarget.backup.timestamp}</span> ({inPlaceTarget.backup.destinationLabel}).
              Name and network identity are preserved; data and configuration revert to the backup.
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={inPlaceSafety}
                onChange={(e) => setInPlaceSafety(e.target.checked)}
                className="rounded-sm border-surface-border"
              />
              <span>Take a safety backup of the current state first</span>
            </label>
            <div>
              <label className="mb-1 block text-xs text-text-muted">
                Type the container name to confirm
              </label>
              <input
                type="text"
                value={inPlaceName}
                onChange={(e) => setInPlaceName(e.target.value)}
                placeholder={inPlaceTarget.group.name}
                className="input-field w-full max-w-xs"
              />
            </div>
            <ErrorBanner error={inPlace.errorOf('confirm')} onDismiss={() => inPlace.dismiss('confirm')} />
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete backup"
        confirmLabel="Delete"
        onConfirm={handleDeleteConfirm}
        onCancel={() => setDeleteTarget(null)}
      >
        {deleteTarget && (
          <div className="space-y-2 px-4 py-4 text-sm text-text-secondary">
            <p>
              Delete backup <span className="font-mono text-xs">{deleteTarget.backup.timestamp}</span> of{' '}
              <span className="font-medium text-text-primary">{deleteTarget.group.name}</span> from {deleteTarget.backup.destinationLabel || 'backup storage'}?
            </p>
            <p className="text-xs text-text-muted">This cannot be undone.</p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
