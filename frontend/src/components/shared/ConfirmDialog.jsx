import { useEffect, useRef } from 'react';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';

export default function ConfirmDialog({ open, title, message, children, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  const dialogRef = useRef(null);

  useEscapeKey(open, onCancel);

  useEffect(() => {
    if (open && dialogRef.current) dialogRef.current.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative z-10 w-full max-w-sm rounded-card bg-surface-card p-6 shadow-lg outline-none"
        data-wisp-modal-root
      >
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {children != null ? (
          <div className="mt-2 text-sm text-text-secondary">{children}</div>
        ) : (
          <p className="mt-2 text-sm text-text-secondary">{message}</p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface transition-colors duration-150"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-status-stopped px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors duration-150"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
