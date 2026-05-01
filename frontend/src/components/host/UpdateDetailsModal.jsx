import { X } from 'lucide-react';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';

export default function UpdateDetailsModal({ open, title, subtitle, footer, onClose, children }) {
  useEscapeKey(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-card border border-surface-border bg-surface-card shadow-lg"
        data-wisp-modal-root
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-surface-border px-5 py-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-1 text-text-muted hover:bg-surface"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="border-t border-surface-border px-5 py-3 text-xs">{footer}</div>
        )}
      </div>
    </div>
  );
}
