import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FolderInput, Check, FolderPlus } from 'lucide-react';
import { useHomeStore, UNGROUPED_GROUP_ID } from '../../store/homeStore.js';
import AlertDialog from '../shared/AlertDialog.jsx';
import { usePopover } from '../../lib/popover.js';
import { errorText } from '../../api/errors.js';
import { useCommand } from '../../hooks/useCommand.js';

const NO_GROUPS = [];

/**
 * Move-to-group popover for a tile in edit mode. Same interaction as the
 * sidebar's `SectionPickerButton`: anchored to its trigger (lib/popover.js:
 * clamped to the viewport, above it where it fits), with a "New group…" entry
 * at the bottom.
 */
export default function TileGroupPicker({ tileId, currentGroupId, className = '' }) {
  const groups = useHomeStore((s) => s.data?.groups ?? NO_GROUPS);
  const assignTile = useHomeStore((s) => s.assignTile);
  const createGroup = useHomeStore((s) => s.createGroup);
  const [open, setOpen] = useState(false);
  const command = useCommand();
  const busy = command.busy;
  const anchorRef = useRef(null);
  const popRef = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  const popStyle = usePopover(open, { anchorRef, popRef, onClose: close, align: 'start', side: 'top' });

  const pick = (groupId) => command.run(() => assignTile({ tileId, groupId }), { key: 'pick', onDone: () => setOpen(false) });

  /* Move the tile into the new group so "New group…" behaves like the sidebar's
   * create-and-assign. */
  const pickNew = () => command.run(async () => {
    const groupId = await createGroup();
    await assignTile({ tileId, groupId });
  }, { key: 'new', onDone: () => setOpen(false) });

  return (
    <div className="relative">
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={className}
        title="Move to group"
        aria-label="Move to group"
        aria-expanded={open}
      >
        <FolderInput size={13} aria-hidden />
      </button>
      {open && createPortal(
        <div
          ref={popRef}
          tabIndex={-1}
          style={popStyle}
          className="z-[60] w-44 overflow-y-auto rounded-lg border border-surface-border bg-surface-card py-1 shadow-popover outline-hidden"
        >
          <div className="border-b border-surface-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            Move to
          </div>
          <ul className="max-h-64 overflow-y-auto">
            {groups.map((group) => {
              const isCurrent = (currentGroupId || UNGROUPED_GROUP_ID) === group.id;
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    onClick={() => pick(group.id)}
                    disabled={busy || isCurrent}
                    className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs transition-colors duration-100 ${
                      isCurrent ? 'text-text-muted' : 'text-text-primary hover:bg-surface'
                    }`}
                  >
                    <span className="truncate">{group.name}</span>
                    {isCurrent && <Check size={12} className="shrink-0 text-accent" aria-hidden />}
                  </button>
                </li>
              );
            })}
            <li className="border-t border-surface-border">
              <button
                type="button"
                onClick={pickNew}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary transition-colors duration-100 hover:bg-surface hover:text-accent-text disabled:opacity-40"
              >
                <FolderPlus size={12} className="shrink-0" aria-hidden />
                <span>New group…</span>
              </button>
            </li>
          </ul>
        </div>,
        document.body,
      )}
      <AlertDialog
        open={!!command.errors[0]}
        title="Couldn't move tile"
        message={command.errors[0] ? errorText(command.errors[0].error) : ''}
        tone="error"
        onClose={() => command.dismiss(command.errors[0]?.key)}
      />
    </div>
  );
}
