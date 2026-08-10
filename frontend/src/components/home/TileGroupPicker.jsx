import { useState, useRef, useEffect } from 'react';
import { FolderInput, Check, FolderPlus } from 'lucide-react';
import { useHomeStore, UNGROUPED_GROUP_ID } from '../../store/homeStore.js';
import AlertDialog from '../shared/AlertDialog.jsx';

/**
 * Move-to-group popover for a tile in edit mode. Same interaction as the
 * sidebar's `SectionPickerButton`: anchored to its trigger, closes on outside
 * click or Escape, with a "New group…" entry at the bottom.
 */
export default function TileGroupPicker({ tileId, currentGroupId, className = '' }) {
  const groups = useHomeStore((s) => s.groups);
  const assignTile = useHomeStore((s) => s.assignTile);
  const createGroup = useHomeStore((s) => s.createGroup);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = async (groupId) => {
    if (busy) return;
    setBusy(true);
    try {
      await assignTile({ tileId, groupId });
      setOpen(false);
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setBusy(false);
    }
  };

  const pickNew = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await createGroup();
      /* The new group is last in the freshly-applied envelope; move the tile
       * into it so "New group…" behaves like the sidebar's create-and-assign. */
      const created = useHomeStore.getState().groups.filter((g) => !g.builtin).at(-1);
      if (created) await assignTile({ tileId, groupId: created.id });
      setOpen(false);
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={className}
        title="Move to group"
        aria-label="Move to group"
        aria-expanded={open}
      >
        <FolderInput size={13} aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 bottom-full z-30 mb-1 w-44 rounded-lg border border-surface-border bg-surface-card py-1 shadow-lg">
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
        </div>
      )}
      <AlertDialog
        open={!!errorMsg}
        title="Couldn't move tile"
        message={errorMsg || ''}
        tone="error"
        onClose={() => setErrorMsg(null)}
      />
    </div>
  );
}
