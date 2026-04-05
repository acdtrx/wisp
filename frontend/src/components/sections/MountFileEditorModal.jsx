import { useState, useEffect, useCallback } from 'react';
import { Loader2, X } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
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

  useEscapeKey(open, handleClose);

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

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={handleClose} />
      <div className="relative z-10 flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-card bg-surface-card shadow-lg" data-wisp-modal-root>
        <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">
            Edit mount file — {mountName}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            disabled={saving}
            className="rounded-lg p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 flex flex-col min-h-0 p-4">
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
        <div className="flex justify-end gap-2 border-t border-surface-border px-4 py-3">
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
        </div>
      </div>
    </div>
  );
}
