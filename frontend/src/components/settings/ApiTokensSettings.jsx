import { useState } from 'react';
import { KeyRound, Plus, Check, X, Trash2 } from 'lucide-react';

import Card from '../shared/Card.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import { DataTableScroll, DataTable, DataTableTh, DataTableTd, DataTableRowActions, dataTableHeadRowClass, dataTableBodyRowClass, dataTableEmptyCellClass } from '../shared/DataTableChrome.jsx';
import { createApiToken, deleteApiToken } from '../../api/authTokens.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useCommand } from '../../hooks/useCommand.js';
import RecordGate from '../shared/RecordGate.jsx';
import RecordError from '../shared/RecordError.jsx';
import IconButton from '../shared/IconButton.jsx';
import CopyButton from '../shared/CopyButton.jsx';

const HELP =
  'Bearer tokens for non-interactive clients (coding agents, scripts). Read-only tokens can ' +
  'only GET; admin tokens can change state. Tokens cannot open consoles, change the password, ' +
  'change SSO settings, or manage other tokens. The token value is shown once at creation — only a hash is stored.';

function formatCreated(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function ApiTokensSettings() {
  /* The tokens, read again on a create or revoke from any tab. */
  const tokensRecord = useRecord(RECORD.TOKENS);
  const tokens = tokensRecord.data;
  /* Create, and each token's revoke (keyed by its id): separate commands, each with
   * its own error in the section. */
  const create = useCommand();
  const revoke = useCommand();
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newScope, setNewScope] = useState('read');
  const creating = create.busy;
  // { label, token } — shown once after a successful create, until dismissed.
  const [minted, setMinted] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const openAdd = () => {
    setNewLabel('');
    setNewScope('read');
    setAdding(true);
  };

  const cancelAdd = () => {
    setAdding(false);
    setNewLabel('');
  };

  const handleCreate = () => {
    if (!newLabel.trim()) return;
    /* The secret is shown once, from the 201; the list row arrives with the cue. */
    create.run(() => createApiToken({ label: newLabel.trim(), scope: newScope }), {
      onDone: (created) => {
        setMinted({ label: created.label, token: created.token });
        setAdding(false);
        setNewLabel('');
      },
    });
  };

  /* The confirm closes at once; the token's row shows the revoke in flight. */
  const handleDelete = () => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    setDeleteTarget(null);
    revoke.run(() => deleteApiToken(id), { key: id });
  };

  const headerAdd = (
    <IconButton icon={Plus} kindIcon={KeyRound} label="Create API token" variant="primary" onClick={openAdd} />
  );

  return (
    <Card
      title="API tokens"
      icon={<KeyRound size={14} />}
      help={HELP}
      commands={[create, revoke]}
      errorPrefix={(key, command) => (command === create ? "Couldn't create the token" : `Couldn't revoke ${tokens?.find((t) => t.id === key)?.label ?? 'the token'}`)}
      actions={headerAdd}
    >
      <div className="space-y-4">
        {minted && (
          <div className="rounded-md border border-accent/30 bg-accent-soft px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-text-primary">
                Token “{minted.label}” created — copy it now, it won’t be shown again.
              </p>
              <IconButton icon={X} label="Dismiss" size="sm" onClick={() => setMinted(null)} />
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={minted.token}
                readOnly
                onFocus={(e) => e.target.select()}
                className="input-field font-mono text-xs text-text-secondary"
              />
              <CopyButton text={minted.token} label="Copy token" variant="field" className="self-stretch" />
            </div>
          </div>
        )}

        {tokens != null && <RecordError record={tokensRecord} what="API tokens" className="mb-2" />}
        {tokens == null ? (
          <RecordGate record={tokensRecord} what="API tokens">{() => null}</RecordGate>
        ) : (
          <DataTableScroll>
            <DataTable>
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
                        ref={autoFocusField}
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
                        <IconButton icon={Check} label="Create token" variant="primary" size="sm" busy={creating} disabled={!newLabel.trim()} onClick={handleCreate} />
                        <IconButton icon={X} label="Cancel" variant="neutral" size="sm" disabled={creating} onClick={cancelAdd} />
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
                          <IconButton icon={Trash2} label="Revoke token" variant="neutral-danger" size="sm" busy={revoke.isBusy(t.id)} onClick={() => setDeleteTarget(t)} />
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
        confirmLabel="Revoke"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      >
        Revoke “{deleteTarget?.label}”? Clients using it will stop working immediately.
      </ConfirmDialog>
    </Card>
  );
}
