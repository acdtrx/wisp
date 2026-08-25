import { useEffect, useState } from 'react';
import { Check, Copy, Dices, Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import {
  FormCheckbox,
  FormField,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';

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

function formFromRow(row) {
  if (!row) return { key: '', value: '', secret: false, valueTouched: false };
  return {
    key: row.key,
    /* Secrets are never read back — empty means "keep what's on file". */
    value: row.secret ? '' : row.value,
    secret: row.secret,
    valueTouched: false,
  };
}

/**
 * One entry of the `envPatch` map the container PATCH takes (see
 * docs/UI-PATTERNS.md — **Container environment**, the documented whole-`env`
 * exception). Same shapes the inline row editor produced: a delta for an
 * unchanged key, remove-plus-upsert for a rename, a full entry for a new var.
 */
function buildEnvPatch(form, row) {
  const key = form.key.trim();
  const entry = form.secret ? { value: form.value, secret: true } : { value: form.value };

  if (!row) return { [key]: entry };
  if (key !== row.key) return { [row.key]: null, [key]: entry };

  const delta = {};
  if (form.secret !== row.secret) delta.secret = form.secret;
  if (form.secret ? form.valueTouched : form.value !== row.value) delta.value = form.value;
  return Object.keys(delta).length > 0 ? { [key]: delta } : {};
}

/**
 * Modal form editor for one container environment variable — create when `row`
 * is null, edit otherwise (see docs/UI-PATTERNS.md § Modal form editor). Builds
 * the `envPatch` and hands it to `onSubmit`, which owns the API call and the
 * parent refresh; the modal stays open on failure.
 */
export default function EnvVarEditorModal({ open, row, existingKeys = [], onSubmit, onClose }) {
  const [form, setForm] = useState(() => formFromRow(null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [pendingGenerate, setPendingGenerate] = useState(null); // { value, replacing }
  const [genCopied, setGenCopied] = useState(false);

  const isEdit = row != null;

  useEffect(() => {
    if (!open) return;
    setForm(formFromRow(row));
    setError(null);
    setPendingGenerate(null);
    setGenCopied(false);
  }, [open, row]);

  const trimmedKey = form.key.trim();
  const duplicate = trimmedKey !== '' && existingKeys.some((k) => k !== row?.key && k === trimmedKey);
  /* A brand-new secret has nothing on file to fall back on. */
  const secretNeedsValue = form.secret && !isEdit && form.value.trim() === '';
  const patch = buildEnvPatch(form, row);
  const canSave =
    trimmedKey !== ''
    && !duplicate
    && !secretNeedsValue
    && Object.keys(patch).length > 0
    && !saving;

  /* Renaming a secret re-creates it under the new key: the old key is removed
   * and the new one is written with whatever the value field holds. */
  const renamingStoredSecret = isEdit && form.secret && row.isSet && trimmedKey !== row.key;

  const requestGenerate = () => {
    setGenCopied(false);
    setPendingGenerate({
      value: generateSecretValue(),
      replacing: (isEdit && row.isSet) || form.valueTouched || form.value.trim() !== '',
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

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ envPatch: patch });
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const keyHint = duplicate
    ? `A variable named ${trimmedKey} already exists.`
    : renamingStoredSecret
      ? 'Renaming a secret stores it under the new key with the value below.'
      : null;

  const valueHint = form.secret
    ? isEdit && row.isSet
      ? 'Leave empty to keep the stored secret. Secrets are never read back, only overwritten.'
      : 'Stored hidden — it can only be overwritten later, never read back.'
    : null;

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={isEdit ? 'Edit variable' : 'Add variable'}
        subtitle={isEdit ? row.key : 'Container environment variable'}
        size="md"
        height="cap"
        closeOnBackdrop={!saving && !pendingGenerate}
        /* A nested confirm is the top layer — Escape must close only it. */
        closeOnEscape={!saving && !pendingGenerate}
        footer={(
          <>
            <button type="button" onClick={onClose} disabled={saving} className={formModalNeutralBtn}>
              Cancel
            </button>
            <button type="submit" form={FORM_ID} disabled={!canSave} className={formModalPrimaryBtn}>
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
              Save
            </button>
          </>
        )}
      >
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
              autoFocus={!isEdit}
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
                placeholder={form.secret && isEdit && row.isSet ? 'Enter new value to replace' : 'value'}
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
            hint={isEdit && row.secret
              ? 'Unchecking clears the stored value — enter a new one above.'
              : 'Hidden from the UI after saving — the value can be overwritten but never read back.'}
            checked={form.secret}
            onChange={(e) => setForm((f) => ({ ...f, secret: e.target.checked }))}
          />
          <FormModalError error={error} />
        </form>
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
