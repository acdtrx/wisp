import { useState } from 'react';
import { Check, Copy, Dices, Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import {
  EditorGone,
  FormCheckbox,
  FormField,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { autoFocusField } from '../../lib/focus.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useForm, useHeld } from '../../hooks/useForm.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';

const FORM_ID = 'env-var-editor-form';

const sideBtn =
  'flex h-[34px] shrink-0 items-center justify-center rounded-md border border-surface-border bg-surface px-2.5 text-text-secondary hover:bg-surface-sidebar transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

// 32 random bytes as hex (same shape as `openssl rand -hex 32`) — hex keeps the
// value safe for apps with naive env parsing. `getRandomValues` works in
// non-secure (HTTP) contexts, unlike `crypto.randomUUID`.
function generateSecretValue() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A container's environment as rows: a secret's value is never sent to the client —
 *  `isSet` says whether one is stored. */
export function rowsFromEnv(env) {
  if (!env || typeof env !== 'object') return [];
  return Object.entries(env).map(([key, entry]) => {
    const secret = !!entry?.secret;
    return {
      key,
      secret,
      isSet: secret ? !!entry?.isSet : false,
      value: secret ? '' : String(entry?.value ?? ''),
    };
  });
}

/** The form of a variable (none: a new one). `stored` is the variable as the form took
 *  it (what Save writes against), carried with the values so that a save under way, or
 *  a record moved on meanwhile, still reads the variable it opened on; it is never sent. */
function formFromRow(row) {
  if (!row) return { key: '', value: '', secret: false, valueTouched: false, stored: null };
  return {
    stored: { key: row.key, secret: row.secret, isSet: row.isSet, value: row.value },
    key: row.key,
    /* Secrets are never read back — empty means "keep what's on file". */
    value: row.secret ? '' : row.value,
    secret: row.secret,
    valueTouched: false,
  };
}

/**
 * What Save writes for the values, against the variable as stored (`row`, null for a
 * new one): the key trimmed, and the value — null to keep a stored secret: a secret's
 * field untouched, or emptied again over one on file, never sends '' and wipes it.
 */
function envSent(form, row) {
  const keep = form.secret && (!form.valueTouched || (!!row?.secret && row.isSet && form.value === ''));
  return { key: form.key.trim(), secret: form.secret, value: keep ? null : form.value };
}

/**
 * The `envPatch` map the container PATCH takes for what Save writes (see
 * docs/FRONTEND-RULES.md — **Container environment**, the documented whole-`env`
 * exception): a delta for an unchanged key, remove-plus-upsert for a rename, a full
 * entry for a new variable.
 */
function envPatch(sent, row) {
  const entry = sent.secret ? { value: sent.value ?? '', secret: true } : { value: sent.value };
  if (!row) return { [sent.key]: entry };
  if (sent.key !== row.key) return { [row.key]: null, [sent.key]: entry };
  const delta = {};
  if (sent.secret !== row.secret) delta.secret = sent.secret;
  if (sent.secret ? sent.value !== null : sent.value !== row.value) delta.value = sent.value;
  return Object.keys(delta).length > 0 ? { [sent.key]: delta } : {};
}

/**
 * Modal form editor for one container environment variable — create when `rowKey`
 * is null, edit the variable of that key otherwise (see docs/FRONTEND-RULES.md §
 * Modal form editor). Its record is the container's config; it hands the `envPatch`
 * to `onSubmit`, which owns the API call.
 */
export default function EnvVarEditorModal(props) {
  return props.open ? <EnvVarEditor {...props} /> : null;
}

/**
 * What an env editor's values lack to be saved, by the field each is about: a key, one
 * no other variable of the record as the form took it (`taken`) has, and for a new
 * secret (`creating`) a value — it has nothing on file to fall back on.
 */
function envProblems(form, taken, rowKey, creating) {
  const problems = {};
  const key = form.key.trim();
  if (key === '') problems.key = 'A key is required.';
  else if (rowsFromEnv(taken?.env).some((r) => r.key !== rowKey && r.key === key)) {
    problems.key = `A variable named ${key} already exists.`;
  }
  if (creating && form.secret && form.value.trim() === '') problems.value = 'A new secret needs a value.';
  return problems;
}

function EnvVarEditor({ open, containerName, rowKey: openedKey, onSubmit, onClose }) {
  const record = useRecord(RECORD.CONTAINER, containerName);
  const isEdit = openedKey != null;
  /* The variable's key: the one it opened on, then the one its own save sent (from the
   * command's ack on, whatever the re-read does). */
  const [rowKey, setRowKey] = useState(openedKey);
  const [blank] = useState(() => formFromRow(null));
  const { form, generation, setForm, dirty, saving, problems, blocked, save: saveForm } = useForm(
    record,
    (config) => {
      if (!isEdit) return blank;
      const stored = rowsFromEnv(config.env).find((r) => r.key === rowKey);
      return stored ? formFromRow(stored) : null;
    },
    (f) => envSent(f, f.stored),
    { problems: (values, data, taken) => envProblems(values, taken, rowKey, !isEdit), creating: !isEdit },
  );
  /* The variable as the form took it. */
  const row = form?.stored ?? null;
  const save = useCommand();
  /* The generate-secret confirm, `{ value, replacing }`: held on the form as it is, a
   * reset drops it. */
  const [pendingGenerate, setPendingGenerate] = useHeld(generation);
  const [genCopied, setGenCopied] = useState(false);

  const trimmedKey = form?.key.trim() ?? '';
  const canSave = form != null && !blocked && (!isEdit || dirty) && !saving;

  /* Renaming a secret re-creates it under the new key: the old key is removed
   * and the new one is written with whatever the value field holds. */
  const renamingStoredSecret = isEdit && !!form?.secret && !!row?.isSet && trimmedKey !== rowKey;

  const requestGenerate = () => {
    setGenCopied(false);
    setPendingGenerate({
      value: generateSecretValue(),
      replacing: (isEdit && !!row?.isSet) || form.valueTouched || form.value.trim() !== '',
    });
  };

  // Apply fills the field; the modal's Save stays the single commit affordance
  // (nothing is persisted until the user saves).
  const applyGenerate = () => {
    if (!pendingGenerate) return;
    setForm((f) => ({ ...f, value: pendingGenerate.value, valueTouched: true }));
    setPendingGenerate(null);
  };

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

  const handleSave = () => {
    if (!canSave) return;
    saveForm(async (sent) => {
      const ok = await save.run(() => onSubmit({ envPatch: envPatch(sent, row) }));
      if (ok && isEdit) setRowKey(sent.key);
      return ok;
    }).then((ok) => { if (ok) onClose(); });
  };

  /* An empty key says nothing under the field (Save says why it is off). */
  const keyHint = trimmedKey !== '' && problems.key
    ? problems.key
    : renamingStoredSecret
      ? 'Renaming a secret stores it under the new key with the value below.'
      : null;

  const valueHint = form?.secret
    ? isEdit && row?.isSet
      ? 'Leave empty to keep the stored secret. Secrets are never read back, only overwritten.'
      : 'Stored hidden — it can only be overwritten later, never read back.'
    : null;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={isEdit ? 'Edit variable' : 'Add variable'}
        subtitle={isEdit ? rowKey : 'Container environment variable'}
        size="md"
        height="cap"
        /* A nested confirm is the top layer — Escape must close only it. */
        closeOnEscape={!saving}
        footer={(
          <>
            <button type="button" onClick={onClose} disabled={saving} className={formModalNeutralBtn}>
              Cancel
            </button>
            <button type="submit" form={FORM_ID} disabled={!canSave} title={blocked ?? undefined} className={formModalPrimaryBtn}>
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
              Save
            </button>
          </>
        )}
      >
        {form == null ? <EditorGone what="variable" /> : (
        <form
          id={FORM_ID}
          onSubmit={(e) => { e.preventDefault(); handleSave(); }}
          className="space-y-3"
        >
          <FormField label="Key" htmlFor="env-editor-key" hint={keyHint}>
            <input
              id="env-editor-key"
              type="text"
              value={form.key}
              onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))}
              placeholder="KEY"
              ref={!isEdit ? autoFocusField : undefined}
              autoComplete="off"
              spellCheck={false}
              className="input-field font-mono"
            />
          </FormField>
          <FormField label="Value" htmlFor="env-editor-value" hint={valueHint}>
            <div className="flex items-center gap-2">
              <input
                id="env-editor-value"
                type={form.secret ? 'password' : 'text'}
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value, valueTouched: true }))}
                placeholder={form.secret && isEdit && row?.isSet ? 'Enter new value to replace' : 'value'}
                autoComplete={form.secret ? 'new-password' : 'off'}
                spellCheck={false}
                className="input-field min-w-0 flex-1 font-mono"
              />
              {form.secret && (
                <button
                  type="button"
                  onClick={requestGenerate}
                  className={sideBtn}
                  title="Generate random value"
                  aria-label="Generate random value"
                >
                  <Dices size={14} aria-hidden />
                </button>
              )}
            </div>
          </FormField>
          <FormCheckbox
            label="Secret"
            hint={isEdit && row?.secret
              ? 'Unchecking clears the stored value — enter a new one above.'
              : 'Hidden from the UI after saving — the value can be overwritten but never read back.'}
            checked={form.secret}
            onChange={(e) => setForm((f) => ({ ...f, secret: e.target.checked }))}
          />
          <ErrorBanner className="mt-3" error={save.error} onDismiss={save.dismiss} />
        </form>
        )}
      </Modal>

      <ConfirmDialog
        open={!!pendingGenerate}
        title="Generate new secret?"
        confirmLabel="Apply"
        variant={pendingGenerate?.replacing ? 'danger' : 'primary'}
        onConfirm={applyGenerate}
        onCancel={() => setPendingGenerate(null)}
      >
        {pendingGenerate?.replacing ? (
          <p>
            This replaces the value of <span className="font-mono text-text-primary">{trimmedKey || 'this variable'}</span> when
            you save. The old value cannot be recovered — make sure nothing still depends on it.
          </p>
        ) : (
          <p>
            A random value was generated for <span className="font-mono text-text-primary">{trimmedKey || 'this variable'}</span>.
            It will be stored when you save.
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
              className="input-field min-w-0 flex-1 font-mono text-xs text-text-secondary"
            />
            <button
              type="button"
              onClick={copyGenerated}
              title="Copy new secret"
              aria-label="Copy new secret"
              className={sideBtn}
            >
              {genCopied ? <Check size={14} className="text-status-running" aria-hidden /> : <Copy size={14} aria-hidden />}
            </button>
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}
