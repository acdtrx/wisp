import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus,
  File,
  Folder,
  MemoryStick,
  Trash2,
  Loader2,
  Upload,
  Archive,
  SquarePen,
  Pencil,
  AlertCircle,
} from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
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
  rowActionIconBtn,
} from '../shared/DataTableChrome.jsx';
import MountFileEditorModal from './MountFileEditorModal.jsx';
import ContainerMountEditorModal, {
  normalizeMountType,
  normalizeOwnerId,
  normalizeTmpfsSize,
} from './ContainerMountEditorModal.jsx';
import {
  removeContainerMount,
  getContainerMountUsage,
  uploadMountFile,
  uploadMountZip,
} from '../../api/containers.js';
import { formatSize } from '../../utils/formatters.js';
import { useSettingsStore } from '../../store/settingsStore.js';
import { getMountStatus } from '../../api/settings.js';

const addBtn =
  'inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150';

/* Caps the phone-only stacked lines so the two-column table never scrolls
   sideways; the desktop columns size themselves as before. */
const phoneLineClamp = 'block max-w-[60vw] truncate sm:max-w-none';

function truncate(s, n) {
  const t = (s || '').trim();
  if (t.length <= n) return t || '—';
  return `${t.slice(0, n - 1)}…`;
}

function rowsFromServerMounts(mounts) {
  return (mounts || []).map((m) => ({
    name: m.name || '',
    type: normalizeMountType(m.type),
    containerPath: m.containerPath || '',
    readonly: !!m.readonly,
    sourceId: m.sourceId || null,
    subPath: m.subPath || '',
    containerOwnerUid: normalizeOwnerId(m.containerOwnerUid),
    containerOwnerGid: normalizeOwnerId(m.containerOwnerGid),
    sizeMiB: normalizeTmpfsSize(m.sizeMiB),
  }));
}

function MountTypeIcon({ type }) {
  const label = type === 'tmpfs'
    ? 'In-memory mount (tmpfs)'
    : type === 'directory'
      ? 'Folder mount'
      : 'File mount';
  return (
    <span className="inline-flex" title={label} aria-label={label}>
      {type === 'tmpfs'
        ? <MemoryStick size={16} aria-hidden />
        : type === 'directory'
          ? <Folder size={16} aria-hidden />
          : <File size={16} aria-hidden />}
    </span>
  );
}

export default function ContainerMountsSection({ config, onRefresh }) {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const [busyRowName, setBusyRowName] = useState(null);
  const [deletingRowName, setDeletingRowName] = useState(null);
  const [error, setError] = useState(null);
  /* The mount is snapshotted when the editor opens so a background refresh of
   * `config.mounts` can't reset the open form; `kind` drives the create path. */
  const [editor, setEditor] = useState({ open: false, kind: 'file', mount: null });
  const [fileEditor, setFileEditor] = useState({ open: false, mountName: '' });
  const [storageStatus, setStorageStatus] = useState([]);
  const [mountUsage, setMountUsage] = useState(null);
  /* Phones: row actions live in a strip that expands under the row text on tap. */
  const [expandedName, setExpandedName] = useState(null);

  // The parent containerStore replaces `containerConfig` (and therefore `config.mounts`) on
  // every SSE/refresh tick — even when mount content is unchanged — so depending on the array
  // reference would re-run the usage fetch every tick. Use a content-hashed key instead.
  const mountsKey = useMemo(() => JSON.stringify(config.mounts || []), [config.mounts]);
  const rows = useMemo(() => rowsFromServerMounts(config.mounts), [mountsKey]);

  useEffect(() => {
    setError(null);
    setExpandedName(null);
  }, [config.name]);

  /* Host-side disk usage per mount — one on-demand snapshot per mounts change, not a live feed
   * (sizing walks the data dir and can take seconds for large trees). Best-effort: on failure
   * the Size column just shows em-dashes. */
  useEffect(() => {
    let cancelled = false;
    setMountUsage(null);
    if (!config.name || (config.mounts || []).length === 0) return undefined;
    getContainerMountUsage(config.name)
      .then((res) => { if (!cancelled) setMountUsage(res.mounts || []); })
      .catch(() => { if (!cancelled) setMountUsage([]); });
    return () => { cancelled = true; };
  }, [config.name, mountsKey]);

  const usageByName = useMemo(() => {
    const map = new Map();
    for (const u of mountUsage || []) map.set(u.name, u);
    return map;
  }, [mountUsage]);

  /* Settings store holds the storage-mount catalogue and is cheap to (re)load; the mount-status
   * endpoint tells us which ones are currently mounted so we can warn on orphan references. */
  const refreshStorageStatus = useCallback(() => {
    getMountStatus()
      .then((list) => setStorageStatus(Array.isArray(list) ? list : []))
      .catch(() => setStorageStatus([]));
  }, []);

  useEffect(() => {
    if (!settings) {
      loadSettings().catch(() => {});
    }
    refreshStorageStatus();
  }, [settings, loadSettings, refreshStorageStatus]);

  const storageMounts = useMemo(() => settings?.mounts || [], [settings]);
  const storageStatusById = useMemo(() => {
    const map = new Map();
    for (const s of storageStatus || []) map.set(s.id, !!s.mounted);
    return map;
  }, [storageStatus]);

  const runAsRoot = !!config.runAsRoot;
  const colCount = runAsRoot ? 9 : 8;

  const openCreate = (kind) => {
    setError(null);
    setEditor({ open: true, kind, mount: null });
  };

  const openEdit = (row) => {
    setError(null);
    setEditor({ open: true, kind: row.type, mount: (config.mounts || []).find((m) => m.name === row.name) || row });
  };

  const closeEditor = () => setEditor({ open: false, kind: 'file', mount: null });

  const handleSaved = async () => {
    if (onRefresh) await onRefresh();
    refreshStorageStatus();
  };

  const handleRemove = async (row) => {
    setError(null);
    setDeletingRowName(row.name);
    try {
      await removeContainerMount(config.name, row.name);
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingRowName(null);
    }
  };

  const runUploadForRow = async (row, uploadFn) => {
    setBusyRowName(row.name);
    setError(null);
    try {
      await uploadFn(row.name);
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyRowName(null);
    }
  };

  const handleFileUpload = (row, e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (row.type !== 'file') return;
    runUploadForRow(row, (mn) => uploadMountFile(config.name, mn, file));
  };

  const handleZipUpload = (row, e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (row.type !== 'directory') return;
    runUploadForRow(row, (mn) => uploadMountZip(config.name, mn, file));
  };

  const headerAdds = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => openCreate('file')}
        className={addBtn}
        title="Add file mount"
        aria-label="Add file mount"
      >
        <Plus size={14} aria-hidden />
        <File size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => openCreate('directory')}
        className={addBtn}
        title="Add folder mount"
        aria-label="Add folder mount"
      >
        <Plus size={14} aria-hidden />
        <Folder size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => openCreate('tmpfs')}
        className={addBtn}
        title="Add tmpfs mount (in-memory, gone on restart)"
        aria-label="Add tmpfs mount"
      >
        <Plus size={14} aria-hidden />
        <MemoryStick size={14} aria-hidden />
      </button>
    </div>
  );

  /* Source display: `Local`, or the storage mount's label with a warning when
   * the reference is dangling or the mount is not currently mounted. */
  const sourceInfo = (row) => {
    if (!row.sourceId) return { label: 'Local', warn: false, warnMsg: '' };
    const sm = storageMounts.find((m) => m.id === row.sourceId);
    const missing = !sm;
    const notMounted = sm && storageStatusById.get(sm.id) === false;
    return {
      label: sm ? ((sm.label && sm.label.trim()) || sm.mountPath) : row.sourceId,
      warn: missing || notMounted,
      warnMsg: missing
        ? 'Referenced storage mount no longer exists'
        : notMounted
          ? 'Referenced storage mount is not currently mounted'
          : '',
    };
  };

  const usageText = (row) => {
    if (row.type === 'tmpfs') return null;
    if (mountUsage === null) return '…';
    const u = usageByName.get(row.name);
    if (!u || u.sizeBytes == null) return null;
    return `${formatSize(u.sizeBytes)}${u.partial ? '+' : ''}`;
  };

  return (
    <SectionCard
      title="Mounts"
      helpText="Add or edit a mount in a form. Deletes and uploads apply to one row at a time. On phones, tap a row to reach its actions."
      requiresRestart={!!config.pendingRestart}
      error={error}
      headerAction={headerAdds}
    >
      <div className="space-y-3">
        <DataTableScroll>
          <DataTable>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense className="w-10 font-normal" aria-hidden />
                <DataTableTh dense className="min-w-48">
                  Container path
                </DataTableTh>
                <DataTableTh dense className="hidden w-32 min-w-32 sm:table-cell">
                  Mount name
                </DataTableTh>
                <DataTableTh dense className="hidden min-w-36 sm:table-cell">
                  Source
                </DataTableTh>
                <DataTableTh dense className="hidden min-w-32 sm:table-cell">
                  Sub-path
                </DataTableTh>
                <DataTableTh dense className="hidden w-20 sm:table-cell" title="Host-side disk usage of the mount data (snapshot)">
                  Size
                </DataTableTh>
                <DataTableTh dense className="hidden w-14 sm:table-cell" title="Read-only">R/O</DataTableTh>
                {runAsRoot && (
                  <DataTableTh
                    dense
                    className="hidden min-w-28 sm:table-cell"
                    title="In-container UID:GID that maps to the host deploy user (size:1 idmap; Local mounts only)"
                  >
                    Owner uid:gid
                  </DataTableTh>
                )}
                <DataTableTh dense align="right" className="hidden sm:table-cell">
                  Actions
                </DataTableTh>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={colCount} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                    No mounts configured. Use Add in the section header.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const rowBusy = busyRowName === row.name;
                const rowDeleting = deletingRowName === row.name;
                const expanded = expandedName === row.name;
                const src = sourceInfo(row);
                const size = usageText(row);
                const usage = usageByName.get(row.name);
                const usageTitle = usage
                  ? `${usage.hostPath || ''}${usage.partial ? ' — some entries were unreadable; size is an undercount' : ''}`
                  : '';
                const tmpfsLabel = row.type === 'tmpfs' ? `tmpfs (${row.sizeMiB} MiB)` : '';

                /* Phone summary of the columns that are hidden below `sm`. */
                const phoneBits = [];
                if (row.type === 'tmpfs') {
                  phoneBits.push(tmpfsLabel);
                } else {
                  phoneBits.push(row.sourceId && row.subPath ? `${src.label}/${row.subPath}` : src.label);
                  if (size) phoneBits.push(size);
                  if (row.readonly) phoneBits.push('read-only');
                  if (runAsRoot && !row.sourceId && (row.containerOwnerUid || row.containerOwnerGid)) {
                    phoneBits.push(`${row.containerOwnerUid}:${row.containerOwnerGid}`);
                  }
                }

                const actionButtons = (
                  <>
                    {row.type === 'file' && (
                      <>
                        <button
                          type="button"
                          disabled={rowBusy || rowDeleting}
                          onClick={() => setFileEditor({ open: true, mountName: row.name })}
                          className={rowActionIconBtn}
                          title="Edit file"
                          aria-label={`Edit file of ${row.name}`}
                        >
                          <SquarePen size={14} aria-hidden />
                        </button>
                        <label
                          className={`${rowActionIconBtn} cursor-pointer text-accent ${rowBusy || rowDeleting ? 'opacity-40 pointer-events-none' : ''}`}
                          title="Upload file"
                          aria-label={`Upload file to ${row.name}`}
                        >
                          {rowBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Upload size={14} aria-hidden />}
                          <input
                            type="file"
                            className="hidden"
                            disabled={rowBusy || rowDeleting}
                            onChange={(e) => handleFileUpload(row, e)}
                          />
                        </label>
                      </>
                    )}
                    {row.type === 'directory' && (() => {
                      const zipDisabled = rowBusy || rowDeleting || !!row.sourceId;
                      const zipTitle = row.sourceId
                        ? 'Zip upload is available on Local mounts only'
                        : 'Upload zip';
                      return (
                        <label
                          className={`${rowActionIconBtn} cursor-pointer text-accent ${zipDisabled ? 'opacity-40 pointer-events-none' : ''}`}
                          title={zipTitle}
                          aria-label={zipTitle}
                        >
                          {rowBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Archive size={14} aria-hidden />}
                          <input
                            type="file"
                            accept=".zip,application/zip"
                            className="hidden"
                            disabled={zipDisabled}
                            onChange={(e) => handleZipUpload(row, e)}
                          />
                        </label>
                      );
                    })()}
                    <button
                      type="button"
                      onClick={() => openEdit(row)}
                      disabled={rowDeleting}
                      className={rowActionIconBtn}
                      title="Edit"
                      aria-label={`Edit mount ${row.name}`}
                    >
                      <Pencil size={14} aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemove(row)}
                      disabled={rowBusy || rowDeleting}
                      className={`${rowActionIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
                      title="Remove mount"
                      aria-label={`Remove mount ${row.name}`}
                    >
                      {rowDeleting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                    </button>
                  </>
                );

                return (
                  <tr
                    key={row.name}
                    className={`${dataTableInteractiveRowClass} cursor-pointer sm:cursor-auto`}
                    onClick={() => setExpandedName((prev) => (prev === row.name ? null : row.name))}
                  >
                    <DataTableTd dense valign="top" className="text-text-muted sm:align-middle">
                      <MountTypeIcon type={row.type} />
                    </DataTableTd>
                    <DataTableTd dense className="min-w-0 sm:min-w-56">
                      <span className={`${phoneLineClamp} font-mono text-sm text-text-primary`}>
                        {truncate(row.containerPath, 40)}
                      </span>
                      {/* The remaining columns are hidden below `sm` and stack here instead. */}
                      <span className={`${phoneLineClamp} mt-0.5 font-mono text-xs text-text-secondary sm:hidden`}>
                        {row.name}
                      </span>
                      <span className={`${phoneLineClamp} text-[11px] text-text-muted sm:hidden`}>
                        {src.warn && (
                          <AlertCircle size={11} className="mr-1 inline align-[-1px] text-status-stopped" aria-label={src.warnMsg} />
                        )}
                        {phoneBits.join(' · ')}
                      </span>
                      {expanded && (
                        /* Tap-to-expand action strip (phones only) */
                        <span className="mt-2 flex items-center gap-1.5 sm:hidden" onClick={(e) => e.stopPropagation()}>
                          {actionButtons}
                        </span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="hidden w-32 min-w-32 sm:table-cell">
                      <span className="font-mono text-sm text-text-primary">{truncate(row.name, 24)}</span>
                    </DataTableTd>
                    <DataTableTd dense className="hidden min-w-36 sm:table-cell">
                      {row.type === 'tmpfs' ? (
                        <span className="text-sm text-text-secondary" title={tmpfsLabel}>{tmpfsLabel}</span>
                      ) : row.type === 'file' || !row.sourceId ? (
                        <span className="text-sm text-text-muted">Local</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-sm">
                          {src.warn && (
                            <AlertCircle size={12} className="text-status-stopped" aria-label={src.warnMsg} />
                          )}
                          <span className={src.warn ? 'text-status-stopped' : 'text-text-secondary'} title={src.warn ? src.warnMsg : src.label}>
                            {truncate(src.label, 20)}
                          </span>
                        </span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="hidden min-w-32 sm:table-cell">
                      {row.type === 'directory' && row.sourceId ? (
                        <span className="font-mono text-sm text-text-secondary">{row.subPath ? truncate(row.subPath, 20) : '—'}</span>
                      ) : (
                        <span className="text-sm text-text-muted">—</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="hidden w-20 whitespace-nowrap sm:table-cell">
                      {row.type === 'tmpfs' ? (
                        <span className="text-sm text-text-muted" title="tmpfs has no host backing">—</span>
                      ) : size === '…' ? (
                        <span className="text-xs text-text-muted">…</span>
                      ) : size ? (
                        <span className="font-mono text-xs text-text-secondary" title={usageTitle}>{size}</span>
                      ) : (
                        <span className="text-sm text-text-muted">—</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="hidden w-14 sm:table-cell">
                      {row.type === 'tmpfs' ? (
                        <span className="text-sm text-text-muted" title="tmpfs cannot be read-only">—</span>
                      ) : (
                        <span className="text-sm text-text-secondary">{row.readonly ? 'Yes' : 'No'}</span>
                      )}
                    </DataTableTd>
                    {runAsRoot && (
                      <DataTableTd dense className="hidden min-w-28 sm:table-cell">
                        {row.type === 'tmpfs' ? (
                          <span className="text-sm text-text-muted" title="Idmap does not apply to tmpfs (kernel-managed in-memory mount)">—</span>
                        ) : row.sourceId ? (
                          <span className="text-sm text-text-muted" title="Idmap is not applied to Storage-sourced mounts">—</span>
                        ) : (
                          <span className="font-mono text-sm text-text-secondary">
                            {`${row.containerOwnerUid}:${row.containerOwnerGid}`}
                          </span>
                        )}
                      </DataTableTd>
                    )}
                    <DataTableTd dense align="right" className="hidden sm:table-cell">
                      <div onClick={(e) => e.stopPropagation()}>
                        <DataTableRowActions forceVisible={rowBusy || rowDeleting}>
                          {actionButtons}
                        </DataTableRowActions>
                      </div>
                    </DataTableTd>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </DataTableScroll>
      </div>

      <ContainerMountEditorModal
        open={editor.open}
        containerName={config.name}
        mount={editor.mount}
        kind={editor.kind}
        mounts={config.mounts || []}
        storageMounts={storageMounts}
        runAsRoot={runAsRoot}
        onSaved={handleSaved}
        onClose={closeEditor}
      />

      <MountFileEditorModal
        open={fileEditor.open}
        containerName={config.name}
        mountName={fileEditor.mountName}
        onClose={() => setFileEditor({ open: false, mountName: '' })}
        onSaved={onRefresh}
      />
    </SectionCard>
  );
}
