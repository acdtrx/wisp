import { useState, useEffect, useCallback } from 'react';
import { Camera, Plus, RotateCcw, Trash2 } from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
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
  getVMSnapshots,
  createVMSnapshot,
  revertVMSnapshot,
  deleteVMSnapshot,
} from '../../api/vms.js';

function formatCreationTime(creationTime) {
  if (creationTime == null) return '—';
  if (typeof creationTime === 'number') {
    return new Date(creationTime * 1000).toLocaleString();
  }
  return String(creationTime);
}

export default function SnapshotsSection({ vmConfig }) {
  const [snapshots, setSnapshots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [revertTarget, setRevertTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const fetchSnapshots = useCallback(() => {
    setLoadError(null);
    getVMSnapshots(vmConfig.name)
      .then(data => setSnapshots(Array.isArray(data) ? data : []))
      .catch(err => {
        setSnapshots([]);
        setLoadError(err.message || 'Failed to load snapshots');
      })
      .finally(() => setLoading(false));
  }, [vmConfig.name]);

  useEffect(() => {
    setLoading(true);
    fetchSnapshots();
  }, [fetchSnapshots]);

  const diskIsQcow2 = vmConfig.disks?.some(d => d.device === 'disk' && d.driverType === 'qcow2');

  const handleCreate = () => {
    const name = createName.trim();
    if (!name) {
      setCreateError('Snapshot name is required');
      return;
    }
    setCreateError(null);
    setCreateSubmitting(true);
    createVMSnapshot(vmConfig.name, name)
      .then(() => {
        setCreateOpen(false);
        setCreateName('');
        fetchSnapshots();
      })
      .catch(err => setCreateError(err.message || 'Failed to create snapshot'))
      .finally(() => setCreateSubmitting(false));
  };

  const handleRevert = () => {
    if (!revertTarget) return;
    setActionError(null);
    revertVMSnapshot(vmConfig.name, revertTarget.name)
      .then(() => {
        setRevertTarget(null);
        fetchSnapshots();
      })
      .catch(err => {
        setActionError(err.message || 'Failed to revert');
        setRevertTarget(null);
      });
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    setActionError(null);
    deleteVMSnapshot(vmConfig.name, deleteTarget.name)
      .then(() => {
        setDeleteTarget(null);
        fetchSnapshots();
      })
      .catch(err => {
        setActionError(err.message || 'Failed to delete snapshot');
        setDeleteTarget(null);
      });
  };

  const snapshotHeaderAdd = diskIsQcow2 ? (
    <button
      type="button"
      onClick={() => { setCreateOpen(true); setCreateError(null); setCreateName(''); }}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Create snapshot"
      aria-label="Create snapshot"
    >
      <Plus size={14} aria-hidden />
      <Camera size={14} aria-hidden />
    </button>
  ) : undefined;

  return (
    <SectionCard title="Snapshots" headerAction={snapshotHeaderAdd}>
      {!diskIsQcow2 && (
        <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-status-warning">
          Snapshots require qcow2 disk format.
        </div>
      )}

      {actionError && (
        <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-status-stopped">
          {actionError}
        </div>
      )}

      {loadError && (
        <div className="mb-3 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-status-stopped">
          {loadError}
        </div>
      )}

      {loading ? (
        <p className="text-xs text-text-muted py-2">Loading…</p>
      ) : snapshots.length === 0 ? (
        <div className="flex flex-col items-center py-6 text-center">
          <Camera size={24} className="text-text-muted mb-2" />
          <p className="text-xs text-text-muted">No snapshots</p>
          <p className="text-[10px] text-text-muted mt-1">
            {diskIsQcow2 ? 'Use the add control in the section header to create a snapshot.' : 'Create and manage snapshots in a future update.'}
          </p>
        </div>
      ) : (
        <DataTableScroll>
          <DataTable minWidthRem={36}>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh>Name</DataTableTh>
                <DataTableTh>Created</DataTableTh>
                <DataTableTh>State</DataTableTh>
                {diskIsQcow2 && (
                  <DataTableTh align="right" className="w-28">Actions</DataTableTh>
                )}
              </tr>
            </thead>
            <tbody>
              {snapshots.map((snap, i) => (
                <tr key={snap.name || i} className={dataTableInteractiveRowClass}>
                  <DataTableTd className="text-xs text-text-primary">{snap.name}</DataTableTd>
                  <DataTableTd className="text-xs text-text-secondary">{formatCreationTime(snap.creationTime)}</DataTableTd>
                  <DataTableTd className="text-xs text-text-muted">{snap.state || '—'}</DataTableTd>
                  {diskIsQcow2 && (
                    <DataTableTd align="right">
                      <DataTableRowActions>
                        <button
                          type="button"
                          onClick={() => setRevertTarget(snap)}
                          className="inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors"
                          title="Revert to this snapshot"
                          aria-label={`Revert to snapshot ${snap.name}`}
                        >
                          <RotateCcw size={14} aria-hidden />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(snap)}
                          className="inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-muted hover:bg-red-50 hover:text-status-stopped transition-colors"
                          title="Delete snapshot"
                          aria-label={`Delete snapshot ${snap.name}`}
                        >
                          <Trash2 size={14} aria-hidden />
                        </button>
                      </DataTableRowActions>
                    </DataTableTd>
                  )}
                </tr>
              ))}
            </tbody>
          </DataTable>
        </DataTableScroll>
      )}

      {/* Create Snapshot modal */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/30" onClick={() => !createSubmitting && setCreateOpen(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-card bg-surface-card p-6 shadow-lg" data-wisp-modal-root>
            <h3 className="text-sm font-semibold text-text-primary">Create Snapshot</h3>
            <p className="mt-1 text-xs text-text-secondary">Enter a name for the snapshot.</p>
            <input
              type="text"
              value={createName}
              onChange={e => setCreateName(e.target.value)}
              placeholder="Snapshot name"
              className="input-field mt-3 bg-surface placeholder:text-text-muted"
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreateOpen(false); }}
              autoFocus
            />
            {createError && (
              <p className="mt-2 text-xs text-status-stopped">{createError}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => !createSubmitting && setCreateOpen(false)}
                className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface transition-colors"
                disabled={createSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreate}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-50"
                disabled={createSubmitting}
              >
                {createSubmitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!revertTarget}
        title="Revert to snapshot"
        message={revertTarget ? `Revert to snapshot "${revertTarget.name}"? The VM will be restored to this state and may need to be started.` : ''}
        confirmLabel="Revert"
        onConfirm={handleRevert}
        onCancel={() => setRevertTarget(null)}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete snapshot"
        message={deleteTarget ? `Delete snapshot "${deleteTarget.name}"? This cannot be undone.` : ''}
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </SectionCard>
  );
}
