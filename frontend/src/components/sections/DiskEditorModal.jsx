import RadioPills from '../shared/RadioPills.jsx';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import RecordError from '../shared/RecordError.jsx';
import {
  FormField,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import {
  attachDiskToVM,
  createDiskOnVM,
  resizeDisk,
  updateDiskBus,
} from '../../api/vms.js';
import { formatSize } from '../../utils/formatters.js';
import { autoFocusField } from '../../lib/focus.js';
import { RECORD } from '../../store/records.js';
import { useRecord } from '../../hooks/useRecord.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';

const FORM_ID = 'disk-editor-form';

const DISK_BUS_OPTIONS = [
  { value: 'virtio', label: 'VirtIO' },
  { value: 'scsi', label: 'VirtIO SCSI' },
  { value: 'sata', label: 'SATA' },
  { value: 'ide', label: 'IDE' },
];

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

/** The library's disk images (the picker's Disk filter), read while this select shows. */
function LibraryDiskSelect({ value, onChange }) {
  const library = useRecord(RECORD.LIBRARY);
  const images = (library.data ?? []).filter((f) => f.type === 'disk');
  const loading = library.status === 'loading';
  return (
    <>
      <select
        id="disk-editor-image"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={loading}
        ref={autoFocusField}
        className="input-field"
      >
        {/* "None in the library" only for a read that succeeded empty. */}
        <option value="">{loading ? 'Loading…' : library.data == null ? 'Library unavailable' : images.length ? 'Select…' : 'No disk images in the library'}</option>
        {images.map((file) => (
          <option key={file.name} value={file.name}>
            {`${file.name} · ${formatSize(file.size)}`}
          </option>
        ))}
      </select>
      <RecordError record={library} what="library" className="mt-1" />
    </>
  );
}

/**
 * Modal form editor for one VM block disk (see docs/FRONTEND-RULES.md § Modal form
 * editor). Two entry points: edit — the `disk` row (`sda` / `sdb`) with its size
 * and bus — or add, with `disk` null, where the mode picker chooses between a
 * new empty volume and attaching a library image (plain select; the full
 * ImageLibraryModal stays the direct-action path for ISO slots).
 *
 * It takes the disk's values when it opens. Saves through the same row-scoped disk
 * APIs and in the same order the inline editors used, each one ending at its answer;
 * closes after the last, stays open on failure.
 */
export default function DiskEditorModal(props) {
  return props.open ? <DiskEditor {...props} /> : null;
}

/** What an edit's Save writes: the bus, and the size to 0.001 GiB (the listed size is
 *  rounded to whole GiB, so a sub-GiB delta is no change). */
function editSent(form) {
  const size = positiveNumber(form.sizeGB);
  return { bus: form.bus, size: size == null ? null : Math.round(size * 1000) / 1000 };
}

/** What a disk editor's values lack to be saved, by the field each is about: attaching,
 *  an image and an optional resize; else a size. */
function diskProblems(form) {
  const problems = {};
  if (form.mode === 'existing') {
    if (!form.imagePath) problems.imagePath = 'Select a library image.';
    if (form.resizeGB !== '' && positiveNumber(form.resizeGB) == null) {
      problems.resizeGB = 'Enter a valid size in GB, or leave empty to keep the image size.';
    }
  } else if (positiveNumber(form.sizeGB) == null) {
    problems.sizeGB = 'Enter a valid size in GB.';
  }
  return problems;
}

function DiskEditor({
  open,
  vmName,
  slot,
  editing,
  disk = null,
  defaultBus = 'virtio',
  onClose,
}) {
  const isEdit = editing;
  /* The disk's values as the editor opened: it never reads the VM's config again. */
  const { form, start, setField, dirty } = useEditor(() => formFromDisk(isEdit ? disk : null, defaultBus));
  const save = useCommand();
  const saving = save.busy;

  const isAttach = !isEdit && form.mode === 'existing';
  const sizeValue = positiveNumber(form.sizeGB);
  const problems = diskProblems(form);
  const blocked = Object.values(problems)[0] ?? null;
  /* A cleared size says nothing under the field (Save says why it is off). */
  const sizeError = form.sizeGB !== '' ? problems.sizeGB ?? null : null;
  const resizeValue = form.resizeGB === '' ? null : positiveNumber(form.resizeGB);
  const resizeError = problems.resizeGB ?? null;
  const imageError = problems.imagePath ?? null;
  /* An edit needs a change; a new disk only valid values. */
  const canSave = !blocked && (!isEdit || dirty) && !saving;

  /* One command, of one to two requests in the order the inline editors used, ending at
   * the last answer. */
  const handleSave = () => {
    if (!canSave) return;
    const values = editSent(form);
    const saved = editSent(start);
    save.run(async () => {
      if (isEdit) {
        if (values.bus !== saved.bus) await updateDiskBus(vmName, slot, values.bus);
        if (values.size !== saved.size) await resizeDisk(vmName, slot, sizeValue);
      } else if (isAttach) {
        await attachDiskToVM(vmName, slot, form.imagePath, form.bus);
        if (resizeValue != null) await resizeDisk(vmName, slot, resizeValue);
      } else {
        await createDiskOnVM(vmName, slot, Math.max(1, parseInt(form.sizeGB, 10) || 32), form.bus);
      }
    }).then((ok) => { if (ok) onClose(); });
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
      closeOnEscape={!saving}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={saving} className={formModalNeutralBtn}>
            Cancel
          </button>
          <button type="submit" form={FORM_ID} disabled={!canSave} title={blocked ?? undefined} className={formModalPrimaryBtn}>
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
            <LibraryDiskSelect value={form.imagePath} onChange={(value) => setField('imagePath', value)} />
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
                ref={!isEdit ? autoFocusField : undefined}
                className="input-field w-28 text-right font-mono"
              />
              <span className="text-xs text-text-muted">GB</span>
            </div>
          </FormField>
        )}

        {busField}

        <ErrorBanner className="mt-3" error={save.error} onDismiss={save.dismiss} />
      </form>
    </Modal>
  );
}
