import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  FormField,
  FormCheckbox,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { randomId } from '../../utils/randomId.js';
import { addMount, patchMount } from '../../api/settings.js';

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

/**
 * Modal form editor for one removable drive (see docs/UI-PATTERNS.md § Modal
 * form editor). Two entry points: edit an adopted drive (`drive` set) or
 * adopt a detected one (`adoptDisk` set — form prefilled from the device).
 * UUID and filesystem are identity, shown read-only. Calls `onSaved` after a
 * successful save so the parent can refresh settings and mount status.
 */
export default function RemovableDriveEditorModal({ open, drive, adoptDisk, onClose, onSaved }) {
  const [form, setForm] = useState(() => formFromDrive({}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isEdit = drive != null;

  useEffect(() => {
    if (!open) return;
    setForm(drive ? formFromDrive(drive) : formFromDetectedDisk(adoptDisk || {}));
    setError(null);
  }, [open, drive, adoptDisk]);

  const trimmedPath = form.mountPath.trim();
  const pathOk = trimmedPath.startsWith('/');
  const dirty = !isEdit
    || form.label.trim() !== (drive.label || '').trim()
    || trimmedPath !== (drive.mountPath || '').trim()
    || form.readOnly !== (drive.readOnly === true)
    || form.autoMount !== (drive.autoMount !== false);
  const canSave = pathOk && dirty && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (!isEdit) {
        await addMount({
          id: form.id,
          type: 'disk',
          label: form.label.trim(),
          mountPath: trimmedPath,
          autoMount: form.autoMount,
          uuid: form.uuid,
          fsType: form.fsType,
          readOnly: form.readOnly,
        });
      } else {
        const patch = {};
        if (form.label.trim() !== (drive.label || '').trim()) patch.label = form.label.trim();
        if (trimmedPath !== (drive.mountPath || '').trim()) patch.mountPath = trimmedPath;
        if (form.autoMount !== (drive.autoMount !== false)) patch.autoMount = form.autoMount;
        if (form.readOnly !== (drive.readOnly === true)) patch.readOnly = form.readOnly;
        if (Object.keys(patch).length > 0) await patchMount(form.id, patch);
      }
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const adoptDeviceName = adoptDisk
    ? [adoptDisk.vendor, adoptDisk.model].filter(Boolean).join(' ') || adoptDisk.devPath
    : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit drive' : 'Adopt drive'}
      subtitle={isEdit ? drive.label || shortUuid(drive.uuid) : `${adoptDeviceName} · ${adoptDisk?.devPath || ''}`}
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
            autoFocus
            className="input-field"
          />
        </FormField>
        <FormField
          label="Mount path"
          htmlFor="drive-editor-path"
          hint={pathOk ? null : 'Must be absolute (start with /).'}
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
        <FormModalError error={error} />
      </form>
    </Modal>
  );
}
