import { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Plus, Monitor, Search, Server, Box, FolderCog,
  Pencil, Trash2, Check, X, FolderPlus, ChevronUp, ChevronDown,
} from 'lucide-react';
import { useVmStore } from '../../store/vmStore.js';
import { useContainerStore } from '../../store/containerStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { useStatsStore } from '../../store/statsStore.js';
import { useSectionsStore, MAIN_SECTION_ID, selectSectionId } from '../../store/sectionsStore.js';
import { formatMemory } from '../../utils/formatters.js';
import VMListItem from '../vm/VMListItem.jsx';
import ContainerListItem from '../container/ContainerListItem.jsx';

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'vms', label: 'VMs' },
  { value: 'containers', label: 'Containers' },
];

const DRAG_MIME = 'application/x-wisp-workload';

/**
 * Compact "logs-marker" style section header: thin rule with a small label.
 * In organize mode, non-builtin sections expose inline rename / delete icons
 * and may auto-enter rename mode on creation. The drop zone lives on the
 * surrounding section block (in LeftPanel), not on the header itself.
 */
function SectionHeader({ section, organizeMode, autoEdit, onAutoEditConsumed, canMoveUp, canMoveDown, onMove }) {
  const renameSection = useSectionsStore((s) => s.renameSection);
  const deleteSection = useSectionsStore((s) => s.deleteSection);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(section.name);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (autoEdit && !editing) {
      setDraftName(section.name);
      setEditing(true);
      onAutoEditConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit]);

  useEffect(() => {
    if (!editing) setDraftName(section.name);
  }, [section.name, editing]);

  const startRename = () => {
    setDraftName(section.name);
    setEditing(true);
  };
  const submitRename = async () => {
    const name = draftName.trim();
    if (!name || name === section.name) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await renameSection(section.id, name);
      setEditing(false);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };
  const handleDelete = async () => {
    if (!confirm(`Delete section "${section.name}"? Its workloads will move back to Main.`)) return;
    setBusy(true);
    try {
      await deleteSection(section.id);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2 px-3 py-1">
      <div className="h-px flex-1 bg-surface-border" />
      {editing ? (
        <div className="flex items-center gap-0.5">
          <input
            type="text"
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              else if (e.key === 'Escape') setEditing(false);
            }}
            className="w-28 rounded border border-surface-border bg-surface-card px-1.5 py-0.5 text-[10px] text-text-primary outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={submitRename}
            disabled={busy}
            className="rounded p-0.5 text-text-secondary hover:bg-surface hover:text-status-running disabled:opacity-40"
            title="Save"
            aria-label="Save"
          >
            <Check size={11} />
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded p-0.5 text-text-secondary hover:bg-surface hover:text-status-stopped"
            title="Cancel"
            aria-label="Cancel"
          >
            <X size={11} />
          </button>
        </div>
      ) : (
        <>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            {section.name}
          </span>
          {organizeMode && !section.builtin && (
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => onMove?.('up')}
                disabled={busy || !canMoveUp}
                className="rounded p-0.5 text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
                title="Move up"
                aria-label="Move section up"
              >
                <ChevronUp size={11} />
              </button>
              <button
                type="button"
                onClick={() => onMove?.('down')}
                disabled={busy || !canMoveDown}
                className="rounded p-0.5 text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-30 disabled:hover:bg-transparent"
                title="Move down"
                aria-label="Move section down"
              >
                <ChevronDown size={11} />
              </button>
              <button
                type="button"
                onClick={startRename}
                disabled={busy}
                className="rounded p-0.5 text-text-secondary hover:bg-surface hover:text-text-primary disabled:opacity-40"
                title="Rename section"
                aria-label="Rename section"
              >
                <Pencil size={10} />
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={busy}
                className="rounded p-0.5 text-text-secondary hover:bg-surface hover:text-status-stopped disabled:opacity-40"
                title="Delete section"
                aria-label="Delete section"
              >
                <Trash2 size={10} />
              </button>
            </div>
          )}
        </>
      )}
      <div className="h-px flex-1 bg-surface-border" />
    </div>
  );
}

/**
 * Wraps a section's header + items so the entire block is one drop target.
 * Calls onDropWorkload({type, name}) when a workload is dropped into it.
 * Visual feedback (subtle accent tint) shows during drag-over.
 */
function SectionBlock({ section, items, organizeMode, onDropWorkload, autoEdit, onAutoEditConsumed, canMoveUp, canMoveDown, onMove }) {
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = (e) => {
    if (!organizeMode) return;
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };
  const handleDragLeave = (e) => {
    /* Ignore dragleave bubbling out of children — only clear when the cursor
     * actually exits the block. relatedTarget is null when leaving the window. */
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  };
  const handleDrop = (e) => {
    setDragOver(false);
    if (!organizeMode) return;
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const { type, name } = JSON.parse(raw);
      if (type && name) onDropWorkload({ type, name });
    } catch { /* malformed payload — ignore */ }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`transition-colors duration-100 ${dragOver ? 'bg-accent/5' : ''}`}
    >
      <SectionHeader
        section={section}
        organizeMode={organizeMode}
        autoEdit={autoEdit}
        onAutoEditConsumed={onAutoEditConsumed}
        canMoveUp={canMoveUp}
        canMoveDown={canMoveDown}
        onMove={onMove}
      />
      {items.length === 0 ? (
        <p className="px-4 py-1.5 text-[11px] italic text-text-muted">
          {organizeMode ? 'Drop workloads here' : 'Empty'}
        </p>
      ) : (
        <div className="space-y-0">
          {items.map((item) =>
            item._type === 'vm' ? (
              <VMListItem key={`vm-${item.name}`} vm={item} />
            ) : (
              <ContainerListItem key={`ct-${item.name}`} container={item} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Ghost "Create Section" placeholder shown in organize mode under the last
 * real section. Dropping a workload here delegates to the store's
 * createAndAssign flow (which mints a default name, assigns the workload,
 * and flags the new section for auto-rename).
 */
function CreateSectionGhost({ onCreateAndAssign }) {
  const [dragOver, setDragOver] = useState(false);

  const handleDragOver = (e) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOver(true);
  };
  const handleDragLeave = (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setDragOver(false);
  };
  const handleDrop = (e) => {
    setDragOver(false);
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    try {
      const { type, name } = JSON.parse(raw);
      if (type && name) onCreateAndAssign({ type, name });
    } catch { /* ignore malformed payload */ }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`mx-3 my-2 flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed py-4 text-[11px] transition-colors duration-100 ${
        dragOver
          ? 'border-accent bg-accent/5 text-accent'
          : 'border-surface-border text-text-muted'
      }`}
    >
      <FolderPlus size={16} aria-hidden />
      <span className="font-medium">{dragOver ? 'Drop to create section' : 'Create section'}</span>
      <span className="text-[10px] text-text-muted/80">Drag a workload here</span>
    </div>
  );
}

export default function LeftPanel() {
  const vms = useVmStore((s) => s.vms);
  const startVMListSSE = useVmStore((s) => s.startVMListSSE);
  const stopVMListSSE = useVmStore((s) => s.stopVMListSSE);
  const containers = useContainerStore((s) => s.containers);
  const startContainerListSSE = useContainerStore((s) => s.startContainerListSSE);
  const stopContainerListSSE = useContainerStore((s) => s.stopContainerListSSE);
  const listFilter = useUiStore((s) => s.listFilter);
  const setListFilter = useUiStore((s) => s.setListFilter);
  const organizeMode = useUiStore((s) => s.organizeMode);
  const setOrganizeMode = useUiStore((s) => s.setOrganizeMode);
  const sections = useSectionsStore((s) => s.sections);
  const assignments = useSectionsStore((s) => s.assignments);
  const loadSections = useSectionsStore((s) => s.loadSections);
  const assignWorkload = useSectionsStore((s) => s.assignWorkload);
  const reorderSections = useSectionsStore((s) => s.reorderSections);
  const createAndAssign = useSectionsStore((s) => s.createAndAssign);
  const pendingRenameId = useSectionsStore((s) => s.pendingRenameId);
  const clearPendingRenameId = useSectionsStore((s) => s.clearPendingRenameId);
  const navigate = useNavigate();
  const location = useLocation();
  const stats = useStatsStore((s) => s.stats);
  const pendingUpdates = stats?.pendingUpdates ?? 0;
  const wispUpdateAvailable = !!stats?.wispUpdate?.available;

  const [search, setSearch] = useState('');
  const [sortRunningFirst, setSortRunningFirst] = useState(false);

  useEffect(() => {
    startVMListSSE();
    return () => stopVMListSSE();
  }, [startVMListSSE, stopVMListSSE]);

  useEffect(() => {
    startContainerListSSE();
    return () => stopContainerListSSE();
  }, [startContainerListSSE, stopContainerListSSE]);

  useEffect(() => { loadSections().catch(() => {}); }, [loadSections]);

  /* Exit organize mode when the user navigates away — stale "edit" state
   * shouldn't leak across views. */
  useEffect(() => {
    if (organizeMode) setOrganizeMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const allItems = useMemo(() => {
    const vmItems = (listFilter === 'all' || listFilter === 'vms')
      ? vms.map((v) => ({ ...v, _type: 'vm' }))
      : [];
    const ctItems = (listFilter === 'all' || listFilter === 'containers')
      ? containers.map((c) => ({ ...c, _type: 'container' }))
      : [];

    let list = [...vmItems, ...ctItems];

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((item) => item.name.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      if (sortRunningFirst) {
        const aRunning = a.state === 'running' || a.state === 'blocked' ? 0 : 1;
        const bRunning = b.state === 'running' || b.state === 'blocked' ? 0 : 1;
        if (aRunning !== bRunning) return aRunning - bRunning;
      }
      return a.name.localeCompare(b.name);
    });

    return list;
  }, [vms, containers, search, sortRunningFirst, listFilter]);

  /* Bucket items using the local assignments map (sectionsStore), not the
   * `sectionId` baked into the SSE payload — the SSE only re-pushes on
   * libvirt/containerd events, so without this overlay the UI would lag
   * behind every move-to-section action until the next workload event. */
  const itemsBySection = useMemo(() => {
    const buckets = new Map();
    for (const s of sections) buckets.set(s.id, []);
    for (const item of allItems) {
      const sid = selectSectionId({ sections, assignments }, item._type, item.name);
      const target = buckets.has(sid) ? sid : MAIN_SECTION_ID;
      buckets.get(target).push(item);
    }
    return buckets;
  }, [allItems, sections, assignments]);

  const totalCount = vms.length + containers.length;
  const isHostSelected = location.pathname === '/' || location.pathname.startsWith('/host');
  const openHost = () => navigate('/host/overview');

  const handleMoveSection = async (id, direction) => {
    /* Build the new order from the user-defined sections only — Main is
     * implicit and always rendered first, never part of the persisted order. */
    const userSections = sections.filter((s) => s.id !== MAIN_SECTION_ID);
    const idx = userSections.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= userSections.length) return;
    const next = [...userSections];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    try {
      await reorderSections(next.map((s) => s.id));
    } catch (err) {
      alert(err.message);
    }
  };

  const handleCreateAndAssign = async ({ type, name }) => {
    try {
      await createAndAssign({ type, name });
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <aside className="flex w-[280px] flex-col border-r border-surface-border bg-surface-sidebar">
      <button
        type="button"
        onClick={openHost}
        className={`flex h-11 w-full items-center gap-3 px-4 text-left transition-colors duration-150 border-b border-surface-border ${
          isHostSelected ? 'bg-surface-card border-l-2 border-l-accent' : 'hover:bg-surface-card'
        }`}
      >
        <Server size={18} className="flex-shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium text-text-primary">Host</span>
          {stats?.cpu?.total != null && stats?.memory?.totalGB != null && (
            <p className="text-[11px] text-text-muted">
              {stats.cpu.total} CPU / {formatMemory(Math.round(stats.memory.totalGB * 1024))}
            </p>
          )}
        </div>
        {(pendingUpdates > 0 || wispUpdateAvailable) && (
          <span
            className="flex h-2 w-2 flex-shrink-0 rounded-full bg-amber-500"
            title={
              wispUpdateAvailable && pendingUpdates > 0
                ? `Wisp update available · ${pendingUpdates} OS package update(s)`
                : wispUpdateAvailable
                  ? 'Wisp update available'
                  : `${pendingUpdates} OS package update(s) available`
            }
          />
        )}
      </button>

      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Workloads
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate('/create/vm')}
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150"
            title="New VM"
          >
            <Plus size={14} />
            <Server size={12} />
          </button>
          <button
            onClick={() => navigate('/create/container')}
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent-hover transition-colors duration-150"
            title="New Container"
          >
            <Plus size={14} />
            <Box size={12} />
          </button>
        </div>
      </div>

      {totalCount > 0 && (
        <div className="px-3 pt-3 pb-1 space-y-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full rounded-md border border-surface-border bg-surface-card pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-accent transition-colors duration-150"
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex rounded-md border border-surface-border bg-surface p-0.5">
              {FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setListFilter(opt.value)}
                  className={`px-2 py-0.5 text-[10px] font-medium rounded transition-colors duration-150 ${
                    listFilter === opt.value
                      ? 'bg-surface-card text-text-primary shadow-sm'
                      : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setSortRunningFirst(!sortRunningFirst)}
              className={`text-[10px] font-medium transition-colors duration-150 ${
                sortRunningFirst ? 'text-accent' : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              {sortRunningFirst ? '● Running first' : '○ Alphabetical'}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-1">
        {totalCount === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Monitor size={32} className="text-text-muted mb-2" />
            <p className="text-sm text-text-muted">No workloads</p>
            <p className="text-xs text-text-muted mt-1">Create a VM or container to get started</p>
          </div>
        ) : allItems.length === 0 && search.trim() ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Search size={24} className="text-text-muted mb-2" />
            <p className="text-xs text-text-muted">No matches for &ldquo;{search}&rdquo;</p>
          </div>
        ) : (
          <>
            {(() => {
              /* Pre-compute the user-section ids in render order so each
               * SectionBlock can know if it's at the top/bottom of the
               * reorderable range. Main is excluded — it's always first and
               * never moves. */
              const userIds = sections.filter((s) => s.id !== MAIN_SECTION_ID).map((s) => s.id);
              return sections.map((section) => {
                const items = itemsBySection.get(section.id) || [];
                if (items.length === 0 && search.trim() && section.id !== MAIN_SECTION_ID) {
                  return null;
                }
                if (
                  section.id === MAIN_SECTION_ID &&
                  items.length === 0 &&
                  sections.length > 1 &&
                  !organizeMode
                ) {
                  return null;
                }
                const userIdx = userIds.indexOf(section.id);
                const canMoveUp = userIdx > 0;
                const canMoveDown = userIdx >= 0 && userIdx < userIds.length - 1;
                return (
                  <SectionBlock
                    key={section.id}
                    section={section}
                    items={items}
                    organizeMode={organizeMode}
                    onDropWorkload={({ type, name }) => assignWorkload({ type, name, sectionId: section.id })}
                    autoEdit={pendingRenameId === section.id}
                    onAutoEditConsumed={clearPendingRenameId}
                    canMoveUp={canMoveUp}
                    canMoveDown={canMoveDown}
                    onMove={(direction) => handleMoveSection(section.id, direction)}
                  />
                );
              });
            })()}
            {organizeMode && (
              <CreateSectionGhost onCreateAndAssign={handleCreateAndAssign} />
            )}
          </>
        )}
      </div>

      <div className="flex border-t border-surface-border px-3 py-2">
        <button
          type="button"
          onClick={() => setOrganizeMode(!organizeMode)}
          className={`flex w-full items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium transition-colors duration-150 ${
            organizeMode
              ? 'bg-accent text-white hover:bg-accent-hover'
              : 'text-text-secondary hover:bg-surface-card hover:text-text-primary'
          }`}
          title={organizeMode ? 'Done organizing' : 'Organize sections'}
          aria-pressed={organizeMode}
        >
          <FolderCog size={14} />
          <span>{organizeMode ? 'Done' : 'Organize'}</span>
        </button>
      </div>
    </aside>
  );
}
