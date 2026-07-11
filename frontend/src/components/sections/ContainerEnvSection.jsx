import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus, Trash2, Braces, Pencil, Save, X, Loader2, Lock, LockOpen, Dices, Copy, Check,
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
  rowActionIconBtnPrimary,
} from '../shared/DataTableChrome.jsx';
import { randomId } from '../../utils/randomId.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

const MASK = '••••••••';

// 32 random bytes as hex (same shape as `openssl rand -hex 32`) — hex keeps the
// value safe for apps with naive env parsing. `getRandomValues` works in
// non-secure (HTTP) contexts, unlike `crypto.randomUUID`.
function generateSecretValue() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function rowsFromEnv(env) {
  if (!env || typeof env !== 'object') return [];
  return Object.entries(env).map(([k, entry]) => {
    const isSecret = !!entry?.secret;
    return {
      id: randomId(),
      initialKey: k,
      initialSecret: isSecret,
      initialIsSet: isSecret ? !!entry?.isSet : false,
      key: k,
      value: isSecret ? '' : String(entry?.value ?? ''),
      secret: isSecret,
      secretValueDirty: false,
    };
  });
}

// Used by the create-flow (not currently mounted, but kept as a defensive
// fallback). Emits the full structured env map in the target on-disk shape.
function buildEnvMapFromRows(rows) {
  const obj = {};
  for (const r of rows) {
    const k = (r.key || '').trim();
    if (!k) continue;
    obj[k] = r.secret ? { value: r.value, secret: true } : { value: r.value };
  }
  return obj;
}

// Build an envPatch delta containing only the rows that actually changed,
// plus null entries for rows that were removed.
function buildEnvPatchFromRows(rows, originalMap) {
  const patch = {};
  const remainingOrig = new Set(Object.keys(originalMap));

  for (const r of rows) {
    const k = (r.key || '').trim();
    if (!k) continue;

    if (r.initialKey != null && r.initialKey === k) {
      remainingOrig.delete(r.initialKey);
      const orig = originalMap[r.initialKey];
      const secretChanged = r.secret !== orig.initialSecret;
      const plainValueChanged = !r.secret && r.value !== orig.value;
      const secretValueChanged = r.secret && r.secretValueDirty;
      if (!secretChanged && !plainValueChanged && !secretValueChanged) continue;
      const entry = {};
      if (secretChanged) entry.secret = r.secret;
      if (plainValueChanged || secretValueChanged) entry.value = r.value;
      patch[k] = entry;
      continue;
    }

    // New row OR rename: remove old key (if any) + upsert new.
    if (r.initialKey != null) {
      remainingOrig.delete(r.initialKey);
      patch[r.initialKey] = null;
    }
    patch[k] = r.secret
      ? { value: r.value, secret: true }
      : { value: r.value };
  }

  for (const origKey of remainingOrig) {
    patch[origKey] = null;
  }

  return patch;
}

function validateRows(rows) {
  const seen = new Set();
  for (const r of rows) {
    const k = (r.key || '').trim();
    if (!k) continue;
    if (seen.has(k)) return `Duplicate key: ${k}`;
    seen.add(k);
    if (r.secret && r.initialKey == null && !r.secretValueDirty && !(r.value || '').trim()) {
      return `Secret '${k}' requires a value`;
    }
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
  const [pendingToggle, setPendingToggle] = useState(null); // { rowId, key, toSecret }
  const [pendingGenerate, setPendingGenerate] = useState(null); // { rowId, key, value, replacing }
  const [genCopied, setGenCopied] = useState(false);

  const originalMap = useMemo(() => {
    const map = {};
    if (config?.env && typeof config.env === 'object') {
      for (const [k, v] of Object.entries(config.env)) {
        map[k] = {
          initialSecret: !!v?.secret,
          value: v?.secret ? '' : String(v?.value ?? ''),
        };
      }
    }
    return map;
  }, [config?.env]);

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
    setRows((prev) => [
      ...prev,
      {
        id,
        initialKey: null,
        initialSecret: false,
        initialIsSet: false,
        key: '',
        value: '',
        secret: false,
        secretValueDirty: false,
      },
    ]);
    setEditingId(id);
  };

  const updateRow = (id, field, value) => {
    setRows((prev) => prev.map((r) => {
      if (r.id !== id) return r;
      const next = { ...r, [field]: value };
      if (field === 'value' && r.secret) next.secretValueDirty = true;
      return next;
    }));
  };

  const cancelEdit = (row) => {
    if (row.initialKey == null && !(row.key || '').trim() && !(row.value || '').trim()) {
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setEditingId(null);
      return;
    }
    if (row.initialKey != null) {
      const orig = config.env?.[row.initialKey] || {};
      const origSecret = !!orig.secret;
      setRows((prev) =>
        prev.map((r) =>
          r.id === row.id
            ? {
              ...r,
              key: row.initialKey,
              value: origSecret ? '' : String(orig.value ?? ''),
              secret: origSecret,
              secretValueDirty: false,
            }
            : r));
    }
    setEditingId(null);
  };

  const requestToggleSecret = (row) => {
    setPendingToggle({ rowId: row.id, key: (row.key || '').trim() || row.initialKey || '', toSecret: !row.secret });
  };

  const confirmToggleSecret = () => {
    if (!pendingToggle) return;
    const { rowId, toSecret } = pendingToggle;
    setRows((prev) => prev.map((r) => {
      if (r.id !== rowId) return r;
      if (toSecret) {
        // Non-secret → secret. Preserve the current value so the upcoming save
        // carries it through as a secret upsert; mark dirty so canSave lights up.
        return { ...r, secret: true, secretValueDirty: true };
      }
      // Secret → non-secret. Clear value; user must type a new plaintext (or
      // save empty and let the server clear the stored secret).
      return { ...r, secret: false, value: '', secretValueDirty: false };
    }));
    setEditingId(rowId);
    setPendingToggle(null);
  };

  const cancelToggleSecret = () => setPendingToggle(null);

  const requestGenerate = (row) => {
    setGenCopied(false);
    setPendingGenerate({
      rowId: row.id,
      key: (row.key || '').trim() || row.initialKey || '',
      value: generateSecretValue(),
      replacing: row.initialIsSet || row.secretValueDirty || !!(row.value || '').trim(),
    });
  };

  // Apply fills the row and enters edit mode; the row's Save stays the single
  // commit affordance (nothing is persisted until the user saves the row).
  const applyGenerate = () => {
    if (!pendingGenerate) return;
    const { rowId, value } = pendingGenerate;
    setRows((prev) => prev.map((r) => (
      r.id === rowId ? { ...r, value, secretValueDirty: true } : r
    )));
    setEditingId(rowId);
    setPendingGenerate(null);
  };

  const cancelGenerate = () => setPendingGenerate(null);

  const copyGenerated = async () => {
    if (!pendingGenerate) return;
    try {
      await navigator.clipboard.writeText(pendingGenerate.value);
      setGenCopied(true);
      setTimeout(() => setGenCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context) — the field is selectable anyway */
    }
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
      if (isCreating && onFormChange) {
        onFormChange({ env: buildEnvMapFromRows(rows) });
        setEditingId(null);
      } else {
        const envPatch = buildEnvPatchFromRows(rows, originalMap);
        if (Object.keys(envPatch).length === 0) {
          setEditingId(null);
          return;
        }
        const result = await onSave({ envPatch });
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
    if (isCreating && onFormChange) {
      const next = rows.filter((r) => r.id !== row.id);
      onFormChange({ env: buildEnvMapFromRows(next) });
      setRows(next);
      if (editingId === row.id) setEditingId(null);
      return;
    }
    if (row.initialKey == null) {
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      if (editingId === row.id) setEditingId(null);
      return;
    }
    setDeletingId(row.id);
    try {
      const result = await onSave({ envPatch: { [row.initialKey]: null } });
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
      className="hidden sm:inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
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
      helpText="Hover a row to see actions. Toggle the lock to mark a value as secret — secrets are never read back, only overwritten. The dice generates a random value for a secret, with a one-time copy."
      requiresRestart={requiresRestart}
      error={error}
      headerAction={headerAdd}
    >
      <DataTableScroll>
        <DataTable minWidthRem={28}>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense className="w-[40%]">
                Key
              </DataTableTh>
              <DataTableTh dense className="hidden sm:table-cell">Value</DataTableTh>
              <DataTableTh dense align="right" className="hidden w-44 sm:table-cell">
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
              const orig = row.initialKey != null ? originalMap[row.initialKey] : null;
              const keyChanged = row.initialKey != null && (row.key || '').trim() !== row.initialKey;
              const secretChanged = orig && row.secret !== orig.initialSecret;
              const valueChanged = !row.secret && orig && row.value !== orig.value;
              const secretValueChanged = row.secret && row.secretValueDirty;
              const dirty =
                row.initialKey == null
                  ? ((row.key || '').trim() !== '' || (row.value || '').trim() !== '')
                  : keyChanged || secretChanged || valueChanged || secretValueChanged;
              const canSave =
                editing
                && (row.key || '').trim() !== ''
                && (row.initialKey == null ? true : dirty);
              const actionsForce =
                editing || savingId === row.id || deletingId === row.id;
              const showMask = row.secret && !editing && (row.initialIsSet || row.secretValueDirty);

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
                      <>
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
                      </>
                    )}
                  </DataTableTd>
                  <DataTableTd dense className="hidden sm:table-cell">
                    {editing ? (
                      row.secret ? (
                        <input
                          type="password"
                          value={row.value}
                          onChange={(e) => updateRow(row.id, 'value', e.target.value)}
                          placeholder={row.initialIsSet ? 'Enter new value to replace' : 'Enter value'}
                          autoComplete="new-password"
                          className="input-field w-full font-mono text-xs"
                        />
                      ) : (
                        <input
                          type="text"
                          value={row.value}
                          onChange={(e) => updateRow(row.id, 'value', e.target.value)}
                          placeholder="value"
                          className="input-field w-full font-mono text-xs"
                        />
                      )
                    ) : row.secret ? (
                      <span className="font-mono text-sm text-text-secondary">
                        {showMask ? MASK : '—'}
                        <span className="ml-2 text-[10px] uppercase tracking-wide text-text-muted">secret</span>
                      </span>
                    ) : (
                      <span className="font-mono text-sm text-text-secondary">{truncate(row.value, 64)}</span>
                    )}
                  </DataTableTd>
                  <DataTableTd dense align="right" className="hidden sm:table-cell">
                    <DataTableRowActions forceVisible={actionsForce}>
                      <button
                        type="button"
                        onClick={() => requestToggleSecret(row)}
                        disabled={savingId === row.id || deletingId === row.id}
                        className={iconBtn}
                        title={row.secret ? 'Unmark as secret' : 'Mark as secret'}
                        aria-label={row.secret ? 'Unmark as secret' : 'Mark as secret'}
                      >
                        {row.secret ? <Lock size={14} aria-hidden /> : <LockOpen size={14} aria-hidden />}
                      </button>
                      {row.secret && (
                        <button
                          type="button"
                          onClick={() => requestGenerate(row)}
                          disabled={savingId === row.id || deletingId === row.id}
                          className={iconBtn}
                          title="Generate random value"
                          aria-label="Generate random value"
                        >
                          <Dices size={14} aria-hidden />
                        </button>
                      )}
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
                            className={rowActionIconBtnPrimary}
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
                        className={`${iconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`}
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

      <ConfirmDialog
        open={!!pendingToggle}
        title={pendingToggle?.toSecret ? 'Mark as secret?' : 'Unmark secret?'}
        confirmLabel={pendingToggle?.toSecret ? 'Mark secret' : 'Unmark'}
        onConfirm={confirmToggleSecret}
        onCancel={cancelToggleSecret}
      >
        {pendingToggle?.toSecret ? (
          <p>
            Marking <span className="font-mono text-text-primary">{pendingToggle?.key}</span> as secret will hide its
            value from the UI. After saving, you won&apos;t be able to read it again — only overwrite it. Continue?
          </p>
        ) : (
          <p>
            Unmarking <span className="font-mono text-text-primary">{pendingToggle?.key}</span> will clear its stored
            value. You&apos;ll need to enter a new non-secret value before saving. Continue?
          </p>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!pendingGenerate}
        title="Generate new secret?"
        confirmLabel="Apply"
        variant={pendingGenerate?.replacing ? 'danger' : 'primary'}
        onConfirm={applyGenerate}
        onCancel={cancelGenerate}
      >
        {pendingGenerate?.replacing ? (
          <p>
            This replaces the value of <span className="font-mono text-text-primary">{pendingGenerate?.key || 'this variable'}</span> when
            you save the row. The old value cannot be recovered — make sure nothing still depends on it.
          </p>
        ) : (
          <p>
            A random value was generated for <span className="font-mono text-text-primary">{pendingGenerate?.key || 'this variable'}</span>.
            It will be stored when you save the row.
          </p>
        )}
        <p className="mt-2">Copy it now — it won&apos;t be shown again after this dialog closes.</p>
        <div className="mt-3">
          <span className="text-[10px] font-medium uppercase tracking-wide text-text-muted">New secret</span>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="text"
              value={pendingGenerate?.value || ''}
              readOnly
              onFocus={(e) => e.target.select()}
              className="input-field w-full font-mono text-xs text-text-secondary"
            />
            <button
              type="button"
              onClick={copyGenerated}
              title="Copy new secret"
              aria-label="Copy new secret"
              className="flex h-[34px] shrink-0 items-center gap-1 rounded-md border border-surface-border bg-surface px-2.5 text-xs text-text-secondary hover:bg-surface-sidebar transition-colors duration-150"
            >
              {genCopied ? <Check size={14} className="text-status-running" aria-hidden /> : <Copy size={14} aria-hidden />}
            </button>
          </div>
        </div>
      </ConfirmDialog>
    </SectionCard>
  );
}
