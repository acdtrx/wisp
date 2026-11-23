import { useState } from 'react';

import { FormCheckbox, FormField } from '../shared/FormModalChrome.jsx';
import { addContainerMount, updateContainerMount } from '../../api/containers.js';
import { autoFocusField } from '../../lib/focus.js';
import { useCommand } from '../../hooks/useCommand.js';
import { useEditor } from '../../hooks/useEditor.js';
import { changedFields, NOTHING_CHANGED } from '../../hooks/editorValues.js';
import FormModal from '../shared/FormModal.jsx';

const TMPFS_DEFAULT_SIZE_MIB = 64;
const TMPFS_MAX_SIZE_MIB = 2048;

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

function normalizeMountType(t) {
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

function normalizeOwnerId(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
}

function isValidTmpfsSize(value) {
  if (value === '' || value === null || value === undefined) return false;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isInteger(n) && n >= 1 && n <= TMPFS_MAX_SIZE_MIB;
}

function normalizeTmpfsSize(value) {
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
      secret: false,
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
    secret: mount.type === 'file' && !!mount.secret,
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
  if (form.type === 'file' && form.secret) payload.secret = true;
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

/** What Save writes for the values, normalised (the shape an edit compares, and sends
 *  the changed keys of): a tmpfs takes its size; the others their access, source,
 *  sub-path (none without a source) and owner ids. */
function mountSent(form) {
  const base = { type: form.type, name: form.name.trim(), containerPath: form.containerPath.trim() };
  if (form.type === 'tmpfs') return { ...base, sizeMiB: normalizeTmpfsSize(form.sizeMiB) };
  return {
    ...base,
    readonly: !!form.readonly,
    ...(form.type === 'file' ? { secret: !!form.secret } : {}),
    sourceId: form.sourceId || null,
    subPath: form.sourceId ? normalizeSubPath(form.subPath) : '',
    containerOwnerUid: normalizeOwnerId(form.containerOwnerUid),
    containerOwnerGid: normalizeOwnerId(form.containerOwnerGid),
  };
}

/**
 * Modal form editor for one container mount (see docs/FRONTEND-RULES.md § Modal
 * form editor). Two entry points like RemovableDriveEditorModal: create — the
 * header Add that was tapped passes its `kind` (`file` | `directory` | `tmpfs`)
 * — or edit `mount`. It takes the mount's values when it opens, and checks duplicates
 * against the container's other mounts as they were then (`mounts`). Saves through
 * the row-scoped mount APIs, then closes; stays open on failure.
 */
export default function ContainerMountEditorModal(props) {
  return props.open ? <ContainerMountEditor {...props} /> : null;
}

/**
 * What a mount editor's values lack to be saved, by the field each is about: the rule
 * set the inline row editor enforced. Duplicates are checked against `others`, the
 * container's other mounts.
 */
function mountProblems(form, others) {
  const problems = {};
  const isTmpfs = form.type === 'tmpfs';
  const name = form.name.trim();
  const containerPath = form.containerPath.trim();
  if (name === '') problems.name = 'Mount name is required.';
  else if (others.some((m) => m.name === name)) problems.name = `Duplicate mount name: ${name}`;
  if (containerPath === '') problems.containerPath = 'Container path is required.';
  else if (!containerPath.startsWith('/')) problems.containerPath = 'Container path must be absolute (start with /).';
  else if (others.some((m) => m.containerPath === containerPath)) problems.containerPath = `Duplicate container path: ${containerPath}`;
  if (isTmpfs && !isValidTmpfsSize(form.sizeMiB)) {
    problems.sizeMiB = `Tmpfs size must be a whole number between 1 and ${TMPFS_MAX_SIZE_MIB} MB.`;
  }
  if (!isTmpfs && form.sourceId && !isValidSubPath(form.subPath)) {
    problems.subPath = 'Sub-path must be relative (no leading /) and cannot contain ".." segments.';
  }
  if (!isTmpfs && !isValidOwnerId(form.containerOwnerUid)) problems.containerOwnerUid = 'Owner UID must be a whole number between 0 and 65535.';
  if (!isTmpfs && !isValidOwnerId(form.containerOwnerGid)) problems.containerOwnerGid = 'Owner GID must be a whole number between 0 and 65535.';
  return problems;
}

function ContainerMountEditor({
  containerName,
  mount = null,
  mounts = [],
  kind = 'file',
  storageMounts = [],
  runAsRoot = false,
  onClose,
}) {
  /* The mount, and the container's other mounts, as the editor opened. */
  const [opened] = useState({ mount, others: mounts.filter((m) => m.name !== mount?.name) });
  const isEdit = opened.mount != null;
  const mountName = opened.mount?.name ?? null;
  const others = opened.others;
  const { form, start, setForm, setField, dirty } = useEditor(() => formFromMount(opened.mount, kind));
  const save = useCommand();
  const saving = save.busy;
  const problems = mountProblems(form, others);
  const blocked = Object.values(problems)[0] ?? null;

  const isTmpfs = form.type === 'tmpfs';
  const trimmedName = form.name.trim();
  const trimmedPath = form.containerPath.trim();
  /* Owner idmap applies to Local (non-storage) bind mounts only. */
  const showOwnerIds = runAsRoot && !isTmpfs && !form.sourceId;

  /* Each field's problem, under it; an empty name or path says nothing there (Save says
   * why it is off). */
  const pathError = trimmedPath !== '' ? problems.containerPath ?? null : null;
  const nameError = trimmedName !== '' ? problems.name ?? null : null;
  const sizeError = problems.sizeMiB ?? null;
  const subPathError = problems.subPath ?? null;
  const ownerError = problems.containerOwnerUid ?? problems.containerOwnerGid ?? null;
  /* An edit needs a change; a new mount only valid values. */
  const canSave = !blocked && (!isEdit || dirty) && !saving;

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

  const handleSave = () => {
    if (!canSave) return;
    save.run(() => (isEdit
      ? updateContainerMount(containerName, mountName, changedFields(mountSent(form), mountSent(start)))
      : addContainerMount(containerName, buildCreatePayload(form))))
      .then((ok) => { if (ok) onClose(); });
  };

  const meta = KIND_META[form.type] || KIND_META.file;
  const sourceMissing = !!form.sourceId && !storageMounts.some((m) => m.id === form.sourceId);

  return (
    <FormModal
      title={isEdit ? 'Edit mount' : meta.addTitle}
      subtitle={isEdit ? `${mountName} · ${containerName}` : meta.subtitle}
      size="md"
      saveLabel={isEdit ? 'Save' : 'Add'}
      save={save}
      blocked={blocked ?? (isEdit && !dirty ? NOTHING_CHANGED : null)}
      onSubmit={handleSave}
      onClose={onClose}
    >
      <FormField label="Container path" htmlFor="mount-editor-path" hint={pathError}>
        <input
          id="mount-editor-path"
          type="text"
          value={form.containerPath}
          onChange={(e) => setField('containerPath', e.target.value)}
          placeholder="/path/in/container"
          ref={!isEdit ? autoFocusField : undefined}
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
          hint={sizeError || `In-memory cap in MB (1–${TMPFS_MAX_SIZE_MIB}).`}
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
              aria-label="Tmpfs size in MB"
            />
            <span className="text-xs text-text-muted">MB</span>
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

      {form.type === 'file' && (
        <FormCheckbox
          label="Secret"
          hint={isEdit && start.secret
            ? 'Unchecking empties the stored file — upload or paste the content again afterwards.'
            : 'Content becomes write-only — it can be replaced or cleared, never read back.'}
          checked={form.secret}
          onChange={(e) => setField('secret', e.target.checked)}
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
    </FormModal>
  );
}
