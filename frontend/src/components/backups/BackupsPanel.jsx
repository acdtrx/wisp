import { useState, useEffect, useCallback } from 'react';
import { Loader2, Trash2, RotateCcw } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
} from '../shared/DataTableChrome.jsx';
import {
  listBackups,
  restoreBackup,
  deleteBackup,
  listContainerBackups,
  restoreContainerBackup,
  deleteContainerBackup,
} from '../../api/backups.js';
import { formatSize } from '../../utils/formatters.js';

/* Merge VM + container backup lists into a single shape with a `type`
 * discriminator. VM rows carry `vmName`, container rows carry `name`; the
 * panel normalizes both to `displayName` for the table. */
function decorateVmRow(row) {
  return {
    type: 'vm',
    displayName: row.vmName,
    timestamp: row.timestamp,
    path: row.path,
    sizeBytes: row.sizeBytes,
    destinationLabel: row.destinationLabel,
  };
}

function decorateContainerRow(row) {
  return {
    type: 'container',
    displayName: row.name,
    timestamp: row.timestamp,
    path: row.path,
    sizeBytes: row.sizeBytes,
    destinationLabel: row.destinationLabel,
    image: row.image,
  };
}

function compareBackups(a, b) {
  /* Newer first, then by name asc. */
  const ts = (b.timestamp || '').localeCompare(a.timestamp || '');
  if (ts !== 0) return ts;
  return (a.displayName || '').localeCompare(b.displayName || '');
}

export default function BackupsPanel() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restoreName, setRestoreName] = useState('');
  const [restoreSaving, setRestoreSaving] = useState(false);
  const [restoreError, setRestoreError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const fetchList = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.allSettled([listBackups(), listContainerBackups()])
      .then(([vmRes, ctRes]) => {
        const vms = vmRes.status === 'fulfilled' && Array.isArray(vmRes.value)
          ? vmRes.value.map(decorateVmRow) : [];
        const cts = ctRes.status === 'fulfilled' && Array.isArray(ctRes.value)
          ? ctRes.value.map(decorateContainerRow) : [];
        const merged = [...vms, ...cts].sort(compareBackups);
        setList(merged);
        const errs = [vmRes, ctRes]
          .filter((r) => r.status === 'rejected')
          .map((r) => r.reason?.message || 'Failed to load backups');
        if (errs.length) setError(errs.join('; '));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const handleRestore = async () => {
    if (!restoreTarget || !restoreName.trim()) return;
    setRestoreError(null);
    setRestoreSaving(true);
    try {
      if (restoreTarget.type === 'container') {
        await restoreContainerBackup(restoreTarget.path, restoreName.trim());
      } else {
        await restoreBackup(restoreTarget.path, restoreName.trim());
      }
      setRestoreTarget(null);
      setRestoreName('');
      fetchList();
    } catch (err) {
      setRestoreError(err.message || 'Restore failed');
    } finally {
      setRestoreSaving(false);
    }
  };

  const handleDeleteBackup = async () => {
    if (!deleteTarget) return;
    setDeleteError(null);
    setDeleteSaving(true);
    try {
      if (deleteTarget.type === 'container') {
        await deleteContainerBackup(deleteTarget.path);
      } else {
        await deleteBackup(deleteTarget.path);
      }
      setDeleteTarget(null);
      fetchList();
    } catch (err) {
      setDeleteError(err.message || 'Delete failed');
    } finally {
      setDeleteSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-surface-border px-6 py-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">Backups</h2>
        <p className="mt-0.5 text-sm text-text-secondary">Restore VM or container backups under a new name, or delete backups you no longer need. Create backups from a VM or container Overview → Backup. Configure destinations in Host Mgmt.</p>
      </div>

      <div className="flex-1 space-y-5 px-6 py-5">
        <SectionCard
          title="Backups"
          helpText="Restore a backup as a new VM or container, or delete backups you no longer need."
          error={restoreError || deleteError}
        >
          {error && (
            <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-status-stopped">
              {error}
            </div>
          )}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading…
            </div>
          ) : list.length === 0 ? (
            <p className="text-sm text-text-muted">No backups found. Configure a backup path in Host Mgmt and create a backup from a VM or container Overview → Backup.</p>
          ) : (
            <DataTableScroll>
              <DataTable minWidthRem={52}>
                <thead>
                  <tr className={dataTableHeadRowClass}>
                    <DataTableTh>Type</DataTableTh>
                    <DataTableTh>Name</DataTableTh>
                    <DataTableTh>Location</DataTableTh>
                    <DataTableTh>Timestamp</DataTableTh>
                    <DataTableTh>Size</DataTableTh>
                    <DataTableTh align="right">Actions</DataTableTh>
                  </tr>
                </thead>
                <tbody>
                  {list.map((b) => (
                    <tr key={`${b.type}:${b.path}-${b.timestamp}`} className={dataTableInteractiveRowClass}>
                      <DataTableTd>
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${b.type === 'container' ? 'bg-accent/15 text-accent' : 'bg-surface-border text-text-secondary'}`}>
                          {b.type === 'container' ? 'container' : 'vm'}
                        </span>
                      </DataTableTd>
                      <DataTableTd className="text-sm font-medium text-text-primary">{b.displayName}</DataTableTd>
                      <DataTableTd>
                        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${b.destinationLabel === 'Local' ? 'bg-surface-border text-text-secondary' : 'bg-accent/15 text-accent'}`}>
                          {b.destinationLabel || '—'}
                        </span>
                      </DataTableTd>
                      <DataTableTd className="text-sm text-text-secondary font-mono text-xs">{b.timestamp}</DataTableTd>
                      <DataTableTd className="text-sm text-text-secondary">{b.sizeBytes != null ? formatSize(b.sizeBytes) : '—'}</DataTableTd>
                      <DataTableTd align="right">
                        <DataTableRowActions>
                          <button
                            type="button"
                            onClick={() => { setRestoreTarget(b); setRestoreName(''); setRestoreError(null); setDeleteError(null); }}
                            className="rounded p-1.5 text-text-secondary hover:bg-surface-sidebar hover:text-text-primary"
                            title={b.type === 'container' ? 'Restore as new container' : 'Restore as new VM'}
                            aria-label={`Restore backup ${b.displayName}`}
                          >
                            <RotateCcw size={14} aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => { setDeleteTarget(b); setDeleteError(null); }}
                            className="rounded p-1.5 text-text-secondary hover:bg-red-50 hover:text-status-stopped"
                            title="Delete backup"
                            aria-label={`Delete backup ${b.displayName}`}
                          >
                            <Trash2 size={14} aria-hidden />
                          </button>
                        </DataTableRowActions>
                      </DataTableTd>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            </DataTableScroll>
          )}
          {deleteTarget && (
            <div className="mt-4 rounded-md border border-surface-border bg-surface p-4">
              <p className="text-sm font-medium text-text-primary">
                Delete backup &ldquo;{deleteTarget.displayName}&rdquo; ({deleteTarget.timestamp}) from {deleteTarget.destinationLabel || 'backup'}?
              </p>
              <p className="mt-1 text-xs text-text-muted">This cannot be undone.</p>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => { setDeleteTarget(null); setDeleteError(null); }}
                  className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteBackup}
                  disabled={deleteSaving}
                  className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  {deleteSaving ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </div>
          )}
          {restoreTarget && (
            <div className="mt-4 rounded-md border border-surface-border bg-surface p-4">
              <p className="text-sm font-medium text-text-primary">
                Restore &ldquo;{restoreTarget.displayName}&rdquo; ({restoreTarget.timestamp}) as new {restoreTarget.type === 'container' ? 'container' : 'VM'}
              </p>
              <input
                type="text"
                value={restoreName}
                onChange={(e) => setRestoreName(e.target.value)}
                placeholder={restoreTarget.type === 'container' ? 'New container name' : 'New VM name'}
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
                  onClick={handleRestore}
                  disabled={!restoreName.trim() || restoreSaving}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  {restoreSaving ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
