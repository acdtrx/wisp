import { useState, useEffect } from 'react';
import { Pencil, Trash2, Check, X, ChevronUp, ChevronDown } from 'lucide-react';

import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import AlertDialog from '../shared/AlertDialog.jsx';
import { useHomeStore } from '../../store/homeStore.js';
import HomeTile from './HomeTile.jsx';
import { autoFocusField } from '../../lib/focus.js';
import { errorText } from '../../api/errors.js';
import { useCommand } from '../../hooks/useCommand.js';
import IconButton from '../shared/IconButton.jsx';

/**
 * One labelled grid of lanterns. In edit mode the label grows the same inline
 * rename / reorder / delete affordances the sidebar's section headers carry;
 * the implicit "Ungrouped" bucket has none of them (it is where new links land,
 * not something the user made).
 */
export default function HomeGroup({ group, tiles, editing, hideLabel, autoEdit, onAutoEditConsumed, canMoveUp, canMoveDown, onMove }) {
  const renameGroup = useHomeStore((s) => s.renameGroup);
  const deleteGroup = useHomeStore((s) => s.deleteGroup);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(group.name);
  const command = useCommand();
  const busy = command.busy;
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (autoEdit && !renaming) {
      setDraftName(group.name);
      setRenaming(true);
      onAutoEditConsumed?.();
    }
  }, [autoEdit, renaming, group.name, onAutoEditConsumed]);

  useEffect(() => {
    if (!renaming) setDraftName(group.name);
  }, [group.name, renaming]);

  const submitRename = () => {
    const name = draftName.trim();
    if (!name || name === group.name) {
      setRenaming(false);
      return;
    }
    command.run(() => renameGroup(group.id, name), { key: 'rename', onDone: () => setRenaming(false) });
  };

  const performDelete = () => {
    setConfirmDelete(false);
    command.run(() => deleteGroup(group.id), { key: 'delete' });
  };

  return (
    <section className="mb-7">
      <div className={`mb-2.5 flex items-baseline gap-2 ${hideLabel ? 'hidden' : ''}`}>
        {renaming ? (
          <div className="flex items-center gap-0.5">
            <input
              type="text"
              ref={autoFocusField}
              value={draftName}
              maxLength={64}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename();
                else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
              }}
              className="w-36 rounded-sm border border-surface-border bg-surface-card px-1.5 py-0.5 text-[11px] text-text-primary outline-hidden focus:border-accent"
            />
            <IconButton icon={Check} label="Save group name" title="Save" variant="positive" size="xs" disabled={busy} onClick={submitRename} />
            <IconButton icon={X} label="Cancel rename" title="Cancel" variant="danger" size="xs" onClick={() => setRenaming(false)} />
          </div>
        ) : (
          <>
            <h3 className="text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
              {group.name}
            </h3>
            <span className="text-xs text-text-muted/70">{tiles.length}</span>
            {editing && !group.builtin && (
              <div className="flex items-center gap-0.5">
                <IconButton icon={ChevronUp} label="Move group up" size="xs" disabled={busy || !canMoveUp} onClick={() => onMove?.('up')} />
                <IconButton icon={ChevronDown} label="Move group down" size="xs" disabled={busy || !canMoveDown} onClick={() => onMove?.('down')} />
                <IconButton icon={Pencil} label="Rename group" size="xs" disabled={busy} onClick={() => { setDraftName(group.name); setRenaming(true); }} />
                <IconButton icon={Trash2} label="Delete group" variant="danger" size="xs" disabled={busy} onClick={() => setConfirmDelete(true)} />
              </div>
            )}
          </>
        )}
      </div>

      {tiles.length === 0 ? (
        <p className="text-[11px] italic text-text-muted">
          {editing ? 'Move tiles here with the folder button on a tile.' : 'Empty'}
        </p>
      ) : (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(236px,1fr))]">
          {tiles.map((tile, i) => (
            <HomeTile
              key={tile.id}
              tile={tile}
              editing={editing}
              groupId={group.id}
              index={i}
              canMoveLeft={i > 0}
              canMoveRight={i < tiles.length - 1}
            />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        title="Delete group"
        message={`Delete the "${group.name}" group? Its tiles move back to Ungrouped.`}
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setConfirmDelete(false)}
      />
      <AlertDialog
        open={!!command.errors[0]}
        title="Group action failed"
        message={command.errors[0] ? errorText(command.errors[0].error) : ''}
        tone="error"
        onClose={() => command.dismiss(command.errors[0]?.key)}
      />
    </section>
  );
}
