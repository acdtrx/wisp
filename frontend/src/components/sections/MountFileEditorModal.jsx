import { useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '../shared/Modal.jsx';
import { putMountFileContent } from '../../api/containers.js';
import { useCommand } from '../../hooks/useCommand.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { useForm } from '../../hooks/useForm.js';
import RecordGate from '../shared/RecordGate.jsx';
import RecordError from '../shared/RecordError.jsx';

const contentText = (data) => (typeof data?.content === 'string' ? data.content : '');

/** The editor of a plain mount file's content; it mounts when it opens, so each opening
 *  starts from the file as read. */
export default function MountFileEditorModal(props) {
  return props.open ? <MountFileEditor {...props} /> : null;
}

function MountFileEditor({
  open,
  containerName,
  mountName,
  onClose,
}) {
  /* The file's content is read while the editor is open; the text follows it until edited. */
  const content = useRecord(RECORD.MOUNT_FILE_CONTENT, containerName && mountName ? [containerName, mountName] : null);
  const { form: text, setForm, dirty, saving, save: saveForm } = useForm(content, contentText);
  const setText = (value) => setForm(() => value);
  /* Save only a change, over the file as read: not while it loads, after a failed read,
   * or once the mount (or its container) is gone. */
  const canSave = content.data != null && dirty;
  const save = useCommand();

  const handleClose = useCallback(() => {
    if (saving) return;
    onClose();
  }, [onClose, saving]);

  const handleSave = () => {
    if (!containerName || !mountName) return;
    saveForm((value) => save.run(() => putMountFileContent(containerName, mountName, value)))
      .then((ok) => { if (ok) onClose(); });
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Edit mount file — ${mountName}`}
      size="3xl"
      height="tall"
      bodyPadding="none"
      closeOnEscape={!saving}
      footer={
        <>
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !canSave}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin inline" /> : 'Save'}
          </button>
        </>
      }
    >
      <div className="flex h-full flex-col p-4">
        {content.data != null && <RecordError record={content} what="file" className="mb-2" />}
        <RecordGate
          record={content}
          what="file"
          loading={(
            <div className="flex flex-1 items-center justify-center py-12">
              <Loader2 size={20} className="animate-spin text-text-muted" />
            </div>
          )}
          gone={(
            <p className="text-xs text-text-muted">
              The mount <span className="font-mono">{mountName}</span> is gone: it was removed, or its container was.
            </p>
          )}
        >
          {() => (
            <textarea
              value={text ?? ''}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              className="input-field flex-1 min-h-48 w-full resize-y font-mono text-xs leading-relaxed text-text-primary"
            />
          )}
        </RecordGate>
        <ErrorBanner className="mt-2" error={save.error} onDismiss={save.dismiss} />
      </div>
    </Modal>
  );
}
