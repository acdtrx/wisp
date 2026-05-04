import { useState, useEffect } from 'react';
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
  Save,
  X,
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
  rowActionIconBtnPrimary,
} from '../shared/DataTableChrome.jsx';
import {
  attachDiskToVM,
  createDiskOnVM,
  detachDiskFromVM,
  resizeDisk,
  updateDiskBus,
  attachISO,
  ejectISO,
} from '../../api/vms.js';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

const DISK_BUS_OPTIONS = [
  { value: 'virtio', label: 'VirtIO' },
  { value: 'scsi', label: 'VirtIO SCSI' },
  { value: 'sata', label: 'SATA' },
  { value: 'ide', label: 'IDE' },
];

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
const imageColClass = 'min-w-0 max-w-[7rem] w-[7rem]';

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
  /** Inline edit for sda/sdb: size (GB) + bus; Save calls API. */
  const [diskEdit, setDiskEdit] = useState(null);
  /** Secondary disk (sdb) draft: confirm runs create or attach+optional resize. */
  const [sdbDraft, setSdbDraft] = useState(null);
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

  useEffect(() => {
    if (sdb) setSdbDraft(null);
  }, [sdb]);

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
    const imagePath = file._fullPath || `/var/lib/wisp/images/${file.name}`;
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
    if (ctx?.type === 'disk' && ctx.defer && ctx.slot === 'sdb') {
      setSdbDraft({
        mode: 'existing',
        path: imagePath,
        name: file.name,
        resizeGB: null,
        bus: sda?.bus || 'virtio',
      });
      return;
    }
    if (ctx?.type === 'disk') {
      executeDiskOperation(`attach-${ctx.slot}`, () => attachDiskToVM(vmName, ctx.slot, imagePath, 'virtio'));
    } else if (ctx?.type === 'cdrom') {
      executeDiskOperation(`iso-${ctx.slot}`, () => attachISO(vmName, ctx.slot, imagePath));
    }
  }

  function startDiskEdit(slot) {
    const d = slot === 'sda' ? sda : sdb;
    setDiskEdit({
      slot,
      sizeGB: d?.sizeGiB != null ? String(d.sizeGiB) : '',
      bus: d?.bus || 'virtio',
    });
  }

  function saveDiskEdit() {
    if (!diskEdit) return;
    const { slot, sizeGB, bus } = diskEdit;
    const disk = slot === 'sda' ? sda : sdb;
    const newSize = parseFloat(sizeGB);
    if (Number.isNaN(newSize) || newSize <= 0) {
      setError('Enter a valid size in GB.');
      return;
    }
    const prevBus = disk?.bus || 'virtio';
    const busChanged = bus !== prevBus;
    const sizeChanged =
      disk?.sizeGiB == null || Math.abs(newSize - Number(disk.sizeGiB)) > 0.001;

    if (!busChanged && !sizeChanged) {
      setDiskEdit(null);
      return;
    }

    executeDiskOperation(
      `disk-edit-${slot}`,
      async () => {
        if (busChanged) {
          await updateDiskBus(vmName, slot, bus);
        }
        if (sizeChanged) {
          await resizeDisk(vmName, slot, newSize);
        }
      },
      () => setDiskEdit(null),
    );
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

  const canAddDisk = sda && !sdb && isStopped && !sdbDraft;

  function confirmSdbDraft() {
    if (!sdbDraft) return;
    if (sdbDraft.mode === 'new') {
      const { sizeGB, bus } = sdbDraft;
      const gb = Math.max(1, parseInt(sizeGB, 10) || 32);
      executeDiskOperation('create-sdb', () => createDiskOnVM(vmName, 'sdb', gb, bus));
      return;
    }
    const { path, bus, resizeGB } = sdbDraft;
    executeDiskOperation('attach-sdb', async () => {
      await attachDiskToVM(vmName, 'sdb', path, bus);
      const target = resizeGB != null && resizeGB > 0 ? Number(resizeGB) : null;
      if (target != null && !Number.isNaN(target)) {
        await resizeDisk(vmName, 'sdb', target);
      }
    });
  }

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
          {canAddDisk && (
            <>
              <button
                type="button"
                onClick={() =>
                  setSdbDraft({ mode: 'new', sizeGB: 32, bus: sda?.bus || 'virtio' })
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
                onClick={() => openPicker({ type: 'disk', slot: 'sdb', defer: true })}
                className="inline-flex items-center gap-0.5 rounded-md bg-accent px-2 py-1.5 text-white hover:bg-accent-hover transition-colors duration-150"
                title="Select existing disk image (confirm in table)"
                aria-label="Select disk image"
              >
                <Plus size={14} aria-hidden />
                <FileImage size={14} aria-hidden />
              </button>
            </>
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
          <DataTable minWidthRem={52}>
            <thead>
              <tr className={dataTableHeadRowClass}>
                <DataTableTh dense className="w-14">
                  Disk
                </DataTableTh>
                <DataTableTh dense className="w-24">
                  Size
                </DataTableTh>
                <DataTableTh dense className="max-w-[7rem] w-[7rem]">
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
      helpText="Edit a disk from its row Actions menu — stop the VM first to change size or bus. ISO attach, change, and eject work while the VM is running."
      error={error}
      headerAction={headerActions}
    >
      <DataTableScroll>
        <DataTable minWidthRem={52}>
          <thead>
            <tr className={dataTableHeadRowClass}>
              <DataTableTh dense className="w-14">
                Disk
              </DataTableTh>
              <DataTableTh dense className="w-24">
                Size
              </DataTableTh>
              <DataTableTh dense className="max-w-[7rem] w-[7rem]">
                Image
              </DataTableTh>
              <DataTableTh dense className="w-20">
                Image type
              </DataTableTh>
              <DataTableTh dense className="w-32">
                Bus
              </DataTableTh>
              <DataTableTh dense align="right" className="w-36">
                Actions
              </DataTableTh>
            </tr>
          </thead>
          <tbody>
            <tr className={dataTableInteractiveRowClass}>
              <DataTableTd dense className="text-xs font-semibold text-text-secondary">sda</DataTableTd>
              <DataTableTd dense className="text-xs max-w-[9rem]">
                {diskEdit?.slot === 'sda' ? (
                  <label className="flex items-center gap-1 text-[11px] text-text-secondary">
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={diskEdit.sizeGB}
                      onChange={(e) =>
                        setDiskEdit((prev) =>
                          prev?.slot === 'sda' ? { ...prev, sizeGB: e.target.value } : prev,
                        )
                      }
                      className="w-16 rounded border border-surface-border px-1.5 py-0.5 text-xs tabular-nums outline-none focus:border-accent"
                    />
                    <span>GB</span>
                  </label>
                ) : (
                  <span className="text-xs text-text-primary tabular-nums">
                    {sda?.sizeGiB != null ? `${sda.sizeGiB} GB` : '—'}
                  </span>
                )}
              </DataTableTd>
              <DataTableTd dense className={imageColClass}>
                <span className="truncate text-xs text-text-primary block" title={sda?.source || ''}>
                  {formatSource(sda?.source) || '—'}
                </span>
              </DataTableTd>
              <DataTableTd dense className="text-xs text-text-muted">{formatImageType(sda)}</DataTableTd>
              <DataTableTd dense className="text-xs">
                {diskEdit?.slot === 'sda' ? (
                  <select
                    value={diskEdit.bus}
                    onChange={(e) =>
                      setDiskEdit((prev) =>
                        prev?.slot === 'sda' ? { ...prev, bus: e.target.value } : prev,
                      )
                    }
                    className="max-w-full rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
                  >
                    {DISK_BUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-text-muted">{formatDriverLabel(sda) || '—'}</span>
                )}
              </DataTableTd>
              <DataTableTd dense align="right">
                <DiskRowActions
                  slot="sda"
                  disk={sda}
                  isStopped={isStopped}
                  loading={loading}
                  editing={diskEdit?.slot === 'sda'}
                  onEdit={() => startDiskEdit('sda')}
                  onSave={saveDiskEdit}
                  onCancel={() => setDiskEdit(null)}
                  onDetach={() => executeDiskOperation('detach-sda', () => detachDiskFromVM(vmName, 'sda'))}
                />
              </DataTableTd>
            </tr>

            {!sdb && sdbDraft && isStopped && (
              <tr className={dataTableInteractiveRowClass}>
                <DataTableTd dense className="text-xs font-semibold text-text-secondary">sdb</DataTableTd>
                <DataTableTd dense className="text-xs text-text-primary">
                  {sdbDraft.mode === 'new' ? (
                    <label className="flex items-center gap-1 text-[11px] text-text-secondary">
                      <input
                        type="number"
                        min={1}
                        value={sdbDraft.sizeGB}
                        onChange={(e) =>
                          setSdbDraft((d) =>
                            d?.mode === 'new'
                              ? { ...d, sizeGB: parseInt(e.target.value, 10) || 32 }
                              : d,
                          )
                        }
                        className="w-16 rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
                      />
                      <span>GB</span>
                    </label>
                  ) : (
                    <label className="flex flex-col gap-0.5 text-[10px] text-text-muted">
                      <span>Optional resize after attach</span>
                      <input
                        type="number"
                        min={1}
                        placeholder="GB"
                        value={sdbDraft.resizeGB ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setSdbDraft((d) =>
                            d?.mode === 'existing'
                              ? { ...d, resizeGB: v === '' ? null : parseFloat(v) }
                              : d,
                          );
                        }}
                        className="w-20 rounded border border-surface-border px-1.5 py-0.5 text-xs text-text-primary outline-none focus:border-accent"
                      />
                    </label>
                  )}
                </DataTableTd>
                <DataTableTd dense className={`${imageColClass} text-xs text-text-primary`}>
                  {sdbDraft.mode === 'existing' ? (
                    <span className="truncate block" title={sdbDraft.path}>
                      {sdbDraft.name}
                    </span>
                  ) : (
                    <span className="text-text-muted">—</span>
                  )}
                </DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">
                  {sdbDraft.mode === 'existing' ? guessImageTypeFromFileName(sdbDraft.name) : '—'}
                </DataTableTd>
                <DataTableTd dense>
                  <select
                    value={sdbDraft.bus}
                    onChange={(e) =>
                      setSdbDraft((d) => (d ? { ...d, bus: e.target.value } : d))
                    }
                    className="max-w-full rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
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
                      onClick={confirmSdbDraft}
                      disabled={!!loading}
                      className={rowActionIconBtnPrimary}
                      title={sdbDraft.mode === 'new' ? 'Create disk' : 'Attach disk'}
                      aria-label="Confirm"
                    >
                      {loading === 'create-sdb' || loading === 'attach-sdb' ? (
                        <Loader2 size={14} className="animate-spin" aria-hidden />
                      ) : (
                        <Check size={14} aria-hidden />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSdbDraft(null)}
                      disabled={!!loading}
                      className={`${iconBtn} text-text-muted`}
                      title="Cancel"
                      aria-label="Cancel"
                    >
                      <CircleX size={14} aria-hidden />
                    </button>
                  </DataTableRowActions>
                </DataTableTd>
              </tr>
            )}

            {sdb && (
              <tr className={dataTableInteractiveRowClass}>
                <DataTableTd dense className="text-xs font-semibold text-text-secondary">sdb</DataTableTd>
                <DataTableTd dense className="text-xs max-w-[9rem]">
                  {diskEdit?.slot === 'sdb' ? (
                    <label className="flex items-center gap-1 text-[11px] text-text-secondary">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={diskEdit.sizeGB}
                        onChange={(e) =>
                          setDiskEdit((prev) =>
                            prev?.slot === 'sdb' ? { ...prev, sizeGB: e.target.value } : prev,
                          )
                        }
                        className="w-16 rounded border border-surface-border px-1.5 py-0.5 text-xs tabular-nums outline-none focus:border-accent"
                      />
                      <span>GB</span>
                    </label>
                  ) : (
                    <span className="text-xs text-text-primary tabular-nums">
                      {sdb.sizeGiB != null ? `${sdb.sizeGiB} GB` : '—'}
                    </span>
                  )}
                </DataTableTd>
                <DataTableTd dense className={imageColClass}>
                  <span className="truncate text-xs text-text-primary block" title={sdb.source || ''}>
                    {formatSource(sdb.source) || '—'}
                  </span>
                </DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">{formatImageType(sdb)}</DataTableTd>
                <DataTableTd dense className="text-xs">
                  {diskEdit?.slot === 'sdb' ? (
                    <select
                      value={diskEdit.bus}
                      onChange={(e) =>
                        setDiskEdit((prev) =>
                          prev?.slot === 'sdb' ? { ...prev, bus: e.target.value } : prev,
                        )
                      }
                      className="max-w-full rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
                    >
                      {DISK_BUS_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-text-muted">{formatDriverLabel(sdb) || '—'}</span>
                  )}
                </DataTableTd>
                <DataTableTd dense align="right">
                  <DiskRowActions
                    slot="sdb"
                    disk={sdb}
                    isStopped={isStopped}
                    loading={loading}
                    editing={diskEdit?.slot === 'sdb'}
                    onEdit={() => startDiskEdit('sdb')}
                    onSave={saveDiskEdit}
                    onCancel={() => setDiskEdit(null)}
                    onDetach={() =>
                      executeDiskOperation('detach-sdb', () => detachDiskFromVM(vmName, 'sdb'))
                    }
                  />
                </DataTableTd>
              </tr>
            )}

            {sdc?.source && (
              <tr className={dataTableInteractiveRowClass}>
                <DataTableTd dense className="text-xs font-semibold text-text-secondary">sdc</DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">—</DataTableTd>
                <DataTableTd dense className={`${imageColClass} text-xs`}>
                  <span className="truncate text-xs text-text-primary block" title={sdc.source}>
                    {formatSource(sdc.source)}
                  </span>
                </DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">{formatImageType(sdc)}</DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">{formatDriverLabel(sdc) || '—'}</DataTableTd>
                <DataTableTd dense align="right">
                  <CdromRowActions
                    slot="sdc"
                    loading={loading}
                    onSwap={() => openPicker({ type: 'cdrom', slot: 'sdc' })}
                    onEject={() => executeDiskOperation('eject-sdc', () => ejectISO(vmName, 'sdc'))}
                  />
                </DataTableTd>
              </tr>
            )}

            {sdd?.source && (
              <tr className={dataTableInteractiveRowClass}>
                <DataTableTd dense className="text-xs font-semibold text-text-secondary">sdd</DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">—</DataTableTd>
                <DataTableTd dense className={`${imageColClass} text-xs`}>
                  <span className="truncate text-xs text-text-primary block" title={sdd.source}>
                    {formatSource(sdd.source)}
                  </span>
                </DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">{formatImageType(sdd)}</DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">{formatDriverLabel(sdd) || '—'}</DataTableTd>
                <DataTableTd dense align="right">
                  <CdromRowActions
                    slot="sdd"
                    loading={loading}
                    onSwap={() => openPicker({ type: 'cdrom', slot: 'sdd' })}
                    onEject={() => executeDiskOperation('eject-sdd', () => ejectISO(vmName, 'sdd'))}
                  />
                </DataTableTd>
              </tr>
            )}

            {sde && (
              <tr className={dataTableBodyRowClass}>
                <DataTableTd dense className="text-xs font-semibold text-text-secondary">sde</DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">—</DataTableTd>
                <DataTableTd dense className={`${imageColClass} text-xs`}>
                  {sde.source ? (
                    <span className="truncate text-xs text-text-primary block" title={sde.source}>
                      {formatSource(sde.source)}
                    </span>
                  ) : (
                    <span className="text-xs text-text-muted">—</span>
                  )}
                </DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">{formatImageType(sde)}</DataTableTd>
                <DataTableTd dense className="text-xs text-text-muted">{formatDriverLabel(sde) || 'SATA'}</DataTableTd>
                <DataTableTd dense align="right" />
              </tr>
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

function DiskRowActions({
  slot,
  disk,
  isStopped,
  loading,
  editing,
  onEdit,
  onSave,
  onCancel,
  onDetach,
}) {
  const isSaving = loading === `disk-edit-${slot}`;
  const isDetaching = loading?.startsWith(`detach-${slot}`);
  const busy = !!loading;

  if (editing) {
    return (
      <DataTableRowActions forceVisible={isSaving}>
        <button
          type="button"
          onClick={onSave}
          disabled={busy && !isSaving}
          className={rowActionIconBtnPrimary}
          title="Save size and bus"
          aria-label={`Save ${slot}`}
        >
          {isSaving ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={isSaving}
          className={`${iconBtn} text-text-muted`}
          title="Cancel editing"
          aria-label={`Cancel edit ${slot}`}
        >
          <X size={14} aria-hidden />
        </button>
      </DataTableRowActions>
    );
  }

  return (
    <DataTableRowActions forceVisible={isDetaching}>
      {isStopped && disk?.source && (
        <>
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className={`${iconBtn} hover:bg-surface`}
            title="Edit size and bus"
            aria-label={`Edit ${slot}`}
          >
            <Pencil size={14} aria-hidden />
          </button>
          <button
            type="button"
            onClick={onDetach}
            disabled={busy}
            className={`${iconBtn} hover:bg-red-50 hover:text-status-stopped`}
            title="Unmount disk"
            aria-label={`Unmount ${slot}`}
          >
            {isDetaching ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Minus size={14} aria-hidden />}
          </button>
        </>
      )}
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
        className={`${iconBtn} hover:bg-surface`}
        title="Change ISO"
        aria-label={`Change ISO in ${slot}`}
      >
        <FileImage size={14} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onEject}
        disabled={!!loading}
        className={`${iconBtn} hover:bg-amber-50`}
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
                className="w-16 rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
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
                className="w-16 rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
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
            className="max-w-full rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
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
                className="w-16 rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
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
                className="w-16 rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
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
            className="max-w-full rounded border border-surface-border px-1.5 py-0.5 text-xs outline-none focus:border-accent"
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
              className={`${iconBtn} hover:bg-red-50 hover:text-status-stopped`}
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
          <button type="button" onClick={onClear} className={`${iconBtn} hover:bg-amber-50`} title="Remove ISO" aria-label="Remove ISO">
            <CircleX size={14} aria-hidden />
          </button>
        </DataTableRowActions>
      </DataTableTd>
    </tr>
  );
}
