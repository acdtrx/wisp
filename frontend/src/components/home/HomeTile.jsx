import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowUpRight, Settings, Eye, EyeOff, Pencil, Check, X,
  Trash2, ChevronLeft, ChevronRight, AlertTriangle,
} from 'lucide-react';
import { getVmIcon } from '../shared/vmIcons.jsx';
import IconPickerModal from '../shared/IconPickerModal.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import AlertDialog from '../shared/AlertDialog.jsx';
import { useHomeStore, UNGROUPED_GROUP_ID } from '../../store/homeStore.js';
import TileGroupPicker from './TileGroupPicker.jsx';

const LIT_STATES = new Set(['running', 'blocked']);

const editBtn =
  'rounded-sm p-1 text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-30 disabled:hover:bg-transparent';

/**
 * One lantern. A tile is a link first: the whole card opens the service in a new
 * tab, the notch sitting in the top border is the visual cue for that, and the
 * cogwheel below it — the only other affordance — opens the backing workload's
 * page in Wisp. Both live in the same right-hand lane so they never collide.
 *
 * State is the light: a running workload glows and breathes, a stopped one wears
 * an "asleep" chip on a dimmed card, and a link with no workload behind it (a
 * proxied host on another machine, a manual link) shows no state at all.
 */
export default function HomeTile({ tile, editing, groupId, canMoveLeft, canMoveRight, index }) {
  const navigate = useNavigate();
  const setTileOverride = useHomeStore((s) => s.setTileOverride);
  const assignTile = useHomeStore((s) => s.assignTile);
  const updateManualTile = useHomeStore((s) => s.updateManualTile);
  const removeManualTile = useHomeStore((s) => s.removeManualTile);

  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(tile.name);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const Icon = getVmIcon(tile.iconId).component;
  const external = tile.workload == null;
  const lit = !external && LIT_STATES.has(tile.workload.state);
  const updateAvailable = tile.workload?.updateAvailable === true;

  const run = async (action) => {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setErrorMsg(err.detail || err.message);
    } finally {
      setBusy(false);
    }
  };

  /* A manual tile owns its name outright; a derived tile keeps its derived name
   * and carries the user's choice as an override, so a renamed Caddy host still
   * tracks the workload it points at. */
  const submitRename = () => {
    const name = draftName.trim();
    setRenaming(false);
    if (!name || name === tile.name) return;
    run(() =>
      tile.kind === 'manual'
        ? updateManualTile(tile.id, { name })
        : setTileOverride({ tileId: tile.id, name }),
    );
  };

  const openWorkload = (e) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/${tile.workload.type}/${encodeURIComponent(tile.workload.name)}`);
  };

  const iconWellClass = lit
    ? 'home-lantern-lit text-accent-text animate-[wisp-breathe_4.2s_ease-in-out_infinite] motion-reduce:animate-none'
    : external
      ? 'bg-surface-sidebar text-text-muted ring-1 ring-inset ring-surface-border'
      : 'bg-surface text-text-muted';

  const cardClass = [
    'relative flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left shadow-card',
    'transition-[transform,box-shadow,border-color] duration-150 motion-reduce:transition-none',
    tile.hidden ? 'border-dashed border-surface-border opacity-50' : 'border-surface-border',
    lit || external ? 'bg-surface-card' : 'home-tile-asleep',
  ].join(' ');

  const body = (
    <>
      {editing ? (
        <button
          type="button"
          onClick={() => setIconPickerOpen(true)}
          className={`grid size-[42px] shrink-0 cursor-pointer place-items-center rounded-[10px] transition-shadow duration-150 hover:ring-2 hover:ring-accent ${iconWellClass}`}
          title="Change icon"
          aria-label="Change icon"
        >
          <Icon size={21} aria-hidden />
        </button>
      ) : (
        <span className={`grid size-[42px] shrink-0 place-items-center rounded-[10px] ${iconWellClass}`}>
          <Icon size={21} aria-hidden />
        </span>
      )}
      <span className="min-w-0 flex-1">
        {renaming ? (
          <span className="flex items-center gap-0.5">
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
              className="min-w-0 flex-1 rounded-sm border border-surface-border bg-surface-card px-1.5 py-0.5 text-sm text-text-primary outline-hidden focus:border-accent"
            />
            <button
              type="button"
              onClick={submitRename}
              className="rounded-sm p-0.5 text-text-secondary hover:bg-surface hover:text-status-running"
              title="Save"
              aria-label="Save name"
            >
              <Check size={12} aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => setRenaming(false)}
              className="rounded-sm p-0.5 text-text-secondary hover:bg-surface hover:text-status-stopped"
              title="Cancel"
              aria-label="Cancel rename"
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[14.5px] font-semibold text-text-primary">
              {tile.name}
            </span>
            {!external && !lit && (
              <span className="shrink-0 rounded-full bg-surface-sidebar px-2 py-px text-[10.5px] font-medium text-text-muted">
                asleep
              </span>
            )}
            {updateAvailable && (
              <span
                className="size-[7px] shrink-0 rounded-full bg-status-warning"
                title="Update available"
                aria-label="Update available"
              />
            )}
          </span>
        )}
        <span className="block truncate text-xs text-text-muted">
          {tile.host}
          {external && ' · elsewhere'}
        </span>
      </span>
    </>
  );

  return (
    /* The modals below render inside this wrapper and position with `fixed` —
       a transformed ancestor becomes their containing block, so the hover lift
       must never apply in edit mode, the only time a modal can open. */
    <div
      className={`group relative ${
        editing ? '' : 'transition-transform duration-150 motion-reduce:transition-none hover:-translate-y-0.5'
      }`}
    >
      {editing ? (
        <div className={`${cardClass} flex-col items-stretch gap-2`}>
          <div className="flex items-center gap-3">{body}</div>
          <div className="flex items-center gap-0.5 border-t border-surface-border pt-2">
            <button
              type="button"
              onClick={() => run(() => setTileOverride({ tileId: tile.id, hidden: !tile.hidden }))}
              disabled={busy}
              className={editBtn}
              title={tile.hidden ? 'Show tile' : 'Hide tile'}
              aria-label={tile.hidden ? 'Show tile' : 'Hide tile'}
            >
              {tile.hidden ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
            </button>
            <button
              type="button"
              onClick={() => { setDraftName(tile.name); setRenaming(true); }}
              disabled={busy}
              className={editBtn}
              title="Rename tile"
              aria-label="Rename tile"
            >
              <Pencil size={13} aria-hidden />
            </button>
            <TileGroupPicker tileId={tile.id} currentGroupId={groupId} className={editBtn} />
            {groupId !== UNGROUPED_GROUP_ID && (
              <>
                <button
                  type="button"
                  onClick={() => run(() => assignTile({ tileId: tile.id, groupId, index: index - 1 }))}
                  disabled={busy || !canMoveLeft}
                  className={editBtn}
                  title="Move earlier"
                  aria-label="Move tile earlier"
                >
                  <ChevronLeft size={13} aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => run(() => assignTile({ tileId: tile.id, groupId, index: index + 1 }))}
                  disabled={busy || !canMoveRight}
                  className={editBtn}
                  title="Move later"
                  aria-label="Move tile later"
                >
                  <ChevronRight size={13} aria-hidden />
                </button>
              </>
            )}
            {tile.kind === 'manual' && (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                className={`${editBtn} ml-auto hover:text-status-stopped`}
                title="Remove link"
                aria-label="Remove link"
              >
                <Trash2 size={13} aria-hidden />
              </button>
            )}
          </div>
          {tile.conflicts?.length > 0 && (
            <p
              className="flex items-start gap-1.5 text-[11px] text-status-warning"
              title="Two sources publish this URL; only one tile is shown."
            >
              <AlertTriangle size={12} className="mt-px shrink-0" aria-hidden />
              <span>
                Also published by {tile.conflicts.map((c) => c.publisher).join(', ')}
              </span>
            </p>
          )}
        </div>
      ) : (
        <a
          href={tile.url}
          target="_blank"
          rel="noreferrer noopener"
          className={`${cardClass} ${external ? '' : 'pr-12'} hover:border-accent/40 hover:shadow-[0_8px_22px_color-mix(in_srgb,var(--color-accent)_14%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
          title={tile.url}
        >
          {body}
          {/* Launch notch: a tab cut into the top border, centred on the cogwheel's
              axis (28px from the right edge) so the two read as one action lane. */}
          <span
            className="absolute -top-px right-[15px] grid h-[15px] w-[26px] place-items-center rounded-b-lg border border-t-0 border-accent/25 bg-accent-soft text-text-muted transition-colors duration-150 motion-reduce:transition-none group-hover:border-accent group-hover:bg-accent group-hover:text-white"
            aria-hidden
          >
            <ArrowUpRight size={10} strokeWidth={2.5} />
          </span>
        </a>
      )}

      {/* Cogwheel sits outside the anchor — an interactive control can't nest in a
          link — and is absolutely placed so the two share the tile's right lane.
          `right-[15px]` against the (border-less) wrapper puts its 28px axis 29px
          from the card's outer edge, exactly where the notch's axis lands from
          inside the 1px border. */}
      {!editing && !external && (
        <button
          type="button"
          onClick={openWorkload}
          className="absolute top-1/2 right-[15px] grid size-7 -translate-y-1/2 place-items-center rounded-[7px] border border-surface-border bg-surface-card text-text-muted transition-colors duration-150 hover:border-accent hover:text-accent-text"
          title={`Manage ${tile.workload.name} in Wisp`}
          aria-label={`Manage ${tile.workload.name} in Wisp`}
        >
          <Settings size={14} aria-hidden />
        </button>
      )}

      <IconPickerModal
        open={iconPickerOpen}
        currentIconId={tile.iconId}
        onSelect={(iconId) => run(() => setTileOverride({ tileId: tile.id, iconId }))}
        onClose={() => setIconPickerOpen(false)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Remove link"
        message={`Remove the "${tile.name}" link from Home?`}
        confirmLabel="Remove"
        onConfirm={() => {
          setConfirmDelete(false);
          run(() => removeManualTile(tile.id));
        }}
        onCancel={() => setConfirmDelete(false)}
      />
      <AlertDialog
        open={!!errorMsg}
        title="Home action failed"
        message={errorMsg || ''}
        tone="error"
        onClose={() => setErrorMsg(null)}
      />
    </div>
  );
}
