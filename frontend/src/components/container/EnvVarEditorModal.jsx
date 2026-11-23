import { useState } from 'react';
import { Check, Copy, Dices } from 'lucide-react';

import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import { FormCheckbox, FormField } from '../shared/FormModalChrome.jsx';
import { autoFocusField } from '../../lib/focus.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import FormModal from '../shared/FormModal.jsx';
import { NOTHING_CHANGED } from '../../hooks/editorValues.js';
import IconButton from '../shared/IconButton.jsx';


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
 * none of `otherKeys` (the container's other variables) has, and for a new secret
 * (`creating`) a value — it has nothing on file to fall back on.
 */
function envProblems(form, otherKeys, creating) {
  const problems = {};
  const key = form.key.trim();
  if (key === '') problems.key = 'A key is required.';
  else if (otherKeys.includes(key)) {
    problems.key = `A variable named ${key} already exists.`;
  }
  if (creating && form.secret && form.value.trim() === '') problems.value = 'A new secret needs a value.';
  return problems;
}

function EnvVarEditor({ env, rowKey: openedKey, onSubmit, onClose }) {
  /* The variable and the other variables' keys, as the editor opened. */
  const [opened] = useState(() => {
    const rows = rowsFromEnv(env);
    return { row: rows.find((r) => r.key === openedKey) ?? null, otherKeys: rows.map((r) => r.key).filter((k) => k !== openedKey) };
  });
  const isEdit = openedKey != null;
  const rowKey = openedKey;
  const { form, dirty, setForm } = useEditor(() => formFromRow(isEdit ? opened.row : null));
  const row = form.stored ?? null;
  const save = useCommand();
  const saving = save.busy;
  const problems = envProblems(form, opened.otherKeys, !isEdit);
  const blocked = Object.values(problems)[0] ?? null;
  /* The generate-secret confirm, `{ value, replacing }`. */
  const [pendingGenerate, setPendingGenerate] = useState(null);
  const [genCopied, setGenCopied] = useState(false);

  const trimmedKey = form.key.trim();
  const canSave = !blocked && (!isEdit || dirty) && !saving;

  /* Renaming a secret re-creates it under the new key: the old key is removed
   * and the new one is written with whatever the value field holds. */
  const renamingStoredSecret = isEdit && !!form.secret && !!row?.isSet && trimmedKey !== rowKey;

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
    save.run(() => onSubmit({ envPatch: envPatch(envSent(form, row), row) })).then((ok) => { if (ok) onClose(); });
  };

  /* An empty key says nothing under the field (Save says why it is off). */
  const keyHint = trimmedKey !== '' && problems.key
    ? problems.key
    : renamingStoredSecret
      ? 'Renaming a secret stores it under the new key with the value below.'
      : null;

  const valueHint = form.secret
    ? isEdit && row?.isSet
      ? 'Leave empty to keep the stored secret. Secrets are never read back, only overwritten.'
      : 'Stored hidden — it can only be overwritten later, never read back.'
    : null;

  return (
    <>
      <FormModal
        title={isEdit ? 'Edit variable' : 'Add variable'}
        subtitle={isEdit ? rowKey : 'Container environment variable'}
        size="md"
        save={save}
        blocked={blocked ?? (isEdit && !dirty ? NOTHING_CHANGED : null)}
        onSubmit={handleSave}
        onClose={onClose}
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
              <IconButton variant="field" icon={Dices} label="Generate random value" onClick={requestGenerate} />
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
      </FormModal>

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
            <IconButton variant="field" icon={genCopied ? Check : Copy} label="Copy new secret" onClick={copyGenerated} />
          </div>
        </div>
      </ConfirmDialog>
    </>
  );
}
