import { useState, useEffect, useCallback } from 'react';
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
} from '../shared/DataTableChrome.jsx';
import { randomId } from '../../utils/randomId.js';
import { useSettingsStore } from '../../store/settingsStore.js';
import {
  addNetworkMount,
  patchNetworkMount,
  deleteNetworkMount,
  getNetworkMountStatus,
  mountNetworkMount,
  unmountNetworkMount,
  checkNetworkMountConnection,
} from '../../api/settings.js';

const iconBtn = 'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function rowFromSettings(d) {
  return {
    id: d.id,
    label: d.label || '',
    path: d.path || d.mountPath || '',
    mountPath: d.mountPath || d.path || '',
    share: d.share || '',
    username: d.username || '',
    password: d.password === '***' ? '' : (d.password || ''),
  };
}

function baselineRow(d) {
  return {
    id: d.id,
    label: d.label || '',
    path: d.path || d.mountPath || '',
    mountPath: d.mountPath || d.path || '',
    share: d.share || '',
    username: d.username || '',
  };
}

function rowDirty(row, settings) {
  const s = (settings?.networkMounts || []).find((m) => m.id === row.id);
  if (!s) return true;
  if (JSON.stringify(baselineRow(row)) !== JSON.stringify(baselineRow(rowFromSettings(s)))) return true;
  const prevPw = s.password === '***' ? '' : (s.password || '');
  if ((row.password || '').trim() !== (prevPw || '').trim()) return true;
  return false;
}

function truncate(s, max) {
  const t = (s || '').trim();
  if (t.length <= max) return t || '—';
  return `${t.slice(0, max - 1)}…`;
}

export default function HostNetworkStorage() {
  const settings = useSettingsStore((s) => s.settings);
  const loadSettings = useSettingsStore((s) => s.loadSettings);

  const [networkMounts, setNetworkMounts] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState(null);
  const [mountStatus, setMountStatus] = useState([]);
  const [mountActionId, setMountActionId] = useState(null);
  const [checkId, setCheckId] = useState(null);
  const [checkByRow, setCheckByRow] = useState({});

  useEffect(() => {
    if (settings) {
      const dests = Array.isArray(settings.networkMounts) ? settings.networkMounts : [];
      setNetworkMounts(dests.map(rowFromSettings));
    }
  }, [settings]);

  const refreshMountStatus = useCallback(() => {
    getNetworkMountStatus()
      .then((list) => setMountStatus(Array.isArray(list) ? list : []))
      .catch(() => setMountStatus([]));
  }, []);

  useEffect(() => {
    if (networkMounts.some((d) => d.share)) refreshMountStatus();
  }, [networkMounts.length, refreshMountStatus]);

  const isPersisted = (id) => (settings?.networkMounts || []).some((s) => s.id === id);

  const resetRowFromSettings = (id) => {
    const s = (settings?.networkMounts || []).find((m) => m.id === id);
    if (!s) return;
    setNetworkMounts((prev) => prev.map((x) => (x.id === id ? rowFromSettings(s) : x)));
  };

  const addMount = () => {
    const id = randomId();
    const defaultMountPath = '/mnt/wisp/smb';
    setNetworkMounts((prev) => [
      ...prev,
      {
        id,
        label: '',
        path: defaultMountPath,
        mountPath: defaultMountPath,
        share: '',
        username: '',
        password: '',
      },
    ]);
    setEditingId(id);
    setCheckByRow((o) => {
      const n = { ...o };
      delete n[id];
      return n;
    });
  };

  const removeMount = async (d) => {
    setError(null);
    if (!isPersisted(d.id)) {
      setNetworkMounts((prev) => prev.filter((x) => x.id !== d.id));
      if (editingId === d.id) setEditingId(null);
      return;
    }
    setDeletingId(d.id);
    try {
      await deleteNetworkMount(d.id);
      await loadSettings();
      refreshMountStatus();
      if (editingId === d.id) setEditingId(null);
      setCheckByRow((o) => {
        const n = { ...o };
        delete n[d.id];
        return n;
      });
    } catch (err) {
      setError(err.message || 'Failed to remove mount');
    } finally {
      setDeletingId(null);
    }
  };

  const updateMount = (id, field, value) => {
    setNetworkMounts((prev) => prev.map((x) => (x.id === id ? { ...x, [field]: value } : x)));
  };

  const syncPathFields = (id, value) => {
    setNetworkMounts((prev) => prev.map((x) => (x.id === id ? { ...x, path: value, mountPath: value } : x)));
  };

  const handleSaveRow = async (d) => {
    const mountPath = (d.mountPath || d.path || '').trim();
    if (!mountPath.startsWith('/')) {
      setError('Mount path must be absolute (start with /).');
      return;
    }
    setSavingId(d.id);
    setError(null);
    try {
      if (!isPersisted(d.id)) {
        await addNetworkMount({
          id: d.id,
          label: (d.label || '').trim(),
          share: (d.share || '').trim(),
          mountPath,
          username: (d.username || '').trim(),
          password: (d.password || '').trim(),
        });
      } else {
        const s = (settings?.networkMounts || []).find((m) => m.id === d.id);
        const patch = {};
        if ((d.label || '').trim() !== (s?.label || '').trim()) patch.label = (d.label || '').trim();
        const prevPath = (s?.mountPath || s?.path || '').trim();
        if (mountPath !== prevPath) {
          patch.mountPath = mountPath;
        }
        const prevShare = (s?.share || '').trim();
        const share = (d.share || '').trim();
        if (share !== prevShare) patch.share = share;
        if (share) {
          if ((d.username || '').trim() !== (s?.username || '').trim()) {
            patch.username = (d.username || '').trim();
          }
          const prevPw = s?.password === '***' ? '' : (s?.password || '');
          if ((d.password || '').trim() !== prevPw) {
            patch.password = (d.password || '').trim();
          }
        }
        if (Object.keys(patch).length > 0) {
          await patchNetworkMount(d.id, patch);
        }
      }
      await loadSettings();
      setEditingId(null);
      setCheckByRow((o) => {
        const n = { ...o };
        delete n[d.id];
        return n;
      });
      refreshMountStatus();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSavingId(null);
    }
  };

  const handleMountToggle = (id, mounted) => {
    setMountActionId(id);
    const p = mounted
      ? unmountNetworkMount(id)
      : mountNetworkMount(id);
    p.then(() => refreshMountStatus())
      /* Swallow: mount API errors are reflected via refreshMountStatus / server state; avoid duplicate banners */
      .catch(() => {})
      .finally(() => setMountActionId(null));
  };

  const handleCheck = (d) => {
    const share = (d.share || '').trim();
    const persisted = isPersisted(d.id);
    if (!persisted && !share) {
      setCheckByRow((o) => ({ ...o, [d.id]: { error: 'Set share first' } }));
      return;
    }
    setCheckId(d.id);
    setCheckByRow((o) => {
      const n = { ...o };
      delete n[d.id];
      return n;
    });
    const body = persisted
      ? { id: d.id }
      : { share, username: (d.username || '').trim(), password: (d.password || '').trim() };
    checkNetworkMountConnection(body)
      .then(() => setCheckByRow((o) => ({ ...o, [d.id]: { ok: true } })))
      .catch((err) => setCheckByRow((o) => ({
        ...o,
        [d.id]: { error: err.detail || err.message || 'Failed' },
      })))
      .finally(() => setCheckId(null));
  };

  const pathOk = (d) => !!(d.mountPath || d.path || '').trim().startsWith('/');

  const startEdit = (d) => {
    setEditingId(d.id);
    setCheckByRow((o) => {
      const n = { ...o };
      delete n[d.id];
      return n;
    });
  };

  const cancelEdit = (d) => {
    if (!isPersisted(d.id)) {
      setNetworkMounts((prev) => prev.filter((x) => x.id !== d.id));
    } else {
      resetRowFromSettings(d.id);
    }
    setEditingId(null);
    setCheckByRow((o) => {
      const n = { ...o };
      delete n[d.id];
      return n;
    });
  };

  const headerAdd = (
    <button
      type="button"
      onClick={addMount}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Add network mount"
      aria-label="Add network mount"
    >
      <Plus size={14} aria-hidden />
      <Server size={14} aria-hidden />
    </button>
  );

  return (
    <SectionCard title="Network Storage" titleIcon={<Server size={14} strokeWidth={2} />} error={error} headerAction={headerAdd}>
      <div className="space-y-3">
        <p className="text-[11px] text-text-muted">
          Use the pencil to edit a row, then Save. Check tests SMB credentials (shield turns green or red; hover for error detail). The plug control mounts or unmounts on the host — green means mounted.
        </p>

        <DataTableScroll>
          <DataTable minWidthRem={56}>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense>Label</DataTableTh>
                <DataTableTh dense className="min-w-[10rem]">Share</DataTableTh>
                <DataTableTh dense className="min-w-[9rem]">Mount path</DataTableTh>
                <DataTableTh dense>User</DataTableTh>
                <DataTableTh dense>Password</DataTableTh>
                <DataTableTh dense align="right">Actions</DataTableTh>
              </tr>
            </thead>
            <tbody>
              {networkMounts.length === 0 && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={6} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                    No network mounts. Use Add in the section header.
                  </td>
                </tr>
              )}
              {networkMounts.map((d) => {
                const status = mountStatus.find((s) => s.id === d.id);
                const mounted = status?.mounted ?? false;
                const isSMB = !!(d.share && (d.mountPath || d.path));
                const persisted = isPersisted(d.id);
                const editing = editingId === d.id;
                const dirty = rowDirty(d, settings);
                const canSave = editing && dirty && pathOk(d) && savingId !== d.id;
                const s = (settings?.networkMounts || []).find((m) => m.id === d.id);
                const hasStoredPassword = persisted && (s?.password === '***' || (s?.password && String(s.password).length > 0));

                const check = checkByRow[d.id];
                const checkLoading = checkId === d.id;
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
                  <tr key={d.id} className={dataTableInteractiveRowClass}>
                    <DataTableTd dense className="text-sm">
                      {editing ? (
                        <input
                          type="text"
                          value={d.label}
                          onChange={(e) => updateMount(d.id, 'label', e.target.value)}
                          placeholder="Label"
                          className="input-field w-full min-w-[6rem] text-xs"
                        />
                      ) : (
                        <span className="text-text-primary">{truncate(d.label, 24)}</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="text-sm font-mono text-text-secondary">
                      {editing ? (
                        <input
                          type="text"
                          value={d.share}
                          onChange={(e) => updateMount(d.id, 'share', e.target.value)}
                          placeholder="//server/share"
                          className="input-field w-full min-w-0 text-xs"
                        />
                      ) : (
                        truncate(d.share, 36)
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="text-sm font-mono text-text-secondary">
                      {editing ? (
                        <input
                          type="text"
                          value={d.mountPath || d.path}
                          onChange={(e) => syncPathFields(d.id, e.target.value)}
                          placeholder="/mnt/wisp/smb"
                          className="input-field w-full min-w-0 text-xs"
                        />
                      ) : (
                        truncate(d.mountPath || d.path, 28)
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="text-sm">
                      {editing ? (
                        <input
                          type="text"
                          value={d.username}
                          onChange={(e) => updateMount(d.id, 'username', e.target.value)}
                          placeholder="Username"
                          className="input-field w-full min-w-[6rem] text-xs"
                        />
                      ) : (
                        <span className="text-text-muted">{d.username ? truncate(d.username, 16) : '—'}</span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="text-sm">
                      {editing ? (
                        <input
                          type="password"
                          value={d.password}
                          onChange={(e) => updateMount(d.id, 'password', e.target.value)}
                          placeholder="Password"
                          className="input-field w-full min-w-[6rem] text-xs"
                        />
                      ) : (
                        <span className="text-text-muted font-mono text-xs">
                          {(d.password || hasStoredPassword) ? '••••' : '—'}
                        </span>
                      )}
                    </DataTableTd>
                    <DataTableTd dense align="right">
                      <DataTableRowActions forceVisible={editing}>
                        {editing && (
                          <>
                            <button
                              type="button"
                              onClick={() => handleSaveRow(d)}
                              disabled={!canSave}
                              className={iconBtn}
                              title="Save"
                              aria-label="Save mount"
                            >
                              {savingId === d.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelEdit(d)}
                              disabled={savingId === d.id}
                              className={iconBtn}
                              title="Cancel edit"
                              aria-label="Cancel edit"
                            >
                              <X size={14} aria-hidden />
                            </button>
                          </>
                        )}
                        {(!persisted || isSMB) && pathOk(d) && (
                          <button
                            type="button"
                            onClick={() => handleCheck(d)}
                            disabled={checkLoading}
                            className={checkBtnClass}
                            title={checkTitle}
                            aria-label={checkTitle}
                          >
                            {checkLoading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
                          </button>
                        )}
                        {persisted && isSMB && (
                          <button
                            type="button"
                            onClick={() => handleMountToggle(d.id, mounted)}
                            disabled={mountActionId === d.id || editing}
                            className={`inline-flex items-center justify-center rounded-md border p-1.5 transition-colors duration-150 disabled:opacity-40 ${mountBtnClass}`}
                            title={mounted ? 'Unmount share' : 'Mount share'}
                            aria-label={mounted ? 'Unmount share' : 'Mount share'}
                          >
                            {mountActionId === d.id ? (
                              <Loader2 size={14} className="animate-spin" aria-hidden />
                            ) : mounted ? (
                              <Unplug size={14} aria-hidden />
                            ) : (
                              <Plug size={14} aria-hidden />
                            )}
                          </button>
                        )}
                        {!editing && (
                          <button
                            type="button"
                            onClick={() => startEdit(d)}
                            className={iconBtn}
                            title="Edit"
                            aria-label="Edit mount"
                          >
                            <Pencil size={14} aria-hidden />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => removeMount(d)}
                          disabled={deletingId === d.id || savingId === d.id}
                          className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-red-50`}
                          title="Remove"
                          aria-label="Remove mount"
                        >
                          {deletingId === d.id ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
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
    </SectionCard>
  );
}
