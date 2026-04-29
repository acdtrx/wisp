import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { VM_ICONS } from './vmIcons.jsx';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';

const CATEGORIES = ['OS', 'Service', 'Generic'];

export default function IconPickerModal({ open, currentIconId, onSelect, onClose }) {
  const [search, setSearch] = useState('');
  const inputRef = useRef(null);

  useEscapeKey(open, onClose);

  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  // Focus the search input synchronously after the modal commits — ref is
  // populated by then. Avoids the prior `setTimeout(50)` which raced the
  // mount and made testing flaky.
  useLayoutEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return VM_ICONS;
    const q = search.trim().toLowerCase();
    return VM_ICONS.filter(
      (i) => i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q) || i.id.includes(q)
    );
  }, [search]);

  const grouped = useMemo(() => {
    const map = {};
    for (const cat of CATEGORIES) map[cat] = [];
    for (const icon of filtered) {
      if (map[icon.category]) map[icon.category].push(icon);
    }
    return map;
  }, [filtered]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-card bg-surface-card shadow-lg max-h-[70vh]" data-wisp-modal-root>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">Choose Icon</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150"
          >
            <X size={16} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search icons…"
              className="w-full rounded-md border border-surface-border bg-surface pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent transition-colors duration-150"
            />
          </div>
        </div>

        {/* Icon grid */}
        <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
          {CATEGORIES.map((cat) => {
            const icons = grouped[cat];
            if (!icons || icons.length === 0) return null;
            return (
              <div key={cat}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  {cat === 'OS' ? 'Operating Systems' : cat === 'Service' ? 'Services' : 'Generic'}
                </p>
                <div className="grid grid-cols-4 gap-1.5">
                  {icons.map((icon) => {
                    const Icon = icon.component;
                    const isSelected = icon.id === currentIconId;
                    return (
                      <button
                        key={icon.id}
                        onClick={() => { onSelect(icon.id); onClose(); }}
                        className={`flex flex-col items-center gap-1 rounded-lg px-2 py-2.5 transition-colors duration-150 ${
                          isSelected
                            ? 'bg-accent/10 border border-accent/30 text-accent'
                            : 'border border-transparent hover:bg-surface text-text-secondary hover:text-text-primary'
                        }`}
                      >
                        <Icon size={20} />
                        <span className="text-[10px] font-medium leading-tight text-center truncate w-full">
                          {icon.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {filtered.length === 0 && (
            <div className="flex flex-col items-center py-8 text-center">
              <Search size={24} className="text-text-muted mb-2" />
              <p className="text-xs text-text-muted">No icons match &ldquo;{search}&rdquo;</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
