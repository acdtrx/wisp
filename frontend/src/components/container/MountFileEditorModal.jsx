import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { putMountFileContent } from '../../api/containers.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { useRecord } from '../../hooks/useRecord.js';
import { RECORD } from '../../store/records.js';
import FormModal from '../shared/FormModal.jsx';
import Modal from '../shared/Modal.jsx';
import RecordGate from '../shared/RecordGate.jsx';
import { NOTHING_CHANGED } from '../../hooks/editorValues.js';

const contentText = (data) => (typeof data?.content === 'string' ? data.content : '');

/** The editor of a plain mount file's content; it mounts when it opens, so each opening
 *  reads the file afresh. */
export default function MountFileEditorModal(props) {
  return props.open ? <MountFileEditor {...props} /> : null;
}

/**
 * The file is read when the editor opens; once read, the editor holds its text as read
 * (a snapshot, like every editor) and Save, which needs a change, writes it whole.
 */
function MountFileEditor({ containerName, mountName, onClose }) {
  const content = useRecord(RECORD.MOUNT_FILE_CONTENT, containerName && mountName ? [containerName, mountName] : null);
  const title = `Edit mount file — ${mountName}`;
  /* The text as first read: later reads (the file changed, or the mount went) change nothing here. */
  const [read, setRead] = useState(null);
  if (read == null && content.data != null) setRead(contentText(content.data));
  if (read != null) {
    return <FileTextEditor title={title} text={read} containerName={containerName} mountName={mountName} onClose={onClose} />;
  }
  /* Until the read answers, or when it failed or the mount is gone. */
  return (
    <Modal open onClose={onClose} title={title} size="3xl">
      <RecordGate
        record={content}
        what="file"
        loading={(
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-text-muted" aria-hidden />
          </div>
        )}
        gone={(
          <p className="text-xs text-text-muted">
            The mount <span className="font-mono">{mountName}</span> is gone: it was removed, or its container was.
          </p>
        )}
      >
        {() => null}
      </RecordGate>
    </Modal>
  );
}

function FileTextEditor({ title, text, containerName, mountName, onClose }) {
  const { form, setForm, dirty } = useEditor({ text });
  const save = useCommand();
  return (
    <FormModal
      title={title}
      save={save}
      size="3xl"
      blocked={dirty ? null : NOTHING_CHANGED}
      onClose={onClose}
      onSubmit={() => save.run(() => putMountFileContent(containerName, mountName, form.text)).then((ok) => { if (ok) onClose(); })}
    >
      <textarea
        value={form.text}
        onChange={(e) => setForm({ text: e.target.value })}
        spellCheck={false}
        aria-label={`The content of ${mountName}`}
        className="input-field min-h-[50vh] w-full resize-y font-mono text-xs leading-relaxed text-text-primary"
      />
    </FormModal>
  );
}
