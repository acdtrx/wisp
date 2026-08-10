import { useState, useEffect, useMemo } from 'react';
import { Plus, Link as LinkIcon, FolderPlus, Check, Pencil, Lightbulb } from 'lucide-react';
import { useHomeStore, UNGROUPED_GROUP_ID } from '../../store/homeStore.js';
import AlertDialog from '../shared/AlertDialog.jsx';
import HomeMotes from './HomeMotes.jsx';
import HomeGroup from './HomeGroup.jsx';
import ManualLinkModal from './ManualLinkModal.jsx';

const LIT_STATES = new Set(['running', 'blocked']);

function greeting(hour) {
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function plural(n, singular, pluralForm) {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

const headerBtn =
  'flex items-center gap-1.5 rounded-md border border-surface-border bg-surface-card px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface hover:text-text-primary transition-colors duration-150';

/**
 * Home — the launcher. First tab of the Host panel and the app's landing page.
 *
 * Everything on it is derived server-side (see backend/src/lib/homeTiles.js) and
 * arrives on the `home` topic, so the page is correct on first paint with no
 * configuration at all; the edit mode here only layers the human touches on top.
 * No host-vitals strip: the top bar's stats already carry that.
 */
export default function HomePanel() {
  const tiles = useHomeStore((s) => s.tiles);
  const groups = useHomeStore((s) => s.groups);
  const loaded = useHomeStore((s) => s.loaded);
  const startHomeSSE = useHomeStore((s) => s.startHomeSSE);
  const stopHomeSSE = useHomeStore((s) => s.stopHomeSSE);
  const createGroup = useHomeStore((s) => s.createGroup);
  const reorderGroups = useHomeStore((s) => s.reorderGroups);
  const pendingRenameId = useHomeStore((s) => s.pendingRenameId);
  const clearPendingRenameId = useHomeStore((s) => s.clearPendingRenameId);

  const [editing, setEditing] = useState(false);
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    startHomeSSE();
    return () => stopHomeSSE();
  }, [startHomeSSE, stopHomeSSE]);

  const tilesById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles]);

  const counts = useMemo(() => {
    let lit = 0;
    let asleep = 0;
    let elsewhere = 0;
    for (const tile of tiles) {
      if (tile.hidden) continue;
      if (!tile.workload) elsewhere += 1;
      else if (LIT_STATES.has(tile.workload.state)) lit += 1;
      else asleep += 1;
    }
    return { lit, asleep, elsewhere };
  }, [tiles]);

  const handleMoveGroup = async (id, direction) => {
    const userGroups = groups.filter((g) => !g.builtin);
    const idx = userGroups.findIndex((g) => g.id === id);
    if (idx < 0) return;
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= userGroups.length) return;
    const next = [...userGroups];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    try {
      await reorderGroups(next.map((g) => g.id));
    } catch (err) {
      setErrorMsg(err.detail || err.message);
    }
  };

  const handleAddGroup = async () => {
    try {
      await createGroup();
    } catch (err) {
      setErrorMsg(err.detail || err.message);
    }
  };

  const userGroupIds = groups.filter((g) => !g.builtin).map((g) => g.id);
  const onlyUngrouped = userGroupIds.length === 0;
  const visibleTileCount = tiles.filter((t) => !t.hidden).length;

  return (
    <div className="home-canvas relative flex-1 overflow-y-auto">
      <HomeMotes />

      <div className="relative px-6 pt-7 pb-11 lg:px-9">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-[30px] leading-tight font-semibold tracking-tight text-text-primary">
              {greeting(new Date().getHours())}
            </h2>
            <p className="text-[13.5px] text-text-muted">
              <span className="font-semibold text-accent-text">
                {plural(counts.lit, 'lantern lit', 'lanterns lit')}
              </span>
              {counts.asleep > 0 && ` · ${counts.asleep} asleep`}
              {counts.elsewhere > 0 &&
                ` · ${plural(counts.elsewhere, 'link lives', 'links live')} elsewhere on the network`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {editing && (
              <>
                <button type="button" onClick={() => setAddLinkOpen(true)} className={headerBtn}>
                  <Plus size={13} aria-hidden />
                  <LinkIcon size={13} aria-hidden />
                  <span>Add link</span>
                </button>
                <button type="button" onClick={handleAddGroup} className={headerBtn}>
                  <Plus size={13} aria-hidden />
                  <FolderPlus size={13} aria-hidden />
                  <span>Add group</span>
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setEditing((e) => !e)}
              className={
                editing
                  ? 'flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150'
                  : headerBtn
              }
              aria-pressed={editing}
            >
              {editing ? <Check size={13} aria-hidden /> : <Pencil size={13} aria-hidden />}
              <span>{editing ? 'Done' : 'Edit home'}</span>
            </button>
          </div>
        </header>

        {loaded && visibleTileCount === 0 && !editing ? (
          <div className="flex flex-col items-center py-16 text-center">
            <Lightbulb size={32} className="mb-3 text-text-muted" aria-hidden />
            <p className="font-display text-lg font-semibold text-text-primary">No lanterns yet</p>
            <p className="mt-1 max-w-md text-xs text-text-muted">
              Home lights up on its own: give a container a published URL — a Caddy reverse-proxy
              host, a Jellyfin or registry address, an <code>_http._tcp</code> mDNS service — and it
              appears here. Or use <strong>Edit home → Add link</strong> for anything else.
            </p>
          </div>
        ) : (
          groups.map((group) => {
            const groupTiles = group.tileIds
              .map((id) => tilesById.get(id))
              .filter((t) => t && (editing || !t.hidden));
            /* An empty group is scaffolding the reader doesn't need — except in
             * edit mode, where it has to stay visible to receive tiles. */
            if (!editing && groupTiles.length === 0) return null;
            const userIdx = userGroupIds.indexOf(group.id);
            return (
              <HomeGroup
                key={group.id}
                group={group}
                tiles={groupTiles}
                editing={editing}
                /* "Ungrouped" only means something next to real groups. On a
                 * zero-config page it is the whole page, so it goes unlabelled. */
                hideLabel={group.builtin && onlyUngrouped && !editing}
                autoEdit={pendingRenameId === group.id}
                onAutoEditConsumed={clearPendingRenameId}
                canMoveUp={userIdx > 0}
                canMoveDown={userIdx >= 0 && userIdx < userGroupIds.length - 1}
                onMove={(direction) => handleMoveGroup(group.id, direction)}
              />
            );
          })
        )}
      </div>

      {addLinkOpen && <ManualLinkModal open tile={null} onClose={() => setAddLinkOpen(false)} />}
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
