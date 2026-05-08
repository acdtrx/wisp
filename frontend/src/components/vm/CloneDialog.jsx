import { useEffect, useState } from 'react';
import Modal from '../shared/Modal.jsx';

// Same auto-dismiss delay as BackupModal — long enough to read "Clone
// complete.", short enough that the user doesn't have to click Close on a
// redundant confirmation.
const AUTO_CLOSE_DELAY_MS = 1200;

/**
 * Two-state dialog: name-input until the clone is started, then progress.
 * Controlled component — parent owns `open`. Mirrors BackupModal's API.
 *
 * Trigger render-prop receives an `onOpen` callback that the trigger should
 * call to open the dialog. Parent maintains the boolean and toggles it.
 *
 * Props:
 *   open: boolean — render or not
 *   onOpen: () => void — invoked by trigger; parent flips `open` true
 *   cloneStarted: boolean — true once `onConfirm` has been fired and a job exists
 *   progress: { step, percent, currentFile } | null — from bgJobs
 *   error: string | null
 *   onConfirm: (newName: string) => Promise<void> — starts the job
 *   onClose: () => void — dismiss; parent flips `open` false and decides whether to clear jobId
 */
export default function CloneDialog({
  trigger,
  open,
  onOpen,
  cloneStarted = false,
  progress,
  error,
  onConfirm,
  onClose,
}) {
  const [localName, setLocalName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isDone = progress?.step === 'done';
  const isError = !!error;
  const inProgress = cloneStarted && progress && !isDone && !isError;

  // Reset local input when the dialog opens fresh (no job yet) or fully closes.
  useEffect(() => {
    if (!open || !cloneStarted) {
      setLocalName('');
      setSubmitting(false);
    }
  }, [open, cloneStarted]);

  // Auto-dismiss on success. Errors stay visible until the user closes.
  useEffect(() => {
    if (!isDone || !open) return;
    const t = setTimeout(() => onClose?.(), AUTO_CLOSE_DELAY_MS);
    return () => clearTimeout(t);
  }, [isDone, open, onClose]);

  const handleConfirm = async () => {
    const trimmed = (localName || '').trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(trimmed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      {typeof trigger === 'function' ? trigger(onOpen) : trigger}
      <Modal open={open} onClose={onClose} size="sm" bodyPadding="none">
        <div className="p-6">
          <h3 className="text-sm font-semibold text-text-primary">Clone VM</h3>

          {!cloneStarted ? (
            <>
              <p className="mt-1 text-xs text-text-secondary">Enter a name for the cloned VM.</p>
              <input
                type="text"
                value={localName}
                onChange={(e) => setLocalName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
                autoFocus
                className="input-field mt-3 focus:ring-1 focus:ring-accent"
              />
              <div className="mt-4 flex justify-end gap-2">
                <button
                  onClick={onClose}
                  className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface transition-colors duration-150"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={!localName.trim() || submitting}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors duration-150"
                >
                  Clone
                </button>
              </div>
            </>
          ) : (
            <>
              {progress && (
                <div className="mt-4 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
                  {progress.step === 'done' ? (
                    <p className="text-status-running">Clone complete.</p>
                  ) : progress.step === 'error' ? null : (
                    <>
                      <p className="text-text-secondary">
                        {progress.currentFile || progress.step}
                        {typeof progress.percent === 'number' && (
                          <span className="ml-1.5 text-text-muted font-mono">{Math.round(progress.percent)}%</span>
                        )}
                      </p>
                      {typeof progress.percent === 'number' && (
                        <div className="mt-1 h-1.5 w-full rounded-full bg-surface-border overflow-hidden">
                          <div className="h-full bg-accent rounded-full transition-all duration-300" style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {inProgress && (
                <p className="mt-3 text-xs text-text-muted">
                  You can hide this dialog and keep working — progress stays in the top bar under background jobs.
                </p>
              )}

              {error && (
                <p className="mt-2 text-xs text-status-stopped">{error}</p>
              )}

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-sidebar"
                >
                  {inProgress ? 'Continue in background' : 'Close'}
                </button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
