import { useState, useEffect, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Loader2,
  Pencil,
  Plug,
  Unplug,
  ShieldCheck,
  Server,
  HardDrive,
} from 'lucide-react';

import SectionCard from '../shared/SectionCard.jsx';
import ConfirmDialog from '../shared/ConfirmDialog.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableBodyRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
  dataTableEmptyCellClass,
  rowActionIconBtn,
} from '../shared/DataTableChrome.jsx';
import SmbShareEditorModal from './SmbShareEditorModal.jsx';
import RemovableDriveEditorModal, { SUPPORTED_FSTYPES } from './RemovableDriveEditorModal.jsx';
import { sendAndAwaitKindChange } from '../../api/events.js';
import { useDiskStore } from '../../store/diskStore.js';
import { CONNECTION } from '../../store/streamStore.js';
import {
  deleteMount,
  mountMount,
  unmountMount,
  checkMountConnection,
} from '../../api/settings.js';
import RecordGate from '../shared/RecordGate.jsx';
import RecordError from '../shared/RecordError.jsx';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import { errorText } from '../../api/errors.js';
import { CHANGE_KIND } from '../../../../shared/wireNames.js';

const NO_STATUS = [];

/* Same geometry as rowActionIconBtn but color-neutral, for tinted (mount/check) states. */
const tintedActionBtnBase =
  'inline-flex items-center justify-center rounded-md border p-2 lg:p-1.5 transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

function truncate(s, max) {
  const t = (s || '').trim();
  if (t.length <= max) return t || '—';
  return `${t.slice(0, max - 1)}…`;
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

function shortUuid(u) {
  return u ? u.slice(0, 8) : '';
}

export default function HostStorage() {
  const settingsRecord = useRecord(RECORD.SETTINGS);
  const settings = settingsRecord.data;
  const disks = useDiskStore((s) => s.data);
  const connectDisks = useDiskStore((s) => s.connect);
  const disconnectDisks = useDiskStore((s) => s.disconnect);
  const diskStreamError = useDiskStore((s) => s.error);
  const diskStreamDropped = useDiskStore((s) => s.connection === CONNECTION.DROPPED);
  const dismissDiskStreamError = useDiskStore((s) => s.dismissError);

  useEffect(() => {
    connectDisks();
    return () => disconnectDisks();
  }, [connectDisks, disconnectDisks]);

  /* Which mounts are mounted, read again on every mount, unmount, add, edit and
   * removal (any tab, the auto-mount included). */
  const status = useRecord(RECORD.HOST_MOUNT_STATUS);
  const mountStatus = status.data ?? NO_STATUS;
  const rowCommands = useMountRowCommands();

  const smbSaved = useMemo(() => (settings?.mounts || []).filter((m) => m.type === 'smb'), [settings]);
  const diskSaved = useMemo(() => (settings?.mounts || []).filter((m) => m.type === 'disk'), [settings]);
  const adoptedUuids = useMemo(() => new Set(diskSaved.map((m) => m.uuid)), [diskSaved]);
  const unadoptedDetected = useMemo(
    () => (disks || []).filter((d) => {
      if (adoptedUuids.has(d.uuid)) return false;
      /* Skip system/OS-owned mounts (/, /boot, /boot/efi, /home, etc.) — anything not under /mnt/wisp/ */
      if (d.mountedAt && !d.mountedAt.startsWith('/mnt/wisp/')) return false;
      return true;
    }),
    [disks, adoptedUuids],
  );

  return (
    <SectionCard
      title="Storage"
      titleIcon={<Server size={14} strokeWidth={2} />}
      commands={rowCommands.commands}
      errorPrefix={rowCommands.errorPrefix((id) => (settings?.mounts || []).find((m) => m.id === id)?.label || id)}
    >
      <RecordGate record={settingsRecord} what="storage settings">
        {() => (
          <div className="space-y-6">
            {status.status === 'loading' && (
              <p className="text-[11px] text-text-muted" role="status">Loading the mount status…</p>
            )}
            <RecordError record={status} what="mount status" />
            <SmbMountsSection
              smbSaved={smbSaved}
              mountStatus={mountStatus}
              rowCommands={rowCommands}
            />

            <RemovableDrivesSection
              diskSaved={diskSaved}
              detectedDisks={disks}
              unadoptedDetected={unadoptedDetected}
              rowCommands={rowCommands}
              diskStreamError={diskStreamError}
              diskStreamDropped={diskStreamDropped}
              onDismissDiskStreamError={dismissDiskStreamError}
            />
          </div>
        )}
      </RecordGate>
    </SectionCard>
  );
}

/**
 * A mount row's commands, shared by the SMB and drive tables: the removal and the
 * mount toggle, each keyed by the mount's id, so rows run in parallel and each keeps
 * its error (the Storage section's). A removal and an unmount are jobs: busy until the
 * job ended and the records they change, read again after it, have landed; a mount is
 * busy until the `host-mounts` cue's re-read has.
 */
function useMountRowCommands() {
  const removal = useCommand();
  const toggleCommand = useCommand();
  return {
    commands: [removal, toggleCommand],
    errorPrefix: (labelOf) => (id, command) => `Couldn't ${command === removal ? 'remove' : 'mount or unmount'} ${labelOf(id)}`,
    deleting: (id) => removal.isBusy(id),
    toggling: (id) => toggleCommand.isBusy(id),
    /** Whether a command runs on the row: every control of the row is disabled then. */
    busy: (id) => removal.isBusy(id) || toggleCommand.isBusy(id),
    remove: (id) => removal.run(() => deleteMount(id), {
      job: true, rereads: [[RECORD.SETTINGS], [RECORD.HOST_MOUNT_STATUS]], key: id,
    }),
    toggle: (id, mounted) => (mounted
      ? toggleCommand.run(() => unmountMount(id), { job: true, rereads: [[RECORD.HOST_MOUNT_STATUS]], key: id })
      : toggleCommand.run(() => sendAndAwaitKindChange(CHANGE_KIND.HOST_MOUNTS, () => mountMount(id)), { key: id })),
  };
}

/* -------------------------- SMB mounts sub-section -------------------------- */

function SmbMountsSection({ smbSaved, mountStatus, rowCommands }) {
  const [editor, setEditor] = useState({ open: false, share: null });
  /* A connection test: its outcome, pass or fail, is the row's result, not an error. */
  const connectionTest = useCommand();
  const rowBusy = (id) => rowCommands.busy(id) || connectionTest.isBusy(id);
  const [checkByRow, setCheckByRow] = useState({});
  const [confirmDelete, setConfirmDelete] = useState(null);
  /* Phones: row actions live in a strip that expands under the row text on tap. */
  const [expandedId, setExpandedId] = useState(null);

  const openCreate = () => setEditor({ open: true, share: null });

  const openEdit = (share) => setEditor({ open: true, share });

  const closeEditor = () => setEditor({ open: false, share: null });

  const handleSaved = () => {
    /* Saved config may invalidate earlier connection-test results. */
    setCheckByRow({});
  };

  const handleRemoveConfirm = () => {
    const row = confirmDelete;
    if (!row) return;
    setConfirmDelete(null);
    rowCommands.remove(row.id);
  };

  const handleMountToggle = (id, mounted) => rowCommands.toggle(id, mounted);

  const handleCheck = (id) => {
    setCheckByRow((o) => {
      const n = { ...o };
      delete n[id];
      return n;
    });
    connectionTest.run(() => checkMountConnection({ id }).then(() => ({ ok: true }), (err) => ({ error: errorText(err) })), {
      key: id,
      onDone: (outcome) => setCheckByRow((o) => ({ ...o, [id]: outcome })),
    });
  };

  const headerAdd = (
    <button
      type="button"
      onClick={openCreate}
      className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
      title="Add SMB share"
      aria-label="Add SMB share"
    >
      <Plus size={14} aria-hidden />
      <Server size={14} aria-hidden />
    </button>
  );

  return (
    <div className="space-y-2">
      <SubHeading label="Network mounts (SMB)" headerAction={headerAdd} />
      <DataTableScroll>
        <DataTable>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense>Label</DataTableTh>
              <DataTableTh dense className="hidden min-w-40 sm:table-cell">Share</DataTableTh>
              <DataTableTh dense className="hidden min-w-36 sm:table-cell">Mount path</DataTableTh>
              <DataTableTh dense className="hidden sm:table-cell">User</DataTableTh>
              <DataTableTh dense className="hidden sm:table-cell">Password</DataTableTh>
              <DataTableTh dense align="right" className="hidden sm:table-cell">Actions</DataTableTh>
            </tr>
          </thead>
          <tbody>
            {smbSaved.length === 0 && (
              <tr className={dataTableBodyRowClass}>
                <td colSpan={6} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                  No SMB shares. Use Add.
                </td>
              </tr>
            )}
            {smbSaved.map((row) => {
              const status = mountStatus.find((s) => s.id === row.id);
              const mounted = status?.mounted ?? false;

              const check = checkByRow[row.id];
              const checkLoading = connectionTest.isBusy(row.id);
              const checkBtnClass = checkLoading
                ? rowActionIconBtn
                : check?.ok
                  ? `${tintedActionBtnBase} border-status-running/30 bg-status-running-soft text-status-running hover:bg-status-running-soft`
                  : check?.error
                    ? `${tintedActionBtnBase} border-status-stopped/30 bg-status-stopped-soft text-status-stopped hover:bg-status-stopped-soft`
                    : rowActionIconBtn;
              const checkTitle = checkLoading
                ? 'Testing…'
                : check?.ok
                  ? 'Connection OK'
                  : check?.error
                    ? check.error
                    : 'Test SMB connection';

              const mountBtnClass = mounted
                ? 'border-status-running/30 bg-status-running-soft text-status-running hover:bg-status-running-soft'
                : 'border-surface-border bg-surface text-text-secondary hover:bg-surface-hover';

              const expanded = expandedId === row.id;
              const actionButtons = (
                <>
                  <button type="button" onClick={() => handleMountToggle(row.id, mounted)} disabled={rowBusy(row.id)} className={`${tintedActionBtnBase} ${mountBtnClass}`} title={mounted ? 'Unmount share' : 'Mount share'} aria-label={mounted ? 'Unmount share' : 'Mount share'}>
                    {rowCommands.toggling(row.id) ? <Loader2 size={14} className="animate-spin" aria-hidden /> : mounted ? <Unplug size={14} aria-hidden /> : <Plug size={14} aria-hidden />}
                  </button>
                  <button type="button" onClick={() => handleCheck(row.id)} disabled={rowBusy(row.id)} className={checkBtnClass} title={checkTitle} aria-label={checkTitle}>
                    {checkLoading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
                  </button>
                  <button type="button" onClick={() => openEdit(row)} disabled={rowBusy(row.id)} className={rowActionIconBtn} title="Edit" aria-label="Edit SMB mount">
                    <Pencil size={14} aria-hidden />
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(row)} disabled={rowBusy(row.id)} className={`${rowActionIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`} title="Remove" aria-label="Remove SMB mount">
                    {rowCommands.deleting(row.id) ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                  </button>
                </>
              );

              return (
                <tr
                  key={row.id}
                  className={`${dataTableInteractiveRowClass} cursor-pointer sm:cursor-auto`}
                  onClick={() => setExpandedId((prev) => (prev === row.id ? null : row.id))}
                >
                  <DataTableTd dense className="text-sm">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <StatusDot {...(mounted ? { tone: 'green', label: 'Mounted' } : { tone: 'gray', label: 'Not mounted' })} />
                      <span className="shrink-0 text-text-primary">{truncate(row.label, 24)}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted sm:hidden">{row.share}</span>
                    </div>
                    <div className="mt-0.5 pl-4 sm:hidden">
                      <span className="block truncate font-mono text-xs text-text-muted">{row.mountPath}</span>
                    </div>
                    {expanded && (
                      /* Tap-to-expand action strip (phones only) */
                      <div className="mt-2 flex items-center gap-1.5 pl-4 sm:hidden" onClick={(e) => e.stopPropagation()}>
                        {actionButtons}
                      </div>
                    )}
                  </DataTableTd>
                  <DataTableTd dense className="hidden text-sm font-mono text-text-secondary sm:table-cell">
                    {truncate(row.share, 36)}
                  </DataTableTd>
                  <DataTableTd dense className="hidden text-sm font-mono text-text-secondary sm:table-cell">
                    {truncate(row.mountPath, 28)}
                  </DataTableTd>
                  <DataTableTd dense className="hidden text-sm sm:table-cell">
                    <span className="text-text-muted">{row.username ? truncate(row.username, 16) : '—'}</span>
                  </DataTableTd>
                  <DataTableTd dense className="hidden text-sm sm:table-cell">
                    <span className="text-text-muted font-mono text-xs">
                      {row.hasPassword === true ? '••••' : '—'}
                    </span>
                  </DataTableTd>
                  <DataTableTd dense align="right" className="hidden sm:table-cell">
                    <div onClick={(e) => e.stopPropagation()}>
                      <DataTableRowActions forceVisible={rowBusy(row.id)}>
                        {actionButtons}
                      </DataTableRowActions>
                    </div>
                  </DataTableTd>
                </tr>
              );
            })}
          </tbody>
        </DataTable>
      </DataTableScroll>
      <SmbShareEditorModal
        open={editor.open}
        share={editor.share}
        onClose={closeEditor}
        onSaved={handleSaved}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        title="Remove SMB share?"
        confirmLabel="Remove"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleRemoveConfirm}
      >
        Removes <span className="font-mono">{confirmDelete?.label || confirmDelete?.share || 'this share'}</span>{' '}
        from Wisp. If the share is currently mounted at{' '}
        <span className="font-mono">{confirmDelete?.mountPath}</span> it will be unmounted and the mount point
        directory removed. Files on the remote server are not touched.
      </ConfirmDialog>
    </div>
  );
}

/* ------------------------ Removable drives sub-section ------------------------ */

function RemovableDrivesSection({
  diskStreamError,
  diskStreamDropped,
  onDismissDiskStreamError,
  diskSaved,
  detectedDisks,
  unadoptedDetected,
  rowCommands,
}) {
  const rowBusy = rowCommands.busy;
  const [editor, setEditor] = useState({ open: false, drive: null, adoptDisk: null });
  const [confirmDelete, setConfirmDelete] = useState(null);
  /* Phones: row actions live in a strip that expands under the row text on tap. */
  const [expandedId, setExpandedId] = useState(null);

  const openEdit = (drive) => setEditor({ open: true, drive, adoptDisk: null });

  const openAdopt = (disk) => setEditor({ open: true, drive: null, adoptDisk: disk });

  const closeEditor = () => setEditor({ open: false, drive: null, adoptDisk: null });


  const handleRemoveConfirm = () => {
    const row = confirmDelete;
    if (!row) return;
    setConfirmDelete(null);
    rowCommands.remove(row.id);
  };

  const handleMountToggle = (id, mounted) => rowCommands.toggle(id, mounted);

  /* The device stream's state, in one place whether or not the tables have rows: an
   * error frame as a banner (dismissible over the drives shown), a dropped connection
   * as a status line while the client reconnects. */
  const streamNotice = (
    <>
      <ErrorBanner error={diskStreamError} onDismiss={detectedDisks ? onDismissDiskStreamError : undefined} />
      {diskStreamDropped && (
        <p className="text-[11px] text-text-muted" role="status">The device stream is not connected — retrying…</p>
      )}
    </>
  );

  const hasAnything = diskSaved.length > 0 || unadoptedDetected.length > 0;
  if (!hasAnything && (detectedDisks == null)) {
    return (
      <div className="space-y-2">
        <SubHeading label="Removable drives" />
        {diskStreamError || diskStreamDropped ? streamNotice : (
          <p className="text-[11px] text-text-muted">Connecting to device stream…</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <SubHeading label="Removable drives" />
        {streamNotice}
        <DataTableScroll>
          <DataTable>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense>Label</DataTableTh>
                <DataTableTh dense className="hidden sm:table-cell">UUID</DataTableTh>
                <DataTableTh dense className="hidden sm:table-cell">FS</DataTableTh>
                <DataTableTh dense className="hidden min-w-36 sm:table-cell">Mount path</DataTableTh>
                <DataTableTh dense className="hidden sm:table-cell">RO</DataTableTh>
                <DataTableTh dense className="hidden sm:table-cell">Auto</DataTableTh>
                <DataTableTh dense align="right" className="hidden sm:table-cell">Actions</DataTableTh>
              </tr>
            </thead>
            <tbody>
              {diskSaved.length === 0 && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={7} className={`${dataTableEmptyCellClass} text-xs text-text-muted`}>
                    No removable drives adopted. Adopt one from the Detected list below.
                  </td>
                </tr>
              )}
              {diskSaved.map((row) => {
                const diskState = (detectedDisks || []).find((d) => d.uuid === row.uuid);
                const present = !!diskState;
                /* Authoritative mount state comes from the live disk stream (mountedAt), not settings status poll. */
                const mounted = !!(diskState && diskState.mountedAt === row.mountPath);

                const mountBtnClass = mounted
                  ? 'border-status-running/30 bg-status-running-soft text-status-running hover:bg-status-running-soft'
                  : present
                    ? 'border-surface-border bg-surface text-text-secondary hover:bg-surface-hover'
                    : 'border-status-stopped/30 bg-status-stopped-soft text-status-stopped hover:bg-status-stopped-soft';

                const expanded = expandedId === row.id;
                const dot = mounted
                  ? { tone: 'green', label: 'Mounted' }
                  : present
                    ? { tone: 'gray', label: 'Present, not mounted' }
                    : { tone: 'red', label: 'Disconnected' };
                const actionButtons = (
                  <>
                    {present && (
                      <button type="button" onClick={() => handleMountToggle(row.id, mounted)} disabled={rowBusy(row.id)} className={`${tintedActionBtnBase} ${mountBtnClass}`} title={mounted ? 'Unmount drive' : 'Mount drive'} aria-label={mounted ? 'Unmount drive' : 'Mount drive'}>
                        {rowCommands.toggling(row.id) ? <Loader2 size={14} className="animate-spin" aria-hidden /> : mounted ? <Unplug size={14} aria-hidden /> : <Plug size={14} aria-hidden />}
                      </button>
                    )}
                    <button type="button" onClick={() => openEdit(row)} disabled={rowBusy(row.id)} className={rowActionIconBtn} title="Edit" aria-label="Edit drive">
                      <Pencil size={14} aria-hidden />
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(row)} disabled={rowBusy(row.id)} className={`${rowActionIconBtn} text-text-muted hover:text-status-stopped hover:bg-status-stopped-soft`} title="Remove" aria-label="Remove drive">
                      {rowCommands.deleting(row.id) ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Trash2 size={14} aria-hidden />}
                    </button>
                  </>
                );

                return (
                  <tr
                    key={row.id}
                    className={`${dataTableInteractiveRowClass} cursor-pointer sm:cursor-auto`}
                    onClick={() => setExpandedId((prev) => (prev === row.id ? null : row.id))}
                  >
                    <DataTableTd dense className="text-sm">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <StatusDot tone={dot.tone} label={dot.label} />
                        <span className="shrink-0 text-text-primary">{truncate(row.label, 24)}</span>
                        <span className="font-mono text-xs text-text-muted sm:hidden">{row.fsType || '—'}</span>
                      </div>
                      <div className="mt-0.5 pl-4 sm:hidden">
                        <span className="block truncate font-mono text-xs text-text-muted">{row.mountPath}</span>
                      </div>
                      {expanded && (
                        /* Tap-to-expand action strip (phones only) */
                        <div className="mt-2 flex items-center gap-1.5 pl-4 sm:hidden" onClick={(e) => e.stopPropagation()}>
                          {actionButtons}
                        </div>
                      )}
                    </DataTableTd>
                    <DataTableTd dense className="hidden text-sm font-mono text-text-muted sm:table-cell">
                      {shortUuid(row.uuid)}
                    </DataTableTd>
                    <DataTableTd dense className="hidden text-sm font-mono text-text-secondary sm:table-cell">
                      {row.fsType || '—'}
                    </DataTableTd>
                    <DataTableTd dense className="hidden text-sm font-mono text-text-secondary sm:table-cell">
                      {truncate(row.mountPath, 28)}
                    </DataTableTd>
                    <DataTableTd dense className="hidden text-sm sm:table-cell">
                      <input type="checkbox" checked={row.readOnly === true} disabled readOnly title={row.fsType === 'ntfs3' ? 'NTFS mounts are read-only' : 'Read-only mount'} />
                    </DataTableTd>
                    <DataTableTd dense className="hidden text-sm sm:table-cell">
                      <input type="checkbox" checked={row.autoMount !== false} disabled readOnly title="Auto-mount on device insertion" />
                    </DataTableTd>
                    <DataTableTd dense align="right" className="hidden sm:table-cell">
                      <div onClick={(e) => e.stopPropagation()}>
                        <DataTableRowActions forceVisible={rowBusy(row.id)}>
                          {actionButtons}
                        </DataTableRowActions>
                      </div>
                    </DataTableTd>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        </DataTableScroll>
      </div>

      {unadoptedDetected.length > 0 && (
        <div className="space-y-2">
          <SubHeading label="Detected drives" hint="Adopt saves the UUID and mount settings. Auto-mount triggers on re-insertion." />
          <DataTableScroll>
            <DataTable>
              <thead>
                <tr className={dataTableHeadRowClass}>
                  <DataTableTh dense>Device</DataTableTh>
                  <DataTableTh dense className="hidden sm:table-cell">Label</DataTableTh>
                  <DataTableTh dense className="hidden sm:table-cell">FS</DataTableTh>
                  <DataTableTh dense className="hidden sm:table-cell">Size</DataTableTh>
                  <DataTableTh dense className="hidden sm:table-cell">Mounted at</DataTableTh>
                  <DataTableTh dense align="right">Actions</DataTableTh>
                </tr>
              </thead>
              <tbody>
                {unadoptedDetected.map((d) => {
                  const supported = SUPPORTED_FSTYPES.includes(d.fsType);
                  const mountedElsewhere = d.mountedAt && !d.mountedAt.startsWith('/mnt/wisp');
                  return (
                    <tr key={d.uuid} className={dataTableBodyRowClass}>
                      <DataTableTd dense className="text-sm">
                        <div className="flex items-center gap-2">
                          <HardDrive size={12} className="text-text-muted" />
                          <div className="flex flex-col">
                            <span className="text-text-primary">{truncate([d.vendor, d.model].filter(Boolean).join(' ') || d.devPath, 30)}</span>
                            <span className="text-[10px] text-text-muted font-mono">{d.devPath} · {shortUuid(d.uuid)}</span>
                            <span className="text-[10px] text-text-muted font-mono sm:hidden">
                              {d.fsType || '—'} · {formatBytes(d.sizeBytes)}
                              {d.mountedAt ? ` · ${truncate(d.mountedAt, 24)}` : ''}
                            </span>
                          </div>
                        </div>
                      </DataTableTd>
                      <DataTableTd dense className="hidden text-sm sm:table-cell">
                        <span className="text-text-secondary">{truncate(d.label, 20)}</span>
                      </DataTableTd>
                      <DataTableTd dense className="hidden text-sm font-mono sm:table-cell">{d.fsType || '—'}</DataTableTd>
                      <DataTableTd dense className="hidden text-sm font-mono text-text-muted sm:table-cell">{formatBytes(d.sizeBytes)}</DataTableTd>
                      <DataTableTd dense className="hidden text-xs font-mono text-text-muted sm:table-cell">{d.mountedAt ? truncate(d.mountedAt, 28) : '—'}</DataTableTd>
                      <DataTableTd dense align="right">
                        <button
                          type="button"
                          onClick={() => openAdopt(d)}
                          disabled={!supported || mountedElsewhere}
                          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none ${supported && !mountedElsewhere ? 'bg-accent text-white hover:bg-accent-hover' : 'border border-surface-border bg-surface text-text-muted'}`}
                          title={
                            !supported
                              ? `Filesystem ${d.fsType || 'unknown'} not supported`
                              : mountedElsewhere
                                ? `Already mounted at ${d.mountedAt}`
                                : 'Adopt drive — configure mount settings'
                          }
                        >
                          Adopt
                        </button>
                      </DataTableTd>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          </DataTableScroll>
        </div>
      )}
      <RemovableDriveEditorModal
        open={editor.open}
        drive={editor.drive}
        adoptDisk={editor.adoptDisk}
        onClose={closeEditor}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        title="Remove adopted drive?"
        confirmLabel="Remove"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleRemoveConfirm}
      >
        Removes <span className="font-mono">{confirmDelete?.label || confirmDelete?.uuid || 'this drive'}</span>{' '}
        from Wisp. If the drive is currently mounted at{' '}
        <span className="font-mono">{confirmDelete?.mountPath}</span> it will be unmounted and the mount point
        directory removed. Data on the drive itself is not touched.
      </ConfirmDialog>
    </div>
  );
}

/* -------------------------------- helpers -------------------------------- */

function SubHeading({ label, hint, headerAction }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-baseline gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</h4>
        {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
      </div>
      {headerAction}
    </div>
  );
}

const STATUS_DOT_TONES = {
  green: 'bg-status-running',
  gray: 'bg-text-muted/40',
  red: 'bg-status-stopped',
};

/** Mount-state dot shown before the row label (replaces the old Status column). */
function StatusDot({ tone, label }) {
  const cls = STATUS_DOT_TONES[tone] || STATUS_DOT_TONES.gray;
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 self-center rounded-full ${cls}`}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}
