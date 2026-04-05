import { useState } from 'react';

/**
 * Modal owns its open state. trigger is a render prop: (onOpen) => element.
 * Clicking the trigger opens the dialog; onConfirm/onCancel close it.
 */
export default function CloneDialog({ trigger, onConfirm, onCancel }) {
  const [open, setOpen] = useState(false);
  const [localName, setLocalName] = useState('');

  const handleConfirm = () => {
    const trimmed = (localName || '').trim();
    if (!trimmed) return;
    onConfirm(trimmed);
    setLocalName('');
    setOpen(false);
  };

  const handleCancel = () => {
    setLocalName('');
    setOpen(false);
    onCancel?.();
  };

  return (
    <>
      {typeof trigger === 'function' ? trigger(() => setOpen(true)) : trigger}
      {open && (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={handleCancel} />
      <div className="relative z-10 w-full max-w-sm rounded-card bg-surface-card p-6 shadow-lg" data-wisp-modal-root>
        <h3 className="text-sm font-semibold text-text-primary">Clone VM</h3>
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
            onClick={handleCancel}
            className="rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface transition-colors duration-150"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!localName.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors duration-150"
          >
            Clone
          </button>
        </div>
      </div>
    </div>
      )}
    </>
  );
}
