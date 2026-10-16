import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import {
  FormField,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { putMountFileContent } from '../../api/containers.js';
import { formatSize } from '../../utils/formatters.js';

const FORM_ID = 'secret-mount-content-form';

/**
 * Write-only editor for a secret file mount (see docs/UI-PATTERNS.md — the
 * secret env var model): the stored content is never fetched, only replaced
 * with pasted text or cleared (emptied). `mount` carries the masked metadata
 * from the container detail (`isSet`, `sizeBytes`). Writes go through the same
 * PUT content route as the plain-text editor; `onSaved` refreshes the parent.
 */
export default function SecretMountContentModal({ open, containerName, mount, onSaved, onClose }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText('');
    setError(null);
    setConfirmClear(false);
  }, [open, mount?.name]);

  const writeContent = async (content) => {
    setSaving(true);
    setError(null);
    try {
      await putMountFileContent(containerName, mount.name, content);
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const isSet = !!mount?.isSet;
  const canSave = text !== '' && !saving;
  const status = isSet
    ? `Set${Number.isFinite(mount?.sizeBytes) ? ` · ${formatSize(mount.sizeBytes)}` : ''} — the current content is never shown.`
    : 'Not set — the file is empty.';

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="Replace secret file"
        subtitle={mount ? `${mount.name} · ${containerName}` : containerName}
        size="md"
        height="cap"
        closeOnBackdrop={!saving && !confirmClear}
        /* A nested confirm is the top layer — Escape must close only it. */
        closeOnEscape={!saving && !confirmClear}
        footer={(
          <>
            {isSet && (
              <div className="mr-auto">
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  disabled={saving}
                  className={`${formModalNeutralBtn} hover:text-status-stopped hover:bg-status-stopped-soft`}
                >
                  Clear
                </button>
              </div>
            )}
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
          onSubmit={(e) => { e.preventDefault(); if (canSave) writeContent(text); }}
          className="space-y-3"
        >
          <p className="rounded-md border border-surface-border bg-surface px-3 py-2 text-xs text-text-secondary">
            {status}
          </p>
          <FormField
            label="New content"
            htmlFor="secret-mount-content"
            hint="Saving replaces the whole file. To upload a file instead, use the row's Upload action."
          >
            <textarea
              id="secret-mount-content"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste the new content"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              rows={8}
              className="input-field min-h-32 w-full resize-y font-mono text-xs leading-relaxed"
            />
          </FormField>
          <FormModalError error={error} />
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmClear}
        title="Clear secret file?"
        confirmLabel="Clear"
        onConfirm={() => { setConfirmClear(false); writeContent(''); }}
        onCancel={() => setConfirmClear(false)}
      >
        <p>
          This empties <span className="font-mono text-text-primary">{mount?.name}</span>. The old content
          cannot be recovered — the container sees an empty file until new content is saved.
        </p>
      </ConfirmDialog>
    </>
  );
}
