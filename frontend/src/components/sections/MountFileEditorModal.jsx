import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import Modal from '../shared/Modal.jsx';
import { getMountFileContent, putMountFileContent } from '../../api/containers.js';

export default function MountFileEditorModal({
  open,
  containerName,
  mountName,
  onClose,
  onSaved,
}) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [saveError, setSaveError] = useState(null);

  const handleClose = useCallback(() => {
    if (saving) return;
    onClose();
  }, [onClose, saving]);

  useEffect(() => {
    if (!open || !containerName || !mountName) return;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setText('');
    getMountFileContent(containerName, mountName)
      .then((data) => {
        setText(typeof data?.content === 'string' ? data.content : '');
      })
      .catch((err) => {
        setLoadError(err.message || 'Failed to load file');
      })
      .finally(() => setLoading(false));
  }, [open, containerName, mountName]);

  const handleSave = async () => {
    if (!containerName || !mountName) return;
    setSaving(true);
    setSaveError(null);
    try {
      await putMountFileContent(containerName, mountName, text);
      if (typeof onSaved === 'function') await onSaved();
      onClose();
    } catch (err) {
      setSaveError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={`Edit mount file — ${mountName}`}
      size="3xl"
      height="tall"
      bodyPadding="none"
      closeOnBackdrop={!saving}
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
            disabled={saving || loading || !!loadError}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin inline" /> : 'Save'}
          </button>
        </>
      }
    >
      <div className="flex h-full flex-col p-4">
        {loadError && (
          <p className="mb-2 text-xs text-status-stopped">{loadError}</p>
        )}
        {loading ? (
          <div className="flex flex-1 items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-text-muted" />
          </div>
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className="input-field flex-1 min-h-[12rem] w-full resize-y font-mono text-xs leading-relaxed text-text-primary"
            disabled={!!loadError}
          />
        )}
        {saveError && (
          <p className="mt-2 text-xs text-status-stopped">{saveError}</p>
        )}
      </div>
    </Modal>
  );
}
