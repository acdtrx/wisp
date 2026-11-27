import { useState } from 'react';
import { KeyRound, Plus, X, Trash2 } from 'lucide-react';

import Card from '../shared/Card.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import FormModal from '../shared/FormModal.jsx';
import { FormField } from '../shared/FormModalChrome.jsx';
import RadioPills from '../shared/RadioPills.jsx';
import { DataTableScroll, DataTable, DataTableTh, DataTableTd, DataTableRowActions, dataTableHeadRowClass, dataTableBodyRowClass, dataTableEmptyCellClass } from '../shared/DataTableChrome.jsx';
import { createApiToken, deleteApiToken } from '../../api/authTokens.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import RecordGate from '../shared/RecordGate.jsx';
import RecordError from '../shared/RecordError.jsx';
import IconButton from '../shared/IconButton.jsx';
import CopyButton from '../shared/CopyButton.jsx';
import { cliInstallBase } from '../host/settingsForms.js';

const HELP =
  'Bearer tokens for non-interactive clients (coding agents, scripts). Read-only tokens see everything ' +
  'and change nothing; agent tokens also build, run and update containers, and start and stop VMs; admin ' +
  'tokens can do everything a token can. Tokens cannot open consoles, change the password, change SSO ' +
  'settings, or manage other tokens. The token value is shown once at creation — only a hash is stored.';

const LABEL_MAX = 64;

/* The three scopes, in their order, each with what it allows (docs/specs/AUTH.md, Scopes). */
const SCOPES = [
  { value: 'read', label: 'Read-only', detail: 'See everything, change nothing.' },
  { value: 'agent', label: 'Agent', detail: 'Build, run and update containers, start and stop VMs; no deletes, no VM or host changes.' },
  { value: 'admin', label: 'Admin', detail: 'Everything a token can do.' },
];

const SCOPE_BADGE = {
  read: { text: 'read-only', className: 'border border-surface-border bg-surface text-text-muted' },
  agent: { text: 'agent', className: 'bg-accent-soft text-accent-text' },
  admin: { text: 'admin', className: 'bg-status-warning-soft text-status-warning' },
};

/** The lines that install the `wisp` CLI from this Wisp, each with a copy action (docs/specs/UI-HOST.md). */
function CliInstall({ base }) {
  const lines = [
    { label: 'macOS and Linux', command: `curl -fsSL ${base}/api/cli/install.sh | sh` },
    { label: 'Windows (PowerShell)', command: `irm ${base}/api/cli/install.ps1 | iex` },
  ];
  return (
    <div className="space-y-2 border-t border-surface-border pt-3">
      <p className="text-xs text-text-secondary">
        Install the <span className="font-mono">wisp</span> CLI from this Wisp, then sign in with a token:{' '}
        <span className="font-mono">wisp login {base}</span>
      </p>
      {lines.map(({ label, command }) => (
        <div key={label}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</p>
          <span className="flex items-start gap-1">
            <code className="min-w-0 select-all break-all font-mono text-[13px] text-text-primary">{command}</code>
            <CopyButton text={command} label={`Copy the ${label} install line`} />
          </span>
        </div>
      ))}
    </div>
  );
}

function formatCreated(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

export default function ApiTokensSettings() {
  /* The tokens, read again on a create or revoke from any tab. */
  const tokensRecord = useRecord(RECORD.TOKENS);
  const tokens = tokensRecord.data;
  /* The advertised URL, for the install line's address. */
  const settings = useRecord(RECORD.SETTINGS).data;
  /* Each token's revoke, keyed by its id, with its error in the card. */
  const revoke = useCommand();
  const [creating, setCreating] = useState(false);
  // { label, token } — shown once after a successful create, until dismissed.
  const [minted, setMinted] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  /* The confirm closes at once; the token's row shows the revoke in flight. */
  const handleDelete = () => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    setDeleteTarget(null);
    revoke.run(() => deleteApiToken(id), { key: id });
  };

  const headerAdd = (
    <IconButton icon={Plus} kindIcon={KeyRound} label="Create API token" variant="primary" onClick={() => setCreating(true)} />
  );

  return (
    <Card
      title="API tokens"
      icon={<KeyRound size={14} />}
      help={HELP}
      commands={[revoke]}
      errorPrefix={(key) => `Couldn't revoke ${tokens?.find((t) => t.id === key)?.label ?? 'the token'}`}
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
                {tokens.length === 0 ? (
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
                        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SCOPE_BADGE[t.scope].className}`}>
                          {SCOPE_BADGE[t.scope].text}
                        </span>
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

        {settings != null && <CliInstall base={cliInstallBase(settings.advertisedUrl, window.location.origin)} />}
      </div>

      {creating && (
        <CreateTokenForm
          onCreated={(created) => setMinted({ label: created.label, token: created.token })}
          onClose={() => setCreating(false)}
        />
      )}

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

/** A new token: its label and its scope, Agent chosen. The secret is shown once, from the 201; the list row arrives with the cue. */
function CreateTokenForm({ onCreated, onClose }) {
  const { form, setField } = useEditor({ label: '', scope: 'agent' });
  const save = useCommand();
  const blocked = !form.label.trim() ? 'Give the token a label.' : null;
  return (
    <FormModal
      title="Create an API token"
      saveLabel="Create"
      save={save}
      blocked={blocked}
      onClose={onClose}
      size="md"
      onSubmit={() => save.run(() => createApiToken({ label: form.label.trim(), scope: form.scope }), { onDone: onCreated })
        .then((ok) => { if (ok) onClose(); })}
    >
      <FormField label="Label" htmlFor="api-token-label" hint="Who uses it, e.g. the agent or the script.">
        <input
          id="api-token-label"
          ref={autoFocusField}
          type="text"
          value={form.label}
          maxLength={LABEL_MAX}
          onChange={(e) => setField('label', e.target.value)}
          placeholder="claude-code"
          autoComplete="off"
          className="input-field placeholder:text-text-muted"
        />
      </FormField>
      <div>
        <p className="mb-1 block text-xs font-medium text-text-secondary">Scope</p>
        <RadioPills
          variant="card"
          className="grid-cols-1"
          label="Scope"
          options={SCOPES}
          value={form.scope}
          onChange={(scope) => setField('scope', scope)}
        />
      </div>
    </FormModal>
  );
}
