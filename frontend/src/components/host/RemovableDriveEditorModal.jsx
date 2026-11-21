import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  FormField,
  FormCheckbox,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { randomId } from '../../utils/randomId.js';
import { addMount, patchMount } from '../../api/settings.js';
import { autoFocusField } from '../../lib/focus.js';
import ErrorBanner from '../shared/ErrorBanner.jsx';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useForm.js';
import { changedFields } from '../../hooks/formState.js';

const FORM_ID = 'removable-drive-editor-form';

export const SUPPORTED_FSTYPES = ['ext4', 'btrfs', 'vfat', 'exfat', 'ntfs3'];

function shortUuid(u) {
  return u ? u.slice(0, 8) : '';
}

function sanitizeForLabel(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function formFromDetectedDisk(disk) {
  const uidShort = shortUuid(disk.uuid) || 'new';
  const labelFromDisk = sanitizeForLabel(disk.label)
    || sanitizeForLabel(`${disk.vendor}-${disk.model}`)
    || `disk-${uidShort}`;
  return {
    id: randomId(),
    uuid: disk.uuid,
    fsType: SUPPORTED_FSTYPES.includes(disk.fsType) ? disk.fsType : '',
    label: labelFromDisk,
    /* Always UUID-derived so two drives never collide and delete→re-adopt yields a fresh path. */
    mountPath: `/mnt/wisp/disk-${uidShort}`,
    readOnly: disk.fsType === 'ntfs3',
    autoMount: true,
  };
}

function formFromDrive(drive) {
  return {
    id: drive.id,
    uuid: drive.uuid || '',
    fsType: drive.fsType || '',
    label: drive.label || '',
    mountPath: drive.mountPath || '',
    readOnly: drive.readOnly === true,
    autoMount: drive.autoMount !== false,
  };
}

/** What Save writes for the values: the label and path trimmed. */
const driveSent = (form) => ({
  label: form.label.trim(),
  mountPath: form.mountPath.trim(),
  autoMount: form.autoMount,
  readOnly: form.readOnly,
});

/** What a drive editor's values lack to be saved: an absolute mount path. */
const pathProblems = (form) => (form.mountPath.trim().startsWith('/') ? {} : { mountPath: 'Must be absolute (start with /).' });

/**
 * Modal form editor for one removable drive (see docs/FRONTEND-RULES.md § Modal
 * form editor). Two entry points: edit an adopted drive (`driveId` set) or adopt a
 * detected one (`adoptDisk` set — form prefilled from the device). Its record is the
 * settings (the mounts list). UUID and filesystem are identity, shown read-only.
 */
export default function RemovableDriveEditorModal(props) {
  return props.open ? <RemovableDriveEditor {...props} /> : null;
}

function RemovableDriveEditor({ open, drive: openedDrive = null, adoptDisk, onClose }) {
  /* The drive as the editor opened: it never reads the settings again. */
  const [drive] = useState(openedDrive);
  const isEdit = drive != null;
  const driveId = drive?.id ?? null;
  const { form, start, setForm, dirty } = useEditor(() => (isEdit ? formFromDrive(drive) : formFromDetectedDisk(adoptDisk || {})));
  const save = useCommand();
  const saving = save.busy;
  const problems = pathProblems(form);
  const blocked = Object.values(problems)[0] ?? null;

  /* An edit needs a change; an adoption only valid values. */
  const canSave = !blocked && (!isEdit || dirty) && !saving;

  const handleSave = () => {
    if (!canSave) return;
    const values = driveSent(form);
    save.run(() => (isEdit
      ? patchMount(form.id, changedFields(values, driveSent(start)))
      : addMount({
        id: form.id,
        type: 'disk',
        label: values.label,
        mountPath: values.mountPath,
        autoMount: values.autoMount,
        uuid: form.uuid,
        fsType: form.fsType,
        readOnly: values.readOnly,
      })))
      .then((ok) => { if (ok) onClose(); });
  };

  const adoptDeviceName = adoptDisk
    ? [adoptDisk.vendor, adoptDisk.model].filter(Boolean).join(' ') || adoptDisk.devPath
    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit drive' : 'Adopt drive'}
      subtitle={isEdit ? drive?.label || shortUuid(drive?.uuid) || driveId : `${adoptDeviceName} · ${adoptDisk?.devPath || ''}`}
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
            {isEdit ? 'Save' : 'Adopt'}
          </button>
        </>
      )}
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => { e.preventDefault(); handleSave(); }}
        className="space-y-3"
      >
        <div className="grid grid-cols-2 gap-3 rounded-md border border-surface-border bg-surface px-3 py-2 text-xs">
          <div>
            <span className="block text-text-muted">UUID</span>
            <span className="font-mono" title={form.uuid}>{shortUuid(form.uuid) || '—'}</span>
          </div>
          <div>
            <span className="block text-text-muted">Filesystem</span>
            <span className="font-mono">{form.fsType || '—'}</span>
          </div>
        </div>
        <FormField label="Label" htmlFor="drive-editor-label">
          <input
            id="drive-editor-label"
            type="text"
            value={form.label}
            onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="backup-drive"
            ref={autoFocusField}
            className="input-field"
          />
        </FormField>
        <FormField
          label="Mount path"
          htmlFor="drive-editor-path"
          hint={problems.mountPath ?? null}
        >
          <input
            id="drive-editor-path"
            type="text"
            value={form.mountPath}
            onChange={(e) => setForm((f) => ({ ...f, mountPath: e.target.value }))}
            placeholder="/mnt/wisp/drive"
            className="input-field font-mono"
          />
        </FormField>
        <div className="grid gap-3 pt-1 sm:grid-cols-2">
          <FormCheckbox
            label="Read-only"
            hint={form.fsType === 'ntfs3' ? 'NTFS mounts are always read-only.' : 'Mount without write access.'}
            checked={form.readOnly}
            onChange={(e) => setForm((f) => ({ ...f, readOnly: e.target.checked }))}
            disabled={form.fsType === 'ntfs3'}
          />
          <FormCheckbox
            label="Auto-mount"
            hint="Mount automatically when the drive is inserted."
            checked={form.autoMount}
            onChange={(e) => setForm((f) => ({ ...f, autoMount: e.target.checked }))}
          />
        </div>
        <ErrorBanner className="mt-3" error={save.error} onDismiss={save.dismiss} />
      </form>
    </Modal>
  );
}
