import { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Braces, Pencil, Save, X, Loader2 } from 'lucide-react';
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

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function rowsFromEnv(env) {
  if (!env || typeof env !== 'object') return [];
  return Object.entries(env).map(([k, v]) => ({
    id: randomId(),
    initialKey: k,
    key: k,
    value: String(v ?? ''),
  }));
}

function buildEnvFromRows(rows) {
  const obj = {};
  for (const r of rows) {
    const k = (r.key || '').trim();
    if (!k) continue;
    obj[k] = r.value;
  }
  return obj;
}

function validateRows(rows) {
  const seen = new Set();
  for (const r of rows) {
    const k = (r.key || '').trim();
    if (!k) continue;
    if (seen.has(k)) return `Duplicate key: ${k}`;
    seen.add(k);
  }
  return null;
}

export default function ContainerEnvSection({ config, isCreating, onSave, onFormChange }) {
  const [rows, setRows] = useState(() => rowsFromEnv(config.env));
  const [editingId, setEditingId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);

  const init = useCallback(() => {
    setRows(rowsFromEnv(config.env));
    setEditingId(null);
    setRequiresRestart(false);
    setError(null);
  }, [config?.env]);

  useEffect(() => {
    if (!isCreating) init();
  }, [init, isCreating]);

  const addEntry = () => {
    const id = randomId();
    setRows((prev) => [...prev, { id, initialKey: null, key: '', value: '' }]);
    setEditingId(id);
  };

  const updateRow = (id, field, value) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const cancelEdit = (row) => {
    if (row.initialKey == null && !(row.key || '').trim() && !(row.value || '').trim()) {
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setEditingId(null);
      return;
    }
    if (row.initialKey != null) {
      const v = config.env?.[row.initialKey];
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? { ...r, key: row.initialKey, value: String(v ?? '') }
            : r));
    }
    setEditingId(null);
  };

  const saveRow = async (row) => {
    const msg = validateRows(rows);
    if (msg) {
      setError(msg);
      return;
    }
    if (!(row.key || '').trim()) {
      setError('Key cannot be empty when saving.');
      return;
    }
    setSavingId(row.id);
    setError(null);
    try {
      const env = buildEnvFromRows(rows);
      if (isCreating && onFormChange) {
        onFormChange({ env });
        setEditingId(null);
      } else {
        const result = await onSave({ env });
        if (result?.requiresRestart) setRequiresRestart(true);
        setEditingId(null);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  };

  const removeRow = async (row) => {
    setError(null);
    const next = rows.filter((r) => r.id !== row.id);
    if (isCreating && onFormChange) {
      onFormChange({ env: buildEnvFromRows(next) });
      setRows(next);
      if (editingId === row.id) setEditingId(null);
      return;
    }
    setDeletingId(row.id);
    try {
      const result = await onSave({ env: buildEnvFromRows(next) });
      if (result?.requiresRestart) setRequiresRestart(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const headerAdd = (
    <button
      type="button"
      onClick={addEntry}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Add environment variable"
      aria-label="Add environment variable"
    >
      <Plus size={14} aria-hidden />
      <Braces size={14} aria-hidden />
    </button>
  );

  const truncate = (s, n) => {
    const t = (s || '').trim();
    if (t.length <= n) return t || '—';
    return `${t.slice(0, n - 1)}…`;
  };

  return (
    <SectionCard
      title="Environment Variables"
      requiresRestart={requiresRestart}
      error={error}
      headerAction={headerAdd}
    >
      <p className="text-[11px] text-text-muted mb-3">
        Hover a row for actions. Use the pencil to edit; Save writes the full environment map (one API update per save).
      </p>
      <DataTableScroll>
        <DataTable minWidthRem={28}>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense className="w-[40%]">
                Key
              </DataTableTh>
              <DataTableTh dense>Value</DataTableTh>
              <DataTableTh dense align="right" className="w-36">
                Actions
              </DataTableTh>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr className={dataTableBodyRowClass}>
                <td colSpan={3} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                  No environment variables. Use Add in the section header.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const editing = editingId === row.id;
              const baseVal =
                row.initialKey != null ? String(config.env?.[row.initialKey] ?? '') : '';
              const dirty =
                row.initialKey == null
                  ? ((row.key || '').trim() !== '' || (row.value || '').trim() !== '')
                  : (row.key || '').trim() !== row.initialKey || String(row.value) !== baseVal;
              const canSave =
                editing
                && (row.key || '').trim() !== ''
                && (row.initialKey == null ? true : dirty);
              const actionsForce =
                editing || savingId === row.id || deletingId === row.id;

              return (
                <tr key={row.id} className={dataTableInteractiveRowClass}>
                  <DataTableTd dense>
                    {editing ? (
                      <input
                        type="text"
                        value={row.key}
                        onChange={(e) => updateRow(row.id, 'key', e.target.value)}
                        placeholder="KEY"
                        className="input-field w-full font-mono text-xs"
                      />
                    ) : (
                      <span className="font-mono text-sm text-text-primary">{truncate(row.key, 48)}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense>
                    {editing ? (
                      <input
                        type="text"
                        value={row.value}
                        onChange={(e) => updateRow(row.id, 'value', e.target.value)}
                        placeholder="value"
                        className="input-field w-full font-mono text-xs"
                      />
                    ) : (
                      <span className="font-mono text-sm text-text-secondary">{truncate(row.value, 64)}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense align="right">
                    <DataTableRowActions forceVisible={actionsForce}>
                      {!editing && (
                        <button
                          type="button"
                          onClick={() => setEditingId(row.id)}
                          className={iconBtn}
                          title="Edit"
                          aria-label="Edit variable"
                        >
                          <Pencil size={14} aria-hidden />
                        </button>
                      )}
                      {editing && (
                        <>
                          <button
                            type="button"
                            onClick={() => saveRow(row)}
                            disabled={!canSave || savingId === row.id}
                            className={iconBtn}
                            title="Save environment"
                            aria-label="Save environment"
                          >
                            {savingId === row.id ? (
                              <Loader2 size={14} className="animate-spin" aria-hidden />
                            ) : (
                              <Save size={14} aria-hidden />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => cancelEdit(row)}
                            disabled={savingId === row.id}
                            className={iconBtn}
                            title="Cancel edit"
                            aria-label="Cancel edit"
                          >
                            <X size={14} aria-hidden />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => removeRow(row)}
                        disabled={deletingId === row.id || savingId === row.id}
                        className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-red-50`}
                        title="Remove variable"
                        aria-label="Remove variable"
                      >
                        {deletingId === row.id ? (
                          <Loader2 size={14} className="animate-spin" aria-hidden />
                        ) : (
                          <Trash2 size={14} aria-hidden />
                        )}
                      </button>
                    </DataTableRowActions>
                  </DataTableTd>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </DataTableScroll>
    </SectionCard>
  );
}
