import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import Modal from '../shared/Modal.jsx';
import {
  FormCheckbox,
  FormField,
  FormModalError,
  formModalNeutralBtn,
  formModalPrimaryBtn,
} from '../shared/FormModalChrome.jsx';
import { addContainerMount, updateContainerMount } from '../../api/containers.js';

const FORM_ID = 'container-mount-editor-form';

export const TMPFS_DEFAULT_SIZE_MIB = 64;
export const TMPFS_MAX_SIZE_MIB = 2048;

/** Mount kinds, in the vocabulary the API uses (`type` on the mount definition). */
const KIND_META = {
  file: {
    addTitle: 'Add file mount',
    subtitle: 'File mount — a single file backed by the container data dir',
  },
  directory: {
    addTitle: 'Add folder mount',
    subtitle: 'Folder mount — a directory backed by the data dir or a storage mount',
  },
  tmpfs: {
    addTitle: 'Add tmpfs mount',
    subtitle: 'In-memory mount — contents are gone when the container restarts',
  },
};

export function normalizeMountType(t) {
  if (t === 'directory' || t === 'tmpfs') return t;
  return 'file';
}

function isValidSubPath(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value !== 'string') return false;
  const t = value.trim();
  if (t === '') return true;
  if (t.startsWith('/')) return false;
  return !t.split('/').filter(Boolean).some((seg) => seg === '..' || seg === '.');
}

function normalizeSubPath(value) {
  if (!value || typeof value !== 'string') return '';
  return value.trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function isValidOwnerId(value) {
  if (value === '' || value === null || value === undefined) return true;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 && n <= 65535;
}

export function normalizeOwnerId(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
}

function isValidTmpfsSize(value) {
  if (value === '' || value === null || value === undefined) return false;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= TMPFS_MAX_SIZE_MIB;
}

export function normalizeTmpfsSize(value) {
  if (value === '' || value === null || value === undefined) return TMPFS_DEFAULT_SIZE_MIB;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= TMPFS_MAX_SIZE_MIB ? n : TMPFS_DEFAULT_SIZE_MIB;
}

function formFromMount(mount, kind) {
  if (!mount) {
    return {
      type: normalizeMountType(kind),
      containerPath: '',
      name: '',
      readonly: false,
      sourceId: null,
      subPath: '',
      containerOwnerUid: 0,
      containerOwnerGid: 0,
      sizeMiB: TMPFS_DEFAULT_SIZE_MIB,
    };
  }
  return {
    type: normalizeMountType(mount.type),
    containerPath: mount.containerPath || '',
    name: mount.name || '',
    readonly: !!mount.readonly,
    sourceId: mount.sourceId || null,
    subPath: mount.subPath || '',
    containerOwnerUid: Number.isInteger(mount.containerOwnerUid) ? mount.containerOwnerUid : 0,
    containerOwnerGid: Number.isInteger(mount.containerOwnerGid) ? mount.containerOwnerGid : 0,
    sizeMiB: Number.isInteger(mount.sizeMiB) && mount.sizeMiB > 0 ? mount.sizeMiB : TMPFS_DEFAULT_SIZE_MIB,
  };
}

/** POST body for a new mount — the shape the inline row editor produced. */
function buildCreatePayload(form) {
  const name = form.name.trim();
  const containerPath = form.containerPath.trim();
  if (form.type === 'tmpfs') {
    return { type: 'tmpfs', name, containerPath, sizeMiB: normalizeTmpfsSize(form.sizeMiB) };
  }
  const payload = { type: form.type, name, containerPath, readonly: !!form.readonly };
  if (form.sourceId) {
    payload.sourceId = form.sourceId;
    payload.subPath = normalizeSubPath(form.subPath);
  }
  const uid = normalizeOwnerId(form.containerOwnerUid);
  const gid = normalizeOwnerId(form.containerOwnerGid);
  if (uid !== 0) payload.containerOwnerUid = uid;
  if (gid !== 0) payload.containerOwnerGid = gid;
  return payload;
}

/** Delta PATCH against the saved mount — only changed keys are sent. */
function buildPatch(form, prev) {
  const patch = {};
  const name = form.name.trim();
  const containerPath = form.containerPath.trim();
  if (name !== prev.name) patch.name = name;
  if (containerPath !== prev.containerPath) patch.containerPath = containerPath;
  if (form.type === 'tmpfs') {
    const size = normalizeTmpfsSize(form.sizeMiB);
    const prevSize = Number.isInteger(prev.sizeMiB) && prev.sizeMiB > 0 ? prev.sizeMiB : TMPFS_DEFAULT_SIZE_MIB;
    if (size !== prevSize) patch.sizeMiB = size;
    return patch;
  }
  if (!!form.readonly !== !!prev.readonly) patch.readonly = !!form.readonly;
  const prevSourceId = prev.sourceId || null;
  const nextSourceId = form.sourceId || null;
  if (prevSourceId !== nextSourceId) patch.sourceId = nextSourceId;
  const sub = normalizeSubPath(form.subPath);
  const prevSub = prev.subPath || '';
  if ((nextSourceId && sub !== prevSub) || (!nextSourceId && prevSub)) {
    patch.subPath = nextSourceId ? sub : '';
  }
  const uid = normalizeOwnerId(form.containerOwnerUid);
  const gid = normalizeOwnerId(form.containerOwnerGid);
  const prevUid = Number.isInteger(prev.containerOwnerUid) ? prev.containerOwnerUid : 0;
  const prevGid = Number.isInteger(prev.containerOwnerGid) ? prev.containerOwnerGid : 0;
  if (uid !== prevUid) patch.containerOwnerUid = uid;
  if (gid !== prevGid) patch.containerOwnerGid = gid;
  return patch;
}

/**
 * Modal form editor for one container mount (see docs/UI-PATTERNS.md § Modal
 * form editor). Two entry points like RemovableDriveEditorModal: create — the
 * header Add that was tapped passes its `kind` (`file` | `directory` | `tmpfs`)
 * — or edit, with the saved `mount` row. Saves through the row-scoped mount
 * APIs, then `onSaved` (parent refresh) before closing; stays open on failure.
 */
export default function ContainerMountEditorModal({
  open,
  containerName,
  mount = null,
  kind = 'file',
  mounts = [],
  storageMounts = [],
  runAsRoot = false,
  onSaved,
  onClose,
}) {
  const [form, setForm] = useState(() => formFromMount(null, 'file'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const isEdit = mount != null;

  useEffect(() => {
    if (!open) return;
    setForm(formFromMount(mount, kind));
    setError(null);
  }, [open, mount, kind]);

  const isTmpfs = form.type === 'tmpfs';
  const trimmedName = form.name.trim();
  const trimmedPath = form.containerPath.trim();
  /* Owner idmap applies to Local (non-storage) bind mounts only. */
  const showOwnerIds = runAsRoot && !isTmpfs && !form.sourceId;

  const others = (mounts || []).filter((m) => m.name !== mount?.name);
  const duplicateName = trimmedName !== '' && others.some((m) => m.name === trimmedName);
  const duplicatePath = trimmedPath !== '' && others.some((m) => m.containerPath === trimmedPath);

  /* Same rule set the inline row editor enforced, surfaced per field. */
  const pathError = trimmedPath !== '' && !trimmedPath.startsWith('/')
    ? 'Container path must be absolute (start with /).'
    : duplicatePath
      ? `Duplicate container path: ${trimmedPath}`
      : null;
  const nameError = duplicateName ? `Duplicate mount name: ${trimmedName}` : null;
  const sizeError = isTmpfs && !isValidTmpfsSize(form.sizeMiB)
    ? `Tmpfs size must be a whole number between 1 and ${TMPFS_MAX_SIZE_MIB} MiB.`
    : null;
  const subPathError = !isTmpfs && form.sourceId && !isValidSubPath(form.subPath)
    ? 'Sub-path must be relative (no leading /) and cannot contain ".." segments.'
    : null;
  const ownerError = isTmpfs
    ? null
    : !isValidOwnerId(form.containerOwnerUid)
      ? 'Owner UID must be a whole number between 0 and 65535.'
      : !isValidOwnerId(form.containerOwnerGid)
        ? 'Owner GID must be a whole number between 0 and 65535.'
        : null;

  const invalid = !!(pathError || nameError || sizeError || subPathError || ownerError);
  const patch = isEdit ? buildPatch(form, mount) : null;
  const dirty = isEdit ? Object.keys(patch).length > 0 : true;
  const canSave = trimmedName !== '' && trimmedPath !== '' && !invalid && dirty && !saving;

  const setField = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  /* Clearing the source drops its sub-path — it only means anything under a storage mount. */
  const setSource = (nextSourceId) => {
    setForm((f) => (nextSourceId
      ? { ...f, sourceId: nextSourceId }
      : { ...f, sourceId: null, subPath: '' }));
  };

  const setDigits = (field, raw, maxLen) => {
    const v = raw.replace(/[^0-9]/g, '').slice(0, maxLen);
    setField(field, v === '' ? '' : Number(v));
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        if (Object.keys(patch).length > 0) {
          await updateContainerMount(containerName, mount.name, patch);
        }
      } else {
        await addContainerMount(containerName, buildCreatePayload(form));
      }
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const meta = KIND_META[form.type] || KIND_META.file;
  const sourceMissing = !!form.sourceId && !storageMounts.some((m) => m.id === form.sourceId);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit mount' : meta.addTitle}
      subtitle={isEdit ? `${mount.name} · ${containerName}` : meta.subtitle}
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
            {isEdit ? 'Save' : 'Add'}
          </button>
        </>
      )}
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => { e.preventDefault(); handleSave(); }}
        className="space-y-3"
      >
        <FormField label="Container path" htmlFor="mount-editor-path" hint={pathError}>
          <input
            id="mount-editor-path"
            type="text"
            value={form.containerPath}
            onChange={(e) => setField('containerPath', e.target.value)}
            placeholder="/path/in/container"
            autoFocus={!isEdit}
            autoComplete="off"
            spellCheck={false}
            className="input-field font-mono"
          />
        </FormField>

        <FormField
          label="Mount name"
          htmlFor="mount-editor-name"
          hint={nameError || 'Storage key — names the mount and its host-side data directory.'}
        >
          <input
            id="mount-editor-name"
            type="text"
            value={form.name}
            onChange={(e) => setField('name', e.target.value)}
            placeholder="storage key"
            autoComplete="off"
            spellCheck={false}
            className="input-field font-mono"
          />
        </FormField>

        {isTmpfs && (
          <FormField
            label="Size"
            htmlFor="mount-editor-size"
            hint={sizeError || `In-memory cap in MiB (1–${TMPFS_MAX_SIZE_MIB}).`}
          >
            <div className="flex items-center gap-2">
              <input
                id="mount-editor-size"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={4}
                value={form.sizeMiB}
                onChange={(e) => setDigits('sizeMiB', e.target.value, 4)}
                className="input-field w-24 text-right font-mono"
                aria-label="Tmpfs size in MiB"
              />
              <span className="text-xs text-text-muted">MiB</span>
            </div>
          </FormField>
        )}

        {form.type === 'directory' && (
          <FormField
            label="Source"
            htmlFor="mount-editor-source"
            hint={sourceMissing ? 'The referenced storage mount no longer exists.' : null}
          >
            <select
              id="mount-editor-source"
              value={form.sourceId || ''}
              onChange={(e) => setSource(e.target.value || null)}
              className="input-field"
            >
              <option value="">Local (container data dir)</option>
              {storageMounts.map((sm) => (
                <option key={sm.id} value={sm.id}>
                  {(sm.label && sm.label.trim()) || sm.mountPath}
                </option>
              ))}
              {sourceMissing && <option value={form.sourceId}>{form.sourceId} (missing)</option>}
            </select>
          </FormField>
        )}

        {form.type === 'directory' && !!form.sourceId && (
          <FormField
            label="Sub-path"
            htmlFor="mount-editor-subpath"
            hint={subPathError || 'Relative to the storage mount root; empty mounts the root.'}
          >
            <input
              id="mount-editor-subpath"
              type="text"
              value={form.subPath || ''}
              onChange={(e) => setField('subPath', e.target.value)}
              placeholder="(empty = mount root)"
              autoComplete="off"
              spellCheck={false}
              className="input-field font-mono"
            />
          </FormField>
        )}

        {!isTmpfs && (
          <FormCheckbox
            label="Read-only"
            hint="Mount without write access inside the container."
            checked={form.readonly}
            onChange={(e) => setField('readonly', e.target.checked)}
          />
        )}

        {showOwnerIds && (
          <FormField
            label="Owner uid:gid"
            hint={ownerError || 'In-container UID:GID mapped to the host deploy user (size:1 idmap). 0:0 disables it.'}
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                value={form.containerOwnerUid}
                onChange={(e) => setDigits('containerOwnerUid', e.target.value, 5)}
                className="input-field w-24 text-right font-mono"
                aria-label="Owner UID inside container"
              />
              <span className="text-text-muted">:</span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={5}
                value={form.containerOwnerGid}
                onChange={(e) => setDigits('containerOwnerGid', e.target.value, 5)}
                className="input-field w-24 text-right font-mono"
                aria-label="Owner GID inside container"
              />
            </div>
          </FormField>
        )}

        <FormModalError error={error} />
      </form>
    </Modal>
  );
}
