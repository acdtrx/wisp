import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus,
  File,
  Folder,
  Trash2,
  Loader2,
  Save,
  Upload,
  Archive,
  SquarePen,
  Pencil,
  X,
  AlertCircle,
} from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import Toggle from '../shared/Toggle.jsx';
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
import MountFileEditorModal from './MountFileEditorModal.jsx';
import {
  addContainerMount,
  updateContainerMount,
  removeContainerMount,
  uploadMountFile,
  uploadMountZip,
} from '../../api/containers.js';
import { randomId } from '../../utils/randomId.js';
import { useSettingsStore } from '../../store/settingsStore.js';
import { getMountStatus } from '../../api/settings.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function isValidSubPath(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (t === '') return true;
  if (t.startsWith('/')) return false;
  return !t.split('/').filter(Boolean).some((seg) => seg === '..' || seg === '.');
}

function normalizeSubPath(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function rowsFromServerMounts(mounts) {
  return (mounts || []).map((m) => ({
    rowId: m.name,
    serverMountName: m.name,
    type: m.type === 'directory' ? 'directory' : 'file',
    name: m.name || '',
    containerPath: m.containerPath || '',
    readonly: !!m.readonly,
    sourceId: m.sourceId || null,
    subPath: m.subPath || '',
  }));
}

function validateRowAgainstOthers(row, allRows) {
  const name = row.name.trim();
  const containerPath = row.containerPath.trim();
  if (!name || !containerPath) {
    return 'Each mount needs a container path and a mount name.';
  }
  if (!containerPath.startsWith('/')) {
    return 'Container path must be absolute (start with /).';
  }
  if (row.sourceId && !isValidSubPath(row.subPath)) {
    return 'Sub-path must be relative (no leading /) and cannot contain ".." segments.';
  }
  const names = new Set();
  const paths = new Set();
  for (const r of allRows) {
    if (r.rowId === row.rowId) continue;
    const n = r.name.trim();
    const p = r.containerPath.trim();
    if (n) names.add(n);
    if (p) paths.add(p);
  }
  if (names.has(name)) {
    return `Duplicate mount name: ${name}`;
  }
  if (paths.has(containerPath)) {
    return `Duplicate container path: ${containerPath}`;
  }
  return null;
}

function rowMatchesServer(row, serverMounts) {
  const mn = row.name.trim();
  if (!mn || !row.serverMountName) return false;
  const s = (serverMounts || []).find((m) => m.name === row.serverMountName);
  if (!s) return false;
  const savedSourceId = s.sourceId || null;
  const savedSubPath = s.subPath || '';
  return (
    s.type === row.type
    && s.name === mn
    && s.containerPath === row.containerPath.trim()
    && Boolean(s.readonly) === Boolean(row.readonly)
    && savedSourceId === (row.sourceId || null)
    && savedSubPath === normalizeSubPath(row.subPath)
  );
}

function isRowDirty(row, serverMounts) {
  if (!row.serverMountName) {
    return (
      row.name.trim() !== ''
      || row.containerPath.trim() !== ''
      || row.readonly
      || !!row.sourceId
      || !!normalizeSubPath(row.subPath)
    );
  }
  const s = (serverMounts || []).find((m) => m.name === row.serverMountName);
  if (!s) return true;
  const savedSourceId = s.sourceId || null;
  const savedSubPath = s.subPath || '';
  return (
    s.type !== row.type
    || s.name !== row.name.trim()
    || s.containerPath !== row.containerPath.trim()
    || Boolean(s.readonly) !== Boolean(row.readonly)
    || savedSourceId !== (row.sourceId || null)
    || savedSubPath !== normalizeSubPath(row.subPath)
  );
}

function isFieldEditing(row, fieldEditRowId) {
  return !row.serverMountName || fieldEditRowId === row.rowId;
}

export default function ContainerMountsSection({ config, onRefresh }) {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const [rows, setRows] = useState(() => rowsFromServerMounts(config.mounts));
  const [fieldEditRowId, setFieldEditRowId] = useState(null);
  const [savingRowId, setSavingRowId] = useState(null);
  const [busyRowId, setBusyRowId] = useState(null);
  const [deletingRowId, setDeletingRowId] = useState(null);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMountName, setEditorMountName] = useState('');
  const [storageStatus, setStorageStatus] = useState([]);

  useEffect(() => {
    setRows(rowsFromServerMounts(config.mounts));
    setFieldEditRowId(null);
    setRequiresRestart(false);
    setError(null);
  }, [config.name, config.mounts]);

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

  const serverMounts = config.mounts;
  const saving = savingRowId !== null;

  const addRow = (type) => {
    const rowId = randomId();
    setRows((prev) => [
      ...prev,
      {
        rowId,
        serverMountName: null,
        type,
        name: '',
        containerPath: '',
        readonly: false,
        sourceId: null,
        subPath: '',
      },
    ]);
    setFieldEditRowId(rowId);
  };

  const handleSourceChange = (row, nextSourceId) => {
    setRows((prev) => prev.map((r) => {
      if (r.rowId !== row.rowId) return r;
      if (!nextSourceId) return { ...r, sourceId: null, subPath: '' };
      return { ...r, sourceId: nextSourceId };
    }));
  };

  const updateRow = (rowId, field, value) => {
    setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, [field]: value } : r)));
  };

  const cancelFieldEdit = (row) => {
    if (!row.serverMountName) {
      setRows((prev) => prev.filter((r) => r.rowId !== row.rowId));
      setFieldEditRowId(null);
      return;
    }
    const s = (serverMounts || []).find((m) => m.name === row.serverMountName);
    if (s) {
      setRows((prev) =>
        prev.map((r) =>
          r.rowId === row.rowId
            ? {
                ...r,
                type: s.type === 'directory' ? 'directory' : 'file',
                name: s.name,
                containerPath: s.containerPath,
                readonly: !!s.readonly,
                sourceId: s.sourceId || null,
                subPath: s.subPath || '',
              }
            : r));
    }
    setFieldEditRowId(null);
  };

  const handleSave = async (row) => {
    const msg = validateRowAgainstOthers(row, rows);
    if (msg) {
      setError(msg);
      return;
    }
    setSavingRowId(row.rowId);
    setError(null);
    try {
      const rowSub = normalizeSubPath(row.subPath);
      if (!row.serverMountName) {
        const payload = {
          type: row.type,
          name: row.name.trim(),
          containerPath: row.containerPath.trim(),
          readonly: !!row.readonly,
        };
        if (row.sourceId) {
          payload.sourceId = row.sourceId;
          payload.subPath = rowSub;
        }
        const result = await addContainerMount(config.name, payload);
        if (result?.requiresRestart) setRequiresRestart(true);
      } else {
        const prev = (config.mounts || []).find((m) => m.name === row.serverMountName);
        if (!prev) {
          setError('Mount no longer exists on the server. Refresh and try again.');
          return;
        }
        const patch = {};
        if (row.name.trim() !== prev.name) patch.name = row.name.trim();
        if (row.containerPath.trim() !== prev.containerPath) patch.containerPath = row.containerPath.trim();
        if (!!row.readonly !== !!prev.readonly) patch.readonly = !!row.readonly;
        const prevSourceId = prev.sourceId || null;
        const nextSourceId = row.sourceId || null;
        if (prevSourceId !== nextSourceId) patch.sourceId = nextSourceId;
        const prevSub = prev.subPath || '';
        if ((nextSourceId && rowSub !== prevSub) || (!nextSourceId && prevSub)) {
          patch.subPath = nextSourceId ? rowSub : '';
        }
        if (Object.keys(patch).length === 0) {
          setFieldEditRowId(null);
          return;
        }
        const result = await updateContainerMount(config.name, row.serverMountName, patch);
        if (result?.requiresRestart) setRequiresRestart(true);
      }
      if (onRefresh) await onRefresh();
      refreshStorageStatus();
      setFieldEditRowId(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingRowId(null);
    }
  };

  const handleRemove = async (row) => {
    setError(null);
    if (!row.serverMountName) {
      setRows((prev) => prev.filter((r) => r.rowId !== row.rowId));
      if (fieldEditRowId === row.rowId) setFieldEditRowId(null);
      return;
    }
    setDeletingRowId(row.rowId);
    try {
      const result = await removeContainerMount(config.name, row.serverMountName);
      if (result?.requiresRestart) setRequiresRestart(true);
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingRowId(null);
    }
  };

  const runUploadForRow = async (row, uploadFn) => {
    if (!row.serverMountName) {
      setError('Save the mount before uploading.');
      return;
    }
    setBusyRowId(row.rowId);
    setError(null);
    try {
      await uploadFn(row.serverMountName);
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyRowId(null);
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

  const openEditor = (row) => {
    const mn = row.name.trim();
    if (!mn || row.type !== 'file' || !row.serverMountName) return;
    setEditorMountName(row.serverMountName);
    setEditorOpen(true);
  };

  const headerAdds = (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => addRow('file')}
        className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
        title="Add file mount"
        aria-label="Add file mount"
      >
        <Plus size={14} aria-hidden />
        <File size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => addRow('directory')}
        className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
        title="Add folder mount"
        aria-label="Add folder mount"
      >
        <Plus size={14} aria-hidden />
        <Folder size={14} aria-hidden />
      </button>
    </div>
  );

  const truncate = (s, n) => {
    const t = (s || '').trim();
    if (t.length <= n) return t || '—';
    return `${t.slice(0, n - 1)}…`;
  };

  return (
    <SectionCard title="Mounts" requiresRestart={requiresRestart} error={error} headerAction={headerAdds}>
      <div className="space-y-3">
        <p className="text-[11px] text-text-muted">
          Use the pencil to edit paths and options. Save, delete, and uploads apply to one mount at a time. Hover a row for actions.
        </p>

        <DataTableScroll>
          <DataTable minWidthRem={60}>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense className="w-10 font-normal" aria-hidden />
                <DataTableTh dense className="min-w-[12rem]">
                  Container path
                </DataTableTh>
                <DataTableTh dense className="w-32 min-w-[8rem]">
                  Mount name
                </DataTableTh>
                <DataTableTh dense className="min-w-[9rem]">
                  Source
                </DataTableTh>
                <DataTableTh dense className="min-w-[8rem]">
                  Sub-path
                </DataTableTh>
                <DataTableTh dense>Read-only</DataTableTh>
                <DataTableTh dense align="right">
                  Actions
                </DataTableTh>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={7} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                    No mounts configured.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const rowBusy = busyRowId === row.rowId;
                const rowDeleting = deletingRowId === row.rowId;
                const persisted = rowMatchesServer(row, serverMounts);
                const canEditFile = persisted && row.type === 'file';
                const dirty = isRowDirty(row, serverMounts);
                const valid = !validateRowAgainstOthers(row, rows);
                const fieldEdit = isFieldEditing(row, fieldEditRowId);
                const canSaveRow = fieldEdit && dirty && valid && !saving;
                const showSaveSpinner = savingRowId === row.rowId;
                const actionsForce =
                  fieldEdit
                  || rowBusy
                  || showSaveSpinner
                  || rowDeleting
                  || !row.serverMountName;

                return (
                  <tr key={row.rowId} className={dataTableInteractiveRowClass}>
                    <DataTableTd dense className="text-text-muted">
                      <span className="inline-flex" title={row.type === 'directory' ? 'Folder mount' : 'File mount'}>
                        {row.type === 'directory' ? <Folder size={16} aria-hidden /> : <File size={16} aria-hidden />}
                      </span>
                    </DataTableTd>
                    <DataTableTd dense className="min-w-[14rem]">
                      {fieldEdit ? (
                        <input
                          type="text"
                          value={row.containerPath}
                          onChange={(e) => updateRow(row.rowId, 'containerPath', e.target.value)}
                          placeholder="/path/in/container"
                          className="input-field w-full min-w-0 font-mono text-xs"
                        />
                      ) : (
                        <span className="font-mono text-sm text-text-primary">{truncate(row.containerPath, 40)}</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="w-32 min-w-[8rem]">
                      {fieldEdit ? (
                        <input
                          type="text"
                          value={row.name}
                          onChange={(e) => updateRow(row.rowId, 'name', e.target.value)}
                          placeholder="storage key"
                          className="input-field w-full min-w-0 font-mono text-xs"
                        />
                      ) : (
                        <span className="font-mono text-sm text-text-primary">{truncate(row.name, 24)}</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="min-w-[9rem]">
                      {row.type === 'file' ? (
                        <span className="text-sm text-text-muted">Local</span>
                      ) : fieldEdit ? (
                        <select
                          value={row.sourceId || ''}
                          onChange={(e) => handleSourceChange(row, e.target.value || null)}
                          className="input-field w-full min-w-0 text-xs"
                        >
                          <option value="">Local</option>
                          {storageMounts.map((sm) => (
                            <option key={sm.id} value={sm.id}>
                              {(sm.label && sm.label.trim()) || sm.mountPath}
                            </option>
                          ))}
                        </select>
                      ) : (
                        (() => {
                          if (!row.sourceId) return <span className="text-sm text-text-muted">Local</span>;
                          const sm = storageMounts.find((m) => m.id === row.sourceId);
                          const missing = !sm;
                          const notMounted = sm && storageStatusById.get(sm.id) === false;
                          const label = sm ? ((sm.label && sm.label.trim()) || sm.mountPath) : row.sourceId;
                          const warn = missing || notMounted;
                          const warnMsg = missing
                            ? 'Referenced storage mount no longer exists'
                            : notMounted
                              ? 'Referenced storage mount is not currently mounted'
                              : '';
                          return (
                            <span className="inline-flex items-center gap-1 text-sm">
                              {warn && (
                                <AlertCircle size={12} className="text-status-stopped" aria-label={warnMsg}>
                                  <title>{warnMsg}</title>
                                </AlertCircle>
                              )}
                              <span className={warn ? 'text-status-stopped' : 'text-text-secondary'} title={warn ? warnMsg : label}>
                                {truncate(label, 20)}
                              </span>
                            </span>
                          );
                        })()
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="min-w-[8rem]">
                      {row.type === 'file' ? (
                        <span className="text-sm text-text-muted">—</span>
                      ) : row.sourceId ? (
                        fieldEdit ? (
                          <input
                            type="text"
                            value={row.subPath || ''}
                            onChange={(e) => updateRow(row.rowId, 'subPath', e.target.value)}
                            placeholder="(empty = mount root)"
                            className="input-field w-full min-w-0 font-mono text-xs"
                          />
                        ) : (
                          <span className="font-mono text-sm text-text-secondary">{row.subPath ? truncate(row.subPath, 20) : '—'}</span>
                        )
                      ) : (
                        <span className="text-sm text-text-muted">—</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense>
                      {fieldEdit ? (
                        <Toggle checked={row.readonly} onChange={(v) => updateRow(row.rowId, 'readonly', v)} />
                      ) : (
                        <span className="text-sm text-text-secondary">{row.readonly ? 'Yes' : 'No'}</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense align="right">
                      <DataTableRowActions forceVisible={actionsForce}>
                        {fieldEdit && (
                          <>
                            <button
                              type="button"
                              disabled={!canSaveRow}
                              onClick={() => handleSave(row)}
                              className={iconBtn}
                              title="Save mount"
                              aria-label="Save mount"
                            >
                              {showSaveSpinner ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelFieldEdit(row)}
                              disabled={showSaveSpinner}
                              className={iconBtn}
                              title={row.serverMountName ? 'Cancel field edit' : 'Remove unsaved row'}
                              aria-label={row.serverMountName ? 'Cancel field edit' : 'Remove unsaved row'}
                            >
                              <X size={14} aria-hidden />
                            </button>
                          </>
                        )}
                        {row.type === 'file' ? (
                          <>
                            <button
                              type="button"
                              disabled={!canEditFile || rowBusy || saving || rowDeleting}
                              onClick={() => openEditor(row)}
                              className={iconBtn}
                              title="Edit file"
                              aria-label="Edit file"
                            >
                              <SquarePen size={14} aria-hidden />
                            </button>
                            <label
                              className={`${iconBtn} cursor-pointer text-accent ${rowBusy || saving || rowDeleting ? 'opacity-40 pointer-events-none' : ''}`}
                              title="Upload file"
                              aria-label="Upload file"
                            >
                              {rowBusy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Upload size={14} aria-hidden />}
                              <input
                                type="file"
                                className="hidden"
                                disabled={rowBusy || saving || rowDeleting}
                                onChange={(e) => handleFileUpload(row, e)}
                              />
                            </label>
                          </>
                        ) : (
                          (() => {
                            const zipDisabled = rowBusy || saving || rowDeleting || !!row.sourceId;
                            const zipTitle = row.sourceId
                              ? 'Zip upload is available on Local mounts only'
                              : 'Upload zip';
                            return (
                              <label
                                className={`${iconBtn} cursor-pointer text-accent ${zipDisabled ? 'opacity-40 pointer-events-none' : ''}`}
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
                          })()
                        )}
                        {row.serverMountName && !fieldEdit && (
                          <button
                            type="button"
                            onClick={() => setFieldEditRowId(row.rowId)}
                            className={iconBtn}
                            title="Edit fields"
                            aria-label="Edit mount fields"
                          >
                            <Pencil size={14} aria-hidden />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemove(row)}
                          disabled={rowBusy || saving || rowDeleting}
                          className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-red-50`}
                          title={row.serverMountName ? 'Remove mount' : 'Remove row'}
                          aria-label={row.serverMountName ? 'Remove mount' : 'Remove row'}
                        >
                          {rowDeleting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
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

      <MountFileEditorModal
        open={editorOpen}
        containerName={config.name}
        mountName={editorMountName}
        onClose={() => {
          setEditorOpen(false);
          setEditorMountName('');
        }}
        onSaved={onRefresh}
      />
    </SectionCard>
  );
}
