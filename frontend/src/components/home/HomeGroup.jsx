import { useState, useEffect } from 'react';
import { Pencil, Trash2, Check, X, ChevronUp, ChevronDown } from 'lucide-react';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import AlertDialog from '../shared/AlertDialog.jsx';
import { useHomeStore } from '../../store/homeStore.js';
import HomeTile from './HomeTile.jsx';

const headerBtn =
  'rounded-sm p-0.5 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-30 disabled:hover:bg-transparent';

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
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    if (autoEdit && !renaming) {
      setDraftName(group.name);
      setRenaming(true);
      onAutoEditConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit]);

  useEffect(() => {
    if (!renaming) setDraftName(group.name);
  }, [group.name, renaming]);

  const submitRename = async () => {
    const name = draftName.trim();
    if (!name || name === group.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      await renameGroup(group.id, name);
      setRenaming(false);
    } catch (err) {
      setErrorMsg(err.detail || err.message);
    } finally {
      setBusy(false);
    }
  };

  const performDelete = async () => {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await deleteGroup(group.id);
    } catch (err) {
      setErrorMsg(err.detail || err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mb-7">
      <div className={`mb-2.5 flex items-baseline gap-2 ${hideLabel ? 'hidden' : ''}`}>
        {renaming ? (
          <div className="flex items-center gap-0.5">
            <input
              type="text"
              autoFocus
              value={draftName}
              maxLength={64}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename();
                else if (e.key === 'Escape') setRenaming(false);
              }}
              className="w-36 rounded-sm border border-surface-border bg-surface-card px-1.5 py-0.5 text-[11px] text-text-primary outline-hidden focus:border-accent"
            />
            <button
              type="button"
              onClick={submitRename}
              disabled={busy}
              className={`${headerBtn} hover:text-status-running`}
              title="Save"
              aria-label="Save group name"
            >
              <Check size={11} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setRenaming(false)}
              className={`${headerBtn} hover:text-status-stopped`}
              title="Cancel"
              aria-label="Cancel rename"
            >
              <X size={11} aria-hidden />
            </button>
          </div>
        ) : (
          <>
            <h3 className="text-[13px] font-semibold uppercase tracking-wider text-text-secondary">
              {group.name}
            </h3>
            <span className="text-xs text-text-muted/70">{tiles.length}</span>
            {editing && !group.builtin && (
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => onMove?.('up')}
                  disabled={busy || !canMoveUp}
                  className={headerBtn}
                  title="Move group up"
                  aria-label="Move group up"
                >
                  <ChevronUp size={11} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => onMove?.('down')}
                  disabled={busy || !canMoveDown}
                  className={headerBtn}
                  title="Move group down"
                  aria-label="Move group down"
                >
                  <ChevronDown size={11} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => { setDraftName(group.name); setRenaming(true); }}
                  disabled={busy}
                  className={headerBtn}
                  title="Rename group"
                  aria-label="Rename group"
                >
                  <Pencil size={10} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                  className={`${headerBtn} hover:text-status-stopped`}
                  title="Delete group"
                  aria-label="Delete group"
                >
                  <Trash2 size={10} aria-hidden />
                </button>
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
        open={!!errorMsg}
        title="Group action failed"
        message={errorMsg || ''}
        tone="error"
        onClose={() => setErrorMsg(null)}
      />
    </section>
  );
}
