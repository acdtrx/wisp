import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Loader2, Trash2, ChevronDown, ChevronRight, Plus, Archive, ArchiveRestore, CopyPlus,
} from 'lucide-react';

import BackupModal from '../shared/BackupModal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
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
  listBackups,
  restoreBackup,
  restoreBackupInPlace,
  deleteBackup,
  startContainerBackup,
  listContainerBackups,
  restoreContainerBackup,
  restoreContainerBackupInPlace,
  deleteContainerBackup,
} from '../../api/backups.js';
import { getSettings } from '../../api/settings.js';
import { subscribeTopic } from '../../api/events.js';
import { JOB_KIND } from '../../api/jobProgress.js';
import { useBackgroundJobsStore } from '../../store/backgroundJobsStore.js';
import { useVmStore } from '../../store/vmStore.js';
import { useContainerStore } from '../../store/containerStore.js';
import { formatSize, formatRelativeTime } from '../../utils/formatters.js';

const VM_STOPPED_STATES = ['shutoff', 'nostate', 'shutdown'];

/** Backup dir timestamps are ISO with `:` swapped to `-` (2026-05-08T06-30-00). */
function backupTsToIso(ts) {
  if (typeof ts !== 'string') return null;
  const m = ts.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : null;
}

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
    <span className="inline-flex items-center rounded-sm bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">scheduled</span>
  ) : (
    <span className="inline-flex items-center rounded-sm border border-surface-border px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">manual</span>
  );
}

function DestinationBadge({ label }) {
  return (
    <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${label === 'Local' ? 'bg-surface-border text-text-secondary' : 'bg-accent-soft text-accent'}`}>
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

export default function BackupsPanel() {
  const vms = useVmStore((s) => s.vms);
  const containers = useContainerStore((s) => s.containers);
  const bgJobs = useBackgroundJobsStore((s) => s.jobs);
  const registerJob = useBackgroundJobsStore((s) => s.registerJob);

  const [vmBackups, setVmBackups] = useState([]);
  const [ctBackups, setCtBackups] = useState([]);
  const [status, setStatus] = useState(null);
  const [schedule, setSchedule] = useState(null);
  const [destinations, setDestinations] = useState([{ id: 'local', label: 'Local', path: '/var/lib/wisp/backups' }]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());

  /* Back up now (BackupModal) */
  const [backupTarget, setBackupTarget] = useState(null);
  const [backupSelectedIds, setBackupSelectedIds] = useState(['local']);
  const [backupJobId, setBackupJobId] = useState(null);
  const [backupError, setBackupError] = useState(null);

  /* Restore as new (inline strip) */
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restoreName, setRestoreName] = useState('');
  const [restoreSaving, setRestoreSaving] = useState(false);
  const [restoreError, setRestoreError] = useState(null);

  /* Restore in place (confirm dialog) */
  const [inPlaceTarget, setInPlaceTarget] = useState(null);
  const [inPlaceName, setInPlaceName] = useState('');
  const [inPlaceSafety, setInPlaceSafety] = useState(true);
  const [inPlaceSaving, setInPlaceSaving] = useState(false);
  const [inPlaceError, setInPlaceError] = useState(null);

  /* Delete (confirm dialog) */
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const fetchLists = useCallback((initial = false) => {
    if (initial) setLoading(true);
    setError(null);
    Promise.allSettled([listBackups(), listContainerBackups()])
      .then(([vmRes, ctRes]) => {
        setVmBackups(vmRes.status === 'fulfilled' && Array.isArray(vmRes.value) ? vmRes.value : []);
        setCtBackups(ctRes.status === 'fulfilled' && Array.isArray(ctRes.value) ? ctRes.value : []);
        const errs = [vmRes, ctRes]
          .filter((r) => r.status === 'rejected')
          .map((r) => r.reason?.message || 'Failed to load backups');
        if (errs.length) setError(errs.join('; '));
      })
      .finally(() => { if (initial) setLoading(false); });
  }, []);

  useEffect(() => {
    fetchLists(true);
  }, [fetchLists]);

  /* Status pushes on the multiplexed events stream; each frame doubles as the
   * cue that the backup lists changed (scheduler run, job finished, delete). */
  const firstFrameRef = useRef(true);
  useEffect(() => {
    const unsubscribe = subscribeTopic('backups', (data) => {
      if (data && !data.error) setStatus(data);
      if (firstFrameRef.current) {
        firstFrameRef.current = false;
        return;
      }
      fetchLists();
    });
    return unsubscribe;
  }, [fetchLists]);

  useEffect(() => {
    getSettings()
      .then((s) => {
        const dests = [{ id: 'local', label: 'Local', path: s.backupLocalPath || '/var/lib/wisp/backups' }];
        if (s.backupMountId) {
          const m = (s.mounts || []).find((x) => x.id === s.backupMountId);
          if (m?.mountPath) dests.push({ id: m.id, label: m.label || 'Mount', path: m.mountPath });
        }
        setDestinations(dests);
        setSchedule(s.backupSchedule || null);
      })
      .catch(() => {
        /* settings unavailable — Local default keeps Back up now usable */
      });
  }, []);

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

  /** The running backup/restore job for a workload, if any (matched by title, like the Overview panels). */
  const activeJobFor = (group) => Object.values(bgJobs).find(
    (j) => j.status === 'running' && (j.title === `Backup ${group.name}` || j.title === `Restore ${group.name}`),
  ) || null;

  const isWorkloadStopped = (group) => (
    group.kind === 'vm'
      ? VM_STOPPED_STATES.includes(group.state)
      : group.state === 'stopped' || group.state === 'created'
  );

  /* ── Back up now ── */

  const handleOpenBackup = (group) => {
    setBackupError(null);
    setBackupSelectedIds(['local']);
    const existing = Object.entries(bgJobs).find(
      ([, j]) => j.status === 'running'
        && j.kind === (group.kind === 'vm' ? JOB_KIND.BACKUP : JOB_KIND.CONTAINER_BACKUP)
        && j.title === `Backup ${group.name}`,
    );
    setBackupJobId(existing ? existing[0] : null);
    setBackupTarget(group);
  };

  const handleStartBackup = async () => {
    if (!backupTarget) return;
    setBackupError(null);
    try {
      const isVm = backupTarget.kind === 'vm';
      const start = isVm ? startBackup : startContainerBackup;
      const { jobId, title } = await start(backupTarget.name, { destinationIds: backupSelectedIds });
      registerJob({ jobId, kind: isVm ? JOB_KIND.BACKUP : JOB_KIND.CONTAINER_BACKUP, title });
      setBackupJobId(jobId);
    } catch (err) {
      setBackupError(err.message || 'Backup failed to start');
    }
  };

  /* ── Restore as new ── */

  const handleRestoreAsNew = async () => {
    if (!restoreTarget || !restoreName.trim() || restoreSaving) return;
    setRestoreError(null);
    setRestoreSaving(true);
    try {
      const { backup } = restoreTarget;
      if (backup.kind === 'container') {
        await restoreContainerBackup(
          { destinationId: backup.destinationId, name: backup.name, timestamp: backup.timestamp },
          restoreName.trim(),
        );
      } else {
        await restoreBackup(
          { destinationId: backup.destinationId, vmName: backup.name, timestamp: backup.timestamp },
          restoreName.trim(),
        );
      }
      setRestoreTarget(null);
      setRestoreName('');
      fetchLists();
    } catch (err) {
      setRestoreError(err.message || 'Restore failed');
    } finally {
      setRestoreSaving(false);
    }
  };

  /* ── Restore in place ── */

  const handleOpenInPlace = (group, backup) => {
    setInPlaceTarget({ group, backup });
    setInPlaceName('');
    setInPlaceSafety(true);
    setInPlaceError(null);
  };

  const handleInPlaceConfirm = async () => {
    if (!inPlaceTarget || inPlaceSaving) return;
    const { group, backup } = inPlaceTarget;
    if (inPlaceName.trim() !== group.name) {
      setInPlaceError(`Type "${group.name}" to confirm`);
      return;
    }
    setInPlaceError(null);
    setInPlaceSaving(true);
    try {
      const isVm = group.kind === 'vm';
      const call = isVm ? restoreBackupInPlace : restoreContainerBackupInPlace;
      const target = isVm
        ? { destinationId: backup.destinationId, vmName: group.name, timestamp: backup.timestamp }
        : { destinationId: backup.destinationId, name: group.name, timestamp: backup.timestamp };
      const { jobId, title } = await call(target, { safetyBackup: inPlaceSafety });
      registerJob({ jobId, kind: isVm ? JOB_KIND.VM_RESTORE : JOB_KIND.CONTAINER_RESTORE, title });
      setInPlaceTarget(null);
    } catch (err) {
      setInPlaceError(err.message || 'Restore failed to start');
    } finally {
      setInPlaceSaving(false);
    }
  };

  /* ── Delete ── */

  const handleDeleteConfirm = async () => {
    if (!deleteTarget || deleteSaving) return;
    setDeleteError(null);
    setDeleteSaving(true);
    try {
      const { backup } = deleteTarget;
      if (backup.kind === 'container') {
        await deleteContainerBackup({ destinationId: backup.destinationId, name: backup.name, timestamp: backup.timestamp });
      } else {
        await deleteBackup({ destinationId: backup.destinationId, vmName: backup.name, timestamp: backup.timestamp });
      }
      setDeleteTarget(null);
      fetchLists();
    } catch (err) {
      setDeleteError(err.message || 'Delete failed');
    } finally {
      setDeleteSaving(false);
    }
  };

  /* ── Rendering ── */

  const renderGroupCard = (group) => {
    const isOpen = expanded.has(group.key);
    const activeJob = activeJobFor(group);
    const stopped = isWorkloadStopped(group);
    const { dotClass, text: statusText } = groupStatusLine(group, !!schedule?.enabled);
    const backupDisabled = !group.live || !!activeJob
      || (group.kind === 'vm' ? !stopped : (group.state === 'pausing' || group.state === 'unknown'));
    const backupDisabledTitle = !group.live
      ? 'Workload no longer exists'
      : activeJob
        ? 'A backup or restore is already running'
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
          <span className={`inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${group.kind === 'container' ? 'bg-accent-soft text-accent' : 'bg-surface-border text-text-secondary'}`}>
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
                <DataTable minWidthRem={44}>
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
                      const inPlaceDisabled = !group.live || !stopped || !!activeJob;
                      const inPlaceTitle = !group.live
                        ? 'Workload no longer exists — restore as new instead'
                        : !stopped
                          ? `Stop the ${group.kind === 'vm' ? 'VM' : 'container'} first`
                          : activeJob
                            ? 'A backup or restore is already running'
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
                            <DataTableRowActions>
                              <button
                                type="button"
                                onClick={() => handleOpenInPlace(group, b)}
                                disabled={inPlaceDisabled}
                                className={`${rowActionIconBtn} disabled:cursor-not-allowed disabled:opacity-40`}
                                title={inPlaceTitle}
                                aria-label={`Restore ${group.name} in place from ${b.timestamp}`}
                              >
                                <ArchiveRestore size={14} aria-hidden />
                              </button>
                              <button
                                type="button"
                                onClick={() => { setRestoreTarget({ group, backup: b }); setRestoreName(''); setRestoreError(null); }}
                                className={rowActionIconBtn}
                                title={group.kind === 'container' ? 'Restore as new container' : 'Restore as new VM'}
                                aria-label={`Restore ${group.name} backup ${b.timestamp} as new`}
                              >
                                <CopyPlus size={14} aria-hidden />
                              </button>
                              <button
                                type="button"
                                onClick={() => { setDeleteTarget({ group, backup: b }); setDeleteError(null); }}
                                className={`${rowActionIconBtn} hover:bg-status-stopped-soft hover:text-status-stopped`}
                                title="Delete backup"
                                aria-label={`Delete backup ${b.timestamp} of ${group.name}`}
                              >
                                <Trash2 size={14} aria-hidden />
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
                {restoreError && <p className="mt-1 text-xs text-status-stopped">{restoreError}</p>}
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
                    onClick={() => { setRestoreTarget(null); setRestoreName(''); setRestoreError(null); }}
                    className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRestoreAsNew}
                    disabled={!restoreName.trim() || restoreSaving}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  >
                    {restoreSaving ? 'Restoring…' : 'Restore'}
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
          Backup coverage per VM and container: back up now, restore in place or as a new copy, and delete old backups.
          Containers with Auto Backup follow the scheduler in Host Mgmt.
        </p>
      </div>

      <div className="flex-1 space-y-3 px-4 py-4 lg:px-6 lg:py-5">
        {error && (
          <div className="rounded-md border border-status-stopped/30 bg-status-stopped-soft px-3 py-2 text-sm text-status-stopped">
            {error}
          </div>
        )}
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading…
          </div>
        ) : groups.length === 0 ? (
          <p className="text-sm text-text-muted">No VMs or containers yet. Backups will show up here per workload.</p>
        ) : (
          groups.map(renderGroupCard)
        )}
      </div>

      {backupTarget && (
        <BackupModal
          name={backupTarget.name}
          subjectLabel={backupTarget.kind === 'vm' ? 'VM' : 'Container'}
          backupStarted={!!backupJobId}
          destinations={destinations}
          selectedIds={backupSelectedIds}
          onToggleDestination={(id) => setBackupSelectedIds((prev) => (
            prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
          ))}
          progress={backupJobId && bgJobs[backupJobId] ? {
            step: bgJobs[backupJobId].step || 'starting',
            percent: bgJobs[backupJobId].percent,
            currentFile: bgJobs[backupJobId].detail,
          } : null}
          error={backupError || (backupJobId && bgJobs[backupJobId]?.status === 'error' ? bgJobs[backupJobId].error : null)}
          onStart={handleStartBackup}
          onClose={() => { setBackupTarget(null); setBackupJobId(null); setBackupError(null); }}
        />
      )}

      <ConfirmDialog
        open={!!inPlaceTarget}
        title={inPlaceTarget ? `Restore ${inPlaceTarget.group.name} in place` : ''}
        confirmLabel={inPlaceSaving ? 'Starting…' : 'Restore in place'}
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
                Type the {inPlaceTarget.group.kind === 'vm' ? 'VM' : 'container'} name to confirm
              </label>
              <input
                type="text"
                value={inPlaceName}
                onChange={(e) => setInPlaceName(e.target.value)}
                placeholder={inPlaceTarget.group.name}
                className="input-field w-full max-w-xs"
              />
            </div>
            {inPlaceError && <p className="text-xs text-status-stopped">{inPlaceError}</p>}
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete backup"
        confirmLabel={deleteSaving ? 'Deleting…' : 'Delete'}
        onConfirm={handleDeleteConfirm}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null); }}
      >
        {deleteTarget && (
          <div className="space-y-2 px-4 py-4 text-sm text-text-secondary">
            <p>
              Delete backup <span className="font-mono text-xs">{deleteTarget.backup.timestamp}</span> of{' '}
              <span className="font-medium text-text-primary">{deleteTarget.group.name}</span> from {deleteTarget.backup.destinationLabel || 'backup storage'}?
            </p>
            <p className="text-xs text-text-muted">This cannot be undone.</p>
            {deleteError && <p className="text-xs text-status-stopped">{deleteError}</p>}
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
