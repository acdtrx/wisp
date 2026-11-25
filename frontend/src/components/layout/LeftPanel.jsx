import { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
import AlertDialog from '../shared/AlertDialog.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import { autoFocusField } from '../../lib/focus.js';
import { useLayer, focusIntoLayer } from '../../lib/layers.js';
import { useMediaQuery } from '../../hooks/useMediaQuery.js';
import { useCommand } from '../../hooks/useCommand.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { errorText } from '../../api/errors.js';
import { CONNECTION } from '../../store/streamStore.js';
import Button from '../shared/Button.jsx';
import IconButton, { IconLink } from '../shared/IconButton.jsx';
import RadioPills from '../shared/RadioPills.jsx';

const FILTER_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'vms', label: 'VMs' },
  { value: 'containers', label: 'Containers' },
];

const DRAG_MIME = 'application/x-wisp-workload';
const NO_WORKLOADS = [];

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
  const command = useCommand();
  const busy = command.busy;
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (autoEdit && !editing) {
      setDraftName(section.name);
      setEditing(true);
      onAutoEditConsumed?.();
    }
  }, [autoEdit, editing, section.name, onAutoEditConsumed]);

  useEffect(() => {
    if (!editing) setDraftName(section.name);
  }, [section.name, editing]);

  const startRename = () => {
    setDraftName(section.name);
    setEditing(true);
  };
  const submitRename = () => {
    const name = draftName.trim();
    if (!name || name === section.name) {
      setEditing(false);
      return;
    }
    command.run(() => renameSection(section.id, name), { key: 'rename', onDone: () => setEditing(false) });
  };
  const handleDelete = () => setConfirmDelete(true);
  const performDelete = () => {
    setConfirmDelete(false);
    command.run(() => deleteSection(section.id), { key: 'delete' });
  };

  return (
    <>
    <div className="flex items-center gap-2 px-3 py-1">
      <div className="h-px flex-1 bg-surface-border" />
      {editing ? (
        <div className="flex items-center gap-0.5">
          <input
            type="text"
            ref={autoFocusField}
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            }}
            className="w-28 rounded-sm border border-surface-border bg-surface-card px-1.5 py-0.5 text-[10px] text-text-primary outline-hidden focus:border-accent"
          />
          <IconButton icon={Check} label="Save" variant="positive" size="xs" disabled={busy} onClick={submitRename} />
          <IconButton icon={X} label="Cancel" variant="danger" size="xs" onClick={() => setEditing(false)} />
        </div>
      ) : (
        <>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
            {section.name}
          </span>
          {organizeMode && !section.builtin && (
            <div className="flex items-center gap-0.5">
              <IconButton icon={ChevronUp} label="Move section up" title="Move up" size="xs" disabled={busy || !canMoveUp} onClick={() => onMove?.('up')} />
              <IconButton icon={ChevronDown} label="Move section down" title="Move down" size="xs" disabled={busy || !canMoveDown} onClick={() => onMove?.('down')} />
              <IconButton icon={Pencil} label="Rename section" size="xs" disabled={busy} onClick={startRename} />
              <IconButton icon={Trash2} label="Delete section" variant="danger" size="xs" disabled={busy} onClick={handleDelete} />
            </div>
          )}
        </>
      )}
      <div className="h-px flex-1 bg-surface-border" />
    </div>
    <ConfirmDialog
      open={confirmDelete}
      title="Delete section"
      message={`Delete section "${section.name}"? Its workloads will move back to Main.`}
      confirmLabel="Delete"
      onConfirm={performDelete}
      onCancel={() => setConfirmDelete(false)}
    />
    <AlertDialog
      open={!!command.errors[0]}
      title="Section action failed"
      message={command.errors[0] ? errorText(command.errors[0].error) : ''}
      tone="error"
      onClose={() => command.dismiss(command.errors[0]?.key)}
    />
    </>
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
    } catch { /* a drag from outside Wisp carries no workload: nothing is dropped */ }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`transition-colors duration-150 ${dragOver ? 'bg-accent-soft' : ''}`}
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
    } catch { /* a drag from outside Wisp carries no workload: nothing is dropped */ }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`mx-3 my-2 flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed py-4 text-[11px] transition-colors duration-150 ${
        dragOver
          ? 'border-accent bg-accent-soft text-accent-text'
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
  const vmList = useVmStore((s) => s.data);
  const connectVMs = useVmStore((s) => s.connect);
  const disconnectVMs = useVmStore((s) => s.disconnect);
  const containerList = useContainerStore((s) => s.data);
  const vms = vmList ?? NO_WORKLOADS;
  const containers = containerList ?? NO_WORKLOADS;
  const vmListError = useVmStore((s) => s.error);
  const containerListError = useContainerStore((s) => s.error);
  const listsLoaded = vmList != null && containerList != null;
  const listError = vmListError || containerListError;
  /* Both lists are topics of the one events stream: reconnecting it asks for both. */
  const retryLists = () => useVmStore.getState().retry();
  const connectContainers = useContainerStore((s) => s.connect);
  const disconnectContainers = useContainerStore((s) => s.disconnect);
  const listFilter = useUiStore((s) => s.listFilter);
  const setListFilter = useUiStore((s) => s.setListFilter);
  const organizeMode = useUiStore((s) => s.organizeMode);
  const setOrganizeMode = useUiStore((s) => s.setOrganizeMode);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const asideRef = useRef(null);
  const belowLg = useMediaQuery('(max-width: 1023.98px)');
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const sections = useSectionsStore((s) => s.data.sections);
  const assignments = useSectionsStore((s) => s.data.assignments);
  const sectionsError = useSectionsStore((s) => s.error);
  const sectionsRefused = useSectionsStore((s) => s.connection === CONNECTION.REFUSED);
  const sectionsRetrying = useSectionsStore((s) => s.connection === CONNECTION.CONNECTING && s.error != null);
  const connectSections = useSectionsStore((s) => s.connect);
  const disconnectSections = useSectionsStore((s) => s.disconnect);
  const assignWorkload = useSectionsStore((s) => s.assignWorkload);
  const reorderSections = useSectionsStore((s) => s.reorderSections);
  const createAndAssign = useSectionsStore((s) => s.createAndAssign);
  const pendingRenameId = useSectionsStore((s) => s.pendingRenameId);
  const clearPendingRenameId = useSectionsStore((s) => s.clearPendingRenameId);
  const location = useLocation();
  const stats = useStatsStore((s) => s.data);
  const pendingUpdates = stats?.pendingUpdates ?? 0;
  const wispUpdateAvailable = !!stats?.wispUpdate?.available;
  const certificateFailed = !!stats?.certificateFailed;
  const hostBadgeTitle = [
    wispUpdateAvailable && 'Wisp update available',
    pendingUpdates > 0 && `${pendingUpdates} OS package update(s) available`,
    certificateFailed && 'The host certificate could not be got or renewed',
  ].filter(Boolean).join(' · ');

  const [search, setSearch] = useState('');
  const [sortRunningFirst, setSortRunningFirst] = useState(false);
  /* A section create or move in flight, until the server answers. */
  const sectionsCommand = useCommand();
  const sectionsBusy = sectionsCommand.busy;

  useEffect(() => {
    connectVMs();
    return () => disconnectVMs();
  }, [connectVMs, disconnectVMs]);

  useEffect(() => {
    connectContainers();
    return () => disconnectContainers();
  }, [connectContainers, disconnectContainers]);

  useEffect(() => {
    connectSections();
    return () => disconnectSections();
  }, [connectSections, disconnectSections]);

  /* Exit organize mode when the user navigates away, and when the panel mounts (after a
   * sign-in: the mode lives in the UI store) — stale "edit" state shouldn't leak across
   * views. Below lg the panel is a drawer; navigating to a workload/host view should
   * also dismiss it. */
  useEffect(() => {
    setOrganizeMode(false);
    setSidebarOpen(false);
  }, [location.pathname, setOrganizeMode, setSidebarOpen]);

  /* Below lg the open panel is a drawer: a layer (Escape closes it, Tab stays
   * in it, the page beside it is inert, focus returns to the menu button). At
   * lg+ it is the static sidebar and no layer. */
  const isDrawer = sidebarOpen && belowLg;
  useLayer(isDrawer, {
    kind: 'drawer',
    ref: asideRef,
    onEscape: () => setSidebarOpen(false),
    inertTargets: () => [document.querySelector('[data-wisp-main]')],
  });
  useEffect(() => {
    if (isDrawer) focusIntoLayer(asideRef.current);
  }, [isDrawer]);

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

  /* Bucket items using the assignments map from sectionsStore, which takes it
   * only from the `sections` topic. The VM/container list topics intentionally
   * don't carry section info: libvirt and containerd don't emit events on
   * assignment changes. */
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

  const handleMoveSection = (id, direction) => {
    /* Build the new order from the user-defined sections only — Main is
     * implicit and always rendered first, never part of the persisted order. */
    const userSections = sections.filter((s) => s.id !== MAIN_SECTION_ID);
    const idx = userSections.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const swapWith = direction === 'up' ? idx - 1 : idx + 1;
    if (swapWith < 0 || swapWith >= userSections.length) return;
    const next = [...userSections];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    sectionsCommand.run(() => reorderSections(next.map((s) => s.id)), { key: 'move' });
  };

  const handleCreateAndAssign = ({ type, name }) => sectionsCommand.run(() => createAndAssign({ type, name }), { key: 'create' });

  return (
    <>
      {/* Drawer backdrop — only below lg while the drawer is open. Sits below
          the top bar so the hamburger stays reachable as a close toggle.
          The offset tracks the top bar's own height: 3rem (its `h-12` first row)
          plus whatever `pt-safe` added to it. */}
      {sidebarOpen && (
        <div
          className="fixed inset-x-0 top-[calc(3rem+env(safe-area-inset-top))] bottom-0 z-30 bg-black/40 dark:bg-black/60 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden
        />
      )}
      {/* Below lg: drawer under the top bar — full-width on phones, 280px rail
          from sm up. At lg+ it is the static sidebar. */}
      <aside
        ref={asideRef}
        tabIndex={-1}
        aria-label="Workloads"
        /* px-safe: the drawer is `fixed`, so AppLayout's inset doesn't reach it. */
        className={`${sidebarOpen ? 'flex' : 'hidden'} outline-hidden fixed top-[calc(3rem+env(safe-area-inset-top))] bottom-0 left-0 z-40 w-full flex-col border-r border-surface-border bg-surface-sidebar px-safe sm:w-[280px] lg:static lg:z-auto lg:flex`}
      >
      <Link
        to="/host/overview"
        className={`flex h-11 w-full items-center gap-3 px-4 text-left transition-colors duration-150 border-b border-surface-border ${
          isHostSelected ? 'bg-surface-card border-l-2 border-l-accent' : 'hover:bg-surface-card'
        }`}
      >
        <Server size={18} className="shrink-0 text-text-secondary" />
        <div className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium text-text-primary">Host</span>
          {stats?.cpu?.total != null && stats?.memory?.totalGB != null && (
            <p className="text-[11px] text-text-muted">
              {stats.cpu.total} CPU / {formatMemory(Math.round(stats.memory.totalGB * 1024))}
            </p>
          )}
        </div>
        {hostBadgeTitle && (
          <span className="flex h-2 w-2 shrink-0 rounded-full bg-status-warning" title={hostBadgeTitle} />
        )}
      </Link>

      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Workloads
        </span>
        <div className="flex items-center gap-1">
          <IconLink to="/create/vm" icon={Plus} kindIcon={Server} label="New VM" variant="primary" size="sm" />
          <IconLink to="/create/container" icon={Plus} kindIcon={Box} label="New Container" variant="primary" size="sm" />
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
              className="w-full rounded-md border border-surface-border bg-surface-card pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-muted outline-hidden focus:border-accent transition-colors duration-150"
            />
          </div>
          <div className="flex items-center justify-between">
            <RadioPills variant="segment" size="xs" label="Show" options={FILTER_OPTIONS} value={listFilter} onChange={setListFilter} />
            <Button variant="ghost" size="xs" onClick={() => setSortRunningFirst(!sortRunningFirst)}>
              {sortRunningFirst ? '● Running first' : '○ Alphabetical'}
            </Button>
          </div>
        </div>
      )}

      {/* overscroll-contain stops the drawer's scroll from chaining to the
          content behind it on iOS when the list hits its top/bottom edge. */}
      <div className="flex-1 overflow-y-auto overscroll-contain py-1">
        {/* Each list's own failure, over the list last read (dismissible) or alone. */}
        <ErrorBanner
          className="mx-3 my-2"
          error={vmListError}
          prefix="Couldn't load the VMs"
          onRetry={retryLists}
          onDismiss={vmList != null ? useVmStore.getState().dismissError : undefined}
        />
        <ErrorBanner
          className="mx-3 my-2"
          error={containerListError}
          prefix="Couldn't load the containers"
          onRetry={retryLists}
          onDismiss={containerList != null ? useContainerStore.getState().dismissError : undefined}
        />
        <ErrorBanner
          className="mx-3 my-2"
          error={sectionsError}
          prefix="Couldn't load the sections"
          /* Refused, nothing is shown: Retry. A failed gather over the sections shown: dismiss. */
          onRetry={sectionsRefused ? retryLists : undefined}
          retrying={sectionsRetrying}
          onDismiss={sectionsRefused ? undefined : useSectionsStore.getState().dismissError}
        />
        {!listsLoaded && totalCount === 0 ? (
          listError ? null : (
            <div className="space-y-2 px-3 py-2" aria-busy="true" aria-label="Loading workloads">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 animate-pulse rounded-md bg-surface" />)}
            </div>
          )
        ) : totalCount === 0 ? (
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
                    canMoveUp={!sectionsBusy && canMoveUp}
                    canMoveDown={!sectionsBusy && canMoveDown}
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

      {/* Bottom-flush in the mobile drawer: pad past the home indicator so Organize
          isn't sitting in the strip. Base 0.5rem is the desktop `py-2` half. */}
      <div className="flex border-t border-surface-border px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <Button
          variant={organizeMode ? 'primary' : 'ghost'}
          icon={FolderCog}
          fullWidth
          aria-pressed={organizeMode}
          title={organizeMode ? 'Done organizing' : 'Organize sections'}
          onClick={() => setOrganizeMode(!organizeMode)}
        >
          {organizeMode ? 'Done' : 'Organize'}
        </Button>
      </div>
      <AlertDialog
        open={!!sectionsCommand.errors[0]}
        title="Section action failed"
        message={sectionsCommand.errors[0] ? errorText(sectionsCommand.errors[0].error) : ''}
        tone="error"
        onClose={() => sectionsCommand.dismiss(sectionsCommand.errors[0]?.key)}
      />
      </aside>
    </>
  );
}
