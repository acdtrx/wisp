import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import {
  FormField,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { putMountFileContent } from '../../api/containers.js';
import { formatSize } from '../../utils/formatters.js';
import { autoFocusField } from '../../lib/focus.js';
import CommandErrors from '../shared/CommandErrors.jsx';
import { useCommand } from '../../hooks/useCommand.js';

const FORM_ID = 'secret-mount-content-form';

/**
 * Write-only editor for a secret file mount (see docs/FRONTEND-RULES.md — the
 * secret env var model): the stored content is never fetched, only replaced
 * with pasted text or cleared (emptied). `mount` carries the masked metadata
 * from the container detail (`isSet`, `sizeBytes`). Writes go through the same
 * PUT content route as the plain-text editor, and end at its answer.
 */
export default function SecretMountContentModal(props) {
  return props.open ? <SecretMountContentEditor {...props} /> : null;
}

function SecretMountContentEditor({ open, containerName, mount, onClose }) {
  /* Write-only: the stored content is never read, so the text is an input to the
   * replace command, its own state, starting empty. */
  const [text, setText] = useState('');
  const save = useCommand();
  const [confirmClear, setConfirmClear] = useState(false);

  /* Replace and clear: two commands of the one content write (one at a time: both
   * controls are disabled while either runs). */
  const writeContent = (content, key) => save.run(
    () => putMountFileContent(containerName, mount.name, content),
    { key, onDone: onClose },
  );

  const isSet = !!mount?.isSet;
  const canSave = text !== '' && !save.busy;
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
        /* A nested confirm is the top layer — Escape must close only it. */
        closeOnEscape={!save.busy}
        footer={(
          <>
            {isSet && (
              <div className="mr-auto">
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  disabled={save.busy}
                  className={`${formModalNeutralBtn} hover:text-status-stopped hover:bg-status-stopped-soft`}
                >
                  Clear
                </button>
              </div>
            )}
            <button type="button" onClick={onClose} disabled={save.busy} className={formModalNeutralBtn}>
              Cancel
            </button>
            <button type="submit" form={FORM_ID} disabled={!canSave} className={formModalPrimaryBtn}>
              {save.busy && <Loader2 size={14} className="animate-spin" aria-hidden />}
              Save
            </button>
          </>
        )}
      >
        <form
          id={FORM_ID}
          onSubmit={(e) => { e.preventDefault(); if (canSave) writeContent(text, 'replace'); }}
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
              ref={autoFocusField}
              autoComplete="off"
              spellCheck={false}
              rows={8}
              className="input-field min-h-32 w-full resize-y font-mono text-xs leading-relaxed"
            />
          </FormField>
          <CommandErrors className="mt-3" commands={[save]} prefix={(key) => (key === 'clear' ? "Couldn't clear the secret" : undefined)} />
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmClear}
        title="Clear secret file?"
        confirmLabel="Clear"
        onConfirm={() => { setConfirmClear(false); writeContent('', 'clear'); }}
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
