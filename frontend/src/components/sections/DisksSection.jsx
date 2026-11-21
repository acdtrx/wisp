import { useState } from 'react';
import {
  HardDrive,
  Disc,
  CircleX,
  Plus,
  Minus,
  Check,
  FileImage,
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
import { libraryImagePath } from './DiskEditorModal.jsx';

const iconBtn =
  'inline-flex items-center justify-center rounded-md border border-surface-border p-1.5 text-text-secondary hover:bg-surface transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';

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

/**
 * The Create VM panel's disks and ISOs: the panel's draft (`draft`: `disk`, `disk2`, the
 * CD-ROM paths) is the only state; every write goes through `onDraft(update)`.
 */
export default function DisksSection({ draft, onDraft }) {
  const setCreateSlot = (slot, update) => onDraft((d) => ({ ...d, [slot]: update(d[slot]) }));
  const setCdrom = (slot, path, name) => onDraft((d) => ({
    ...d,
    [slot === 'sdc' ? 'cdrom1Path' : 'cdrom2Path']: path,
    [slot === 'sdc' ? 'cdrom1Name' : 'cdrom2Name']: name,
  }));
  const cdrom1Path = draft?.cdrom1Path ?? null;
  const cdrom2Path = draft?.cdrom2Path ?? null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerContext, setPickerContext] = useState(null);
  /* The new disk row open in create mode: its slot and starting values. The row is an
   * input to adding a disk to the draft: it keeps its own values until confirmed. */
  const [newDiskRow, setNewDiskRow] = useState(null);

  const disk =
    draft?.disk || {
      type: 'none',
      sizeGB: 32,
      bus: 'virtio',
      sourcePath: null,
      sourceName: null,
      resizeGB: null,
    };
  const disk2 =
    draft?.disk2 || {
      type: 'none',
      sizeGB: 32,
      bus: 'virtio',
      sourcePath: null,
      sourceName: null,
      resizeGB: null,
    };

  function openPicker(context) {
    setPickerContext(context);
    setPickerOpen(true);
  }

  function handlePickerSelect(file) {
    const imagePath = libraryImagePath(file);
    const ctx = pickerContext;
    setPickerOpen(false);
    setPickerContext(null);

    if (ctx) {
      if (ctx.type === 'disk') {
        if (ctx.defer) {
          const bus =
            ctx.slot === 'sda'
              ? disk?.bus || 'virtio'
              : disk2?.bus || disk?.bus || 'virtio';
          setNewDiskRow({
            slot: ctx.slot,
            mode: 'existing',
            path: imagePath,
            name: file.name,
            resizeGB: null,
            bus,
          });
        } else {
          setCreateSlot(ctx.slot === 'sda' ? 'disk' : 'disk2', (cur) => ({ ...cur, type: 'existing', sourcePath: imagePath, sourceName: file.name }));
        }
      } else if (ctx.type === 'cdrom' && ctx.slot) {
        setCdrom(ctx.slot, imagePath, file.name);
      }
    }
  }

  const canAddFirstCreateDisk =
    disk.type === 'none' && !newDiskRow;
  const canAddSecondCreateDisk =
    disk.type !== 'none' &&
    disk2.type === 'none' &&
    !newDiskRow;

  function confirmNewDisk(d) {
    const baseBus = d.bus || 'virtio';
    if (d.slot === 'sda') {
      if (d.mode === 'new') {
        setCreateSlot('disk', () => ({
          type: 'new',
          sizeGB: Math.max(1, parseInt(d.sizeGB, 10) || 32),
          bus: baseBus,
          sourcePath: null,
          sourceName: null,
          resizeGB: null,
        }));
      } else {
        setCreateSlot('disk', () => ({
          type: 'existing',
          sourcePath: d.path,
          sourceName: d.name,
          bus: baseBus,
          resizeGB: d.resizeGB != null && d.resizeGB > 0 ? Number(d.resizeGB) : null,
        }));
      }
    } else if (d.slot === 'sdb') {
      if (d.mode === 'new') {
        setCreateSlot('disk2', () => ({
          type: 'new',
          sizeGB: Math.max(1, parseInt(d.sizeGB, 10) || 32),
          bus: baseBus,
          sourcePath: null,
          sourceName: null,
          resizeGB: null,
        }));
      } else {
        setCreateSlot('disk2', () => ({
          type: 'existing',
          sourcePath: d.path,
          sourceName: d.name,
          bus: baseBus,
          resizeGB: d.resizeGB != null && d.resizeGB > 0 ? Number(d.resizeGB) : null,
        }));
      }
    }
    setNewDiskRow(null);
  }

  function clearCreateDiskSlot(slot) {
    if (slot === 'sda') {
      setCreateSlot('disk', (cur) => ({
        type: 'none',
        sizeGB: 32,
        bus: cur?.bus || 'virtio',
        sourcePath: null,
        sourceName: null,
        resizeGB: null,
      }));
      setCreateSlot('disk2', () => ({
        type: 'none',
        sizeGB: 32,
        bus: 'virtio',
        sourcePath: null,
        sourceName: null,
        resizeGB: null,
      }));
    } else {
      setCreateSlot('disk2', (cur) => ({
        type: 'none',
        sizeGB: 32,
        bus: cur?.bus || 'virtio',
        sourcePath: null,
        sourceName: null,
        resizeGB: null,
      }));
    }
  }

  const headerActions = (
        <div className="flex items-center gap-1.5">
          {canAddFirstCreateDisk && (
            <>
              <button
                type="button"
                onClick={() =>
                  setNewDiskRow({
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
                  setNewDiskRow({
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
  );

  {
    const showCreateEmptyHint =
      disk.type === 'none' &&
      disk2.type === 'none' &&
      !newDiskRow;
    return (
      <SectionCard
        title="Disks"
        titleIcon={<HardDrive size={14} strokeWidth={2} />}
        helpText="Add disks or attach an ISO from the header. Original images are never modified — copies are created for new VMs."
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
              {newDiskRow?.slot === 'sda' && (
                <NewDiskRow
                  key={`${newDiskRow.mode}:${newDiskRow.path ?? ''}`}
                  initial={newDiskRow}
                  onConfirm={confirmNewDisk}
                  onCancel={() => setNewDiskRow(null)}
                />
              )}
              {disk.type !== 'none' && (
                <CreateCommittedDiskRow
                  slot="sda"
                  disk={disk}
                  onChange={(changes) => setCreateSlot('disk', (cur) => ({ ...cur, ...changes }))}
                  onRemove={() => clearCreateDiskSlot('sda')}
                />
              )}
              {newDiskRow?.slot === 'sdb' && (
                <NewDiskRow
                  key={`${newDiskRow.mode}:${newDiskRow.path ?? ''}`}
                  initial={newDiskRow}
                  onConfirm={confirmNewDisk}
                  onCancel={() => setNewDiskRow(null)}
                />
              )}
              {disk2.type !== 'none' && (
                <CreateCommittedDiskRow
                  slot="sdb"
                  disk={disk2}
                  onChange={(changes) => setCreateSlot('disk2', (cur) => ({ ...cur, ...changes }))}
                  onRemove={() => clearCreateDiskSlot('sdb')}
                />
              )}
              {cdrom1Path && (
                <CreateCdromTableRow
                  slot="sdc"
                  path={cdrom1Path}
                  onClear={() => setCdrom('sdc', null, null)}
                />
              )}
              {cdrom2Path && (
                <CreateCdromTableRow
                  slot="sdd"
                  path={cdrom2Path}
                  onClear={() => setCdrom('sdd', null, null)}
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

}

function NewDiskRow({ initial, onConfirm, onCancel }) {
  const [values, setValues] = useState(initial);
  const slot = values.slot;
  return (
    <>
      <tr className={dataTableInteractiveRowClass}>
        <DataTableTd dense className="text-xs font-semibold text-text-secondary">{slot}</DataTableTd>
        <DataTableTd dense className="text-xs text-text-primary">
          {values.mode === 'new' ? (
            <label className="flex items-center gap-1 text-[11px] text-text-secondary">
              <input
                type="number"
                min={1}
                value={values.sizeGB}
                onChange={(e) =>
                  setValues((d) =>
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
                value={values.resizeGB ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setValues((d) =>
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
          {values.mode === 'existing' ? (
            <span className="truncate block" title={values.path}>
              {values.name}
            </span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </DataTableTd>
        <DataTableTd dense className="text-xs text-text-muted">
          {values.mode === 'existing' ? guessImageTypeFromFileName(values.name) : '—'}
        </DataTableTd>
        <DataTableTd dense>
          <select
            value={values.bus}
            onChange={(e) => setValues((d) => (d ? { ...d, bus: e.target.value } : d))}
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
              onClick={() => onConfirm(values)}
              className={rowActionIconBtnPrimary}
              title={values.mode === 'new' ? 'Add disk' : 'Add disk from image'}
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
                onChange={(e) => onChange?.({ sizeGB: parseInt(e.target.value, 10) || 32 })}
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
            onChange={(e) => onChange?.({ bus: e.target.value })}
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
