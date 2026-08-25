import { useState } from 'react';
import {
  HardDrive,
  Disc,
  CircleX,
  Plus,
  Minus,
  Loader2,
  Check,
  FileImage,
  Pencil,
  Lock,
} from 'lucide-react';
import SectionCard from '../shared/SectionCard.jsx';
import ImageLibraryModal from '../shared/ImageLibraryModal.jsx';
import {
  DataTableScroll,
  DataTable,
  dataTableHeadRowClass,
  dataTableBodyRowClass,
  dataTableInteractiveRowClass,
  DataTableRowActions,
  DataTableTh,
  DataTableTd,
  dataTableCellPadX,
  rowActionIconBtn,
  rowActionIconBtnPrimary,
} from '../shared/DataTableChrome.jsx';
import DiskEditorModal, { libraryImagePath } from './DiskEditorModal.jsx';
import {
  detachDiskFromVM,
  attachISO,
  ejectISO,
} from '../../api/vms.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

/* Caps the phone-only stacked lines so the two-column table never scrolls
   sideways; the desktop columns size themselves as before. */
const phoneLineClamp = 'block max-w-[60vw] truncate sm:max-w-none';

function formatSource(source) {
  if (!source) return null;
  const parts = source.split('/');
  return parts[parts.length - 1];
}

function formatDriverLabel(disk) {
  if (!disk) return null;
  if (disk.bus) {
    if (disk.bus === 'virtio') return 'VirtIO';
    if (disk.bus === 'scsi') return 'VirtIO SCSI';
    return disk.bus.toUpperCase();
  }
  return disk.driverType || null;
}

/** Driver / format for Image type column (qcow2, raw, ISO, …). */
function formatImageType(disk) {
  if (!disk) return '—';
  if (disk.slot === 'sde') return 'cloud-init';
  if (disk.device === 'cdrom') {
    if (disk.source && /\.iso$/i.test(disk.source)) return 'ISO';
    return disk.driverType || 'raw';
  }
  return disk.driverType || '—';
}

function guessImageTypeFromFileName(name) {
  if (!name || typeof name !== 'string') return '—';
  const lower = name.toLowerCase();
  if (lower.endsWith('.qcow2')) return 'qcow2';
  if (lower.endsWith('.raw') || lower.endsWith('.img')) return 'raw';
  if (lower.endsWith('.vmdk')) return 'vmdk';
  return '—';
}

/** Narrow filename column — keeps the table balanced vs Size. */
const imageColClass = 'min-w-0 max-w-28 w-28';

export default function DisksSection({
  vmConfig,
  onRefresh,
  isCreating,
  createDisk,
  onCreateDiskChange,
  createDisk2,
  onCreateDisk2Change,
  cdrom1Path,
  cdrom2Path,
  onCdromChange,
}) {
  const isStopped = vmConfig.state === 'shutoff' || vmConfig.state === 'nostate' || isCreating;
  const vmName = vmConfig.name;

  const [loading, setLoading] = useState(null);
  const [error, setError] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerContext, setPickerContext] = useState(null);
  /* The disk is snapshotted when the editor opens so a background refresh of
   * `vmConfig.disks` can't reset the open form; `disk` is null when adding. */
  const [editor, setEditor] = useState({ open: false, slot: 'sdb', disk: null });
  /** Create VM: draft for adding sda/sdb from header (new or existing image picked). */
  const [createDiskDraft, setCreateDiskDraft] = useState(null);

  const localDisks = (vmConfig.disks || []).filter((d) => d.device === 'disk');
  const cdroms = (vmConfig.disks || []).filter((d) => d.device === 'cdrom');

  const sda = localDisks.find((d) => d.slot === 'sda');
  const sdb = localDisks.find((d) => d.slot === 'sdb');
  const sdc = cdroms.find((d) => d.slot === 'sdc');
  const sdd = cdroms.find((d) => d.slot === 'sdd');
  const sde = cdroms.find((d) => d.slot === 'sde');

  const disk =
    createDisk || {
      type: 'none',
      sizeGB: 32,
      bus: 'virtio',
      sourcePath: null,
      sourceName: null,
      resizeGB: null,
    };
  const disk2 =
    createDisk2 || {
      type: 'none',
      sizeGB: 32,
      bus: 'virtio',
      sourcePath: null,
      sourceName: null,
      resizeGB: null,
    };

  async function executeDiskOperation(actionName, fn, afterSuccess) {
    setLoading(actionName);
    setError(null);
    try {
      await fn();
      if (typeof afterSuccess === 'function') afterSuccess();
      if (onRefresh) await onRefresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(null);
    }
  }

  function openPicker(context) {
    setPickerContext(context);
    setPickerOpen(true);
  }

  function handlePickerSelect(file) {
    const imagePath = libraryImagePath(file);
    const ctx = pickerContext;
    setPickerOpen(false);
    setPickerContext(null);

    if (isCreating && ctx) {
      if (ctx.type === 'disk') {
        if (ctx.defer) {
          const bus =
            ctx.slot === 'sda'
              ? disk?.bus || 'virtio'
              : disk2?.bus || disk?.bus || 'virtio';
          setCreateDiskDraft({
            slot: ctx.slot,
            mode: 'existing',
            path: imagePath,
            name: file.name,
            resizeGB: null,
            bus,
          });
        } else if (ctx.slot === 'sda' && onCreateDiskChange) {
          onCreateDiskChange({ ...disk, type: 'existing', sourcePath: imagePath, sourceName: file.name });
        } else if (ctx.slot === 'sdb' && onCreateDisk2Change) {
          onCreateDisk2Change({ ...disk2, type: 'existing', sourcePath: imagePath, sourceName: file.name });
        }
      } else if (ctx.type === 'cdrom' && ctx.slot && onCdromChange) {
        onCdromChange(ctx.slot, imagePath, file.name);
      }
      return;
    }
    /* Non-create: the only picker context left is the ISO slots — block disks
     * are added and edited in DiskEditorModal. */
    if (ctx?.type === 'cdrom') {
      executeDiskOperation(`iso-${ctx.slot}`, () => attachISO(vmName, ctx.slot, imagePath));
    }
  }

  function openDiskEditor(slot) {
    setError(null);
    const existing = slot === 'sda' ? sda : sdb;
    setEditor({ open: true, slot, disk: existing || null });
  }

  function handlePlusCdrom() {
    if (!sdc?.source) {
      openPicker({ type: 'cdrom', slot: 'sdc' });
      return;
    }
    if (!sdd?.source) {
      openPicker({ type: 'cdrom', slot: 'sdd' });
    }
  }

  function canAddAnotherCdrom() {
    return !sdc?.source || !sdd?.source;
  }

  /* The second slot is free — the button is disabled, not hidden, while the VM runs. */
  const sdbSlotFree = !!sda && !sdb;

  const canAddFirstCreateDisk =
    !!isCreating && disk.type === 'none' && !createDiskDraft;
  const canAddSecondCreateDisk =
    !!isCreating &&
    disk.type !== 'none' &&
    disk2.type === 'none' &&
    !createDiskDraft;

  function confirmCreateDiskDraft() {
    if (!createDiskDraft) return;
    const d = createDiskDraft;
    const baseBus = d.bus || 'virtio';
    if (d.slot === 'sda') {
      if (d.mode === 'new') {
        onCreateDiskChange?.({
          type: 'new',
          sizeGB: Math.max(1, parseInt(d.sizeGB, 10) || 32),
          bus: baseBus,
          sourcePath: null,
          sourceName: null,
          resizeGB: null,
        });
      } else {
        onCreateDiskChange?.({
          type: 'existing',
          sourcePath: d.path,
          sourceName: d.name,
          bus: baseBus,
          resizeGB: d.resizeGB != null && d.resizeGB > 0 ? Number(d.resizeGB) : null,
        });
      }
    } else if (d.slot === 'sdb') {
      if (d.mode === 'new') {
        onCreateDisk2Change?.({
          type: 'new',
          sizeGB: Math.max(1, parseInt(d.sizeGB, 10) || 32),
          bus: baseBus,
          sourcePath: null,
          sourceName: null,
          resizeGB: null,
        });
      } else {
        onCreateDisk2Change?.({
          type: 'existing',
          sourcePath: d.path,
          sourceName: d.name,
          bus: baseBus,
          resizeGB: d.resizeGB != null && d.resizeGB > 0 ? Number(d.resizeGB) : null,
        });
      }
    }
    setCreateDiskDraft(null);
  }

  function clearCreateDiskSlot(slot) {
    if (slot === 'sda') {
      onCreateDiskChange?.({
        type: 'none',
        sizeGB: 32,
        bus: disk.bus || 'virtio',
        sourcePath: null,
        sourceName: null,
        resizeGB: null,
      });
      onCreateDisk2Change?.({
        type: 'none',
        sizeGB: 32,
        bus: 'virtio',
        sourcePath: null,
        sourceName: null,
        resizeGB: null,
      });
    } else {
      onCreateDisk2Change?.({
        type: 'none',
        sizeGB: 32,
        bus: disk2.bus || 'virtio',
        sourcePath: null,
        sourceName: null,
        resizeGB: null,
      });
    }
  }

  const headerActions = isCreating
    ? (
        <div className="flex items-center gap-1.5">
          {canAddFirstCreateDisk && (
            <>
              <button
                type="button"
                onClick={() =>
                  setCreateDiskDraft({
                    slot: 'sda',
                    mode: 'new',
                    sizeGB: 32,
                    bus: 'virtio',
                  })
                }
                className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
                title="New empty disk (confirm in table)"
                aria-label="New disk"
              >
                <Plus size={14} aria-hidden />
                <HardDrive size={14} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => openPicker({ type: 'disk', slot: 'sda', defer: true })}
                className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
                title="Select existing disk image (confirm in table)"
                aria-label="Select disk image"
              >
                <Plus size={14} aria-hidden />
                <FileImage size={14} aria-hidden />
              </button>
            </>
          )}
          {canAddSecondCreateDisk && (
            <>
              <button
                type="button"
                onClick={() =>
                  setCreateDiskDraft({
                    slot: 'sdb',
                    mode: 'new',
                    sizeGB: 32,
                    bus: disk.bus || 'virtio',
                  })
                }
                className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
                title="New empty second disk (confirm in table)"
                aria-label="New second disk"
              >
                <Plus size={14} aria-hidden />
                <HardDrive size={14} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => openPicker({ type: 'disk', slot: 'sdb', defer: true })}
                className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
                title="Select existing image for second disk (confirm in table)"
                aria-label="Select second disk image"
              >
                <Plus size={14} aria-hidden />
                <FileImage size={14} aria-hidden />
              </button>
            </>
          )}
          {(!cdrom1Path || !cdrom2Path) && (
            <button
              type="button"
              onClick={() => {
                if (!cdrom1Path) openPicker({ type: 'cdrom', slot: 'sdc' });
                else if (!cdrom2Path) openPicker({ type: 'cdrom', slot: 'sdd' });
              }}
              className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
              title="Attach ISO (opens image library)"
              aria-label="Attach ISO"
            >
              <Plus size={14} aria-hidden />
              <Disc size={14} aria-hidden />
            </button>
          )}
        </div>
      )
    : (
        <div className="flex items-center gap-1.5">
          {sdbSlotFree && (
            <button
              type="button"
              onClick={() => openDiskEditor('sdb')}
              disabled={!isStopped}
              className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
              title={isStopped ? 'Add a second disk (new or from the library)' : 'Stop the VM to add a disk'}
              aria-label="Add disk"
            >
              <Plus size={14} aria-hidden />
              <HardDrive size={14} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={handlePlusCdrom}
            disabled={!canAddAnotherCdrom()}
            className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none"
            title="Attach ISO (opens image library)"
            aria-label="Attach ISO"
          >
            <Plus size={14} aria-hidden />
            <Disc size={14} aria-hidden />
          </button>
        </div>
      );

  if (isCreating) {
    const showCreateEmptyHint =
      disk.type === 'none' &&
      disk2.type === 'none' &&
      !createDiskDraft;
    return (
      <SectionCard
        title="Disks"
        titleIcon={<HardDrive size={14} strokeWidth={2} />}
        helpText="Add disks or attach an ISO from the header. Original images are never modified — copies are created for new VMs."
        error={error}
        headerAction={headerActions}
      >
        <DataTableScroll>
          <DataTable>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense className="w-14">
                  Disk
                </DataTableTh>
                <DataTableTh dense className="w-24">
                  Size
                </DataTableTh>
                <DataTableTh dense className="max-w-28 w-28">
                  Image
                </DataTableTh>
                <DataTableTh dense className="w-20">
                  Image type
                </DataTableTh>
                <DataTableTh dense className="w-32">
                  Bus
                </DataTableTh>
                <DataTableTh dense align="right" className="w-28">
                  Actions
                </DataTableTh>
              </tr>
            </thead>
            <tbody>
              {showCreateEmptyHint && (
                <tr className={dataTableBodyRowClass}>
                  <td colSpan={6} className={`${dataTableCellPadX} py-3 text-xs text-text-muted`}>
                    No block disks yet. Use the buttons in the section header to add a disk or attach an ISO.
                  </td>
                </tr>
              )}
              {createDiskDraft?.slot === 'sda' && (
                <CreateDiskDraftTableRow
                  draft={createDiskDraft}
                  setDraft={setCreateDiskDraft}
                  onConfirm={confirmCreateDiskDraft}
                  onCancel={() => setCreateDiskDraft(null)}
                />
              )}
              {disk.type !== 'none' && (
                <CreateCommittedDiskRow
                  slot="sda"
                  disk={disk}
                  onChange={onCreateDiskChange}
                  onRemove={() => clearCreateDiskSlot('sda')}
                />
              )}
              {createDiskDraft?.slot === 'sdb' && (
                <CreateDiskDraftTableRow
                  draft={createDiskDraft}
                  setDraft={setCreateDiskDraft}
                  onConfirm={confirmCreateDiskDraft}
                  onCancel={() => setCreateDiskDraft(null)}
                />
              )}
              {disk2.type !== 'none' && (
                <CreateCommittedDiskRow
                  slot="sdb"
                  disk={disk2}
                  onChange={onCreateDisk2Change}
                  onRemove={() => clearCreateDiskSlot('sdb')}
                />
              )}
              {cdrom1Path && (
                <CreateCdromTableRow
                  slot="sdc"
                  path={cdrom1Path}
                  onClear={() => onCdromChange?.('sdc', null, null)}
                />
              )}
              {cdrom2Path && (
                <CreateCdromTableRow
                  slot="sdd"
                  path={cdrom2Path}
                  onClear={() => onCdromChange?.('sdd', null, null)}
                />
              )}
            </tbody>
          </DataTable>
        </DataTableScroll>
        <ImageLibraryModal
          open={pickerOpen}
          onClose={() => {
            setPickerOpen(false);
            setPickerContext(null);
          }}
          onSelect={handlePickerSelect}
          defaultFilter={pickerContext?.type === 'cdrom' ? 'iso' : 'disk'}
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Disks"
      titleIcon={<HardDrive size={14} strokeWidth={2} />}
      helpText="Add or edit a block disk in a form — the VM must be stopped to add, resize, re-bus, or detach one. ISO attach, change, and eject work while it runs."
      error={error}
      headerAction={headerActions}
    >
      <DataTableScroll>
        <DataTable>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense className="sm:w-14">
                Disk
              </DataTableTh>
              <DataTableTh dense className="hidden w-24 sm:table-cell">
                Size
              </DataTableTh>
              <DataTableTh dense className="hidden max-w-28 w-28 sm:table-cell">
                Image
              </DataTableTh>
              <DataTableTh dense className="hidden w-20 sm:table-cell">
                Image type
              </DataTableTh>
              <DataTableTh dense className="hidden w-32 sm:table-cell">
                Bus
              </DataTableTh>
              <DataTableTh dense align="right" className="sm:w-36">
                Actions
              </DataTableTh>
            </tr>
          </thead>
          <tbody>
            <BlockDiskRow
              slot="sda"
              disk={sda}
              isStopped={isStopped}
              loading={loading}
              onEdit={() => openDiskEditor('sda')}
              onDetach={() => executeDiskOperation('detach-sda', () => detachDiskFromVM(vmName, 'sda'))}
            />

            {sdb && (
              <BlockDiskRow
                slot="sdb"
                disk={sdb}
                isStopped={isStopped}
                loading={loading}
                onEdit={() => openDiskEditor('sdb')}
                onDetach={() => executeDiskOperation('detach-sdb', () => detachDiskFromVM(vmName, 'sdb'))}
              />
            )}

            {sdc?.source && (
              <CdromRow
                slot="sdc"
                disk={sdc}
                loading={loading}
                onSwap={() => openPicker({ type: 'cdrom', slot: 'sdc' })}
                onEject={() => executeDiskOperation('eject-sdc', () => ejectISO(vmName, 'sdc'))}
              />
            )}

            {sdd?.source && (
              <CdromRow
                slot="sdd"
                disk={sdd}
                loading={loading}
                onSwap={() => openPicker({ type: 'cdrom', slot: 'sdd' })}
                onEject={() => executeDiskOperation('eject-sdd', () => ejectISO(vmName, 'sdd'))}
              />
            )}

            {sde && <CdromRow slot="sde" disk={sde} loading={loading} />}
          </tbody>
        </DataTable>
      </DataTableScroll>

      {!isStopped && (
        <p className="mt-2 flex items-center gap-1 text-[11px] text-text-muted">
          <Lock size={11} aria-hidden />
          Stop the VM to add, resize, re-bus, or detach block disks.
        </p>
      )}

      <DiskEditorModal
        open={editor.open}
        vmName={vmName}
        slot={editor.slot}
        disk={editor.disk}
        defaultBus={sda?.bus || 'virtio'}
        onSaved={onRefresh}
        onClose={() => setEditor({ open: false, slot: 'sdb', disk: null })}
      />

      <ImageLibraryModal
        open={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
          setPickerContext(null);
        }}
        onSelect={handlePickerSelect}
        defaultFilter={pickerContext?.type === 'cdrom' ? 'iso' : 'disk'}
      />
    </SectionCard>
  );
}

/**
 * Detail-page block disk row (sda / sdb) — read-only cells; Size, Image, Image
 * type, and Bus collapse into stacked lines under the slot label below `sm`.
 */
function BlockDiskRow({ slot, disk, isStopped, loading, onEdit, onDetach }) {
  const sizeText = disk?.sizeGiB != null ? `${disk.sizeGiB} GB` : '—';
  const busText = formatDriverLabel(disk) || '—';
  const imageName = formatSource(disk?.source) || '—';

  return (
    <tr className={dataTableInteractiveRowClass}>
      <DataTableTd dense valign="top" className="min-w-0 sm:w-14 sm:align-middle">
        <span className="block text-xs font-semibold text-text-secondary">{slot}</span>
        {/* The columns hidden below `sm` stack here instead. */}
        <span className={`${phoneLineClamp} mt-0.5 text-xs text-text-primary sm:hidden`} title={disk?.source || ''}>
          {imageName}
        </span>
        <span className={`${phoneLineClamp} text-[11px] text-text-muted sm:hidden`}>
          {`${sizeText} · ${busText} · ${formatImageType(disk)}`}
        </span>
      </DataTableTd>
      <DataTableTd dense className="hidden w-24 sm:table-cell">
        <span className="text-xs text-text-primary tabular-nums">{sizeText}</span>
      </DataTableTd>
      <DataTableTd dense className={`hidden sm:table-cell ${imageColClass}`}>
        <span className="truncate text-xs text-text-primary block" title={disk?.source || ''}>
          {imageName}
        </span>
      </DataTableTd>
      <DataTableTd dense className="hidden text-xs text-text-muted sm:table-cell">
        {formatImageType(disk)}
      </DataTableTd>
      <DataTableTd dense className="hidden text-xs text-text-muted sm:table-cell">{busText}</DataTableTd>
      <DataTableTd dense align="right">
        <DiskRowActions
          slot={slot}
          disk={disk}
          isStopped={isStopped}
          loading={loading}
          onEdit={onEdit}
          onDetach={onDetach}
        />
      </DataTableTd>
    </tr>
  );
}

/**
 * Detail-page CDROM row (sdc / sdd, and the read-only cloud-init seed sde,
 * which passes no handlers and so renders an empty Actions cell).
 */
function CdromRow({ slot, disk, loading, onSwap, onEject }) {
  const imageName = formatSource(disk?.source) || '—';
  const busText = formatDriverLabel(disk) || (slot === 'sde' ? 'SATA' : '—');
  const interactive = !!onSwap || !!onEject;

  return (
    <tr className={interactive ? dataTableInteractiveRowClass : dataTableBodyRowClass}>
      <DataTableTd dense valign="top" className="min-w-0 sm:w-14 sm:align-middle">
        <span className="block text-xs font-semibold text-text-secondary">{slot}</span>
        {/* The columns hidden below `sm` stack here instead. */}
        <span className={`${phoneLineClamp} mt-0.5 text-xs text-text-primary sm:hidden`} title={disk?.source || ''}>
          {imageName}
        </span>
        <span className={`${phoneLineClamp} text-[11px] text-text-muted sm:hidden`}>
          {`${busText} · ${formatImageType(disk)}`}
        </span>
      </DataTableTd>
      <DataTableTd dense className="hidden w-24 text-xs text-text-muted sm:table-cell">—</DataTableTd>
      <DataTableTd dense className={`hidden sm:table-cell ${imageColClass}`}>
        <span className="truncate text-xs text-text-primary block" title={disk?.source || ''}>
          {imageName}
        </span>
      </DataTableTd>
      <DataTableTd dense className="hidden text-xs text-text-muted sm:table-cell">
        {formatImageType(disk)}
      </DataTableTd>
      <DataTableTd dense className="hidden text-xs text-text-muted sm:table-cell">{busText}</DataTableTd>
      <DataTableTd dense align="right">
        {interactive && (
          <CdromRowActions slot={slot} loading={loading} onSwap={onSwap} onEject={onEject} />
        )}
      </DataTableTd>
    </tr>
  );
}

/** Row actions for a block disk: edit (modal) and detach, both offline-only. */
function DiskRowActions({ slot, disk, isStopped, loading, onEdit, onDetach }) {
  const isDetaching = loading === `detach-${slot}`;
  const busy = !!loading;

  if (!disk?.source) return null;

  return (
    <DataTableRowActions forceVisible={isDetaching}>
      <button
        type="button"
        onClick={onEdit}
        disabled={busy || !isStopped}
        className={rowActionIconBtn}
        title={isStopped ? 'Edit size and bus' : 'Stop the VM to change size or bus'}
        aria-label={`Edit ${slot}`}
      >
        <Pencil size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onDetach}
        disabled={busy || !isStopped}
        className={`${rowActionIconBtn} hover:bg-status-stopped-soft hover:text-status-stopped`}
        title={isStopped ? 'Unmount disk' : 'Stop the VM to unmount disks'}
        aria-label={`Unmount ${slot}`}
      >
        {isDetaching ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Minus size={14} aria-hidden />}
      </button>
    </DataTableRowActions>
  );
}

function CdromRowActions({ slot, loading, onSwap, onEject }) {
  const isLoading = loading?.includes(slot);
  return (
    <DataTableRowActions forceVisible={isLoading}>
      <button
        type="button"
        onClick={onSwap}
        disabled={!!loading}
        className={rowActionIconBtn}
        title="Change ISO"
        aria-label={`Change ISO in ${slot}`}
      >
        <FileImage size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onEject}
        disabled={!!loading}
        className={`${rowActionIconBtn} hover:bg-status-warning-soft`}
        title="Eject ISO"
        aria-label={`Eject ISO from ${slot}`}
      >
        {isLoading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <CircleX size={14} aria-hidden />}
      </button>
    </DataTableRowActions>
  );
}

/** Create VM: confirm/cancel row after choosing New or picking an image (defer). */
function CreateDiskDraftTableRow({ draft, setDraft, onConfirm, onCancel }) {
  const slot = draft.slot;
  return (
    <>
      <tr className={dataTableInteractiveRowClass}>
        <DataTableTd dense className="text-xs font-semibold text-text-secondary">{slot}</DataTableTd>
        <DataTableTd dense className="text-xs text-text-primary">
          {draft.mode === 'new' ? (
            <label className="flex items-center gap-1 text-[11px] text-text-secondary">
              <input
                type="number"
                min={1}
                value={draft.sizeGB}
                onChange={(e) =>
                  setDraft((d) =>
                    d && d.mode === 'new'
                      ? { ...d, sizeGB: parseInt(e.target.value, 10) || 32 }
                      : d,
                  )
                }
                className="w-16 rounded-sm border border-surface-border px-1.5 py-0.5 text-xs outline-hidden focus:border-accent"
              />
              <span>GB</span>
            </label>
          ) : (
            <label className="flex items-center gap-1 text-[11px] text-text-secondary">
              <input
                type="number"
                min={1}
                placeholder="optional"
                value={draft.resizeGB ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft((d) =>
                    d?.mode === 'existing' ? { ...d, resizeGB: v === '' ? null : parseFloat(v) } : d,
                  );
                }}
                className="w-16 rounded-sm border border-surface-border px-1.5 py-0.5 text-xs outline-hidden focus:border-accent"
              />
              <span>GB</span>
            </label>
          )}
        </DataTableTd>
        <DataTableTd dense className={`${imageColClass} text-xs text-text-primary`}>
          {draft.mode === 'existing' ? (
            <span className="truncate block" title={draft.path}>
              {draft.name}
            </span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </DataTableTd>
        <DataTableTd dense className="text-xs text-text-muted">
          {draft.mode === 'existing' ? guessImageTypeFromFileName(draft.name) : '—'}
        </DataTableTd>
        <DataTableTd dense>
          <select
            value={draft.bus}
            onChange={(e) => setDraft((d) => (d ? { ...d, bus: e.target.value } : d))}
            className="max-w-full rounded-sm border border-surface-border px-1.5 py-0.5 text-xs outline-hidden focus:border-accent"
          >
            <option value="virtio">VirtIO</option>
            <option value="scsi">VirtIO SCSI</option>
            <option value="sata">SATA</option>
            <option value="ide">IDE</option>
          </select>
        </DataTableTd>
        <DataTableTd dense align="right">
          <DataTableRowActions forceVisible>
            <button
              type="button"
              onClick={onConfirm}
              className={rowActionIconBtnPrimary}
              title={draft.mode === 'new' ? 'Add disk' : 'Add disk from image'}
              aria-label="Confirm"
            >
              <Check size={14} aria-hidden />
            </button>
            <button
              type="button"
              onClick={onCancel}
              className={`${iconBtn} text-text-muted`}
              title="Cancel"
              aria-label="Cancel"
            >
              <CircleX size={14} aria-hidden />
            </button>
          </DataTableRowActions>
        </DataTableTd>
      </tr>
    </>
  );
}

/** Create VM: committed block disk row (no New/Existing toggles — use header to add). */
function CreateCommittedDiskRow({ slot, disk, onChange, onRemove }) {
  const type = disk?.type || 'none';
  const sizeGB = disk?.sizeGB ?? 32;
  const bus = disk?.bus || 'virtio';
  const sourceName = disk?.sourceName || disk?.sourcePath?.split('/').pop();
  const resizeGB = disk?.resizeGB;

  const imageCell =
    type === 'new' ? (
      <span className="text-xs text-text-muted">New volume</span>
    ) : (
      <div className="flex flex-wrap items-center gap-1">
        {sourceName && (
          <span className="truncate text-xs text-text-primary" title={disk?.sourcePath}>
            {sourceName}
          </span>
        )}
      </div>
    );

  const imageTypeCell =
    type === 'new' ? '—' : type === 'existing' && sourceName ? guessImageTypeFromFileName(sourceName) : '—';

  return (
    <tr key={slot} className={dataTableInteractiveRowClass}>
        <DataTableTd dense className="text-xs font-semibold text-text-secondary">{slot}</DataTableTd>
        <DataTableTd dense className="text-xs text-text-primary">
          {type === 'new' ? (
            <label className="flex items-center gap-1 text-[11px] text-text-secondary">
              <input
                type="number"
                min={1}
                value={sizeGB}
                onChange={(e) => onChange?.({ ...disk, sizeGB: parseInt(e.target.value, 10) || 32 })}
                className="w-16 rounded-sm border border-surface-border px-1.5 py-0.5 text-xs outline-hidden focus:border-accent"
              />
              <span>GB</span>
            </label>
          ) : type === 'existing' && sourceName ? (
            <label className="flex items-center gap-1 text-[11px] text-text-secondary">
              <input
                type="number"
                min={1}
                placeholder="optional"
                value={resizeGB ?? ''}
                onChange={(e) =>
                  onChange?.({
                    ...disk,
                    resizeGB: e.target.value === '' ? null : parseFloat(e.target.value),
                  })
                }
                className="w-16 rounded-sm border border-surface-border px-1.5 py-0.5 text-xs outline-hidden focus:border-accent"
              />
              <span>GB</span>
            </label>
          ) : (
            <span className="text-xs text-text-muted">—</span>
          )}
        </DataTableTd>
        <DataTableTd dense className={imageColClass}>{imageCell}</DataTableTd>
        <DataTableTd dense className="text-xs text-text-muted">{imageTypeCell}</DataTableTd>
        <DataTableTd dense>
          <select
            value={bus}
            onChange={(e) => onChange?.({ ...disk, bus: e.target.value })}
            className="max-w-full rounded-sm border border-surface-border px-1.5 py-0.5 text-xs outline-hidden focus:border-accent"
          >
            <option value="virtio">VirtIO</option>
            <option value="scsi">VirtIO SCSI</option>
            <option value="sata">SATA</option>
            <option value="ide">IDE</option>
          </select>
        </DataTableTd>
        <DataTableTd dense align="right">
          <DataTableRowActions forceVisible>
            <button
              type="button"
              onClick={onRemove}
              className={`${iconBtn} hover:bg-status-stopped-soft hover:text-status-stopped`}
              title="Remove disk"
              aria-label={`Remove ${slot}`}
            >
              <Minus size={14} aria-hidden />
            </button>
          </DataTableRowActions>
        </DataTableTd>
      </tr>
  );
}

function CreateCdromTableRow({ slot, path, onClear }) {
  const name = path ? path.split('/').pop() : null;
  return (
    <tr className={dataTableInteractiveRowClass}>
      <DataTableTd dense className="text-xs font-semibold text-text-secondary">{slot}</DataTableTd>
      <DataTableTd dense className="text-xs text-text-muted">—</DataTableTd>
      <DataTableTd dense className={`${imageColClass} text-xs`}>
        {name ? <span className="truncate text-xs text-text-primary block">{name}</span> : <span className="text-xs text-text-muted">—</span>}
      </DataTableTd>
      <DataTableTd dense className="text-xs text-text-muted">ISO</DataTableTd>
      <DataTableTd dense className="text-xs text-text-muted">SATA</DataTableTd>
      <DataTableTd dense align="right">
        <DataTableRowActions forceVisible>
          <button type="button" onClick={onClear} className={`${iconBtn} hover:bg-status-warning-soft`} title="Remove ISO" aria-label="Remove ISO">
            <CircleX size={14} aria-hidden />
          </button>
        </DataTableRowActions>
      </DataTableTd>
    </tr>
  );
}
