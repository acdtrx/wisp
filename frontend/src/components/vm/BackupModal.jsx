import { useState } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';

export default function BackupModal({
  vmName,
  backupStarted = false,
  destinations,
  selectedIds,
  onToggleDestination,
  progress,
  error,
  onStart,
  onClose,
}) {
  const [starting, setStarting] = useState(false);
  const isDone = progress?.step === 'done';
  const isError = !!error;
  const inProgress = backupStarted && progress && !isDone && !isError;

  useEscapeKey(!!onClose, onClose);

  const handleStart = () => {
    if (selectedIds.length === 0) return;
    setStarting(true);
    onStart();
    setStarting(false);
  };

  if (!destinations?.length) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/30" onClick={onClose} />
        <div className="relative z-10 w-full max-w-sm rounded-card bg-surface-card p-6 shadow-lg" data-wisp-modal-root>
          <h3 className="text-sm font-semibold text-text-primary">Backup VM</h3>
          <p className="mt-2 text-xs text-text-muted">Loading destinations…</p>
          <button onClick={onClose} className="mt-4 rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium">Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 w-full max-w-md rounded-card bg-surface-card p-6 shadow-lg" data-wisp-modal-root>
        <h3 className="text-sm font-semibold text-text-primary">Backup — {vmName}</h3>
        <p className="mt-1 text-xs text-text-secondary">Choose backup destinations. VM must be stopped.</p>

        <div className={`mt-4 space-y-2 ${inProgress ? 'opacity-60' : ''}`}>
          {destinations.map((d) => (
            <label key={d.id} className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedIds.includes(d.id)}
                onChange={() => onToggleDestination(d.id)}
                className="rounded border-surface-border"
                disabled={inProgress}
              />
              <span className="text-sm text-text-primary">{d.label}</span>
              <span className="text-xs text-text-muted font-mono truncate">{d.path}</span>
            </label>
          ))}
        </div>

        {progress && (
          <div className="mt-4 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
            {progress.step === 'done' ? (
              <p className="text-status-running">Backup complete.</p>
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
          {inProgress ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-surface-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-sidebar"
            >
              Continue in background
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface"
              >
                {isDone ? 'Close' : 'Cancel'}
              </button>
              {!isDone && !isError && (
                <button
                  type="button"
                  onClick={handleStart}
                  disabled={selectedIds.length === 0 || starting}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                >
                  Start backup
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
