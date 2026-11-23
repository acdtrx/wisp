import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { Search } from 'lucide-react';

import Modal from './Modal.jsx';
import { VM_ICONS } from './vmIcons.jsx';
import { focusField } from '../../lib/focus.js';
import RadioPills from './RadioPills.jsx';

const CATEGORIES = ['OS', 'Service', 'Generic'];

export default function IconPickerModal({ open, currentIconId, onSelect, onClose }) {
  const [search, setSearch] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  // Focus the search input synchronously after the modal commits — ref is
  // populated by then. Avoids the prior `setTimeout(50)` which raced the
  // mount and made testing flaky.
  useLayoutEffect(() => {
    if (open) focusField(inputRef.current); // not on touch: the picker opens without the keyboard
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose Icon"
      size="md"
      height="cap"
      bodyPadding="none"
    >
      <div className="flex h-full flex-col">
        <div className="px-4 pt-3 pb-2 shrink-0">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search icons…"
              className="w-full rounded-md border border-surface-border bg-surface pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-hidden focus:border-accent transition-colors duration-150"
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-3">
          {CATEGORIES.map((cat) => {
            const icons = grouped[cat];
            if (!icons || icons.length === 0) return null;
            return (
              <div key={cat}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                  {cat === 'OS' ? 'Operating Systems' : cat === 'Service' ? 'Services' : 'Generic'}
                </p>
                <RadioPills
                  variant="tile"
                  label={cat}
                  options={icons.map((icon) => ({ value: icon.id, label: icon.name }))}
                  icons={Object.fromEntries(icons.map((icon) => [icon.id, icon.component]))}
                  value={currentIconId}
                  onChange={(id) => { onSelect(id); onClose(); }}
                />
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
    </Modal>
  );
}
