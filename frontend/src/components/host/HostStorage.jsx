import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Loader2,
  Save,
  Pencil,
  X,
  Plug,
  Unplug,
  ShieldCheck,
  Server,
  HardDrive,
} from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableBodyRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
  dataTableEmptyCellClass,
} from '../shared/DataTableChrome.jsx';
import { randomId } from '../../utils/randomId.js';
import { useSettingsStore } from '../../store/settingsStore.js';
import { useDiskStore } from '../../store/diskStore.js';
import {
  addMount,
  patchMount,
  deleteMount,
  getMountStatus,
  mountMount,
  unmountMount,
  checkMountConnection,
} from '../../api/settings.js';

const iconBtn = 'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

const SUPPORTED_FSTYPES = ['ext4', 'btrfs', 'vfat', 'exfat', 'ntfs3'];

function truncate(s, max) {
  const t = (s || '').trim();
  if (t.length <= max) return t || '—';
  return `${t.slice(0, max - 1)}…`;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function shortUuid(u) {
  return u ? u.slice(0, 8) : '';
}

function sanitizeForLabel(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function adoptDefaults(disk) {
  const uidShort = shortUuid(disk.uuid) || 'new';
  const labelFromDisk = sanitizeForLabel(disk.label) || sanitizeForLabel(`${disk.vendor}-${disk.model}`) || `disk-${uidShort}`;
  return {
    label: labelFromDisk,
    /* Always UUID-derived so two drives never collide and delete→re-adopt yields a fresh path. */
    mountPath: `/mnt/wisp/disk-${uidShort}`,
    fsType: SUPPORTED_FSTYPES.includes(disk.fsType) ? disk.fsType : '',
    readOnly: disk.fsType === 'ntfs3',
    autoMount: true,
  };
}

function smbRowFromSettings(d) {
  return {
    id: d.id,
    label: d.label || '',
    mountPath: d.mountPath || '',
    share: d.share || '',
    username: d.username || '',
    /* Backend never returns the password; `hasPassword` tells us whether one
     * is on file so the row can render an empty input with the "saved" hint. */
    password: '',
  };
}

function smbBaselineForCompare(d) {
  return {
    id: d.id,
    label: (d.label || '').trim(),
    mountPath: (d.mountPath || '').trim(),
    share: (d.share || '').trim(),
    username: (d.username || '').trim(),
  };
}

function smbRowDirty(row, savedSmb) {
  if (!savedSmb) return true;
  const a = smbBaselineForCompare(row);
  const b = smbBaselineForCompare(savedSmb);
  if (JSON.stringify(a) !== JSON.stringify(b)) return true;
  /* The backend never returns the password — we only know whether one is on
   * file. Treat any non-empty input as a change; empty means "leave it". */
  if ((row.password || '').trim() !== '') return true;
  return false;
}

function diskRowFromSettings(d) {
  return {
    id: d.id,
    label: d.label || '',
    mountPath: d.mountPath || '',
    uuid: d.uuid || '',
    fsType: d.fsType || '',
    readOnly: d.readOnly === true,
    autoMount: d.autoMount !== false,
  };
}

function diskRowDirty(row, savedDisk) {
  if (!savedDisk) return true;
  if ((row.label || '').trim() !== (savedDisk.label || '').trim()) return true;
  if ((row.mountPath || '').trim() !== (savedDisk.mountPath || '').trim()) return true;
  if (Boolean(row.readOnly) !== Boolean(savedDisk.readOnly)) return true;
  if (Boolean(row.autoMount) !== (savedDisk.autoMount !== false)) return true;
  return false;
}

export default function HostStorage() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const disks = useDiskStore((s) => s.disks);
  const connectDisks = useDiskStore((s) => s.connect);
  const disconnectDisks = useDiskStore((s) => s.disconnect);

  useEffect(() => {
    connectDisks();
    return () => disconnectDisks();
  }, [connectDisks, disconnectDisks]);

  const [mountStatus, setMountStatus] = useState([]);
  const [error, setError] = useState(null);

  const refreshStatus = useCallback(() => {
    getMountStatus()
      .then((list) => setMountStatus(Array.isArray(list) ? list : []))
      .catch(() => setMountStatus([]));
  }, []);

  useEffect(() => { refreshStatus(); }, [settings, refreshStatus]);

  const smbSaved = useMemo(() => (settings?.mounts || []).filter((m) => m.type === 'smb'), [settings]);
  const diskSaved = useMemo(() => (settings?.mounts || []).filter((m) => m.type === 'disk'), [settings]);
  const adoptedUuids = useMemo(() => new Set(diskSaved.map((m) => m.uuid)), [diskSaved]);
  const unadoptedDetected = useMemo(
    () => (disks || []).filter((d) => {
      if (adoptedUuids.has(d.uuid)) return false;
      /* Skip system/OS-owned mounts (/, /boot, /boot/efi, /home, etc.) — anything not under /mnt/wisp/ */
      if (d.mountedAt && !d.mountedAt.startsWith('/mnt/wisp/')) return false;
      return true;
    }),
    [disks, adoptedUuids],
  );

  return (
    <SectionCard title="Storage" titleIcon={<Server size={14} strokeWidth={2} />} error={error}>
      <div className="space-y-6">
        <SmbMountsSection
          settings={settings}
          smbSaved={smbSaved}
          mountStatus={mountStatus}
          refreshStatus={refreshStatus}
          loadSettings={loadSettings}
          onError={setError}
        />

        <RemovableDrivesSection
          diskSaved={diskSaved}
          detectedDisks={disks}
          unadoptedDetected={unadoptedDetected}
          refreshStatus={refreshStatus}
          loadSettings={loadSettings}
          onError={setError}
        />
      </div>
    </SectionCard>
  );
}

/* -------------------------- SMB mounts sub-section -------------------------- */

function SmbMountsSection({ settings, smbSaved, mountStatus, refreshStatus, loadSettings, onError }) {
  const [rows, setRows] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [mountActionId, setMountActionId] = useState(null);
  const [checkId, setCheckId] = useState(null);
  const [checkByRow, setCheckByRow] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    setRows(smbSaved.map(smbRowFromSettings));
  }, [smbSaved]);

  const isPersisted = (id) => smbSaved.some((m) => m.id === id);

  const resetRow = (id) => {
    const s = smbSaved.find((m) => m.id === id);
    if (!s) return;
    setRows((prev) => prev.map((x) => (x.id === id ? smbRowFromSettings(s) : x)));
  };

  const handleAdd = () => {
    const id = randomId();
    const suffix = id.slice(0, 6);
    setRows((prev) => [
      ...prev,
      { id, label: '', mountPath: `/mnt/wisp/smb-${suffix}`, share: '', username: '', password: '' },
    ]);
    setEditingId(id);
    clearCheck(id);
  };

  const clearCheck = (id) => {
    setCheckByRow((o) => {
      const n = { ...o };
      delete n[id];
      return n;
    });
  };

  const handleRemoveClick = (row) => {
    onError(null);
    if (!isPersisted(row.id)) {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
      if (editingId === row.id) setEditingId(null);
      return;
    }
    setConfirmDelete(row);
  };

  const handleRemoveConfirm = async () => {
    const row = confirmDelete;
    if (!row) return;
    setConfirmDelete(null);
    setDeletingId(row.id);
    try {
      await deleteMount(row.id);
      await loadSettings();
      refreshStatus();
      if (editingId === row.id) setEditingId(null);
      clearCheck(row.id);
    } catch (err) {
      onError(err.message || 'Failed to remove mount');
    } finally {
      setDeletingId(null);
    }
  };

  const updateField = (id, field, value) => {
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, [field]: value } : x)));
  };

  const handleSave = async (row) => {
    const mountPath = (row.mountPath || '').trim();
    if (!mountPath.startsWith('/')) {
      onError('Mount path must be absolute (start with /).');
      return;
    }
    setSavingId(row.id);
    onError(null);
    try {
      if (!isPersisted(row.id)) {
        await addMount({
          id: row.id,
          type: 'smb',
          label: (row.label || '').trim(),
          share: (row.share || '').trim(),
          mountPath,
          username: (row.username || '').trim(),
          password: (row.password || '').trim(),
        });
      } else {
        const saved = smbSaved.find((m) => m.id === row.id);
        const patch = {};
        if ((row.label || '').trim() !== (saved?.label || '').trim()) patch.label = (row.label || '').trim();
        if (mountPath !== (saved?.mountPath || '').trim()) patch.mountPath = mountPath;
        const share = (row.share || '').trim();
        if (share !== (saved?.share || '').trim()) patch.share = share;
        if ((row.username || '').trim() !== (saved?.username || '').trim()) patch.username = (row.username || '').trim();
        /* Only send `password` when the user actually typed one; empty means
         * "keep what's on file" (the backend never returns the stored value). */
        const newPw = (row.password || '').trim();
        if (newPw !== '') patch.password = newPw;
        if (Object.keys(patch).length > 0) await patchMount(row.id, patch);
      }
      await loadSettings();
      setEditingId(null);
      clearCheck(row.id);
      refreshStatus();
    } catch (err) {
      onError(err.message || 'Failed to save');
    } finally {
      setSavingId(null);
    }
  };

  const handleMountToggle = (id, mounted) => {
    setMountActionId(id);
    const p = mounted ? unmountMount(id) : mountMount(id);
    p.then(() => refreshStatus())
      /* SMB mount errors surface via refreshStatus / server state */
      .catch(() => {})
      .finally(() => setMountActionId(null));
  };

  const handleCheck = (row) => {
    const share = (row.share || '').trim();
    const persisted = isPersisted(row.id);
    if (!persisted && !share) {
      setCheckByRow((o) => ({ ...o, [row.id]: { error: 'Set share first' } }));
      return;
    }
    setCheckId(row.id);
    clearCheck(row.id);
    const body = persisted
      ? { id: row.id }
      : { share, username: (row.username || '').trim(), password: (row.password || '').trim() };
    checkMountConnection(body)
      .then(() => setCheckByRow((o) => ({ ...o, [row.id]: { ok: true } })))
      .catch((err) => setCheckByRow((o) => ({
        ...o,
        [row.id]: { error: err.detail || err.message || 'Failed' },
      })))
      .finally(() => setCheckId(null));
  };

  const pathOk = (row) => !!(row.mountPath || '').trim().startsWith('/');

  const startEdit = (row) => {
    setEditingId(row.id);
    clearCheck(row.id);
  };

  const cancelEdit = (row) => {
    if (!isPersisted(row.id)) {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
    } else {
      resetRow(row.id);
    }
    setEditingId(null);
    clearCheck(row.id);
  };

  const headerAdd = (
    <button
      type="button"
      onClick={handleAdd}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Add SMB share"
      aria-label="Add SMB share"
    >
      <Plus size={14} aria-hidden />
      <Server size={14} aria-hidden />
    </button>
  );

  return (
    <div className="space-y-2">
      <SubHeading label="Network mounts (SMB)" headerAction={headerAdd} />
      <DataTableScroll>
        <DataTable minWidthRem={60}>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense>Label</DataTableTh>
              <DataTableTh dense className="min-w-[10rem]">Share</DataTableTh>
              <DataTableTh dense className="min-w-[9rem]">Mount path</DataTableTh>
              <DataTableTh dense>User</DataTableTh>
              <DataTableTh dense>Password</DataTableTh>
              <DataTableTh dense>Status</DataTableTh>
              <DataTableTh dense align="right">Actions</DataTableTh>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className={dataTableBodyRowClass}>
                <td colSpan={7} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                  No SMB shares. Use Add.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const status = mountStatus.find((s) => s.id === row.id);
              const mounted = status?.mounted ?? false;
              const persisted = isPersisted(row.id);
              const editing = editingId === row.id;
              const saved = smbSaved.find((m) => m.id === row.id);
              const dirty = smbRowDirty(row, saved);
              const canSave = editing && dirty && pathOk(row) && savingId !== row.id;
              const hasStoredPassword = persisted && saved?.hasPassword === true;

              const check = checkByRow[row.id];
              const checkLoading = checkId === row.id;
              const checkBtnClass = checkLoading
                ? iconBtn
                : check?.ok
                  ? 'inline-flex items-center justify-center rounded-md border border-green-200 bg-green-50 p-1.5 text-green-800 hover:bg-green-100 transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none'
                  : check?.error
                    ? 'inline-flex items-center justify-center rounded-md border border-red-200 bg-red-50 p-1.5 text-red-800 hover:bg-red-100 transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none'
                    : iconBtn;
              const checkTitle = checkLoading
                ? 'Testing…'
                : check?.ok
                  ? 'Connection OK'
                  : check?.error
                    ? check.error
                    : 'Test SMB connection';

              const mountBtnClass = mounted
                ? 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100'
                : 'border-surface-border bg-surface text-text-secondary hover:bg-surface-hover';

              return (
                <tr key={row.id} className={dataTableInteractiveRowClass}>
                  <DataTableTd dense className="text-sm">
                    {editing ? (
                      <input type="text" value={row.label} onChange={(e) => updateField(row.id, 'label', e.target.value)} placeholder="Label" className="input-field w-full min-w-[6rem] text-xs" />
                    ) : (
                      <span className="text-text-primary">{truncate(row.label, 24)}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense className="text-sm font-mono text-text-secondary">
                    {editing ? (
                      <input type="text" value={row.share} onChange={(e) => updateField(row.id, 'share', e.target.value)} placeholder="//server/share" className="input-field w-full min-w-0 text-xs" />
                    ) : (
                      truncate(row.share, 36)
                    )}
                  </DataTableTd>
                  <DataTableTd dense className="text-sm font-mono text-text-secondary">
                    {editing ? (
                      <input type="text" value={row.mountPath} onChange={(e) => updateField(row.id, 'mountPath', e.target.value)} placeholder="/mnt/wisp/smb" className="input-field w-full min-w-0 text-xs" />
                    ) : (
                      truncate(row.mountPath, 28)
                    )}
                  </DataTableTd>
                  <DataTableTd dense className="text-sm">
                    {editing ? (
                      <input type="text" value={row.username} onChange={(e) => updateField(row.id, 'username', e.target.value)} placeholder="Username" className="input-field w-full min-w-[6rem] text-xs" />
                    ) : (
                      <span className="text-text-muted">{row.username ? truncate(row.username, 16) : '—'}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense className="text-sm">
                    {editing ? (
                      <input type="password" value={row.password} onChange={(e) => updateField(row.id, 'password', e.target.value)} placeholder="Password" className="input-field w-full min-w-[6rem] text-xs" />
                    ) : (
                      <span className="text-text-muted font-mono text-xs">
                        {(row.password || hasStoredPassword) ? '••••' : '—'}
                      </span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense className="text-sm">
                    {persisted ? (
                      <StatusPill {...(mounted ? { tone: 'green', label: 'mounted' } : { tone: 'gray', label: 'unmounted' })} />
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense align="right">
                    <DataTableRowActions forceVisible={editing}>
                      {editing && (
                        <>
                          <button type="button" onClick={() => handleSave(row)} disabled={!canSave} className={iconBtn} title="Save" aria-label="Save SMB mount">
                            {savingId === row.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
                          </button>
                          <button type="button" onClick={() => cancelEdit(row)} disabled={savingId === row.id} className={iconBtn} title="Cancel edit" aria-label="Cancel edit">
                            <X size={14} aria-hidden />
                          </button>
                        </>
                      )}
                      {pathOk(row) && (
                        <button type="button" onClick={() => handleCheck(row)} disabled={checkLoading} className={checkBtnClass} title={checkTitle} aria-label={checkTitle}>
                          {checkLoading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
                        </button>
                      )}
                      {persisted && (
                        <button type="button" onClick={() => handleMountToggle(row.id, mounted)} disabled={mountActionId === row.id || editing} className={`inline-flex items-center justify-center rounded-md border p-1.5 transition-colors duration-150 disabled:opacity-40 ${mountBtnClass}`} title={mounted ? 'Unmount share' : 'Mount share'} aria-label={mounted ? 'Unmount share' : 'Mount share'}>
                          {mountActionId === row.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : mounted ? <Unplug size={14} aria-hidden /> : <Plug size={14} aria-hidden />}
                        </button>
                      )}
                      {!editing && (
                        <button type="button" onClick={() => startEdit(row)} className={iconBtn} title="Edit" aria-label="Edit SMB mount">
                          <Pencil size={14} aria-hidden />
                        </button>
                      )}
                      <button type="button" onClick={() => handleRemoveClick(row)} disabled={deletingId === row.id || savingId === row.id} className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-red-50`} title="Remove" aria-label="Remove SMB mount">
                        {deletingId === row.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                      </button>
                    </DataTableRowActions>
                  </DataTableTd>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </DataTableScroll>
      <ConfirmDialog
        open={!!confirmDelete}
        title="Remove SMB share?"
        confirmLabel="Remove"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleRemoveConfirm}
      >
        Removes <span className="font-mono">{confirmDelete?.label || confirmDelete?.share || 'this share'}</span>{' '}
        from Wisp. If the share is currently mounted at{' '}
        <span className="font-mono">{confirmDelete?.mountPath}</span> it will be unmounted and the mount point
        directory removed. Files on the remote server are not touched.
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------ Removable drives sub-section ------------------------ */

function RemovableDrivesSection({
  diskSaved,
  detectedDisks,
  unadoptedDetected,
  refreshStatus,
  loadSettings,
  onError,
}) {
  const [rows, setRows] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [mountActionId, setMountActionId] = useState(null);
  const [adoptingUuid, setAdoptingUuid] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => {
    setRows(diskSaved.map(diskRowFromSettings));
  }, [diskSaved]);

  const isPersisted = (id) => diskSaved.some((m) => m.id === id);

  const updateField = (id, field, value) => {
    setRows((prev) => prev.map((x) => (x.id === id ? { ...x, [field]: value } : x)));
  };

  const resetRow = (id) => {
    const s = diskSaved.find((m) => m.id === id);
    if (!s) return;
    setRows((prev) => prev.map((x) => (x.id === id ? diskRowFromSettings(s) : x)));
  };

  const handleAdopt = (disk) => {
    if (!SUPPORTED_FSTYPES.includes(disk.fsType)) {
      onError(`Filesystem "${disk.fsType}" is not supported for adoption.`);
      return;
    }
    const d = adoptDefaults(disk);
    const id = randomId();
    setRows((prev) => [
      ...prev,
      { id, uuid: disk.uuid, fsType: d.fsType, label: d.label, mountPath: d.mountPath, readOnly: d.readOnly, autoMount: d.autoMount },
    ]);
    setAdoptingUuid(disk.uuid);
    setEditingId(id);
    onError(null);
  };

  const handleSave = async (row) => {
    const mountPath = (row.mountPath || '').trim();
    if (!mountPath.startsWith('/')) {
      onError('Mount path must be absolute (start with /).');
      return;
    }
    setSavingId(row.id);
    onError(null);
    try {
      if (!isPersisted(row.id)) {
        await addMount({
          id: row.id,
          type: 'disk',
          label: (row.label || '').trim(),
          mountPath,
          autoMount: row.autoMount !== false,
          uuid: row.uuid,
          fsType: row.fsType,
          readOnly: row.readOnly === true,
        });
      } else {
        const saved = diskSaved.find((m) => m.id === row.id);
        const patch = {};
        if ((row.label || '').trim() !== (saved?.label || '').trim()) patch.label = (row.label || '').trim();
        if (mountPath !== (saved?.mountPath || '').trim()) patch.mountPath = mountPath;
        if ((row.autoMount !== false) !== (saved?.autoMount !== false)) patch.autoMount = row.autoMount !== false;
        if ((row.readOnly === true) !== (saved?.readOnly === true)) patch.readOnly = row.readOnly === true;
        if (Object.keys(patch).length > 0) await patchMount(row.id, patch);
      }
      await loadSettings();
      setEditingId(null);
      setAdoptingUuid(null);
      refreshStatus();
    } catch (err) {
      onError(err.message || 'Failed to save');
    } finally {
      setSavingId(null);
    }
  };

  const handleRemoveClick = (row) => {
    onError(null);
    if (!isPersisted(row.id)) {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
      if (editingId === row.id) setEditingId(null);
      if (adoptingUuid === row.uuid) setAdoptingUuid(null);
      return;
    }
    setConfirmDelete(row);
  };

  const handleRemoveConfirm = async () => {
    const row = confirmDelete;
    if (!row) return;
    setConfirmDelete(null);
    setDeletingId(row.id);
    try {
      await deleteMount(row.id);
      await loadSettings();
      refreshStatus();
      if (editingId === row.id) setEditingId(null);
    } catch (err) {
      onError(err.message || 'Failed to remove');
    } finally {
      setDeletingId(null);
    }
  };

  const handleMountToggle = (id, mounted) => {
    setMountActionId(id);
    const p = mounted ? unmountMount(id) : mountMount(id);
    p.then(() => refreshStatus())
      .catch((err) => onError(err.detail || err.message || 'Mount toggle failed'))
      .finally(() => setMountActionId(null));
  };

  const startEdit = (row) => { setEditingId(row.id); };

  const cancelEdit = (row) => {
    if (!isPersisted(row.id)) {
      setRows((prev) => prev.filter((x) => x.id !== row.id));
      if (adoptingUuid === row.uuid) setAdoptingUuid(null);
    } else {
      resetRow(row.id);
    }
    setEditingId(null);
  };

  const pathOk = (row) => !!(row.mountPath || '').trim().startsWith('/');

  const hasAnything = rows.length > 0 || unadoptedDetected.length > 0;
  if (!hasAnything && (detectedDisks == null)) {
    return (
      <div className="space-y-2">
        <SubHeading label="Removable drives" />
        <p className="text-[11px] text-text-muted">Connecting to device stream…</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SubHeading label="Removable drives" />
        <DataTableScroll>
          <DataTable minWidthRem={60}>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense>Label</DataTableTh>
                <DataTableTh dense>UUID</DataTableTh>
                <DataTableTh dense>FS</DataTableTh>
                <DataTableTh dense className="min-w-[9rem]">Mount path</DataTableTh>
                <DataTableTh dense>RO</DataTableTh>
                <DataTableTh dense>Auto</DataTableTh>
                <DataTableTh dense>Status</DataTableTh>
                <DataTableTh dense align="right">Actions</DataTableTh>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={8} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                    No removable drives adopted. Adopt one from the Detected list below.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const persisted = isPersisted(row.id);
                const editing = editingId === row.id;
                const saved = diskSaved.find((m) => m.id === row.id);
                const dirty = diskRowDirty(row, saved);
                const canSave = editing && dirty && pathOk(row) && savingId !== row.id;
                const diskState = (detectedDisks || []).find((d) => d.uuid === row.uuid);
                const present = !!diskState;
                /* Authoritative mount state comes from the live disk stream (mountedAt), not settings status poll. */
                const mounted = !!(diskState && diskState.mountedAt === row.mountPath);

                const mountBtnClass = mounted
                  ? 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100'
                  : present
                    ? 'border-surface-border bg-surface text-text-secondary hover:bg-surface-hover'
                    : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100';

                return (
                  <tr key={row.id} className={dataTableInteractiveRowClass}>
                    <DataTableTd dense className="text-sm">
                      {editing ? (
                        <input type="text" value={row.label} onChange={(e) => updateField(row.id, 'label', e.target.value)} placeholder="Label" className="input-field w-full min-w-[6rem] text-xs" />
                      ) : (
                        <span className="text-text-primary">{truncate(row.label, 24)}</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="text-sm font-mono text-text-muted">
                      {shortUuid(row.uuid)}
                    </DataTableTd>
                    <DataTableTd dense className="text-sm font-mono text-text-secondary">
                      {row.fsType || '—'}
                    </DataTableTd>
                    <DataTableTd dense className="text-sm font-mono text-text-secondary">
                      {editing ? (
                        <input type="text" value={row.mountPath} onChange={(e) => updateField(row.id, 'mountPath', e.target.value)} placeholder="/mnt/wisp/drive" className="input-field w-full min-w-0 text-xs" />
                      ) : (
                        truncate(row.mountPath, 28)
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="text-sm">
                      <input type="checkbox" checked={row.readOnly === true} onChange={(e) => updateField(row.id, 'readOnly', e.target.checked)} disabled={!editing || row.fsType === 'ntfs3'} title={row.fsType === 'ntfs3' ? 'NTFS mounts are read-only' : 'Read-only mount'} />
                    </DataTableTd>
                    <DataTableTd dense className="text-sm">
                      <input type="checkbox" checked={row.autoMount !== false} onChange={(e) => updateField(row.id, 'autoMount', e.target.checked)} disabled={!editing} title="Auto-mount on device insertion" />
                    </DataTableTd>
                    <DataTableTd dense className="text-sm">
                      {persisted ? (
                        mounted
                          ? <StatusPill tone="green" label="mounted" />
                          : present
                            ? <StatusPill tone="gray" label="present" />
                            : <StatusPill tone="red" label="disconnected" />
                      ) : (
                        <span className="text-text-muted">—</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense align="right">
                      <DataTableRowActions forceVisible={editing}>
                        {editing && (
                          <>
                            <button type="button" onClick={() => handleSave(row)} disabled={!canSave} className={iconBtn} title="Save" aria-label="Save drive">
                              {savingId === row.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
                            </button>
                            <button type="button" onClick={() => cancelEdit(row)} disabled={savingId === row.id} className={iconBtn} title="Cancel edit" aria-label="Cancel edit">
                              <X size={14} aria-hidden />
                            </button>
                          </>
                        )}
                        {persisted && present && (
                          <button type="button" onClick={() => handleMountToggle(row.id, mounted)} disabled={mountActionId === row.id || editing} className={`inline-flex items-center justify-center rounded-md border p-1.5 transition-colors duration-150 disabled:opacity-40 ${mountBtnClass}`} title={mounted ? 'Unmount drive' : 'Mount drive'} aria-label={mounted ? 'Unmount drive' : 'Mount drive'}>
                            {mountActionId === row.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : mounted ? <Unplug size={14} aria-hidden /> : <Plug size={14} aria-hidden />}
                          </button>
                        )}
                        {!editing && (
                          <button type="button" onClick={() => startEdit(row)} className={iconBtn} title="Edit" aria-label="Edit drive">
                            <Pencil size={14} aria-hidden />
                          </button>
                        )}
                        <button type="button" onClick={() => handleRemoveClick(row)} disabled={deletingId === row.id || savingId === row.id} className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-red-50`} title="Remove" aria-label="Remove drive">
                          {deletingId === row.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                        </button>
                      </DataTableRowActions>
                    </DataTableTd>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </DataTableScroll>
      </div>

      {unadoptedDetected.length > 0 && (
        <div className="space-y-2">
          <SubHeading label="Detected drives" hint="Adopt saves the UUID and mount settings. Auto-mount triggers on re-insertion." />
          <DataTableScroll>
            <DataTable minWidthRem={56}>
              <thead>
                <tr className={dataTableHeadRowClass}>
                  <DataTableTh dense>Device</DataTableTh>
                  <DataTableTh dense>Label</DataTableTh>
                  <DataTableTh dense>FS</DataTableTh>
                  <DataTableTh dense>Size</DataTableTh>
                  <DataTableTh dense>Mounted at</DataTableTh>
                  <DataTableTh dense align="right">Actions</DataTableTh>
                </tr>
              </thead>
              <tbody>
                {unadoptedDetected.map((d) => {
                  const supported = SUPPORTED_FSTYPES.includes(d.fsType);
                  const mountedElsewhere = d.mountedAt && !d.mountedAt.startsWith('/mnt/wisp');
                  const currentlyAdopting = adoptingUuid === d.uuid;
                  return (
                    <tr key={d.uuid} className={dataTableBodyRowClass}>
                      <DataTableTd dense className="text-sm">
                        <div className="flex items-center gap-2">
                          <HardDrive size={12} className="text-text-muted" />
                          <div className="flex flex-col">
                            <span className="text-text-primary">{truncate([d.vendor, d.model].filter(Boolean).join(' ') || d.devPath, 30)}</span>
                            <span className="text-[10px] text-text-muted font-mono">{d.devPath} · {shortUuid(d.uuid)}</span>
                          </div>
                        </div>
                      </DataTableTd>
                      <DataTableTd dense className="text-sm">
                        <span className="text-text-secondary">{truncate(d.label, 20)}</span>
                      </DataTableTd>
                      <DataTableTd dense className="text-sm font-mono">{d.fsType || '—'}</DataTableTd>
                      <DataTableTd dense className="text-sm font-mono text-text-muted">{formatBytes(d.sizeBytes)}</DataTableTd>
                      <DataTableTd dense className="text-xs font-mono text-text-muted">{d.mountedAt ? truncate(d.mountedAt, 28) : '—'}</DataTableTd>
                      <DataTableTd dense align="right">
                        <button
                          type="button"
                          onClick={() => handleAdopt(d)}
                          disabled={!supported || mountedElsewhere || currentlyAdopting}
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none ${supported && !mountedElsewhere ? 'bg-accent text-white hover:bg-accent-hover' : 'border border-surface-border bg-surface text-text-muted'}`}
                          title={
                            !supported
                              ? `Filesystem ${d.fsType || 'unknown'} not supported`
                              : mountedElsewhere
                                ? `Already mounted at ${d.mountedAt}`
                                : currentlyAdopting
                                  ? 'Editing adoption'
                                  : 'Adopt drive — configure mount settings'
                          }
                        >
                          Adopt
                        </button>
                      </DataTableTd>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          </DataTableScroll>
        </div>
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Remove adopted drive?"
        confirmLabel="Remove"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleRemoveConfirm}
      >
        Removes <span className="font-mono">{confirmDelete?.label || confirmDelete?.uuid || 'this drive'}</span>{' '}
        from Wisp. If the drive is currently mounted at{' '}
        <span className="font-mono">{confirmDelete?.mountPath}</span> it will be unmounted and the mount point
        directory removed. Data on the drive itself is not touched.
      </ConfirmDialog>
    </div>
  );
}

/* -------------------------------- helpers -------------------------------- */

function SubHeading({ label, hint, headerAction }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</h4>
        {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
      </div>
      {headerAction}
    </div>
  );
}

const STATUS_PILL_TONES = {
  green: 'bg-green-50 text-green-800 border border-green-200',
  gray: 'bg-surface text-text-secondary border border-surface-border',
  red: 'bg-red-50 text-red-700 border border-red-200',
};

function StatusPill({ tone, label }) {
  const cls = STATUS_PILL_TONES[tone] || STATUS_PILL_TONES.gray;
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {label}
    </span>
  );
}
