import { useEffect, useMemo, useState } from 'react';
import { Braces, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

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
import EnvVarEditorModal from './EnvVarEditorModal.jsx';

const MASK = '••••••••';

function rowsFromEnv(env) {
  if (!env || typeof env !== 'object') return [];
  return Object.entries(env).map(([key, entry]) => {
    const secret = !!entry?.secret;
    return {
      key,
      secret,
      /* A secret's value is never sent to the client — `isSet` says whether
       * one is stored. */
      isSet: secret ? !!entry?.isSet : false,
      value: secret ? '' : String(entry?.value ?? ''),
    };
  });
}

const truncate = (s, n) => {
  const t = (s || '').trim();
  if (t.length <= n) return t || '—';
  return `${t.slice(0, n - 1)}…`;
};

export default function ContainerEnvSection({ config, onSave }) {
  const [error, setError] = useState(null);
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [deletingKey, setDeletingKey] = useState(null);
  /* The row is snapshotted when the editor opens so a background refresh of
   * `config.env` can't reset the open form. */
  const [editor, setEditor] = useState({ open: false, row: null });

  const rows = useMemo(() => rowsFromEnv(config.env), [config.env]);

  useEffect(() => {
    setRequiresRestart(false);
    setError(null);
  }, [config.env]);

  /* Save path for the editor modal: it builds the `envPatch` (whole-`env`-map
   * exception, see docs/UI-PATTERNS.md), this owns the API call and the
   * restart badge. Failures propagate so the modal can show them and stay open. */
  const submitEnvPatch = async ({ envPatch }) => {
    setError(null);
    const result = await onSave({ envPatch });
    if (result?.requiresRestart) setRequiresRestart(true);
    return result;
  };

  const removeRow = async (row) => {
    setError(null);
    setDeletingKey(row.key);
    try {
      const result = await onSave({ envPatch: { [row.key]: null } });
      if (result?.requiresRestart) setRequiresRestart(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setDeletingKey(null);
    }
  };

  const headerAdd = (
    <button
      type="button"
      onClick={() => { setError(null); setEditor({ open: true, row: null }); }}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Add environment variable"
      aria-label="Add environment variable"
    >
      <Plus size={14} aria-hidden />
      <Braces size={14} aria-hidden />
    </button>
  );

  return (
    <SectionCard
      title="Environment Variables"
      helpText="Add or edit variables in a form. Marking a value as secret hides it — secrets are never read back, only overwritten. The dice generates a random secret, with a one-time copy."
      requiresRestart={requiresRestart}
      error={error}
      headerAction={headerAdd}
    >
      <DataTableScroll>
        <DataTable>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense className="w-[40%]">
                Key
              </DataTableTh>
              <DataTableTh dense className="hidden sm:table-cell">Value</DataTableTh>
              <DataTableTh dense align="right">
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
              const showMask = row.secret && row.isSet;

              return (
                <tr key={row.key} className={dataTableInteractiveRowClass}>
                  <DataTableTd dense>
                    <span className="font-mono text-sm text-text-primary">{truncate(row.key, 48)}</span>
                    <div className="mt-0.5 font-mono text-xs text-text-secondary sm:hidden">
                      {row.secret ? (
                        <>
                          {showMask ? MASK : '—'}
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-text-muted">secret</span>
                        </>
                      ) : (
                        truncate(row.value, 48)
                      )}
                    </div>
                  </DataTableTd>
                  <DataTableTd dense className="hidden sm:table-cell">
                    {row.secret ? (
                      <span className="font-mono text-sm text-text-secondary">
                        {showMask ? MASK : '—'}
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-text-muted">secret</span>
                      </span>
                    ) : (
                      <span className="font-mono text-sm text-text-secondary">{truncate(row.value, 64)}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense align="right">
                    <DataTableRowActions forceVisible={deletingKey === row.key}>
                      <button
                        type="button"
                        onClick={() => { setError(null); setEditor({ open: true, row }); }}
                        className={rowActionIconBtn}
                        title="Edit"
                        aria-label={`Edit ${row.key}`}
                      >
                        <Pencil size={14} aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeRow(row)}
                        disabled={deletingKey === row.key}
                        className={`${rowActionIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
                        title="Remove variable"
                        aria-label={`Remove ${row.key}`}
                      >
                        {deletingKey === row.key ? (
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

      <EnvVarEditorModal
        open={editor.open}
        row={editor.row}
        existingKeys={rows.map((r) => r.key)}
        onSubmit={submitEnvPatch}
        onClose={() => setEditor({ open: false, row: null })}
      />
    </SectionCard>
  );
}
