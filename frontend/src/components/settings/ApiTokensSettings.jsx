import { useState, useEffect, useCallback } from 'react';
import { KeyRound, Plus, Check, X, Trash2, Copy, Loader2 } from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import {
  DataTableScroll,
  DataTable,
  DataTableTh,
  DataTableTd,
  DataTableRowActions,
  dataTableHeadRowClass,
  dataTableBodyRowClass,
  dataTableEmptyCellClass,
  rowActionIconBtn,
  rowActionIconBtnPrimary,
} from '../shared/DataTableChrome.jsx';
import { listApiTokens, createApiToken, deleteApiToken } from '../../api/authTokens.js';

const HELP =
  'Bearer tokens for non-interactive clients (coding agents, scripts). Read-only tokens can ' +
  'only GET; admin tokens can change state. Tokens cannot open consoles, change the password, ' +
  'or manage other tokens. The token value is shown once at creation — only a hash is stored.';

function formatCreated(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function ApiTokensSettings() {
  const [tokens, setTokens] = useState(null);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newScope, setNewScope] = useState('read');
  const [creating, setCreating] = useState(false);
  // { label, token } — shown once after a successful create, until dismissed.
  const [minted, setMinted] = useState(null);
  const [copied, setCopied] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setTokens(await listApiTokens());
    } catch (err) {
      setError(err.detail || err.message || 'Failed to load API tokens');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => {
    setError(null);
    setNewLabel('');
    setNewScope('read');
    setAdding(true);
  };

  const cancelAdd = () => {
    setAdding(false);
    setNewLabel('');
  };

  const handleCreate = async () => {
    if (!newLabel.trim() || creating) return;
    setError(null);
    setCreating(true);
    try {
      const created = await createApiToken({ label: newLabel.trim(), scope: newScope });
      setMinted({ label: created.label, token: created.token });
      setCopied(false);
      setAdding(false);
      setNewLabel('');
      await load();
    } catch (err) {
      setError(err.detail || err.message || 'Failed to create API token');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget || deleting) return;
    setError(null);
    setDeleting(true);
    try {
      await deleteApiToken(deleteTarget.id);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err.detail || err.message || 'Failed to revoke API token');
    } finally {
      setDeleting(false);
    }
  };

  const copyToken = async () => {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (insecure context) — the field is selectable anyway */
    }
  };

  const headerAdd = (
    <button
      type="button"
      onClick={openAdd}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Create API token"
      aria-label="Create API token"
    >
      <Plus size={14} aria-hidden />
      <KeyRound size={14} aria-hidden />
    </button>
  );

  return (
    <SectionCard
      title="API tokens"
      titleIcon={<KeyRound size={14} />}
      helpText={HELP}
      error={error}
      headerAction={headerAdd}
    >
      <div className="space-y-4">
        {minted && (
          <div className="rounded-md border border-accent/30 bg-accent-soft px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-text-primary">
                Token “{minted.label}” created — copy it now, it won’t be shown again.
              </p>
              <button
                type="button"
                onClick={() => setMinted(null)}
                title="Dismiss"
                aria-label="Dismiss"
                className="shrink-0 rounded-md p-1 text-text-muted hover:bg-surface transition-colors duration-150"
              >
                <X size={14} />
              </button>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={minted.token}
                readOnly
                onFocus={(e) => e.target.select()}
                className="input-field font-mono text-xs text-text-secondary"
              />
              <button
                type="button"
                onClick={copyToken}
                title="Copy token"
                aria-label="Copy token"
                className="flex h-[34px] shrink-0 items-center gap-1 rounded-md border border-surface-border bg-surface px-2.5 text-xs text-text-secondary hover:bg-surface-sidebar transition-colors duration-150"
              >
                {copied ? <Check size={14} className="text-status-running" /> : <Copy size={14} />}
              </button>
            </div>
          </div>
        )}

        {tokens == null ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : (
          <DataTableScroll>
            <DataTable minWidthRem={36}>
              <thead>
                <tr className={dataTableHeadRowClass}>
                  <DataTableTh dense>Label</DataTableTh>
                  <DataTableTh dense className="w-28">Scope</DataTableTh>
                  <DataTableTh dense className="hidden sm:table-cell">Created</DataTableTh>
                  <DataTableTh dense align="right" className="w-24">Actions</DataTableTh>
                </tr>
              </thead>
              <tbody>
                {adding && (
                  <tr className={dataTableBodyRowClass}>
                    <DataTableTd dense>
                      <input
                        type="text"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
                        placeholder="claude-code"
                        maxLength={64}
                        autoFocus
                        className="input-field placeholder:text-text-muted"
                      />
                    </DataTableTd>
                    <DataTableTd dense>
                      <select
                        value={newScope}
                        onChange={(e) => setNewScope(e.target.value)}
                        className="input-field"
                      >
                        <option value="read">Read-only</option>
                        <option value="admin">Admin</option>
                      </select>
                    </DataTableTd>
                    <DataTableTd dense className="hidden sm:table-cell text-text-muted">—</DataTableTd>
                    <DataTableTd dense align="right">
                      <DataTableRowActions forceVisible>
                        <button
                          type="button"
                          onClick={handleCreate}
                          disabled={!newLabel.trim() || creating}
                          title="Create token"
                          aria-label="Create token"
                          className={rowActionIconBtnPrimary}
                        >
                          {creating ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        </button>
                        <button
                          type="button"
                          onClick={cancelAdd}
                          disabled={creating}
                          title="Cancel"
                          aria-label="Cancel"
                          className={rowActionIconBtn}
                        >
                          <X size={14} />
                        </button>
                      </DataTableRowActions>
                    </DataTableTd>
                  </tr>
                )}
                {tokens.length === 0 && !adding ? (
                  <tr>
                    <td colSpan={4} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                      No API tokens. Create one with the + button above to let agents and scripts talk to Wisp.
                    </td>
                  </tr>
                ) : (
                  tokens.map((t) => (
                    <tr key={t.id} className={dataTableBodyRowClass}>
                      <DataTableTd dense className="text-text-primary">{t.label}</DataTableTd>
                      <DataTableTd dense>
                        {t.scope === 'admin' ? (
                          <span className="rounded-full bg-status-warning-soft px-2 py-0.5 text-[10px] font-medium text-status-warning">admin</span>
                        ) : (
                          <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-muted border border-surface-border">read-only</span>
                        )}
                      </DataTableTd>
                      <DataTableTd dense className="hidden sm:table-cell text-text-muted">
                        {formatCreated(t.createdAt)}
                      </DataTableTd>
                      <DataTableTd dense align="right">
                        <DataTableRowActions forceVisible>
                          <button
                            type="button"
                            onClick={() => setDeleteTarget(t)}
                            title="Revoke token"
                            aria-label="Revoke token"
                            className={rowActionIconBtn}
                          >
                            <Trash2 size={14} />
                          </button>
                        </DataTableRowActions>
                      </DataTableTd>
                    </tr>
                  ))
                )}
              </tbody>
            </DataTable>
          </DataTableScroll>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget != null}
        title="Revoke API token"
        confirmLabel={deleting ? 'Revoking…' : 'Revoke'}
        onConfirm={handleDelete}
        onCancel={() => (deleting ? null : setDeleteTarget(null))}
      >
        Revoke “{deleteTarget?.label}”? Clients using it will stop working immediately.
      </ConfirmDialog>
    </SectionCard>
  );
}
