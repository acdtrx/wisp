import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, Check, FolderPlus } from 'lucide-react';

import { useSectionsStore, MAIN_SECTION_ID, selectSectionId } from '../../store/sectionsStore.js';
import AlertDialog from '../shared/AlertDialog.jsx';
import { usePopover } from '../../lib/popover.js';
import { errorText } from '../../api/errors.js';
import { useCommand } from '../../hooks/useCommand.js';
import IconButton from '../shared/IconButton.jsx';
import MenuItem from '../shared/MenuItem.jsx';

/**
 * Tiny popover trigger used inside a workload row in organize mode.
 * Lists every section + Main; clicking one calls assignWorkload and closes.
 * Anchored to the button (lib/popover.js: clamped to the viewport; Escape or a
 * press outside closes it).
 */
export default function SectionPickerButton({ type, name, disabled }) {
  const sections = useSectionsStore((s) => s.data.sections);
  const assignWorkload = useSectionsStore((s) => s.assignWorkload);
  const createAndAssign = useSectionsStore((s) => s.createAndAssign);
  const currentSectionId = useSectionsStore((s) => selectSectionId(s.data, type, name));
  const [open, setOpen] = useState(false);
  const command = useCommand();
  const busy = command.busy;
  const anchorRef = useRef(null);
  const popRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const popStyle = usePopover(open, { anchorRef, popRef, onClose: close, align: 'end' });

  const pick = (sectionId) => command.run(() => assignWorkload({ type, name, sectionId }), { key: 'pick', onDone: () => setOpen(false) });

  const pickNew = () => command.run(() => createAndAssign({ type, name }), { key: 'new', onDone: () => setOpen(false) });

  return (
    <div className="relative">
      <IconButton
        ref={anchorRef}
        icon={FolderInput}
        label="Move to section"
        size="sm"
        disabled={disabled}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          if (!disabled) setOpen((o) => !o);
        }}
      />
      {open && createPortal(
        <div
          ref={popRef}
          tabIndex={-1}
          style={popStyle}
          className="z-[60] w-44 overflow-y-auto rounded-lg border border-surface-border bg-surface-card py-1 shadow-popover outline-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-b border-surface-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Move to
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {sections.map((s) => {
              const isCurrent = (currentSectionId || MAIN_SECTION_ID) === s.id;
              return (
                <li key={s.id}>
                  <MenuItem
                    role={undefined}
                    size="sm"
                    current={isCurrent}
                    disabled={busy}
                    label={s.name}
                    trail={isCurrent && <Check size={12} className="shrink-0 text-accent" aria-hidden />}
                    onClick={() => pick(s.id)}
                  />
                </li>
              );
            })}
            <li className="border-t border-surface-border">
              <MenuItem role={undefined} size="sm" accent icon={FolderPlus} label="New section…" disabled={busy} onClick={pickNew} />
            </li>
          </ul>
        </div>,
        document.body,
      )}
      <AlertDialog
        open={!!command.errors[0]}
        title="Couldn't move workload"
        message={command.errors[0] ? errorText(command.errors[0].error) : ''}
        tone="error"
        onClose={() => command.dismiss(command.errors[0]?.key)}
      />
    </div>
  );
}
