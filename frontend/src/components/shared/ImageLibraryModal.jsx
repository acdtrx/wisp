import { X } from 'lucide-react';
import ImageLibrary from '../library/ImageLibrary.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';

export default function ImageLibraryModal({ open, onClose, onSelect, defaultFilter = 'all' }) {
  useEscapeKey(open, onClose);

  if (!open) return null;

  const handleSelect = (file) => {
    onSelect(file);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        className="relative z-10 flex h-[70vh] w-full max-w-3xl flex-col overflow-hidden rounded-card border border-surface-border bg-surface shadow-lg"
        data-wisp-modal-root
      >
        <div className="flex items-center justify-between border-b border-surface-border bg-surface-card px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Select Image</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
          >
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-hidden">
          <ImageLibrary mode="picker" onSelect={handleSelect} defaultFilter={defaultFilter} />
        </div>
      </div>
    </div>
  );
}
