import { useEffect, useState } from 'react';
import RadioPills from '../shared/RadioPills.jsx';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  FormField,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { listFiles } from '../../api/library.js';
import {
  attachDiskToVM,
  createDiskOnVM,
  resizeDisk,
  updateDiskBus,
} from '../../api/vms.js';
import { formatSize } from '../../utils/formatters.js';

const FORM_ID = 'disk-editor-form';

export const DISK_BUS_OPTIONS = [
  { value: 'virtio', label: 'VirtIO' },
  { value: 'scsi', label: 'VirtIO SCSI' },
  { value: 'sata', label: 'SATA' },
  { value: 'ide', label: 'IDE' },
];

/** Library images live in one flat directory — the same path the picker builds. */
export function libraryImagePath(file) {
  return file._fullPath || `/var/lib/wisp/images/${file.name}`;
}

const ADD_MODE_OPTIONS = [
  { value: 'new', label: 'New disk' },
  { value: 'existing', label: 'Existing image' },
];

function AddModePills({ value, onChange }) {
  return <RadioPills options={ADD_MODE_OPTIONS} value={value} onChange={onChange} />;
}

function formFromDisk(disk, defaultBus) {
  if (disk) {
    return {
      mode: 'new',
      sizeGB: disk.sizeGiB != null ? String(disk.sizeGiB) : '',
      bus: disk.bus || 'virtio',
      imagePath: '',
      resizeGB: '',
    };
  }
  return { mode: 'new', sizeGB: '32', bus: defaultBus || 'virtio', imagePath: '', resizeGB: '' };
}

function positiveNumber(value) {
  const n = parseFloat(value);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

/**
 * Modal form editor for one VM block disk (see docs/UI-PATTERNS.md § Modal form
 * editor). Two entry points: edit — the `disk` row (`sda` / `sdb`) with its size
 * and bus — or add, with `disk` null, where the mode picker chooses between a
 * new empty volume and attaching a library image (plain select; the full
 * ImageLibraryModal stays the direct-action path for ISO slots).
 *
 * Saves through the same row-scoped disk APIs and in the same order the inline
 * editors used, then `onSaved` (parent refresh) before closing; stays open on
 * failure.
 */
export default function DiskEditorModal({
  open,
  vmName,
  slot,
  disk = null,
  defaultBus = 'virtio',
  onSaved,
  onClose,
}) {
  const [form, setForm] = useState(() => formFromDisk(null, 'virtio'));
  const [images, setImages] = useState([]);
  const [imagesLoading, setImagesLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isEdit = disk != null;

  useEffect(() => {
    if (!open) return;
    setForm(formFromDisk(disk, defaultBus));
    setError(null);
  }, [open, disk]);

  /* The attach-existing select needs the library's disk images — the same list
   * the picker shows under its Disk filter. Fetched when the add modal opens. */
  useEffect(() => {
    if (!open || isEdit) return undefined;
    let cancelled = false;
    setImagesLoading(true);
    listFiles('disk')
      .then((files) => {
        if (!cancelled) setImages(Array.isArray(files) ? files : []);
      })
      .catch((err) => {
        if (!cancelled) {
          setImages([]);
          setError(err.message || 'Failed to load the image library');
        }
      })
      .finally(() => {
        if (!cancelled) setImagesLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, isEdit]);

  const setField = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  const isAttach = !isEdit && form.mode === 'existing';
  const sizeValue = positiveNumber(form.sizeGB);
  const sizeError = !isAttach && form.sizeGB !== '' && sizeValue == null
    ? 'Enter a valid size in GB.'
    : null;
  const resizeValue = form.resizeGB === '' ? null : positiveNumber(form.resizeGB);
  const resizeError = isAttach && form.resizeGB !== '' && resizeValue == null
    ? 'Enter a valid size in GB, or leave empty to keep the image size.'
    : null;
  const imageError = isAttach && !form.imagePath ? 'Select a library image.' : null;

  const prevBus = disk?.bus || 'virtio';
  const busChanged = isEdit && form.bus !== prevBus;
  /* The listed size is rounded to whole GiB, so treat sub-GiB deltas as no change. */
  const sizeChanged = isEdit && sizeValue != null
    && (disk?.sizeGiB == null || Math.abs(sizeValue - Number(disk.sizeGiB)) > 0.001);

  const invalid = !!(sizeError || resizeError || imageError)
    || (!isAttach && sizeValue == null);
  const dirty = isEdit ? busChanged || sizeChanged : true;
  const canSave = !invalid && dirty && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        if (busChanged) await updateDiskBus(vmName, slot, form.bus);
        if (sizeChanged) await resizeDisk(vmName, slot, sizeValue);
      } else if (isAttach) {
        await attachDiskToVM(vmName, slot, form.imagePath, form.bus);
        if (resizeValue != null) await resizeDisk(vmName, slot, resizeValue);
      } else {
        await createDiskOnVM(vmName, slot, Math.max(1, parseInt(form.sizeGB, 10) || 32), form.bus);
      }
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const busField = (
    <FormField label="Bus" htmlFor="disk-editor-bus">
      <select
        id="disk-editor-bus"
        value={form.bus}
        onChange={(e) => setField('bus', e.target.value)}
        className="input-field"
      >
        {DISK_BUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FormField>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit disk' : 'Add disk'}
      subtitle={`${slot} · ${vmName}`}
      size="md"
      height="cap"
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={formModalNeutralBtn}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} disabled={!canSave} className={formModalPrimaryBtn}>
            {saving && <Loader2 size={14} className="animate-spin" aria-hidden />}
            {isEdit ? 'Save' : isAttach ? 'Attach' : 'Create'}
          </button>
        </>
      )}
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => { e.preventDefault(); handleSave(); }}
        className="space-y-3"
      >
        {!isEdit && (
          <FormField label="Source">
            <AddModePills
              value={form.mode}
              onChange={(v) => setField('mode', v)}
            />
          </FormField>
        )}

        {isAttach && (
          <FormField
            label="Image"
            htmlFor="disk-editor-image"
            hint={imageError || 'Disk images from the library; the original file is attached as-is.'}
          >
            <select
              id="disk-editor-image"
              value={form.imagePath}
              onChange={(e) => setField('imagePath', e.target.value)}
              disabled={imagesLoading}
              autoFocus
              className="input-field"
            >
              <option value="">{imagesLoading ? 'Loading…' : 'Select…'}</option>
              {images.map((file) => (
                <option key={file.name} value={libraryImagePath(file)}>
                  {`${file.name} · ${formatSize(file.size)}`}
                </option>
              ))}
            </select>
          </FormField>
        )}

        {isAttach ? (
          <FormField
            label="Resize after attach"
            htmlFor="disk-editor-resize"
            hint={resizeError || 'Optional — leave empty to keep the image size. Disks can only grow.'}
          >
            <div className="flex items-center gap-2">
              <input
                id="disk-editor-resize"
                type="number"
                min={1}
                step={1}
                value={form.resizeGB}
                onChange={(e) => setField('resizeGB', e.target.value)}
                placeholder="optional"
                className="input-field w-28 text-right font-mono"
              />
              <span className="text-xs text-text-muted">GB</span>
            </div>
          </FormField>
        ) : (
          <FormField
            label="Size"
            htmlFor="disk-editor-size"
            hint={sizeError || (isEdit ? 'Disks can only grow — shrinking is not supported.' : null)}
          >
            <div className="flex items-center gap-2">
              <input
                id="disk-editor-size"
                type="number"
                min={1}
                step={1}
                value={form.sizeGB}
                onChange={(e) => setField('sizeGB', e.target.value)}
                autoFocus={!isEdit}
                className="input-field w-28 text-right font-mono"
              />
              <span className="text-xs text-text-muted">GB</span>
            </div>
          </FormField>
        )}

        {busField}

        <FormModalError error={error} />
      </form>
    </Modal>
  );
}
